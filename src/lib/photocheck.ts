// What the app cannot repair in a photo, noticed when it is added so the seller can take it again.
// Every threshold leans towards silence: a note on a good photo costs more than a missed bad one.

export type PhotoIssue = 'dark' | 'blurry' | 'small'

export const PHOTO_ISSUE_TEXT: Record<PhotoIssue, string> = {
  dark: 'This photo is dark. Daylight near a window gives a cleaner cutout and truer colours.',
  blurry: 'This photo looks blurry.',
  small: 'This photo is small, so it will look soft when enlarged.',
}

const SMALL_SIDE = 700 // px on the shorter side of the photo as added

// Measured on 13 real photos (8 product shots on white, 5 of people; 564×1000 to 2048×2732) scaled to 512 px,
// as they are and darkened in linear light. Median / 95th percentile of luma:
//   as they are  149…255 / 213…255        2 stops darker  77…137 / 113…137        3 stops darker  54…99 / 81…99
// The 95th percentile is what counts: a black garment on white keeps a bright one, and so does a white garment
// on black cloth, while a white sheet 3 stops under has a median of 99 and is dark all the same.
const DARK_P95 = 110

// Sharpness: in 8×8 px cells, the strongest Laplacian response divided by the cell's own contrast (so a faint
// but crisp edge counts like a strong one), over cells that have an edge at all; the 95th percentile of that,
// because most of a product photo is plain background or plain fabric. Same photos, Gaussian blur at full
// size before scaling (radius for a 2048 px long side):
//   sharp  1.68…2.76 (1.38…2.54 with a bilinear scaler)     radius 2  1.11…1.91
//   radius 4  0.49…0.95                                      radius 8  0.22…0.31
// The threshold sits between radius 4 (soft, still usable in a web shop) and radius 8 (blurred).
const CELL = 8
const EDGE_RANGE = 32 // luma range from which a cell has an edge to judge
const MIN_CELLS = 12 // fewer cells with an edge (a blank wall): can't tell
const BLURRY = 0.42

/** Luma of each pixel, 0…255, with integer weights. */
function lumaOf(rgba: Uint8ClampedArray, n: number) {
  const y = new Uint8Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) y[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8
  return y
}

/** The value at the share `q` of the sorted values: the smallest one with at least that share at or below it. */
function percentile(hist: Uint32Array, total: number, q: number) {
  const want = Math.max(1, Math.ceil(q * total))
  let seen = 0
  for (let v = 0; v < hist.length; v++) {
    seen += hist[v]
    if (seen >= want) return v
  }
  return hist.length - 1
}

/** What the checks measure: for the tests, and for whoever calibrates the thresholds again. */
export function measurePhoto(rgba: Uint8ClampedArray, w: number, h: number) {
  const n = w * h
  const y = lumaOf(rgba, n)
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) hist[y[i]]++

  const ratios: number[] = []
  const cw = Math.floor(w / CELL)
  const ch = Math.floor(h / CELL)
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let lo = 255
      let hi = 0
      let lap = 0
      for (let yy = cy * CELL; yy < (cy + 1) * CELL; yy++) {
        for (let xx = cx * CELL, i = yy * w + xx; xx < (cx + 1) * CELL; xx++, i++) {
          const v = y[i]
          if (v < lo) lo = v
          if (v > hi) hi = v
          // The frame's outermost pixels have no four neighbours.
          if (xx === 0 || yy === 0 || xx === w - 1 || yy === h - 1) continue
          const l = Math.abs(4 * v - y[i - 1] - y[i + 1] - y[i - w] - y[i + w])
          if (l > lap) lap = l
        }
      }
      if (hi - lo >= EDGE_RANGE) ratios.push(lap / (hi - lo))
    }
  }
  ratios.sort((a, b) => a - b)
  const sharpness = ratios.length ? ratios[Math.max(0, Math.ceil(0.95 * ratios.length) - 1)] : 0
  return { median: percentile(hist, n, 0.5), p95: percentile(hist, n, 0.95), sharpness, edgeCells: ratios.length }
}

/**
 * 'rgba' is the photo scaled down to at most 512 px a side (w×h); 'full' is the size of the photo as the
 * seller added it.
 */
export function checkPhoto(rgba: Uint8ClampedArray, w: number, h: number, full: { width: number; height: number }): PhotoIssue[] {
  const n = w * h
  if (!(w > 0 && h > 0) || !Number.isInteger(n) || rgba.length < n * 4) return []
  const m = measurePhoto(rgba, w, h)
  const issues: PhotoIssue[] = []
  const small = Math.min(full.width, full.height) < SMALL_SIDE
  const dark = m.p95 < DARK_P95
  if (dark) issues.push('dark')
  // Not judged when dark (noise, and little contrast to measure) or small: a photo that is hardly scaled down
  // looks softer per pixel than the ones the threshold was measured on.
  else if (!small && m.edgeCells >= MIN_CELLS && m.sharpness < BLURRY) issues.push('blurry')
  if (small) issues.push('small')
  return issues
}
