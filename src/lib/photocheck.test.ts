import { describe, expect, it } from 'vitest'
import { PHOTO_ISSUE_TEXT, checkPhoto, measurePhoto } from './photocheck'

const FULL = { width: 1536, height: 2048 }

/** A w×h picture from a grey value per pixel. */
function picture(w: number, h: number, grey: (x: number, y: number) => number) {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0, p = 0; y < h; y++)
    for (let x = 0; x < w; x++, p += 4) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = grey(x, y)
      rgba[p + 3] = 255
    }
  return rgba
}

/** Box blur of the grey channel, radius r, edges clamped; several passes come close to a Gaussian. */
function blurred(src: Uint8ClampedArray, w: number, h: number, r: number, passes = 3) {
  let cur = Float64Array.from({ length: w * h }, (_, i) => src[i * 4])
  for (let pass = 0; pass < passes; pass++) {
    const out = new Float64Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0
        let n = 0
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
            s += cur[yy * w + xx]
            n++
          }
        out[y * w + x] = s / n
      }
    cur = out
  }
  return picture(w, h, (x, y) => Math.round(cur[y * w + x]))
}

const W = 192
const H = 256
// Dark stripes on a light page, like a print or text on a garment.
const stripes = picture(W, H, (x, y) => (y > 60 && y < 200 && x > 40 && x < 150 && x % 12 < 4 ? 30 : 235))
const checker = picture(W, H, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? 40 : 220)

describe('checkPhoto', () => {
  it('says nothing about a sharp photo', () => {
    expect(checkPhoto(stripes, W, H, FULL)).toEqual([])
    expect(checkPhoto(checker, W, H, FULL)).toEqual([])
    expect(measurePhoto(stripes, W, H).sharpness).toBeGreaterThan(1)
  })

  it('calls a heavily blurred photo blurry, a slightly soft one not', () => {
    expect(checkPhoto(blurred(checker, W, H, 5), W, H, FULL)).toEqual(['blurry'])
    expect(checkPhoto(blurred(checker, W, H, 4), W, H, FULL)).toEqual(['blurry'])
    expect(checkPhoto(blurred(checker, W, H, 1, 1), W, H, FULL)).toEqual([])
  })

  it('cannot tell without edges: a plain colour, a soft gradient', () => {
    expect(checkPhoto(picture(W, H, () => 180), W, H, FULL)).toEqual([])
    expect(checkPhoto(picture(W, H, (_, y) => 60 + (y * 150) / H), W, H, FULL)).toEqual([])
    expect(measurePhoto(picture(W, H, () => 180), W, H)).toMatchObject({ sharpness: 0, edgeCells: 0, median: 180, p95: 180 })
  })

  it('calls an underexposed photo dark, and then does not judge its sharpness', () => {
    const dim = picture(W, H, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? 10 : 40)
    expect(checkPhoto(dim, W, H, FULL)).toEqual(['dark'])
    expect(checkPhoto(blurred(dim, W, H, 5), W, H, FULL)).toEqual(['dark'])
    expect(checkPhoto(picture(W, H, () => 35), W, H, FULL)).toEqual(['dark'])
  })

  it('does not take a dark garment on a light background, or a light one on a dark backdrop, for a dark photo', () => {
    const inBox = (x: number, y: number) => x > 40 && x < 150 && y > 50 && y < 210
    expect(checkPhoto(picture(W, H, (x, y) => (inBox(x, y) ? 12 : 240)), W, H, FULL)).toEqual([])
    expect(checkPhoto(picture(W, H, (x, y) => (inBox(x, y) ? 240 : 12)), W, H, FULL)).toEqual([])
    // Mostly black cloth with a white garment covering a fifth of the frame.
    expect(checkPhoto(picture(W, H, (x, y) => (x > 60 && x < 130 && y > 60 && y < 200 ? 235 : 15)), W, H, FULL)).toEqual([])
  })

  it('calls a photo under 700 px on its shorter side small, and does not judge its sharpness', () => {
    expect(checkPhoto(stripes, W, H, { width: 500, height: 700 })).toEqual(['small'])
    expect(checkPhoto(blurred(checker, W, H, 5), W, H, { width: 600, height: 2000 })).toEqual(['small'])
    expect(checkPhoto(stripes, W, H, { width: 700, height: 700 })).toEqual([])
    expect(checkPhoto(picture(W, H, () => 20), W, H, { width: 400, height: 400 })).toEqual(['dark', 'small'])
  })

  it('says nothing when there is nothing to read', () => {
    expect(checkPhoto(new Uint8ClampedArray(0), 0, 0, FULL)).toEqual([])
    expect(checkPhoto(stripes, 0, H, FULL)).toEqual([])
    expect(checkPhoto(stripes, W, -1, FULL)).toEqual([])
    expect(checkPhoto(stripes, NaN, H, FULL)).toEqual([])
    expect(checkPhoto(new Uint8ClampedArray(16), W, H, FULL)).toEqual([])
    expect(checkPhoto(picture(1, 1, () => 200), 1, 1, FULL)).toEqual([])
    expect(checkPhoto(picture(5, 3, () => 200), 5, 3, FULL)).toEqual([])
  })

  it('does not change the pixels it reads, and has a text for every issue', () => {
    const copy = stripes.slice()
    checkPhoto(copy, W, H, FULL)
    expect(copy).toEqual(stripes)
    expect(Object.keys(PHOTO_ISSUE_TEXT).sort()).toEqual(['blurry', 'dark', 'small'])
  })
})
