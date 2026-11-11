// Where the photo, the text and the size pills go on post images and catalogue pages. Pure: text is measured
// through `measure`, so tests run without a canvas. Text stays inside Instagram's safe areas: x 72–1008 on
// posts (the profile grid shows the middle 3:4) and y 250–1580 on stories (the top bar and the reply bar).

export type Weight = 500 | 600 | 700
export interface Font {
  size: number
  weight: Weight
}
export type Measure = (text: string, font: Font) => number
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Op =
  | { kind: 'text'; text: string; x: number; y: number; font: Font; tone: 'ink' | 'muted'; align: 'left' | 'right'; strike?: boolean }
  | { kind: 'pill'; text: string; x: number; y: number; w: number; h: number; font: Font; inverted?: boolean }
  | { kind: 'line'; x: number; y: number; w: number }

/** The facts drawn on an image, already formatted. */
export interface Facts {
  name: string
  price?: string
  oldPrice?: string
  discount?: string
  sizes: string[]
  code?: string
}

export interface CardLayout {
  width: number
  height: number
  photo: Rect
  ops: Op[]
}

export const FEED = { width: 1080, height: 1350 } // Instagram post, 4:5
export const STORY = { width: 1080, height: 1920 } // Instagram story, 9:16
export const SQUARE = { width: 2048, height: 2048 } // Facebook and marketplaces, no text
export const PAGE = { width: 1080, height: 1920 } // catalogue page
export const MIN_TEXT = 30 // px at 1080 wide: still readable after a messenger shrinks the image

const f = (size: number, weight: Weight): Font => ({ size, weight })
const chars = (s: string) => [...s] // whole characters, so nothing is cut in half

function ellipsis(line: string, maxWidth: number, font: Font, measure: Measure) {
  let c = chars(line)
  while (c.length && measure(`${c.join('').trimEnd()}…`, font) > maxWidth) c = c.slice(0, -1)
  return `${c.join('').trimEnd()}…`
}

/**
 * Wraps at spaces into at most `maxLines` lines no wider than `maxWidth`. A word wider than a line is broken;
 * when text is left over, the last line ends in "…". The text itself is never changed (no case changes:
 * upper-casing turns Georgian Mkhedruli into Mtavruli).
 */
export function fitLines(text: string, maxWidth: number, maxLines: number, font: Font, measure: Measure): string[] {
  const fits = (s: string) => measure(s, font) <= maxWidth
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (let i = 0; i < words.length; ) {
    const next = line ? `${line} ${words[i]}` : words[i]
    if (fits(next)) {
      line = next
      i++
      continue
    }
    if (line) {
      lines.push(line)
      line = ''
    } else {
      const c = chars(words[i])
      let cut = c.length - 1
      while (cut > 1 && !fits(c.slice(0, cut).join(''))) cut--
      lines.push(c.slice(0, cut).join(''))
      words[i] = c.slice(cut).join('')
    }
    if (lines.length === maxLines) {
      lines[maxLines - 1] = ellipsis(lines[maxLines - 1], maxWidth, font, measure)
      return lines
    }
  }
  if (line) lines.push(line)
  return lines
}

interface PillStyle {
  h: number
  pad: number
  gap: number
  font: Font
  highlight?: string // drawn inverted, e.g. the size the catalogue was made for
}

/** Size pills in one row from (x, y), at most `maxWidth` wide; the sizes that don't fit become a "+n" pill. */
export function pillRow(sizes: string[], x: number, y: number, maxWidth: number, o: PillStyle, measure: Measure) {
  const width = (t: string) => Math.ceil(measure(t, o.font)) + o.pad * 2
  const ops: Op[] = []
  let cx = x
  for (let i = 0; i < sizes.length; i++) {
    const w = width(sizes[i])
    const rest = sizes.length - i - 1
    const room = x + maxWidth - cx
    if (w + (rest ? o.gap + width(`+${rest}`) : 0) > room) {
      const more = `+${sizes.length - i}`
      if (width(more) <= room) {
        ops.push({ kind: 'pill', text: more, x: cx, y, w: width(more), h: o.h, font: o.font })
        cx += width(more) + o.gap
      }
      break
    }
    ops.push({ kind: 'pill', text: sizes[i], x: cx, y, w, h: o.h, font: o.font, inverted: sizes[i] === o.highlight })
    cx += w + o.gap
  }
  return { ops, end: ops.length ? cx - o.gap : x }
}

