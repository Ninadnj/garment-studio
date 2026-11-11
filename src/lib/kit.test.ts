import { describe, expect, it } from 'vitest'
import {
  catalogueFileName,
  catalogueMessage,
  catalogueProducts,
  dateText,
  paginate,
  repeatedCodes,
  skippedText,
} from './catalogue'
import type { GarmentRec, LookRec, ProductRec } from './db'
import { displayName, imageFacts, kitFileName, kitPhotos, postedPatch, storyPhoto, tilePhoto, unpostedPatch } from './kit'
import {
  FEED,
  type Font,
  MIN_TEXT,
  type Op,
  STORY,
  cellLayout,
  edgesTouched,
  feedLayout,
  fitLines,
  pageCells,
  pageFooter,
  pageHeader,
  pillRow,
  placeSubject,
  storyLayout,
  tones,
} from './layout'
import { jpegPdf } from './pdf'
import { discountText, formatPrice, newProduct } from './products'

// Text width without a canvas: half the font size per character.
const measure = (t: string, f: Font) => [...t].length * f.size * 0.5
const product = (patch: Partial<ProductRec> = {}) => newProduct({ name: 'Linen shirt', status: 'for_sale', ...patch }, [], 1000)
const garment = (id: string, productId: string, createdAt: number): GarmentRec =>
  ({ id, productId, createdAt, photo: new Blob(), removeBg: true, remover: 'rmbg14' }) as GarmentRec
const tryOn = (id: string, productId: string, createdAt: number): LookRec => ({ id, productId, createdAt, image: new Blob() })

describe('prices on images and in copied details', () => {
  it('writes prices the Georgian way, the same on every phone', () => {
    expect(formatPrice(45, 'GEL')).toBe('45 ₾')
    expect(formatPrice(1200, 'GEL')).toBe('1200 ₾')
    expect(formatPrice(12500, 'GEL')).toBe('12 500 ₾')
    expect(formatPrice(12.5, 'GEL')).toBe('12,50 ₾')
    expect(formatPrice(99.9, 'EUR')).toBe('99,90 €')
    expect(formatPrice(45, 'USD')).toBe('45 $')
    expect(formatPrice(undefined, 'GEL')).toBe('')
  })

  it('shows a discount only for a real reduction', () => {
    expect(discountText(120, 89)).toBe('−26%')
    expect(discountText(100, 100)).toBeUndefined()
    expect(discountText(100, 120)).toBeUndefined()
    expect(discountText(undefined, 50)).toBeUndefined()
    expect(discountText(1000, 999)).toBeUndefined() // rounds to 0 %
  })

  it('puts the facts on images: price, old price and discount, sizes as buyers read them, code', () => {
    const p = product({
      price: 120,
      salePrice: 89,
      code: '0012',
      sizeSystem: 'eu',
      sizes: [
        { size: '38', stock: 1 },
        { size: '40', stock: 0 },
        { size: '42', stock: 2 },
      ],
    })
    expect(imageFacts(p, 'GEL')).toEqual({
      name: 'Linen shirt',
      price: '89 ₾',
      oldPrice: '120 ₾',
      discount: '−26%',
      sizes: ['38 EU', '42 EU'],
      code: '0012',
    })
    expect(imageFacts({ ...p, status: 'sold' }, 'GEL').sizes).toEqual([])
    expect(imageFacts({ ...p, code: ' ' }, 'GEL').code).toBeUndefined()
  })

  it('adds the brand to the name once, and never invents a name', () => {
    expect(displayName({ name: 'Linen shirt', brand: 'COS' })).toBe('COS · Linen shirt')
    expect(displayName({ name: 'COS linen shirt', brand: 'cos' })).toBe('COS linen shirt')
    expect(displayName({ name: '', brand: '' })).toBe('')
    expect(displayName({ name: 'ლინენის პერანგი', brand: '' })).toBe('ლინენის პერანგი')
  })
})

