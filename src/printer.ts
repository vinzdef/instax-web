import { Emitter } from './emitter.js'
import { InstaxError } from './errors.js'
import { filmSpec, filmVariantForSize, type FilmVariant } from './film.js'
import { encodeLedPattern, type LedPatternOptions } from './led.js'
import { Opcode, SupportFunction, opcodeName } from './opcodes.js'
import {
  parseBattery,
  parseDeviceInfo,
  parseFilmCount,
  parseImageSpecs,
  type BatteryInfo,
  type DeviceIdentity,
} from './parser.js'
import { encodePacket, uint32be, type ResponsePacket } from './protocol.js'
import {
  BleTransport,
  DEFAULT_FRAGMENT_SIZE,
  type BleTransportOptions,
  type Logger,
  type Transport,
} from './transport.js'

/** Bytes the image-download header reserves before the 32-bit length field. */
const DOWNLOAD_HEADER = [0x02, 0x00, 0x00, 0x00] as const

export interface PrinterStatus {
  /** Loaded film, or `null` when the reported dimensions match no known film. */
  film: FilmVariant | null
  battery: BatteryInfo
  /** Shots left in the cartridge. */
  shotsRemaining: number
  /** Image dimensions the printer advertises. */
  image: { width: number; height: number }
}

export interface PrintProgress {
  phase: 'uploading' | 'printing'
  /** Completion of the current phase, 0 to 1. */
  ratio: number
  /** 1-based copy being printed, during the `printing` phase. */
  copy?: number
  copies?: number
}

export interface InstaxPrinterEvents {
  connect: { name: string | null }
  disconnect: void
  progress: PrintProgress
  status: PrinterStatus
}

export interface InstaxPrinterOptions extends BleTransportOptions {
  /**
   * Byte pipe to the printer. Defaults to Web Bluetooth; supply your own to
   * test without hardware or to bridge a different link.
   */
  transport?: Transport
  /** Bytes per BLE write. @default 182 */
  fragmentSize?: number
  /**
   * Pause between BLE writes during upload, in ms. Raising it trades speed for
   * reliability on flaky links; the library raises it itself when a transfer
   * fails and retries.
   * @default 15
   */
  fragmentDelay?: number
  /**
   * How long to wait after asking for a print, in ms. The protocol has no
   * "ejection finished" notification, so this is a fixed conservative wait
   * covering the mechanical cycle.
   * @default 15000
   */
  ejectDelay?: number
}

export interface PrintOptions {
  /** @default 1 */
  copies?: number
  /**
   * Film the image was prepared for. Defaults to the film reported by the last
   * {@link InstaxPrinter.getStatus} call.
   */
  variant?: FilmVariant
  signal?: AbortSignal
  onProgress?: (progress: PrintProgress) => void
}

export type UploadOptions = Omit<PrintOptions, 'copies'>

/** Anything this library can turn into JPEG bytes. */
export type ImageSource = Blob | ArrayBuffer | ArrayBufferView | Uint8Array | string

/**
 * A connected INSTAX Link printer.
 *
 * ```ts
 * const printer = await InstaxPrinter.request()
 * const status = await printer.getStatus()
 * const jpeg = await prepareImage(file, { variant: status.film ?? 'mini' })
 * await printer.print(jpeg)
 * ```
 */
export class InstaxPrinter extends Emitter<InstaxPrinterEvents> {
  readonly #transport: Transport
  readonly #fragmentSize: number
  readonly #baseFragmentDelay: number
  readonly #ejectDelay: number
  readonly #log: Logger

  #film: FilmVariant | null = null

