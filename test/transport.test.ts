import { afterEach, describe, expect, it, vi } from 'vitest'
import { Opcode } from '../src/opcodes.js'
import { encodePacket } from '../src/protocol.js'
import { BleTransport } from '../src/transport.js'
import { FakeCharacteristic, FakeDevice, fakeNavigator } from './fake-bluetooth.js'
import { buildResponse } from './fake-printer.js'

function setup(options: { characteristics?: FakeCharacteristic[]; ackTimeout?: number } = {}) {
  const characteristic = new FakeCharacteristic()
  const device = new FakeDevice('INSTAX-1234', options.characteristics ?? [characteristic])
  vi.stubGlobal('navigator', fakeNavigator(device))
  const transport = new BleTransport({ ackTimeout: options.ackTimeout ?? 50 })
  return { transport, characteristic, device }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connect', () => {
  it('reports the device name and subscribes to notifications', async () => {
    const { transport, characteristic } = setup()
    await transport.connect()

    expect(transport.connected).toBe(true)
    expect(transport.name).toBe('INSTAX-1234')
    expect(characteristic.notifying).toBe(true)
  })

  it('fails with `unsupported` when the browser has no Web Bluetooth', async () => {
    vi.stubGlobal('navigator', {})
    await expect(new BleTransport().connect()).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('reports a dismissed chooser as `cancelled`, not a failure', async () => {
    vi.stubGlobal('navigator', fakeNavigator(new DOMException('user cancelled', 'NotFoundError')))
    await expect(new BleTransport().connect()).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('reports other chooser failures as `disconnected`', async () => {
    vi.stubGlobal('navigator', fakeNavigator(new DOMException('boom', 'SecurityError')))
    await expect(new BleTransport().connect()).rejects.toMatchObject({ code: 'disconnected' })
  })

  it('rejects a service with no notifying characteristic', async () => {
    const { transport } = setup({
      characteristics: [new FakeCharacteristic({ notify: false })],
    })
    await expect(transport.connect()).rejects.toMatchObject({ code: 'disconnected' })
    expect(transport.connected).toBe(false)
  })

  it('picks the writable and the notifying characteristic out of several', async () => {
    const readOnly = new FakeCharacteristic({ write: false, writeWithoutResponse: false, notify: false })
    const writer = new FakeCharacteristic({ notify: false })
    const notifier = new FakeCharacteristic({ write: false, writeWithoutResponse: false })
    const { transport } = setup({ characteristics: [readOnly, writer, notifier] })

    await transport.connect()
    await transport.write(encodePacket(Opcode.PRINT_IMAGE), false)

    expect(writer.writes).toHaveLength(1)
    expect(notifier.notifying).toBe(true)
  })
})

describe('write', () => {
  it('refuses to write before connecting', async () => {
    const { transport } = setup()
    await expect(transport.write(new Uint8Array([1]), false)).rejects.toMatchObject({
      code: 'not-connected',
    })
  })

  it('resolves with the decoded acknowledgement', async () => {
    const { transport, characteristic } = setup()
    await transport.connect()
    characteristic.onWrite = () => [buildResponse(Opcode.SUPPORT_FUNCTION_INFO, 1, [0, 90])]

    const response = await transport.write(encodePacket(Opcode.SUPPORT_FUNCTION_INFO, [1]), true)
    expect(response).toMatchObject({ status: 0, command: 1 })
    expect(Array.from(response!.payload)).toEqual([0, 90])
  })

  it('resolves without waiting when no acknowledgement is asked for', async () => {
    const { transport, characteristic } = setup()
    await transport.connect()
    expect(await transport.write(encodePacket(Opcode.PRINT_IMAGE), false)).toBeNull()
    expect(characteristic.writes).toHaveLength(1)
  })

  it('reassembles a response split across notifications', async () => {
    const { transport, characteristic } = setup()
    await transport.connect()

    const full = buildResponse(Opcode.DEVICE_INFO_SERVICE, 2, [0x41, 0x42, 0x43, 0x44])
    characteristic.onWrite = () => [full.subarray(0, 5), full.subarray(5)]

    const response = await transport.write(encodePacket(Opcode.DEVICE_INFO_SERVICE, [2]), true)
    expect(Array.from(response!.payload)).toEqual([0x41, 0x42, 0x43, 0x44])
  })

  it('times out when the printer stays silent', async () => {
    const { transport } = setup({ ackTimeout: 20 })
    await transport.connect()
    await expect(transport.write(encodePacket(Opcode.PRINT_IMAGE), true)).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('rejects a corrupted notification as `invalid-packet`', async () => {
    const { transport, characteristic } = setup()
    await transport.connect()

    const corrupt = buildResponse(Opcode.PRINT_IMAGE, 0)
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1]! + 1) & 0xff
    characteristic.onWrite = () => [corrupt]

    await expect(transport.write(encodePacket(Opcode.PRINT_IMAGE), true)).rejects.toMatchObject({
      code: 'invalid-packet',
    })
  })

  it('ignores notification traffic that is not a response frame', async () => {
    const { transport, characteristic } = setup({ ackTimeout: 40 })
    await transport.connect()

    characteristic.onWrite = () => [
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      buildResponse(Opcode.PRINT_IMAGE, 0),
    ]

    const response = await transport.write(encodePacket(Opcode.PRINT_IMAGE), true)
    expect(response).toMatchObject({ opcode: Opcode.PRINT_IMAGE, status: 0 })
  })

  it('ignores a response for a different opcode and waits for its own', async () => {
    const { transport, characteristic } = setup({ ackTimeout: 200 })
    await transport.connect()

    characteristic.onWrite = () => [
      // Late reply to an earlier command that was sent without awaiting one.
      buildResponse(Opcode.PRINT_IMAGE_DOWNLOAD_CANCEL, 0),
      buildResponse(Opcode.PRINT_IMAGE_DOWNLOAD_START, 0),
    ]

    const response = await transport.write(encodePacket(Opcode.PRINT_IMAGE_DOWNLOAD_START), true)
    expect(response).toMatchObject({ opcode: Opcode.PRINT_IMAGE_DOWNLOAD_START })
  })

  it('times out rather than resolving with a reply meant for another command', async () => {
    const { transport, characteristic } = setup({ ackTimeout: 20 })
    await transport.connect()
    characteristic.onWrite = () => [buildResponse(Opcode.PRINT_IMAGE_DOWNLOAD_CANCEL, 0)]

    await expect(
      transport.write(encodePacket(Opcode.PRINT_IMAGE_DOWNLOAD_START), true),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('matches the ack of a fragmented packet to the opcode in its header fragment', async () => {
    const { transport, characteristic } = setup({ ackTimeout: 200 })
    await transport.connect()

    const packet = encodePacket(Opcode.PRINT_IMAGE_DOWNLOAD_DATA, new Uint8Array(300))
    await transport.write(packet.subarray(0, 182), false)
    characteristic.onWrite = () => [buildResponse(Opcode.PRINT_IMAGE_DOWNLOAD_DATA, 0)]

    const response = await transport.write(packet.subarray(182), true)
    expect(response).toMatchObject({ opcode: Opcode.PRINT_IMAGE_DOWNLOAD_DATA })
  })

  it('serialises concurrent writes so replies cannot cross', async () => {
    const { transport, characteristic } = setup({ ackTimeout: 200 })
    await transport.connect()

    characteristic.writeDelay = 5
    characteristic.onWrite = (bytes) => {
      // Echo the sub-command byte back so each reply is identifiable.
      const command = bytes[6] as number
      return [buildResponse(Opcode.SUPPORT_FUNCTION_INFO, command, [command])]
    }

    const responses = await Promise.all([
      transport.write(encodePacket(Opcode.SUPPORT_FUNCTION_INFO, [0]), true),
      transport.write(encodePacket(Opcode.SUPPORT_FUNCTION_INFO, [1]), true),
      transport.write(encodePacket(Opcode.SUPPORT_FUNCTION_INFO, [2]), true),
    ])

    expect(responses.map((r) => r!.command)).toEqual([0, 1, 2])
    expect(characteristic.writes.map((w) => w[6])).toEqual([0, 1, 2])
  })

  it('keeps the queue moving after a write fails', async () => {
    const { transport, characteristic } = setup()
    await transport.connect()
    characteristic.onWrite = () => [buildResponse(Opcode.PRINT_IMAGE, 0)]
    characteristic.writeError = new Error('GATT operation failed')

    const first = transport.write(encodePacket(Opcode.PRINT_IMAGE), true)
    const second = transport.write(encodePacket(Opcode.PRINT_IMAGE), true)

    await expect(first).rejects.toMatchObject({ code: 'disconnected' })
    await expect(second).resolves.toMatchObject({ opcode: Opcode.PRINT_IMAGE })
  })

  it('falls back to writeValue when the characteristic lacks writeWithoutResponse', async () => {
    const characteristic = new FakeCharacteristic({ writeWithoutResponse: false })
    const { transport } = setup({ characteristics: [characteristic] })
    await transport.connect()

    const spy = vi.spyOn(characteristic, 'writeValue')
    await transport.write(encodePacket(Opcode.PRINT_IMAGE), false)
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('disconnect', () => {
  it('unsubscribes, drops the link, and fires onDisconnect once', async () => {
    const { transport, characteristic } = setup()
    await transport.connect()

    const onDisconnect = vi.fn()
    transport.onDisconnect = onDisconnect
    await transport.disconnect()

    expect(transport.connected).toBe(false)
    expect(characteristic.notifying).toBe(false)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('fires onDisconnect when the link drops on its own', async () => {
    const { transport, device } = setup()
    await transport.connect()

    const onDisconnect = vi.fn()
    transport.onDisconnect = onDisconnect
    device.dropLink()

    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(transport.connected).toBe(false)
  })

  it('fails an in-flight request instead of leaving it hanging', async () => {
    const { transport, characteristic, device } = setup({ ackTimeout: 5000 })
    await transport.connect()

    characteristic.writeDelay = 5
    const pending = transport.write(encodePacket(Opcode.PRINT_IMAGE), true)
    await Promise.resolve()
    device.dropLink()

    await expect(pending).rejects.toMatchObject({ code: 'disconnected' })
  })
})

describe('logger', () => {
  it('traces both directions', async () => {
    const logger = vi.fn()
    const characteristic = new FakeCharacteristic()
    const device = new FakeDevice('INSTAX-1234', [characteristic])
    vi.stubGlobal('navigator', fakeNavigator(device))

    const transport = new BleTransport({ logger, ackTimeout: 50 })
    await transport.connect()
    characteristic.onWrite = () => [buildResponse(Opcode.PRINT_IMAGE, 0)]
    await transport.write(encodePacket(Opcode.PRINT_IMAGE), true)

    const directions = logger.mock.calls.map(([direction]) => direction)
    expect(directions).toContain('info')
    expect(directions).toContain('tx')
    expect(directions).toContain('rx')
  })
})