describe('post kit photos', () => {
  const p = product({ id: 'p1', coverId: 'g1' } as Partial<ProductRec>)
  const garments = [garment('g1', 'p1', 1), garment('g2', 'p1', 3), garment('g3', 'p1', 2), garment('x', 'other', 9)]
  const looks = [tryOn('l1', 'p1', 5), tryOn('l2', 'p1', 8), tryOn('lx', 'other', 9)]

  it('starts with the cover, then try-ons, then the other photos, newest first', () => {
    expect(kitPhotos(p, garments, looks).map((i) => i.id)).toEqual(['g1', 'l2', 'l1', 'g2', 'g3'])
    expect(kitPhotos({ ...p, coverId: undefined }, garments, looks)[0].id).toBe('g2') // the newest photo when no cover is set
  })

  it('picks the story photo: the chosen one, else the first try-on, else the first photo', () => {
    const items = kitPhotos(p, garments, looks)
    expect(storyPhoto(items, 'g3')?.id).toBe('g3')
    expect(storyPhoto(items, 'gone')?.id).toBe('l2')
    expect(storyPhoto(items.filter((i) => i.kind === 'garment'))?.id).toBe('g1')
    expect(storyPhoto([])).toBeUndefined()
  })

  it('picks the catalogue photo: the cover, or the newest try-on, else whichever exists', () => {
    expect(tilePhoto(p, garments, looks, false)?.id).toBe('g1')
    expect(tilePhoto(p, garments, looks, true)?.id).toBe('l2')
    expect(tilePhoto(p, garments, [], true)?.id).toBe('g1')
    expect(tilePhoto(p, [], looks, false)?.id).toBe('l2')
    expect(tilePhoto(p, [], [], false)).toBeUndefined()
  })

  it('names files after the code, and records where the product was posted', () => {
    expect(kitFileName('0012', 'instagram', 2)).toBe('0012-instagram-2.jpg')
    expect(kitFileName('კოდი', 'story')).toBe('product-story.jpg')
    const posted = postedPatch({ ...p, postedOn: ['instagram'] }, 'Instagram', 77)
    expect(posted).toEqual({ postedOn: ['instagram'], postedAt: { Instagram: 77 } })
    expect(postedPatch(p, 'Facebook', 5).postedOn).toEqual(['Facebook'])
    expect(unpostedPatch({ ...p, ...posted }, 'INSTAGRAM')).toEqual({ postedOn: [], postedAt: {} })
  })
})

