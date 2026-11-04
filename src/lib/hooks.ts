import { useEffect, useState } from 'react'
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

export function useBitmap(blob: Blob | undefined | null) {
  const [bmp, setBmp] = useState<ImageBitmap>()
  useEffect(() => {
    if (!blob) return setBmp(undefined)
    let alive = true
    loadBitmap(blob).then((b) => {
      if (alive) setBmp(b)
      else b.close()
    })
    return () => {
      alive = false
    }
  }, [blob])
  // Close a bitmap only after it has been replaced: until then consumers may still draw it.
  useEffect(() => () => bmp?.close(), [bmp])
  return bmp
}

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
