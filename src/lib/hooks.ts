import { useEffect, useRef, useState } from 'react'
import { loadBitmap } from './image'

export function useObjectURL(blob: Blob | undefined | null) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!blob) return setUrl(undefined)
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}

/**
 * `blob` decoded. While a new blob decodes: the previous bitmap when the new blob is the same picture read
 * again (team sync and other windows re-read records, with new Blob objects of the same size), otherwise
 * undefined, never another photo's pixels (Save would export them under the new photo's name). Undefined when
 * it can't be decoded.
 */
export function useBitmap(blob: Blob | undefined | null) {
  const [state, setState] = useState<{ blob: Blob; bmp?: ImageBitmap }>()
  useEffect(() => {
    if (!blob) return setState(undefined)
    let alive = true
    loadBitmap(blob).then(
      (b) => {
        if (alive) setState({ blob, bmp: b })
        else b.close()
      },
      () => alive && setState({ blob }), // e.g. a truncated file, or memory pressure on a phone
    )
    return () => {
      alive = false
    }
  }, [blob])
  // Close a bitmap only after it has been replaced: until then consumers may still draw it.
  useEffect(() => () => state?.bmp?.close(), [state])
  return state && blob && sameBlob(state.blob, blob) ? state.bmp : undefined
}

/** The same picture: the same object, or a copy read again (same size and type; two different photos practically never match). */
export const sameBlob = (a: Blob, b: Blob) => a === b || (a.size === b.size && a.type === b.type)

/** Seconds since `start`, ticking once a second while `start` is set. */
export function useElapsed(start: number | undefined) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!start) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [start])
  return start ? Math.max(0, Math.round((now - start) / 1000)) : 0
}

/**
 * `blob`, or the object given before when it is the same picture read again (team sync and other windows
 * re-read records): effects and caches keyed by the object then don't start over.
 */
export function useStableBlob(blob: Blob | undefined) {
  const kept = useRef(blob)
  if (!(blob && kept.current && sameBlob(kept.current, blob))) kept.current = blob
  return kept.current
}
