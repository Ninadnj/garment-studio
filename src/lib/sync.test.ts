import { describe, expect, it } from 'vitest'
import type { GarmentRec, LookRec, ProductRec } from './db'
import { sharesChange } from './garments'
import { type Local, type SyncState, createSync } from './sync'
import { type Remote, type Row, TeamError } from './team'

/** A stand-in for the team's Supabase project: the records table (with its newer-wins rule) and the photos. */
function fakeServer() {
  const rows = new Map<string, Row>()
  const files = new Map<string, Blob>()
  const log = { uploads: [] as string[], downloads: [] as string[], removed: [] as string[] }
  let clock = Date.UTC(2026, 10, 1)
  const remote: Remote = {
    async pull(since) {
      return [...rows.values()]
        .filter((r) => !since || r.updated_at! > since)
        .sort((a, b) => a.updated_at!.localeCompare(b.updated_at!))
        .map((r) => structuredClone(r))
    },
    async get(ids) {
      return ids.flatMap((id) => (rows.has(id) ? [structuredClone(rows.get(id)!)] : []))
    },
    async push(batch) {
      const written: string[] = []
      for (const r of batch) {
        const old = rows.get(r.id)
        if (old && r.changed_at < old.changed_at) continue // the database keeps the newer row
        rows.set(r.id, { ...structuredClone(r), updated_at: new Date((clock += 1000)).toISOString() })
        written.push(r.id)
      }
      return written
    },
    async upload(path, blob) {
      log.uploads.push(path)
      files.set(path, blob)
    },
    async download(path) {
      log.downloads.push(path)
      const f = files.get(path)
      if (!f) throw new TeamError(`missing ${path}`)
      return f
    },
    async remove(paths) {
      log.removed.push(...paths)
      paths.forEach((p) => files.delete(p))
    },
  }
  return { rows, files, log, remote }
}

/** A device: its IndexedDB stores as maps, and its sync state. */
function device(server: ReturnType<typeof fakeServer>) {
  const stores = { products: new Map(), garments: new Map(), looks: new Map() } as Record<
    'products' | 'garments' | 'looks',
    Map<string, ProductRec | GarmentRec | LookRec>
  >
  let saved = JSON.stringify({ synced: {}, retry: [] } satisfies SyncState)
  const outbox = new Map<string, number>()
  const local: Local = {
    get: async (store, id) => stores[store].get(id),
    put: async (store, rec) => void stores[store].set(rec.id, rec),
    remove: async (store, id) => void stores[store].delete(id),
    all: async (store) => [...stores[store].values()],
    thumb: async (shown: Blob) => new Blob([`thumb of ${await shown.text()}`]),
    changed: () => {},
  }
  let signedIn = true
  const sync = createSync({
    local,
    state: {
      load: () => JSON.parse(saved),
      save: (s) => void (saved = JSON.stringify(s)),
      outbox: {
        all: () => Object.fromEntries(outbox),
        set: (k, at) => void outbox.set(k, at),
        clear: (k, at) => void (outbox.get(k) === at && outbox.delete(k)),
      },
    },
    remote: () => (signedIn ? server.remote : undefined),
  })
  /** A change made here, as the app's lists make it: written, then queued. */
  const write = (store: 'products' | 'garments' | 'looks', rec: ProductRec | GarmentRec | LookRec) => {
    stores[store].set(rec.id, rec)
    sync.queue(store, rec.id)
  }
  const erase = (store: 'products' | 'garments' | 'looks', id: string) => {
    stores[store].delete(id)
    sync.queue(store, id)
  }
  return { stores, sync, write, erase, signOut: () => (signedIn = false) }
}

const product = (patch: Partial<ProductRec> = {}): ProductRec => ({
  id: 'p1',
  createdAt: 1,
  updatedAt: 1,
  name: 'Linen shirt',
  code: '0001',
  status: 'for_sale',
  sizes: [{ size: 'M', stock: 2 }],
  colours: ['White'],
  category: 'Shirts',
  brand: '',
  condition: '',
  material: '',
  measurements: '',
  notes: '',
  ...patch,
})

const photo = (text: string) => new Blob([text], { type: 'image/jpeg' })

const garment = (patch: Partial<GarmentRec> = {}): GarmentRec => ({
  id: 'g1',
  createdAt: 2,
  updatedAt: 2,
  photo: photo('front'),
  thumb: new Blob(['t']),
  autoCut: new Blob(['cut'], { type: 'image/png' }),
  removeBg: true,
  remover: 'rmbg14',
  productId: 'p1',
  ...patch,
})

