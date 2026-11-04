// Minimal IndexedDB store for garments, products, saved models and try-on results (blobs stay on the device).
import type { Adjust } from './adjust'
import type { GarmentKind } from './hf'
import type { Remover } from './settings'

export interface GarmentRec {
  id: string
  createdAt: number
  photo: Blob // working photo, ≤ 2048 px
  raw?: Blob // the decoded upload, kept when `photo` is the photo cropped out of a phone screenshot
  thumb?: Blob // small preview for the photo strip
  removeBg: boolean
  remover: Remover
  autoCut?: Blob // background remover result
  editedCut?: Blob // hand-edited cutout; replaces autoCut
  adjust?: Adjust
  kind?: GarmentKind // for the free try-on, which sends each kind to a different service; top when unset
  productId?: string // the product this photo shows
  updatedAt?: number // last change; team sync keeps the newer of two versions
}

export type ProductStatus = 'draft' | 'for_sale' | 'reserved' | 'sold'
export type Audience = 'women' | 'men' | 'unisex' | 'kids'
export type SizeSystem = 'letter' | 'eu' | 'it' | 'fr' | 'uk' | 'us' | 'kids' | 'one'

export interface SizeStock {
  size: string // as written by the seller: S, 38, 38 EU, One size…
  stock: number
}

/** One item for sale. Its photos are the garments whose `productId` points here. */
export interface ProductRec {
  id: string
  createdAt: number
  updatedAt: number // every change; later used to merge edits from other devices
  name: string
  code: string // the shop's own code (SKU)
  price?: number // in the currency from Settings
  salePrice?: number // reduced price; `price` stays the regular one
  status: ProductStatus
  reservedFor?: string // name, @handle or phone, while reserved
  reservedUntil?: string // YYYY-MM-DD
  soldAt?: number // set when it becomes sold
  postedOn?: string[] // where it is listed: Instagram, Facebook…
  audience?: Audience
  sizeSystem?: SizeSystem // what numbers mean; letter sizes when unset
  sizes: SizeStock[]
  colours: string[]
  category: string
  brand: string
  condition: string
  material: string
  measurements: string // free text, e.g. "Chest 52 cm, length 70 cm"
  notes: string
  coverId?: string // photo shown in the catalogue; the oldest linked photo when unset
}

export interface ModelRec {
  id: string
  image: Blob
  createdAt: number
  source: 'ai' | 'upload'
  prompt?: string
}

export interface LookRec {
  id: string
  image: Blob // raw try-on output
  cutout?: Blob // person cut out locally, used to swap the background colour
  createdAt: number
  modelId?: string
  productId?: string // set when the garment photo belonged to a product
  note?: string
}

type Stores = { garments: GarmentRec; models: ModelRec; looks: LookRec; products: ProductRec }
export type StoreName = keyof Stores

// 'blocked': another window still has the old version open, so the upgrade waits; 'stale': a newer version
// of the app took over the database in another window. Either way this window must reload before saving.
export type DbState = 'ok' | 'blocked' | 'stale'
let state: DbState = 'ok'
const stateListeners = new Set<(s: DbState) => void>()
const setState = (s: DbState) => {
  state = s
  stateListeners.forEach((f) => f(s))
}
export function onDbState(f: (s: DbState) => void) {
  stateListeners.add(f)
  f(state)
  return () => void stateListeners.delete(f)
}

// Writes that are still waiting (typing is saved shortly after the last key), saved before stepping aside.
const flushers = new Set<() => void>()
export function onBeforeClose(flush: () => void) {
  flushers.add(flush)
  return () => void flushers.delete(flush)
}

// Failed saves are shown, not only logged.
const errorListeners = new Set<(e: unknown) => void>()
export function onWriteError(f: (e: unknown) => void) {
  errorListeners.add(f)
  return () => void errorListeners.delete(f)
}
export const reportWriteError = (e: unknown) => {
  console.error(e)
  errorListeners.forEach((f) => f(e))
}

// Other windows of the app (a tab and the installed app share this database) re-read what changed here.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('garment-studio')
const changeListeners = new Set<(store: StoreName) => void>()
export function onOtherWindowChange(f: (store: StoreName) => void) {
  changeListeners.add(f)
  return () => void changeListeners.delete(f)
}
if (channel) channel.onmessage = (e) => changeListeners.forEach((f) => f((e.data as { store: StoreName }).store))
const announce = (store: StoreName) => channel?.postMessage({ store })

// Changes made on this device, for team sync to upload. Its own writes (changes from the team) are quiet.
const writeListeners = new Set<(store: StoreName, id: string) => void>()
export function onLocalWrite(f: (store: StoreName, id: string) => void) {
  writeListeners.add(f)
  return () => void writeListeners.delete(f)
}

/** Records were written by something other than the lists (team sync): this window and the others re-read. */
export function storeChanged(store: StoreName) {
  changeListeners.forEach((f) => f(store))
  announce(store)
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('garment-studio', 3)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of ['models', 'looks', 'garments', 'products'])
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
    }
    req.onblocked = () => setState('blocked')
    req.onsuccess = () => {
      const db = req.result
      if (state === 'blocked') setState('ok')
      // A newer version of the app opened the database in another window: save what is waiting, then step aside.
      db.onversionchange = () => {
        flushers.forEach((f) => f())
        db.close()
        setState('stale')
      }
      resolve(db)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function listAll<S extends StoreName>(store: S): Promise<Stores[S][]> {
  const rows = await tx<Stores[S][]>(store, 'readonly', (s) => s.getAll())
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export const getRec = <S extends StoreName>(store: S, id: string) =>
  tx<Stores[S] | undefined>(store, 'readonly', (s) => s.get(id))

export async function putRec<S extends StoreName>(store: S, rec: Stores[S], quiet = false) {
  if (state === 'stale') throw new Error('A newer version of the app is open in another window.')
  await tx(store, 'readwrite', (s) => s.put(rec))
  announce(store)
  if (!quiet) writeListeners.forEach((f) => f(store, rec.id))
}

export async function deleteRec(store: StoreName, id: string, quiet = false) {
  if (state === 'stale') throw new Error('A newer version of the app is open in another window.')
  await tx(store, 'readwrite', (s) => s.delete(id))
  announce(store)
  if (!quiet) writeListeners.forEach((f) => f(store, id))
}

/** Ask the browser not to evict our data (iOS clears non-persistent storage under pressure). */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {})
}
