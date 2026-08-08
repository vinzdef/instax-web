/** Machine-readable discriminator on every {@link InstaxError}. */
export type InstaxErrorCode =
  /** `navigator.bluetooth` is missing — insecure origin, or a browser without Web Bluetooth. */
  | 'unsupported'
  /** The user dismissed the device chooser. Expected, not a failure. */
  | 'cancelled'
  /** The GATT connection dropped or was never established. */
  | 'disconnected'
  /** A command was issued while no printer was connected. */
  | 'not-connected'
  /** The printer did not acknowledge within the configured window. */
  | 'timeout'
  /** A notification did not parse as an INSTAX response packet. */
  | 'invalid-packet'
  /** The printer replied with a non-zero status byte. */
  | 'printer-error'
  /** The image exceeds what the printer accepts for the loaded film. */
  | 'image-too-large'
  /** The caller aborted via an `AbortSignal`. */
  | 'aborted'
  /** The printer is connected but reports it cannot print right now. */
  | 'not-ready'

export class InstaxError extends Error {
  override readonly name = 'InstaxError'
  readonly code: InstaxErrorCode

  constructor(code: InstaxErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/** Narrowing helper so callers can branch without importing the class. */
export function isInstaxError(value: unknown, code?: InstaxErrorCode): value is InstaxError {
  return value instanceof InstaxError && (code === undefined || value.code === code)
}
