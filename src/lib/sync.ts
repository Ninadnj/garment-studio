// Team sync: products, the photos that belong to them, and their try-on results, shared through the team's
// Supabase project (see team.ts). Every change made here is queued; a sync uploads the queue, then fetches
// what changed elsewhere. Of two versions of a record, the one changed later wins: the database refuses an
// older one, and a refused upload fetches the team's version instead. Photos are files named by their
// content, so an unchanged photo is never sent twice; sync never deletes them, because another device's
// version may still use one. Cutouts are not shared: each device makes its own. Models and photos outside a
// product stay on the device.

import type { GarmentRec, LookRec, ProductRec, StoreName } from './db'
import { type Remote, type Row, TeamError } from './team'

type Type = Row['type']
type SyncedStore = 'products' | 'garments' | 'looks'
type Rec = ProductRec | GarmentRec | LookRec

const STORE: Record<Type, SyncedStore> = { product: 'products', garment: 'garments', look: 'looks' }
const TYPE_OF: Record<SyncedStore, Type> = { products: 'product', garments: 'garment', looks: 'look' }
const isSynced = (store: StoreName): store is SyncedStore => store in TYPE_OF

export interface SyncState {
  cursor?: string // server time of the newest change fetched, exactly as the server wrote it
  synced: Record<string, string[]> // `type:id` → its photos in the team's storage; present = known to the team
  retry: string[] // `type:id` of changes that could not be applied (a photo didn't download): fetched again
}

/** This device's records, as sync needs them; writes made through it are not queued again. */
export interface Local {
  get(store: SyncedStore, id: string): Promise<Rec | undefined>
  put(store: SyncedStore, rec: Rec): Promise<void>
  remove(store: SyncedStore, id: string): Promise<void>
  all(store: SyncedStore): Promise<Rec[]>
  thumb(shown: Blob, cutout: boolean): Promise<Blob | undefined>
  changed(stores: Set<SyncedStore>): void
}

/**
 * Where sync keeps its state. The waiting changes are one entry each, since any window may add one while
 * another syncs; the rest is written only by the window that syncs.
 */
export interface StateStore {
  load(): SyncState
  save(s: SyncState): void
  outbox: {
    all(): Record<string, number> // `type:id` → when it changed here
    set(k: string, at: number): void
    clear(k: string, at: number): void // only if it hasn't changed again since `at`
  }
}

export type SyncPhase = 'off' | 'signed-out' | 'syncing' | 'synced' | 'error'
export interface SyncStatus {
  phase: SyncPhase
  pending: number // changes waiting to be uploaded
  lastSync?: number
  error?: string
}

// Rows changed while a fetch ran can carry a slightly earlier server time; fetching a little further back
// catches them (applying a row twice changes nothing).
const OVERLAP = 10_000

