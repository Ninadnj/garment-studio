// The app's team sync: sync.ts working on this device's IndexedDB and the Supabase project from Settings.
import { useEffect, useState } from 'react'
import { thumbnail } from './compose'
import { deleteRec, getRec, listAll, onLocalWrite, putRec, storeChanged } from './db'
import { type StateStore, type SyncState, type SyncStatus, createSync } from './sync'
import { createRemote, loadConfig, loadSession, saveSession } from './team'

const STATE_KEY = 'gs.sync'
const OUT = 'gs.sync.out:' // one entry per waiting change, so windows never overwrite each other's
const empty = (): SyncState => ({ synced: {}, retry: [] })

const state: StateStore = {
  load() {
    try {
      return { ...empty(), ...JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') }
    } catch {
      return empty()
    }
  },
  save({ cursor, synced, retry }) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ cursor, synced, retry }))
    } catch {
      // Storage full: the next sync starts over from what the team has.
    }
  },
  outbox: {
    all() {
      const out: Record<string, number> = {}
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (k?.startsWith(OUT)) out[k.slice(OUT.length)] = Number(localStorage.getItem(k))
        }
      } catch {}
      return out
    },
    set(k, at) {
      try {
        localStorage.setItem(OUT + k, String(at))
      } catch {}
    },
    clear(k, at) {
      try {
        if (Number(localStorage.getItem(OUT + k)) === at) localStorage.removeItem(OUT + k)
      } catch {}
    },
  },
}

export const teamSync = createSync({
  local: {
    get: (store, id) => getRec(store, id),
    put: (store, rec) => putRec(store, rec as never, true),
    remove: (store, id) => deleteRec(store, id, true),
    all: (store) => listAll(store),
    thumb: (shown, cutout) => thumbnail(shown, cutout).catch(() => undefined),
    changed: (stores) => stores.forEach(storeChanged),
  },
  state,
  remote: () => {
    const c = loadConfig()
    return c && loadSession() ? createRemote(c, { get: loadSession, set: saveSession }) : undefined
  },
})

/** Forgets what was fetched and what waits to be uploaded, e.g. when connecting to another project. */
export function resetSyncState() {
  state.save(empty())
  for (const k of Object.keys(state.outbox.all()))
    try {
      localStorage.removeItem(OUT + k)
    } catch {}
}

/** The phase to show when no sync is running: off without a project, signed out without a session. */
export const restingPhase = () => (!loadConfig() ? 'off' : !loadSession() ? 'signed-out' : undefined)

/** Queues every change made here and syncs shortly after the last one, every 30 s, and on coming back online. */
export function startTeamSync() {
  let timer = 0
  const soon = (ms: number) => {
    clearTimeout(timer)
    timer = window.setTimeout(() => teamSync.run(), ms)
  }
  const offWrite = onLocalWrite((store, id) => {
    if (!loadConfig()) return // not connected: nothing to queue (connecting uploads everything)
    teamSync.queue(store, id)
    soon(2000)
  })
  const wake = () => {
    if (document.visibilityState === 'visible') teamSync.run()
  }
  const tick = window.setInterval(wake, 30_000)
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', wake)
  const phase = restingPhase()
  if (phase) teamSync.setStatus({ phase })
  else teamSync.run()
  return () => {
    offWrite()
    clearTimeout(timer)
    clearInterval(tick)
    window.removeEventListener('online', wake)
    document.removeEventListener('visibilitychange', wake)
  }
}

export function useSyncStatus() {
  const [status, setStatus] = useState<SyncStatus>(teamSync.status)
  useEffect(() => teamSync.onStatus(setStatus), [])
  return status
}
