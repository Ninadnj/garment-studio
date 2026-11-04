// Free AI through public Hugging Face Spaces (Gradio apps).
// - Kolors Virtual Try-On (tops and dresses) and WeShop's try-on (bottoms) pass the images on to Kuaishou's
//   and WeShop's own servers, and the HiDream demos (new models) the prompt to HiDream's: no daily limit,
//   but they answer errors when busy.
// - The backups run on shared GPUs ("ZeroGPU"). Free use there has two limits: daily GPU time (2 min per
//   internet connection without a token, 5 min on a free account, 8× on PRO; renews 24 h after the first
//   use) and, since April 2026, about 3 runs a day for free users.
// Protocol: GET /config, upload the images, POST queue/join, then read queue/data (server-sent events).

export type SpaceStatus = ({ stage: 'queue'; position: number } | { stage: 'running'; eta?: number }) & {
  service?: string
}

export class SpaceError extends Error {
  constructor(
    message: string,
    readonly quota = false,
    readonly renewsAt?: number, // when the free allowance renews, if known
    readonly changed = false, // the Space no longer offers what the app calls; retrying won't help
  ) {
    super(message)
  }
}

const TOO_LONG = 'The free service took too long. Try again.'

// When the free allowance renews, as Hugging Face last stated it. Only some limit messages give the
// time, so it is kept for the others. Kept per token (the allowance belongs to the account, or to the
// internet connection without one); only the token's last characters are stored.
const RENEWS_KEY = 'gs.hfRenews'

const renewal = {
  get(token = ''): number | undefined {
    try {
      const r = JSON.parse(localStorage.getItem(RENEWS_KEY) ?? 'null') as { at: number; who: string } | null
      return r?.who === token.slice(-6) ? r.at : undefined
    } catch {
      return undefined
    }
  },
  set(at: number, token = '') {
    try {
      localStorage.setItem(RENEWS_KEY, JSON.stringify({ at, who: token.slice(-6) }))
    } catch {
      // Storage unavailable; later messages leave the time out.
    }
  },
}

interface FileData {
  path: string
  url?: string
  meta?: { _type: 'gradio.FileData' }
}

interface QueueMessage {
  msg: string
  rank?: number
  eta?: number
  success?: boolean
  message?: string
  output?: { data?: unknown[]; error?: string | null }
  log?: string // msg 'log': gr.Info / gr.Warning text
  level?: string
}

interface SpaceFn {
  fn_index: number
  trigger_id: number | null
  inputs: number
}

interface SpaceConfig {
  prefix: string
  fns: Map<string | number, SpaceFn> // by API name, and by index for Spaces that hide their API
}

const configs = new Map<string, Promise<SpaceConfig>>()

const authHeaders = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})

async function request(url: string, init?: RequestInit) {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e
    throw new SpaceError('Could not reach Hugging Face. Check your connection.')
  }
  const withToken = !!(init?.headers as Record<string, string> | undefined)?.Authorization
  if ((res.status === 401 || res.status === 403) && withToken)
    throw new SpaceError('Hugging Face rejected the token. Check it in Settings, or clear it to use the free allowance.')
  if (res.status === 429) throw new SpaceError('Too many requests to the free service. Wait a minute and try again.')
  if (!res.ok) throw new SpaceError(`The free service answered with error ${res.status}. Try again later.`)
  return res
}

function getConfig(host: string, token?: string): Promise<SpaceConfig> {
  let p = configs.get(host)
  if (!p) {
    // Its own time limit: a config that never comes would otherwise stay cached for the whole session.
    p = request(`https://${host}/config`, { headers: authHeaders(token), signal: AbortSignal.timeout(30_000) })
      .then((r) => r.json())
      .then(
        (cfg: {
          api_prefix?: string
          dependencies: { id?: number; api_name?: string | false; targets?: [number, string][]; inputs?: number[] }[]
        }) => {
          const fns: SpaceConfig['fns'] = new Map()
          cfg.dependencies.forEach((d, i) => {
            const fn = { fn_index: d.id ?? i, trigger_id: d.targets?.[0]?.[0] ?? null, inputs: d.inputs?.length ?? 0 }
            fns.set(fn.fn_index, fn)
            if (d.api_name) fns.set(d.api_name, fn)
          })
          const prefix = cfg.api_prefix ?? ''
          if (prefix && !prefix.startsWith('/')) throw new SpaceError('The free service sent an unexpected setup.')
          return { prefix, fns }
        },
      )
      .catch((e) => {
        configs.delete(host)
        throw e instanceof SpaceError ? e : new SpaceError('The free service is starting up. Try again in a minute.')
      })
    configs.set(host, p)
  }
  return p
}

