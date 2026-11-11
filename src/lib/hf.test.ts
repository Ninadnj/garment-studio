import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type SpaceStatus, friendlyError, parseEvents } from './hf'

describe('parseEvents', () => {
  it('splits complete events and keeps the unfinished tail', () => {
    const text =
      'data: {"msg":"estimation","rank":2}\n\n' +
      'data: {"msg":"heartbeat"}\r\n\r\n' +
      ': keep-alive comment\n\n' +
      'data: {"msg":"process_comp'
    const { messages, rest } = parseEvents(text)
    expect(messages.map((m) => m.msg)).toEqual(['estimation', 'heartbeat'])
    expect(messages[0].rank).toBe(2)
    expect(rest).toBe('data: {"msg":"process_comp')
    expect(parseEvents(rest + 'leted","success":true}\n\n').messages[0].success).toBe(true)
  })
})

describe('friendlyError', () => {
  const now = Date.UTC(2026, 9, 30, 12, 0)

  it('says how much GPU time is left and when it renews', () => {
    const e = friendlyError(
      'You have exceeded your ZeroGPU quota (90s requested vs. 76s left). Try again in 23:59:14. Authenticate with a Hugging Face token for more quota',
      { now },
    )
    expect(e.quota).toBe(true)
    expect(e.message).toContain('this needs 90 s, 76 s are left. It renews in 23 h 59 min.')
    expect(e.renewsAt).toBe(now + (23 * 3600 + 59 * 60 + 14) * 1000)
  })

  it('explains the runs limit, which gives no time, with a remembered one when there is one', () => {
    // As returned by the FLUX.1 dev Space on 2026-10-30.
    const raw =
      'You have exceeded your ZeroGPU runs limit. Authenticate with a Hugging Face token for more quota - https://huggingface.co/settings/tokens'
    const first = friendlyError(raw, { now })
    expect(first.quota).toBe(true)
    expect(first.message).toBe(
      "Today's free tries on Hugging Face are used up. They renew within 24 hours. A token from a Hugging Face PRO account, added in Settings, raises the daily limit.",
    )
    const later = friendlyError(raw, { now, renewsAt: now + (16 * 60 + 20) * 60_000, token: true })
    expect(later.message).toContain('They should renew in 16 h 20 min.')
    expect(later.message).toContain('A Hugging Face PRO account raises the daily limit.')
    expect(friendlyError(raw, { now, renewsAt: now - 1000 }).message).toContain('within 24 hours')
  })

  it('handles short, whole-hour and zero waits, other errors and missing details', () => {
    expect(friendlyError('ZeroGPU quota exceeded. Try again in 0:12:03', { now }).message).toContain('renews in 12 min.')
    expect(friendlyError('ZeroGPU quota exceeded. Try again in 2:00:10', { now }).message).toContain('renews in 2 h.')
    const zero = friendlyError('You have exceeded your free GPU quota (60s requested vs. 0s left). Try again in 0:00:00', { now })
    expect(zero.message).toContain('GPU time on Hugging Face is used up. It renews within 24 hours.')
    expect(zero.renewsAt).toBeUndefined()
    expect(friendlyError('CUDA out of memory').quota).toBe(false)
    expect(friendlyError(null).quota).toBe(false)
  })
})

