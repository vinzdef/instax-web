import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../src/emitter.js'
import { InstaxError, isInstaxError } from '../src/errors.js'

class Bus extends Emitter<{ ping: number; pong: void }> {
  fire<K extends 'ping' | 'pong'>(event: K, payload: { ping: number; pong: void }[K]) {
    this.emit(event, payload)
  }
}

describe('Emitter', () => {
  it('delivers payloads to every listener', () => {
    const bus = new Bus()
    const a = vi.fn()
    const b = vi.fn()
    bus.on('ping', a)
    bus.on('ping', b)
    bus.fire('ping', 7)
    expect(a).toHaveBeenCalledWith(7)
    expect(b).toHaveBeenCalledWith(7)
  })

  it('unsubscribes via the returned function and via off()', () => {
    const bus = new Bus()
    const viaReturn = vi.fn()
    const viaOff = vi.fn()
    const unsubscribe = bus.on('ping', viaReturn)
    bus.on('ping', viaOff)

    unsubscribe()
    bus.off('ping', viaOff)
    bus.fire('ping', 1)

    expect(viaReturn).not.toHaveBeenCalled()
    expect(viaOff).not.toHaveBeenCalled()
  })

  it('once() fires exactly once', () => {
    const bus = new Bus()
    const listener = vi.fn()
    bus.once('ping', listener)
    bus.fire('ping', 1)
    bus.fire('ping', 2)
    expect(listener).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('lets a listener unsubscribe during dispatch without skipping others', () => {
    const bus = new Bus()
    const second = vi.fn()
    const first = vi.fn(() => bus.off('ping', second))
    bus.on('ping', first)
    bus.on('ping', second)

    bus.fire('ping', 1)
    expect(second).toHaveBeenCalledOnce()

    bus.fire('ping', 2)
    expect(second).toHaveBeenCalledOnce()
  })

  it('ignores events nobody listens to', () => {
    expect(() => new Bus().fire('pong', undefined)).not.toThrow()
  })

  it('removeAllListeners() clears every event', () => {
    const bus = new Bus()
    const listener = vi.fn()
    bus.on('ping', listener)
    bus.removeAllListeners()
    bus.fire('ping', 1)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('isInstaxError', () => {
  it('narrows by code', () => {
    const error = new InstaxError('cancelled', 'nope')
    expect(isInstaxError(error)).toBe(true)
    expect(isInstaxError(error, 'cancelled')).toBe(true)
    expect(isInstaxError(error, 'timeout')).toBe(false)
    expect(isInstaxError(new Error('nope'))).toBe(false)
  })
})