describe('team sync', () => {
  it('shares a product with its photo and try-on result; the other device fetches them', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    a.write('garments', garment())
    a.write('looks', { id: 'l1', createdAt: 3, image: photo('on a model'), productId: 'p1', modelId: 'm-a' })
    await a.sync.run()
    expect(a.sync.status()).toMatchObject({ phase: 'synced', pending: 0 })
    expect(server.log.uploads).toEqual([expect.stringMatching(/^garments\/g1\/\w+\.jpg$/), expect.stringMatching(/^looks\/l1\//)])

    await b.sync.run()
    expect(b.stores.products.get('p1')).toMatchObject({ name: 'Linen shirt', sizes: [{ size: 'M', stock: 2 }] })
    const g = b.stores.garments.get('g1') as GarmentRec
    expect(await g.photo.text()).toBe('front')
    expect(g.autoCut).toBeUndefined() // made again on this device
    expect(g.thumb).toBeDefined()
    expect(await (b.stores.looks.get('l1') as LookRec).image.text()).toBe('on a model')

    // Fetching again (or its own changes coming back) downloads nothing more.
    const downloads = server.log.downloads.length
    await b.sync.run()
    await a.sync.run()
    expect(server.log.downloads.length).toBe(downloads)
  })

  it('keeps the later of two edits on both devices', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    await a.sync.run()
    await b.sync.run()
    // Both edit while apart; B's edit is the later one.
    a.write('products', product({ name: 'Shirt (A)', updatedAt: 10 }))
    b.write('products', product({ name: 'Shirt (B)', updatedAt: 20 }))
    await b.sync.run()
    await a.sync.run() // A's older edit is refused by the server and replaced by B's
    await b.sync.run()
    expect((a.stores.products.get('p1') as ProductRec).name).toBe('Shirt (B)')
    expect((b.stores.products.get('p1') as ProductRec).name).toBe('Shirt (B)')
  })

  it('does not overwrite a newer change made here with an older one from the team', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product({ updatedAt: 5 }))
    await a.sync.run()
    await b.sync.run()
    b.write('products', product({ name: 'Mine', updatedAt: 50 }))
    a.write('products', product({ name: 'Older', updatedAt: 30 }))
    await a.sync.run()
    await b.sync.run() // B uploads its newer edit and keeps it
    expect((b.stores.products.get('p1') as ProductRec).name).toBe('Mine')
    await a.sync.run()
    expect((a.stores.products.get('p1') as ProductRec).name).toBe('Mine')
  })

  it('passes deletions on, and drops a photo from the team when it leaves its product', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    a.write('garments', garment())
    await a.sync.run()
    await b.sync.run()

    // The photo leaves the product on A: B drops its copy, A keeps the photo in its Studio.
    a.write('garments', garment({ productId: undefined, updatedAt: 40 }))
    await a.sync.run()
    await b.sync.run()
    expect(b.stores.garments.has('g1')).toBe(false)
    expect(a.stores.garments.has('g1')).toBe(true)
    expect(server.log.removed).toEqual([]) // photos are never deleted by sync: another version may use them

    a.erase('products', 'p1')
    await a.sync.run()
    await b.sync.run()
    expect(b.stores.products.has('p1')).toBe(false)
    expect(server.rows.get('p1')).toMatchObject({ deleted: true })
  })

  it('uploads a photo only when it changes, and deletes none', async () => {
    const server = fakeServer()
    const a = device(server)
    a.write('products', product())
    a.write('garments', garment())
    await a.sync.run()
    a.write('garments', garment({ adjust: { exposure: 0.2, contrast: 0, saturation: 0, warmth: 0 }, updatedAt: 3 }))
    await a.sync.run()
    expect(server.log.uploads).toHaveLength(1)
    a.write('garments', garment({ photo: photo('cropped'), updatedAt: 4 }))
    await a.sync.run()
    expect(server.log.uploads).toHaveLength(2)
    expect(server.log.removed).toEqual([])
  })

  it('never uploads what was not shared, and waits while signed out', async () => {
    const server = fakeServer()
    const a = device(server)
    a.write('garments', garment({ productId: undefined })) // a photo outside any product
    a.signOut()
    await a.sync.run()
    expect(a.sync.status().pending).toBe(1) // kept for after signing in
    expect(server.rows.size).toBe(0)
  })

  it('reports an ended session as signed out', async () => {
    const server = fakeServer()
    server.remote.pull = async () => {
      throw new TeamError('Signed out: sign in again in Settings.', true)
    }
    const a = device(server)
    await a.sync.run()
    expect(a.sync.status()).toMatchObject({ phase: 'signed-out', error: 'Signed out: sign in again in Settings.' })
  })

  it('takes the team’s version when the database refuses an older upload, and keeps its photos', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    a.write('garments', garment())
    await a.sync.run()
    await b.sync.run()
    // A replaces the photo offline (older); B changes the light (newer) and syncs first.
    a.write('garments', garment({ photo: photo('replaced'), updatedAt: 100 }))
    b.write('garments', garment({ adjust: { exposure: 0.3, contrast: 0, saturation: 0, warmth: 0 }, updatedAt: 200 }))
    await b.sync.run()
    await a.sync.run()
    const g = a.stores.garments.get('g1') as GarmentRec
    expect(await g.photo.text()).toBe('front') // the team's (newer) version
    expect(g.adjust?.exposure).toBe(0.3)
    expect(server.log.removed).toEqual([])
    expect(a.sync.status()).toMatchObject({ phase: 'synced', pending: 0 })
  })

  it('keeps an edit made here while the team’s version of it was downloading', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    a.write('garments', garment())
    await a.sync.run()
    a.write('garments', garment({ photo: photo('new photo'), updatedAt: 50 }))
    await a.sync.run()
    await b.sync.run() // B gets the first version
    a.write('garments', garment({ photo: photo('newer photo'), updatedAt: 60 }))
    await a.sync.run()
    // While B downloads A's newer photo, B's user changes the garment type.
    const download = server.remote.download
    server.remote.download = async (path) => {
      b.write('garments', { ...(b.stores.garments.get('g1') as GarmentRec), kind: 'bottom', updatedAt: 70 })
      return download(path)
    }
    await b.sync.run()
    server.remote.download = download
    expect((b.stores.garments.get('g1') as GarmentRec).kind).toBe('bottom')
    await b.sync.run() // B's edit goes up
    await a.sync.run()
    expect((a.stores.garments.get('g1') as GarmentRec).kind).toBe('bottom')
  })

  it('applies the rest when a photo fails to download, and tries that one again next time', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    a.write('products', product({ id: 'p2', name: 'Skirt' }))
    a.write('garments', garment())
    await a.sync.run()
    const download = server.remote.download
    server.remote.download = async () => {
      throw new TeamError('network')
    }
    await b.sync.run()
    expect(b.stores.products.size).toBe(2)
    expect(b.stores.garments.size).toBe(0)
    expect(b.sync.status().error).toMatch(/1 change from the team could not be downloaded yet/)
    server.remote.download = download
    await b.sync.run()
    expect(b.stores.garments.size).toBe(1)
    expect(b.sync.status().error).toBeUndefined()
  })

  it('makes the cutout again when the team chose another method, and keeps it otherwise', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    a.write('garments', garment())
    await a.sync.run()
    await b.sync.run()
    const own = new Blob(['cut on b'], { type: 'image/png' })
    b.stores.garments.set('g1', { ...(b.stores.garments.get('g1') as GarmentRec), autoCut: own })

    a.write('garments', garment({ kind: 'dress', updatedAt: 5 }))
    await a.sync.run()
    await b.sync.run()
    expect(b.stores.garments.get('g1')).toMatchObject({ kind: 'dress', autoCut: own })

    a.write('garments', garment({ kind: 'dress', remover: 'isnet_fp16', updatedAt: 6 }))
    await a.sync.run()
    await b.sync.run()
    const g = b.stores.garments.get('g1') as GarmentRec
    expect(g.remover).toBe('isnet_fp16')
    expect(g.autoCut).toBeUndefined()
  })

  it('makes a new thumbnail when a hand fix or an online cutout arrives for a photo it has', async () => {
    const server = fakeServer()
    const a = device(server)
    const b = device(server)
    a.write('products', product())
    a.write('garments', garment())
    await a.sync.run()
    await b.sync.run()
    expect(await (b.stores.garments.get('g1') as GarmentRec).thumb!.text()).toBe('thumb of front')

    a.write('garments', garment({ editedCut: new Blob(['fixed'], { type: 'image/png' }), updatedAt: 5 }))
    await a.sync.run()
    await b.sync.run()
    const g = b.stores.garments.get('g1') as GarmentRec
    expect(await g.editedCut!.text()).toBe('fixed')
    expect(await g.thumb!.text()).toBe('thumb of fixed')

    // Nothing shown changed: the thumbnail stays.
    const thumb = g.thumb
    a.write('garments', garment({ editedCut: (a.stores.garments.get('g1') as GarmentRec).editedCut, kind: 'top', updatedAt: 7 }))
    await a.sync.run()
    await b.sync.run()
    expect((b.stores.garments.get('g1') as GarmentRec).thumb).toBe(thumb)
  })

  it('treats cutouts and thumbnails as this device’s own, not as edits for the team', () => {
    expect(sharesChange({ autoCut: new Blob() })).toBe(false)
    expect(sharesChange({ thumb: new Blob() })).toBe(false)
    expect(sharesChange({ editedCut: new Blob() })).toBe(true)
    expect(sharesChange({ kind: 'bottom' })).toBe(true)
  })
})
