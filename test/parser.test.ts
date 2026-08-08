import { describe, expect, it } from 'vitest'
import {
  describeResponse,
  parseBattery,
  parseDeviceInfo,
  parseFilmCount,
  parseImageSpecs,
} from '../src/parser.js'
import { decodePacket } from '../src/protocol.js'
import { buildResponse } from './fake-printer.js'

const response = (opcode: number, command: number, payload: number[]) =>
  decodePacket(buildResponse(opcode, command, payload))

describe('parseImageSpecs', () => {
  it('reads big-endian dimensions', () => {
    const specs = parseImageSpecs(response(0x0002, 0, [0x02, 0x58, 0x03, 0x20, 0x02, 0x00]))
    expect(specs).toEqual({ width: 600, height: 800, packetSize: 512 })
  })

  it('returns zeroes for a truncated payload rather than NaN', () => {
    expect(parseImageSpecs(response(0x0002, 0, [0x02]))).toEqual({
      width: 0,
      height: 0,
      packetSize: 0,
    })
  })
})

describe('parseBattery', () => {
  it('reads the level from the second byte', () => {
    expect(parseBattery(response(0x0002, 1, [0, 87]))).toEqual({ level: 87, charging: false })
  })

  it('treats values above the threshold as charging', () => {
    expect(parseBattery(response(0x0002, 1, [6, 40])).charging).toBe(true)
    expect(parseBattery(response(0x0002, 1, [5, 40])).charging).toBe(false)
  })
})

describe('parseFilmCount', () => {
  it('masks the count out of the low nibble', () => {
    expect(parseFilmCount(response(0x0002, 2, [0x07]))).toEqual({ shotsRemaining: 7 })
    expect(parseFilmCount(response(0x0002, 2, [0xa3]))).toEqual({ shotsRemaining: 3 })
  })
})

describe('parseDeviceInfo', () => {
  it('decodes ASCII and drops padding bytes', () => {
    const bytes = [...'FUJIFILM'].map((char) => char.charCodeAt(0))
    expect(parseDeviceInfo(response(0x0001, 0, [...bytes, 0x08, 0x08]))).toEqual({
      company: 'FUJIFILM',
    })
  })

  it('maps each sub-command to its own field', () => {
    expect(parseDeviceInfo(response(0x0001, 1, [0x41]))).toEqual({ printerTypeId: 'A' })
    expect(parseDeviceInfo(response(0x0001, 2, [0x41]))).toEqual({ serialNumber: 'A' })
    expect(parseDeviceInfo(response(0x0001, 9, [0x41]))).toEqual({})
  })
})

describe('describeResponse', () => {
  it('falls back to raw fields for unmodelled opcodes', () => {
    expect(describeResponse(response(0x3001, 0, [1, 2]))).toEqual({
      opcode: 0x3001,
      command: 0,
      status: 0,
      payload: [1, 2],
    })
  })

  it('dispatches known opcodes to their parsers', () => {
    expect(describeResponse(response(0x0002, 1, [0, 50]))).toEqual({ level: 50, charging: false })
  })
})
