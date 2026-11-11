import { describe, expect, it } from 'vitest'
import { applyAdjust, isNeutral, NO_ADJUST } from './adjust'
import type { Adjust } from './adjust'
import { autoAdjust } from './autofix'
import type { LightInput } from './autofix'

type RGB = [number, number, number]
/** Colour at a position; u and v run 0…1 across the painted area. */
type Paint = (u: number, v: number) => RGB

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

/** Seeded pseudo-random numbers in 0…1 (mulberry32), so every run paints the same pixels. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function flat(c: RGB): Paint {
  return () => c
}

/** `c` lit unevenly: its sRGB values scaled from `lo` on the left to `hi` on the right, like folds and shade. */
function shaded(c: RGB, lo: number, hi: number): Paint {
  return (u) => {
    const k = lo + (hi - lo) * u
    return [c[0] * k, c[1] * k, c[2] * k]
  }
}

interface SceneSpec {
  bg: Paint
  garment: Paint
  w?: number
  h?: number
  box?: [number, number, number, number] // the garment's rectangle: x0, y0, x1, y1
  noise?: number // ± levels of sensor noise on every channel
  seed?: number
}

/** A photo of a rectangular garment on a background, with its cutout (alpha 255 on the garment, 0 around it). */
function scene({ bg, garment, w = 64, h = 64, box = [16, 12, 48, 52], noise = 2, seed = 1 }: SceneSpec): LightInput {
  const rand = rng(seed)
  const photo = new Uint8ClampedArray(w * h * 4)
  const cut = new Uint8ClampedArray(w * h * 4)
  const [x0, y0, x1, y1] = box
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1
      const c = inside ? garment((x - x0) / (x1 - x0 - 1 || 1), (y - y0) / (y1 - y0 - 1 || 1)) : bg(x / (w - 1 || 1), y / (h - 1 || 1))
      for (let k = 0; k < 3; k++) photo[p + k] = c[k] + Math.round((rand() * 2 - 1) * noise)
      photo[p + 3] = 255
      if (inside) cut.set(photo.subarray(p, p + 4), p)
    }
  return { photo, cut, w, h }
}

/** The same scene under other light: every channel multiplied in linear light, as a lamp or a shorter exposure does. */
function relight(s: LightInput, k: RGB): LightInput {
  const scale = (px: Uint8ClampedArray) => {
    const out = px.slice()
    for (let p = 0; p < out.length; p += 4)
      for (let c = 0; c < 3; c++) out[p + c] = Math.round(toSrgb(Math.min(1, toLinear(px[p + c] / 255) * k[c])) * 255)
    return out
  }
  return { ...s, photo: scale(s.photo), cut: scale(s.cut) }
}

/** The scene as it looks with `a` applied to photo and cutout. */
function apply(s: LightInput, a: Adjust): LightInput {
  const photo = s.photo.slice()
  const cut = s.cut.slice()
  applyAdjust(photo, a)
  applyAdjust(cut, a)
  return { ...s, photo, cut }
}

/** The photo kept with its background: nothing is cut away. */
function uncut(s: LightInput): LightInput {
  return { ...s, cut: s.photo.slice() }
}

/** Mean linear R, G, B of the background pixels. */
function bgLinear(s: LightInput): RGB {
  const sum: RGB = [0, 0, 0]
  let n = 0
  for (let p = 0; p < s.photo.length; p += 4) {
    if (s.cut[p + 3]) continue
    n++
    for (let c = 0; c < 3; c++) sum[c] += toLinear(s.photo[p + c] / 255)
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n]
}

/** Mean sRGB level of the photo's colour channels. */
function meanLevel(px: Uint8ClampedArray) {
  let sum = 0
  for (let p = 0; p < px.length; p += 4) sum += px[p] + px[p + 1] + px[p + 2]
  return sum / ((px.length / 4) * 3)
}

/** Share of the garment's pixels with a channel at the top. */
function clippedShare(s: LightInput) {
  let n = 0
  let clipped = 0
  for (let p = 0; p < s.cut.length; p += 4) {
    if (!s.cut[p + 3]) continue
    n++
    if (Math.max(s.cut[p], s.cut[p + 1], s.cut[p + 2]) === 255) clipped++
  }
  return clipped / n
}

