import { InstaxPrinter, filmSpec, isInstaxError, prepareImage, type FilmVariant } from '../src/index.js'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const connectButton = el<HTMLButtonElement>('connect')
const printButton = el<HTMLButtonElement>('print')
const cancelButton = el<HTMLButtonElement>('cancel')
const ejectButton = el<HTMLButtonElement>('eject')
const fileInput = el<HTMLInputElement>('file')
const canvas = el<HTMLCanvasElement>('preview')
const progressBar = el<HTMLProgressElement>('progress')
const statusText = el<HTMLSpanElement>('status')
const logOutput = el<HTMLPreElement>('log')

let printer: InstaxPrinter | null = null
let variant: FilmVariant = 'mini'
let jpeg: Uint8Array | null = null
let controller: AbortController | null = null

function log(message: string) {
  logOutput.textContent = `${message}\n${logOutput.textContent}`.split('\n').slice(0, 200).join('\n')
}

if (!InstaxPrinter.isSupported()) {
  connectButton.disabled = true
  statusText.textContent = 'this browser has no Web Bluetooth'
}

connectButton.addEventListener('click', async () => {
  if (printer?.connected) {
    await printer.disconnect()
    return
  }

  connectButton.disabled = true
  try {
    printer = await InstaxPrinter.request({ logger: (direction, message) => log(`${direction} ${message}`) })

    printer.on('progress', ({ phase, ratio }) => {
      progressBar.value = ratio
      statusText.textContent = `${phase} ${Math.round(ratio * 100)}%`
    })
    printer.on('disconnect', () => {
      statusText.textContent = 'disconnected'
      connectButton.textContent = 'Connect printer'
      printButton.disabled = true
      ejectButton.disabled = true
    })

    const status = await printer.getStatus()
    variant = status.film ?? 'mini'
    statusText.textContent = `${variant} · ${status.battery.level}%${status.battery.charging ? ' charging' : ''} · ${status.shotsRemaining} left`
    connectButton.textContent = 'Disconnect'
    ejectButton.disabled = false
    await render()
  } catch (error) {
    if (isInstaxError(error, 'cancelled')) log('chooser dismissed')
    else log(`error: ${String(error)}`)
  } finally {
    connectButton.disabled = false
  }
})

fileInput.addEventListener('change', render)

async function render() {
  const file = fileInput.files?.[0]
  if (!file) return

  const spec = filmSpec(variant)
  jpeg = await prepareImage(file, { variant, fit: 'cover' })
  log(`prepared ${spec.width}x${spec.height} at ${(jpeg.byteLength / 1024).toFixed(1)} KB`)

  // Show exactly what will be sent, decoded back from the JPEG bytes.
  const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }))
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)

  printButton.disabled = !printer?.connected
}

printButton.addEventListener('click', async () => {
  if (!printer || !jpeg) return

  controller = new AbortController()
  printButton.disabled = true
  cancelButton.disabled = false
  try {
    await printer.print(jpeg, { variant, signal: controller.signal })
    log('printed')
  } catch (error) {
    log(isInstaxError(error, 'aborted') ? 'cancelled' : `error: ${String(error)}`)
  } finally {
    printButton.disabled = false
    cancelButton.disabled = true
    progressBar.value = 0
  }
})

cancelButton.addEventListener('click', () => controller?.abort())

ejectButton.addEventListener('click', async () => {
  if (!printer) return
  // Irreversible and it costs a shot when the cover is already out, so make it
  // a deliberate choice rather than a stray click.
  if (!confirm('Eject the film cover?\n\nThis ejects one sheet. If the cover is already out, it wastes a photo.')) {
    return
  }

  ejectButton.disabled = true
  try {
    await printer.ejectFilmCover()
    log('cover ejected')
  } catch (error) {
    log(`error: ${String(error)}`)
  } finally {
    ejectButton.disabled = !printer.connected
  }
})
