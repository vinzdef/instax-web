/** Film formats an INSTAX Link printer can be loaded with. */
export type FilmVariant = 'mini' | 'square' | 'wide'

export interface FilmSpec {
  readonly variant: FilmVariant
  /** Pixel width the printer expects. */
  readonly width: number
  /** Pixel height the printer expects. */
  readonly height: number
  /**
   * Payload bytes per image-download packet. The printer rejects other sizes;
   * square firmware uses a larger packet than mini/wide.
   */
  readonly chunkSize: number
  /** Largest JPEG the printer will accept, in bytes. */
  readonly maxBytes: number
}

export const FILM_SPECS: Readonly<Record<FilmVariant, FilmSpec>> = {
  mini: { variant: 'mini', width: 600, height: 800, chunkSize: 900, maxBytes: 60 * 1024 },
  square: { variant: 'square', width: 800, height: 800, chunkSize: 1808, maxBytes: 60 * 1024 },
  wide: { variant: 'wide', width: 1260, height: 840, chunkSize: 900, maxBytes: 60 * 1024 },
}

export function filmSpec(variant: FilmVariant): FilmSpec {
  const spec = FILM_SPECS[variant]
  if (!spec) throw new RangeError(`Unknown film variant: ${String(variant)}`)
  return spec
}

/**
 * Maps the image dimensions the printer reports to a film variant.
 * Returns `null` for dimensions no known film uses, so callers can fall back
 * to an explicit variant rather than printing at the wrong size.
 */
export function filmVariantForSize(width: number, height: number): FilmVariant | null {
  for (const spec of Object.values(FILM_SPECS)) {
    if (spec.width === width && spec.height === height) return spec.variant
  }
  return null
}
