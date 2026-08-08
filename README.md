# instax-web

Print to a Fujifilm **INSTAX Link** printer from the browser, over Web Bluetooth. No runtime dependencies, no server.

Supports mini, square, and wide film.

```bash
npm install instax-web
```

## Usage

```ts
import { InstaxPrinter, prepareImage } from 'instax-web'

// Must run inside a user gesture — browsers block the device chooser otherwise.
button.addEventListener('click', async () => {
  const printer = await InstaxPrinter.request()
  const status = await printer.getStatus()

  const jpeg = await prepareImage(file, { variant: status.film ?? 'mini' })
  await printer.print(jpeg)

  await printer.disconnect()
})
```

`prepareImage` is the part that makes this work: the printer only accepts a JPEG at the film's exact pixel dimensions and under 60 KB, so quality is bisected until the output fits.

### Progress and abort

```ts
const controller = new AbortController()

printer.on('progress', ({ phase, ratio }) => {
  bar.value = ratio // phase is 'uploading' or 'printing'
})

await printer.print(jpeg, { copies: 2, signal: controller.signal })
```

Aborting mid-upload sends the printer a cancel and rejects with `code: 'aborted'`.

### Errors

Every failure is an `InstaxError` with a `code` you can branch on, so a dismissed chooser doesn't look like a hardware fault:

```ts
import { isInstaxError } from 'instax-web'

try {
  await InstaxPrinter.request()
} catch (error) {
  if (isInstaxError(error, 'cancelled')) return // user closed the picker
  if (isInstaxError(error, 'unsupported')) showBrowserWarning()
  throw error
}
```

Codes: `unsupported`, `cancelled`, `disconnected`, `not-connected`, `timeout`, `invalid-packet`, `printer-error`, `image-too-large`, `aborted`, `not-ready`.

## API

| | |
|---|---|
| `InstaxPrinter.isSupported()` | Web Bluetooth available in this context |
| `InstaxPrinter.request(options?)` | Show the chooser, connect, resolve a printer |
| `printer.getStatus()` | Film size, battery, shots remaining |
| `printer.getIdentity()` | Manufacturer, model id, serial |
| `printer.print(image, options?)` | Upload and print. `{ copies, variant, signal, onProgress }` |
| `printer.upload(image, options?)` / `printer.printLoaded(copies?)` | Same, split in two |
| `printer.setLed(colors, options?)` | Ring LED colour or animation |
| `printer.shutdown()` / `printer.disconnect()` | |
| `printer.on(event, listener)` | `connect`, `disconnect`, `progress`, `status`. Returns an unsubscribe |
| `prepareImage(input, options)` | `{ variant, fit, crop, rotate, background, maxBytes }` → JPEG bytes |

`print` accepts a `Blob`, `Uint8Array`, `ArrayBuffer`, data URL, or base64 string. `prepareImage` accepts a `Blob`/`File`, `ImageBitmap`, `HTMLImageElement`, `HTMLCanvasElement`, or URL.

The protocol layer is exported too — `encodePacket`, `decodePacket`, `Opcode`, `BleTransport` — if you want to drive the printer directly. Pass your own `transport` to run without hardware; `test/fake-printer.ts` is a working example.

## Browser support

Needs [Web Bluetooth](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) and a secure context (HTTPS or `localhost`): Chrome, Edge, and Opera on desktop and Android. **Safari and Firefox do not support it**, on any platform. Check `InstaxPrinter.isSupported()` before offering the feature.

## Notes

- Only one image is held by the printer at a time; `print` uploads then prints.
- There is no "ejection finished" notification in the protocol. `print` waits a fixed 15 s per copy — tune with `ejectDelay`.
- A refused transfer is retried with a slower fragment cadence before failing.
- Unverified on hardware beyond INSTAX mini Link. Reports for square and wide welcome.

## Development

```bash
npm install
npm test          # 89 unit tests against a fake printer, no hardware needed
npm run typecheck
npm run build
npm run example   # demo app at localhost:5174, needs a real printer
```

## Credits

Extracted and rewritten from [linssenste/instax-link-web](https://github.com/linssenste/instax-link-web) (MIT). The protocol itself was reverse-engineered by Jasper van Loenen in [javl/InstaxBLE](https://github.com/javl/InstaxBLE).

Not affiliated with or endorsed by Fujifilm. INSTAX is a trademark of Fujifilm.

## License

MIT — see [LICENSE](LICENSE).