const text = (t: string, x: number, y: number, font: Font, tone: 'ink' | 'muted' = 'ink', align: 'left' | 'right' = 'left', strike = false): Op => ({
  kind: 'text',
  text: t,
  x: Math.round(x),
  y: Math.round(y),
  font,
  tone,
  align,
  ...(strike ? { strike } : {}),
})

/**
 * Instagram post, 1080 × 1350. With facts: the photo above, then the name and price, the sizes and the code,
 * and on sale the old price struck through with the discount. Without: the photo on the whole image.
 */
export function feedLayout(facts: Facts | undefined, m: Measure): CardLayout {
  const { width, height } = FEED
  if (!facts) return { width, height, photo: { x: 0, y: 0, w: width, h: height }, ops: [] }
  const L = 72
  const R = 1008
  const ops: Op[] = [{ kind: 'line', x: L, y: 1106, w: R - L }]
  const priceFont = f(76, 700)
  const priceW = facts.price ? m(facts.price, priceFont) : 0
  if (facts.price) ops.push(text(facts.price, R, 1186, priceFont, 'ink', 'right'))
  const nameFont = f(44, 600)
  const [name] = fitLines(facts.name, R - L - (priceW ? priceW + 40 : 0), 1, nameFont, m)
  if (name) ops.push(text(name, L, 1174, nameFont))

  // Under the price, right-aligned: the discount, and before it the old price struck through.
  let edge = R
  if (facts.discount) {
    const font = f(30, 600)
    const w = Math.ceil(m(facts.discount, font)) + 36
    ops.push({ kind: 'pill', text: facts.discount, x: R - w, y: 1209, w, h: 48, font, inverted: true })
    edge = R - w - 14
  }
  const oldFont = f(38, 500)
  if (facts.oldPrice) {
    ops.push(text(facts.oldPrice, edge, 1246, oldFont, 'muted', 'right', true))
    edge -= m(facts.oldPrice, oldFont)
  }

  // Left: the size pills, then the code (pills give way to the code; a long code is shortened).
  const codeFont = f(30, 500)
  const [code = ''] = facts.code ? fitLines(`№ ${facts.code}`, 300, 1, codeFont, m) : []
  const codeW = code ? m(code, codeFont) + 16 : 0
  const room = (edge < R ? edge - 40 : R) - L - codeW
  const pills = pillRow(facts.sizes, L, 1206, room, { h: 54, pad: 20, gap: 10, font: f(30, 600) }, m)
  ops.push(...pills.ops)
  if (code) ops.push(text(code, pills.ops.length ? pills.end + 16 : L, 1244, codeFont, 'muted'))
  return { width, height, photo: { x: 0, y: 0, w: width, h: 1090 }, ops }
}