describe('free services', () => {
  const KOLORS = 'kwai-kolors-kolors-virtual-try-on.hf.space'
  const IDM_VTON = 'yisol-idm-vton.hf.space'
  const LEFFA = 'franciszzj-leffa.hf.space'
  const WESHOP = 'weshopai-weshopai-virtual-try-on.hf.space'
  const HIDREAM_O1 = 'hidream-ai-hidream-o1-image.hf.space'
  const HIDREAM_I1 = 'hidream-ai-hidream-i1-dev.hf.space'
  const FLUX = 'black-forest-labs-flux-1-dev.hf.space'
  const BIREFNET = 'zhengpeng7-birefnet-demo.hf.space'

  // The Spaces' configs, reduced to what the client reads; names, positions and input counts as on the real ones.
  const dep = (api_name: string | false, inputs: number) => ({
    api_name,
    inputs: Array.from({ length: inputs }, (_, i) => i),
    targets: [[1, 'click']],
  })
  const other = dep('other', 1)
  const CONFIGS: Record<string, object> = {
    [KOLORS]: { dependencies: [other, other, dep(false, 4), other] },
    [IDM_VTON]: { dependencies: [other, other, dep('tryon', 7)] },
    [LEFFA]: { api_prefix: '/gradio_api', dependencies: [other, other, dep('leffa_predict_vt', 9)] },
    [WESHOP]: { api_prefix: '/gradio_api', dependencies: [other, other, dep('generate_image', 3)] },
    [HIDREAM_O1]: { api_prefix: '/gradio_api', dependencies: [other, dep('_generate_wrapped', 6)] },
    [HIDREAM_I1]: { api_prefix: '/gradio_api', dependencies: [dep('generate_with_status', 3)] },
    [FLUX]: { api_prefix: '/gradio_api', dependencies: [other, other, dep('infer', 7)] },
    [BIREFNET]: { api_prefix: '/gradio_api', dependencies: [other, other, dep('image', 3)] },
  }

  // A Space's answer: the completed event's data, a failure, a warning before an empty result (WeShop),
  // a connection that drops mid-stream, or a job that never ends.
  type Reply = { data?: unknown[]; error?: string; warning?: string; drop?: boolean; hang?: boolean }

  /** Stands in for the Spaces' HTTP API. Result files contain the name of the Space that made them. */
  function fakeSpaces(replies: Record<string, Reply>, configs: Record<string, object | number | 'hang'> = CONFIGS) {
    const joined: { host: string; fn_index: number; data: unknown[] }[] = []
    const tokens = new Map<string, Set<string | undefined>>() // Authorization header per host
    const uploaded: string[] = [] // host of each upload
    const downloaded: string[] = [] // host and path of each result file
    let uploads = 0
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const { host, pathname } = new URL(input)
      const path = pathname.replace('/gradio_api', '')
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      tokens.set(host, (tokens.get(host) ?? new Set()).add(auth))
      const json = (v: unknown) => new Response(JSON.stringify(v))
      if (path === '/config') {
        const c = configs[host]
        if (c === 'hang') return new Promise<Response>(() => {})
        return typeof c === 'number' ? new Response(null, { status: c }) : json(c)
      }
      if (path === '/upload') {
        uploaded.push(host)
        return json([`/tmp/upload-${uploads++}.jpg`])
      }
      if (path === '/queue/join') {
        joined.push({ host, ...JSON.parse(init!.body as string) })
        return json({ event_id: 'e1' })
      }
      if (path === '/queue/data') {
        const { data = [{ path: '/tmp/out.webp' }], error, warning, drop, hang } = replies[host] ?? {}
        const events = [
          { msg: 'estimation', rank: 0 },
          { msg: 'process_starts' },
          ...(warning ? [{ msg: 'log', level: 'warning', log: warning }] : []),
          { msg: 'process_completed', success: !error, output: { data, error: error ?? null } },
        ]
        const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`)
        if (!drop && !hang) return new Response(text.join(''))
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(text[0]))
              if (drop) c.error(new TypeError('network error'))
              // Like a real fetch, aborting ends the stream.
              init?.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')))
            },
          }),
        )
      }
      downloaded.push(host + path)
      return new Response(new Blob([host], { type: 'image/webp' }))
    })
    return { joined, tokens, uploaded, downloaded }
  }

  const garment = new Blob(['garment'])
  const person = new Blob(['person'])
  const busy = { data: [null, 123, 'Too many users, please try again later'] }
  const runsLimit = {
    error: 'You have exceeded your ZeroGPU runs limit. Authenticate with a Hugging Face token for more quota',
  }

  // A fresh module per test, so no Space config stays cached from another test.
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('sends tops and dresses to Kolors: person, garment, random seed', async () => {
    const { freeTryOn } = await import('./hf')
    const { joined } = fakeSpaces({})
    const statuses: SpaceStatus[] = []
    const top = await freeTryOn(garment, person, 'top', '', { onStatus: (s) => statuses.push(s) })
    expect(await top.text()).toBe(KOLORS)
    expect(joined).toMatchObject([
      { host: KOLORS, fn_index: 2, data: [{ path: '/tmp/upload-0.jpg' }, { path: '/tmp/upload-1.jpg' }, 0, true] },
    ])
    expect(statuses).toEqual([
      { stage: 'queue', position: 1, service: 'Kolors' },
      { stage: 'running', eta: undefined, service: 'Kolors' },
    ])
    expect(await (await freeTryOn(garment, person, 'dress', '', {})).text()).toBe(KOLORS)
  })

  it('sends bottoms to WeShop: garment first, then the person', async () => {
    const { freeTryOn } = await import('./hf')
    const { joined } = fakeSpaces({})
    const services = new Set<string | undefined>()
    const out = await freeTryOn(garment, person, 'bottom', '', { onStatus: (s) => services.add(s.service) })
    expect(await out.text()).toBe(WESHOP)
    expect(joined).toMatchObject([
      { host: WESHOP, fn_index: 2, data: [{ path: '/tmp/upload-0.jpg' }, { path: '/tmp/upload-1.jpg' }, null] },
    ])
    expect(services).toEqual(new Set(['WeShop']))
  })

  it('falls back to Leffa for bottoms when WeShop reports a problem, which it does only as a warning', async () => {
    const { freeTryOn, SpaceError } = await import('./hf')
    const weshopFails = { warning: 'Query task timeout.', data: [null, null] }
    const { joined } = fakeSpaces({ [WESHOP]: weshopFails })
    expect(await (await freeTryOn(garment, person, 'bottom', '', {})).text()).toBe(LEFFA)
    expect(joined.at(-1)!.data[7]).toBe('lower_body')

    fakeSpaces({ [WESHOP]: weshopFails, [LEFFA]: runsLimit })
    const e = await freeTryOn(garment, person, 'bottom', '', {}).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(SpaceError)
    expect((e as Error).message).toMatch(
      /^WeShop could not make it right now \(Query task timeout\)\. It has no daily limit, so try again in a minute\. The backup, Leffa on Hugging Face, failed too: Today's free tries on Hugging Face are used up\./,
    )
  })

  it('gives up on a service that keeps a job open for 5 minutes, and uses the backup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { freeTryOn } = await import('./hf')
      fakeSpaces({ [WESHOP]: { hang: true } })
      const result = freeTryOn(garment, person, 'bottom', '', {})
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(await (await result).text()).toBe(LEFFA)

      fakeSpaces({ [WESHOP]: { hang: true }, [LEFFA]: { error: 'CUDA out of memory' } })
      const failed = freeTryOn(garment, person, 'bottom', '', {}).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(((await failed) as Error).message).toMatch(
        /^WeShop could not make it right now \(The free service took too long\)\. It has no daily limit/,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the shared-GPU models when Kolors is busy', async () => {
    const { freeTryOn } = await import('./hf')
    const { joined } = fakeSpaces({ [KOLORS]: busy })
    const services = new Set<string | undefined>()
    const top = await freeTryOn(garment, person, 'top', 'white tank top', { onStatus: (s) => services.add(s.service) })
    expect(await top.text()).toBe(IDM_VTON)
    expect(joined.at(-1)!.data[2]).toBe('white tank top')
    expect(services).toEqual(new Set(['Kolors', 'IDM-VTON']))
    const dress = await freeTryOn(garment, person, 'dress', '', {})
    expect(await dress.text()).toBe(LEFFA)
    expect(joined.at(-1)!.data[7]).toBe('dresses')
  })

  it('falls back when Kolors changed what its try-on takes', async () => {
    const { freeTryOn } = await import('./hf')
    const { joined } = fakeSpaces({}, { ...CONFIGS, [KOLORS]: { dependencies: [other, other, dep(false, 3)] } })
    expect(await (await freeTryOn(garment, person, 'top', '', {})).text()).toBe(IDM_VTON)
    expect(joined.map((j) => j.host)).toEqual([IDM_VTON])
  })

  it('leads with Kolors when it and the backup both fail, and offers no token for it', async () => {
    const { freeTryOn, SpaceError } = await import('./hf')
    fakeSpaces({ [KOLORS]: { error: 'Too many users, please try again later' }, [IDM_VTON]: runsLimit })
    const e = await freeTryOn(garment, person, 'top', '', {}).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(SpaceError)
    expect((e as InstanceType<typeof SpaceError>).quota).toBe(false)
    expect((e as Error).message).toMatch(
      /^Kolors could not make it right now \(Too many users, please try again later\)\. It has no daily limit, so try again in a minute\. The backup, IDM-VTON on Hugging Face, failed too: Today's free tries on Hugging Face are used up\./,
    )
  })

  it('sends the Hugging Face token only to the shared-GPU Spaces', async () => {
    const { freeTryOn } = await import('./hf')
    const { tokens } = fakeSpaces({ [KOLORS]: busy })
    await freeTryOn(garment, person, 'top', '', { token: 'hf_secret' })
    expect(tokens.get(KOLORS)).toEqual(new Set([undefined]))
    expect(tokens.get(IDM_VTON)).toEqual(new Set(['Bearer hf_secret']))
  })

  it('reports a dropped connection as such, with the service that dropped', async () => {
    const { freeTryOn } = await import('./hf')
    fakeSpaces({ [KOLORS]: { drop: true }, [IDM_VTON]: { drop: true } })
    await expect(freeTryOn(garment, person, 'top', '', {})).rejects.toThrow(
      'The connection to the free service dropped. Try again.',
    )
    fakeSpaces({ [KOLORS]: busy, [IDM_VTON]: { drop: true } })
    await expect(freeTryOn(garment, person, 'top', '', {})).rejects.toThrow(
      /^Kolors could not make it right now \(Too many users.*The backup, IDM-VTON on Hugging Face, failed too: The connection to the free service dropped\. Try again\.$/,
    )
  })

  it('says when the first service has changed, without uploading to it, and keeps the backup limit actionable', async () => {
    const { freeTryOn, SpaceError } = await import('./hf')
    const { uploaded } = fakeSpaces(
      { [IDM_VTON]: runsLimit },
      { ...CONFIGS, [KOLORS]: { dependencies: [other, other, dep(false, 3)] } },
    )
    const e = await freeTryOn(garment, person, 'top', '', {}).catch((e: unknown) => e)
    expect((e as Error).message).toMatch(
      /^Kolors has changed, and this app can no longer use it\. The backup, IDM-VTON on Hugging Face, failed too: Today's free tries/,
    )
    expect((e as InstanceType<typeof SpaceError>).quota).toBe(true)
    expect(uploaded).not.toContain(KOLORS)
  })

  it('does not blame a token that was never sent', async () => {
    const { freeTryOn } = await import('./hf')
    fakeSpaces({ [IDM_VTON]: { error: 'CUDA out of memory' } }, { ...CONFIGS, [KOLORS]: 403 })
    await expect(freeTryOn(garment, person, 'top', '', {})).rejects.toThrow(
      /^Kolors could not make it right now \(The free service answered with error 403\)\. It has no daily limit/,
    )
  })

  it('gives up on a Space whose setup never arrives, and uses the backup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { freeTryOn } = await import('./hf')
      fakeSpaces({}, { ...CONFIGS, [KOLORS]: 'hang' })
      const result = freeTryOn(garment, person, 'top', '', {})
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(await (await result).text()).toBe(IDM_VTON)
    } finally {
      vi.useRealTimers()
    }
  })

  it('downloads only the first output, and sends the token only to the Space itself', async () => {
    const { freeTryOn } = await import('./hf')
    const { downloaded, tokens } = fakeSpaces({
      [KOLORS]: busy,
      [IDM_VTON]: { data: [{ path: '/tmp/out.png', url: 'https://cdn.example.com/out.png' }, { path: '/tmp/mask.png' }] },
    })
    await freeTryOn(garment, person, 'top', '', { token: 'hf_secret' })
    expect(downloaded).toEqual(['cdn.example.com/out.png'])
    expect(tokens.get('cdn.example.com')).toEqual(new Set([undefined]))
    expect(tokens.get(IDM_VTON)).toEqual(new Set(['Bearer hf_secret']))
  })

  it('makes new models with HiDream, without the token, and falls back to FLUX.1 dev', async () => {
    const { freeModel } = await import('./hf')
    const { joined, tokens } = fakeSpaces({})
    const services = new Set<string | undefined>()
    const out = await freeModel('a model', { token: 'hf_secret', onStatus: (s) => services.add(s.service) })
    expect(await out.text()).toBe(HIDREAM_O1)
    expect(joined).toMatchObject([{ host: HIDREAM_O1, fn_index: 1, data: ['a model', '3:4', '', false, -1, 5] }])
    expect(services).toEqual(new Set(['HiDream']))
    expect(tokens.get(HIDREAM_O1)).toEqual(new Set([undefined]))

    // O1 reports failures as an HTML status pill next to an empty image.
    const pill = { data: [null, '<div class="status-pill status-error"><span></span>API error: Failed after 3 retries</div>', null] }
    fakeSpaces({ [HIDREAM_O1]: pill })
    expect(await (await freeModel('a model', {})).text()).toBe(HIDREAM_I1)

    fakeSpaces({ [HIDREAM_O1]: pill, [HIDREAM_I1]: { data: [null, 1, 'Error: No image name in successful response', null] } })
    expect(await (await freeModel('a model', {})).text()).toBe(FLUX)
  })

  it('leads with HiDream when it and FLUX.1 dev both fail', async () => {
    const { freeModel } = await import('./hf')
    fakeSpaces({
      [HIDREAM_O1]: { data: [null, '<div class="status-pill status-error">Timed out after 300s</div>', null] },
      [HIDREAM_I1]: { data: [null, 1, 'Error: Task failed', null] },
      [FLUX]: runsLimit,
    })
    await expect(freeModel('a model', {})).rejects.toThrow(
      /^HiDream could not make it right now \(Timed out after 300s\)\. It has no daily limit, so try again in a minute\. The backup, FLUX\.1 dev on Hugging Face, failed too: Today's free tries on Hugging Face are used up\./,
    )
  })

  // BiRefNet answers with one output, a before/after slider: the photo and then the cutout.
  const slider = { data: [[{ path: '/tmp/photo.png' }, { path: '/tmp/cut.png' }]] }

  it('takes the cutout, not the photo, from the online remover and sends it the token', async () => {
    const { onlineCutout } = await import('./hf')
    const { joined, downloaded, tokens } = fakeSpaces({ [BIREFNET]: slider })
    const services = new Set<string | undefined>()
    const out = await onlineCutout(garment, { token: 'hf_secret', onStatus: (s) => services.add(s.service) })
    expect(await out.text()).toBe(BIREFNET)
    expect(joined).toMatchObject([{ host: BIREFNET, fn_index: 2, data: [{ path: '/tmp/upload-0.jpg' }, '1024x1024', 'General'] }])
    expect(downloaded).toEqual([`${BIREFNET}/file=/tmp/cut.png`])
    expect(services).toEqual(new Set(['BiRefNet']))
    expect(tokens.get(BIREFNET)).toEqual(new Set(['Bearer hf_secret']))
  })

  it('says so when the online remover has no cutout or the free tries are used up', async () => {
    const { onlineCutout, SpaceError } = await import('./hf')
    fakeSpaces({ [BIREFNET]: { data: [[{ path: '/tmp/photo.png' }]] } })
    await expect(onlineCutout(garment, {})).rejects.toThrow('The free service returned no image.')

    fakeSpaces({ [BIREFNET]: runsLimit })
    const used = await onlineCutout(garment, {}).catch((e: unknown) => e)
    expect((used as InstanceType<typeof SpaceError>).quota).toBe(true)
    expect((used as Error).message).toMatch(/^Today's free tries on Hugging Face are used up\./)
  })

  it('does not upload the photo when the online remover takes other inputs now', async () => {
    const { onlineCutout } = await import('./hf')
    const { uploaded } = fakeSpaces({}, { ...CONFIGS, [BIREFNET]: { dependencies: [other, other, dep('image', 2)] } })
    await expect(onlineCutout(garment, {})).rejects.toThrow('The online remover has changed, and this app can no longer use it.')
    expect(uploaded).toEqual([])
  })
})
