export const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

export const loadBitmap = (blob: Blob) => createImageBitmap(blob)

async function looksLikeHeic(blob: Blob) {
  if (/hei[cf]/i.test(blob.type) || /\.hei[cf]$/i.test((blob as File).name ?? '')) return true
  // ISO-BMFF "ftyp" box with a HEIF brand (some pickers report an empty MIME type).
  const head = new TextDecoder().decode(await blob.slice(4, 12).arrayBuffer())
  return /^ftyp(hei[cxms]|hev[cx]|mif1|msf1)/.test(head)
}

/**
 * Make sure the browser can decode the image. Safari reads HEIC natively; Chrome and others
 * don't, so iPhone/Mac HEIC photos are converted to JPEG on the device (converter loads on demand).
 */
export async function normalizeImage(blob: Blob): Promise<Blob> {
  try {
    ;(await createImageBitmap(blob)).close()
    return blob
  } catch (err) {
    if (!(await looksLikeHeic(blob))) throw err
    const { heicTo } = await import('heic-to')
    return heicTo({ blob, type: 'image/jpeg', quality: 0.92 })
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality = 0.92) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
  )
}

/**
 * Downscale so the long side is at most `maxSide`. Returns the original blob if already small, unless
 * `always`: re-encoding also drops the photo's metadata (EXIF: where and when it was taken, the camera).
 */
export async function downscale(blob: Blob, maxSide: number, type = 'image/jpeg', always = false): Promise<Blob> {
  const bmp = await loadBitmap(blob)
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  if (scale === 1 && blob.type === type && !always) {
    bmp.close()
    return blob
  }
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * scale)
  c.height = Math.round(bmp.height * scale)
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
  }
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  try {
    return await canvasToBlob(c, type, 0.92)
  } finally {
    releaseCanvas(c)
  }
}

/**
 * Gives a canvas's memory back at once. iPhones cap the memory all canvases may use; a dropped canvas only
 * counts down when it is collected, and past the cap getContext returns null.
 */
export function releaseCanvas(c: HTMLCanvasElement) {
  c.width = 0
  c.height = 0
}

export function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export const dataURLToBlob = (url: string) => fetch(url).then((r) => r.blob())

/** A phone or tablet: files go to the share sheet rather than a download. */
export const isTouch = () => matchMedia('(pointer: coarse)').matches

const canShare = (files: File[]) => {
  try {
    return !!navigator.canShare?.({ files })
  } catch {
    return false
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp' }

export const toFile = (blob: Blob, baseName: string) =>
  new File([blob], `${baseName}.${EXTENSIONS[blob.type] ?? 'jpg'}`, { type: blob.type })

/** 'needs-tap': the share sheet refused because preparing took too long after the tap; ask for another tap. */
export type SaveResult = 'shared' | 'downloaded' | 'cancelled' | 'needs-tap'

export interface ShareOptions {
  zipName: string // when several files are downloaded
  text?: string // sent along with the files; some apps keep it (WhatsApp), others drop it (Instagram)
  copy?: string // put on the clipboard first, for the apps that drop shared text
  preferShare?: boolean
}

/**
 * Phones: the share sheet ("Save Images" puts the files in Photos). Desktop: a download, zipped when there are
 * several files. Call it straight from the tap, with the files ready: iPhones refuse a share sheet that opens
 * long after the tap ('needs-tap').
 */
export async function shareFiles(files: File[], o: ShareOptions): Promise<SaveResult> {
  // Not awaited: the clipboard write and the share must both happen within the tap.
  if (o.copy) navigator.clipboard?.writeText(o.copy).catch(() => {})
  if ((o.preferShare ?? isTouch()) && canShare(files)) {
    try {
      await navigator.share(o.text ? { files, text: o.text } : { files })
      return 'shared'
    } catch (e) {
      const name = (e as DOMException).name
      if (name === 'AbortError') return 'cancelled'
      if (name === 'NotAllowedError') return 'needs-tap'
    }
  }
  if (files.length === 1) download(files[0], files[0].name)
  else {
    const { zip } = await import('./zip')
    download(await zip(files.map((f) => ({ name: f.name, data: f }))), o.zipName)
  }
  return 'downloaded'
}

export const saveFiles = (files: File[], zipName: string, preferShare = isTouch()) => shareFiles(files, { zipName, preferShare })

export const saveImage = (blob: Blob, baseName: string) => saveFiles([toFile(blob, baseName)], `${baseName}.zip`)

/** Local date and time for file names, e.g. 2026-10-30-14-05-09. */
export function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}
