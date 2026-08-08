import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InstaxError } from '../src/errors.js'
import { Opcode } from '../src/opcodes.js'
import { InstaxPrinter, base64ToBytes, toBytes, toIndexedChunks } from '../src/printer.js'
import type { PrintProgress } from '../src/printer.js'
import { FakePrinter } from './fake-printer.js'

/** A printer with the mechanical waits removed, so tests run in real time. */
async function connected(fake = new FakePrinter(), options = {}) {
  const printer = new InstaxPrinter({
    transport: fake,
    fragmentDelay: 0,
    ejectDelay: 0,
    ...options,
  })
  await printer.connect()
  return printer
}

const jpeg = (bytes: number) => new Uint8Array(bytes).fill(0x42)

describe('toIndexedChunks', () => {
  it('prefixes each chunk with its big-endian index', () => {
    const chunks = toIndexedChunks(new Uint8Array(1800).fill(1), 900)
    expect(chunks).toHaveLength(2)
    expect(Array.from(chunks[0]!.subarray(0, 4))).toEqual([0, 0, 0, 0])
    expect(Array.from(chunks[1]!.subarray(0, 4))).toEqual([0, 0, 0, 1])
  })

  it('zero-pads the final chunk to the full size', () => {
    const chunks = toIndexedChunks(new Uint8Array(950).fill(1), 900)
    const last = chunks[1]!
    expect(last).toHaveLength(904)
    expect(last[4 + 49]).toBe(1)
    expect(last[4 + 50]).toBe(0)
    expect(last[903]).toBe(0)
  })

  it('does not emit a trailing empty chunk for exact multiples', () => {
    expect(toIndexedChunks(new Uint8Array(1800), 900)).toHaveLength(2)
  })
})

describe('toBytes', () => {
  it('accepts a data URL', async () => {
    expect(await toBytes('data:image/jpeg;base64,QUJD')).toEqual(new Uint8Array([65, 66, 67]))
  })

  it('accepts bare base64', async () => {
    expect(base64ToBytes('QUJD')).toEqual(new Uint8Array([65, 66, 67]))
  })

  it('accepts an ArrayBuffer and a view over it', async () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer
    expect(await toBytes(buffer)).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(await toBytes(new Uint8Array(buffer, 1, 2))).toEqual(new Uint8Array([2, 3]))
  })

  it('rejects anything else', async () => {
    await expect(toBytes(42 as never)).rejects.toThrow(TypeError)
  })
})

describe('getStatus', () => {
  it('reads battery, film count, and the loaded film size', async () => {
    const printer = await connected(new FakePrinter({ battery: 87, shotsRemaining: 4 }))
    expect(await printer.getStatus()).toEqual({
      film: 'mini',
      battery: { level: 87, charging: false },
      shotsRemaining: 4,
      image: { width: 600, height: 800 },
    })
  })

  it('identifies square and wide film from their dimensions', async () => {
    const square = await connected(new FakePrinter({ width: 800, height: 800 }))
    expect((await square.getStatus()).film).toBe('square')

    const wide = await connected(new FakePrinter({ width: 1260, height: 840 }))
    expect((await wide.getStatus()).film).toBe('wide')
  })

  it('reports null film for dimensions no known cartridge uses', async () => {
    const printer = await connected(new FakePrinter({ width: 123, height: 456 }))
    expect((await printer.getStatus()).film).toBeNull()
  })

  it('emits a status event', async () => {
    const printer = await connected()
    const listener = vi.fn()
    printer.on('status', listener)
    await printer.getStatus()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ film: 'mini' }))
  })
})

describe('getIdentity', () => {
  it('merges the three device-info sub-commands', async () => {
    const printer = await connected()
    expect(await printer.getIdentity()).toEqual({
      company: 'FUJIFILM',
      printerTypeId: 'mini-link',
      serialNumber: 'SN-0001',
    })
  })
})