describe('layout', () => {
  const inside = (ops: Op[], x0: number, x1: number, y0: number, y1: number) =>
    ops.every((o) => {
      if (o.kind === 'pill') return o.x >= x0 && o.x + o.w <= x1 && o.y >= y0 && o.y + o.h <= y1
      if (o.kind === 'line') return o.x >= x0 && o.x + o.w <= x1
      const w = measure(o.text, o.font)
      const left = o.align === 'right' ? o.x - w : o.x
      return left >= x0 - 0.5 && left + w <= x1 + 0.5 && o.y - o.font.size >= y0 && o.y <= y1
    })
  const fonts = (ops: Op[]) => ops.flatMap((o) => (o.kind === 'line' ? [] : [o.font.size]))
  const worst = {
    name: 'ძალიან გრძელი ქართული სახელი ლინენის პერანგისთვის, რომელიც ერთ ხაზზე არ ეტევა',
    price: '12 500 ₾',
    oldPrice: '15 000 ₾',
    discount: '−17%',
    sizes: ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
    code: '0012',
  }

  it('wraps text without changing it, and ends cut text with …', () => {
    const f: Font = { size: 40, weight: 500 }
    const lines = fitLines('ლინენის პერანგი თეთრი ფერის ზომა M', 300, 2, f, measure)
    expect(lines.length).toBe(2)
    expect(lines.every((l) => measure(l, f) <= 300)).toBe(true)
    expect(lines[1].endsWith('…')).toBe(true)
    expect(fitLines('Short', 300, 2, f, measure)).toEqual(['Short'])
    expect(fitLines('Supercalifragilistic', 200, 3, f, measure).join('')).toBe('Supercalifragilistic')
    expect(fitLines('', 300, 1, f, measure)).toEqual([])
  })

  it('ends a row of sizes with +n when they do not fit', () => {
    const { ops } = pillRow(['S', 'M', 'L', 'XL', '2XL'], 0, 0, 260, { h: 50, pad: 18, gap: 8, font: { size: 30, weight: 600 } }, measure)
    const texts = ops.map((o) => (o.kind === 'pill' ? o.text : ''))
    expect(texts.at(-1)).toMatch(/^\+\d$/)
    expect(ops.every((o) => o.kind === 'pill' && o.x + o.w <= 260)).toBe(true)
  })

  it('keeps post text inside the grid crop and the photo clear of it, at readable sizes', () => {
    const l = feedLayout(worst, measure)
    expect(l).toMatchObject(FEED)
    expect(inside(l.ops, 72, 1008, l.photo.y + l.photo.h, FEED.height)).toBe(true)
    expect(Math.min(...fonts(l.ops))).toBeGreaterThanOrEqual(MIN_TEXT)
    expect(feedLayout(undefined, measure).ops).toEqual([]) // photos 2… carry no text
  })

  it('keeps story text out of the top bar and the reply bar', () => {
    const l = storyLayout(worst, measure)
    expect(l).toMatchObject(STORY)
    expect(inside(l.ops, 72, 1008, 1310, 1580)).toBe(true)
    expect(Math.min(...fonts(l.ops))).toBeGreaterThanOrEqual(MIN_TEXT)
  })

  it('lays out catalogue pages: cells inside the margins, text inside each cell, a short page from the top', () => {
    for (const perPage of [4, 6] as const) {
      const cells = pageCells(perPage, perPage)
      expect(cells.every((c) => c.x >= 48 && c.x + c.w <= 1032 && c.y >= 168 && c.y + c.h <= 1786)).toBe(true)
      for (const c of cells) {
        const { photo, ops } = cellLayout(worst, c, perPage, measure, 'M')
        expect(inside(ops, c.x, c.x + c.w, photo.y + photo.h, c.y + c.h)).toBe(true)
        expect(ops.some((o) => o.kind === 'pill' && o.text === 'M' && o.inverted)).toBe(true)
      }
    }
    expect(pageCells(1, 4)[0].y).toBe(168) // right under the header
    // The chosen size is never folded into "+n", and a long code is shortened instead of running into the price.
    const shoes = { ...worst, sizes: ['36 EU', '37 EU', '38 EU', '39 EU', '40 EU', '41 EU'], code: 'ZR-2291-BLK-38-EXTRA-LONG' }
    const cell = pageCells(1, 6)[0]
    const { ops } = cellLayout(shoes, cell, 6, measure, '41 EU')
    expect(ops.some((o) => o.kind === 'pill' && o.text === '41 EU' && o.inverted)).toBe(true)
    const price = ops.find((o) => o.kind === 'text' && o.text === shoes.price)!
    const code = ops.find((o) => o.kind === 'text' && o.text.startsWith('№'))!
    if (price.kind !== 'text' || code.kind !== 'text') throw new Error('no price or code')
    expect(code.text.endsWith('…')).toBe(true)
    expect(price.x + measure(price.text, price.font)).toBeLessThan(code.x - measure(code.text, code.font))
    expect(inside(feedLayout(shoes, measure).ops, 72, 1008, 1090, FEED.height)).toBe(true)
    expect(inside(storyLayout(shoes, measure).ops, 72, 1008, 1310, 1580)).toBe(true)
    expect(inside(pageHeader({ shopName: worst.name, title: 'Size M', date: '09.11.2026' }, measure), 48, 1032, 0, 168)).toBe(true)
    expect(inside(pageFooter({ contact: `@shop · ${worst.name}`, page: '1/3' }, measure), 48, 1032, 1786, 1920)).toBe(true)
  })

  it('places photos: centred in the margin, cut-off cutouts on the edge, never blown up past 1.5×', () => {
    const area = { x: 0, y: 0, w: 1000, h: 1000 }
    expect(placeSubject({ w: 500, h: 1000 }, area, 100)).toEqual({ x: 300, y: 100, w: 400, h: 800 })
    expect(placeSubject({ w: 500, h: 600, bottom: true }, area, 100).y + placeSubject({ w: 500, h: 600, bottom: true }, area, 100).h).toBe(1000)
    expect(placeSubject({ w: 500, h: 600, top: true }, area, 100).y).toBe(0)
    expect(placeSubject({ w: 100, h: 100 }, area, 0)).toMatchObject({ w: 150, h: 150 })
    expect(edgesTouched({ y: 10, h: 990 }, 1000)).toEqual({ top: false, bottom: true })
  })

  it('picks ink that reads on the background', () => {
    expect(tones('#ffffff').ink).toBe('#1d1b19')
    expect(tones('#2b2a28').ink).toBe('#f6f4f1')
    expect(tones('#9a9a9a').ink).toBe('#1d1b19')
    expect(tones('transparent').bg).toBe('#ffffff')
  })
})

