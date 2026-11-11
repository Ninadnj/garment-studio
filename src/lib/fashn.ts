// FASHN API (https://docs.fashn.ai): submit to /v1/run, poll /v1/status/{id}.
// Called straight from the browser; the key lives only in this device's localStorage.
import type { GenMode, Resolution } from './settings'

const API = 'https://api.fashn.ai/v1'
const POLL_MS = 2500
const TIMEOUT_MS = 5 * 60_000

export type RunStatus = 'starting' | 'in_queue' | 'processing' | 'completed' | 'failed'

export class FashnError extends Error {
  constructor(
    message: string,
    readonly status = 0, // HTTP status; 0 when FASHN couldn't be reached
  ) {
    super(message)
  }
}

interface Quality {
  mode: GenMode
  resolution: Resolution
}

async function call<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(API + path, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    })
  } catch {
    throw new FashnError('Could not reach FASHN. Check your connection.')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) throw new FashnError('FASHN rejected the API key. Check it in Settings.', 401)
    throw new FashnError(body.message || body.error || `FASHN error ${res.status}`, res.status)
  }
  return body as T
}

async function run(
  key: string,
  model_name: string,
  inputs: Record<string, unknown>,
  onStatus?: (s: RunStatus) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const sub = await call<{ id?: string; error?: unknown }>(key, '/run', {
    method: 'POST',
    body: JSON.stringify({ model_name, inputs: { ...inputs, return_base64: true } }),
  })
  if (!sub.id) throw new FashnError(errMessage(sub.error) || 'FASHN did not accept the request.')
  const started = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    signal?.throwIfAborted()
    let s: { status: RunStatus; output?: string[]; error?: unknown }
    try {
      s = await call(key, `/status/${sub.id}`)
    } catch (e) {
      // A dropped connection or a busy server while waiting: the paid job keeps running at FASHN, so keep asking.
      const passing = e instanceof FashnError && (e.status === 0 || e.status === 429 || e.status >= 500)
      if (!passing || Date.now() - started > TIMEOUT_MS) throw e
      continue
    }
    onStatus?.(s.status)
    if (s.status === 'completed') {
      if (!s.output?.length) throw new FashnError('FASHN returned no image.')
      return s.output
    }
    if (s.status === 'failed') throw new FashnError(errMessage(s.error) || 'Generation failed.')
    if (Date.now() - started > TIMEOUT_MS) throw new FashnError('Timed out waiting for FASHN.')
  }
}

function errMessage(e: unknown): string | undefined {
  if (!e) return undefined
  if (typeof e === 'string') return e
  const o = e as { message?: string; name?: string }
  return o.message || o.name
}

const format = (r: Resolution) => (r === '4k' ? 'jpeg' : 'png')

export async function credits(key: string): Promise<number> {
  const b = await call<{ credits?: { total?: number } }>(key, '/credits')
  return b.credits?.total ?? 0
}

/** Generate fashion model photos from a text description. Returns data URIs. */
export const createModel = (
  key: string,
  prompt: string,
  q: Quality,
  count: number,
  onStatus?: (s: RunStatus) => void,
  signal?: AbortSignal,
) =>
  run(
    key,
    'model-create',
    {
      prompt,
      aspect_ratio: '3:4',
      resolution: q.resolution,
      generation_mode: q.mode,
      num_images: count,
      output_format: 'jpeg',
      seed: Math.floor(Math.random() * 2 ** 31),
    },
    onStatus,
    signal,
  )

/** Put the product on the person in `modelImage`, keeping their pose and the photo framing. */
export const tryOn = (
  key: string,
  productImage: string,
  modelImage: string,
  prompt: string,
  q: Quality,
  onStatus?: (s: RunStatus) => void,
) =>
  run(
    key,
    'tryon-max',
    {
      product_image: productImage,
      model_image: modelImage,
      prompt,
      resolution: q.resolution,
      generation_mode: q.mode,
      output_format: format(q.resolution),
    },
    onStatus,
  )
