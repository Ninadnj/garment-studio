import { useEffect, useMemo, useRef, useState } from 'react'
import { type Adjust, NO_ADJUST } from '../lib/adjust'
import { acceptNote, cutIssues, cutNoteKey, isNoteAccepted, lightFix, photoIssues, photoNoteKey } from '../lib/checks'
import { type Box, alphaBox, drawFit, exportFit, prepareSource } from '../lib/compose'
import { CUT_ISSUE_TEXT, type CutIssue } from '../lib/cutcheck'
import type { LookRec, ModelRec } from '../lib/db'
import { type GarmentStatus, type Garments, shownCut } from '../lib/garments'
import { useBitmap, useObjectURL, useStableBlob } from '../lib/hooks'
import { downscale, loadBitmap, releaseCanvas, saveFiles, stamp, toFile } from '../lib/image'
import { PHOTO_ISSUE_TEXT, type PhotoIssue } from '../lib/photocheck'
import type { Products } from '../lib/products'
import type { LookPrefs, Settings } from '../lib/settings'
import { CompareSheet } from './CompareSheet'
import { IconBrush, IconCompare, IconDownload, IconTrash, IconUpload } from './Icons'
import { LookPanel } from './LookPanel'
import { MaskEditor } from './MaskEditor'
import { ProductPanel } from './ProductPanel'
import { useToast } from './Toast'
import { Tray } from './Tray'
import { TryOnPanel } from './TryOnPanel'
import { Spinner } from './ui'

const PREVIEW_SIDE = 1400

interface Props {
  active: boolean
  G: Garments
  currentId?: string
  setCurrentId: (id: string | undefined) => void
  P: Products
  openProduct: (id: string) => void
  settings: Settings
  setSettings: (s: Settings) => void
  look: LookPrefs
  setLook: (l: LookPrefs) => void
  models: ModelRec[]
  looks: LookRec[]
  selectedModelId?: string
  selectModel: (id: string) => void
  onNewModel: () => void
  onUploadModel: (file: File) => void
  onLookSaved: (rec: LookRec) => void
  makeCutout: (rec: LookRec) => void
  cutoutBusy: Set<string>
  goSettings: () => void
}

const isImageFile = (f: File) => f.type.startsWith('image/') || /\.(hei[cf]|jpe?g|png|webp|avif|gif)$/i.test(f.name)

function statusText(st: GarmentStatus | undefined) {
  if (!st) return ''
  if (st.stage === 'download')
    return st.ratio < 1
      ? `Downloading background remover · ${Math.round(st.ratio * 100)}% (first time only)`
      : 'Preparing background remover'
  if (st.stage === 'queued') return 'Waiting for the photos before it'
  if (st.stage === 'refine') return 'Cleaning up the edges'
  return 'Removing background'
}

