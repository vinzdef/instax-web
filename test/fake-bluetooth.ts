import { INSTAX_SERVICES } from '../src/transport.js'

export interface FakeCharacteristicOptions {
  write?: boolean
  writeWithoutResponse?: boolean
  notify?: boolean
}

/**
 * A GATT characteristic backed by an event target, close enough to the real
 * thing for `BleTransport` to drive it.
 */
export class FakeCharacteristic extends EventTarget {
  value: DataView | undefined
  readonly properties: { write: boolean; writeWithoutResponse: boolean; notify: boolean }
  readonly writes: Uint8Array[] = []
  notifying = false

  /** Called for each write; return fragments to notify back, or null for silence. */
  onWrite: ((bytes: Uint8Array) => Uint8Array[] | null) | null = null
  /** Delay applied inside the write call, to expose ordering bugs. */
  writeDelay = 0
  /** Set to fail the next write. */
  writeError: Error | null = null
  /** Set to fail subscription, the way a link that drops mid-attach does. */
  notifyError: Error | null = null

  constructor(options: FakeCharacteristicOptions = {}) {
    super()
    this.properties = {
      write: options.write ?? true,
      writeWithoutResponse: options.writeWithoutResponse ?? true,
      notify: options.notify ?? true,
    }
  }

  async startNotifications(): Promise<FakeCharacteristic> {
    if (this.notifyError) throw this.notifyError
    this.notifying = true
    return this
  }

  async stopNotifications(): Promise<FakeCharacteristic> {
    this.notifying = false
    return this
  }

  async writeValueWithoutResponse(value: BufferSource): Promise<void> {
    await this.#record(value)
  }

  async writeValue(value: BufferSource): Promise<void> {
    await this.#record(value)
  }

  async #record(value: BufferSource): Promise<void> {
    if (this.writeError) {
      const error = this.writeError
      this.writeError = null
      throw error
    }
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writes.push(bytes.slice())

    if (this.writeDelay) await new Promise((resolve) => setTimeout(resolve, this.writeDelay))

    const reply = this.onWrite?.(bytes)
    if (reply) for (const fragment of reply) this.notify(fragment)
  }

  /** Delivers a notification the way the browser does. */
  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

export class FakeDevice extends EventTarget {
  readonly gatt: { connected: boolean; connect: () => Promise<FakeServer> }
  readonly #server: FakeServer
  /** Live listeners per event type. A leak shows up here and nowhere else. */
  readonly #listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  constructor(
    public readonly name: string,
    private readonly characteristics: FakeCharacteristic[],
    services: readonly string[] = INSTAX_SERVICES,
  ) {
    super()
    this.#server = new FakeServer(this, characteristics, services)
    this.gatt = {
      connected: false,
      connect: async () => {
        this.gatt.connected = true
        this.#server.connected = true
        return this.#server
      },
    }
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener) {
      const set = this.#listeners.get(type) ?? new Set()
      set.add(listener)
      this.#listeners.set(type, set)
    }
    super.addEventListener(type, listener, options)
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (listener) this.#listeners.get(type)?.delete(listener)
    super.removeEventListener(type, listener, options)
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0
  }

  /** Simulates the link dropping out from under the transport. */
  dropLink(): void {
    this.gatt.connected = false
    this.#server.connected = false
    // Losing the link ends every subscription with it, whoever asked for it.
    for (const characteristic of this.characteristics) characteristic.notifying = false
    this.dispatchEvent(new Event('gattserverdisconnected'))
  }
}

export class FakeServer {
  connected = false

  constructor(
    public readonly device: FakeDevice,
    private readonly characteristics: FakeCharacteristic[],
    private readonly services: readonly string[],
  ) {}

  async getPrimaryService(uuid: string): Promise<{ getCharacteristics: () => Promise<FakeCharacteristic[]> }> {
    if (!this.services.includes(uuid)) throw new DOMException('no such service', 'NotFoundError')
    return { getCharacteristics: async () => this.characteristics }
  }

  disconnect(): void {
    this.device.dropLink()
  }
}

/** Builds a `navigator`-shaped object exposing a single fake printer. */
export function fakeNavigator(device: FakeDevice | Error): { bluetooth: unknown } {
  return {
    bluetooth: {
      requestDevice: async () => {
        if (device instanceof Error) throw device
        return device
      },
      getAvailability: async () => true,
    },
  }
}
