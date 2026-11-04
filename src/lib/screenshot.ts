// Phone screenshots of a photo viewer (Vinted, Instagram, Photos…) put the photo between uniform bars
// holding the clock, buttons and page dots. Crop to the photo so background removal only sees the photo.
import { canvasToBlob } from './image'

const TOLERANCE = 28 // per channel, vs the corner colour
const BAR_ROW = 0.9 // a row/column is "bar" when this share of its pixels matches the corner colour

function longestRun(isBar: boolean[]): [number, number] {
  let best: [number, number] = [0, isBar.length]
  let bestLen = 0
  let start = -1
  for (let i = 0; i <= isBar.length; i++) {
    const bar = i === isBar.length || isBar[i]
    if (!bar && start < 0) start = i
    if (bar && start >= 0) {
      if (i - start > bestLen) {
        bestLen = i - start
        best = [start, i]
      }
      start = -1
    }
  }
  return best
}

/** Returns the photo cropped out of a phone screenshot, or null when the image isn't one. */
export async function cropScreenshotBars(blob: Blob): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob)
  const W = bmp.width
  const H = bmp.height
  try {
    if (H / W < 1.9) return null // only tall, phone-shaped images

    const s = Math.min(1, 360 / W)
    const w = Math.max(1, Math.round(W * s))
    const h = Math.max(1, Math.round(H * s))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bmp, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    const [r, g, b] = [d[0], d[1], d[2]]
    const near = (i: number) =>
      Math.abs(d[i] - r) < TOLERANCE && Math.abs(d[i + 1] - g) < TOLERANCE && Math.abs(d[i + 2] - b) < TOLERANCE

    const rows: boolean[] = []
    for (let y = 0; y < h; y++) {
      let n = 0
      for (let x = 0; x < w; x++) if (near((y * w + x) * 4)) n++
      rows.push(n / w >= BAR_ROW)
    }
    const [y0, y1] = longestRun(rows)
    const share = (y1 - y0) / h
    if (share > 0.92 || share < 0.25) return null

    const cols: boolean[] = []
    for (let x = 0; x < w; x++) {
      let n = 0
      for (let y = y0; y < y1; y++) if (near((y * w + x) * 4)) n++
      cols.push(n / (y1 - y0) >= BAR_ROW)
    }
    const [x0, x1] = longestRun(cols)

    // Back to full resolution; step 2px inside any cut edge so no bar fringe remains.
    const X0 = x0 > 0 ? Math.ceil(x0 / s) + 2 : 0
    const X1 = x1 < w ? Math.floor(x1 / s) - 2 : W
    const Y0 = y0 > 0 ? Math.ceil(y0 / s) + 2 : 0
    const Y1 = y1 < h ? Math.floor(y1 / s) - 2 : H
    const out = document.createElement('canvas')
    out.width = X1 - X0
    out.height = Y1 - Y0
    out.getContext('2d')!.drawImage(bmp, X0, Y0, out.width, out.height, 0, 0, out.width, out.height)
    return canvasToBlob(out, 'image/jpeg', 0.95)
  } finally {
    bmp.close()
  }
}
