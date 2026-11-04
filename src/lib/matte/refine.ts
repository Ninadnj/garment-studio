import { estimateForeground } from './foreground'
import { removeSpecks } from './specks'

export interface RefineJob {
  rgba: Uint8ClampedArray // the photo, with the matte in the alpha channel
  w: number
  h: number
  clean: boolean // drop specks and haze (automatic mattes only; never undo hand edits)
}

/** Turns photo + matte into the final cutout pixels, in place. Pure, so it runs in a worker or in tests. */
export function refineCutout({ rgba, w, h, clean }: RefineJob): Uint8ClampedArray {
  const n = w * h
  const alpha = new Float32Array(n)
  for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 3] / 255
  if (clean) removeSpecks(alpha, w, h)
  estimateForeground(rgba, alpha, w, h)
  for (let i = 0; i < n; i++) rgba[i * 4 + 3] = Math.round(alpha[i] * 255)
  return rgba
}
