import { Opcode, SupportFunction } from './opcodes.js'
import type { ResponsePacket } from './protocol.js'

export interface ImageSpecsInfo {
  width: number
  height: number
  /** Bytes per image-download packet the printer advertises. */
  packetSize: number
}

export interface BatteryInfo {
  /** Charge percentage as reported, 0-100. */
  level: number
  charging: boolean
}

export interface FilmCountInfo {
  /** Shots left in the cartridge, 0-10. */
  shotsRemaining: number
}

export interface DeviceIdentity {
  company?: string
  printerTypeId?: string
  serialNumber?: string
}

/**
 * The printer reports charging as a small enum rather than a flag; values above
 * this threshold mean "on external power". Derived from observed traffic, so it
 * is a heuristic, not a documented contract.
 */
const CHARGING_THRESHOLD = 5

function u16(payload: Uint8Array, offset: number): number {
  if (payload.length < offset + 2) return 0
  return ((payload[offset] as number) << 8) | (payload[offset + 1] as number)
}

function u8(payload: Uint8Array, offset: number): number {
  return payload.length < offset + 1 ? 0 : (payload[offset] as number)
}

export function parseImageSpecs(packet: ResponsePacket): ImageSpecsInfo {
  return {
    width: u16(packet.payload, 0),
    height: u16(packet.payload, 2),
    packetSize: u16(packet.payload, 4),
  }
}

export function parseBattery(packet: ResponsePacket): BatteryInfo {
  return {
    charging: u8(packet.payload, 0) > CHARGING_THRESHOLD,
    level: u8(packet.payload, 1),
  }
}

export function parseFilmCount(packet: ResponsePacket): FilmCountInfo {
  // The count lives in the low nibble; the high nibble carries unrelated flags.
  return { shotsRemaining: u8(packet.payload, 0) & 0x0f }
}

export function parseDeviceInfo(packet: ResponsePacket): DeviceIdentity {
  // 0x08 is used as padding inside these ASCII fields.
  const text = String.fromCharCode(...Array.from(packet.payload).filter((code) => code !== 0x08))
  switch (packet.command) {
    case 0:
      return { company: text }
    case 1:
      return { printerTypeId: text }
    case 2:
      return { serialNumber: text }
    default:
      return {}
  }
}

/**
 * Best-effort decode of any response into a plain object, for logging and for
 * opcodes this library does not model. Typed callers should prefer the
 * `parse*` functions above.
 */
export function describeResponse(packet: ResponsePacket): Record<string, unknown> {
  if (packet.opcode === Opcode.DEVICE_INFO_SERVICE) {
    return { ...parseDeviceInfo(packet) }
  }
  if (packet.opcode === Opcode.SUPPORT_FUNCTION_INFO) {
    switch (packet.command) {
      case SupportFunction.IMAGE_SPECS:
        return { ...parseImageSpecs(packet) }
      case SupportFunction.BATTERY:
        return { ...parseBattery(packet) }
      case SupportFunction.FILM_COUNT:
        return { ...parseFilmCount(packet) }
      default:
        break
    }
  }
  return {
    opcode: packet.opcode,
    command: packet.command,
    status: packet.status,
    payload: Array.from(packet.payload),
  }
}
