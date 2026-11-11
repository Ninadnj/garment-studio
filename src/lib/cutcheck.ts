// Sanity check of a finished cutout, so the seller is told when the remover probably got it wrong.
// Every threshold leans towards silence: a warning on a good cutout costs more than a missed bad one.

export type CutIssue = 'empty' | 'nothing_removed' | 'see_through' | 'pieces'

export const CUT_ISSUE_TEXT: Record<CutIssue, string> = {
  empty: 'Almost nothing was kept from this photo.',
  nothing_removed: 'The background was not removed.',
  see_through: 'Parts of the garment look see-through.',
  pieces: 'The cutout is in several separate pieces.',
}

const KEPT = 128 // alpha from which a pixel counts as kept
const EMPTY_SHARE = 0.015 // kept share of the frame below which nothing useful is left
const FULL_SHARE = 0.97 // kept share of the frame above which the remover kept the whole photo
const HAZE_MIN = 40 // alpha from HAZE_MIN to HAZE_MAX is neither clearly removed nor solid
const HAZE_MAX = 215
const EDGE_BAND = 3 // px at 256 px a side: haze this close to a solid pixel is the inner half of a soft edge
const OUTER_BAND = 6 // the same towards a removed pixel; wider, so a faint strap, fringe or fluff never counts
const HAZE_SHARE = 0.06 // haze beyond the edge band, as a share of the kept area, that reads as see-through
const PIECE_MIN = 0.02 // pieces below this share of the largest one are specks
const PIECES_SHARE = 0.12 // share of the kept area outside the largest piece that reads as several pieces

/**
 * What looks wrong with a cutout, most serious first; empty when it looks fine.
 * 'alpha' has one byte per pixel (0 = removed, 255 = kept), w×h, at most 256 px a side.
 */
export function checkCutout(alpha: Uint8ClampedArray, w: number, h: number): CutIssue[] {
  const n = w * h
  if (!(w > 0 && h > 0) || alpha.length < n) return []
  let kept = 0
  for (let i = 0; i < n; i++) if (alpha[i] >= KEPT) kept++
  // With next to nothing or next to everything kept, the other checks have nothing sensible to measure.
  if (kept < n * EMPTY_SHARE) return ['empty']
  if (kept > n * FULL_SHARE) return ['nothing_removed']

  const issues: CutIssue[] = []
  if (hazeBeyondEdges(alpha, w, h) > kept * HAZE_SHARE) issues.push('see_through')
  if (outsideLargestPiece(alpha, w, h) > kept * PIECES_SHARE) issues.push('pieces')
  return issues
}

/**
 * Number of half-transparent pixels that are not part of a soft edge. A soft edge is a narrow ramp
 * between removed and solid, so each of its pixels has one of the two close by; haze over the fabric
 * is a plateau, and its middle has neither.
 */
function hazeBeyondEdges(alpha: Uint8ClampedArray, w: number, h: number): number {
  // Rounded up: at small sizes a band that rounds down to nothing would turn every soft edge into haze.
  const scale = Math.max(w, h) / 256
  const inner = Math.ceil(EDGE_BAND * scale)
  const outer = Math.ceil(OUTER_BAND * scale)
  const toSolid = distanceTo(alpha, w, h, HAZE_MAX + 1, 255, inner + 1)
  const toRemoved = distanceTo(alpha, w, h, 0, HAZE_MIN - 1, outer + 1)
  let count = 0
  for (let i = 0; i < toSolid.length; i++) if (toSolid[i] > inner && toRemoved[i] > outer) count++
  return count
}

/**
 * Chessboard distance from every pixel to the nearest one with alpha from `lo` to `hi`, capped at
 * `cap`; exact in two sweeps. Pixels outside the frame are nothing, so haze cut off by the frame
 * still counts as a plateau.
 */
function distanceTo(alpha: Uint8ClampedArray, w: number, h: number, lo: number, hi: number, cap: number): Uint16Array {
  const dist = new Uint16Array(w * h)
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const a = alpha[i]
      if (a >= lo && a <= hi) continue
      let m = cap - 1
      if (x > 0 && dist[i - 1] < m) m = dist[i - 1]
      if (y > 0) {
        const up = i - w
        if (dist[up] < m) m = dist[up]
        if (x > 0 && dist[up - 1] < m) m = dist[up - 1]
        if (x < w - 1 && dist[up + 1] < m) m = dist[up + 1]
      }
      dist[i] = m + 1
    }
  }
  for (let y = h - 1, i = w * h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--, i--) {
      if (!dist[i]) continue
      let m = dist[i] - 1
      if (x < w - 1 && dist[i + 1] < m) m = dist[i + 1]
      if (y < h - 1) {
        const down = i + w
        if (dist[down] < m) m = dist[down]
        if (x > 0 && dist[down - 1] < m) m = dist[down - 1]
        if (x < w - 1 && dist[down + 1] < m) m = dist[down + 1]
      }
      dist[i] = m + 1
    }
  }
  return dist
}

/**
 * Kept pixels that sit outside the largest piece, specks not counted. Pieces are 8-connected and
 * joined through anything not clearly removed, so a strap that came out faint still holds the garment
 * together; each piece is weighed by its kept pixels only.
 */
function outsideLargestPiece(alpha: Uint8ClampedArray, w: number, h: number): number {
  const n = w * h
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const sizes: number[] = []
  let largest = 0
  for (let s = 0; s < n; s++) {
    if (seen[s] || alpha[s] < HAZE_MIN) continue
    let size = 0
    let top = 0
    stack[top++] = s
    seen[s] = 1
    while (top) {
      const p = stack[--top]
      if (alpha[p] >= KEPT) size++
      const x = p % w
      const y = (p - x) / w
      const x0 = x > 0 ? x - 1 : x
      const x1 = x < w - 1 ? x + 1 : x
      const y0 = y > 0 ? y - 1 : y
      const y1 = y < h - 1 ? y + 1 : y
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const q = yy * w + xx
          if (!seen[q] && alpha[q] >= HAZE_MIN) {
            seen[q] = 1
            stack[top++] = q
          }
        }
      }
    }
    if (size) sizes.push(size)
    if (size > largest) largest = size
  }
  let significant = 0
  for (const size of sizes) if (size >= largest * PIECE_MIN) significant += size
  return significant - largest
}
