// Light and colour corrections for the garment (never the background). All values run from −1 to 1.

export interface Adjust {
  exposure: number // ±1 stop
  contrast: number
  saturation: number
  warmth: number
}

export const NO_ADJUST: Adjust = { exposure: 0, contrast: 0, saturation: 0, warmth: 0 }

export const isNeutral = (a?: Adjust) =>
  !a || (a.exposure === 0 && a.contrast === 0 && a.saturation === 0 && a.warmth === 0)

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)

// Contrast up follows a smoothstep S-curve, so highlights and shadows roll off instead of clipping.
const curve = (x: number, c: number) => (c >= 0 ? x + c * (x * x * (3 - 2 * x) - x) : 0.5 + (x - 0.5) * (1 + c * 0.5))

/** One lookup table per channel for exposure, warmth (both in linear light) and contrast. */
export function buildLuts(a: Adjust): [Uint8Array, Uint8Array, Uint8Array] {
  const gain = 2 ** a.exposure
  const warm = [2 ** (a.warmth * 0.15), 2 ** (a.warmth * 0.02), 2 ** (-a.warmth * 0.15)]
  return [0, 1, 2].map((c) => {
    const lut = new Uint8Array(256)
    for (let v = 0; v < 256; v++) {
      const lin = Math.min(1, toLinear(v / 255) * gain * warm[c])
      lut[v] = Math.round(Math.min(1, Math.max(0, curve(toSrgb(lin), a.contrast))) * 255)
    }
    return lut
  }) as [Uint8Array, Uint8Array, Uint8Array]
}

/** Apply `a` in place to RGBA pixels; fully transparent pixels are skipped. */
export function applyAdjust(px: Uint8ClampedArray, a: Adjust) {
  if (isNeutral(a)) return
  const [lr, lg, lb] = buildLuts(a)
  const sat = 1 + a.saturation * (a.saturation > 0 ? 0.8 : 1)
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue
    const r = lr[px[i]]
    const g = lg[px[i + 1]]
    const b = lb[px[i + 2]]
    if (sat === 1) {
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
    } else {
      const l = 0.299 * r + 0.587 * g + 0.114 * b
      px[i] = l + (r - l) * sat
      px[i + 1] = l + (g - l) * sat
      px[i + 2] = l + (b - l) * sat
    }
  }
}