describe('catalogue', () => {
  const sizes = (...s: string[]) => s.map((size) => ({ size, stock: 1 }))
  const a = product({ id: 'a', code: '0001', sizes: sizes('M') } as Partial<ProductRec>)
  const b = product({ id: 'b', code: '0002', sizes: sizes('L') } as Partial<ProductRec>)
  const c = product({ id: 'c', code: ' 0001 ', status: 'reserved', sizes: sizes('M') } as Partial<ProductRec>)
  const d = product({ id: 'd', code: '0004', status: 'draft' } as Partial<ProductRec>)
  const e = product({ id: 'e', code: '0005', sizes: sizes('M') } as Partial<ProductRec>)
  const f = product({ id: 'f', code: '0006', sizes: [] } as Partial<ProductRec>)

  it('keeps what can be sold now, in order, and says what was left out', () => {
    const hasPhoto = (p: ProductRec) => p.id !== 'e'
    const all = catalogueProducts([a, b, c, d, e, f], hasPhoto)
    expect(all.products.map((p) => p.id)).toEqual(['a', 'b', 'f'])
    expect(skippedText(all.skipped)).toBe('Not included: 1 reserved, 1 draft, 1 without a photo.')
    const m = catalogueProducts([a, b, c, d, e, f], hasPhoto, 'M')
    expect(m.products.map((p) => p.id)).toEqual(['a'])
    expect(skippedText(m.skipped, 'M')).toBe('Not included: 1 reserved, 1 draft, 2 out of stock in M, 1 without a photo.')
  })

  it('pages, repeated codes, dates, file names and the message', () => {
    expect(paginate([], 4)).toEqual([])
    expect(paginate([1, 2, 3, 4, 5], 4)).toEqual([[1, 2, 3, 4], [5]])
    expect(repeatedCodes([a, b, c])).toEqual(['0001'])
    const day = new Date(2026, 10, 9)
    expect(dateText(day)).toBe('09.11.2026')
    expect(catalogueFileName(day, 2)).toBe('catalogue-2026-11-09-2.jpg')
    expect(catalogueFileName(day)).toBe('catalogue-2026-11-09.pdf')
    expect(catalogueMessage(' Size M ', '', 'Order by DM.')).toBe('Size M\nOrder by DM.')
  })
})

describe('PDF', () => {
  it('writes one page per image, with a cross-reference table that points at each object', async () => {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    const pdf = await jpegPdf([
      { jpeg, width: 1080, height: 1920 },
      { jpeg, width: 1080, height: 1920 },
    ])
    const text = new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer()))
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text.match(/\/Type \/Page /g)?.length).toBe(2)
    const xref = text.indexOf('\nxref\n') + 1 // not the "xref" in "startxref"
    expect(Number(text.match(/startxref\n(\d+)/)![1])).toBe(xref)
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
    expect(offsets.length).toBe(8) // catalog, pages, and page + content + image for each page
    offsets.forEach((o, i) => expect(text.startsWith(`${i + 1} 0 obj`, o)).toBe(true))
  })
})
