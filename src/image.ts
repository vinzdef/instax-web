import { InstaxError } from './errors.js'
import { filmSpec, type FilmVariant } from './film.js'

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PrepareImageOptions {
  /** Film the output must fit. Determines the output dimensions. */
  variant: FilmVariant
  /**
   * `cover` fills the frame and crops the overflow; `contain` fits the whole
   * image and fills the remainder with {@link background}.
   * @default 'cover'
   */
  fit?: 'cover' | 'contain'
  /** Letterbox colour used by `contain`. @default '#ffffff' */
  background?: string
  /** Source-pixel region to use. Defaults to the whole image. */
  crop?: CropRect
  /** Clockwise rotation applied before fitting. @default 0 */
  rotate?: 0 | 90 | 180 | 270
  /** Overrides the film's byte budget. */
  maxBytes?: number
  /** Lowest JPEG quality to accept before giving up. @default 0.05 */
  minQuality?: number
  /** Quality to try first, and the ceiling. @default 0.95 */
  maxQuality?: number
  /** Bisection steps. More steps means a slightly better image, slower. @default 8 */
  steps?: number
}

/** Anything that can be decoded into pixels. */
export type ImageInput = Blob | ImageBitmap | HTMLImageElement | HTMLCanvasElement | string

interface Canvas2D {
  width: number
  height: number
  getContext(id: '2d'): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
}

/**
 * Resizes, crops, and JPEG-encodes an image so a printer will accept it.
 *
 * INSTAX printers take a JPEG at the film's exact pixel dimensions and under a
 * fixed byte budget, so quality is bisected until the output fits rather than
 * guessed at.
 *
 * Browser-only: it needs a canvas and a JPEG encoder.
 */
export async function prepareImage(
  input: ImageInput,
  options: PrepareImageOptions,
): Promise<Uint8Array> {
  const spec = filmSpec(options.variant)
  const maxBytes = options.maxBytes ?? spec.maxBytes
  const minQuality = options.minQuality ?? 0.05
  const maxQuality = options.maxQuality ?? 0.95
  const steps = options.steps ?? 8

  const source = await decode(input)
  const canvas = draw(source, spec.width, spec.height, options)

  let low = minQuality
  let high = maxQuality
  let best: Blob | null = null

  // Try the ceiling first: most already-small images pass on the first attempt.
  const initial = await encodeJpeg(canvas, maxQuality)
  if (initial.size <= maxBytes) {
    best = initial
  } else {
    for (let step = 0; step < steps; step++) {
      const quality = (low + high) / 2
      const candidate = await encodeJpeg(canvas, quality)
      if (candidate.size <= maxBytes) {
        best = candidate
        low = quality
      } else {
        high = quality
      }
    }
  }

  if (!best) {
    throw new InstaxError(
      'image-too-large',
      `Could not encode ${spec.width}x${spec.height} under ${maxBytes} bytes at quality ${minQuality}.`,
    )
  }

  return new Uint8Array(await best.arrayBuffer())
}

async function decode(input: ImageInput): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof input === 'string') {
    return decode(await fetchBlob(input))
  }
  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) return input
  if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) return input
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    if (!input.complete) await input.decode()
    return Object.assign(input, { width: input.naturalWidth, height: input.naturalHeight })
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (typeof createImageBitmap === 'undefined') {
      throw new InstaxError(
        'unsupported',
        'prepareImage needs a browser environment: createImageBitmap is unavailable.',
      )
    }
    // createImageBitmap applies EXIF orientation, which an <img> would too but
    // a raw canvas draw would not.
    return await createImageBitmap(input, { imageOrientation: 'from-image' })
  }
  throw new TypeError('Unsupported image input')
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load image: ${response.status} ${response.statusText}`)
  return await response.blob()
}

function draw(
  source: CanvasImageSource & { width: number; height: number },
  targetWidth: number,
  targetHeight: number,
  options: PrepareImageOptions,
): Canvas2D {
  const canvas = createCanvas(targetWidth, targetHeight)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not acquire a 2D canvas context')

  context.fillStyle = options.background ?? '#ffffff'
  context.fillRect(0, 0, targetWidth, targetHeight)
  context.imageSmoothingQuality = 'high'

  const crop = options.crop ?? { x: 0, y: 0, width: source.width, height: source.height }
  const rotate = options.rotate ?? 0
  // A quarter turn swaps which source axis maps onto which target axis.
  const swapped = rotate === 90 || rotate === 270
  const fitWidth = swapped ? crop.height : crop.width
  const fitHeight = swapped ? crop.width : crop.height

  const scale =
    (options.fit ?? 'cover') === 'contain'
      ? Math.min(targetWidth / fitWidth, targetHeight / fitHeight)
      : Math.max(targetWidth / fitWidth, targetHeight / fitHeight)

  const drawWidth = crop.width * scale
  const drawHeight = crop.height * scale

  context.save()
  context.translate(targetWidth / 2, targetHeight / 2)
  if (rotate) context.rotate((rotate * Math.PI) / 180)
  context.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    -drawWidth / 2,
    -drawHeight / 2,
    drawWidth,
    drawHeight,
  )
  context.restore()

  return canvas
}

function createCanvas(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  if (typeof document === 'undefined') {
    throw new Error('prepareImage needs a browser environment with canvas support')
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function encodeJpeg(canvas: Canvas2D, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality })
  }
  return new Promise((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
      'image/jpeg',
      quality,
    )
  })
}
