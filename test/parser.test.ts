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

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

describe('parseDeviceInfo', () => {
  it('reads the leading length byte rather than the whole payload', () => {
    // Captured from an FI033: a count of 5 that an earlier decoder kept as a
    // control character on the front of the string.
    expect(parseDeviceInfo(response(0x0001, 1, [5, ...ascii('FI033')]))).toEqual({
      printerTypeId: 'FI033',
    })
  })

  it('ignores bytes past the declared length', () => {
    expect(parseDeviceInfo(response(0x0001, 0, [8, ...ascii('FUJIFILM'), 0x08, 0x08]))).toEqual({
      company: 'FUJIFILM',
    })
  })

  it('maps each sub-command to its own field', () => {
    expect(parseDeviceInfo(response(0x0001, 0, [1, 0x41]))).toEqual({ company: 'A' })
    expect(parseDeviceInfo(response(0x0001, 2, [8, ...ascii('70535674')]))).toEqual({
      serialNumber: '70535674',
    })
    expect(parseDeviceInfo(response(0x0001, 9, [1, 0x41]))).toEqual({})
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
