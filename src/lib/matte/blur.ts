/**
 * Mean over a (2r+1)×(2r+1) window of a w×h single-channel image, with the window shrunk at the
 * borders. Two running-sum passes, so the cost doesn't depend on r. Both passes walk rows, which
 * keeps memory access sequential on large images.
 */
export function boxBlur(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
  out = new Float32Array(src.length),
  tmp = new Float32Array(src.length),
): Float32Array {
  // Horizontal pass: src -> tmp.
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    let lo = 0
    let hi = Math.min(r, w - 1)
    for (let i = 0; i <= hi; i++) sum += src[row + i]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (hi - lo + 1)
      if (x + r + 1 < w) sum += src[row + x + r + 1], hi++
      if (x - r >= 0) sum -= src[row + x - r], lo++
    }
  }

  // Vertical pass: tmp -> out, one row at a time with a running sum per column.
  const col = new Float64Array(w)
  let lo = 0
  let hi = Math.min(r, h - 1)
  for (let y = 0; y <= hi; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) col[x] += tmp[row + x]
  }
  for (let y = 0; y < h; y++) {
    const n = hi - lo + 1
    const row = y * w
    for (let x = 0; x < w; x++) out[row + x] = col[x] / n
    if (y + r + 1 < h) {
      const add = (y + r + 1) * w
      for (let x = 0; x < w; x++) col[x] += tmp[add + x]
      hi++
    }
    if (y - r >= 0) {
      const sub = (y - r) * w
      for (let x = 0; x < w; x++) col[x] -= tmp[sub + x]
      lo++
    }
  }
  return out
}
