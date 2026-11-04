import { useEffect, useRef, useState } from 'react'
import { thumbnail } from './compose'
import { type CutoutProgress, cutout } from './cutout'
import {
  type GarmentRec,
  deleteRec,
  listAll,
  onBeforeClose,
  onOtherWindowChange,
  putRec,
  reportWriteError,
  requestPersistence,
} from './db'
import { downscale, normalizeImage, uid } from './image'
import { cropScreenshotBars } from './screenshot'
import type { Remover } from './settings'

export type GarmentStatus = CutoutProgress | { stage: 'queued' } | { stage: 'error'; message: string }

// What the team shares of a photo. The rest (the automatic cutout, the thumbnail, an uncropped screenshot) is
// made or kept by each device: changing it isn't an edit, and doesn't make this device's copy the newest.
const SHARED_FIELDS = new Set<string>(['photo', 'editedCut', 'adjust', 'kind', 'productId', 'removeBg', 'remover'])
export const sharesChange = (patch: Partial<GarmentRec>) => Object.keys(patch).some((k) => SHARED_FIELDS.has(k))

/** What is shown and exported for `g`: the photo itself, or its cutout (undefined while it's made). */
export const shownCut = (g: GarmentRec) => (g.removeBg ? (g.editedCut ?? g.autoCut) : g.photo)

const omit = <T,>(o: Record<string, T>, key: string) => {
  const { [key]: _, ...rest } = o
  return rest
}

/**
 * Every garment photo, kept in IndexedDB, plus a queue that removes backgrounds one photo at a time
 * (the photo on screen first).
 */
