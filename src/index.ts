export { InstaxPrinter, toIndexedChunks, toBytes, base64ToBytes } from './printer.js'
export type {
  ImageSource,
  InstaxPrinterEvents,
  InstaxPrinterOptions,
  PrintOptions,
  PrintProgress,
  PrinterStatus,
  UploadOptions,
} from './printer.js'

export { prepareImage } from './image.js'
export type { CropRect, ImageInput, PrepareImageOptions } from './image.js'

export { FILM_SPECS, filmSpec, filmVariantForSize } from './film.js'
export type { FilmSpec, FilmVariant } from './film.js'

export { InstaxError, isInstaxError } from './errors.js'
export type { InstaxErrorCode } from './errors.js'

export { Opcode, SupportFunction, opcodeName } from './opcodes.js'

export {
  BleTransport,
  DEFAULT_FRAGMENT_SIZE,
  INSTAX_NAME_PREFIX,
  INSTAX_SERVICES,
} from './transport.js'
export type { BleTransportOptions, Logger, Transport } from './transport.js'

export {
  checksum,
  decodePacket,
  encodePacket,
  looksLikeResponse,
  toHex,
  uint32be,
} from './protocol.js'
export type { ResponsePacket } from './protocol.js'

export {
  describeResponse,
  parseBattery,
  parseDeviceInfo,
  parseFilmCount,
  parseImageSpecs,
} from './parser.js'
export type { BatteryInfo, DeviceIdentity, FilmCountInfo, ImageSpecsInfo } from './parser.js'

export { encodeLedPattern, hexToBgr } from './led.js'
export type { LedPatternOptions } from './led.js'

export { Emitter } from './emitter.js'
export type { Unsubscribe } from './emitter.js'