const WHITE: RGB = [245, 245, 245]
const denim = shaded([120, 140, 180], 0.45, 1.2) // a mid-tone garment with a wide tonal range
const black = shaded([40, 40, 45], 0.4, 1.1)
const shirt = shaded([240, 240, 238], 0.9, 1.03)

const wellLit = () => scene({ bg: flat(WHITE), garment: denim })
const oneStopUnder = () => relight(wellLit(), [0.5, 0.5, 0.5])
// A strong lamp cast: R/B off by 1.22, twice what the capped correction (±0.5) undoes.
const lampBase = () => scene({ bg: flat([240, 240, 240]), garment: denim, noise: 1 })
const warm = () => relight(lampBase(), [1.1, 1, 0.9])
const cool = () => relight(lampBase(), [0.9, 1, 1.1])
// Casts the capped correction undoes in full: R/B off by 1.1.
const mildWarm = () => relight(lampBase(), [1.05, 1, 0.95])
const mildCool = () => relight(lampBase(), [0.95, 1, 1.05])
const halfStopUnder = () => relight(wellLit(), [0.71, 0.71, 0.71])
const wood = () => scene({ bg: flat([150, 105, 65]), garment: denim, noise: 6 })
const blackOnWhite = () => scene({ bg: flat(WHITE), garment: black })
const whiteOnWhite = () => scene({ bg: flat([248, 248, 248]), garment: shirt })
// A red garment against an underexposed white wall: its red channel is near the top while the photo is dim.
const redOnDimWall = () => scene({ bg: flat([180, 180, 180]), garment: shaded([235, 40, 45], 0.45, 1) })
const burntOut = (share: number) =>
  scene({ bg: flat([255, 255, 255]), garment: (u) => (u < share ? [255, 255, 255] : [228, 226, 222]), noise: 0 })
const flatGarment = (c: RGB, lo = 0.92, hi = 1.05) => scene({ bg: flat(WHITE), garment: shaded(c, lo, hi) })

describe('autoAdjust: photos that are fine', () => {
  it('proposes nothing for a well-lit photo on white', () => {
    expect(autoAdjust(wellLit())).toEqual(NO_ADJUST)
  })

  it('leaves a black garment on a bright white background alone', () => {
    const a = autoAdjust(blackOnWhite())
    expect(a.exposure).toBe(0)
    expect(a.contrast).toBe(0)
    expect(a).toEqual(NO_ADJUST)
  })

  it('leaves a white garment on a white background alone', () => {
    expect(autoAdjust(whiteOnWhite())).toEqual(NO_ADJUST)
  })

  it('proposes nothing for a well-lit photo that keeps its background', () => {
    expect(autoAdjust(uncut(wellLit()))).toEqual(NO_ADJUST)
  })

  it('proposes nothing when the white backdrop is blown out and the garment is not', () => {
    expect(autoAdjust(scene({ bg: flat([255, 255, 255]), garment: denim, noise: 0 }))).toEqual(NO_ADJUST)
  })
})

