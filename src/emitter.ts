export type Unsubscribe = () => void

type Listener = (payload: never) => void

/**
 * Minimal typed event emitter.
 *
 * `EventTarget` would need every payload wrapped in a `CustomEvent` and casts
 * at each call site; this keeps listener payloads statically typed.
 */
export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener>>()

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener as Listener)
    return () => this.off(event, listener)
  }

  once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(event, (payload) => {
      off()
      listener(payload)
    })
    return off
  }

  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): void {
    this.#listeners.get(event)?.delete(listener as Listener)
  }

  removeAllListeners(): void {
    this.#listeners.clear()
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event)
    if (!set) return
    // Copy first: a listener may unsubscribe itself or others while running.
    for (const listener of [...set]) {
      ;(listener as (payload: Events[K]) => void)(payload)
    }
  }
}
