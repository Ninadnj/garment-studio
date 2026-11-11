import { useEffect, useMemo, useRef, useState } from 'react'
import type { GarmentRec, LookRec, ProductRec } from '../lib/db'
import { shownCut } from '../lib/garments'
import { isTouch, shareFiles } from '../lib/image'
import {
  DEFAULT_POST_PHOTOS,
  type KitItem,
  MAX_POST_PHOTOS,
  fileBase,
  imageFacts,
  kitFileName,
  kitPhotos,
  postedPatch,
  storyPhoto,
  unpostedPatch,
} from '../lib/kit'
import { type CardLayout, feedLayout, squareLayout, storyLayout } from '../lib/layout'
import { CHANNELS, STATUS_LABELS, currentPrice, detailsText, formatPrice } from '../lib/products'
import { type Rendered, canvasMeasure, loadSubject, pictureKey, renderCard } from '../lib/render'
import type { Currency, LookPrefs } from '../lib/settings'
import { Sheet } from './Sheet'
import { useToast } from './Toast'
import { Field, Spinner, Thumb } from './ui'

const PREFS = 'gs.kitPrefs'
function readInfo() {
  try {
    return JSON.parse(localStorage.getItem(PREFS) ?? '{}').info !== false
  } catch {
    return true
  }
}
function saveInfo(info: boolean) {
  try {
    localStorage.setItem(PREFS, JSON.stringify({ info }))
  } catch {}
}

interface Out {
  file: File
  url: string // preview
}