export function Studio(p: Props) {
  const toast = useToast()
  const { G, currentId } = p
  const g = G.garments.find((x) => x.id === currentId) ?? G.garments[0]
  const [editing, setEditing] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [savingAll, setSavingAll] = useState(false)
  const [saving, setSaving] = useState(false)
  const [comparingId, setComparingId] = useState<string>() // the photo "Try another way" is open for
  const [fixingId, setFixingId] = useState<string>() // the photo whose light is being read
  const [photoNotes, setPhotoNotes] = useState<PhotoIssue[]>([])
  const [cutNotes, setCutNotes] = useState<CutIssue[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const holdTimer = useRef(0)
  const { look, setLook } = p

  const cutBlob = g ? shownCut(g) : undefined
  const bmp = useBitmap(cutBlob)
  const box = useMemo<Box | undefined>(() => (bmp ? alphaBox(bmp) : undefined), [bmp])
  const photoUrl = useObjectURL(g?.photo)
  const status = g ? G.statusOf(g) : undefined
  const ready = !!(bmp && box && cutBlob)

  // What the app can't repair in the photo (dark, blurry, small), said once under it.
  const notedPhoto = useStableBlob(g?.photo)
  useEffect(() => {
    setPhotoNotes([])
    if (!g || !notedPhoto || isNoteAccepted(photoNoteKey(g.id))) return
    let alive = true
    photoIssues(notedPhoto).then(
      (r) => alive && setPhotoNotes(r),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [g?.id, notedPhoto])

  // The automatic cutout is checked for the seller; one fixed by hand, or kept as it is, is theirs to judge.
  const checkedCut = useStableBlob(g?.removeBg && !g.editedCut ? g.autoCut : undefined)
  useEffect(() => {
    setCutNotes([])
    if (!g || !checkedCut || isNoteAccepted(cutNoteKey(g.id, checkedCut))) return
    let alive = true
    cutIssues(checkedCut).then(
      (r) => alive && setCutNotes(r),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [g?.id, checkedCut])

  function endCompare() {
    clearTimeout(holdTimer.current)
    setComparing(false)
  }

  function choose(id: string | undefined) {
    p.setCurrentId(id)
    setEditing(false)
  }

  // Keep the selection valid when the selected photo is deleted or none was stored.
  useEffect(() => {
    if (G.loaded && g?.id !== currentId) choose(g?.id)
  }, [G.loaded, g?.id])

  // Another photo was opened from elsewhere (a product): the brush belongs to the photo it was opened on.
  useEffect(() => setEditing(false), [g?.id])
  const comparingWays = !!g && comparingId === g.id

  useEffect(() => {
    if (editing || !ready || !canvas.current) return
    const id = requestAnimationFrame(() => {
      const src = prepareSource(bmp!, box!, g?.adjust, PREVIEW_SIDE)
      drawFit(canvas.current!, src.src, src.box, look, PREVIEW_SIDE)
      // Dragging a slider makes a copy every frame: free it now rather than when it is collected (iPhones).
      if (src.src !== bmp && src.src instanceof HTMLCanvasElement) releaseCanvas(src.src)
    })
    return () => cancelAnimationFrame(id)
  }, [bmp, box, look, g?.adjust, editing, ready])

  async function addFiles(files: File[]) {
    const images = files.filter(isImageFile)
    if (!images.length) {
      if (files.length) toast({ text: 'That is not an image file.', error: true })
      return
    }
    const { ids, failed } = await G.add(images, (id, i) => i === 0 && choose(id))
    if (failed)
      toast({
        text: failed === 1 ? 'One file could not be opened as an image.' : `${failed} files could not be opened as images.`,
        error: true,
      })
    if (ids.length > 1) toast({ text: `${ids.length} photos added. Backgrounds are removed one after another.` })
  }

  // Paste images from the clipboard (Mac: ⌘V); ← → switch photos; E opens the brush.
  useEffect(() => {
    if (!p.active || editing) return
    // A dialog (a product, the product picker) is on top: its keys are not the Studio's.
    const dialogOpen = () => !!document.querySelector('[aria-modal="true"]')
    const onPaste = (e: ClipboardEvent) => {
      if (dialogOpen()) return
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.some(isImageFile)) addFiles(files)
    }
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen() || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const i = G.garments.findIndex((x) => x.id === g?.id)
      if (e.key === 'ArrowRight' && i < G.garments.length - 1) choose(G.garments[i + 1].id)
      else if (e.key === 'ArrowLeft' && i > 0) choose(G.garments[i - 1].id)
      else if (e.key.toLowerCase() === 'e' && ready && g?.removeBg) setEditing(true)
      else return
      e.preventDefault()
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKey)
    }
  })

  async function share(files: File[], zipName: string) {
    const res = await saveFiles(files, zipName)
    // Preparing took long enough that the share sheet no longer counts the tap: ask for another.
    if (res === 'needs-tap')
      toast({
        text: files.length === 1 ? 'Image ready' : `${files.length} images ready`,
        action: { label: 'Save', run: () => saveFiles(files, zipName) },
      })
  }

  async function save() {
    if (!g || !bmp || !box) return
    setSaving(true)
    try {
      const name = `garment-${stamp()}`
      await share([toFile(await exportFit(bmp, box, look, g.adjust), name)], `${name}.zip`)
    } finally {
      setSaving(false)
    }
  }

  async function saveAll() {
    setSavingAll(true)
    try {
      const files: File[] = []
      let waiting = 0
      let failed = 0
      for (const [i, x] of G.garments.entries()) {
        const blob = shownCut(x)
        if (!blob) {
          waiting++
          continue
        }
        // One photo that can't be made (out of memory on a phone) doesn't stop the others.
        try {
          const b = await loadBitmap(blob)
          try {
            files.push(toFile(await exportFit(b, alphaBox(b), look, x.adjust), `garment-${String(i + 1).padStart(2, '0')}`))
          } finally {
            b.close()
          }
        } catch (e) {
          console.error(e)
          failed++
        }
      }
      if (waiting || failed)
        toast({
          text: [waiting && `${waiting} still being processed`, failed && `${failed} could not be made`].filter(Boolean).join(', ') + ', not included.',
          error: failed > 0,
        })
      if (files.length) await share(files, `garments-${stamp()}.zip`)
    } finally {
      setSavingAll(false)
    }
  }

  function remove() {
    if (!g) return
    const i = G.garments.indexOf(g)
    const next = G.garments[i + 1] ?? G.garments[i - 1]
    const rec = G.remove(g.id)
    choose(next?.id)
    if (rec)
      toast({
        text: 'Photo deleted',
        action: {
          label: 'Undo',
          run: () => {
            G.restore(rec)
            choose(rec.id)
          },
        },
      })
  }

  async function fixLight() {
    if (!g || !cutBlob) return
    const { id } = g
    const before = g.adjust ?? NO_ADJUST
    setFixingId(id)
    try {
      const fix = await lightFix(g.photo, cutBlob)
      // Nothing proposed also when it can't tell (no plain background to read the light from): the seller's
      // own slider values stay.
      if (!fix.exposure && !fix.contrast && !fix.warmth) {
        toast({ text: 'Nothing to fix automatically. The sliders under Light and colour change it by hand.' })
        return
      }
      const adjust = { ...fix, saturation: before.saturation }
      if (adjust.exposure === before.exposure && adjust.contrast === before.contrast && adjust.warmth === before.warmth) {
        toast({ text: 'The light is already fixed.' })
        return
      }
      G.update(id, { adjust })
      toast({ text: 'Light fixed', action: { label: 'Undo', run: () => G.update(id, { adjust: before }) } })
    } catch (e) {
      console.error(e)
      toast({ text: 'Could not read the photo to fix its light.', error: true })
    } finally {
      setFixingId(undefined)
    }
  }

  async function useFullScreenshot() {
    if (!g?.raw) return
    G.update(g.id, { photo: await downscale(g.raw, 2048), raw: undefined, autoCut: undefined, editedCut: undefined })
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (![...e.dataTransfer.types].includes('Files')) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      addFiles([...e.dataTransfer.files])
    },
  }

  const fileField = (
    <input
      ref={fileInput}
      type="file"
      accept="image/*"
      multiple
      hidden
      onChange={(e) => {
        const files = [...(e.target.files ?? [])]
        e.target.value = ''
        addFiles(files)
      }}
    />
  )

  const busy = status && status.stage !== 'error'

  return (
    <div className={`studio ${dragging ? 'dragging' : ''}`} {...dropProps}>
      <section className="studio-preview">
        {fileField}
        {!g ? (
          <button className="dropzone" onClick={() => fileInput.current?.click()} disabled={!G.loaded}>
            {G.opening ? <Spinner /> : <IconUpload />}
            <strong>{G.opening ? 'Opening photos' : 'Add clothing photos'}</strong>
            <span className="muted">
              Tap to choose or take photos. Several at once work too.
              <br />
              On a Mac, drop or paste them here.
            </span>
            <span className="muted tips">
              Cleanest results: a plain background in another colour than the garment, daylight, the whole garment in the
              picture.
            </span>
          </button>
        ) : editing && cutBlob && g.removeBg ? (
          <MaskEditor
            key={g.id}
            active={p.active}
            src={g.photo}
            cut={cutBlob}
            auto={g.autoCut}
            onCancel={() => setEditing(false)}
            onDone={(edited) => {
              G.update(g.id, { editedCut: edited })
              setEditing(false)
            }}
          />
        ) : (
          <div className="preview-wrap">
            <div
              className={`preview ${ready && look.bg === 'transparent' ? 'checker' : ''}`}
              onPointerDown={(e) => {
                // Touch and hold shows the original. The delay keeps a scroll that starts here from flashing it.
                if (!ready || e.pointerType === 'mouse') return
                clearTimeout(holdTimer.current)
                holdTimer.current = window.setTimeout(() => setComparing(true), 220)
              }}
              onPointerUp={endCompare}
              onPointerCancel={endCompare}
              onPointerLeave={endCompare}
              onContextMenu={(e) => ready && e.preventDefault()}
            >
              {ready ? (
                <canvas ref={canvas} aria-label="Garment on the chosen background" />
              ) : (
                photoUrl && <img src={photoUrl} alt="Original photo" className={busy ? 'processing' : ''} />
              )}
              {comparing && photoUrl && <img src={photoUrl} alt="Original photo" className="preview-original" />}
              {busy && (
                <div className="preview-status">
                  <Spinner />
                  {statusText(status)}
                </div>
              )}
            </div>
            {status?.stage === 'error' && (
              <div className="row notice">
                <span className="error">{status.message}</span>
                <button className="btn-text" onClick={() => G.retry(g.id)}>
                  Try again
                </button>
                <button
                  className="btn-text"
                  onClick={() => {
                    setEditing(false)
                    G.update(g.id, { removeBg: false })
                  }}
                >
                  Keep the background
                </button>
              </div>
            )}
            {(photoNotes.length > 0 || cutNotes.length > 0) && !busy && status?.stage !== 'error' && (
              <ul className="photo-notes small">
                {cutNotes.length > 0 && checkedCut && (
                  <li>
                    <span>{cutNotes.map((i) => CUT_ISSUE_TEXT[i]).join(' ')}</span>
                    <button className="btn-text small" onClick={() => setComparingId(g.id)}>
                      Try another way
                    </button>
                    <button className="btn-text small" onClick={() => setEditing(true)} disabled={!ready}>
                      Fix by hand
                    </button>
                    <button
                      className="btn-text small"
                      onClick={() => {
                        acceptNote(cutNoteKey(g.id, checkedCut))
                        setCutNotes([])
                      }}
                    >
                      It is fine
                    </button>
                  </li>
                )}
                {photoNotes.length > 0 && (
                  <li className="muted">
                    <span>{photoNotes.map((i) => PHOTO_ISSUE_TEXT[i]).join(' ')}</span>
                    <button
                      className="btn-text small"
                      onClick={() => {
                        acceptNote(photoNoteKey(g.id))
                        setPhotoNotes([])
                      }}
                    >
                      It is fine
                    </button>
                  </li>
                )}
              </ul>
            )}
            {g.raw && (
              <p className="muted small note">
                Phone screenshot: cropped to the photo.{' '}
                <button className="btn-text" onClick={useFullScreenshot}>
                  Use full screenshot
                </button>
              </p>
            )}
            <div className="actions">
              <button
                className="btn-secondary"
                onClick={() => setEditing(true)}
                disabled={!ready || !g.removeBg}
                title="Erase or bring back parts by hand (E)"
              >
                <IconBrush /> Fix by hand
              </button>
              <button
                className="btn-secondary icon-only"
                aria-label="Compare with the original (hold)"
                title="Hold to compare with the original"
                disabled={!ready}
                onPointerDown={() => setComparing(true)}
                onPointerUp={() => setComparing(false)}
                onPointerLeave={() => setComparing(false)}
                onKeyDown={(e) => e.key === ' ' && setComparing(true)}
                onKeyUp={() => setComparing(false)}
              >
                <IconCompare />
              </button>
              <button className="btn-secondary icon-only" aria-label="Delete photo" title="Delete photo" onClick={remove}>
                <IconTrash />
              </button>
              <span className="spacer" />
              <button className="btn" onClick={save} disabled={!ready || saving}>
                {saving ? <Spinner /> : <IconDownload />} Save
              </button>
            </div>
          </div>
        )}

        {G.garments.length > 0 && !editing && (
          <div className="tray-wrap">
            <div className="tray-head">
              <span className="muted small">
                {G.garments.length} photo{G.garments.length === 1 ? '' : 's'} · ← → to switch
              </span>
              {G.garments.length > 1 && (
                <button className="btn-text" onClick={saveAll} disabled={savingAll}>
                  {savingAll ? 'Preparing…' : `Save all ${G.garments.length}`}
                </button>
              )}
            </div>
            <Tray
              garments={G.garments}
              currentId={g?.id}
              statusOf={G.statusOf}
              bg={look.bg}
              opening={G.opening}
              onSelect={choose}
              onAdd={() => fileInput.current?.click()}
            />
          </div>
        )}
      </section>

      <section className="studio-controls">
        {g && !editing && p.P.loaded && (
          <ProductPanel g={g} G={G} P={p.P} currency={p.settings.currency} openProduct={p.openProduct} />
        )}
        <LookPanel
          look={look}
          setLook={setLook}
          photo={
            g && {
              removeBg: g.removeBg,
              setRemoveBg: (removeBg) => {
                setEditing(false)
                G.update(g.id, { removeBg })
              },
              compare: g.removeBg && cutBlob ? () => setComparingId(g.id) : undefined,
              adjust: g.adjust ?? NO_ADJUST,
              setAdjust: (adjust: Adjust) => G.update(g.id, { adjust }),
              fixLight: cutBlob ? fixLight : undefined,
              fixingLight: fixingId === g.id,
            }
          }
        />
        <TryOnPanel
          garment={
            ready && g
              ? {
                  bmp: bmp!,
                  box: box!,
                  adjust: g.adjust,
                  kind: g.kind ?? 'top',
                  setKind: (kind) => G.update(g.id, { kind }),
                  productId: p.P.products.some((x) => x.id === g.productId) ? g.productId : undefined,
                }
              : undefined
          }
          settings={p.settings}
          models={p.models}
          looks={p.looks}
          bg={look.bg}
          selectedModelId={p.selectedModelId}
          selectModel={p.selectModel}
          onNewModel={p.onNewModel}
          onUploadModel={p.onUploadModel}
          onLookSaved={p.onLookSaved}
          makeCutout={p.makeCutout}
          cutoutBusy={p.cutoutBusy}
          goSettings={p.goSettings}
        />
      </section>
      {comparingWays && g && (
        <CompareSheet
          key={g.id}
          g={g}
          bg={look.bg}
          token={p.settings.hfToken || undefined}
          onUse={(patch) => {
            setEditing(false) // the brush belongs to the cutout being replaced
            G.update(g.id, patch)
          }}
          onClose={() => setComparingId(undefined)}
        />
      )}
      {dragging && <div className="drop-hint">Drop photos to add them</div>}
    </div>
  )
}
