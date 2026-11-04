import { useEffect, useMemo, useRef, useState } from 'react'
import type { Adjust } from '../lib/adjust'
import { type Box, alphaBox, drawFit, exportFit, prepareSource } from '../lib/compose'
import type { LookRec, ModelRec } from '../lib/db'
import { type GarmentStatus, type Garments, shownCut } from '../lib/garments'
import { useBitmap, useObjectURL } from '../lib/hooks'
import { downscale, loadBitmap, saveFiles, stamp, toFile } from '../lib/image'
import type { Products } from '../lib/products'
import type { LookPrefs, Remover, Settings } from '../lib/settings'
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

  useEffect(() => {
    if (editing || !ready || !canvas.current) return
    const id = requestAnimationFrame(() => {
      const src = prepareSource(bmp!, box!, g?.adjust, PREVIEW_SIDE)
      drawFit(canvas.current!, src.src, src.box, look, PREVIEW_SIDE)
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
      for (const [i, x] of G.garments.entries()) {
        const blob = shownCut(x)
        if (!blob) {
          waiting++
          continue
        }
        const b = await loadBitmap(blob)
        try {
          files.push(toFile(await exportFit(b, alphaBox(b), look, x.adjust), `garment-${String(i + 1).padStart(2, '0')}`))
        } finally {
          b.close()
        }
      }
      if (waiting) toast({ text: `${waiting} still being processed, not included.` })
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

  function setRemover(remover: Remover) {
    if (!g) return
    p.setSettings({ ...p.settings, remover })
    if (remover === g.remover) return
    if (g.editedCut && !confirm('Switching the remover discards your brush edits on this photo.')) return
    G.update(g.id, { remover, autoCut: undefined, editedCut: undefined })
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
          </button>
        ) : editing && cutBlob && g.removeBg ? (
          <MaskEditor
            key={g.id}
            active={p.active}
            src={g.photo}
            cut={cutBlob}
            auto={g.autoCut ?? g.photo}
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
                <button className="btn-text" onClick={() => G.update(g.id, { removeBg: false })}>
                  Keep the background
                </button>
              </div>
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
                title="Erase or restore parts by hand (E)"
              >
                <IconBrush /> Erase / restore
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
              remover: g.remover,
              setRemover,
              adjust: g.adjust ?? { exposure: 0, contrast: 0, saturation: 0, warmth: 0 },
              setAdjust: (adjust: Adjust) => G.update(g.id, { adjust }),
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
      {dragging && <div className="drop-hint">Drop photos to add them</div>}
    </div>
  )
}
