import { useEffect, useMemo, useState } from 'react'
import {
  catalogueFileName,
  catalogueMessage,
  catalogueProducts,
  dateText,
  paginate,
  repeatedCodes,
  skippedText,
} from '../lib/catalogue'
import type { GarmentRec, LookRec, ProductRec } from '../lib/db'
import { isTouch, shareFiles } from '../lib/image'
import { SHARE_BATCH, imageFacts, tilePhoto } from '../lib/kit'
import { PAGE } from '../lib/layout'
import { jpegPdf } from '../lib/pdf'
import { currentPrice, formatPrice } from '../lib/products'
import { canvasMeasure, loadSubject, pictureKey, renderPage } from '../lib/render'
import type { LookPrefs, Settings } from '../lib/settings'
import { Sheet } from './Sheet'
import { useToast } from './Toast'
import { Chips, Field, Spinner, Thumb } from './ui'

const PREFS = 'gs.cataloguePrefs'
interface Prefs {
  perPage: 4 | 6
  model: boolean // try-ons rather than garment photos
}
function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}')
    return { perPage: p.perPage === 6 ? 6 : 4, model: p.model === true }
  } catch {
    return { perPage: 4, model: false }
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p))
  } catch {}
}

interface Out {
  file: File
  url: string // preview
}

/**
 * Pages to send to a customer: the products shown in Products that can be sold now (for example everything in
 * size M), with photo, price, code and sizes; as images or one PDF, through the share sheet (downloads on a computer).
 */