describe('autoAdjust: white balance', () => {
  it('cools a warm cast on a white background until red and blue meet', () => {
    const s = mildWarm()
    const a = autoAdjust(s)
    expect(a.warmth).toBeLessThan(-0.4)
    expect(a.warmth).toBeGreaterThanOrEqual(-0.5)
    const [r, , b] = bgLinear(apply(s, a))
    expect(Math.abs(r / b - 1)).toBeLessThan(0.03)
  })

  it('warms a cool cast the same way', () => {
    const s = mildCool()
    const a = autoAdjust(s)
    expect(a.warmth).toBeGreaterThan(0.4)
    expect(a.warmth).toBeLessThanOrEqual(0.5)
    const [r, , b] = bgLinear(apply(s, a))
    expect(Math.abs(r / b - 1)).toBeLessThan(0.03)
  })

  // A cream wall looks like a white one under a warm lamp: half the way is the most it goes on its own.
  it('goes no further than half the slider on a strong cast, which may be the wall’s own colour', () => {
    const s = warm()
    const [r0, , b0] = bgLinear(s)
    expect(r0 / b0).toBeGreaterThan(1.2)
    const a = autoAdjust(s)
    expect(a.warmth).toBe(-0.5)
    const [r, , b] = bgLinear(apply(s, a))
    expect(r / b).toBeGreaterThan(1.05)
    expect(r / b).toBeLessThan(1.15)
    expect(autoAdjust(cool()).warmth).toBe(0.5)
    // A white shirt on an ivory wall is moved by a quarter of a stop of red against blue at most.
    expect(Math.abs(autoAdjust(scene({ bg: flat([240, 235, 220]), garment: shirt })).warmth)).toBeLessThanOrEqual(0.5)
  })

  it('scales with the cast', () => {
    const a = autoAdjust(relight(lampBase(), [1.05, 1, 0.95]))
    expect(a.warmth).toBeCloseTo(-Math.log2(1.05 / 0.95) / 0.3, 1)
  })

  it('ignores a cast under about 3 %', () => {
    expect(autoAdjust(relight(lampBase(), [1.008, 1, 0.992])).warmth).toBe(0)
  })

  // R×1.2 with B×0.8 is an R/B ratio of 1.5: past the 1.35 limit, where a lamp can no longer be told from a
  // cream wall, and more than warmth = −1 could undo anyway (that leaves a ratio of 1.22).
  it('reads a background whose red and blue differ by half as a coloured wall', () => {
    const s = relight(scene({ bg: flat([225, 225, 225]), garment: denim }), [1.2, 1, 0.8])
    expect(autoAdjust(s).warmth).toBe(0)
  })

  it('takes a wooden-brown background as a colour, not a cast', () => {
    expect(autoAdjust(wood())).toEqual(NO_ADJUST)
  })

  it('takes pale green and pale pink walls as colours', () => {
    expect(autoAdjust(scene({ bg: flat([200, 225, 200]), garment: denim })).warmth).toBe(0)
    expect(autoAdjust(scene({ bg: flat([235, 215, 220]), garment: denim })).warmth).toBe(0)
  })

  it('does not trust a dark background', () => {
    expect(autoAdjust(scene({ bg: flat([62, 55, 44]), garment: denim })).warmth).toBe(0)
  })

  it('does not trust a background smaller than 5 % of the frame', () => {
    const s = relight(scene({ bg: flat([240, 240, 240]), garment: denim, box: [2, 0, 64, 64], noise: 1 }), [1.1, 1, 0.9])
    expect(autoAdjust(s).warmth).toBe(0)
  })

  it('does not take grey patches in a mostly wooden background for a wall', () => {
    const bg: Paint = (u) => (u < 0.2 ? [215, 205, 185] : [150, 105, 65])
    expect(autoAdjust(scene({ bg, garment: denim })).warmth).toBe(0)
  })

  it('has no reference when nothing is cut away', () => {
    expect(autoAdjust(uncut(warm())).warmth).toBe(0)
  })
})

