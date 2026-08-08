import { Opcode } from '../src/opcodes.js'
import { decodePacket, type ResponsePacket } from '../src/protocol.js'
import type { Transport } from '../src/transport.js'

/** Builds a printer→host packet the way the firmware does. */
export function buildResponse(
  opcode: number,
  command: number,
  payload: number[] = [],
  status = 0,
): Uint8Array {
  const length = payload.length + 9 // magic 2 + length 2 + opcode 2 + status + command + checksum
  const bytes = new Uint8Array(length)
  bytes[0] = 0x61
  bytes[1] = 0x42
  bytes[2] = (length >> 8) & 0xff
  bytes[3] = length & 0xff
  bytes[4] = (opcode >> 8) & 0xff
  bytes[5] = opcode & 0xff
  bytes[6] = status
  bytes[7] = command
  bytes.set(payload, 8)

  let sum = 0
  for (let i = 0; i < length - 1; i++) sum += bytes[i] as number
  bytes[length - 1] = (sum & 0xff) ^ 0xff
  return bytes
}

export interface FakePrinterOptions {
  width?: number
  height?: number
  battery?: number
  charging?: number
  shotsRemaining?: number
  /** Fail the Nth (0-based) acknowledged write with a non-zero status. */
  failDownloadStartTimes?: number
  /** Never answer; used to exercise timeouts. */
  silent?: boolean
}

/**
 * In-memory stand-in for a printer, exercising the same framing as the real
 * device so protocol regressions surface without hardware.
 */
export class FakePrinter implements Transport {
  onDisconnect: (() => void) | null = null
  connected = false
  readonly name = 'INSTAX-12345678(ANDROID)'

  /** Every fragment written, in order. */
  readonly fragments: Uint8Array[] = []
  /** Every complete host→printer packet, decoded. */
  readonly commands: { opcode: number; payload: Uint8Array }[] = []
  /** Image bytes reassembled from PRINT_IMAGE_DOWNLOAD_DATA packets. */
  readonly received: number[] = []
  printCount = 0

  #buffer: number[] = []
  #downloadStartFailures: number
  readonly #options: Required<Omit<FakePrinterOptions, 'failDownloadStartTimes' | 'silent'>> &
    Pick<FakePrinterOptions, 'silent'>

  constructor(options: FakePrinterOptions = {}) {
    this.#downloadStartFailures = options.failDownloadStartTimes ?? 0
    this.#options = {
      width: options.width ?? 600,
      height: options.height ?? 800,
      battery: options.battery ?? 87,
      charging: options.charging ?? 0,
      shotsRemaining: options.shotsRemaining ?? 7,
      silent: options.silent,
    }
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.onDisconnect?.()
  }

  async write(bytes: Uint8Array, awaitAck: boolean): Promise<ResponsePacket | null> {
    if (!this.connected) throw new Error('not connected')
    this.fragments.push(bytes.slice())
    this.#buffer.push(...bytes)

    // Host packets are fragmented; reassemble using the declared length.
    if (this.#buffer.length < 4) return null
    const declared = ((this.#buffer[2] as number) << 8) | (this.#buffer[3] as number)
    if (this.#buffer.length < declared) return null

    const packet = new Uint8Array(this.#buffer.splice(0, declared))
    const response = this.#handle(packet)
    if (!awaitAck || this.#options.silent) return null
    return decodePacket(response)
  }

  #handle(packet: Uint8Array): Uint8Array {
    const opcode = ((packet[4] as number) << 8) | (packet[5] as number)
    const payload = packet.slice(6, packet.length - 1)
    this.commands.push({ opcode, payload })
    const command = payload[0] ?? 0

    switch (opcode) {
      case Opcode.SUPPORT_FUNCTION_INFO:
        return this.#supportFunctionInfo(command)

      case Opcode.DEVICE_INFO_SERVICE: {
        const text = ['FUJIFILM', 'mini-link', 'SN-0001'][command] ?? ''
        return buildResponse(opcode, command, Array.from(text, (char) => char.charCodeAt(0)))
      }

      case Opcode.PRINT_IMAGE_DOWNLOAD_START: {
        this.received.length = 0
        if (this.#downloadStartFailures > 0) {
          this.#downloadStartFailures--
          return buildResponse(opcode, command, [], 1)
        }
        return buildResponse(opcode, command)
      }

      case Opcode.PRINT_IMAGE_DOWNLOAD_DATA:
        // Strip the 4-byte chunk index prefix.
        this.received.push(...payload.slice(4))
        return buildResponse(opcode, command)

      case Opcode.PRINT_IMAGE:
        this.printCount++
        return buildResponse(opcode, command)

      default:
        return buildResponse(opcode, command)
    }
  }

  #supportFunctionInfo(command: number): Uint8Array {
    const { width, height, battery, charging, shotsRemaining } = this.#options
    switch (command) {
      case 0:
        return buildResponse(Opcode.SUPPORT_FUNCTION_INFO, 0, [
          (width >> 8) & 0xff,
          width & 0xff,
          (height >> 8) & 0xff,
          height & 0xff,
          0x02,
          0x00,
        ])
      case 1:
        return buildResponse(Opcode.SUPPORT_FUNCTION_INFO, 1, [charging, battery])
      case 2:
        return buildResponse(Opcode.SUPPORT_FUNCTION_INFO, 2, [shotsRemaining])
      default:
        return buildResponse(Opcode.SUPPORT_FUNCTION_INFO, command)
    }
  }
}