export function useGarments(defaultRemover: Remover, priorityId: string | undefined) {
  const [garments, setGarments] = useState<GarmentRec[]>([])
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<Record<string, GarmentStatus>>({})
  const [opening, setOpening] = useState(0)
  const [tick, setTick] = useState(0)
  // Source of truth between renders, so async work never patches a stale copy.
  const list = useRef<GarmentRec[]>([])
  const running = useRef<string | null>(null)
  const priority = useRef(priorityId)
  priority.current = priorityId

  const commit = (next: GarmentRec[]) => {
    list.current = next
    setGarments(next)
  }

  useEffect(() => {
    listAll('garments')
      .then(commit)
      .catch(reportWriteError)
      .finally(() => setLoaded(true))
  }, [])

  // Saved by another window or by team sync: re-read, keeping edits here that are still waiting to be saved.
  useEffect(
    () =>
      onOtherWindowChange((store) => {
        if (store !== 'garments') return
        listAll('garments')
          .then((rows) => commit(rows.map((r) => (writes.current.has(r.id) ? (list.current.find((g) => g.id === r.id) ?? r) : r))))
          .catch(reportWriteError)
      }),
    [],
  )

  async function refreshThumb(id: string) {
    const g = list.current.find((x) => x.id === id)
    const blob = g && shownCut(g)
    if (!blob) return
    const thumb = await thumbnail(blob, blob !== g.photo)
    const now = list.current.find((x) => x.id === id)
    if (now && shownCut(now) === blob) update(id, { thumb })
  }

  // Writes are batched per photo: a slider drag changes the record many times a second.
  const writes = useRef(new Map<string, number>())
  const sharedEdits = useRef(new Set<string>()) // photos with a change the team should get
  function write(id: string) {
    clearTimeout(writes.current.get(id))
    writes.current.delete(id)
    const quiet = !sharedEdits.current.delete(id)
    const latest = list.current.find((g) => g.id === id)
    if (latest) putRec('garments', latest, quiet).catch(reportWriteError)
  }
  function persist(rec: GarmentRec) {
    clearTimeout(writes.current.get(rec.id))
    writes.current.set(
      rec.id,
      window.setTimeout(() => write(rec.id), 300),
    )
  }
  useEffect(() => onBeforeClose(() => [...writes.current.keys()].forEach(write)), [])

  function update(id: string, patch: Partial<GarmentRec>) {
    const shares = sharesChange(patch)
    let rec: GarmentRec | undefined
    commit(list.current.map((g) => (g.id === id ? (rec = { ...g, ...patch, ...(shares && { updatedAt: Date.now() }) }) : g)))
    if (!rec) return
    if (shares) sharedEdits.current.add(id)
    persist(rec)
    if ('removeBg' in patch || 'autoCut' in patch || 'editedCut' in patch || 'photo' in patch) refreshThumb(id)
  }

  /** Open image files and put them at the front of the strip in the order given; `extra` goes into each record. */
  async function add(
    files: Blob[],
    onAdded?: (id: string, index: number) => void,
    extra: Partial<GarmentRec> = {},
  ): Promise<{ ids: string[]; failed: number }> {
    requestPersistence()
    const ids: string[] = []
    let failed = 0
    const t = Date.now()
    setOpening((n) => n + files.length)
    // One at a time: decoding several 12-megapixel photos at once can exhaust phone memory.
    for (let i = 0; i < files.length; i++) {
      try {
        const img = await normalizeImage(files[i])
        const crop = await cropScreenshotBars(img).catch(() => null)
        const photo = await downscale(crop ?? img, 2048)
        const rec: GarmentRec = {
          id: uid(),
          createdAt: t - i,
          updatedAt: t,
          photo,
          raw: crop ? img : undefined,
          thumb: await thumbnail(photo, false),
          removeBg: true,
          remover: defaultRemover,
          ...extra,
        }
        await putRec('garments', rec)
        commit([...list.current, rec].sort((a, b) => b.createdAt - a.createdAt))
        onAdded?.(rec.id, ids.length)
        ids.push(rec.id)
      } catch (e) {
        console.error(e)
        failed++
      } finally {
        setOpening((n) => n - 1)
      }
    }
    return { ids, failed }
  }

  function remove(id: string) {
    clearTimeout(writes.current.get(id))
    writes.current.delete(id)
    const rec = list.current.find((g) => g.id === id)
    commit(list.current.filter((g) => g.id !== id))
    deleteRec('garments', id).catch(reportWriteError)
    return rec
  }

  function restore(deleted: GarmentRec) {
    // A new change: team sync must not take the deletion for the newer one.
    const rec = { ...deleted, updatedAt: Date.now() }
    commit([...list.current, rec].sort((a, b) => b.createdAt - a.createdAt))
    putRec('garments', rec).catch(reportWriteError)
  }

  function retry(id: string) {
    setStatus((s) => omit(s, id))
    setTick((t) => t + 1)
  }

  // Background removal queue.
  useEffect(() => {
    if (!loaded || running.current) return
    const pending = list.current.filter((g) => g.removeBg && !g.autoCut && status[g.id]?.stage !== 'error')
    if (!pending.length) return
    const g = pending.find((x) => x.id === priority.current) ?? pending[0]
    const { id, remover, photo } = g
    running.current = id
    setStatus((s) => ({ ...s, [id]: { stage: 'compute' } }))
    cutout(photo, remover, (p) => setStatus((s) => ({ ...s, [id]: p })))
      .then((cut) => {
        const cur = list.current.find((x) => x.id === id)
        // Deleted, or the remover changed while this ran: the queue picks it up again if needed.
        if (cur && cur.remover === remover && cur.photo === photo) update(id, { autoCut: cut })
        setStatus((s) => omit(s, id))
      })
      .catch((e) => {
        console.error(e)
        setStatus((s) => ({ ...s, [id]: { stage: 'error', message: 'Background removal failed.' } }))
      })
      .finally(() => {
        running.current = null
        setTick((t) => t + 1)
      })
    // `garments` and `tick` re-run the check whenever work may be waiting.
  }, [garments, loaded, status, tick])

  /** Queue state for the strip: waiting photos show as queued even before their turn. */
  const statusOf = (g: GarmentRec): GarmentStatus | undefined =>
    status[g.id] ?? (g.removeBg && !g.autoCut ? { stage: 'queued' } : undefined)

  return { garments, loaded, opening, statusOf, add, update, remove, restore, retry }
}

export type Garments = ReturnType<typeof useGarments>