/** Split server-sent-event text into JSON messages; returns the incomplete tail to keep buffering. */
export function parseEvents(buffer: string): { messages: QueueMessage[]; rest: string } {
  const messages: QueueMessage[] = []
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n')
    if (!data) continue
    try {
      messages.push(JSON.parse(data))
    } catch {
      // Not JSON (keep-alive comments and the like).
    }
  }
  return { messages, rest }
}

function duration(ms: number) {
  const total = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return [h && `${h} h`, (m || !h) && `${m} min`].filter(Boolean).join(' ')
}

/**
 * Turn a Space error into something actionable. When a free limit runs out, says which one and when it
 * renews: from the message, else from `renewsAt` (remembered from an earlier message).
 */
export function friendlyError(
  raw: string | null | undefined,
  { renewsAt, token = false, now = Date.now() }: { renewsAt?: number; token?: boolean; now?: number } = {},
): SpaceError {
  if (!raw) return new SpaceError('The free service could not make this image. Try again, or use FASHN in Settings.')
  if (!/quota|runs limit/i.test(raw)) return new SpaceError(raw.length > 240 ? `${raw.slice(0, 240)}…` : raw)

  // "Try again in 23:59:14"; a zero wait comes with the runs limit and says nothing.
  const w = raw.match(/(\d+):(\d\d):(\d\d)/)
  const wait = w ? ((Number(w[1]) * 60 + Number(w[2])) * 60 + Number(w[3])) * 1000 : 0
  const stated = wait ? now + wait : undefined
  const at = stated ?? (renewsAt && renewsAt > now ? renewsAt : undefined)
  const runs = /runs limit/i.test(raw)
  const needs = raw.match(/(\d+)s requested/i)?.[1]
  const left = Number(raw.match(/(\d+)s left/i)?.[1] ?? 0)

  const what = runs
    ? "Today's free tries on Hugging Face are used up."
    : needs && left
      ? `Not enough free GPU time is left on Hugging Face today: this needs ${needs} s, ${left} s are left.`
      : "Today's free GPU time on Hugging Face is used up."
  const it = runs ? 'They' : 'It'
  const when = stated
    ? ` ${it} renew${runs ? '' : 's'} in ${duration(stated - now)}.`
    : at
      ? ` ${it} should renew in ${duration(at - now)}.`
      : ` ${it} renew${runs ? '' : 's'} within 24 hours.`
  // The runs limit is "about 3 a day for free users": only PRO is known to raise it.
  const more = runs
    ? token
      ? ' A Hugging Face PRO account raises the daily limit.'
      : ' A token from a Hugging Face PRO account, added in Settings, raises the daily limit.'
    : token
      ? ' A Hugging Face PRO account gives 8 times the GPU time.'
      : ' A Hugging Face token in Settings raises the limit, a little with a free account and much more with PRO.'
  return new SpaceError(what + when + more, true, at)
}

const isFile = (v: unknown): v is FileData => !!v && typeof v === 'object' && 'path' in v

type CallOptions = {
  token?: string
  onStatus?: (s: SpaceStatus) => void
  signal?: AbortSignal
  timeout?: number // ms; some services keep a job open as long as their backend takes (WeShop: up to an hour)
}

/**
 * Run `api` (an endpoint name, or its index when the Space hides its API) on the Space at `host`.
 * `files` are uploaded first; `buildData` turns their server paths into the endpoint's inputs.
 * Resolves with the first image output.
 */
export async function callSpace(
  host: string,
  api: string | number,
  files: Blob[],
  buildData: (paths: FileData[]) => unknown[],
  opts: CallOptions = {},
): Promise<Blob> {
  if (!opts.timeout) return runSpace(host, api, files, buildData, opts)
  const ctrl = new AbortController()
  const stop = () => ctrl.abort()
  opts.signal?.addEventListener('abort', stop)
  const timer = setTimeout(stop, opts.timeout)
  try {
    return await runSpace(host, api, files, buildData, { ...opts, signal: ctrl.signal })
  } catch (e) {
    if (ctrl.signal.aborted && !opts.signal?.aborted) throw new SpaceError(TOO_LONG)
    throw e
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', stop)
  }
}

