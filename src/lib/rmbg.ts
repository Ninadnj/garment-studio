// BRIA RMBG-1.4 in the browser with onnxruntime-web (WebGPU, falling back to WASM): a 1024×1024 picture in,
// a matte out. Weights come from Hugging Face once, then from Cache Storage.
// Tried on 12 real product and model photos (2026-11-10) and not kept:
//  - Open RMBG (onnx-community/ormbg-ONNX, Apache-2.0): WASM only (MaxPool with ceil is missing on WebGPU),
//    9 s a photo against under 1 s, and it left a cream top on white half transparent.
//  - BiRefNet lite (onnx-community/BiRefNet_lite-ONNX, MIT): fails on WebGPU and on WASM with onnxruntime-web 1.21.
// BiRefNet itself is offered online instead (see onlineCutout in hf.ts).
import * as ort from 'onnxruntime-web/webgpu'

// Free for non-commercial use; BRIA sells licences for commercial use.
const MODEL_URL =
  'https://huggingface.co/briaai/RMBG-1.4/resolve/2ceba5a5efaec153162aedea169f76caf9b46cf8/onnx/model_fp16.onnx'
const MODEL_BYTES = 88_217_533 // when the server doesn't say
const CACHE = 'gs-models-v1'
const SIZE = 1024

export type RmbgProgress = (p: { stage: 'download'; ratio: number } | { stage: 'compute' }) => void

async function fetchModel(onProgress?: RmbgProgress): Promise<Uint8Array> {
  let cache: Cache | undefined
  try {
    cache = await caches.open(CACHE)
  } catch {
    // Cache Storage unavailable (private mode): download every session.
  }
  const hit = await cache?.match(MODEL_URL)
  if (hit) return new Uint8Array(await hit.arrayBuffer())

  const res = await fetch(MODEL_URL)
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`)
  const length = Number(res.headers.get('content-length'))
  const total = length || MODEL_BYTES
  const reader = res.body.getReader()
  // Written straight into one buffer of the announced size, so the model isn't held twice (chunks and a copy).
  let buf: Uint8Array<ArrayBuffer> | undefined = length > 0 ? new Uint8Array(length) : undefined
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (buf && got + value.length <= buf.length) buf.set(value, got)
    else {
      if (buf) chunks.push(buf.subarray(0, got)) // more than announced: collect pieces instead
      buf = undefined
      chunks.push(value)
    }
    got += value.length
    onProgress?.({ stage: 'download', ratio: Math.min(1, got / total) })
  }
  let model: Uint8Array<ArrayBuffer>
  if (buf) model = got === buf.length ? buf : buf.slice(0, got)
  else {
    model = new Uint8Array(got)
    let at = 0
    for (const c of chunks) {
      model.set(c, at)
      at += c.length
    }
  }
  cache?.put(MODEL_URL, new Response(model, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {})
  return model
}

let model: Promise<Uint8Array> | null = null
let gpu: Promise<ort.InferenceSession> | null = null
let cpu: Promise<ort.InferenceSession> | null = null
let gpuBroken = !('gpu' in navigator)

const release = (s: Promise<ort.InferenceSession> | null) => s?.then((x) => x.release()).catch(() => {})

function session(provider: 'webgpu' | 'wasm', onProgress?: RmbgProgress) {
  // The model is read only to make a session. Once the session exists the buffer goes (onnxruntime keeps its
  // own copy); a later session, e.g. the WASM one after WebGPU fails, reads it from Cache Storage again.
  const create = async () => {
    try {
      const m = await (model ??= fetchModel(onProgress))
      return await ort.InferenceSession.create(m, { executionProviders: [provider] })
    } finally {
      model = null
    }
  }
  const made = provider === 'webgpu' ? (gpu ??= create()) : (cpu ??= create())
  // A failed session (no connection for the download, out of memory) is tried again next time.
  made.catch(() => {
    if (gpu === made) gpu = null
    if (cpu === made) cpu = null
  })
  return made
}

async function infer(input: Float32Array, onProgress?: RmbgProgress): Promise<Float32Array> {
  const run = async (s: ort.InferenceSession) => {
    onProgress?.({ stage: 'compute' })
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) })
    return (await out[s.outputNames[0]].getData()) as Float32Array
  }
  if (!gpuBroken) {
    try {
      return await run(await session('webgpu', onProgress))
    } catch (e) {
      if (!navigator.onLine) throw e // the download failed, not the GPU
      // Some GPUs/browsers lack a feature the WebGPU kernels need; the WASM build always works.
      console.warn('RMBG on WebGPU failed, using WASM', e)
      gpuBroken = true
      const failed = gpu
      gpu = null
      release(failed) // its GPU and WASM memory, before a second session is made
    }
  }
  return run(await session('wasm', onProgress))
}

/** The subject's matte for `bmp`: a 1024×1024 canvas whose alpha is the matte (stretch it to the photo). */
export async function rmbgMatte(bmp: ImageBitmap, onProgress?: RmbgProgress): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas')
  c.width = SIZE
  c.height = SIZE
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, SIZE, SIZE)
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data
  const n = SIZE * SIZE
  // BRIA's preprocessing: RGB scaled to 0–1, mean 0.5, std 1.
  const input = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    input[i] = px[i * 4] / 255 - 0.5
    input[n + i] = px[i * 4 + 1] / 255 - 0.5
    input[2 * n + i] = px[i * 4 + 2] / 255 - 0.5
  }

  const out = await infer(input, onProgress)

  // Min-max normalise the matte, as BRIA's reference code does.
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    if (out[i] < lo) lo = out[i]
    if (out[i] > hi) hi = out[i]
  }
  const range = hi - lo || 1
  const matte = ctx.createImageData(SIZE, SIZE)
  for (let i = 0; i < n; i++) matte.data[i * 4 + 3] = Math.round(((out[i] - lo) / range) * 255)
  ctx.putImageData(matte, 0, 0)
  return c
}
