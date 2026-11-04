import { boxBlur } from './blur'

const VISIBLE = 0.1 // alpha at which a pixel counts as part of a region
const KEEP_SHARE = 0.005 // regions with less than this share of the largest region's mass are specks
const EDGE_RADIUS = 12 // px around kept regions where faint alpha (soft edges, fluff) survives
const FLOOR = 4 / 255 // below this, alpha is noise

/**
 * Clear what the remover kept away from the garment: specks of lint or pattern, and faint haze over
 * the background. Regions are 8-connected areas of visible alpha, weighed by their total alpha;
 * every region at least 0.5 % of the largest one stays, so a pair of socks keeps both socks.
 * Returns the number of regions removed.
 */
export function removeSpecks(alpha: Float32Array, w: number, h: number): number {
  const n = w * h
  const label = new Int32Array(n) // 0 = not visible; regions numbered from 1
  const mass: number[] = [0]
  const stack = new Int32Array(n)
  let id = 0
  for (let s = 0; s < n; s++) {
    if (label[s] || alpha[s] < VISIBLE) continue
    id++
    let m = 0
    let top = 0
    stack[top++] = s
    label[s] = id
    while (top) {
      const p = stack[--top]
      m += alpha[p]
      const x = p % w
      const y = (p - x) / w
      const x0 = x > 0 ? x - 1 : x
      const x1 = x < w - 1 ? x + 1 : x
      const y0 = y > 0 ? y - 1 : y
      const y1 = y < h - 1 ? y + 1 : y
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const q = yy * w + xx
          if (!label[q] && alpha[q] >= VISIBLE) {
            label[q] = id
            stack[top++] = q
          }
        }
      }
    }
    mass.push(m)
  }
  if (!id) return 0

  let largest = 0
  for (let k = 1; k <= id; k++) if (mass[k] > largest) largest = mass[k]
  const keep = new Uint8Array(id + 1)
  let removed = 0
  for (let k = 1; k <= id; k++) {
    if (mass[k] >= largest * KEEP_SHARE) keep[k] = 1
    else removed++
  }

  // Kept regions, grown by EDGE_RADIUS: faint alpha only survives close to them.
  const near = new Float32Array(n)
  for (let i = 0; i < n; i++) near[i] = keep[label[i]]
  boxBlur(near, w, h, EDGE_RADIUS, near)
  for (let i = 0; i < n; i++) {
    const k = label[i]
    const drop = k ? !keep[k] : near[i] < 1e-6 || alpha[i] < FLOOR
    if (drop) alpha[i] = 0
  }
  return removed
}
