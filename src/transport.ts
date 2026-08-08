import { InstaxError } from './errors.js'
import { decodePacket, looksLikeResponse, toHex, type ResponsePacket } from './protocol.js'

/** Known GATT services on INSTAX Link printers. The first is the primary one. */
export const INSTAX_SERVICES: readonly string[] = [
  '70954782-2d83-473d-9e5f-81e1d02d5273',
  '0000180a-0000-1000-8000-00805f9b34fb',
  '00001800-0000-1000-8000-00805f9b34fb',
  '0000e0ff-3c17-d293-8e48-14fe2e4da212',
]

/** Advertised-name prefix shared by every INSTAX Link model. */
export const INSTAX_NAME_PREFIX = 'INSTAX'

/**
 * Bytes per BLE write. The default ATT MTU is 185, minus 3 bytes of ATT
 * overhead; larger writes are silently truncated by some stacks, so packets are
 * fragmented to this size and reassembled by the printer.
 */
export const DEFAULT_FRAGMENT_SIZE = 182

export type Logger = (direction: 'tx' | 'rx' | 'info', message: string) => void

/**
 * The byte pipe the printer talks over. Implement this to drive a printer from
 * something other than Web Bluetooth — a test double, a WebSocket bridge, or a
 * native transport in a wrapper app.
 */
export interface Transport {
  readonly connected: boolean
  /** Advertised device name, once known. */
  readonly name: string | null
  connect(): Promise<void>
  disconnect(): Promise<void>
  /**
   * Writes raw bytes. When `awaitAck` is true, resolves with the printer's next
   * response packet; otherwise resolves as soon as the write lands.
   */
  write(bytes: Uint8Array, awaitAck: boolean, timeoutMs?: number): Promise<ResponsePacket | null>
  /** Invoked when the link drops, for any reason including a clean disconnect. */
  onDisconnect: (() => void) | null
}

export interface BleTransportOptions {
  /** @default 'INSTAX' */
  namePrefix?: string
  /** @default INSTAX_SERVICES */
  services?: readonly string[]
  /**
   * How long to wait for an acknowledgement before giving up, in ms.
   * @default 1000
   */
  ackTimeout?: number
  /** Receives protocol traces. Defaults to discarding them. */
  logger?: Logger
}

interface PendingAck {
  resolve: (packet: ResponsePacket) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Web Bluetooth transport.
 *
 * Two things matter for correctness here. Writes are serialised through a
 * promise chain, because the printer answers with an unaddressed notification
 * and concurrent commands would race for each other's replies. And
 * notifications stay subscribed for the lifetime of the connection rather than
 * being started and stopped per command, which is both slow and lossy.
 */
export class BleTransport implements Transport {
  onDisconnect: (() => void) | null = null

  readonly #namePrefix: string
  readonly #services: readonly string[]
  readonly #ackTimeout: number
  readonly #log: Logger

  #device: BluetoothDevice | null = null
  #server: BluetoothRemoteGATTServer | null = null
  #writeCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
  #notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null = null

  #pending: PendingAck | null = null
  /** Reassembly buffer for responses split across notifications. */
  #inbound: number[] = []
  /** Tail of the write queue; every write chains onto it. */
  #queue: Promise<unknown> = Promise.resolve()

  #onValueChanged = (event: Event) => this.#handleNotification(event)
  #onGattDisconnected = () => this.#teardown()

  constructor(options: BleTransportOptions = {}) {
    this.#namePrefix = options.namePrefix ?? INSTAX_NAME_PREFIX
    this.#services = options.services ?? INSTAX_SERVICES
    this.#ackTimeout = options.ackTimeout ?? 1000
    this.#log = options.logger ?? (() => {})
  }

  get connected(): boolean {
    return this.#writeCharacteristic !== null && this.#server?.connected === true
  }

  get name(): string | null {
    return this.#device?.name ?? null
  }

  /**
   * Shows the browser's device chooser and connects to the chosen printer.
   * Must be called from a user gesture — browsers reject `requestDevice`
   * otherwise.
   */
  async connect(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) {
      throw new InstaxError(
        'unsupported',
        'Web Bluetooth is unavailable. It needs a supported browser and a secure context (HTTPS or localhost).',
      )
    }

