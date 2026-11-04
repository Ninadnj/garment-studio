// The team's shared catalogue on Supabase, through its plain HTTP API (no client library): sign-in, records
// and photos. Setup: supabase/setup.sql and the README. The project URL and the publishable key are public by
// design; what a signed-in user may do is decided by the database's row-level security.

export interface TeamConfig {
  url: string // https://<project>.supabase.co
  key: string // publishable ("anon") key
}

export interface Session {
  url: string // the project it belongs to: never sent anywhere else
  access: string
  refresh: string
  expiresAt: number // ms
  email: string
}

/** A record as stored in the shared table (see supabase/setup.sql). */
export interface Row {
  id: string
  type: 'product' | 'garment' | 'look'
  data: Record<string, unknown>
  changed_at: number
  deleted: boolean
  updated_at?: string // set by the server
}

export class TeamError extends Error {
  constructor(
    message: string,
    readonly signedOut = false, // the session is no longer valid: sign in again
  ) {
    super(message)
  }
}

const CONFIG_KEY = 'gs.team'
const SESSION_KEY = 'gs.teamSession'

function read<T>(key: string): T | undefined {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: the team connection lasts until the page closes.
  }
}

export const loadConfig = () => read<TeamConfig>(CONFIG_KEY)
export const saveConfig = (c?: TeamConfig) => write(CONFIG_KEY, c)
/** The session, only if it belongs to the connected project. */
export const loadSession = () => {
  const s = read<Session>(SESSION_KEY)
  return s && s.url === loadConfig()?.url ? s : undefined
}
export const saveSession = (s?: Session) => write(SESSION_KEY, s)

/** "https://abc.supabase.co/" or "abc.supabase.co" → "https://abc.supabase.co". */
export function normalizeUrl(url: string) {
  const u = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(u) ? u : `https://${u}`
}