describe('autoAdjust: exposure', () => {
  it('lifts a photo taken half a stop too dark back up', () => {
    const lit = wellLit()
    const dark = halfStopUnder()
    expect(meanLevel(lit.photo) - meanLevel(dark.photo)).toBeGreaterThan(20)
    const a = autoAdjust(dark)
    expect(Math.abs(a.exposure - 0.5)).toBeLessThanOrEqual(0.15)
    expect(a.warmth).toBe(0)
    expect(a.contrast).toBe(0)
    expect(Math.abs(meanLevel(apply(dark, a).photo) - meanLevel(lit.photo))).toBeLessThan(8)
  })

  // A grey wall in good light looks like a white one in poor light, so the lift is capped.
  it('lifts by 0.7 of a stop at most, and by 0.4 when nothing in the photo is brighter than a mid grey', () => {
    const dark = oneStopUnder()
    expect(autoAdjust(dark).exposure).toBe(0.7)
    const lit = meanLevel(wellLit().photo)
    expect(lit - meanLevel(apply(dark, autoAdjust(dark)).photo)).toBeLessThan((lit - meanLevel(dark.photo)) / 2)
    expect(autoAdjust(relight(wellLit(), [0.25, 0.25, 0.25])).exposure).toBe(0.4)
    // A black dress in front of a grey wall, correctly exposed.
    expect(autoAdjust(scene({ bg: flat([150, 150, 150]), garment: black })).exposure).toBeLessThanOrEqual(0.4)
  })

  // A close-up of dark fabric is not underexposed, and nothing in it says what white is.
  it('leaves the exposure of a photo that keeps its background alone', () => {
    expect(autoAdjust(uncut(oneStopUnder()))).toEqual(NO_ADJUST)
    expect(autoAdjust(uncut(scene({ bg: flat([40, 40, 44]), garment: black })))).toEqual(NO_ADJUST)
  })

  it('stops before the garment clips', () => {
    const s = redOnDimWall()
    const a = autoAdjust(s)
    expect(a.exposure).toBeGreaterThan(0)
    expect(a.exposure).toBeLessThan(0.5) // the wall alone would ask for nearly a stop
    expect(clippedShare(apply(s, a))).toBeLessThanOrEqual(0.01)
  })

  it('does not brighten when no grey background says what white is', () => {
    expect(autoAdjust(wood()).exposure).toBe(0)
    expect(autoAdjust(scene({ bg: flat([30, 30, 32]), garment: denim })).exposure).toBe(0)
  })

  it('judges exposure after the white balance', () => {
    const a = autoAdjust(relight(lampBase(), [0.95 * 0.75, 0.75, 1.05 * 0.75]))
    expect(a.warmth).toBeGreaterThan(0.4)
    expect(a.exposure).toBeCloseTo(Math.log2(0.87 / (toLinear(240 / 255) * 0.75)), 1)
  })

  it('darkens a little when most of the garment is clipped, and only then', () => {
    expect(autoAdjust(burntOut(0.8))).toEqual({ ...NO_ADJUST, exposure: -0.3 })
    const some = autoAdjust(burntOut(0.6)).exposure
    expect(some).toBeLessThan(0)
    expect(some).toBeGreaterThan(-0.3)
    expect(autoAdjust(burntOut(0.3))).toEqual(NO_ADJUST)
    expect(autoAdjust(uncut(burntOut(0.8)))).toEqual(NO_ADJUST) // a white backdrop is not a clipped garment
  })

  it('does not take a vivid red, yellow or pink garment, with one channel at the top, for a clipped one', () => {
    for (const c of [[255, 45, 55], [255, 220, 40], [255, 60, 150]] as RGB[])
      expect(autoAdjust(scene({ bg: flat(WHITE), garment: flat(c), noise: 0 })).exposure).toBe(0)
  })

  it('leaves a black frame alone', () => {
    expect(autoAdjust(uncut(scene({ bg: flat([3, 3, 3]), garment: flat([4, 4, 4]), noise: 1 })))).toEqual(NO_ADJUST)
  })
})

describe('autoAdjust: contrast', () => {
  it('adds a little to a flat mid-tone garment', () => {
    expect(autoAdjust(flatGarment([150, 120, 110]))).toEqual({ ...NO_ADJUST, contrast: 0.25 })
    const mild = autoAdjust(flatGarment([150, 120, 110], 0.8, 1.1)).contrast
    expect(mild).toBeGreaterThan(0.05)
    expect(mild).toBeLessThan(0.25)
  })

  it('leaves plain black and plain white garments flat', () => {
    expect(autoAdjust(flatGarment([38, 38, 42]))).toEqual(NO_ADJUST)
    expect(autoAdjust(flatGarment([236, 236, 234]))).toEqual(NO_ADJUST)
  })

  it('judges the range after exposure: a dim photo of a mid-tone garment is not a dark garment', () => {
    const a = autoAdjust(relight(flatGarment([150, 120, 110]), [0.71, 0.71, 0.71]))
    expect(a.exposure).toBeGreaterThan(0.35)
    expect(a.contrast).toBe(0.25)
  })
})

