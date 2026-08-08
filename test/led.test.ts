import { describe, expect, it } from 'vitest'
import { encodeLedPattern, hexToBgr } from '../src/led.js'

describe('hexToBgr', () => {
  it('converts to BGR, which is the order the printer expects', () => {
    expect(hexToBgr('#ff0000')).toEqual([0x00, 0x00, 0xff])
    expect(hexToBgr('0000ff')).toEqual([0xff, 0x00, 0x00])
  })

  it('expands shorthand hex', () => {
    expect(hexToBgr('#f0a')).toEqual([0xaa, 0x00, 0xff])
  })

  it('rejects malformed input instead of printing a silent black', () => {
    expect(() => hexToBgr('#gggggg')).toThrow(RangeError)
    expect(() => hexToBgr('#ff00')).toThrow(RangeError)
  })
})

describe('encodeLedPattern', () => {
  it('lays out when, count, speed, repeat, then colours', () => {
    expect(encodeLedPattern(['#ff0000', '#00ff00'], { speed: 10, repeat: 255, when: 1 })).toEqual([
      1, 2, 10, 255, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00,
    ])
  })

  it('defaults speed and repeat', () => {
    expect(encodeLedPattern(['#000000'])).toEqual([0, 1, 20, 0, 0, 0, 0])
  })

  it('requires at least one colour', () => {
    expect(() => encodeLedPattern([])).toThrow(RangeError)
  })
})
