import { boxBlur } from './blur'

// Box sizes from Photoroom's reference implementation (github.com/Photoroom/fast-foreground-estimation).
const COARSE_BOX = 90
const FINE_RADIUS = 3
const EPS = 1e-5

/**
 * Recolour the soft edge pixels of a cutout with the foreground's own colour, so the old background
 * (a white wall, a bed sheet) doesn't show as a light or dark rim on the new background.
 *
 * Blur-fusion foreground estimation: Forte & Pitié, "Approximate Fast Foreground Colour Estimation",
 * ICIP 2021. A coarse pass estimates smooth foreground/background colours, a fine pass sharpens them.
 * The coarse 90 px box runs at quarter resolution: a box that wide gives the same smooth result.
 *
 * `rgba` holds the photo; its RGB is rewritten where 0 < alpha < 1. Fully opaque pixels keep the
 * photo's colour exactly.
 */
export function estimateForeground(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number) {
  const n = w * h
  let soft = false
  for (let i = 0; i < n; i++) {
    if (alpha[i] > 0 && alpha[i] < 1) {
      soft = true
      break
    }
  }
  if (!soft) return

  // ---- Coarse pass, on a grid f times smaller.
  const f = Math.min(w, h) >= 256 ? 4 : 1
  const lw = Math.ceil(w / f)
  const lh = Math.ceil(h / f)
  const ln = lw * lh
  const la = new Float32Array(ln) // mean alpha
  const lf = [new Float32Array(ln), new Float32Array(ln), new Float32Array(ln)] // mean I·α
  const lb = [new Float32Array(ln), new Float32Array(ln), new Float32Array(ln)] // mean I·(1−α)
  const count = new Float32Array(ln)
  for (let y = 0; y < h; y++) {
    const lrow = ((y / f) | 0) * lw
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const li = lrow + ((x / f) | 0)
      const a = alpha[i]
      la[li] += a
      count[li]++
      for (let c = 0; c < 3; c++) {
        const v = rgba[i * 4 + c] / 255
        lf[c][li] += v * a
        lb[c][li] += v * (1 - a)
      }
    }
  }
  const lt = new Float32Array(ln)
  const R = Math.max(1, Math.round(COARSE_BOX / 2 / f))
  for (let li = 0; li < ln; li++) la[li] /= count[li]
  boxBlur(la, lw, lh, R, la, lt)
  for (let c = 0; c < 3; c++) {
    for (let li = 0; li < ln; li++) {
      lf[c][li] /= count[li]
      lb[c][li] /= count[li]
    }
    boxBlur(lf[c], lw, lh, R, lf[c], lt)
    boxBlur(lb[c], lw, lh, R, lb[c], lt)
    // Blurred foreground and background colour estimates.
    for (let li = 0; li < ln; li++) {
      lf[c][li] /= la[li] + EPS
      lb[c][li] /= 1 - la[li] + EPS
    }
  }

  // Bilinear lookup from the coarse grid (cell centres at (i + 0.5)·f − 0.5).
  const axis = (len: number, llen: number) => {
    const i0 = new Int32Array(len)
    const i1 = new Int32Array(len)
    const t = new Float32Array(len)
    for (let p = 0; p < len; p++) {
      const u = Math.min(Math.max((p + 0.5) / f - 0.5, 0), llen - 1)
      i0[p] = Math.floor(u)
      i1[p] = Math.min(i0[p] + 1, llen - 1)
      t[p] = u - i0[p]
    }
    return { i0, i1, t }
  }
  const ax = axis(w, lw)
  const ay = axis(h, lh)
  const sample = (grid: Float32Array, x: number, y: number) => {
    const r0 = ay.i0[y] * lw
    const r1 = ay.i1[y] * lw
    const tx = ax.t[x]
    const top = grid[r0 + ax.i0[x]] * (1 - tx) + grid[r0 + ax.i1[x]] * tx
    const bot = grid[r1 + ax.i0[x]] * (1 - tx) + grid[r1 + ax.i1[x]] * tx
    return top + (bot - top) * ay.t[y]
  }

  // ---- Fine pass at full resolution, one colour channel at a time to limit memory.
  const tmp = new Float32Array(n)
  const ba = boxBlur(alpha, w, h, FINE_RADIUS, new Float32Array(n), tmp)
  const fa = new Float32Array(n) // F1·α
  const bb = new Float32Array(n) // B1·(1−α)
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const a = alpha[i]
        const bF = sample(lf[c], x, y)
        const bB = sample(lb[c], x, y)
        const v = rgba[i * 4 + c] / 255
        const F1 = Math.min(1, Math.max(0, bF + a * (v - a * bF - (1 - a) * bB)))
        fa[i] = F1 * a
        bb[i] = bB * (1 - a)
      }
    }
    boxBlur(fa, w, h, FINE_RADIUS, fa, tmp)
    boxBlur(bb, w, h, FINE_RADIUS, bb, tmp)
    for (let i = 0; i < n; i++) {
      const a = alpha[i]
      if (a <= 0 || a >= 1) continue
      const bF = fa[i] / (ba[i] + EPS)
      const bB = bb[i] / (1 - ba[i] + EPS)
      const v = rgba[i * 4 + c] / 255
      const F = bF + a * (v - a * bF - (1 - a) * bB)
      rgba[i * 4 + c] = Math.round(Math.min(1, Math.max(0, F)) * 255)
    }
  }
}
