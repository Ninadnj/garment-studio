import { useEffect, useRef } from 'react'
import type { GarmentRec } from '../lib/db'
import type { GarmentStatus } from '../lib/garments'
import { IconPlus, IconWarning } from './Icons'
import { Spinner, Thumb } from './ui'

/** Strip of every garment photo on this device; the selected one is in the editor above. */
export function Tray({
  garments,
  currentId,
  statusOf,
  bg,
  opening,
  onSelect,
  onAdd,
}: {
  garments: GarmentRec[]
  currentId?: string
  statusOf: (g: GarmentRec) => GarmentStatus | undefined
  bg: string
  opening: number
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  const strip = useRef<HTMLDivElement>(null)

  // Keep the selected photo in view when it changes (arrow keys, a new batch). Scrolls only the
  // strip sideways; scrollIntoView could also scroll the page.
  useEffect(() => {
    const s = strip.current
    const el = s?.querySelector('[aria-selected="true"]')
    if (!s || !el) return
    const r = el.getBoundingClientRect()
    const sr = s.getBoundingClientRect()
    if (r.left < sr.left) s.scrollBy({ left: r.left - sr.left - 8, behavior: 'smooth' })
    else if (r.right > sr.right) s.scrollBy({ left: r.right - sr.right + 8, behavior: 'smooth' })
  }, [currentId])

  return (
    <div ref={strip} className="tray" role="listbox" aria-label="Photos" aria-orientation="horizontal">
      <button className="tray-item tray-add" onClick={onAdd} aria-label="Add photos" title="Add photos">
        <IconPlus />
      </button>
      {Array.from({ length: opening }, (_, i) => (
        <div key={`opening-${i}`} className="tray-item tray-opening" aria-label="Opening photo">
          <Spinner />
        </div>
      ))}
      {garments.map((g, i) => {
        const st = statusOf(g)
        const cut = g.removeBg && !!(g.editedCut ?? g.autoCut)
        return (
          <button
            key={g.id}
            role="option"
            aria-selected={g.id === currentId}
            aria-label={`Photo ${i + 1}`}
            className={`tray-item ${cut && bg === 'transparent' ? 'checker' : ''}`}
            style={cut && bg !== 'transparent' ? { background: bg } : undefined}
            onClick={() => onSelect(g.id)}
          >
            {g.thumb && <Thumb blob={g.thumb} alt="" className={cut ? 'tray-cut' : ''} />}
            {st && st.stage !== 'error' && (
              <span className="tray-badge">
                <Spinner />
              </span>
            )}
            {st?.stage === 'error' && (
              <span className="tray-badge tray-error">
                <IconWarning />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