function Previews({ items, label, tall }: { items: Out[]; label: string; tall?: boolean }) {
  if (!items.length) return null
  return (
    <div className={`kit-previews${tall ? ' tall' : ''}`}>
      {items.map((o, i) => (
        <img key={o.url} src={o.url} alt={`${label} ${i + 1}`} className="kit-preview" />
      ))}
    </div>
  )
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Images for posting a product, made from its photos with the shop's look: Instagram post and story, and squares
 * for Facebook and marketplaces, each handed to the share sheet (downloaded on a computer) with the caption copied.
 */
export function PostKitSheet({
  product: p,
  garments,
  looks,
  look,
  currency,
  shopInfo,
  cutoutBusy,
  makeCutout,
  onUpdate,
  onClose,
}: {
  product: ProductRec
  garments: GarmentRec[]
  looks: LookRec[]
  look: LookPrefs
  currency: Currency
  shopInfo: string
  cutoutBusy: Set<string>
  makeCutout: (rec: LookRec) => void
  onUpdate: (change: Partial<ProductRec> | ((now: ProductRec) => Partial<ProductRec>)) => void
  onClose: () => void
}) {
  const toast = useToast()
  const touch = isTouch()
  const items = useMemo(() => kitPhotos(p, garments, looks), [p, garments, looks])
  const [picked, setPicked] = useState(() => items.slice(0, DEFAULT_POST_PHOTOS).map((i) => i.id))
  const [storyId, setStoryId] = useState<string>()
  const [info, setInfo] = useState(readInfo)
  const [caption, setCaption] = useState(() => detailsText(p, currency, shopInfo))
  const [progress, setProgress] = useState('')
  const [failure, setFailure] = useState<string>()
  // Finished images by what they show (photo, facts, look), so a change draws again only the images it affects.
  const made = useRef(new Map<string, { r: Rendered; url: string }>())
  const [, setDrawn] = useState(0)
  useEffect(
    () => () => {
      for (const m of made.current.values()) URL.revokeObjectURL(m.url)
    },
    [],
  )
  // The product as it is now, for work that finishes later (a share sheet that was open a while).
  const latest = useRef(p)
  latest.current = p

  const chosen = picked.map((id) => items.find((i) => i.id === id)).filter((i): i is KitItem => !!i)
  // A photo whose background is still being removed waits; the others are drawn.
  const waiting = chosen.filter((i) => i.kind === 'garment' && !shownCut(i.rec))
  const ready = chosen.filter((i) => !waiting.includes(i))
  const storyItem = storyPhoto(ready, storyId)
  const plainLooks = chosen.filter((i): i is Extract<KitItem, { kind: 'look' }> => i.kind === 'look' && !i.rec.cutout)
  const cutting = plainLooks.some((l) => cutoutBusy.has(l.id))
  const facts = imageFacts(p, currency)
  const factsKey = JSON.stringify(facts)
  const lookKey = JSON.stringify(look)
  const keyOf = (kind: 'feed' | 'story' | 'square', item: KitItem, withFacts: boolean) =>
    `${kind}|${pictureKey(item)}|${withFacts ? factsKey : ''}|${lookKey}`
  const plan = ready.map((item, i) => ({
    item,
    feedFacts: i === 0 && info, // only the first post photo can carry the facts
    feed: keyOf('feed', item, i === 0 && info),
    square: keyOf('square', item, false),
    story: item === storyItem ? keyOf('story', item, true) : undefined,
  }))
  const key = JSON.stringify(plan.map((x) => [x.feed, x.square, x.story]))

  useEffect(() => {
    let stop = false
    setFailure(undefined)
    ;(async () => {
      const todo = plan.filter((x) => [x.feed, x.square, x.story].some((k) => k && !made.current.has(k)))
      try {
        for (const [n, x] of todo.entries()) {
          if (stop) return
          setProgress(`Preparing photo ${n + 1} of ${todo.length}`)
          const s = await loadSubject(x.item)
          if (!s) continue
          try {
            const draw = async (k: string | undefined, layout: () => CardLayout) => {
              if (!k || made.current.has(k) || stop) return
              const r = await renderCard(layout(), s, look)
              made.current.set(k, { r, url: URL.createObjectURL(r.preview) })
              setDrawn((d) => d + 1)
            }
            await draw(x.feed, () => feedLayout(x.feedFacts ? facts : undefined, canvasMeasure))
            await draw(x.story, () => storyLayout(facts, canvasMeasure))
            await draw(x.square, squareLayout)
          } finally {
            s.close()
          }
        }
        if (stop) return
        // Images nothing shows any more are let go.
        const used = new Set(plan.flatMap((x) => [x.feed, x.square, x.story]))
        for (const [k, m] of made.current)
          if (!used.has(k)) {
            URL.revokeObjectURL(m.url)
            made.current.delete(k)
          }
      } catch (e) {
        if (!stop) setFailure(`Could not make the images: ${(e as Error).message}`)
      } finally {
        if (!stop) setProgress('')
      }
    })()
    return () => {
      stop = true
    }
    // Drawn only when what the images show changes (`key`), not on every edit of the product.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const toOut = (k: string | undefined, name: string): Out | undefined => {
    const m = k ? made.current.get(k) : undefined
    return m && { file: new File([m.r.blob], name, { type: 'image/jpeg' }), url: m.url }
  }
  const post = plan.map((x, i) => toOut(x.feed, kitFileName(p.code, 'instagram', i + 1))).filter((o): o is Out => !!o)
  const squares = plan.map((x, i) => toOut(x.square, kitFileName(p.code, 'square', i + 1))).filter((o): o is Out => !!o)
  const storyKey = plan.find((x) => x.story)?.story
  const story = toOut(storyKey, kitFileName(p.code, 'story'))

  function toggle(id: string) {
    setPicked((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= MAX_POST_PHOTOS ? ids : [...ids, id]))
  }

  async function share(files: File[], o: { zip: string; channel?: string; copy?: boolean }) {
    const r = await shareFiles(files, { zipName: o.zip, copy: o.copy ? caption : undefined })
    const copied = o.copy ? ' The caption is copied: paste it into the post.' : ''
    const channel = o.channel
    if (r === 'needs-tap') toast({ text: 'The images are ready: tap the button again to share them.' })
    else if (r === 'downloaded') toast({ text: `Downloaded.${copied}` })
    else if (r === 'shared' && channel) {
      // Worked out from the product as it is by then (the share sheet may have been open a while), and Undo
      // takes off only this place, whatever else changed meanwhile.
      const already = (latest.current.postedOn ?? []).some((c) => c.toLowerCase() === channel.toLowerCase())
      onUpdate((now) => postedPatch(now, channel))
      if (already) {
        if (copied) toast({ text: copied.trim() })
      } else
        toast({
          text: `Added ${channel} to Posted on.${copied}`,
          action: { label: 'Undo', run: () => onUpdate((now) => unpostedPatch(now, channel)) },
        })
    } else if (r === 'shared' && copied) toast({ text: copied.trim() })
  }

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(caption)
      toast({ text: 'Caption copied' })
    } catch {
      toast({ text: 'Copying is not allowed here.', error: true })
    }
  }

  const base = fileBase(p.code)
  const posted = p.postedOn ?? []
  const isPosted = (c: string) => posted.some((x) => x.toLowerCase() === c.toLowerCase())
  const places = [...CHANNELS, ...posted.filter((c) => !CHANNELS.some((x) => x.toLowerCase() === c.toLowerCase()))]
  const thumbOf = (i: KitItem) => (i.kind === 'garment' ? (i.rec.thumb ?? i.rec.photo) : i.rec.image)
  const verb = touch ? 'Share' : 'Download'

  return (
    <Sheet title="Post kit" onClose={onClose}>
      <p className="muted small">
        {[p.name || 'Untitled', formatPrice(currentPrice(p), currency), STATUS_LABELS[p.status]].filter(Boolean).join(' · ')}
      </p>
      {items.length === 0 ? (
        <p className="muted empty">Add a photo to this product first.</p>
      ) : (
        <>
          <Field label="Photos" hint="Tap a photo to leave it out or put it back. The numbers are the order in the post.">
            <div className="kit-strip">
              {items.map((it, n) => {
                const order = chosen.findIndex((c) => c.id === it.id)
                return (
                  <button
                    key={it.id}
                    className={`kit-thumb${order >= 0 ? ' on' : ''}`}
                    aria-pressed={order >= 0}
                    aria-label={`${it.kind === 'look' ? 'Try-on' : 'Photo'} ${n + 1}${order >= 0 ? `, number ${order + 1} in the post` : ', left out'}`}
                    onClick={() => toggle(it.id)}
                  >
                    <Thumb blob={thumbOf(it)} alt="" />
                    {order >= 0 && <span className="kit-order">{order + 1}</span>}
                  </button>
                )
              })}
            </div>
          </Field>
          {waiting.length > 0 && (
            <p className="muted small">{plural(waiting.length, 'photo is', 'photos are')} still being processed and not included yet.</p>
          )}
          {plainLooks.length > 0 && (
            <p className="muted small">
              {plainLooks.length === 1 ? 'A try-on keeps' : `${plainLooks.length} try-ons keep`} the background it was made with.{' '}
              <button className="btn-text small" disabled={cutting} onClick={() => plainLooks.forEach((l) => makeCutout(l.rec))}>
                {cutting ? 'Cutting out…' : 'Use the shop background'}
              </button>
            </p>
          )}
          <p className="muted small">Background, light, margin and shadow come from the Look in the Studio.</p>
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

          <section className="kit-group" aria-labelledby="kit-feed">
            <div className="kit-group-head">
              <h3 id="kit-feed">Instagram post</h3>
              <span className="muted small">1080 × 1350</span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={info}
                onChange={(e) => {
                  setInfo(e.target.checked)
                  saveInfo(e.target.checked)
                }}
              />
              Price and sizes on the first photo
            </label>
            <Previews items={post} label="Post photo" />
            <button
              className="btn"
              disabled={!post.length || !!progress}
              onClick={() => share(post.map((o) => o.file), { zip: `${base}-instagram.zip`, channel: touch ? 'Instagram' : undefined, copy: true })}
            >
              {verb} {post.length === 1 ? 'photo' : plural(post.length, 'photo')}
            </button>
          </section>

          <section className="kit-group" aria-labelledby="kit-story">
            <div className="kit-group-head">
              <h3 id="kit-story">Instagram story</h3>
              <span className="muted small">1080 × 1920</span>
            </div>
            {ready.length > 1 && (
              <div className="kit-strip small" role="radiogroup" aria-label="Photo for the story">
                {ready.map((it, n) => (
                  <button
                    key={it.id}
                    role="radio"
                    aria-checked={it === storyItem}
                    aria-label={`Story photo: ${it.kind === 'look' ? 'try-on' : 'photo'} ${n + 1}`}
                    className={`kit-thumb${it === storyItem ? ' on' : ''}`}
                    onClick={() => setStoryId(it.id)}
                  >
                    <Thumb blob={thumbOf(it)} alt="" />
                  </button>
                ))}
              </div>
            )}
            <Previews items={story ? [story] : []} label="Story" tall />
            <button
              className="btn"
              disabled={!story}
              onClick={() => story && share([story.file], { zip: `${base}-story.zip`, channel: touch ? 'Instagram' : undefined })}
            >
              {verb} story
            </button>
          </section>

          <section className="kit-group" aria-labelledby="kit-square">
            <div className="kit-group-head">
              <h3 id="kit-square">Facebook and marketplaces</h3>
              <span className="muted small">2048 × 2048 · no text on the photos</span>
            </div>
            <Previews items={squares} label="Square photo" />
            <button
              className="btn"
              disabled={!squares.length || !!progress}
              onClick={() => share(squares.map((o) => o.file), { zip: `${base}-square.zip`, copy: true })}
            >
              {verb} {squares.length === 1 ? 'photo' : plural(squares.length, 'photo')}
            </button>
          </section>

          <Field label="Posted on" hint="Sharing the post or story from a phone ticks Instagram. Tick the other places yourself.">
            <div className="chips" role="group" aria-label="Posted on">
              {places.map((c) => (
                <button
                  key={c}
                  className="chip"
                  aria-pressed={isPosted(c)}
                  onClick={() =>
                    onUpdate((now) =>
                      (now.postedOn ?? []).some((x) => x.toLowerCase() === c.toLowerCase()) ? unpostedPatch(now, c) : postedPatch(now, c),
                    )
                  }
                >
                  {c}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Caption" hint="Copied when you share. Instagram and Facebook drop shared text: paste it into the post.">
            <textarea className="input" rows={7} aria-label="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} />
          </Field>
          <div className="row sheet-actions">
            <button className="btn-secondary" onClick={copyCaption}>
              Copy caption
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