describe('autoAdjust: idempotence', () => {
  const cases: [string, () => LightInput][] = [
    ['half a stop under', halfStopUnder],
    ['warm cast', mildWarm],
    ['cool cast', mildCool],
    ['cool cast and dim', () => relight(lampBase(), [0.95 * 0.75, 0.75, 1.05 * 0.75])],
    ['garment near clipping', redOnDimWall],
    ['clipped garment', () => burntOut(0.8)],
  ]
  for (const [name, make] of cases)
    it(`proposes almost nothing more once its own proposal is applied: ${name}`, () => {
      const s = make()
      const first = autoAdjust(s)
      expect(isNeutral(first)).toBe(false)
      const again = autoAdjust(apply(s, first))
      for (const v of Object.values(again)) expect(Math.abs(v)).toBeLessThanOrEqual(0.12)
    })

  // Contrast is the exception: +0.25 widens a range by an eighth at most, so a flat garment is still flat.
  it('asks for contrast again on a garment that stays flat, but for nothing else', () => {
    const s = relight(flatGarment([150, 120, 110]), [0.71, 0.71, 0.71])
    const again = autoAdjust(apply(s, autoAdjust(s)))
    expect(again).toEqual({ ...NO_ADJUST, contrast: 0.25 })
  })
})

describe('autoAdjust: edge cases and output', () => {
  const empty = new Uint8ClampedArray(0)

  it('returns zeros for empty or malformed input', () => {
    expect(autoAdjust({ photo: empty, cut: empty, w: 0, h: 0 })).toEqual(NO_ADJUST)
    const s = oneStopUnder()
    expect(autoAdjust({ ...s, w: 128 })).toEqual(NO_ADJUST) // arrays shorter than w×h
    expect(autoAdjust({ ...s, cut: s.cut.subarray(0, 100) })).toEqual(NO_ADJUST)
    for (const w of [NaN, -64, 0.5, Infinity]) expect(autoAdjust({ ...s, w })).toEqual(NO_ADJUST)
  })

  it('returns zeros for a single pixel', () => {
    const grey = Uint8ClampedArray.from([90, 90, 90, 255])
    expect(autoAdjust({ photo: grey, cut: grey, w: 1, h: 1 })).toEqual(NO_ADJUST)
    expect(autoAdjust({ photo: grey, cut: new Uint8ClampedArray(4), w: 1, h: 1 })).toEqual(NO_ADJUST)
  })

  it('returns zeros when the cutout is fully transparent', () => {
    const s = relight(warm(), [0.5, 0.5, 0.5])
    expect(autoAdjust({ ...s, cut: new Uint8ClampedArray(s.cut.length) })).toEqual(NO_ADJUST)
  })

  it('returns a fresh object every time', () => {
    const a = autoAdjust(wellLit())
    expect(a).not.toBe(NO_ADJUST)
    expect(a).not.toBe(autoAdjust(wellLit()))
  })

  it('returns clean slider values and leaves the pixels alone', () => {
    console.log('DBG', JSON.stringify([wellLit(), oneStopUnder(), warm(), cool(), wood(), redOnDimWall(), burntOut(0.6), flatGarment([150, 120, 110], 0.8, 1.1), uncut(oneStopUnder()), relight(lampBase(), [0.54, 0.6, 0.66]), scene({ bg: flat([235, 215, 220]), garment: denim })].map(autoAdjust)))
    const scenes = [
      wellLit(),
      oneStopUnder(),
      warm(),
      cool(),
      wood(),
      blackOnWhite(),
      whiteOnWhite(),
      redOnDimWall(),
      burntOut(0.6),
      flatGarment([150, 120, 110], 0.8, 1.1),
      uncut(oneStopUnder()),
      relight(lampBase(), [1.008, 1, 0.992]),
      relight(lampBase(), [1.03, 0.4, 0.97]),
    ]
    for (const s of scenes) {
      const photo = s.photo.slice()
      const cut = s.cut.slice()
      const a = autoAdjust(s)
      expect(Object.keys(a).sort()).toEqual(['contrast', 'exposure', 'saturation', 'warmth'])
      for (const v of Object.values(a)) {
        expect(Number.isFinite(v)).toBe(true)
        expect(Object.is(v, -0)).toBe(false)
        expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-9) // two decimals
      }
      expect(a.saturation).toBe(0)
      expect(Math.abs(a.warmth)).toBeLessThanOrEqual(1)
      expect(a.exposure).toBeGreaterThanOrEqual(-0.3)
      expect(a.exposure).toBeLessThanOrEqual(1)
      expect(a.contrast).toBeGreaterThanOrEqual(0)
      expect(a.contrast).toBeLessThanOrEqual(0.25)
      expect(s.photo).toEqual(photo)
      expect(s.cut).toEqual(cut)
    }
  })
})