describe('print', () => {
  let fake: FakePrinter

  beforeEach(() => {
    fake = new FakePrinter()
  })

  it('delivers the image bytes intact', async () => {
    const printer = await connected(fake)
    await printer.getStatus()

    const image = Uint8Array.from({ length: 2000 }, (_, i) => i & 0xff)
    await printer.print(image)

    // The printer receives zero-padded chunks; the prefix must match the source.
    expect(fake.received.slice(0, image.length)).toEqual(Array.from(image))
    expect(fake.received.length % 900).toBe(0)
  })

  it('declares the unpadded byte length in the download header', async () => {
    const printer = await connected(fake)
    await printer.getStatus()
    await printer.print(jpeg(1234))

    const start = fake.commands.find((c) => c.opcode === Opcode.PRINT_IMAGE_DOWNLOAD_START)!
    expect(Array.from(start.payload)).toEqual([0x02, 0, 0, 0, 0, 0, 0x04, 0xd2])
  })

  it('sends start, data, end, then print', async () => {
    const printer = await connected(fake)
    await printer.getStatus()
    await printer.print(jpeg(100))

    const sequence = fake.commands.map((c) => c.opcode).filter((op) => op !== Opcode.SUPPORT_FUNCTION_INFO)
    expect(sequence).toEqual([
      Opcode.PRINT_IMAGE_DOWNLOAD_START,
      Opcode.PRINT_IMAGE_DOWNLOAD_DATA,
      Opcode.PRINT_IMAGE_DOWNLOAD_END,
      Opcode.PRINT_IMAGE,
    ])
  })

  it('fragments writes to the negotiated MTU', async () => {
    const printer = await connected(fake)
    await printer.getStatus()
    await printer.print(jpeg(900))

    expect(fake.fragments.every((fragment) => fragment.length <= 182)).toBe(true)
    expect(fake.fragments.some((fragment) => fragment.length === 182)).toBe(true)
  })

  it('issues one PRINT_IMAGE per copy', async () => {
    const printer = await connected(fake)
    await printer.getStatus()
    await printer.print(jpeg(100), { copies: 3 })
    expect(fake.printCount).toBe(3)
  })

  it('reports upload progress that ends at 1', async () => {
    const printer = await connected(fake)
    await printer.getStatus()

    const progress: PrintProgress[] = []
    await printer.print(jpeg(2000), { onProgress: (p) => progress.push(p) })

    const uploads = progress.filter((p) => p.phase === 'uploading')
    expect(uploads[0]!.ratio).toBe(0)
    expect(uploads.at(-1)!.ratio).toBe(1)
    expect(uploads.every((p, i) => i === 0 || p.ratio >= uploads[i - 1]!.ratio)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'printing', ratio: 1, copy: 1, copies: 1 })
  })

  it('uses the explicit variant when status has not been read', async () => {
    const printer = await connected(fake)
    await printer.print(jpeg(100), { variant: 'square' })
    expect(fake.received.length).toBe(1808)
  })

  it('refuses to print when the film size is unknown', async () => {
    const printer = await connected(fake)
    await expect(printer.print(jpeg(100))).rejects.toMatchObject({ code: 'not-ready' })
  })

  it('rejects an image over the film byte budget before touching the wire', async () => {
    const printer = await connected(fake)
    await printer.getStatus()
    const before = fake.commands.length
    await expect(printer.print(jpeg(70_000))).rejects.toMatchObject({ code: 'image-too-large' })
    expect(fake.commands).toHaveLength(before)
  })

  it('rejects a non-positive copy count', async () => {
    const printer = await connected(fake)
    await printer.getStatus()
    await expect(printer.print(jpeg(100), { copies: 0 })).rejects.toThrow(RangeError)
  })

  it('retries a refused transfer at a slower cadence, then succeeds', async () => {
    const flaky = new FakePrinter({ failDownloadStartTimes: 2 })
    const printer = await connected(flaky)
    await printer.getStatus()
    await printer.print(jpeg(100))

    expect(flaky.printCount).toBe(1)
    expect(flaky.commands.filter((c) => c.opcode === Opcode.PRINT_IMAGE_DOWNLOAD_START)).toHaveLength(3)
    expect(flaky.commands.some((c) => c.opcode === Opcode.PRINT_IMAGE_DOWNLOAD_CANCEL)).toBe(true)
  })

  it('gives up once the retry cadence exceeds its ceiling', async () => {
    const broken = new FakePrinter({ failDownloadStartTimes: 99 })
    const printer = await connected(broken)
    await printer.getStatus()
    await expect(printer.print(jpeg(100))).rejects.toMatchObject({ code: 'printer-error' })
  })

  it('aborts before the transfer starts', async () => {
    const printer = await connected(fake)
    await printer.getStatus()
    const before = fake.commands.length
    await expect(
      printer.print(jpeg(100), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(fake.commands).toHaveLength(before)
  })

  it('cancels the transfer mid-flight and does not print', async () => {
    const controller = new AbortController()
    const printer = await connected(fake)
    await printer.getStatus()

    printer.on('progress', () => controller.abort())

    await expect(
      printer.print(jpeg(3000), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(fake.printCount).toBe(0)
    expect(fake.commands.some((c) => c.opcode === Opcode.PRINT_IMAGE_DOWNLOAD_CANCEL)).toBe(true)
  })
})

describe('connection lifecycle', () => {
  it('emits connect with the device name', async () => {
    const fake = new FakePrinter()
    const printer = new InstaxPrinter({ transport: fake })
    const listener = vi.fn()
    printer.on('connect', listener)
    await printer.connect()
    expect(listener).toHaveBeenCalledWith({ name: 'INSTAX-12345678(ANDROID)' })
    expect(printer.connected).toBe(true)
  })

  it('emits disconnect and forgets the cached film', async () => {
    const printer = await connected()
    await printer.getStatus()
    expect(printer.film).toBe('mini')

    const listener = vi.fn()
    printer.on('disconnect', listener)
    await printer.disconnect()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(printer.film).toBeNull()
    expect(printer.connected).toBe(false)
  })

  it('surfaces a timeout when the printer never answers', async () => {
    const printer = await connected(new FakePrinter({ silent: true }))
    await expect(printer.getStatus()).rejects.toBeInstanceOf(InstaxError)
  })
})

describe('setLed', () => {
  it('sends the encoded pattern without waiting for an ack', async () => {
    const fake = new FakePrinter()
    const printer = await connected(fake)
    await printer.setLed('#ff0000', { speed: 5, repeat: 255 })

    const command = fake.commands.find((c) => c.opcode === Opcode.LED_PATTERN_SETTINGS)!
    expect(Array.from(command.payload)).toEqual([0, 1, 5, 255, 0x00, 0x00, 0xff])
  })
})
