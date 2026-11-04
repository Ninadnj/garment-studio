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
  const canvas = useRef<HTMLCanvasElement>(null)
  const showColour = !!cut && !original

  useEffect(() => {
    if (showColour && canvas.current) drawReplace(canvas.current, cut, bg, 1400)
  }, [showColour, cut, bg])

  async function save() {
    setSaving(true)
    try {
      const blob = showColour ? await exportReplace(cut, bg) : look.image
      await saveImage(blob, `look-${look.id.slice(0, 8)}`)
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
        <button className="btn-small" onClick={save} disabled={saving}>
          Save
        </button>
      </figcaption>
    </figure>
  )
}
