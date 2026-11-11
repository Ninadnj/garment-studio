// Draws post images and catalogue pages from the layouts in layout.ts: one canvas at a time, released right
// after it is encoded, and one photo decoded at a time (iPhones cap the memory canvases may use).
import { type Box, SHADOWS, alphaBox, drawFloorShadow, fillBg, prepareSource } from './compose'
import { shownCut } from './garments'
import { canvasToBlob, releaseCanvas } from './image'
import type { KitItem } from './kit'
import { type CardLayout, type Facts, type Font, type Measure, type Op, PAGE, type Rect, cellLayout, edgesTouched, pageCells, pageFooter, pageHeader, placeSubject, tones } from './layout'
import type { LookPrefs } from './settings'

// System fonts: SF on Apple devices, Roboto on Android; Georgian falls back to the system's Georgian font.
const FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Georgian", "Noto Sans", sans-serif'
const css = (f: Font) => `${f.weight} ${f.size}px ${FAMILY}`

let scratch: CanvasRenderingContext2D | null = null
/** Text width as the canvas draws it (with the same fonts and fallbacks). */
export const canvasMeasure: Measure = (text, font) => {
  scratch ??= document.createElement('canvas').getContext('2d')
  if (!scratch) return text.length * font.size * 0.6
  scratch.font = css(font)
  return scratch.measureText(text).width
}

// A picture by its size and type, not the Blob object: team sync and other windows re-read records with new Blob
// objects of the same pictures, which is not a reason to draw everything again.
const blobKey = (b?: Blob) => (b ? `${b.size}${b.type}` : '-')

/** Changes whenever what loadSubject draws for this photo changes. */
export const pictureKey = (i: KitItem) =>
  i.kind === 'garment'
    ? `${i.id}:${i.rec.removeBg}:${blobKey(shownCut(i.rec))}:${blobKey(i.rec.photo)}:${JSON.stringify(i.rec.adjust ?? null)}`
    : `${i.id}:${blobKey(i.rec.cutout)}:${blobKey(i.rec.image)}`

export interface Subject {
  src: CanvasImageSource
  box: Box
  cut: boolean // a cutout (transparent around the subject), not a whole photo
  person: boolean // a try-on result
  top: boolean // the cutout reaches the top or bottom edge of its photo
  bottom: boolean
  close(): void
}

/**
 * The picture for a kit photo: a garment's cutout with its light and colour, as the Studio saves it, or a try-on
 * (its cutout when this device made one). Undefined while the garment's background is still being removed,
 * unless `orPhoto`: then the photo itself, framed.
 */
export async function loadSubject(item: KitItem, maxSide = 2048, orPhoto = false): Promise<Subject | undefined> {
  const garment = item.kind === 'garment' ? item.rec : undefined
  let blob = garment ? shownCut(garment) : (item.rec as { cutout?: Blob; image: Blob }).cutout
  let cut = garment ? garment.removeBg : !!blob
  if (!blob && !garment) blob = (item.rec as { image: Blob }).image
  if (!blob && garment && orPhoto) {
    blob = garment.photo
    cut = false
  }
  if (!blob) return undefined
  const bmp = await createImageBitmap(blob)
  const box = cut ? alphaBox(bmp) : { x: 0, y: 0, w: bmp.width, h: bmp.height }
  const edges = cut ? edgesTouched(box, bmp.height) : { top: false, bottom: false }
  const p = prepareSource(bmp, box, garment?.adjust, maxSide)
  if (p.src !== bmp) bmp.close() // a smaller copy was made: the full-size photo can go
  return {
    src: p.src,
    box: p.box,
    cut,
    person: !garment,
    ...edges,
    close() {
      if (p.src === bmp) bmp.close()
      else if (p.src instanceof HTMLCanvasElement) releaseCanvas(p.src)
    },
  }
}

