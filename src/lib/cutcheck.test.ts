import { describe, expect, it } from 'vitest'
import { CUT_ISSUE_TEXT, checkCutout } from './cutcheck'

/** Signed distance to a shape's outline in px, positive inside; u and v run from 0 to 1 across the frame. */
type Shape = (u: number, v: number, w: number, h: number) => number

const rect =
  (u0: number, v0: number, u1: number, v1: number): Shape =>
  (u, v, w, h) =>
    Math.min((u - u0) * w, (u1 - u) * w, (v - v0) * h, (v1 - v) * h)
const ellipse =
  (cu: number, cv: number, ru: number, rv: number): Shape =>
  (u, v, w, h) =>
    (1 - Math.hypot((u - cu) / ru, (v - cv) / rv)) * Math.min(ru * w, rv * h)
const union =
  (...shapes: Shape[]): Shape =>
  (u, v, w, h) =>
    Math.max(...shapes.map((s) => s(u, v, w, h)))
const minus =
  (a: Shape, b: Shape): Shape =>
  (u, v, w, h) =>
    Math.min(a(u, v, w, h), -b(u, v, w, h))

/** Pictures are described at 256 px a side; this is the factor to the real size. */
const scaleOf = (w: number, h: number) => Math.max(w, h) / 256

/** Alpha of a shape whose edge ramps from removed to kept over `soft` px (at 256 px a side; 0 = hard). */
function draw(w: number, h: number, shape: Shape, soft = 2, level = 255) {
  const a = new Uint8ClampedArray(w * h)
  const ramp = soft * scaleOf(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = shape((x + 0.5) / w, (y + 0.5) / h, w, h)
      const cover = ramp > 0 ? Math.min(1, Math.max(0, d / ramp + 0.5)) : d >= 0 ? 1 : 0
      a[y * w + x] = cover * level
    }
  return a
}

/** Change the alpha of every non-removed pixel inside `shape`. */
function repaint(a: Uint8ClampedArray, w: number, h: number, shape: Shape, to: (alpha: number) => number) {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (a[i] && shape((x + 0.5) / w, (y + 0.5) / h, w, h) >= 0) a[i] = to(a[i])
    }
  return a
}

