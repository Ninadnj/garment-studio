// One-tap "Fix light": proposes values for the manual corrections in adjust.ts from the pixels alone.
// Conservative on purpose: a black dress, a white shirt or a red dress is what the seller sells, so
// nothing changes unless the photo itself shows what is wrong.

import { buildLuts } from './adjust'
import type { Adjust } from './adjust'

export interface LightInput {
  photo: Uint8ClampedArray // RGBA of the original photo, w×h (small: ≤ 256 px a side)
  cut: Uint8ClampedArray // RGBA of the cutout at the same size; its alpha says what is garment (255) and background (0).
  // For a photo that keeps its background, every alpha is 255.
  w: number
  h: number
}

const BG_ALPHA = 13 // cut alpha below this (5 %) is background
const GARMENT_ALPHA = 128 // from here on a pixel is garment; the soft edge in between mixes both and is skipped
const MIN_PIXELS = 64 // fewer garment pixels than this say nothing reliable

// White balance: the background is the reference, when it is a lit, nearly grey surface.
const REF_SHARE = 0.05 // share of the frame the reference must cover
const REF_FLOOR = 0.08 // linear luminance below which 8-bit steps are larger than a cast
const REF_CLIP = 254 // a channel at the top has lost its ratio to the others
const GREY_RB = 0.6 // stops between R and B a single pixel may show and still count as nearly grey
const GREY_G = 0.3 // same for green against the R/B midpoint
const CAST_RB = Math.log2(1.35) // a larger R/B ratio is a coloured wall, not a lamp
const CAST_G = 0.15 // stops green may sit off the R/B midpoint: beyond is a green or pink wall
const WARMTH_STOPS = 0.3 // stops of R/B that warmth = 1 moves (2 × 0.15 in buildLuts)
// A cream or ivory wall can't be told from a white one under a warm lamp, so the correction stays moderate:
// it halves the error on the first and leaves the second for the Warmth slider to finish.
const MAX_WARMTH = 0.5
const MIN_WARMTH = 0.1 // a cast under about 3 % is not worth touching

// Exposure, judged on the 99th percentile of the whole photo's linear luminance.
const BRIGHT = 0.78 // from here the photo has its highlights; also keeps a −0.3 correction from bouncing back up
const TARGET = 0.87 // where the bright end of an underexposed photo is lifted to
// A grey wall in good light can't be told from a white one in poor light either: the lift stays under a stop,
// and smaller still when nothing in the photo is brighter than a mid grey (sRGB 180), where a grey wall is the
// likelier of the two.
const MAX_LIFT = 0.7
const DIM_TOP = 0.45
const DIM_LIFT = 0.4
const BLACK = 0.03 // nothing above this: a lens cap, not a photo
const CLIP_ROOM = 0.98 // the garment's 99th-percentile channel stays below this after the gain
const BURNT = 253 // a garment pixel with a channel from here on is clipped
const MAX_DARKEN = 0.3 // clipped detail cannot come back, so darkening stays small
const MIN_EXPOSURE = 0.08

// Contrast, judged on the garment's sRGB luma after exposure.
const FLAT = 0.16 // 5th…95th percentile range below this is a flat-looking garment; full boost at half of it
const MID_LO = 0.25 // a median outside these is a dark or light garment, whose narrow range is by design
const MID_HI = 0.75
const MAX_CONTRAST = 0.25
const MIN_CONTRAST = 0.05

const LIN = new Float64Array(256) // sRGB byte → linear light
const LOG = new Float64Array(256) // sRGB byte → stops; 0 is floored at half a step so differences stay finite
for (let v = 0; v < 256; v++) {
  const s = Math.max(v, 0.5) / 255
  const lin = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  LIN[v] = v ? lin : 0
  LOG[v] = Math.log2(lin)
}

const RATIO_BINS = 2049 // ±1 stop in steps of 1/1024: finer than one step of the warmth slider
const LUMA_BINS = 1024

const none = (): Adjust => ({ exposure: 0, contrast: 0, saturation: 0, warmth: 0 })

// The sliders step by 0.01; adding 0 turns −0 into 0.
const round2 = (v: number) => Math.round(v * 100) / 100 + 0

/** Index of the bin where the running count reaches the share `q` of `total` samples. */
function quantile(hist: Uint32Array, total: number, q: number) {
  const want = Math.max(1, q * total)
  let seen = 0
  for (let k = 0; k < hist.length; k++) {
    seen += hist[k]
    if (seen >= want) return k
  }
  return hist.length - 1
}

