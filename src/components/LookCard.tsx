import { useEffect, useRef, useState } from 'react'
import type { LookRec } from '../lib/db'
import { drawReplace, exportReplace } from '../lib/compose'
import { useBitmap, useObjectURL } from '../lib/hooks'
import { saveImage } from '../lib/image'
import { Spinner } from './ui'

/** A try-on result. Shows it on the chosen background colour once the person has been cut out. */
export function LookCard({
  look,
  bg,
  cutoutBusy,
  onMakeCutout,
  onDelete,
}: {
  look: LookRec
  bg: string
  cutoutBusy?: boolean
  onMakeCutout?: () => void
  onDelete?: () => void
}) {
  const rawUrl = useObjectURL(look.image)
  const cut = useBitmap(look.cutout)
  const [original, setOriginal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<Blob>() // made, waiting for a tap to share
  const [problem, setProblem] = useState<string>()
  const canvas = useRef<HTMLCanvasElement>(null)
  // An image waiting for a tap was made for the colour and view of that moment.
  useEffect(() => setPending(undefined), [bg, original, look.cutout])
  const showColour = !!cut && !original

  useEffect(() => {
    if (showColour && canvas.current) drawReplace(canvas.current, cut, bg, 1400)
  }, [showColour, cut, bg])

  async function save(ready?: Blob) {
    setSaving(true)
    setProblem(undefined)
    try {
      const blob = ready ?? (showColour ? await exportReplace(cut, bg) : look.image)
      // iPhones refuse a share sheet that opens long after the tap: the image is ready now, so one more tap shares it.
      setPending((await saveImage(blob, `look-${look.id.slice(0, 8)}`)) === 'needs-tap' ? blob : undefined)
    } catch (e) {
      setProblem(`Could not save: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <figure className="look">
      <div className={`look-media ${showColour && bg === 'transparent' ? 'checker' : ''}`}>
        {showColour ? <canvas ref={canvas} /> : rawUrl && <img src={rawUrl} alt="Model wearing the garment" />}
        {cutoutBusy && (
          <div className="look-badge">
            <Spinner /> Applying background
          </div>
        )}
      </div>
      <figcaption className="look-actions">
        {look.cutout ? (
          <button className="btn-text" onClick={() => setOriginal((o) => !o)}>
            {original ? 'Your colour' : 'Original'}
          </button>
        ) : (
          onMakeCutout &&
          !cutoutBusy && (
            <button className="btn-text" onClick={onMakeCutout}>
              Apply colour
            </button>
          )
        )}
        <span className="spacer" />
        {onDelete && (
          <button className="btn-text danger" onClick={onDelete}>
            Delete
          </button>
        )}
        <button className="btn-small" onClick={() => save(pending)} disabled={saving}>
          {pending ? 'Tap to share' : 'Save'}
        </button>
      </figcaption>
      {problem && (
        <p className="error small" role="alert">
          {problem}
        </p>
      )}
    </figure>
  )
}