  constructor(options: InstaxPrinterOptions = {}) {
    super()
    this.#log = options.logger ?? (() => {})
    this.#transport = options.transport ?? new BleTransport({ ...options, logger: this.#log })
    this.#fragmentSize = options.fragmentSize ?? DEFAULT_FRAGMENT_SIZE
    this.#baseFragmentDelay = options.fragmentDelay ?? 15
    this.#ejectDelay = options.ejectDelay ?? 15000

    this.#transport.onDisconnect = () => {
      this.#film = null
      this.emit('disconnect', undefined)
    }
  }

  /** `true` when this browser can talk to Bluetooth devices at all. */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth)
  }

  /**
   * Prompts for a printer and connects. Call this from a click handler or
   * another user gesture; browsers block the chooser otherwise.
   */
  static async request(options: InstaxPrinterOptions = {}): Promise<InstaxPrinter> {
    const printer = new InstaxPrinter(options)
    await printer.connect()
    return printer
  }

  get connected(): boolean {
    return this.#transport.connected
  }

  get name(): string | null {
    return this.#transport.name
  }

  /** Film reported by the most recent {@link getStatus}, if any. */
  get film(): FilmVariant | null {
    return this.#film
  }

  async connect(): Promise<void> {
    await this.#transport.connect()
    this.emit('connect', { name: this.#transport.name })
  }

  async disconnect(): Promise<void> {
    await this.#transport.disconnect()
  }

  /** Battery, film count, and loaded film size. */
  async getStatus(): Promise<PrinterStatus> {
    const specs = parseImageSpecs(
      await this.#command(Opcode.SUPPORT_FUNCTION_INFO, [SupportFunction.IMAGE_SPECS]),
    )
    const battery = parseBattery(
      await this.#command(Opcode.SUPPORT_FUNCTION_INFO, [SupportFunction.BATTERY]),
    )
    const film = parseFilmCount(
      await this.#command(Opcode.SUPPORT_FUNCTION_INFO, [SupportFunction.FILM_COUNT]),
    )

    this.#film = filmVariantForSize(specs.width, specs.height)

    const status: PrinterStatus = {
      film: this.#film,
      battery,
      shotsRemaining: film.shotsRemaining,
      image: { width: specs.width, height: specs.height },
    }
    this.emit('status', status)
    return status
  }

  /** Manufacturer, model id, and serial number. */
  async getIdentity(): Promise<DeviceIdentity> {
    const identity: DeviceIdentity = {}
    for (const command of [0, 1, 2]) {
      Object.assign(identity, parseDeviceInfo(await this.#command(Opcode.DEVICE_INFO_SERVICE, [command])))
    }
    return identity
  }

  /**
   * Sets the ring LED to a colour or an animated sequence of colours.
   * Cosmetic: failures here never stop a print.
   */
  async setLed(colors: string | string[], options: LedPatternOptions = {}): Promise<void> {
    const list = typeof colors === 'string' ? [colors] : colors
    await this.#command(Opcode.LED_PATTERN_SETTINGS, encodeLedPattern(list, options), false)
  }

  /** Powers the printer off. */
  async shutdown(): Promise<void> {
    await this.#command(Opcode.SHUT_DOWN, [], false)
  }

  /**
   * Uploads an image and prints it.
   *
   * The image must already be a JPEG at the film's exact dimensions and under
   * its size limit — use {@link prepareImage} to get there from an arbitrary
   * file.
   */
  async print(image: ImageSource, options: PrintOptions = {}): Promise<void> {
    const copies = options.copies ?? 1
    if (!Number.isInteger(copies) || copies < 1) {
      throw new RangeError(`copies must be a positive integer, got ${copies}`)
    }

    await this.upload(image, options)
    await this.#triggerPrints(copies, options)
  }

  /**
   * Uploads an image without printing it. The printer holds one image at a
   * time; {@link printLoaded} prints whatever was uploaded last.
   */
  async upload(image: ImageSource, options: UploadOptions = {}): Promise<void> {
    const data = await toBytes(image)
    const variant = options.variant ?? this.#film
    if (!variant) {
      throw new InstaxError(
        'not-ready',
        'Film size is unknown. Call getStatus() first, or pass { variant }.',
      )
    }

    const spec = filmSpec(variant)
    if (data.length > spec.maxBytes) {
      throw new InstaxError(
        'image-too-large',
        `Image is ${data.length} bytes; ${variant} film accepts at most ${spec.maxBytes}.`,
      )
    }
    if (data.length === 0) {
      throw new InstaxError('image-too-large', 'Image is empty.')
    }

    throwIfAborted(options.signal)

    // A failed transfer is usually the link running ahead of the printer, so
    // each retry slows the fragment cadence down.
    let delay = this.#baseFragmentDelay
    for (;;) {
      try {
        await this.#uploadOnce(data, spec.chunkSize, delay, options)
        return
      } catch (error) {
        if (error instanceof InstaxError && (error.code === 'aborted' || error.code === 'not-connected')) {
          throw error
        }
        delay += 25
        this.#log('info', `upload failed (${describe(error)}); retrying at ${delay}ms/fragment`)
        await this.#cancelUpload()
        if (delay > 200) {
          throw new InstaxError('printer-error', `Image transfer failed: ${describe(error)}`, {
            cause: error,
          })
        }
      }
    }
  }

  /** Prints the image already held by the printer. */
  async printLoaded(copies = 1, options: Omit<PrintOptions, 'copies' | 'variant'> = {}): Promise<void> {
    await this.#triggerPrints(copies, options)
  }

  async #uploadOnce(
    data: Uint8Array,
    chunkSize: number,
    fragmentDelay: number,
    options: UploadOptions,
  ): Promise<void> {
    const start = await this.#command(Opcode.PRINT_IMAGE_DOWNLOAD_START, [
      ...DOWNLOAD_HEADER,
      ...uint32be(data.length),
    ])
    assertOk(start)

    const chunks = toIndexedChunks(data, chunkSize)

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (options.signal?.aborted) {
        await this.#cancelUpload()
        throw new InstaxError('aborted', 'Upload aborted.')
      }

      const packet = encodePacket(Opcode.PRINT_IMAGE_DOWNLOAD_DATA, chunks[chunkIndex] as Uint8Array)

      for (let offset = 0; offset < packet.length; offset += this.#fragmentSize) {
        const isLastFragment = offset + this.#fragmentSize >= packet.length
        // Only the final fragment of a packet is acknowledged; asking for an ack
        // on every fragment would stall the transfer.
        await this.#transport.write(
          packet.subarray(offset, offset + this.#fragmentSize),
          isLastFragment,
        )

        this.#reportProgress(options, {
          phase: 'uploading',
          ratio: (chunkIndex + offset / packet.length) / chunks.length,
        })

        if (fragmentDelay > 0) await sleep(fragmentDelay)
      }
    }

    assertOk(await this.#command(Opcode.PRINT_IMAGE_DOWNLOAD_END, []))
    this.#reportProgress(options, { phase: 'uploading', ratio: 1 })
  }

  async #triggerPrints(copies: number, options: Omit<PrintOptions, 'copies' | 'variant'>): Promise<void> {
    for (let copy = 1; copy <= copies; copy++) {
      throwIfAborted(options.signal)

      assertOk(await this.#command(Opcode.PRINT_IMAGE, []))
      this.#reportProgress(options, { phase: 'printing', ratio: (copy - 1) / copies, copy, copies })

      // No notification marks the end of the mechanical cycle, so wait it out.
      await sleep(this.#ejectDelay, options.signal)

      this.#reportProgress(options, { phase: 'printing', ratio: copy / copies, copy, copies })
    }
  }

  async #cancelUpload(): Promise<void> {
    try {
      await this.#command(Opcode.PRINT_IMAGE_DOWNLOAD_CANCEL, [], false)
    } catch {
      // Best effort: the printer clears its buffer on the next START anyway.
    }
  }

  #reportProgress(options: { onProgress?: (p: PrintProgress) => void }, progress: PrintProgress): void {
    options.onProgress?.(progress)
    this.emit('progress', progress)
  }

  async #command(opcode: number, payload: number[], awaitAck = true): Promise<ResponsePacket> {
    const response = await this.#transport.write(encodePacket(opcode, payload), awaitAck)
    if (!awaitAck) {
      return { opcode, status: 0, command: payload[0] ?? 0, payload: new Uint8Array() }
    }
    if (!response) {
      throw new InstaxError('timeout', `No response to ${opcodeName(opcode)}.`)
    }
    return response
  }
}

function assertOk(packet: ResponsePacket): void {
  if (packet.status !== 0) {
    throw new InstaxError(
      'printer-error',
      `${opcodeName(packet.opcode)} was refused with status ${packet.status}.`,
    )
  }
}

/**
 * Splits image bytes into fixed-size chunks, zero-padding the last one, and
 * prefixes each with its big-endian 32-bit index. Both the fixed size and the
 * padding are required — the printer rejects short packets.
 */
export function toIndexedChunks(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = new Uint8Array(4 + chunkSize)
    chunk.set(uint32be(chunks.length), 0)
    chunk.set(data.subarray(offset, offset + chunkSize), 4)
    chunks.push(chunk)
  }
  return chunks
}

/** Normalises every accepted image representation to raw bytes. */
export async function toBytes(source: ImageSource): Promise<Uint8Array> {
  if (typeof source === 'string') return base64ToBytes(source)
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer())
  }
  throw new TypeError('Unsupported image source')
}

/** Decodes a bare base64 string or a `data:` URL. */
export function base64ToBytes(input: string): Uint8Array {
  const base64 = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InstaxError('aborted', 'Operation aborted.')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InstaxError('aborted', 'Operation aborted.'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new InstaxError('aborted', 'Operation aborted.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
