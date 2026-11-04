import { useEffect, useRef, useState } from 'react'
import { createModel } from '../lib/fashn'
import { freeModel } from '../lib/hf'
import { useElapsed } from '../lib/hooks'
import { dataURLToBlob } from '../lib/image'
import { DEFAULT_SPEC, OPTIONS, POSE_LABELS, type ModelSpec, buildPrompt } from '../lib/modelSpec'
import { type Settings, creditCost } from '../lib/settings'
import { Sheet } from './Sheet'
import { Chips, Field, Spinner, Thumb } from './ui'

const COUNTS = ['1', '2', '4'] as const

export function NewModelSheet({
  settings,
  onClose,
  onSave,
}: {
  settings: Settings
  onClose: () => void
  onSave: (images: Blob[], prompt: string) => Promise<void>
}) {
  const [spec, setSpec] = useState<ModelSpec>(DEFAULT_SPEC)
  const [prompt, setPrompt] = useState(buildPrompt(DEFAULT_SPEC))
  const [edited, setEdited] = useState(false)
  // Free images come one at a time, about 40 s each, so it starts with one.
  const [count, setCount] = useState<(typeof COUNTS)[number]>(settings.ai === 'free' ? '1' : '2')
  const [started, setStarted] = useState<number>()
  const [service, setService] = useState<string>() // free service making the current image
  const [done, setDone] = useState(0) // free service: images finished so far (it makes one per request)
  const [error, setError] = useState<string>()
  const [results, setResults] = useState<Blob[]>([])
  const [keep, setKeep] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const secs = useElapsed(started)
  // Closing the sheet stops the images still to come; they would be thrown away (and could use free tries).
  const stop = useRef<AbortController>(undefined)
  useEffect(() => () => stop.current?.abort(), [])

  function set<K extends keyof ModelSpec>(k: K, v: ModelSpec[K]) {
    const next = { ...spec, [k]: v }
    setSpec(next)
    if (!edited) setPrompt(buildPrompt(next))
  }

  async function generate() {
    setError(undefined)
    setStarted(Date.now())
    setDone(0)
    const blobs: Blob[] = []
    const ctrl = (stop.current = new AbortController())
    try {
      if (free) {
        for (let i = 0; i < Number(count); i++) {
          setService(undefined)
          const opts = { token: settings.hfToken || undefined, signal: ctrl.signal }
          blobs.push(await freeModel(prompt, { ...opts, onStatus: (s) => setService(s.service) }))
          setDone(i + 1)
        }
      } else {
        const out = await createModel(settings.fashnKey, prompt, settings, Number(count))
        blobs.push(...(await Promise.all(out.map(dataURLToBlob))))
      }
    } catch (e) {
      if (ctrl.signal.aborted) return
      setError((e as Error).message)
    } finally {
      setStarted(undefined)
    }
    // Keep whatever finished before an error (the free allowance can run out midway).
    if (blobs.length) {
      setResults(blobs)
      setKeep(new Set(blobs.map((_, i) => i)))
    }
  }

  async function save() {
    setSaving(true)
    try {
      await onSave(
        results.filter((_, i) => keep.has(i)),
        prompt,
      )
      onClose()
    } catch (e) {
      setError(`Could not save: ${(e as Error).message}`)
      setSaving(false)
    }
  }

  const free = settings.ai === 'free'
  if (!free && !settings.fashnKey)
    return (
      <Sheet title="New model" onClose={onClose}>
        <p>
          FASHN is selected in Settings but has no API key. Add the key, switch to the free service, or upload a photo of
          a person instead.
        </p>
      </Sheet>
    )

  if (results.length)
    return (
      <Sheet title="Choose models to keep" onClose={onClose}>
        <div className="pick-grid">
          {results.map((b, i) => (
            <button
              key={i}
              className="pick"
              aria-pressed={keep.has(i)}
              onClick={() =>
                setKeep((k) => {
                  const n = new Set(k)
                  if (n.has(i)) n.delete(i)
                  else n.add(i)
                  return n
                })
              }
            >
              <Thumb blob={b} alt={`Generated model ${i + 1}`} />
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button
            className="btn-secondary"
            onClick={() => {
              setResults([])
              setError(undefined)
            }}
          >
            Back
          </button>
          <span className="spacer" />
          <button className="btn" onClick={save} disabled={!keep.size || saving}>
            Save {keep.size} model{keep.size === 1 ? '' : 's'}
          </button>
        </div>
      </Sheet>
    )

  const cost = creditCost(settings, Number(count))

  return (
    <Sheet title="New model" onClose={onClose}>
      <Field label="Gender">
        <Chips label="Gender" options={OPTIONS.gender} value={spec.gender} onChange={(v) => set('gender', v)} />
      </Field>
      <Field label="Age">
        <Chips label="Age" options={OPTIONS.age} value={spec.age} onChange={(v) => set('age', v)} />
      </Field>
      <Field label="Skin tone">
        <Chips label="Skin tone" options={OPTIONS.skin} value={spec.skin} onChange={(v) => set('skin', v)} />
      </Field>
      <Field label="Hair">
        <Chips label="Hair length" options={OPTIONS.hairLength} value={spec.hairLength} onChange={(v) => set('hairLength', v)} />
        <Chips label="Hair colour" options={OPTIONS.hairColor} value={spec.hairColor} onChange={(v) => set('hairColor', v)} />
      </Field>
      <Field label="Body">
        <Chips label="Body" options={OPTIONS.body} value={spec.body} onChange={(v) => set('body', v)} />
      </Field>
      <Field label="Pose">
        <Chips label="Pose" options={OPTIONS.pose} labels={POSE_LABELS} value={spec.pose} onChange={(v) => set('pose', v)} />
      </Field>
      <Field label="Framing">
        <Chips label="Framing" options={OPTIONS.shot} value={spec.shot} onChange={(v) => set('shot', v)} />
      </Field>
      <Field
        label="Prompt"
        hint={
          edited ? (
            <button
              className="btn-text"
              onClick={() => {
                setEdited(false)
                setPrompt(buildPrompt(spec))
              }}
            >
              Reset to the options above
            </button>
          ) : (
            'Built from the options above. Edit it freely.'
          )
        }
      >
        <textarea
          className="input"
          rows={5}
          value={prompt}
          onChange={(e) => {
            setEdited(true)
            setPrompt(e.target.value)
          }}
        />
      </Field>
      <Field label="Variations">
        <Chips label="Variations" options={COUNTS} value={count} onChange={setCount} />
      </Field>
      {error && <p className="error">{error}</p>}
      <button className="btn wide" onClick={generate} disabled={!!started || !prompt.trim()}>
        {started ? (
          <>
            <Spinner /> Generating{free && Number(count) > 1 ? ` ${done + 1} of ${count}` : ''}
            {service ? ` · ${service}` : ''} · {secs}s
          </>
        ) : free ? (
          'Generate · free'
        ) : (
          `Generate · ${cost} credit${cost === 1 ? '' : 's'}`
        )}
      </button>
      {free && (
        <p className="muted small">
          Uses HiDream, a free demo with no daily limit, one image at a time (about 40 seconds each). When HiDream is
          busy, FLUX.1 dev on Hugging Face takes over: about 3 images a day, shared with the try-on backups. Uploading
          a photo of a person works too, without a limit.
        </p>
      )}
    </Sheet>
  )
}