/** Instagram story, 1080 × 1920: the photo in the middle; the name and sizes on the left, the price and code on the right. */
export function storyLayout(facts: Facts, m: Measure): CardLayout {
  const { width, height } = STORY
  const L = 72
  const R = 1008
  const BOTTOM = 1580
  const ops: Op[] = [{ kind: 'line', x: L, y: 1326, w: R - L }]

  let rightW = 0
  let y = 1426
  const priceFont = f(100, 700)
  if (facts.price) {
    ops.push(text(facts.price, R, y, priceFont, 'ink', 'right'))
    rightW = m(facts.price, priceFont)
  }
  if (facts.oldPrice || facts.discount) {
    y = 1507
    let edge = R
    if (facts.discount) {
      const font = f(34, 600)
      const w = Math.ceil(m(facts.discount, font)) + 40
      ops.push({ kind: 'pill', text: facts.discount, x: R - w, y: y - 42, w, h: 56, font, inverted: true })
      edge = R - w - 14
    }
    if (facts.oldPrice) {
      const font = f(48, 500)
      ops.push(text(facts.oldPrice, edge, y, font, 'muted', 'right', true))
      edge -= m(facts.oldPrice, font)
    }
    rightW = Math.max(rightW, R - edge)
  }
  if (facts.code) {
    const font = f(34, 500)
    const [code] = fitLines(`№ ${facts.code}`, 400, 1, font, m) // a long code doesn't squeeze out the name
    y += facts.oldPrice || facts.discount ? 62 : 73
    ops.push(text(code, R, y, font, 'muted', 'right'))
    rightW = Math.max(rightW, m(code, font))
  }

  const leftW = R - L - (rightW ? rightW + 40 : 0)
  const nameFont = f(54, 600)
  const lines = fitLines(facts.name, leftW, 2, nameFont, m)
  lines.forEach((t, i) => ops.push(text(t, L, 1406 + i * 70, nameFont)))
  const top = lines.length ? 1406 + (lines.length - 1) * 70 + 34 : 1352
  if (top + 64 <= BOTTOM) ops.push(...pillRow(facts.sizes, L, top, leftW, { h: 64, pad: 24, gap: 12, font: f(36, 600) }, m).ops)
  return { width, height, photo: { x: L, y: 250, w: R - L, h: 1060 }, ops }
}

/** Facebook and marketplaces, 2048 × 2048: the photo only (marketplaces show the price in their own fields). */
export const squareLayout = (): CardLayout => ({ ...SQUARE, photo: { x: 0, y: 0, w: SQUARE.width, h: SQUARE.height }, ops: [] })

const CELL = {
  4: { rows: 2, h: 793, gap: 32, tile: 593 },
  6: { rows: 3, h: 520, gap: 29, tile: 344 },
} as const

/** Where each product goes on a catalogue page: two columns, from under the header down. */
export function pageCells(count: number, perPage: 4 | 6): Rect[] {
  const c = CELL[perPage]
  return Array.from({ length: count }, (_, i) => ({ x: i % 2 ? 552 : 48, y: 168 + Math.floor(i / 2) * (c.h + c.gap), w: 480, h: c.h }))
}

/** One product on a catalogue page: the photo tile, then price and code, the name, and the sizes. */
export function cellLayout(facts: Facts, cell: Rect, perPage: 4 | 6, m: Measure, highlight?: string): { photo: Rect; ops: Op[] } {
  const big = perPage === 4
  const photo = { x: cell.x, y: cell.y, w: cell.w, h: CELL[perPage].tile }
  const ops: Op[] = []
  const right = cell.x + cell.w
  let y = photo.y + photo.h + (big ? 60 : 56)

  // The price first; the code (buyers ask by it) gets the rest of the row, shortened when it is long.
  const priceFont = f(big ? 50 : 46, 700)
  const priceW = facts.price ? m(facts.price, priceFont) : 0
  const codeFont = f(big ? 32 : 30, 600)
  const [code = ''] = facts.code ? fitLines(`№ ${facts.code}`, cell.w - (priceW ? priceW + 24 : 0), 1, codeFont, m) : []
  const codeW = code ? m(code, codeFont) : 0
  if (code) ops.push(text(code, right, y, codeFont, 'ink', 'right'))
  const limit = right - (codeW ? codeW + 24 : 0)
  if (facts.price) {
    ops.push(text(facts.price, cell.x, y, priceFont))
    let x = cell.x + priceW + 14
    const oldFont = f(big ? 32 : 30, 500)
    if (facts.oldPrice && x + m(facts.oldPrice, oldFont) <= limit) {
      ops.push(text(facts.oldPrice, x, y, oldFont, 'muted', 'left', true))
      x += m(facts.oldPrice, oldFont) + 12
    }
    const dFont = f(30, 600)
    const dw = facts.discount ? Math.ceil(m(facts.discount, dFont)) + 28 : 0
    if (facts.discount && x + dw <= limit) ops.push({ kind: 'pill', text: facts.discount, x, y: y - 34, w: dw, h: 44, font: dFont, inverted: true })
  }

  y += big ? 48 : 44
  const nameFont = f(big ? 32 : 30, 500)
  const [name] = fitLines(facts.name, cell.w, 1, nameFont, m)
  if (name) ops.push(text(name, cell.x, y, nameFont))

  const top = y + (big ? 22 : 18)
  const h = big ? 50 : 46
  // The size the catalogue was made for comes first, so it is never folded into "+n".
  const sizes = highlight && facts.sizes.includes(highlight) ? [highlight, ...facts.sizes.filter((s) => s !== highlight)] : facts.sizes
  if (top + h <= cell.y + cell.h - 12)
    ops.push(...pillRow(sizes, cell.x, top, cell.w, { h, pad: big ? 18 : 16, gap: 8, font: f(30, 600), highlight }, m).ops)
  return { photo, ops }
}