/** Box blur with a radius given at 256 px a side; the window shrinks at the frame, as a canvas blur does not. */
function blur(src: Uint8ClampedArray, w: number, h: number, radius: number) {
  const r = Math.max(1, Math.round(radius * scaleOf(w, h)))
  const out = new Uint8ClampedArray(src.length)
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

/** Seeded pseudo-random numbers in [0, 1), so noisy pictures are the same on every run. */
function mulberry32(seed: number) {
  let t = seed
  return () => {
    t = (t + 0x6d2b79f5) | 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const BODY = rect(0.2, 0.2, 0.8, 0.8)
const LOWER_THIRD = rect(0.2, 0.6, 0.8, 0.8)

/** A sleeveless top hanging from two thin straps that close into a loop, so the neck is a real hole. */
const TOP = minus(
  union(
    rect(0.25, 0.3, 0.75, 0.9), // body
    rect(0.3, 0.08, 0.33, 0.32), // straps, under 8 px wide at 256 px a side
    rect(0.67, 0.08, 0.7, 0.32),
    rect(0.3, 0.08, 0.7, 0.11), // loop behind the neck
  ),
  ellipse(0.5, 0.3, 0.12, 0.1), // scooped neckline
)

// The same pictures at every size: the thresholds are shares of the frame and the edge band scales with it.
describe.each([
  [256, 256],
  [256, 180],
  [64, 64],
  [512, 512],
])('checkCutout at %i×%i', (w, h) => {
  describe('good cutouts', () => {
    it('accepts a solid rectangle with a 2 px soft edge', () => {
      expect(checkCutout(draw(w, h, BODY), w, h)).toEqual([])
    })

    it('accepts a solid ellipse with a 2 px soft edge', () => {
      expect(checkCutout(draw(w, h, ellipse(0.5, 0.5, 0.3, 0.4)), w, h)).toEqual([])
    })

    it('accepts the same shapes after a 3 px box blur', () => {
      expect(checkCutout(blur(draw(w, h, BODY), w, h, 3), w, h)).toEqual([])
      expect(checkCutout(blur(draw(w, h, ellipse(0.5, 0.5, 0.3, 0.4)), w, h, 3), w, h)).toEqual([])
    })

    it('accepts a hard edge and a wide feathered edge', () => {
      expect(checkCutout(draw(w, h, BODY, 0), w, h)).toEqual([])
      expect(checkCutout(draw(w, h, BODY, 5), w, h)).toEqual([])
    })

    it('accepts a top with two thin straps and a neck hole', () => {
      expect(checkCutout(draw(w, h, TOP), w, h)).toEqual([])
      expect(checkCutout(draw(w, h, TOP, 0), w, h)).toEqual([])
    })

    it('accepts the top when its straps came out blurred or faint', () => {
      expect(checkCutout(blur(draw(w, h, TOP), w, h, 3), w, h)).toEqual([])
      const faint = repaint(draw(w, h, TOP), w, h, rect(0, 0, 1, 0.28), (v) => Math.min(v, 110))
      expect(checkCutout(faint, w, h)).toEqual([])
    })

    it('accepts lace: many small hard-edged holes', () => {
      const a = draw(w, h, BODY)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x % 6 < 2 && y % 6 < 2) a[y * w + x] = 0
      expect(checkCutout(a, w, h)).toEqual([])
    })

    it('accepts fabric that is solid but not perfectly opaque', () => {
      const rand = mulberry32(7)
      const a = repaint(draw(w, h, BODY), w, h, rect(0.22, 0.22, 0.78, 0.78), () => 225 + rand() * 30)
      expect(checkCutout(a, w, h)).toEqual([])
    })

    it('accepts a garment that fills most of the frame or only a small part of it', () => {
      expect(checkCutout(draw(w, h, rect(0.01, 0.01, 0.99, 0.99)), w, h)).toEqual([]) // 96 % kept
      expect(checkCutout(draw(w, h, rect(0.4, 0.4, 0.6, 0.55)), w, h)).toEqual([]) // 3 % kept
    })
  })

  describe('empty and nothing removed', () => {
    it('reports a fully transparent image as empty', () => {
      expect(checkCutout(new Uint8ClampedArray(w * h), w, h)).toEqual(['empty'])
    })

    it('reports a tiny dot as empty', () => {
      expect(checkCutout(draw(w, h, ellipse(0.5, 0.5, 0.04, 0.04)), w, h)).toEqual(['empty'])
    })

    it('reports only empty when all that is left is haze', () => {
      expect(checkCutout(new Uint8ClampedArray(w * h).fill(100), w, h)).toEqual(['empty'])
      expect(checkCutout(draw(w, h, BODY, 2, 120), w, h)).toEqual(['empty'])
    })

    it('reports a fully opaque image as nothing removed', () => {
      expect(checkCutout(new Uint8ClampedArray(w * h).fill(255), w, h)).toEqual(['nothing_removed'])
    })

    it('reports only nothing removed when a sliver of the frame went and the rest is hazy', () => {
      const a = new Uint8ClampedArray(w * h).fill(150)
      a.fill(0, 0, w) // one row
      expect(checkCutout(a, w, h)).toEqual(['nothing_removed'])
    })
  })

  describe('see-through', () => {
    it('reports a shape whose lower third is at alpha 120', () => {
      const a = repaint(draw(w, h, BODY), w, h, LOWER_THIRD, (v) => Math.min(v, 120))
      expect(checkCutout(a, w, h)).toEqual(['see_through'])
    })

    it('reports haze that is still above the kept threshold', () => {
      const a = repaint(draw(w, h, BODY), w, h, LOWER_THIRD, (v) => Math.min(v, 160))
      expect(checkCutout(a, w, h)).toEqual(['see_through'])
    })

    it('reports uneven haze in the middle of the garment', () => {
      const rand = mulberry32(11)
      const a = repaint(draw(w, h, BODY), w, h, ellipse(0.5, 0.5, 0.2, 0.2), () => 80 + rand() * 100)
      expect(checkCutout(a, w, h)).toEqual(['see_through'])
    })

    it('reports a garment that is half-transparent all over', () => {
      expect(checkCutout(draw(w, h, BODY, 2, 170), w, h)).toEqual(['see_through'])
    })

    it('stays quiet about a small hazy patch', () => {
      const a = repaint(draw(w, h, BODY), w, h, rect(0.45, 0.45, 0.55, 0.55), () => 120) // under 3 % of the shape
      expect(checkCutout(a, w, h)).toEqual([])
    })
  })

  describe('pieces', () => {
    it('reports two equal separate rectangles', () => {
      const a = draw(w, h, union(rect(0.1, 0.2, 0.4, 0.8), rect(0.6, 0.2, 0.9, 0.8)))
      expect(checkCutout(a, w, h)).toEqual(['pieces'])
    })

    it('reports a big shape plus a second one of 20 % of its area', () => {
      const a = draw(w, h, union(rect(0.1, 0.2, 0.6, 0.8), rect(0.7, 0.35, 0.9, 0.65)))
      expect(checkCutout(a, w, h)).toEqual(['pieces'])
    })

    it('stays quiet about a big shape plus a few specks', () => {
      const rand = mulberry32(3)
      const a = draw(w, h, BODY)
      const side = Math.max(1, Math.round(2 * scaleOf(w, h)))
      for (let k = 0; k < 6; k++) {
        const x0 = Math.floor(rand() * 0.1 * w)
        const y0 = Math.floor(rand() * (h - side))
        for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) a[y * w + x] = 255
      }
      expect(checkCutout(a, w, h)).toEqual([])
    })

    it('stays quiet about a small second piece, like a detached belt', () => {
      const a = draw(w, h, union(rect(0.1, 0.2, 0.6, 0.8), rect(0.75, 0.4, 0.85, 0.55))) // 5 % of the big one
      expect(checkCutout(a, w, h)).toEqual([])
    })

    it('counts two parts joined by a faint strap as one piece', () => {
      const a = draw(w, h, union(rect(0.1, 0.2, 0.4, 0.8), rect(0.6, 0.2, 0.9, 0.8)))
      const y = Math.floor(h / 2)
      for (let x = Math.floor(0.38 * w); x < 0.62 * w; x++) a[y * w + x] = Math.max(a[y * w + x], 70)
      expect(checkCutout(a, w, h)).toEqual([])
    })

    it('puts see-through before pieces', () => {
      const a = draw(w, h, union(rect(0.1, 0.2, 0.4, 0.8), rect(0.6, 0.2, 0.9, 0.8)))
      repaint(a, w, h, rect(0.55, 0, 1, 1), (v) => Math.min(v, 160))
      expect(checkCutout(a, w, h)).toEqual(['see_through', 'pieces'])
    })
  })
})

describe('checkCutout edge cases', () => {
  it('has nothing to say without pixels', () => {
    expect(checkCutout(new Uint8ClampedArray(0), 0, 0)).toEqual([])
    expect(checkCutout(new Uint8ClampedArray(16), 0, 4)).toEqual([])
    expect(checkCutout(new Uint8ClampedArray(16), 4, 0)).toEqual([])
    expect(checkCutout(new Uint8ClampedArray(16), -4, -4)).toEqual([])
    expect(checkCutout(new Uint8ClampedArray(16), NaN, 4)).toEqual([])
  })

  it('has nothing to say when the array is shorter than w×h', () => {
    expect(checkCutout(new Uint8ClampedArray(15).fill(255), 4, 4)).toEqual([])
  })

  it('reads only the first w×h bytes of a longer array', () => {
    const a = new Uint8ClampedArray(32).fill(255)
    a.fill(0, 0, 16)
    expect(checkCutout(a, 4, 4)).toEqual(['empty'])
  })

  it('handles a single pixel', () => {
    expect(checkCutout(Uint8ClampedArray.of(0), 1, 1)).toEqual(['empty'])
    expect(checkCutout(Uint8ClampedArray.of(127), 1, 1)).toEqual(['empty'])
    expect(checkCutout(Uint8ClampedArray.of(128), 1, 1)).toEqual(['nothing_removed'])
    expect(checkCutout(Uint8ClampedArray.of(255), 1, 1)).toEqual(['nothing_removed'])
  })

  it('handles one-pixel-wide images', () => {
    const a = new Uint8ClampedArray(100)
    a.fill(255, 20, 40)
    a.fill(255, 60, 80)
    expect(checkCutout(a, 100, 1)).toEqual(['pieces'])
    expect(checkCutout(a, 1, 100)).toEqual(['pieces'])
    a.fill(255, 40, 60)
    expect(checkCutout(a, 100, 1)).toEqual([])
    a.fill(120, 30, 70)
    expect(checkCutout(a, 1, 100)).toEqual(['see_through'])
  })

  it('does not change the alpha it is given', () => {
    const a = repaint(draw(64, 64, BODY), 64, 64, LOWER_THIRD, () => 120)
    const before = a.slice()
    checkCutout(a, 64, 64)
    expect(a).toEqual(before)
  })
})

describe('CUT_ISSUE_TEXT', () => {
  it('has the agreed wording for every issue', () => {
    expect(CUT_ISSUE_TEXT).toEqual({
      empty: 'Almost nothing was kept from this photo.',
      nothing_removed: 'The background was not removed.',
      see_through: 'Parts of the garment look see-through.',
      pieces: 'The cutout is in several separate pieces.',
    })
  })
})