function drawSubject(ctx: CanvasRenderingContext2D, s: Subject, area: Rect, look: LookPrefs, pad: number) {
  const r = placeSubject({ w: s.box.w, h: s.box.h, top: s.top, bottom: s.bottom }, area, pad)
  ctx.save()
  ctx.beginPath()
  ctx.rect(area.x, area.y, area.w, area.h)
  ctx.clip() // shadows never run into the text
  if (s.person) {
    // A shadow around a whole person looks like a sticker: only a floor shadow, under a standing cutout.
    if (s.cut && !s.bottom && look.shadow !== 'none') drawFloorShadow(ctx, r.x, r.y, r.w, r.h)
  } else if (look.shadow !== 'none') {
    if (look.shadow === 'floor') drawFloorShadow(ctx, r.x, r.y, r.w, r.h)
    const side = Math.min(area.w, area.h)
    const sh = SHADOWS[look.shadow]
    ctx.shadowColor = `rgba(0, 0, 0, ${sh.alpha})`
    ctx.shadowBlur = side * sh.blur
    ctx.shadowOffsetY = side * sh.y
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(s.src, s.box.x, s.box.y, s.box.w, s.box.h, r.x, r.y, r.w, r.h)
  ctx.restore()
}

// Pills drawn with arcTo: ctx.roundRect is missing in iOS 15.
function pillPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = h / 2
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawOps(ctx: CanvasRenderingContext2D, ops: Op[], t: ReturnType<typeof tones>) {
  ctx.textBaseline = 'alphabetic'
  for (const op of ops) {
    if (op.kind === 'line') {
      ctx.fillStyle = t.line
      ctx.fillRect(op.x, op.y, op.w, 2)
    } else if (op.kind === 'pill') {
      ctx.fillStyle = op.inverted ? t.ink : t.pill
      pillPath(ctx, op.x, op.y, op.w, op.h)
      ctx.fill()
      ctx.font = css(op.font)
      ctx.textAlign = 'center'
      ctx.fillStyle = op.inverted ? t.bg : t.ink
      ctx.fillText(op.text, op.x + op.w / 2, Math.round(op.y + op.h / 2 + op.font.size * 0.35))
    } else {
      ctx.font = css(op.font)
      ctx.textAlign = op.align
      ctx.fillStyle = op.tone === 'ink' ? t.ink : t.muted
      ctx.fillText(op.text, op.x, op.y)
      if (op.strike) {
        const w = ctx.measureText(op.text).width
        const h = Math.max(2, Math.round(op.font.size * 0.07))
        ctx.fillRect(op.align === 'right' ? op.x - w : op.x, Math.round(op.y - op.font.size * 0.32 - h / 2), w, h)
      }
    }
  }
}

function newCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('This device ran out of memory for images. Close other apps or tabs and try again.')
  return { c, ctx }
}

export interface Rendered {
  blob: Blob // full size, JPEG
  preview: Blob // 360 px wide, for showing in the sheet
}

async function finish(c: HTMLCanvasElement, quality: number): Promise<Rendered> {
  try {
    const blob = await canvasToBlob(c, 'image/jpeg', quality)
    const small = newCanvas(360, Math.round((360 * c.height) / c.width))
    small.ctx.imageSmoothingQuality = 'high'
    small.ctx.drawImage(c, 0, 0, small.c.width, small.c.height)
    try {
      return { blob, preview: await canvasToBlob(small.c, 'image/jpeg', 0.8) }
    } finally {
      releaseCanvas(small.c)
    }
  } finally {
    releaseCanvas(c)
  }
}

/** A post image: the shop background and light, the photo placed with the shop margin and shadow, then the text. */
export async function renderCard(l: CardLayout, s: Subject | undefined, look: LookPrefs): Promise<Rendered> {
  const { c, ctx } = newCanvas(l.width, l.height)
  const t = tones(look.bg)
  fillBg(ctx, l.width, l.height, { bg: t.bg, light: look.light }) // a transparent look becomes white: JPEG has no transparency
  if (s) drawSubject(ctx, s, l.photo, look, Math.round(Math.min(l.photo.w, l.photo.h) * look.padding))
  drawOps(ctx, l.ops, t)
  return finish(c, 0.92)
}

export interface PageSpec {
  items: { facts: Facts; load: () => Promise<Subject | undefined> }[]
  perPage: 4 | 6
  shopName: string
  title: string
  date: string
  contact: string
  page: string // "1/3"
  highlight?: string // the size the catalogue was made for
}

/** A catalogue page, 1080 × 1920. Each product's photo is loaded, drawn and released before the next. */
export async function renderPage(spec: PageSpec, look: LookPrefs, m: Measure): Promise<Rendered> {
  const { c, ctx } = newCanvas(PAGE.width, PAGE.height)
  const t = tones(look.bg)
  ctx.fillStyle = t.bg
  ctx.fillRect(0, 0, PAGE.width, PAGE.height)
  drawOps(ctx, pageHeader(spec, m), t)
  const cells = pageCells(spec.items.length, spec.perPage)
  for (const [i, item] of spec.items.entries()) {
    const { photo, ops } = cellLayout(item.facts, cells[i], spec.perPage, m, spec.highlight)
    ctx.save()
    ctx.translate(photo.x, photo.y)
    fillBg(ctx, photo.w, photo.h, { bg: t.bg, light: look.light })
    ctx.restore()
    const s = await item.load()
    if (s)
      try {
        drawSubject(ctx, s, photo, look, Math.round(photo.w * Math.min(look.padding, 0.12)))
      } finally {
        s.close()
      }
    drawOps(ctx, ops, t)
  }
  drawOps(ctx, pageFooter(spec, m), t)
  return finish(c, 0.9)
}