/** `promise`, or a rejection as soon as `signal` aborts (the shared config fetch itself carries no signal). */
function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function runSpace(
  host: string,
  api: string | number,
  files: Blob[],
  buildData: (paths: FileData[]) => unknown[],
  opts: CallOptions,
): Promise<Blob> {
  const auth = authHeaders(opts.token)
  const fail = (raw?: string | null) => {
    const e = friendlyError(raw, { renewsAt: renewal.get(opts.token), token: !!opts.token })
    if (e.renewsAt) renewal.set(e.renewsAt, opts.token)
    return e
  }
  const changed = () =>
    new SpaceError('The free service changed and no longer offers this. Use FASHN in Settings.', false, undefined, true)
  const cfg = await unlessAborted(getConfig(host, opts.token), opts.signal)
  const fn = cfg.fns.get(api)
  // Different inputs mean the Space now runs something else under this name or index: stop before uploading.
  if (!fn || buildData(files.map(() => ({ path: '' }))).length !== fn.inputs) throw changed()
  const base = `https://${host}${cfg.prefix}`

  const paths = await Promise.all(
    files.map(async (blob, i) => {
      const fd = new FormData()
      fd.append('files', blob, `image-${i}.${blob.type === 'image/png' ? 'png' : 'jpg'}`)
      const res = await request(`${base}/upload`, { method: 'POST', body: fd, headers: auth, signal: opts.signal })
      const [path] = (await res.json()) as string[]
      return { path, meta: { _type: 'gradio.FileData' as const } }
    }),
  )

  const data = buildData(paths)
  const session_hash = Math.random().toString(36).slice(2, 13)
  await request(`${base}/queue/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ data, fn_index: fn.fn_index, trigger_id: fn.trigger_id, session_hash, event_data: null }),
    signal: opts.signal,
  })

  const res = await request(`${base}/queue/data?session_hash=${session_hash}`, {
    headers: { Accept: 'text/event-stream', ...auth },
    signal: opts.signal,
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let warning: string | undefined // WeShop reports failures only as a warning before an empty result
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') throw e
      throw new SpaceError('The connection to the free service dropped. Try again.')
    }
    const { done, value } = chunk
    if (done) break
    const parsed = parseEvents(buffer + decoder.decode(value, { stream: true }))
    buffer = parsed.rest
    for (const m of parsed.messages) {
      if (m.msg === 'estimation') opts.onStatus?.({ stage: 'queue', position: (m.rank ?? 0) + 1 })
      else if (m.msg === 'process_starts') opts.onStatus?.({ stage: 'running', eta: m.eta })
      else if (m.msg === 'unexpected_error') throw fail(m.message)
      else if (m.msg === 'log' && m.level !== 'info' && m.log) warning = m.log
      else if (m.msg === 'process_completed') {
        reader.cancel().catch(() => {})
        if (!m.success) throw fail(m.output?.error)
        const outputs = (m.output?.data ?? []).filter(isFile)
        // Some Spaces report a failure as text next to an empty image (Kolors: "Too many users, …"),
        // HiDream as an HTML status pill.
        const text = m.output?.data
          ?.find((d): d is string => typeof d === 'string' && d !== '')
          ?.replace(/<[^>]*>/g, '')
          .trim()
        if (!outputs.length) throw fail(text || warning || 'The free service returned no image.')
        // Only the first image is used (others are masks and the like). The token goes only to the Space itself.
        const url = outputs[0].url ?? `${base}/file=${outputs[0].path}`
        const own = new URL(url).origin === `https://${host}`
        return (await request(url, { headers: own ? auth : {}, signal: opts.signal })).blob()
      }
    }
  }
  throw new SpaceError('The free service stopped before finishing. Try again.')
}

export type GarmentKind = 'top' | 'bottom' | 'dress'

// Kolors, WeShop and HiDream run on their companies' own servers: no daily limit. The others are on the
// shared GPUs and serve as backups.
const KOLORS = 'kwai-kolors-kolors-virtual-try-on.hf.space' // tops and dresses (tested 2026-10-30)
const KOLORS_TRYON = 2 // the Space hides its API; this is its try-on (person, garment, seed, random seed)
const WESHOP = 'weshopai-weshopai-virtual-try-on.hf.space' // bottoms, 1520 × 2048 (tested 2026-10-31)
const HIDREAM_O1 = 'hidream-ai-hidream-o1-image.hf.space' // new models, 1728 × 2304 (tested 2026-10-31)
const HIDREAM_I1 = 'hidream-ai-hidream-i1-dev.hf.space' // new models, 880 × 1168, when O1 fails
const IDM_VTON = 'yisol-idm-vton.hf.space' // tops when Kolors is busy (clean result, tested 2026-10-30)
const LEFFA = 'franciszzj-leffa.hf.space' // bottoms and dresses when WeShop or Kolors is busy (Dress Code model)
const FLUX_DEV = 'black-forest-labs-flux-1-dev.hf.space' // new models when HiDream is busy

// Kolors and HiDream end their own jobs within about 5 minutes; WeShop can keep one open for an hour.
const OWN_SERVERS_TIMEOUT = 5 * 60_000

const seed = () => Math.floor(Math.random() * 1_000_000)

type CallOpts = Parameters<typeof callSpace>[4]

