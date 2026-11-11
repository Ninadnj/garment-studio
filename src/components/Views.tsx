import { useEffect, useRef, useState } from 'react'
import type { LookRec, ModelRec } from '../lib/db'
import { credits } from '../lib/fashn'
import {
  type AIService,
  type Currency,
  type GenMode,
  type LookPrefs,
  type Remover,
  type Resolution,
  type Settings,
  REMOVER_LABELS,
  creditCost,
} from '../lib/settings'
import { BackgroundPicker } from './BackgroundPicker'
import { IconClose, IconPlus, IconUpload } from './Icons'
import { LookCard } from './LookCard'
import { TeamPanel } from './TeamPanel'
import { loadConfig } from '../lib/team'
import { Chips, Field, Thumb } from './ui'

export function ModelsView({
  models,
  selectedId,
  select,
  remove,
  onNew,
  onUpload,
}: {
  models: ModelRec[]
  selectedId?: string
  select: (id: string) => void
  remove: (id: string) => void
  onNew: () => void
  onUpload: (f: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="page">
      <div className="page-head">
        <h1>Models</h1>
        <div className="row">
          <button className="btn-secondary" onClick={() => input.current?.click()}>
            <IconUpload /> Upload
          </button>
          <button className="btn" onClick={onNew}>
            <IconPlus /> New model
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) onUpload(f)
          }}
        />
      </div>
      {models.length === 0 ? (
        <p className="muted empty">
          No models yet. Generate one with AI, or upload a full-body photo of a person (plain background, fitted clothes
          work best).
        </p>
      ) : (
        <div className="grid">
          {models.map((m) => (
            <div key={m.id} className="grid-item">
              <button className="model-card" aria-pressed={m.id === selectedId} onClick={() => select(m.id)}>
                <Thumb blob={m.image} alt="Model" />
              </button>
              <button
                className="icon-btn floating"
                aria-label="Delete model"
                onClick={() => confirm('Delete this model?') && remove(m.id)}
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LibraryView({
  looks,
  look,
  setLook,
  remove,
  makeCutout,
  cutoutBusy,
}: {
  looks: LookRec[]
  look: LookPrefs
  setLook: (l: LookPrefs) => void
  remove: (id: string) => void
  makeCutout: (rec: LookRec) => void
  cutoutBusy: Set<string>
}) {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Library</h1>
      </div>
      {looks.length === 0 ? (
        <p className="muted empty">Every try-on result is kept here on this device.</p>
      ) : (
        <>
          <Field label="Background">
            <BackgroundPicker value={look.bg} onChange={(bg) => setLook({ ...look, bg })} />
          </Field>
          <div className="grid looks-grid">
            {looks.map((l) => (
              <LookCard
                key={l.id}
                look={l}
                bg={look.bg}
                cutoutBusy={cutoutBusy.has(l.id)}
                onMakeCutout={() => makeCutout(l)}
                onDelete={() => confirm('Delete this image?') && remove(l.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const CURRENCIES: Currency[] = ['GEL', 'USD', 'EUR', 'GBP']
const SERVICES: AIService[] = ['free', 'fashn']
const SERVICE_LABELS: Record<AIService, string> = { free: 'Free · Hugging Face', fashn: 'FASHN · paid' }
const MODES: GenMode[] = ['fast', 'balanced', 'quality']
const RESOLUTIONS: Resolution[] = ['1k', '2k', '4k']
const REMOVERS: Remover[] = ['rmbg14', 'isnet_fp16', 'isnet_quint8']

function useStorageUse() {
  const [mb, setMb] = useState<number>()
  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then((e) => setMb(Math.round((e.usage ?? 0) / 1e6)))
      .catch(() => {})
  }, [])
  return mb
}

function SecretInput({
  value,
  onChange,
  placeholder,
  extra,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  extra?: React.ReactNode
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="row">
      <input
        className="input grow"
        type={show ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
      />
      <button className="btn-secondary" onClick={() => setShow((s) => !s)}>
        {show ? 'Hide' : 'Show'}
      </button>
      {extra}
    </div>
  )
}

export function SettingsView({ settings, setSettings }: { settings: Settings; setSettings: (s: Settings) => void }) {
  const [balance, setBalance] = useState<string>()
  const [checking, setChecking] = useState(false)
  const storageMb = useStorageUse()
  const free = settings.ai === 'free'

  async function check() {
    setChecking(true)
    try {
      setBalance(`${await credits(settings.fashnKey)} credits left`)
    } catch (e) {
      setBalance((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <div className="panel">
        <h2>AI models and try-on</h2>
        <Field label="Service">
          <Chips label="AI service" options={SERVICES} labels={SERVICE_LABELS} value={settings.ai} onChange={(ai) => setSettings({ ...settings, ai })} />
        </Field>
        {free ? (
          <>
            <p className="muted small">
              Tops and dresses go to Kolors Virtual Try-On (a free demo run by Kuaishou), bottoms to WeShop’s free
              try-on demo, and new models to HiDream (a free demo run by HiDream.ai). None of them has a daily limit.
              When one is busy, the image is made on Hugging Face’s shared GPUs instead (IDM-VTON, Leffa or FLUX.1 dev),
              which allow about 3 images a day. Each image takes about 15–50 seconds, longer when others are queuing.
              Try-on results are about 768 × 1024 pixels, bottoms from WeShop 1520 × 2048.
            </p>
            <Field
              label="Hugging Face token (optional)"
              hint={
                <>
                  Used for the backups on the shared GPUs and for the online background remover. Hugging Face lets free users make about 3 images a
                  day there. Without a token they come out of 2 GPU minutes
                  shared by everything on your internet connection, which often covers only 2. A token from a free account
                  gives 5 minutes on your own account; one from a PRO account ($9 a month) gives 8 times that. Create a
                  token with “Read” access at{' '}
                  <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
                    huggingface.co/settings/tokens
                  </a>
                  . Stored only in this browser.
                </>
              }
            >
              <SecretInput value={settings.hfToken} placeholder="hf_…" onChange={(hfToken) => setSettings({ ...settings, hfToken })} />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="FASHN API key"
              hint={
                <>
                  Sharper results, up to 4k, and exact garment details. Get a key at{' '}
                  <a href="https://app.fashn.ai/api" target="_blank" rel="noreferrer">
                    app.fashn.ai/api
                  </a>
                  . Stored only in this browser; enter it once on each device.
                </>
              }
            >
              <SecretInput
                value={settings.fashnKey}
                placeholder="fa-…"
                onChange={(fashnKey) => {
                  setBalance(undefined)
                  setSettings({ ...settings, fashnKey })
                }}
                extra={
                  <button className="btn-secondary" onClick={check} disabled={!settings.fashnKey || checking}>
                    Check
                  </button>
                }
              />
              {balance && <div className="field-hint">{balance}</div>}
            </Field>
            <Field label="AI quality" hint="Fast ≈ 10 s, balanced ≈ 25 s, quality ≈ 55 s at the highest resolution.">
              <Chips label="AI quality" options={MODES} value={settings.mode} onChange={(mode) => setSettings({ ...settings, mode })} />
            </Field>
            <Field
              label="AI resolution"
              hint={`Each image costs ${creditCost(settings)} credit${creditCost(settings) === 1 ? '' : 's'} with these settings.`}
            >
              <Chips
                label="AI resolution"
                options={RESOLUTIONS}
                value={settings.resolution}
                onChange={(resolution) => setSettings({ ...settings, resolution })}
              />
            </Field>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Shop</h2>
        <Field label="Currency for prices" hint="Prices are not converted: this changes the currency of every price.">
          <Chips
            label="Currency"
            options={CURRENCIES}
            value={settings.currency}
            onChange={(currency) => setSettings({ ...settings, currency })}
          />
        </Field>
        <Field label="Shop name" hint="At the top of catalogue pages.">
          <input
            className="input"
            aria-label="Shop name"
            value={settings.shopName}
            onChange={(e) => setSettings({ ...settings, shopName: e.target.value })}
          />
        </Field>
        <Field label="Contact line" hint="At the bottom of catalogue pages.">
          <input
            className="input"
            aria-label="Contact line"
            placeholder="e.g. @yourshop · 555 12 34 56"
            value={settings.contactLine}
            onChange={(e) => setSettings({ ...settings, contactLine: e.target.value })}
          />
        </Field>
        <Field
          label="Added to copied details"
          hint="Your own lines under every product’s details and post captions, e.g. how to order and delivery."
        >
          <textarea
            className="input"
            aria-label="Added to copied details"
            rows={3}
            value={settings.shopInfo}
            onChange={(e) => setSettings({ ...settings, shopInfo: e.target.value })}
          />
        </Field>
      </div>

      <TeamPanel />

      <div className="panel">
        <Field
          label="Background remover for new photos"
          hint="Runs on this device, free. Each downloads once: Standard 88 MB, Second method about 80 MB, Light about 40 MB. Standard (BRIA RMBG-1.4) was the cleanest of the three on test photos; BRIA allows free non-commercial use and sells licences for commercial use. The other two are IMG.LY’s open-source remover."
        >
          <Chips
            label="Background remover"
            options={REMOVERS}
            labels={REMOVER_LABELS}
            value={settings.remover}
            onChange={(remover) => setSettings({ ...settings, remover })}
          />
        </Field>
      </div>

      <div className="panel">
        <h2>Install</h2>
        <p className="muted">
          iPhone: open in Safari → Share → Add to Home Screen.
          <br />
          Mac: Safari → File → Add to Dock, or the install icon in Chrome’s address bar.
        </p>
        <h2>Privacy</h2>
        <p className="muted">
          Photos, products, models and results are stored in this browser{loadConfig() ? '' : ' only'}
          {storageMb !== undefined ? ` (${storageMb} MB on this device)` : ''}.
          {loadConfig() && ' Products, with their photos and try-on results, are also shared with your team’s Supabase project.'}{' '}
          Background removal runs on the device; only “Try another way → Online” sends that one photo to Hugging Face. Try-on sends the photos to Kuaishou (Kolors), WeShop and Hugging Face for the free service, or to
          FASHN. WeShop also gets your IP address, and the Kolors demo passes the photos on to Kuaishou without
          encryption (http).
          New models send only their description, to HiDream and Hugging Face, or to FASHN.
        </p>
      </div>
    </div>
  )
}
