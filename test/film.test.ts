import { describe, expect, it } from 'vitest'
import { FILM_SPECS, filmSpec, filmVariantForSize } from '../src/film.js'

describe('filmSpec', () => {
  it('exposes the dimensions each film prints at', () => {
    expect(filmSpec('mini')).toMatchObject({ width: 600, height: 800 })
    expect(filmSpec('square')).toMatchObject({ width: 800, height: 800 })
    expect(filmSpec('wide')).toMatchObject({ width: 1260, height: 840 })
  })

  it('uses the larger download packet only for square film', () => {
    expect(filmSpec('square').chunkSize).toBe(1808)
    expect(filmSpec('mini').chunkSize).toBe(900)
    expect(filmSpec('wide').chunkSize).toBe(900)
  })

  it('throws on an unknown variant', () => {
    expect(() => filmSpec('instant' as never)).toThrow(RangeError)
  })
})

describe('filmVariantForSize', () => {
  it('matches every known film', () => {
    for (const spec of Object.values(FILM_SPECS)) {
      expect(filmVariantForSize(spec.width, spec.height)).toBe(spec.variant)
    }
  })

  it('returns null rather than guessing at unknown dimensions', () => {
    expect(filmVariantForSize(640, 480)).toBeNull()
  })
})