export function CatalogueSheet({
  shown,
  size,
  garments,
  looks,
  look,
  settings,
  onClose,
  goShop,
}: {
  shown: ProductRec[]
  size?: string // the size filter that was on in Products
  garments: GarmentRec[]
  looks: LookRec[]
  look: LookPrefs
  settings: Settings
  onClose: () => void
  goShop: () => void
}) {
  const toast = useToast()
  const touch = isTouch()
  const [prefs, setPrefsState] = useState(readPrefs)
  const setPrefs = (p: Prefs) => {
    setPrefsState(p)
    savePrefs(p)
  }
  const [title, setTitle] = useState(size ? `Size ${size}` : '')
  const [left, setLeft] = useState<Set<string>>(() => new Set()) // unticked
  const { products, skipped } = useMemo(
    () => catalogueProducts(shown, (p) => garments.some((g) => g.productId === p.id) || looks.some((l) => l.productId === p.id), size),
    [shown, garments, looks, size],
  )
  const chosen = products.filter((p) => !left.has(p.id))
  const twice = repeatedCodes(chosen)
  const [today] = useState(() => new Date())
  const [pages, setPages] = useState<Out[]>([])
  const [pdf, setPdf] = useState<File>()
  const [progress, setProgress] = useState('')
  const [failure, setFailure] = useState<string>()
  const message = catalogueMessage(title, settings.contactLine, settings.shopInfo)
  const { currency, shopName, contactLine } = settings

  const tiles = chosen.map((p) => ({ p, item: tilePhoto(p, garments, looks, prefs.model) }))
  const key = JSON.stringify({
    tiles: tiles.map(({ p, item }) => [imageFacts(p, currency), item ? pictureKey(item) : '']),
    prefs,
    title,
    look,
    shopName,
    contactLine,
  })

  useEffect(() => {
    let stop = false
    const urls: string[] = []
    setPages([])
    setPdf(undefined)
    setFailure(undefined)
    // Drawn a moment after the last change (typing the title, ticking products).
    const timer = window.setTimeout(async () => {
      const groups = paginate(tiles, prefs.perPage)
      const done: Out[] = []
      try {
        for (const [i, group] of groups.entries()) {
          if (stop) return
          setProgress(`Preparing page ${i + 1} of ${groups.length}`)
          const r = await renderPage(
            {
              items: group.map(({ p, item }) => ({
                facts: imageFacts(p, currency),
                load: () => (item ? loadSubject(item, 1000, true) : Promise.resolve(undefined)),
              })),
              perPage: prefs.perPage,
              shopName,
              title,
              date: dateText(today),
              contact: contactLine,
              page: `${i + 1}/${groups.length}`,
              highlight: size,
            },
            look,
            canvasMeasure,
          )
          if (stop) return
          const url = URL.createObjectURL(r.preview)
          urls.push(url)
          const page = { file: new File([r.blob], catalogueFileName(today, i + 1), { type: 'image/jpeg' }), url }
          done.push(page)
          setPages((xs) => [...xs, page])
        }
        if (stop || !done.length) return
        const blob = await jpegPdf(done.map((o) => ({ jpeg: o.file, width: PAGE.width, height: PAGE.height })))
        if (!stop) setPdf(new File([blob], catalogueFileName(today), { type: 'application/pdf' }))
      } catch (e) {
        if (!stop) setFailure(`Could not make the pages: ${(e as Error).message}`)
      } finally {
        if (!stop) setProgress('')
      }
    }, 600)
    return () => {
      stop = true
      clearTimeout(timer)
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
    // Drawn again only when what the pages show changes (`key`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  async function share(files: File[]) {
    const r = await shareFiles(files, {
      zipName: catalogueFileName(today).replace(/\.pdf$/, '.zip'),
      text: message || undefined,
      copy: message || undefined,
    })
    if (r === 'needs-tap') toast({ text: 'The pages are ready: tap the button again to share them.' })
    else if (r === 'downloaded') toast({ text: message ? 'Downloaded. The message is copied.' : 'Downloaded.' })
  }

  const tick = (id: string, on: boolean) =>
    setLeft((s) => {
      const n = new Set(s)
      if (on) n.delete(id)
      else n.add(id)
      return n
    })
  const busy = !!progress || pages.length === 0 || chosen.length === 0
  const n = products.length

  return (
    <Sheet title="Catalogue" onClose={onClose}>
      <p>{n ? `${n} product${n === 1 ? '' : 's'} for sale${size ? ` with stock in ${size}` : ''}.` : 'None of these products can be sold now.'}</p>
      {skippedText(skipped, size) && <p className="muted small">{skippedText(skipped, size)}</p>}
      {twice.length > 0 && (
        <p className="error small">
          {twice.length === 1
            ? `Code ${twice[0]} is on more than one of these products.`
            : `Codes ${twice.join(', ')} are each on more than one of these products.`}
        </p>
      )}
      {n > 0 && (
        <>
          <Field label="Products">
            <div className="row">
              <button className="btn-text small" onClick={() => setLeft(new Set())}>
                Select all
              </button>
              <button className="btn-text small" onClick={() => setLeft(new Set(products.map((p) => p.id)))}>
                Clear
              </button>
            </div>
            <ul className="catalogue-list">
              {products.map((p) => {
                const item = tilePhoto(p, garments, looks, prefs.model)
                const thumb = item && (item.kind === 'garment' ? (item.rec.thumb ?? item.rec.photo) : item.rec.image)
                return (
                  <li key={p.id}>
                    <label className="catalogue-row">
                      <input type="checkbox" checked={!left.has(p.id)} onChange={(e) => tick(p.id, e.target.checked)} />
                      <span className="catalogue-thumb">{thumb && <Thumb blob={thumb} alt="" />}</span>
                      <span className="catalogue-name">{p.name || 'Untitled'}</span>
                      <span className="muted small">{[p.code, formatPrice(currentPrice(p), currency)].filter(Boolean).join(' · ')}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </Field>
          <Field label="Title on the pages">
            <input className="input" value={title} placeholder="Optional, e.g. New in" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Per page">
            <Chips
              label="Per page"
              options={['4', '6'] as const}
              value={prefs.perPage === 6 ? '6' : '4'}
              onChange={(v) => setPrefs({ ...prefs, perPage: v === '6' ? 6 : 4 })}
            />
          </Field>
          <Field label="Photo">
            <Chips
              label="Photo"
              options={['garment', 'model'] as const}
              labels={{ garment: 'Garment', model: 'On a model' }}
              value={prefs.model ? 'model' : 'garment'}
              onChange={(v) => setPrefs({ ...prefs, model: v === 'model' })}
            />
          </Field>
          {(!shopName.trim() || !contactLine.trim()) && (
            <p className="muted small">
              Add your shop name and contact line in{' '}
              <button className="btn-text small" onClick={goShop}>
                Settings → Shop
              </button>{' '}
              to show them on the pages.
            </p>
          )}
          {failure && (
            <p className="error" role="alert">
              {failure}
            </p>
          )}
          {progress && (
            <p className="muted small" role="status">
              <Spinner /> {progress}
            </p>
          )}
          {pages.length > 0 && (
            <div className="kit-previews tall">
              {pages.map((o, i) => (
                <img key={o.url} src={o.url} alt={`Page ${i + 1}`} className="kit-preview" />
              ))}
            </div>
          )}
          <div className="row sheet-actions">
            {/* A phone's share sheet takes up to 10 files at once (Android), so more pages go in groups. */}
            {(touch ? paginate(pages, SHARE_BATCH) : [pages]).map((group, g, all) => (
              <button key={g} className="btn" disabled={busy} onClick={() => share(group.map((o) => o.file))}>
                {touch ? 'Share' : 'Download'}{' '}
                {all.length > 1
                  ? `pages ${g * SHARE_BATCH + 1}–${g * SHARE_BATCH + group.length}`
                  : pages.length === 1
                    ? 'page'
                    : `${pages.length} pages`}
              </button>
            ))}
            <button className="btn-secondary" disabled={busy || !pdf} onClick={() => pdf && share([pdf])}>
              {touch ? 'Share as PDF' : 'Download PDF'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
