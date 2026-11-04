import { type Adjust, applyAdjust, isNeutral } from './adjust'
import { canvasToBlob } from './image'
import type { Aspect, LookPrefs, ShadowStyle } from './settings'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

type Source = ImageBitmap | HTMLCanvasElement

export const EXPORT_SIDE = 2048

/** Bounding box of the non-transparent pixels, so the garment can be centred and padded precisely. */
export function alphaBox(src: Source): Box {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

export function aspectSize(aspect: Aspect, longSide: number): [number, number] {
  const [a, b] = aspect.split(':').map(Number)
  return a >= b ? [longSide, Math.round((longSide * b) / a)] : [Math.round((longSide * a) / b), longSide]
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const n = parseInt(full, 16) || 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const mixRgb = ([r, g, b]: number[], t: number, k: number) =>
  `rgb(${Math.round(r + (t - r) * k)}, ${Math.round(g + (t - g) * k)}, ${Math.round(b + (t - b) * k)})`

function fillBg(ctx: CanvasRenderingContext2D, W: number, H: number, look: Pick<LookPrefs, 'bg' | 'light'>) {
  ctx.clearRect(0, 0, W, H)
  if (look.bg === 'transparent') return
  ctx.fillStyle = look.bg
  ctx.fillRect(0, 0, W, H)
  if (!look.light) return
  // Studio light: brighter behind the garment, falling off towards the edges like a lit backdrop.
  const rgb = hexRgb(look.bg)
  const g = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.hypot(W, H) * 0.62)
  g.addColorStop(0, mixRgb(rgb, 255, 0.16))
  g.addColorStop(0.5, look.bg)
  g.addColorStop(1, mixRgb(rgb, 0, 0.14))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
}

const SHADOWS: Record<Exclude<ShadowStyle, 'none'>, { alpha: number; blur: number; y: number }> = {
  soft: { alpha: 0.22, blur: 0.035, y: 0.014 }, // lifted off the background
  close: { alpha: 0.32, blur: 0.01, y: 0.004 }, // lying flat on it
  floor: { alpha: 0.16, blur: 0.008, y: 0.002 }, // contact edge, plus the floor shadow below
}

/** Soft elliptical shadow under the garment, as if it stood on the floor. */
function drawFloorShadow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const rx = w * 0.46
  const ry = Math.max(h * 0.045, 4)
  ctx.save()
  ctx.translate(x + w / 2, y + h - ry * 0.35)
  ctx.scale(1, ry / rx)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  g.addColorStop(0, 'rgba(0, 0, 0, 0.30)')
  g.addColorStop(0.6, 'rgba(0, 0, 0, 0.10)')
  g.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Garment mode: trim, centre and pad the cutout inside the chosen aspect ratio. */
export function drawFit(canvas: HTMLCanvasElement, src: Source, box: Box, look: LookPrefs, longSide: number) {
  const [W, H] = aspectSize(look.aspect, longSide)
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  fillBg(ctx, W, H, look)
  const s = Math.min(W, H)
  const pad = s * look.padding
  const scale = Math.min((W - pad * 2) / box.w, (H - pad * 2) / box.h)
  const dw = box.w * scale
  const dh = box.h * scale
  const x = (W - dw) / 2
  const y = (H - dh) / 2
  if (look.shadow === 'floor') drawFloorShadow(ctx, x, y, dw, dh)
  ctx.save()
  if (look.shadow !== 'none') {
    const sh = SHADOWS[look.shadow]
    ctx.shadowColor = `rgba(0, 0, 0, ${sh.alpha})`
    ctx.shadowBlur = s * sh.blur
    ctx.shadowOffsetY = s * sh.y
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, box.x, box.y, box.w, box.h, x, y, dw, dh)
  ctx.restore()
}

/**
 * The garment part of `cut`, at most `maxSide` px, with light/colour adjustments applied. Cropping to
 * the box keeps the pixel work proportional to the garment rather than the photo.
 */
export function prepareSource(cut: Source, box: Box, adjust: Adjust | undefined, maxSide: number): { src: Source; box: Box } {
  const k = Math.min(1, maxSide / Math.max(box.w, box.h))
  if (k === 1 && isNeutral(adjust)) return { src: cut, box }
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(box.w * k))
  c.height = Math.max(1, Math.round(box.h * k))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cut, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height)
  if (adjust && !isNeutral(adjust)) {
    const img = ctx.getImageData(0, 0, c.width, c.height)
    applyAdjust(img.data, adjust)
    ctx.putImageData(img, 0, 0)
  }
  return { src: c, box: { x: 0, y: 0, w: c.width, h: c.height } }
}

/** Model mode: keep the photo's framing, only swap what is behind the person. */
export function drawReplace(canvas: HTMLCanvasElement, cut: ImageBitmap, bg: string, longSide?: number) {
  const scale = longSide ? Math.min(1, longSide / Math.max(cut.width, cut.height)) : 1
  const W = Math.round(cut.width * scale)
  const H = Math.round(cut.height * scale)
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  fillBg(ctx, W, H, { bg, light: false })
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cut, 0, 0, W, H)
}

export const encode = (canvas: HTMLCanvasElement, bg: string) =>
  bg === 'transparent' ? canvasToBlob(canvas, 'image/png') : canvasToBlob(canvas, 'image/jpeg', 0.94)

export async function exportFit(cut: ImageBitmap, box: Box, look: LookPrefs, adjust?: Adjust) {
  const p = prepareSource(cut, box, adjust, Infinity)
  const c = document.createElement('canvas')
  drawFit(c, p.src, p.box, look, EXPORT_SIDE)
  return encode(c, look.bg)
}

export async function exportReplace(cut: ImageBitmap, bg: string) {
  const c = document.createElement('canvas')
  drawReplace(c, cut, bg)
  return encode(c, bg)
}

/** Product photo for the try-on services: the cutout centred on plain white. */
export async function productImage(cut: ImageBitmap, box: Box, adjust?: Adjust, longSide = 1536) {
  const p = prepareSource(cut, box, adjust, longSide)
  const c = document.createElement('canvas')
  drawFit(c, p.src, p.box, { bg: '#ffffff', light: false, aspect: '3:4', padding: 0.06, shadow: 'none' }, longSide)
  return canvasToBlob(c, 'image/jpeg', 0.95)
}

/** Small preview for the photo strip: cutouts cropped to the garment (PNG), photos as JPEG. */
export async function thumbnail(blob: Blob, cutout: boolean, side = 320): Promise<Blob> {
  const bmp = await createImageBitmap(blob)
  try {
    const box = cutout ? alphaBox(bmp) : { x: 0, y: 0, w: bmp.width, h: bmp.height }
    const k = Math.min(1, side / Math.max(box.w, box.h))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(box.w * k))
    c.height = Math.max(1, Math.round(box.h * k))
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height)
    return cutout ? canvasToBlob(c, 'image/png') : canvasToBlob(c, 'image/jpeg', 0.85)
  } finally {
    bmp.close()
  }
}
