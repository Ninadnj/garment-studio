// BRIA RMBG-1.4: an ISNet-style remover trained on licensed product and stock photos, run in the browser
// with onnxruntime-web (WebGPU, falling back to WASM). Weights: huggingface.co/briaai/RMBG-1.4, free for
// non-commercial use. The model is cached in Cache Storage after the first download.
import * as ort from 'onnxruntime-web/webgpu'

const MODEL_URL =
  'https://huggingface.co/briaai/RMBG-1.4/resolve/2ceba5a5efaec153162aedea169f76caf9b46cf8/onnx/model_fp16.onnx'
const MODEL_BYTES = 88_217_533
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
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress?.({ stage: 'download', ratio: Math.min(1, got / total) })
  }
  const model = new Uint8Array(got)
  let at = 0
  for (const c of chunks) {
    model.set(c, at)
    at += c.length
  }
  cache?.put(MODEL_URL, new Response(model, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {})
  return model
}

let model: Promise<Uint8Array> | null = null
let gpu: Promise<ort.InferenceSession> | null = null
let cpu: Promise<ort.InferenceSession> | null = null
let gpuBroken = !('gpu' in navigator)

function session(provider: 'webgpu' | 'wasm', onProgress?: RmbgProgress) {
  model ??= fetchModel(onProgress).catch((e) => {
    model = null
    throw e
  })
  const create = () => model!.then((m) => ort.InferenceSession.create(m, { executionProviders: [provider] }))
  if (provider === 'webgpu') return (gpu ??= create())
  return (cpu ??= create())
}

async function infer(input: Float32Array, onProgress?: RmbgProgress): Promise<Float32Array> {
  const feeds = (s: ort.InferenceSession) => ({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) })
  if (!gpuBroken) {
    try {
      const s = await session('webgpu', onProgress)
      onProgress?.({ stage: 'compute' })
      const out = await s.run(feeds(s))
      return out[s.outputNames[0]].data as Float32Array
    } catch (e) {
      // Some GPUs/browsers lack a feature the WebGPU kernels need; the WASM build always works.
      console.warn('RMBG on WebGPU failed, using WASM', e)
      gpuBroken = true
      gpu = null
    }
  }
  const s = await session('wasm', onProgress)
  onProgress?.({ stage: 'compute' })
  const out = await s.run(feeds(s))
  return out[s.outputNames[0]].data as Float32Array
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