/** Corrections that make the garment's light and colour right; all zeros when the photo is fine or it can't tell. */
export function autoAdjust(input: LightInput): Adjust {
  const { photo, cut, w, h } = input
  const n = w * h
  if (!(n >= 1) || !Number.isInteger(n) || photo.length < n * 4 || cut.length < n * 4) return none()

  // Pass 1: who is garment, and what the lit, nearly grey part of the background says about the lamp.
  const rbHist = new Uint32Array(RATIO_BINS)
  const gHist = new Uint32Array(RATIO_BINS)
  let garment = 0
  let burnt = 0
  let lit = 0
  let grey = 0
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = cut[p + 3]
    const r = photo[p]
    const g = photo[p + 1]
    const b = photo[p + 2]
    if (a >= GARMENT_ALPHA) {
      garment++
      if (r >= BURNT && g >= BURNT && b >= BURNT) burnt++ // one channel at the top is a vivid colour, not a burn
      continue
    }
    if (a >= BG_ALPHA || r >= REF_CLIP || g >= REF_CLIP || b >= REF_CLIP) continue
    if (0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b] < REF_FLOOR) continue
    lit++
    const rb = LOG[r] - LOG[b]
    const gm = LOG[g] - (LOG[r] + LOG[b]) / 2
    if (rb > GREY_RB || rb < -GREY_RB || gm > GREY_G || gm < -GREY_G) continue
    grey++
    rbHist[Math.round((rb + 1) * 1024)]++
    gHist[Math.round((gm + 1) * 1024)]++
  }
  if (garment < MIN_PIXELS) return none()

  // The grey pixels must be most of the lit background: grey knots in a wooden floor are no white wall.
  const neutral = grey >= REF_SHARE * n && grey * 2 >= lit
  let warmth = 0
  if (neutral) {
    const rb = quantile(rbHist, grey, 0.5) / 1024 - 1
    const gm = quantile(gHist, grey, 0.5) / 1024 - 1
    // Warmth that makes the reference's R and B equal after applyAdjust.
    if (Math.abs(rb) < CAST_RB && Math.abs(gm) < CAST_G) warmth = round2(Math.max(-MAX_WARMTH, Math.min(MAX_WARMTH, -rb / WARMTH_STOPS)))
    if (Math.abs(warmth) < MIN_WARMTH) warmth = 0
  }

  // Pass 2: the bright end of the whole photo and of the garment, as they look after the white balance.
  const [wr, wg, wb] = buildLuts({ exposure: 0, contrast: 0, saturation: 0, warmth })
  const yHist = new Uint32Array(LUMA_BINS)
  const topHist = new Uint32Array(256) // the garment's largest channel: the first one to clip
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = wr[photo[p]]
    const g = wg[photo[p + 1]]
    const b = wb[photo[p + 2]]
    yHist[Math.round((0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b]) * (LUMA_BINS - 1))]++
    if (cut[p + 3] >= GARMENT_ALPHA) topHist[r > g ? (r > b ? r : b) : g > b ? g : b]++
  }
  const top = quantile(yHist, n, 0.99) / (LUMA_BINS - 1)

  // A photo that keeps its background has no garment to tell from a blown-out backdrop, and no reference
  // either: a close-up of dark fabric is not underexposed, so its exposure is left alone.
  const whole = garment === n
  let exposure = 0
  if (!whole && burnt * 2 > garment) {
    exposure = -MAX_DARKEN * Math.min(1, (burnt / garment - 0.5) * 4)
  } else if (neutral && top >= BLACK && top < BRIGHT) {
    // Without a grey background nothing says the bright end should be white: a grey shirt on a wooden floor
    // is not underexposed. With one, lift it there, but stop before the garment clips.
    const room = CLIP_ROOM / LIN[quantile(topHist, garment, 0.99)]
    exposure = Math.min(top < DIM_TOP ? DIM_LIFT : MAX_LIFT, Math.log2(Math.min(TARGET / top, room)))
  }
  exposure = Math.abs(exposure) < MIN_EXPOSURE ? 0 : round2(exposure)

  // Pass 3: the garment's tonal range once exposure and white balance are in.
  const [er, eg, eb] = buildLuts({ exposure, contrast: 0, saturation: 0, warmth })
  const lumaHist = new Uint32Array(256)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (cut[p + 3] < GARMENT_ALPHA) continue
    lumaHist[Math.round(0.299 * er[photo[p]] + 0.587 * eg[photo[p + 1]] + 0.114 * eb[photo[p + 2]])]++
  }
  const range = (quantile(lumaHist, garment, 0.95) - quantile(lumaHist, garment, 0.05)) / 255
  const mid = quantile(lumaHist, garment, 0.5) / 255
  let contrast = 0
  if (mid > MID_LO && mid < MID_HI && range < FLAT) contrast = round2(MAX_CONTRAST * Math.min(1, (FLAT - range) / (FLAT / 2)))
  if (contrast < MIN_CONTRAST) contrast = 0

  return { exposure, contrast, saturation: 0, warmth }
}