    let device: BluetoothDevice
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: this.#namePrefix }],
        optionalServices: this.#services as string[],
      })
    } catch (error) {
      // The chooser throws NotFoundError both when dismissed and when nothing
      // matched; neither is an error worth a stack trace.
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new InstaxError('cancelled', 'No printer was selected.', { cause: error })
      }
      throw new InstaxError('disconnected', `Could not reach the printer: ${describe(error)}`, {
        cause: error,
      })
    }

    await this.#attach(device)
  }

  async #attach(device: BluetoothDevice): Promise<void> {
    try {
      this.#device = device
      device.addEventListener('gattserverdisconnected', this.#onGattDisconnected)

      const server = await device.gatt!.connect()
      this.#server = server

      const primary = this.#services[0] as string
      const service = await server.getPrimaryService(primary)
      const characteristics = await service.getCharacteristics()

      const write = characteristics.find(
        (c) => c.properties.writeWithoutResponse || c.properties.write,
      )
      const notify = characteristics.find((c) => c.properties.notify)
      if (!write || !notify) {
        throw new InstaxError(
          'disconnected',
          'Printer service is missing a writable or notifying characteristic.',
        )
      }

      this.#writeCharacteristic = write
      this.#notifyCharacteristic = notify

      await notify.startNotifications()
      notify.addEventListener('characteristicvaluechanged', this.#onValueChanged)

      this.#log('info', `connected to ${device.name ?? 'printer'}`)
    } catch (error) {
      this.#teardown()
      if (error instanceof InstaxError) throw error
      throw new InstaxError('disconnected', `Connection failed: ${describe(error)}`, {
        cause: error,
      })
    }
  }

  async disconnect(): Promise<void> {
    const notify = this.#notifyCharacteristic
    const server = this.#server
    // Drop local state first so an in-flight write fails fast rather than
    // hanging on a link that is going away.
    this.#teardown()

    try {
      notify?.removeEventListener('characteristicvaluechanged', this.#onValueChanged)
      if (notify) await notify.stopNotifications()
    } catch {
      // The characteristic is already gone; nothing to unsubscribe from.
    }
    try {
      server?.disconnect()
    } catch {
      // Already disconnected.
    }
  }

  write(bytes: Uint8Array, awaitAck: boolean, timeoutMs?: number): Promise<ResponsePacket | null> {
    // Chain onto the queue tail so writes never interleave, and make the tail
    // settle regardless of this write's outcome.
    const result = this.#queue.then(
      () => this.#writeNow(bytes, awaitAck, timeoutMs),
      () => this.#writeNow(bytes, awaitAck, timeoutMs),
    )
    this.#queue = result.catch(() => {})
    return result
  }

  async #writeNow(
    bytes: Uint8Array,
    awaitAck: boolean,
    timeoutMs = this.#ackTimeout,
  ): Promise<ResponsePacket | null> {
    const characteristic = this.#writeCharacteristic
    if (!characteristic || !this.connected) {
      throw new InstaxError('not-connected', 'No printer is connected.')
    }

    this.#log('tx', toHex(bytes))

    let ack: Promise<ResponsePacket> | null = null
    if (awaitAck) {
      // Register before writing: the reply can land before `writeValue` resolves.
      this.#inbound = []
      ack = new Promise<ResponsePacket>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending = null
          reject(
            new InstaxError('timeout', `Printer did not acknowledge within ${timeoutMs}ms.`),
          )
        }, timeoutMs)
        this.#pending = { resolve, reject, timer }
      })
      // The ack can reject before this function reaches `return ack` — a
      // disconnect or a failed write settles it early. Attach a handler now so
      // that never surfaces as an unhandled rejection; the returned promise
      // still rejects for the caller.
      void ack.catch(() => {})
    }

    try {
      // writeWithoutResponse skips the ATT ack, which the printer's own
      // notification makes redundant and which roughly halves throughput.
      if (characteristic.properties.writeWithoutResponse) {
        await characteristic.writeValueWithoutResponse(bytes as unknown as BufferSource)
      } else {
        await characteristic.writeValue(bytes as unknown as BufferSource)
      }
    } catch (error) {
      this.#settlePending(null, error)
      throw new InstaxError('disconnected', `Write failed: ${describe(error)}`, { cause: error })
    }

    if (!ack) return null
    return ack
  }

  #handleNotification(event: Event): void {
    const value = (event.target as BluetoothRemoteGATTCharacteristic | null)?.value
    if (!value) return

    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.#inbound.push(...bytes)

    const buffered = new Uint8Array(this.#inbound)
    if (!looksLikeResponse(buffered)) {
      // Not a response frame; discard so a stray fragment cannot corrupt the
      // next real one.
      this.#inbound = []
      return
    }
    if (buffered.length < 4) return

    const declaredLength = ((buffered[2] as number) << 8) | (buffered[3] as number)
    if (buffered.length < declaredLength) return

    this.#inbound = []
    this.#log('rx', toHex(buffered))

    try {
      this.#settlePending(decodePacket(buffered.subarray(0, declaredLength)))
    } catch (error) {
      this.#settlePending(null, error)
    }
  }

  #settlePending(packet: ResponsePacket | null, error?: unknown): void {
    const pending = this.#pending
    if (!pending) return
    this.#pending = null
    clearTimeout(pending.timer)
    if (packet) pending.resolve(packet)
    else pending.reject(error ?? new InstaxError('disconnected', 'Connection closed.'))
  }

  /** Clears local state and fails any in-flight request. */
  #teardown(): void {
    const wasConnected = this.#writeCharacteristic !== null
    this.#writeCharacteristic = null
    this.#notifyCharacteristic = null
    this.#server = null
    this.#inbound = []
    this.#settlePending(null, new InstaxError('disconnected', 'The printer disconnected.'))

    if (wasConnected) {
      this.#log('info', 'disconnected')
      this.onDisconnect?.()
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