// Status updates name the service, since a job can move from one to another. Only the shared-GPU Spaces
// get the Hugging Face token; the others don't use it, and get a time limit instead.
const via = (service: string, opts: CallOpts, sharedGpu: boolean): CallOpts => ({
  ...opts,
  token: sharedGpu ? opts?.token : undefined,
  timeout: sharedGpu ? undefined : OWN_SERVERS_TIMEOUT,
  onStatus: (s) => opts?.onStatus?.({ ...s, service }),
})

type Service = [name: string, run: () => Promise<Blob>]

// "The free service answered with error 503. Try again later." → "The free service answered with error 503"
const reason = (message: string) =>
  message.replace(/\.\s+(Try again[^.]*|Wait a minute and try again|Check your connection)\.$/, '').replace(/\.$/, '')

/**
 * Runs `first`, a service without a daily limit, and `backup` on the shared GPUs if it fails. When both
 * fail, the message leads with the first one: it is the one worth retrying, unless it has changed.
 */
async function withBackup([name, run]: Service, [backupName, backup]: Service, signal?: AbortSignal) {
  let first: Error
  try {
    return await run()
  } catch (e) {
    if (signal?.aborted) throw e
    first = e as Error
  }
  try {
    return await backup()
  } catch (e) {
    if (!(e instanceof SpaceError) || e.message === first.message) throw e
    const gone = first instanceof SpaceError && first.changed
    const lead = gone
      ? `${name} has changed, and this app can no longer use it.`
      : `${name} could not make it right now (${reason(first.message)}). It has no daily limit, so try again in ` +
        'a minute.'
    // Retrying only helps while the first service is still there; otherwise the backup's limit is what counts.
    throw new SpaceError(
      `${lead} The backup, ${backupName} on Hugging Face, failed too: ${e.message}`,
      gone && e.quota,
      gone ? e.renewsAt : undefined,
    )
  }
}

/**
 * Free try-on: `person` wearing `garment` (a product photo on white). Tops and dresses go to Kolors, bottoms
 * to WeShop (Kolors turns trousers into a dress); the shared-GPU models are the backups.
 */
export async function freeTryOn(garment: Blob, person: Blob, kind: GarmentKind, description: string, opts: CallOpts) {
  const leffa: Service = [
    'Leffa',
    () =>
      callSpace(
        LEFFA,
        'leffa_predict_vt',
        [person, garment],
        ([p, g]) => [p, g, false, 30, 2.5, seed(), 'dress_code', kind === 'bottom' ? 'lower_body' : 'dresses', false],
        via('Leffa', opts, true),
      ),
  ]
  if (kind === 'bottom')
    return withBackup(
      [
        'WeShop',
        // Garment first, then the person; the third input is the Space's own session state.
        () =>
          callSpace(WESHOP, 'generate_image', [garment, person], ([g, p]) => [g, p, null], via('WeShop', opts, false)),
      ],
      leffa,
      opts?.signal,
    )
  return withBackup(
    [
      'Kolors',
      () => callSpace(KOLORS, KOLORS_TRYON, [person, garment], ([p, g]) => [p, g, 0, true], via('Kolors', opts, false)),
    ],
    kind === 'top'
      ? [
          'IDM-VTON',
          () =>
            callSpace(
              IDM_VTON,
              'tryon',
              [person, garment],
              ([p, g]) => [
                { background: p, layers: [], composite: null },
                g,
                description || 'top',
                true,
                true,
                30,
                seed(),
              ],
              via('IDM-VTON', opts, true),
            ),
        ]
      : leffa,
    opts?.signal,
  )
}

/** Free AI model photo from a text prompt, 3:4: HiDream (two demos of its servers), else FLUX.1 dev. */
export async function freeModel(prompt: string, opts: CallOpts) {
  // Both HiDream demos share one time limit: I1 gets what O1 left.
  const hidream = async () => {
    const deadline = Date.now() + OWN_SERVERS_TIMEOUT
    try {
      // prompt, ratio, negative prompt, prompt rewriting (changes the look), seed (-1 random), guidance
      const o1 = () => [prompt, '3:4', '', false, -1, 5]
      return await callSpace(HIDREAM_O1, '_generate_wrapped', [], o1, via('HiDream', opts, false))
    } catch (e) {
      if (opts?.signal?.aborted || (e as Error).message === TOO_LONG) throw e
      try {
        const i1 = () => [prompt, '3:4', seed()]
        const left = Math.max(1, deadline - Date.now())
        const i1opts = { ...via('HiDream', opts, false), timeout: left }
        return await callSpace(HIDREAM_I1, 'generate_with_status', [], i1, i1opts)
      } catch {
        throw e // O1's reason is the one to show
      }
    }
  }
  const flux = () =>
    callSpace(FLUX_DEV, 'infer', [], () => [prompt, 0, true, 768, 1024, 3.5, 28], via('FLUX.1 dev', opts, true))
  return withBackup(['HiDream', hidream], ['FLUX.1 dev', flux], opts?.signal)
}
