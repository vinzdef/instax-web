export interface LedPatternOptions {
  /**
   * Animation speed. Lower is faster; the printer treats this as a frame delay.
   * @default 20
   */
  speed?: number
  /**
   * Repeat count. `0` plays once, `255` loops indefinitely.
   * @default 0
   */
  repeat?: number
  /**
   * When the pattern applies. `0` is "now"; other values are reserved for
   * firmware-scheduled patterns.
   * @default 0
   */
  when?: number
}

/**
 * Builds the LED_PATTERN_SETTINGS payload.
 *
 * Layout: `when | color_count | speed | repeat | (b g r) × color_count`.
 * The printer wants BGR, not RGB.
 */
export function encodeLedPattern(colors: string[], options: LedPatternOptions = {}): number[] {
  const { speed = 20, repeat = 0, when = 0 } = options
  if (colors.length === 0) throw new RangeError('At least one colour is required')
  if (colors.length > 0xff) throw new RangeError('At most 255 colours are supported')

  const payload = [when & 0xff, colors.length, speed & 0xff, repeat & 0xff]
  for (const color of colors) payload.push(...hexToBgr(color))
  return payload
}

/** Parses `#rgb`, `#rrggbb` (with or without `#`) into a BGR triplet. */
export function hexToBgr(hex: string): [number, number, number] {
  let value = hex.trim().replace(/^#/, '')
  if (value.length === 3) {
    value = value.replace(/./g, (char) => char + char)
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new RangeError(`Invalid hex colour: ${hex}`)
  }

  const rgb = Number.parseInt(value, 16)
  return [rgb & 0xff, (rgb >> 8) & 0xff, (rgb >> 16) & 0xff]
}
