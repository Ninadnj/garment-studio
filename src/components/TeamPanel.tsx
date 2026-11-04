import { useEffect, useState } from 'react'
import {
  type TeamConfig,
  TeamError,
  checkConfig,
  hostOf,
  loadConfig,
  loadSession,
  normalizeUrl,
  saveConfig,
  saveSession,
  setupLink,
  signIn,
  signOut,
} from '../lib/team'
import { resetSyncState, teamSync, useSyncStatus } from '../lib/teamSync'
import { useToast } from './Toast'
import { Field, Spinner } from './ui'

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Settings → Team: connect to the team's Supabase project, sign in, and see how syncing goes. */
export function TeamPanel() {
  const toast = useToast()
  const status = useSyncStatus()
  const [config, setConfig] = useState<TeamConfig | undefined>(loadConfig)
  const [session, setSession] = useState(loadSession)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signupOpen, setSignupOpen] = useState(false)

  // Anyone could create an account (and see the catalogue) while sign-ups are on: say so.
  useEffect(() => {
    if (config)
      checkConfig(config)
        .then((r) => setSignupOpen(r.signupOpen))
        .catch(() => {})
  }, [config?.url, config?.key])

  // Sync can end the session (it expired and couldn't be renewed); a setup link can connect from outside.
  useEffect(() => {
    setSession(loadSession())
    setConfig(loadConfig())
  }, [status.phase])

  async function attempt(f: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await f()
    } catch (e) {
      setError(e instanceof TeamError ? e.message : `Something went wrong: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const connect = () =>
    attempt(async () => {
      const c = { url: normalizeUrl(url), key: key.trim() }
      const { signupOpen } = await checkConfig(c)
      if (c.url !== config?.url) {
        saveSession(undefined)
        resetSyncState()
      }
      saveConfig(c)
      setConfig(c)
      setSignupOpen(signupOpen)
      teamSync.setStatus({ phase: 'signed-out' })
    })

  const login = () =>
    attempt(async () => {
      const s = await signIn(config!, email.trim(), password)
      saveSession(s)
      setSession(s)
      setPassword('')
      // Everything shared that is on this device goes up; then the team's catalogue comes down.
      await teamSync.queueAll()
      teamSync.run()
    })

  async function logout() {
    if (session && config) await signOut(config, session)
    saveSession(undefined)
    setSession(undefined)
    teamSync.setStatus({ phase: 'signed-out', error: undefined })
  }

  function disconnect() {
    if (!confirm('Disconnect from the team? Products stay on this device; changes made from now on are not shared.')) return
    saveSession(undefined)
    saveConfig(undefined)
    resetSyncState()
    setSession(undefined)
    setConfig(undefined)
    teamSync.setStatus({ phase: 'off', error: undefined })
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(setupLink(config!, `${location.origin}${location.pathname}`))
      toast({ text: 'Link copied. Teammates open it, then sign in with their own account.' })
    } catch {
      toast({ text: 'Copying is not allowed here.', error: true })
    }
  }

  if (!config)
    return (
      <div className="panel">
        <h2>Team</h2>
        <p className="muted small">
          Share products, their photos and their try-on results with your team through a free Supabase project. The
          README has the setup steps. Or open the setup link a teammate sent you.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            connect()
          }}
        >
          <Field label="Project URL">
            <input
              className="input"
              aria-label="Project URL"
              placeholder="https://….supabase.co"
              autoComplete="off"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="Publishable key" hint="Project Settings → API Keys → publishable (anon) key. Never the secret key.">
            <input
              className="input"
              aria-label="Publishable key"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          {error && <p className="error">{error}</p>}
          <button className="btn" disabled={busy || !url.trim() || !key.trim()}>
            {busy && <Spinner />} Connect
          </button>
        </form>
      </div>
    )

  if (!session)
    return (
      <div className="panel">
        <h2>Team</h2>
        <p className="muted small">
          Connected to {hostOf(config.url)}. Sign in with the account made for you in the project’s Authentication
          page.
        </p>
        {signupOpen && <SignupWarning />}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            login()
          }}
        >
          <Field label="Email">
            <input
              className="input"
              type="email"
              aria-label="Email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <input
              className="input"
              type="password"
              aria-label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="btn" disabled={busy || !email.trim() || !password}>
              {busy && <Spinner />} Sign in
            </button>
            <span className="spacer" />
            <button type="button" className="btn-text" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </form>
      </div>
    )

  const line =
    status.phase === 'syncing'
      ? 'Syncing…'
      : status.phase === 'error'
        ? `Not synced: ${status.error}`
        : status.lastSync
          ? `Synced at ${time(status.lastSync)}`
          : 'Not synced yet'

  return (
    <div className="panel">
      <h2>Team</h2>
      <p className="small">
        Signed in as <strong>{session.email}</strong> on {hostOf(config.url)}.
      </p>
      {signupOpen && <SignupWarning />}
      <p className={`small ${status.phase === 'error' ? 'error' : 'muted'}`} role="status">
        {status.phase === 'syncing' && <Spinner />} {line}
        {status.pending > 0 && ` · ${status.pending} change${status.pending === 1 ? '' : 's'} waiting`}
      </p>
      <p className="muted small">
        Shared: products, the photos in them and their try-on results. Models and other photos stay on this
        device.
      </p>
      <div className="row">
        <button className="btn-secondary" onClick={() => teamSync.run()} disabled={status.phase === 'syncing'}>
          Sync now
        </button>
        <button className="btn-secondary" onClick={copyLink}>
          Copy link for your team
        </button>
        <span className="spacer" />
        <button className="btn-text" onClick={logout}>
          Sign out
        </button>
        <button className="btn-text" onClick={disconnect}>
          Disconnect
        </button>
      </div>
    </div>
  )
}

function SignupWarning() {
  return (
    <p className="error small" role="alert">
      New sign-ups are allowed on this project: anyone with the project address could create an account and see
      the catalogue. In Supabase, turn off “Allow new users to sign up” under Authentication → Sign In / Providers.
    </p>
  )
}
