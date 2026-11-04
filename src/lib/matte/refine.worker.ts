import { type RefineJob, refineCutout } from './refine'

// Typed as a Worker for the transfer-list form of postMessage, which every browser supports.
const worker = self as unknown as Worker

self.onmessage = (e: MessageEvent<RefineJob & { id: number }>) => {
  const { id, ...job } = e.data
  try {
    const rgba = refineCutout(job)
    worker.postMessage({ id, rgba }, [rgba.buffer])
  } catch (err) {
    worker.postMessage({ id, error: String(err) })
  }
}
