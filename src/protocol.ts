import { InstaxError } from './errors.js'

/** Magic bytes that open every host → printer packet. */
export const REQUEST_MAGIC = [0x41, 0x62] as const // "Ab"
/** Magic bytes that open every printer → host packet. */
export const RESPONSE_MAGIC = [0x61, 0x42] as const // "aB"

/** Bytes a packet spends on framing: 2 magic + 2 length + 2 opcode + 1 checksum. */
export const FRAME_OVERHEAD = 7

export interface ResponsePacket {
  readonly opcode: number
  /** 0 means success; anything else is a printer-side refusal. */
  readonly status: number
  /** Echoes the sub-command byte the request carried, where one applies. */
  readonly command: number
  readonly payload: Uint8Array
}

/**
 * Frames a command for the printer.
 *
 * Layout: `41 62 | len_hi len_lo | op_hi op_lo | payload… | checksum`
 * where `len` counts the whole packet and `checksum` is the one's complement
 * of the low byte of the sum of every preceding byte.
 */
export function encodePacket(opcode: number, payload: ArrayLike<number> = []): Uint8Array {
  const length = payload.length + FRAME_OVERHEAD
  if (length > 0xffff) {
    throw new RangeError(`Packet payload too long: ${payload.length} bytes`)
  }

  const packet = new Uint8Array(length)
  packet[0] = REQUEST_MAGIC[0]
  packet[1] = REQUEST_MAGIC[1]
  packet[2] = (length >> 8) & 0xff
  packet[3] = length & 0xff
  packet[4] = (opcode >> 8) & 0xff
  packet[5] = opcode & 0xff
  packet.set(payload as ArrayLike<number> & Iterable<number>, 6)
  packet[length - 1] = checksum(packet.subarray(0, length - 1))

  return packet
}

/** One's complement of the low byte of the sum — the printer's trailer byte. */
export function checksum(bytes: Uint8Array): number {
  let sum = 0
  for (const byte of bytes) sum += byte
  return (sum & 0xff) ^ 0xff
}

/**
 * Parses a printer notification into its fields.
 *
 * @throws {InstaxError} with code `invalid-packet` if the magic, declared
 * length, or checksum disagree with the bytes received.
 */
export function decodePacket(bytes: Uint8Array): ResponsePacket {
  if (bytes.length < FRAME_OVERHEAD + 2) {
    throw new InstaxError('invalid-packet', `Response too short: ${bytes.length} bytes`)
  }
  if (bytes[0] !== RESPONSE_MAGIC[0] || bytes[1] !== RESPONSE_MAGIC[1]) {
    throw new InstaxError(
      'invalid-packet',
      `Bad response header: ${toHex(bytes.subarray(0, 2))}`,
    )
  }

  const declaredLength = ((bytes[2] as number) << 8) | (bytes[3] as number)
  if (declaredLength !== bytes.length) {
    throw new InstaxError(
      'invalid-packet',
      `Length mismatch: header says ${declaredLength}, got ${bytes.length}`,
    )
  }

  // A valid packet's bytes sum to 0xff in the low byte, checksum included.
  let sum = 0
  for (const byte of bytes) sum += byte
  if ((sum & 0xff) !== 0xff) {
    throw new InstaxError('invalid-packet', `Checksum mismatch on ${toHex(bytes)}`)
  }

  return {
    opcode: ((bytes[4] as number) << 8) | (bytes[5] as number),
    status: bytes[6] as number,
    command: bytes[7] as number,
    payload: bytes.slice(8, bytes.length - 1),
  }
}

/** `true` when the bytes look like the start of a printer response. */
export function looksLikeResponse(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === RESPONSE_MAGIC[0] && bytes[1] === RESPONSE_MAGIC[1]
}

/** Big-endian 32-bit encoding, as used by the image-download length field. */
export function uint32be(value: number): [number, number, number, number] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/** Space-separated hex, for logs and error messages. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
}
