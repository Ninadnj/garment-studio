import type { Config } from '@imgly/background-removal'
import type { Remover } from './settings'
import { SpaceError, onlineCutout } from './hf'
import { downscale } from './image'
import { composeCutout } from './matte'

export type CutoutProgress = { stage: 'download'; ratio: number } | { stage: 'compute' } | { stage: 'refine' }

// Both removers run fully in the browser. IMG.LY's model files come from its CDN once, then from the
// service-worker cache; BRIA's from Hugging Face into Cache Storage (see rmbg.ts). A third, BiRefNet, runs
// online and only when the seller asks for it (cleanOnlineCutout).
let gpuBroken = false
// One job at a time: the model is large and parallel runs exhaust phone memory.
let queue: Promise<unknown> = Promise.resolve()

export function cutout(input: Blob, remover: Remover, onProgress?: (p: CutoutProgress) => void): Promise<Blob> {
  // IMG.LY still reports progress after its result is there: a caller that cleared its status on the result
  // would show "Removing background" again, for good.
  let running = true
  const job = queue
    .then(() => runCutout(input, remover, (p) => running && onProgress?.(p)))
    .finally(() => {
      running = false
    })
  queue = job.catch(() => {})
  return job
}

/** Clean cutout PNG of `input` (≤ 2048 px): matte from the remover, then specks and edge colours fixed. */
async function runCutout(input: Blob, remover: Remover, onProgress?: (p: CutoutProgress) => void): Promise<Blob> {
  // 2048px is plenty for a 2048px export and keeps phone memory in check.
  const src = await downscale(input, 2048)
  const photo = await createImageBitmap(src)
  try {
    let matte: CanvasImageSource
    if (remover === 'isnet_fp16' || remover === 'isnet_quint8') {
      matte = await createImageBitmap(await imglyCutout(src, remover, onProgress))
    } else {
      // BRIA, also for a photo from a teammate whose version names a remover this one doesn't have.
      // Loaded on first use: onnxruntime-web is ~400 KB of JS the app doesn't need at startup.
      const { rmbgMatte } = await import('./rmbg')
      matte = await rmbgMatte(photo, onProgress)
    }
    onProgress?.({ stage: 'refine' })
    try {
      return await composeCutout(photo, matte, true)
    } finally {
      if (matte instanceof ImageBitmap) matte.close()
    }
  } finally {
    photo.close()
  }
}

async function imglyCutout(src: Blob, remover: Exclude<Remover, 'rmbg14'>, onProgress?: (p: CutoutProgress) => void) {
  // Loaded on first use, like BRIA's runtime: most photos never need it.
  const { removeBackground } = await import('@imgly/background-removal')
  const sizes = new Map<string, [number, number]>()
  const config: Config = {
    model: remover,
    output: { format: 'image/png' },
    progress: (key, current, total) => {
      if (key.startsWith('fetch:')) {
        sizes.set(key, [current, total])
        let cur = 0
        let tot = 0
        for (const [c, t] of sizes.values()) {
          cur += c
          tot += t
        }
        onProgress?.({ stage: 'download', ratio: tot ? cur / tot : 0 })
      } else {
        onProgress?.({ stage: 'compute' })
      }
    },
  }

  const tryGpu = 'gpu' in navigator && !gpuBroken
  try {
    return await removeBackground(src, { ...config, device: tryGpu ? 'gpu' : 'cpu' })
  } catch (err) {
    if (!tryGpu) throw err
    gpuBroken = true
    return removeBackground(src, { ...config, device: 'cpu' })
  }
}

/**
 * The cutout of `photo` by the online remover (the photo is sent to Hugging Face), finished like the others:
 * specks removed and edge colours fixed.
 */
export async function cleanOnlineCutout(photo: Blob, opts: { token?: string; signal?: AbortSignal }): Promise<Blob> {
  // Sent re-encoded: a small JPEG is stored as the file came, with where and when it was taken.
  const cut = await onlineCutout(await downscale(photo, 2048, 'image/jpeg', true), opts)
  const job = queue.then(async () => {
    const bmp = await createImageBitmap(photo)
    try {
      const matte = await createImageBitmap(cut).catch(() => {
        throw new SpaceError('The online remover could not cut out this photo. Try again.')
      })
      try {
        return await composeCutout(bmp, matte, true)
      } finally {
        matte.close()
      }
    } finally {
      bmp.close()
    }
  })
  queue = job.catch(() => {})
  return job
}
