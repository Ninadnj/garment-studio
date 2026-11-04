import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type Session,
  TeamError,
  checkConfig,
  createRemote,
  normalizeUrl,
  readSetupLink,
  setupLink,
  signIn,
  signOut,
} from './team'

const config = { url: 'https://abc.supabase.co', key: 'sb_publishable_123' }

type Seen = { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** Answers like Supabase; records each request. */
function fakeSupabase(answer: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const req = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    }
    seen.push(req)
    return answer(req)
  })
  return seen
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
const token = (access: string) => ({ access_token: access, refresh_token: `r-${access}`, expires_in: 3600, user: { email: 'nina@example.com' } })

afterEach(() => vi.unstubAllGlobals())

describe('team (Supabase)', () => {
  it('signs in with email and password, and says so when they are wrong', async () => {
    const seen = fakeSupabase((r) => (r.body && (r.body as { password: string }).password === 'right' ? json(token('a1')) : json({ error_description: 'Invalid login credentials' }, 400)))
    const s = await signIn(config, 'nina@example.com', 'right')
    expect(s).toMatchObject({ access: 'a1', refresh: 'r-a1', email: 'nina@example.com' })
    expect(seen[0]).toMatchObject({ url: 'https://abc.supabase.co/auth/v1/token?grant_type=password', method: 'POST' })
    expect(seen[0].headers.apikey).toBe(config.key)
    await expect(signIn(config, 'nina@example.com', 'wrong')).rejects.toThrow('Wrong email or password.')
  })

  it('renews the session before it runs out, and once more when the server says it has', async () => {
    let session: Session | undefined = { url: config.url, access: 'old', refresh: 'r-old', expiresAt: Date.now() + 30_000, email: 'n' }
    let rejectNext = false
    const seen = fakeSupabase((r) => {
      if (r.url.includes('grant_type=refresh_token')) return json(token(`new-${seen.length}`))
      if (rejectNext) {
        rejectNext = false
        return json({ message: 'JWT expired' }, 401)
      }
      return json([])
    })
    const remote = createRemote(config, { get: () => session, set: (s) => (session = s) })
    await remote.pull(undefined)
    expect(seen[0].url).toContain('grant_type=refresh_token') // under a minute left: renewed first
    expect(seen[1].headers.Authorization).toBe(`Bearer ${session!.access}`)
    rejectNext = true
    await remote.pull(undefined)
    expect(seen.slice(2).map((r) => r.url.includes('refresh_token'))).toEqual([false, true, false])
  })

  it('signs out when the session cannot be renewed', async () => {
    let session: Session | undefined = { url: config.url, access: 'old', refresh: 'r-old', expiresAt: 0, email: 'n' }
    fakeSupabase(() => json({ error_description: 'Invalid Refresh Token' }, 400))
    const remote = createRemote(config, { get: () => session, set: (s) => (session = s) })
    const e = await remote.pull(undefined).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(TeamError)
    expect((e as TeamError).signedOut).toBe(true)
    expect(session).toBeUndefined()
  })

  it('fetches changes page by page, and sends records and photos the way Supabase takes them', async () => {
    const session: Session = { url: config.url, access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000, email: 'n' }
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${from + i}`, updated_at: `2026-11-01T10:00:00.${String(from + i).padStart(6, '0')}+00:00` }))
    const seen = fakeSupabase((r) => {
      if (r.method === 'POST' && r.url.includes('/rest/v1/records')) return json([{ id: 'p1' }])
      if (r.url.includes('/rest/v1/records?')) return json(r.url.includes('or=') ? page(3, 500) : page(500, 0))
      if (r.url.includes('/storage/v1/object/authenticated/')) return new Response(new Blob(['img']))
      return new Response(null, { status: 200 })
    })
    const remote = createRemote(config, { get: () => session, set: () => {} })
    const rows = await remote.pull('2026-11-01T10:00:00.000Z')
    expect(rows).toHaveLength(503)
    expect(seen[0].url).toContain('updated_at=gt.2026-11-01T10%3A00%3A00.000Z')
    expect(seen[0].url).toContain('order=updated_at.asc,id.asc')
    // The next page continues after the last row seen, not by offset.
    expect(decodeURIComponent(seen[1].url)).toContain(
      'or=(updated_at.gt."2026-11-01T10:00:00.000499+00:00",and(updated_at.eq."2026-11-01T10:00:00.000499+00:00",id.gt.id-499))',
    )

    expect(await remote.push([{ id: 'p1', type: 'product', data: {}, changed_at: 5, deleted: false }])).toEqual(['p1'])
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: 'https://abc.supabase.co/rest/v1/records?select=id' })
    expect(seen.at(-1)!.headers.Prefer).toBe('resolution=merge-duplicates,return=representation')

    await remote.upload('garments/g1/abc.jpg', new Blob(['x'], { type: 'image/jpeg' }))
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: 'https://abc.supabase.co/storage/v1/object/photos/garments/g1/abc.jpg' })
    expect(seen.at(-1)!.headers['x-upsert']).toBe('true')
    expect(await (await remote.download('garments/g1/abc.jpg')).text()).toBe('img')
    expect(seen.at(-1)!.url).toBe('https://abc.supabase.co/storage/v1/object/authenticated/photos/garments/g1/abc.jpg')
    await remote.remove(['garments/g1/abc.jpg'])
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', body: { prefixes: ['garments/g1/abc.jpg'] } })
  })

  it('carries the project in a setup link, and tidies a pasted URL', () => {
    const link = setupLink(config, 'https://studio.example.com/')
    expect(link.startsWith('https://studio.example.com/#team=')).toBe(true)
    expect(readSetupLink(new URL(link).hash)).toEqual(config)
    expect(readSetupLink('#team=not-base64!')).toBeUndefined()
    expect(normalizeUrl(' abc.supabase.co/ ')).toBe('https://abc.supabase.co')
  })

  it('keeps the session when the project is paused or busy, and says what happened', async () => {
    let session: Session | undefined = { url: config.url, access: 'old', refresh: 'r-old', expiresAt: 0, email: 'n' }
    fakeSupabase(() => new Response(null, { status: 540 }))
    const remote = createRemote(config, { get: () => session, set: (s) => (session = s) })
    const e = await remote.pull(undefined).catch((e: unknown) => e)
    expect((e as TeamError).signedOut).toBe(false)
    expect((e as Error).message).toMatch(/paused/)
    expect(session).toBeDefined()
  })

  it('never sends a session to a project it does not belong to', async () => {
    const session: Session = { url: 'https://other.supabase.co', access: 'secret', refresh: 'r', expiresAt: Date.now() + 3_600_000, email: 'n' }
    const seen = fakeSupabase(() => json([]))
    const e = await createRemote(config, { get: () => session, set: () => {} }).pull(undefined).catch((e: unknown) => e)
    expect((e as TeamError).signedOut).toBe(true)
    expect(seen).toHaveLength(0)
  })

  it('signs out this device only, and shows sign-in problems other than a wrong password as they are', async () => {
    const seen = fakeSupabase((r) =>
      r.url.includes('logout') ? new Response(null, { status: 204 }) : json({ error_code: 'email_not_confirmed', msg: 'Email not confirmed' }, 400),
    )
    await signOut(config, { url: config.url, access: 'a', refresh: 'r', expiresAt: 0, email: 'n' })
    expect(seen[0].url).toBe('https://abc.supabase.co/auth/v1/logout?scope=local')
    await expect(signIn(config, 'nina@example.com', 'pw')).rejects.toThrow('Email not confirmed (error 400)')
  })

  it('refuses setup links and addresses that are not a Supabase project, and reports open sign-ups', async () => {
    const link = (c: object) => `#team=${btoa(JSON.stringify(c))}`
    expect(readSetupLink(link({ url: 'http://abc.supabase.co', key: 'k' }))).toBeUndefined()
    expect(readSetupLink(link({ url: 'https://attacker.example', key: 'k' }))).toBeUndefined()
    expect(readSetupLink(link({ url: '', key: '' }))).toBeUndefined()
    await expect(checkConfig({ url: 'https://attacker.example', key: 'k' })).rejects.toThrow(/not a Supabase project/)
    fakeSupabase(() => json({ disable_signup: false }))
    expect(await checkConfig(config)).toEqual({ signupOpen: true })
  })
})
