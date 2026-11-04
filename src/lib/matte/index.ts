// Final step of every cutout: photo + matte -> clean RGBA PNG (specks removed, edge colours fixed).
// The pixel work runs in a worker so the page stays responsive on phones.
import { canvasToBlob } from '../image'
import { type RefineJob, refineCutout } from './refine'

type Pending = { resolve: (rgba: Uint8ClampedArray) => void; reject: (e: unknown) => void }

let worker: Worker | null | undefined
let seq = 0
const pending = new Map<number, Pending>()

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    worker = new Worker(new URL('./refine.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; rgba?: Uint8ClampedArray; error?: string }>) => {
      const p = pending.get(e.data.id)
      pending.delete(e.data.id)
      if (e.data.rgba) p?.resolve(e.data.rgba)
      else p?.reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      // The worker script failed to load: run on the main thread from now on.
      worker?.terminate()
      worker = null
      for (const p of pending.values()) p.reject(e)
      pending.clear()
    }
  } catch {
    worker = null
  }
  return worker
}

function refineInWorker(job: RefineJob): Promise<Uint8ClampedArray> {
  const w = getWorker()
  if (!w) return Promise.resolve(refineCutout(job))
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    w.postMessage({ id, ...job }, [job.rgba.buffer])
  })
}

/**
 * Combine `photo` with `matte` (any size; only its alpha is used, scaled to the photo) into the
 * cutout PNG. `clean` removes specks and haze; leave it off for hand-edited masks.
 */
export async function composeCutout(photo: ImageBitmap, matte: CanvasImageSource, clean: boolean): Promise<Blob> {
  const W = photo.width
  const H = photo.height
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const m = document.createElement('canvas')
  m.width = W
  m.height = H
  const mctx = m.getContext('2d', { willReadFrequently: true })!
  mctx.imageSmoothingQuality = 'high'
  mctx.drawImage(matte, 0, 0, W, H)
  const alpha = mctx.getImageData(0, 0, W, H).data
  m.width = m.height = 0

  const job = (): RefineJob => {
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(photo, 0, 0)
    const rgba = ctx.getImageData(0, 0, W, H).data
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = alpha[i]
    return { rgba, w: W, h: H, clean }
  }

  let out: Uint8ClampedArray
  try {
    out = await refineInWorker(job())
  } catch (e) {
    console.warn('Cutout worker failed, refining on the main thread', e)
    out = refineCutout(job())
  }
  ctx.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0)
  return canvasToBlob(c, 'image/png')
}
