import { describe, expect, it } from 'vitest'
import { InstaxError } from '../src/errors.js'
import { checksum, decodePacket, encodePacket, toHex, uint32be } from '../src/protocol.js'
import { buildResponse } from './fake-printer.js'

describe('encodePacket', () => {
  it('frames an empty payload', () => {
    const packet = encodePacket(0x1080)
    expect(toHex(packet)).toBe('41 62 00 07 10 80 c5')
    expect(packet).toHaveLength(7)
  })

  it('declares the total packet length, not the payload length', () => {
    const packet = encodePacket(0x0002, [1])
    expect((packet[2]! << 8) | packet[3]!).toBe(packet.length)
    expect(packet.length).toBe(8)
  })

  it('appends the one’s-complement checksum so the packet sums to 0xff', () => {
    const packet = encodePacket(0x1000, [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x12, 0x34])
    const sum = packet.reduce((total, byte) => total + byte, 0)
    expect(sum & 0xff).toBe(0xff)
  })

  it('rejects payloads that overflow the 16-bit length field', () => {
    expect(() => encodePacket(0x1001, new Uint8Array(0x10000))).toThrow(RangeError)
  })
})

describe('decodePacket', () => {
  it('round-trips a printer response', () => {
    const packet = decodePacket(buildResponse(0x0002, 1, [0, 87]))
    expect(packet).toEqual({
      opcode: 0x0002,
      status: 0,
      command: 1,
      payload: new Uint8Array([0, 87]),
    })
  })

  it('surfaces a non-zero status rather than discarding it', () => {
    expect(decodePacket(buildResponse(0x1000, 0, [], 3)).status).toBe(3)
  })

  it('rejects a wrong header', () => {
    const bytes = buildResponse(0x0002, 1, [0, 87])
    bytes[0] = 0x41
    expect(() => decodePacket(bytes)).toThrow(InstaxError)
  })

  it('rejects a corrupted checksum', () => {
    const bytes = buildResponse(0x0002, 1, [0, 87])
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) & 0xff
    expect(() => decodePacket(bytes)).toThrowError(/Checksum mismatch/)
  })

  it('rejects a length that disagrees with the bytes received', () => {
    const bytes = buildResponse(0x0002, 1, [0, 87])
    expect(() => decodePacket(bytes.subarray(0, bytes.length - 1))).toThrowError(/Length mismatch/)
  })

  it('rejects a runt packet', () => {
    expect(() => decodePacket(new Uint8Array([0x61, 0x42]))).toThrowError(/too short/)
  })
})

describe('checksum', () => {
  it('is the complement of the low byte of the sum', () => {
    expect(checksum(new Uint8Array([0x01, 0x02]))).toBe(0xfc)
    expect(checksum(new Uint8Array([0xff, 0x01]))).toBe(0xff)
  })
})

describe('uint32be', () => {
  it('emits big-endian bytes', () => {
    expect(uint32be(0x12345678)).toEqual([0x12, 0x34, 0x56, 0x78])
    expect(uint32be(60000)).toEqual([0x00, 0x00, 0xea, 0x60])
  })
})
