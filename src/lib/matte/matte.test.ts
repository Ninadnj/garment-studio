import { describe, expect, it } from 'vitest'
import { boxBlur } from './blur'
import { estimateForeground } from './foreground'
import { refineCutout } from './refine'
import { removeSpecks } from './specks'

/** Brute-force reference for the box blur. */
function naiveBlur(src: Float32Array, w: number, h: number, r: number) {
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          s += src[yy * w + xx]
          n++
        }
      out[y * w + x] = s / n
    }
  return out
}

describe('boxBlur', () => {
  it('matches a brute-force mean, including borders and radii larger than the image', () => {
    const w = 23
    const h = 17
    const src = Float32Array.from({ length: w * h }, (_, i) => Math.sin(i * 1.7) + (i % 5))
    for (const r of [0, 1, 3, 30]) {
      const got = boxBlur(src, w, h, r)
      const want = naiveBlur(src, w, h, r)
      for (let i = 0; i < src.length; i++) expect(got[i]).toBeCloseTo(want[i], 4)
    }
  })

  it('works in place', () => {
    const src = Float32Array.from({ length: 64 }, (_, i) => i)
    const want = naiveBlur(src, 8, 8, 2)
    const got = boxBlur(src, 8, 8, 2, src)
    expect(got).toBe(src)
    for (let i = 0; i < 64; i++) expect(got[i]).toBeCloseTo(want[i], 4)
  })
})

/** A dark square garment on a white background, with a soft 4px edge whose pixels mix in the white. */
function scene(w: number, h: number) {
  const rgba = new Uint8ClampedArray(w * h * 4)
  const alpha = new Float32Array(w * h)
  const fg = [30, 40, 60]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.min(x - 80, 240 - x, y - 80, 240 - y) // distance inside the square
      const a = Math.min(1, Math.max(0, (d + 2) / 4))
      const i = y * w + x
      alpha[i] = a
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(fg[c] * a + 255 * (1 - a))
      rgba[i * 4 + 3] = 255
    }
  return { rgba, alpha, fg }
}

describe('estimateForeground', () => {
  it('recovers the garment colour in soft edge pixels instead of the white background mix', () => {
    const w = 320
    const h = 320
    const { rgba, alpha, fg } = scene(w, h)
    const before = rgba.slice()
    estimateForeground(rgba, alpha, w, h)
    let worstBefore = 0
    let worstAfter = 0
    for (let i = 0; i < w * h; i++) {
      if (alpha[i] <= 0.2 || alpha[i] >= 1) continue
      for (let c = 0; c < 3; c++) {
        worstBefore = Math.max(worstBefore, Math.abs(before[i * 4 + c] - fg[c]))
        worstAfter = Math.max(worstAfter, Math.abs(rgba[i * 4 + c] - fg[c]))
      }
    }
    expect(worstBefore).toBeGreaterThan(100) // the white halo
    expect(worstAfter).toBeLessThan(12)
  })

  it('leaves fully opaque pixels exactly as they were', () => {
    const w = 320
    const h = 320
    const { rgba, alpha } = scene(w, h)
    const before = rgba.slice()
    estimateForeground(rgba, alpha, w, h)
    for (let i = 0; i < w * h; i++) if (alpha[i] === 1) expect(rgba[i * 4]).toBe(before[i * 4])
  })
})

describe('removeSpecks', () => {
  function canvas(w: number, h: number) {
    return new Float32Array(w * h)
  }
  function fill(a: Float32Array, w: number, x0: number, y0: number, x1: number, y1: number, v = 1) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = v
  }

  it('drops small specks and far haze but keeps the garment and its soft edge', () => {
    const w = 200
    const h = 200
    const a = canvas(w, h)
    fill(a, w, 40, 40, 160, 160) // garment
    fill(a, w, 160, 40, 165, 160, 0.05) // faint edge right next to it
    fill(a, w, 5, 5, 8, 8) // lint speck
    fill(a, w, 180, 180, 200, 200, 0.05) // haze far away
    expect(removeSpecks(a, w, h)).toBe(1)
    expect(a[100 * w + 100]).toBe(1)
    expect(a[100 * w + 162]).toBeCloseTo(0.05)
    expect(a[6 * w + 6]).toBe(0)
    expect(a[190 * w + 190]).toBe(0)
  })

  it('keeps two similar pieces, like a pair of socks', () => {
    const w = 200
    const h = 100
    const a = canvas(w, h)
    fill(a, w, 10, 10, 90, 90)
    fill(a, w, 110, 10, 185, 90)
    expect(removeSpecks(a, w, h)).toBe(0)
    expect(a[50 * w + 150]).toBe(1)
  })
})

describe('refineCutout', () => {
  it('writes the cleaned alpha back into the pixels', () => {
    const w = 64
    const h = 64
    const rgba = new Uint8ClampedArray(w * h * 4).fill(200)
    for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = 0
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) rgba[(y * w + x) * 4 + 3] = 255
    rgba[(2 * w + 2) * 4 + 3] = 255 // speck
    refineCutout({ rgba, w, h, clean: true })
    expect(rgba[(32 * w + 32) * 4 + 3]).toBe(255)
    expect(rgba[(2 * w + 2) * 4 + 3]).toBe(0)
  })
})