/** The top of a catalogue page: the shop name and date, then the title. */
export function pageHeader(o: { shopName: string; title: string; date: string }, m: Measure): Op[] {
  const dateFont = f(30, 500)
  const ops: Op[] = [text(o.date, 1032, 92, dateFont, 'muted', 'right')]
  const nameFont = f(46, 700)
  const [name] = fitLines(o.shopName, 984 - m(o.date, dateFont) - 30, 1, nameFont, m)
  if (name) ops.push(text(name, 48, 92, nameFont))
  const [title] = fitLines(o.title, 984, 1, f(34, 500), m)
  if (title) ops.push(text(title, 48, 140, f(34, 500), 'muted'))
  return ops
}

/** The bottom of a catalogue page: the contact line and the page number. */
export function pageFooter(o: { contact: string; page: string }, m: Measure): Op[] {
  const pageFont = f(32, 600)
  const ops: Op[] = [{ kind: 'line', x: 48, y: 1810, w: 984 }, text(o.page, 1032, 1868, pageFont, 'muted', 'right')]
  const [contact] = fitLines(o.contact, 984 - m(o.page, pageFont) - 30, 1, f(32, 500), m)
  if (contact) ops.push(text(contact, 48, 1868, f(32, 500)))
  return ops
}

/** Whether a cutout reaches the top or bottom edge of its photo (a half-body try-on, trousers cut by the camera). */
export function edgesTouched(box: Pick<Rect, 'y' | 'h'>, photoHeight: number) {
  return { top: box.y <= photoHeight * 0.005, bottom: box.y + box.h >= photoHeight * 0.995 }
}

/**
 * Where a photo goes in its area: fitted inside the margin, never enlarged past `maxScale` (a smaller person
 * looks better than a blurred one), centred. A cutout cut off at the bottom (or top) of its photo sits on that
 * edge of the area instead of floating.
 */
export function placeSubject(s: { w: number; h: number; top?: boolean; bottom?: boolean }, area: Rect, pad: number, maxScale = 1.5): Rect {
  const padTop = s.top && !s.bottom ? 0 : pad
  const padBottom = s.bottom ? 0 : pad
  const k = Math.min((area.w - pad * 2) / s.w, (area.h - padTop - padBottom) / s.h, maxScale)
  const w = Math.round(s.w * k)
  const h = Math.round(s.h * k)
  const x = Math.round(area.x + (area.w - w) / 2)
  const y = s.bottom ? area.y + area.h - h : s.top ? area.y : Math.round(area.y + padTop + (area.h - padTop - padBottom - h) / 2)
  return { x, y, w, h }
}

const hex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
function rgbOf(colour: string) {
  const h = colour.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function luminance([r, g, b]: number[]) {
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * Text colours for a background: near-black or near-white ink, whichever contrasts more, and muted ink, pill and
 * line tones mixed from it. Neutral text survives JPEG compression in messengers better than coloured text.
 */
export function tones(bg: string) {
  const base = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(bg) ? bg : '#ffffff'
  const b = rgbOf(base)
  const dark = [29, 27, 25]
  const light = [246, 244, 241]
  const ink = contrast(luminance(b), luminance(dark)) >= contrast(luminance(b), luminance(light)) ? dark : light
  const mix = (k: number) => hex(ink.map((v, i) => v * k + b[i] * (1 - k)))
  return { bg: hex(b), ink: hex(ink), muted: mix(0.7), pill: mix(0.1), line: mix(0.14) }
}