/** A Supabase project address (https://<project>.supabase.co); anything else is refused. */
export function isProjectUrl(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname) && (u.pathname === '/' || u.pathname === '')
  } catch {
    return false
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// A link teammates open to connect the app to the same project (they still sign in with their own account).
export const setupLink = (c: TeamConfig, base: string) =>
  `${base}#team=${btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`

export function readSetupLink(hash: string): TeamConfig | undefined {
  const m = hash.match(/[#&]team=([\w-]+)/)
  if (!m) return undefined
  try {
    const c = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof c?.url !== 'string' || typeof c?.key !== 'string' || !c.key.trim()) return undefined
    const url = normalizeUrl(c.url)
    return isProjectUrl(url) ? { url, key: c.key.trim() } : undefined
  } catch {
    return undefined
  }
}

async function call(url: string, init: RequestInit) {
  try {
    return await fetch(url, init)
  } catch {
    throw new TeamError('Could not reach Supabase. Check your connection.')
  }
}

const PAUSED = 'The team’s Supabase project is paused (free projects pause after a week without use). Restore it in the Supabase dashboard.'

async function failure(res: Response) {
  if (res.status === 540) return PAUSED
  let text = ''
  try {
    const body = await res.json()
    text = body.error_description ?? body.msg ?? body.message ?? body.error ?? ''
  } catch {}
  return text ? `${text} (error ${res.status})` : `Supabase answered with error ${res.status}.`
}

function toSession(
  url: string,
  body: { access_token: string; refresh_token: string; expires_in: number; user?: { email?: string } },
  email: string,
): Session {
  return {
    url,
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    email: body.user?.email ?? email,
  }
}

/**
 * Checks that the URL and key belong to a Supabase project. Returns whether anyone may still create an
 * account there: then anyone with the setup link could sign up and see the catalogue.
 */
export async function checkConfig(c: TeamConfig): Promise<{ signupOpen: boolean }> {
  if (!isProjectUrl(c.url)) throw new TeamError('That is not a Supabase project address (https://….supabase.co).')
  const res = await call(`${c.url}/auth/v1/settings`, { headers: { apikey: c.key } })
  if (res.status === 401 || res.status === 403) throw new TeamError('The key does not belong to this project.')
  if (!res.ok) throw new TeamError(await failure(res))
  const body = await res.json().catch(() => ({}))
  return { signupOpen: body?.disable_signup === false }
}

export async function signIn(c: TeamConfig, email: string, password: string): Promise<Session> {
  const res = await call(`${c.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = await res
      .clone()
      .json()
      .catch(() => ({}))
    if (body?.error_code === 'invalid_credentials' || (res.status === 400 && !body?.error_code))
      throw new TeamError('Wrong email or password.')
    throw new TeamError(await failure(res))
  }
  return toSession(c.url, await res.json(), email)
}

/** Signs this device out (other devices of the same account stay signed in). */
export async function signOut(c: TeamConfig, s: Session) {
  await call(`${c.url}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: { apikey: c.key, Authorization: `Bearer ${s.access}` },
  }).catch(() => {})
}

export interface Remote {
  pull(since: string | undefined): Promise<Row[]>
  get(ids: string[]): Promise<Row[]>
  /** Upserts; returns the ids the database accepted (it refuses a version older than the one it has). */
  push(rows: Row[]): Promise<string[]>
  upload(path: string, blob: Blob): Promise<void>
  download(path: string): Promise<Blob>
  remove(paths: string[]): Promise<void>
}

const PAGE = 500
const BUCKET = 'photos'
const COLUMNS = 'id,type,data,changed_at,deleted,updated_at'

/**
 * The team's records and photos, with the session kept fresh (renewed shortly before it expires, and once
 * more when the server says it has).
 */
export function createRemote(c: TeamConfig, session: { get: () => Session | undefined; set: (s?: Session) => void }): Remote {
  async function renew(s: Session) {
    const res = await call(`${c.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh }),
    })
    // Only a refused session ends it; a paused project, a rate limit or an outage is tried again later.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      session.set(undefined)
      throw new TeamError('Signed out: sign in again in Settings.', true)
    }
    if (!res.ok) throw new TeamError(await failure(res))
    const next = toSession(c.url, await res.json(), s.email)
    session.set(next)
    return next
  }

  async function authed(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    let s = session.get()
    if (!s || s.url !== c.url) throw new TeamError('Not signed in.', true)
    if (s.expiresAt - Date.now() < 60_000) s = await renew(s)
    const res = await call(`${c.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), apikey: c.key, Authorization: `Bearer ${s.access}` },
    })
    if (res.status === 401 && !retried) {
      await renew(s)
      return authed(path, init, true)
    }
    if (!res.ok) throw new TeamError(await failure(res))
    return res
  }

  return {
    async pull(since) {
      // Pages continue after the last row seen (not by offset), so a row edited meanwhile moves to a later
      // page instead of pushing another row out of view.
      const rows: Row[] = []
      let last: Row | undefined
      for (;;) {
        const filter = last
          ? `&or=${encodeURIComponent(`(updated_at.gt."${last.updated_at}",and(updated_at.eq."${last.updated_at}",id.gt.${last.id}))`)}`
          : since
            ? `&updated_at=gt.${encodeURIComponent(since)}`
            : ''
        const res = await authed(`/rest/v1/records?select=${COLUMNS}${filter}&order=updated_at.asc,id.asc&limit=${PAGE}`)
        const page = (await res.json()) as Row[]
        rows.push(...page)
        if (page.length < PAGE) return rows
        last = page[page.length - 1]
      }
    },
    async get(ids) {
      const rows: Row[] = []
      for (let i = 0; i < ids.length; i += 100) {
        const res = await authed(`/rest/v1/records?select=${COLUMNS}&id=in.(${ids.slice(i, i + 100).join(',')})`)
        rows.push(...((await res.json()) as Row[]))
      }
      return rows
    },
    async push(rows) {
      if (!rows.length) return []
      const res = await authed('/rest/v1/records?select=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows),
      })
      return ((await res.json()) as { id: string }[]).map((r) => r.id)
    },
    async upload(path, blob) {
      await authed(`/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' },
        body: blob,
      })
    },
    async download(path) {
      return (await authed(`/storage/v1/object/authenticated/${BUCKET}/${path}`)).blob()
    },
    async remove(paths) {
      if (!paths.length) return
      await authed(`/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      })
    },
  }
}
