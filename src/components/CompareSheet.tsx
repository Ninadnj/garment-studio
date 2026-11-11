import { useEffect, useRef, useState } from 'react'
import { cutIssues } from '../lib/checks'
import { CUT_ISSUE_TEXT, type CutIssue } from '../lib/cutcheck'
import { type CutoutProgress, cleanOnlineCutout, cutout } from '../lib/cutout'
import type { GarmentRec } from '../lib/db'
import { shownCut } from '../lib/garments'
import { useObjectURL } from '../lib/hooks'
import type { Remover } from '../lib/settings'
import { Sheet } from './Sheet'
import { Spinner } from './ui'

type Way = Remover | 'online'

// The two that run on the device, by what the seller needs to know rather than by their makers' names.
const ON_DEVICE: { way: Remover; label: string; mb: number }[] = [
  { way: 'rmbg14', label: 'Standard', mb: 88 },
  { way: 'isnet_fp16', label: 'Second method', mb: 80 },
]

interface Result {
  cut?: Blob
  busy?: string
  error?: string
  issues?: CutIssue[]
}

function progressText(p: CutoutProgress) {
  if (p.stage === 'download') return p.ratio < 1 ? `Downloading · ${Math.round(p.ratio * 100)}%` : 'Preparing'
  return p.stage === 'refine' ? 'Cleaning up the edges' : 'Removing background'
}

/**
 * The same photo cut out in other ways, side by side on the chosen background; the seller taps the cleaner
 * one. Nothing runs until asked: each way downloads a model once, or sends the photo online.
 */
export function CompareSheet({
  g,
  bg,
  token,
  onUse,
  onClose,
}: {
  g: GarmentRec
  bg: string
  token?: string
  onUse: (patch: Partial<GarmentRec>) => void
  onClose: () => void
}) {
  // With hand fixes on the photo, the automatic result it started from is already there to go back to.
  const [results, setResults] = useState<Partial<Record<Way, Result>>>(() =>
    g.editedCut && g.autoCut ? { [g.remover]: { cut: g.autoCut } } : {},
  )
  const [big, setBig] = useState<string>()
  // Made by the effect, not once for the component: in development React runs the cleanup once before use.
  const stop = useRef<AbortController>(null)
  useEffect(() => {
    const c = new AbortController()
    stop.current = c
    return () => c.abort()
  }, [])
  const now = shownCut(g)
  const set = (way: Way, r: Result) => setResults((all) => ({ ...all, [way]: r }))

  async function run(way: Way) {
    const { signal } = stop.current!
    set(way, { busy: way === 'online' ? 'Sending the photo' : 'Removing background' })
    try {
      const cut =
        way === 'online'
          ? await cleanOnlineCutout(g.photo, { token, signal })
          : await cutout(g.photo, way, (p) => !signal.aborted && set(way, { busy: progressText(p) }))
      if (signal.aborted) return
      set(way, { cut, issues: await cutIssues(cut).catch(() => []) })
    } catch (e) {
      if (signal.aborted) return
      console.error(e)
      set(way, { error: way === 'online' ? (e as Error).message : 'Background removal failed.' })
    }
  }

  function use(way: Way, cut: Blob) {
    if (g.editedCut && !confirm('This replaces your hand fixes on this photo.')) return
    // The online result is kept like a hand fix: it goes to the team as it is, so no other device has to
    // send the photo again. A result made on the device is made again there with the same method.
    onUse(way === 'online' ? { editedCut: cut } : { remover: way, autoCut: cut, editedCut: undefined })
    onClose()
  }

  const others = ON_DEVICE.filter((o) => o.way !== g.remover || g.editedCut)

  // Closing throws away what was made here, and an online try that is already used.
  function confirmClose() {
    const all = Object.values(results)
    if (all.some((r) => r.busy)) return confirm('Close? The cutout still being made will be lost.')
    if (all.some((r) => r.cut && r.cut !== g.autoCut)) return confirm('Close without using the cutouts made here?')
    return true
  }

  return (
    <Sheet title="Try another way" onClose={onClose} confirmClose={confirmClose}>
      <p className="muted small">The same photo, cut out differently. Tap a picture to enlarge it.</p>
      <div className="compare-grid">
        {now && (
          <Tile label="Now" cut={now} bg={bg} big={big === 'now'} onZoom={() => setBig(big === 'now' ? undefined : 'now')}>
            <span className="muted small">In use</span>
          </Tile>
        )}
        {others.map((o) => (
          <WayTile
            key={o.way}
            label={o.label}
            hint={`On this device. Downloads ${o.mb} MB the first time.`}
            result={results[o.way]}
            bg={bg}
            big={big === o.way}
            onZoom={() => setBig(big === o.way ? undefined : o.way)}
            onRun={() => run(o.way)}
            onUse={(cut) => use(o.way, cut)}
          />
        ))}
        <WayTile
          label="Online"
          hint="Sends this photo to Hugging Face (BiRefNet). A few free tries a day."
          result={results.online}
          bg={bg}
          big={big === 'online'}
          onZoom={() => setBig(big === 'online' ? undefined : 'online')}
          onRun={() => run('online')}
          onUse={(cut) => use('online', cut)}
        />
      </div>
    </Sheet>
  )
}

function WayTile({
  label,
  hint,
  result,
  bg,
  big,
  onZoom,
  onRun,
  onUse,
}: {
  label: string
  hint: string
  result?: Result
  bg: string
  big: boolean
  onZoom: () => void
  onRun: () => void
  onUse: (cut: Blob) => void
}) {
  if (result?.cut)
    return (
      <Tile label={label} cut={result.cut} bg={bg} big={big} onZoom={onZoom}>
        {result.issues?.map((i) => (
          <span key={i} className="muted small">
            {CUT_ISSUE_TEXT[i]}
          </span>
        ))}
        <button className="btn-secondary" onClick={() => onUse(result.cut!)}>
          Use this
        </button>
      </Tile>
    )
  return (
    <div className="compare-tile">
      <div className="compare-empty">
        {result?.busy ? (
          <span className="muted small" role="status">
            <Spinner /> {result.busy}
          </span>
        ) : (
          <button className="btn-secondary" onClick={onRun}>
            {result?.error ? 'Try again' : 'Try'}
          </button>
        )}
      </div>
      <strong>{label}</strong>
      {result?.error ? (
        <span className="error small" role="alert">
          {result.error}
        </span>
      ) : (
        <span className="muted small">{hint}</span>
      )}
    </div>
  )
}

function Tile({
  label,
  cut,
  bg,
  big,
  onZoom,
  children,
}: {
  label: string
  cut: Blob
  bg: string
  big: boolean
  onZoom: () => void
  children: React.ReactNode
}) {
  const url = useObjectURL(cut)
  return (
    <div className={`compare-tile ${big ? 'big' : ''}`}>
      <button
        className={`compare-picture ${bg === 'transparent' ? 'checker' : ''}`}
        style={bg === 'transparent' ? undefined : { background: bg }}
        onClick={onZoom}
        aria-label={big ? `${label}: make smaller` : `${label}: enlarge`}
      >
        {url && <img src={url} alt={`${label} cutout`} />}
      </button>
      <strong>{label}</strong>
      {children}
    </div>
  )
}
