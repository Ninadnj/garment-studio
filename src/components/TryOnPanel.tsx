import { useRef, useState } from 'react'
import type { Adjust } from '../lib/adjust'
import { type Box, productImage } from '../lib/compose'
import type { LookRec, ModelRec } from '../lib/db'
import { type RunStatus, tryOn } from '../lib/fashn'
import { type GarmentKind, SpaceError, freeTryOn } from '../lib/hf'
import { useElapsed } from '../lib/hooks'
import { blobToDataURL, dataURLToBlob, downscale, uid } from '../lib/image'
import { type Settings, creditCost } from '../lib/settings'
import { IconPlus, IconUpload } from './Icons'
import { LookCard } from './LookCard'
import { Chips, Spinner, Thumb } from './ui'

const KINDS: GarmentKind[] = ['top', 'bottom', 'dress']
const KIND_LABELS: Record<GarmentKind, string> = { top: 'Top', bottom: 'Bottom', dress: 'Dress' }
// Which free service makes each kind (see freeTryOn).
const FREE_LABELS: Record<GarmentKind, string> = {
  top: 'Free · Kolors',
  bottom: 'Free · WeShop',
  dress: 'Free · Kolors',
}

// One garment on one model, with the images already prepared: "Try again" repeats exactly this, even after
// another garment is shown (its bitmap is closed then).
interface Attempt {
  free: boolean
  modelId: string
  productId?: string
  note: string
  run: (update: (patch: Partial<Job>) => void) => Promise<Blob>
}

interface Job {
  id: string
  started: number
  status: RunStatus | 'preparing'
  position?: number // place in the free queue
  service?: string // free service working on it
  error?: string
  quota?: boolean
  lookId?: string
  attempt?: Attempt
}

const STATUS_TEXT: Record<Job['status'], string> = {
  preparing: 'Preparing images',
  starting: 'Starting',
  in_queue: 'In queue',
  processing: 'Generating',
  completed: 'Done',
  failed: 'Failed',
}

// `kind` is kept with each garment, so a top isn't sent to the bottoms service after a pair of trousers.
type PanelGarment = {
  bmp: ImageBitmap
  box: Box
  adjust?: Adjust
  kind: GarmentKind
  setKind: (kind: GarmentKind) => void
  productId?: string // results are listed with the product
}

