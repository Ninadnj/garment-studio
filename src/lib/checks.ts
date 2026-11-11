// Small copies of a photo and its cutout for the photo check, the cutout check and the light fix. The pixel
// work itself is in photocheck.ts, cutcheck.ts and autofix.ts.
import type { Adjust } from './adjust'
import { autoAdjust } from './autofix'
import { type CutIssue, checkCutout } from './cutcheck'
import { releaseCanvas } from './image'
import { type PhotoIssue, checkPhoto } from './photocheck'

interface Sample {
  rgba: Uint8ClampedArray
  w: number
  h: number
  full: { width: number; height: number }
}

/** `blob` drawn at most `side` px a side, or exactly `size`. */
async function sample(blob: Blob, side: number, size?: { w: number; h: number }): Promise<Sample> {
  const bmp = await createImageBitmap(blob)
  try {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height))
    const w = size?.w ?? Math.max(1, Math.round(bmp.width * k))
    const h = size?.h ?? Math.max(1, Math.round(bmp.height * k))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    const rgba = ctx.getImageData(0, 0, w, h).data
    releaseCanvas(c)
    return { rgba, w, h, full: { width: bmp.width, height: bmp.height } }
  } finally {
    bmp.close()
  }
}

// Asked again for the same picture whenever the seller comes back to it.
const photoResults = new WeakMap<Blob, Promise<PhotoIssue[]>>()
const cutResults = new WeakMap<Blob, Promise<CutIssue[]>>()

function cached<T>(results: WeakMap<Blob, Promise<T>>, blob: Blob, make: () => Promise<T>) {
  let r = results.get(blob)
  if (!r) {
    r = make()
    results.set(blob, r)
    r.catch(() => results.delete(blob)) // could not be read now (memory): asked again next time
  }
  return r
}

/** What the seller could not repair later in `photo`: dark, blurry, small. */
export const photoIssues = (photo: Blob) =>
  cached(photoResults, photo, async () => {
    const s = await sample(photo, 512)
    return checkPhoto(s.rgba, s.w, s.h, s.full)
  })

/** What looks wrong with the cutout `cut`. */
export const cutIssues = (cut: Blob) =>
  cached(cutResults, cut, async () => {
    const s = await sample(cut, 256)
    const alpha = new Uint8ClampedArray(s.w * s.h)
    for (let i = 0; i < alpha.length; i++) alpha[i] = s.rgba[i * 4 + 3]
    return checkCutout(alpha, s.w, s.h)
  })

/** Light and colour corrections for `photo`; `cut` says what is garment (the photo itself when it keeps its background). */
export async function lightFix(photo: Blob, cut: Blob): Promise<Adjust> {
  const p = await sample(photo, 256)
  const c = cut === photo ? p : await sample(cut, 256, p)
  return autoAdjust({ photo: p.rgba, cut: c.rgba, w: p.w, h: p.h })
}

// Notes the seller read and dismissed (a cutout kept although the check had something to say, a photo of a
// dark garment on a dark floor that is not underexposed): not shown again.
const ACCEPTED_KEY = 'gs.cutAccepted'
/** The note about this cutout of this photo; another cutout of it is checked afresh. */
export const cutNoteKey = (id: string, cut: Blob) => `${id}:${cut.size}`
export const photoNoteKey = (id: string) => `${id}:photo`

function accepted(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ACCEPTED_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export const isNoteAccepted = (key: string) => accepted().includes(key)

export function acceptNote(key: string) {
  try {
    // The last 300 are plenty: older photos have long been posted.
    localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...accepted().filter((k) => k !== key), key].slice(-300)))
  } catch {
    // Storage unavailable: the note comes back next time.
  }
}
