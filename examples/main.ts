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
const infoPanel = el<HTMLElement>('info')
const infoFilm = el<HTMLElement>('info-film')
const infoShots = el<HTMLElement>('info-shots')
const infoBattery = el<HTMLElement>('info-battery')
const infoSize = el<HTMLElement>('info-size')
const infoModel = el<HTMLElement>('info-model')
const infoSerial = el<HTMLElement>('info-serial')

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

    printer.on('status', (status) => {
      infoPanel.hidden = false
      infoFilm.textContent = status.film ?? 'unknown'
      infoShots.textContent = String(status.shotsRemaining)
      infoBattery.textContent = `${status.battery.level}%${status.battery.charging ? ' ⚡' : ''}`
      infoSize.textContent = `${status.image.width}×${status.image.height}`
    })

    printer.on('progress', ({ phase, ratio }) => {
      progressBar.value = ratio
      statusText.textContent = `${phase} ${Math.round(ratio * 100)}%`
    })
    printer.on('disconnect', () => {
      statusText.textContent = 'disconnected'
      infoPanel.hidden = true
      connectButton.textContent = 'Connect printer'
      printButton.disabled = true
      ejectButton.disabled = true
    })

    const status = await printer.getStatus()
    variant = status.film ?? 'mini'
    statusText.textContent = 'ready'
    connectButton.textContent = 'Disconnect'

    // Identity never changes while connected, so read it once.
    const identity = await printer.getIdentity()
    infoModel.textContent = identity.printerTypeId ?? '—'
    infoSerial.textContent = identity.serialNumber ?? '—'
    log(`${identity.company ?? '?'} ${identity.printerTypeId ?? '?'} · ${identity.serialNumber ?? '?'}`)
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
    statusText.textContent = 'ready'
  } catch (error) {
    log(isInstaxError(error, 'aborted') ? 'cancelled' : `error: ${String(error)}`)
  } finally {
    printButton.disabled = false
    cancelButton.disabled = true
    progressBar.value = 0
    await refreshStatus()
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
    await refreshStatus()
  }
})

/** Re-reads the printer so the counter reflects shots just consumed. */
async function refreshStatus() {
  if (!printer?.connected) return
  try {
    await printer.getStatus()
  } catch (error) {
    log(`status refresh failed: ${String(error)}`)
  }
}