export function TryOnPanel(p: {
  garment?: PanelGarment
  settings: Settings
  models: ModelRec[]
  looks: LookRec[]
  bg: string
  selectedModelId?: string
  selectModel: (id: string) => void
  onNewModel: () => void
  onUploadModel: (file: File) => void
  onLookSaved: (rec: LookRec) => void
  makeCutout: (rec: LookRec) => void
  cutoutBusy: Set<string>
  goSettings: () => void
}) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [note, setNote] = useState('')
  const kind = p.garment?.kind ?? 'top'
  const modelInput = useRef<HTMLInputElement>(null)
  // Keys are read when a job runs, so a retry uses the token or key just fixed in Settings.
  const settings = useRef(p.settings)
  settings.current = p.settings
  const free = p.settings.ai === 'free'
  const model = p.models.find((m) => m.id === p.selectedModelId)
  const cost = creditCost(p.settings)

  async function prepare(g: PanelGarment, model: ModelRec): Promise<Attempt> {
    const text = note.trim()
    if (free) {
      // The free models work at 768 × 1024; smaller uploads are faster.
      const [product, person] = await Promise.all([
        productImage(g.bmp, g.box, g.adjust, 1024),
        downscale(model.image, 1024, 'image/jpeg', true),
      ])
      return {
        free,
        modelId: model.id,
        productId: g.productId,
        note: text,
        run: async (update) => {
          const out = await freeTryOn(product, person, g.kind, text, {
            token: settings.current.hfToken || undefined,
            onStatus: (s) =>
              update(
                s.stage === 'queue'
                  ? { status: 'in_queue', position: s.position, service: s.service }
                  : { status: 'processing', service: s.service },
              ),
          })
          // The free services answer in WebP or large PNG; kept as JPEG so saved files open in every app.
          return downscale(out, Infinity)
        },
      }
    }
    const [product, person] = await Promise.all([
      productImage(g.bmp, g.box, g.adjust).then(blobToDataURL),
      downscale(model.image, 2048, 'image/jpeg', true).then(blobToDataURL),
    ])
    return {
      free,
      modelId: model.id,
      productId: g.productId,
      note: text,
      run: async (update) => {
        const s = settings.current
        const [out] = await tryOn(s.fashnKey, product, person, text, s, (status) => update({ status }))
        return dataURLToBlob(out)
      },
    }
  }

  /** Puts the garment on the model, or repeats an earlier attempt. */
  async function dress(again?: Attempt) {
    if (!again && (!p.garment || !model)) return
    const job: Job = { id: uid(), started: Date.now(), status: 'preparing' }
    const update = (patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, ...patch } : j)))
    setJobs((js) => [job, ...js])
    try {
      const attempt = again ?? (await prepare(p.garment!, model!))
      update({ status: 'starting', attempt })
      const image = await attempt.run(update)
      const rec: LookRec = {
        id: uid(),
        image,
        createdAt: Date.now(),
        modelId: attempt.modelId,
        productId: attempt.productId,
        note: attempt.note || undefined,
      }
      p.onLookSaved(rec)
      update({ status: 'completed', lookId: rec.id })
      p.makeCutout(rec)
    } catch (e) {
      update({ status: 'failed', error: (e as Error).message, quota: e instanceof SpaceError && e.quota })
    }
  }

  const ready = free || !!p.settings.fashnKey

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>On a model</h2>
          <span className="muted small">
            {free ? FREE_LABELS[kind] : `FASHN · ${cost} credit${cost === 1 ? '' : 's'} per image`}
          </span>
        </div>
        <div className="model-strip">
          <button className="model-tile add" onClick={p.onNewModel}>
            <IconPlus />
            <span>New model</span>
          </button>
          <button className="model-tile add" onClick={() => modelInput.current?.click()}>
            <IconUpload />
            <span>Upload photo</span>
          </button>
          <input
            ref={modelInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) p.onUploadModel(f)
            }}
          />
          {p.models.map((m) => (
            <button
              key={m.id}
              className="model-tile"
              aria-pressed={m.id === p.selectedModelId}
              aria-label="Model"
              onClick={() => p.selectModel(m.id)}
            >
              <Thumb blob={m.image} alt="" />
            </button>
          ))}
        </div>
        {free && p.garment && (
          <div className="field">
            <div className="field-label">Garment</div>
            <Chips
              label="Garment type"
              options={KINDS}
              labels={KIND_LABELS}
              value={kind}
              onChange={p.garment.setKind}
            />
          </div>
        )}
        {/* Of the free services only IDM-VTON reads a description, for tops when Kolors is busy. */}
        {(!free || kind === 'top') && (
          <input
            className="input"
            placeholder={
              free ? 'What is it? Used if Kolors is busy, e.g. black cotton T-shirt' : 'Styling note, e.g. tucked in'
            }
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
        {ready ? (
          <button className="btn wide" onClick={() => dress()} disabled={!p.garment || !model}>
            {!p.garment ? 'Add a garment first' : !model ? 'Choose a model' : 'Put it on the model'}
          </button>
        ) : (
          <button className="btn-secondary wide" onClick={p.goSettings}>
            Add your FASHN API key in Settings
          </button>
        )}
      </div>

      {jobs.length > 0 && (
        <div className="results">
          {jobs.map((j) => {
            const rec = j.lookId ? p.looks.find((l) => l.id === j.lookId) : undefined
            // A finished job whose image was deleted (in the Library) has nothing left to show.
            if (j.status === 'completed' && !rec) return null
            if (rec)
              return (
                <LookCard
                  key={j.id}
                  look={rec}
                  bg={p.bg}
                  cutoutBusy={p.cutoutBusy.has(rec.id)}
                  onMakeCutout={() => p.makeCutout(rec)}
                />
              )
            return (
              <JobCard
                key={j.id}
                job={j}
                hasToken={!!p.settings.hfToken}
                onDismiss={() => setJobs((js) => js.filter((x) => x.id !== j.id))}
                onRetry={() => {
                  setJobs((js) => js.filter((x) => x.id !== j.id))
                  // After a switch between the free service and FASHN the images are prepared again.
                  dress(j.attempt?.free === free ? j.attempt : undefined)
                }}
                onSettings={p.goSettings}
              />
            )
          })}
        </div>
      )}
    </>
  )
}

function JobCard({
  job,
  hasToken,
  onDismiss,
  onRetry,
  onSettings,
}: {
  job: Job
  hasToken: boolean
  onDismiss: () => void
  onRetry: () => void
  onSettings: () => void
}) {
  const failed = job.status === 'failed'
  const secs = useElapsed(failed ? undefined : job.started)
  if (failed)
    return (
      <div className="job failed">
        <p className="error">{job.error}</p>
        <div className="row">
          {job.quota ? (
            <button className="btn-small" onClick={onSettings}>
              {hasToken ? 'Settings' : 'Add a token'}
            </button>
          ) : (
            <button className="btn-small" onClick={onRetry}>
              Try again
            </button>
          )}
          <button className="btn-text" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    )
  return (
    <div className="job">
      <Spinner />
      <span>
        {STATUS_TEXT[job.status]}
        {job.service ? ` · ${job.service}` : ''}
        {job.status === 'in_queue' && job.position ? ` · position ${job.position}` : ''} · {secs}s
      </span>
    </div>
  )
}