const key = (type: Type, id: string) => `${type}:${id}`
const split = (k: string) => {
  const i = k.indexOf(':')
  return [k.slice(0, i) as Type, k.slice(i + 1)] as const
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** Storage path named by the photo's content: the same photo always gets the same path. */
export async function photoPath(type: Type, id: string, blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${type}s/${id}/${hex.slice(0, 24)}.${EXT[blob.type] ?? 'bin'}`
}

/** When a record was last changed here: newer wins against the team's version. */
function changedAt(type: Type, rec: Rec) {
  if (type === 'product') return (rec as ProductRec).updatedAt
  if (type === 'garment') return (rec as GarmentRec).updatedAt ?? rec.createdAt
  return rec.createdAt // try-on results don't change
}

/** Whether a record is shared with the team: every product, and photos and results of a product. */
const shared = (type: Type, rec: Rec | undefined) =>
  !!rec && (type === 'product' || !!(rec as GarmentRec | LookRec).productId)

/** The record as the team stores it: data without the image blobs, plus the photos to upload. */
async function toRow(type: Type, rec: Rec): Promise<{ data: Record<string, unknown>; files: [string, Blob][] }> {
  if (type === 'product') return { data: { ...(rec as ProductRec) }, files: [] }
  if (type === 'garment') {
    const g = rec as GarmentRec
    const photo = await photoPath('garment', g.id, g.photo)
    const cut = g.editedCut && (await photoPath('garment', g.id, g.editedCut))
    const files: [string, Blob][] = [[photo, g.photo]]
    if (cut && g.editedCut) files.push([cut, g.editedCut])
    const { id, createdAt, updatedAt, removeBg, remover, adjust, kind, productId } = g
    return { data: { id, createdAt, updatedAt, removeBg, remover, adjust, kind, productId, photo, cut }, files }
  }
  const l = rec as LookRec
  const image = await photoPath('look', l.id, l.image)
  const { id, createdAt, modelId, productId, note } = l
  return { data: { id, createdAt, modelId, productId, note, image }, files: [[image, l.image]] }
}

export function createSync({
  local,
  state,
  remote,
}: {
  local: Local
  state: StateStore
  remote: () => Remote | undefined // undefined: not connected or not signed in
}) {
  let status: SyncStatus = { phase: 'off', pending: 0 }
  const listeners = new Set<(s: SyncStatus) => void>()
  const pending = () => Object.keys(state.outbox.all()).length
  const setStatus = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch, pending: pending() }
    listeners.forEach((f) => f(status))
  }

  function mutate(f: (s: SyncState) => void) {
    const s = state.load()
    f(s)
    state.save(s)
  }

  /** A record changed here: upload it on the next sync. */
  function queue(store: StoreName, id: string, at = Date.now()) {
    if (!isSynced(store)) return
    state.outbox.set(key(TYPE_OF[store], id), at)
    setStatus({}) // the waiting count changed
  }

  /** Queues everything the team should have, e.g. after signing in for the first time on this device. */
  async function queueAll() {
    const waiting = state.outbox.all()
    for (const store of ['products', 'garments', 'looks'] as const) {
      const type = TYPE_OF[store]
      for (const r of await local.all(store))
        if (shared(type, r) && waiting[key(type, r.id)] === undefined) state.outbox.set(key(type, r.id), changedAt(type, r))
    }
    setStatus({})
  }

  /** The record a row describes, reusing photos this device already has (the same content, the same name). */
  async function fromRow(row: Row, existing: Rec | undefined, r: Remote): Promise<{ rec: Rec; paths: string[] }> {
    const d = row.data as Record<string, never>
    const fetchOr = async (path: string, have: Blob | undefined) =>
      have && (await photoPath(row.type, row.id, have)) === path ? have : r.download(path)
    if (row.type === 'product') return { rec: { ...(d as unknown as ProductRec), id: row.id }, paths: [] }
    if (row.type === 'garment') {
      const prev = existing as GarmentRec | undefined
      const photo = await fetchOr(d.photo, prev?.photo)
      const cut = d.cut ? await fetchOr(d.cut, prev?.editedCut) : undefined
      const same = prev && photo === prev.photo
      // This device's own cutout stays only for the same photo cut out the same way; otherwise it is made
      // again here, with the method the team chose.
      const autoCut = same && prev.remover === d.remover ? prev.autoCut : undefined
      // What this device shows for the record (shownCut in garments.ts), the photo until a cutout exists.
      const shown = (d.removeBg ? (cut ?? autoCut) : photo) ?? photo
      const prevShown = prev && ((prev.removeBg ? (prev.editedCut ?? prev.autoCut) : prev.photo) ?? prev.photo)
      const rec: GarmentRec = {
        ...prev,
        id: row.id,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        removeBg: d.removeBg,
        remover: d.remover,
        adjust: d.adjust,
        kind: d.kind,
        productId: d.productId,
        photo,
        editedCut: cut,
        autoCut,
        // A hand fix or an online cutout from the team changes the picture without changing the photo.
        thumb: prev && shown === prevShown ? prev.thumb : await local.thumb(shown, shown !== photo),
      }
      return { rec, paths: [d.photo, d.cut].filter(Boolean) }
    }
    const prev = existing as LookRec | undefined
    const image = await fetchOr(d.image, prev?.image)
    const rec: LookRec = {
      id: row.id,
      createdAt: d.createdAt,
      modelId: d.modelId,
      productId: d.productId,
      note: d.note,
      image,
      cutout: prev && image === prev.image ? prev.cutout : undefined,
    }
    return { rec, paths: [d.image] }
  }

  /** Applies the team's version of a record here, unless this device has a later change of its own. */
  async function apply(r: Remote, row: Row, touched: Set<SyncedStore>) {
    const store = STORE[row.type]
    if (!store) return
    const k = key(row.type, row.id)
    const waiting = state.outbox.all()[k]
    const existing = await local.get(store, row.id)
    const changedHere = () => (existing ? changedAt(row.type, existing) : waiting)
    if (waiting !== undefined && changedHere()! > row.changed_at) return // goes up on the next sync instead

    if (row.deleted) {
      // The team no longer shares it. A copy that isn't shared here either (a photo taken out of its product
      // on this device) is this device's own and stays.
      if (shared(row.type, existing)) {
        await local.remove(store, row.id)
        touched.add(store)
      }
      mutate((s) => delete s.synced[k])
      if (waiting !== undefined) state.outbox.clear(k, waiting)
      return
    }
    if (existing && changedAt(row.type, existing) === row.changed_at && state.load().synced[k]) return // have it

    const { rec, paths } = await fromRow(row, existing, r) // downloads can take a while…
    // …and the record may have been changed here meanwhile: then that change is the newer one.
    if (state.outbox.all()[k] !== waiting) return
    const now = await local.get(store, row.id)
    if (now && existing && changedAt(row.type, now) !== changedAt(row.type, existing)) return
    await local.put(store, rec)
    touched.add(store)
    mutate((s) => (s.synced[k] = paths))
    if (waiting !== undefined) state.outbox.clear(k, waiting)
  }

  async function pushOne(r: Remote, k: string, at: number, touched: Set<SyncedStore>) {
    const [type, id] = split(k)
    const store = STORE[type]
    if (!store) return state.outbox.clear(k, at)
    const rec = await local.get(store, id)
    const known = state.load().synced[k]
    let row: Row
    let paths: string[] = []
    if (shared(type, rec)) {
      const { data, files } = await toRow(type, rec!)
      for (const [path, blob] of files) if (!known?.includes(path)) await r.upload(path, blob)
      row = { id, type, data, changed_at: changedAt(type, rec!), deleted: false }
      paths = files.map(([p]) => p)
    } else if (known) {
      // Deleted here, or no longer part of a product: the team drops it too.
      row = { id, type, data: {}, changed_at: at, deleted: true }
    } else return state.outbox.clear(k, at) // never shared: nothing to tell the team

    const written = await r.push([row])
    state.outbox.clear(k, at)
    if (written.includes(id)) mutate((s) => (row.deleted ? delete s.synced[k] : (s.synced[k] = paths)))
    else {
      // The team has a later version: take it.
      const [winner] = await r.get([id])
      if (winner) await apply(r, winner, touched)
    }
  }

  /** Fetches the team's changes; returns how many could not be applied yet (tried again next time). */
  async function pull(r: Remote, touched: Set<SyncedStore>) {
    const s = state.load()
    const since = s.cursor ? new Date(Date.parse(s.cursor) - OVERLAP).toISOString() : undefined
    const rows = await r.pull(since)
    const again = s.retry.length ? await r.get(s.retry.map((k) => split(k)[1])) : []
    const failed: string[] = []
    for (const row of [...again, ...rows])
      try {
        await apply(r, row, touched)
      } catch (e) {
        if (e instanceof TeamError && e.signedOut) throw e
        failed.push(key(row.type, row.id))
      }
    const newest = rows.reduce<string | undefined>((m, row) => (row.updated_at && (!m || row.updated_at > m) ? row.updated_at : m), s.cursor)
    mutate((st) => {
      st.cursor = newest
      st.retry = [...new Set(failed)]
    })
    return failed.length
  }

  let running: Promise<void> | null = null
  let again = false

  /** Uploads what is waiting, then fetches the team's changes. One window at a time does this. */
  function run(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        const r = remote()
        if (!r) return
        const work = async () => {
          setStatus({ phase: 'syncing', error: undefined })
          const touched = new Set<SyncedStore>()
          try {
            for (const [k, at] of Object.entries(state.outbox.all())) await pushOne(r, k, at, touched)
            const failed = await pull(r, touched)
            setStatus({
              phase: 'synced',
              lastSync: Date.now(),
              error: failed
                ? `${failed} change${failed === 1 ? '' : 's'} from the team could not be downloaded yet; trying again on the next sync.`
                : undefined,
            })
          } catch (e) {
            if (e instanceof TeamError && e.signedOut) setStatus({ phase: 'signed-out', error: e.message })
            else setStatus({ phase: 'error', error: (e as Error).message })
          } finally {
            // Whatever was applied shows, even when the sync stopped partway.
            if (touched.size) local.changed(touched)
          }
        }
        const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
        if (locks) await locks.request('garment-studio-sync', { ifAvailable: true }, (lock) => (lock ? work() : undefined))
        else await work()
      } while (again)
    })().finally(() => {
      running = null
    })
    return running
  }

  return {
    queue,
    queueAll,
    run,
    /** Resolves when no sync is running in this window (e.g. before clearing its state). */
    idle: (): Promise<void> => running ?? Promise.resolve(),
    status: () => ({ ...status, pending: pending() }),
    setStatus,
    onStatus(f: (s: SyncStatus) => void) {
      listeners.add(f)
      f({ ...status, pending: pending() })
      return () => void listeners.delete(f)
    },
  }
}

export type Sync = ReturnType<typeof createSync>
