import { type Adjust, NO_ADJUST, isNeutral } from '../lib/adjust'
import { type Aspect, type LookPrefs, type ShadowStyle, SHADOW_LABELS } from '../lib/settings'
import { BackgroundPicker } from './BackgroundPicker'
import { Chips, Field, Slider, Spinner } from './ui'

const ASPECTS: Aspect[] = ['1:1', '4:5', '3:4', '9:16']
// Named by where the picture goes; the numbers stay for those who know them.
const ASPECT_LABELS: Record<Aspect, string> = { '1:1': 'Square 1:1', '4:5': 'Feed 4:5', '3:4': '3:4', '9:16': 'Story 9:16' }
const SHADOWS: ShadowStyle[] = ['none', 'soft', 'close', 'floor']

/** Controls for the selected photo (background removal, light and colour) and the shared look. */
export function LookPanel({
  look,
  setLook,
  photo,
}: {
  look: LookPrefs
  setLook: (l: LookPrefs) => void
  photo?: {
    removeBg: boolean
    setRemoveBg: (on: boolean) => void
    compare?: () => void // other ways to cut this photo out; unset while there is nothing to compare with
    adjust: Adjust
    setAdjust: (a: Adjust) => void
    fixLight?: () => void // brightness and colour cast set from the photo; unset while the photo isn't ready
    fixingLight: boolean
  }
}) {
  const adj = photo?.adjust ?? NO_ADJUST
  const setAdj = (patch: Partial<Adjust>) => photo?.setAdjust({ ...adj, ...patch })
  return (
    <>
      {photo && (
        <div className="panel">
          <label className="toggle toggle-top">
            <input type="checkbox" checked={photo.removeBg} onChange={(e) => photo.setRemoveBg(e.target.checked)} />
            <span>
              Remove background
              <span className="muted small block">Turn off for close-ups like labels or fabric</span>
            </span>
          </label>
          <div className="row quick-fixes">
            <button className="btn-secondary" onClick={photo.fixLight} disabled={!photo.fixLight || photo.fixingLight}>
              {photo.fixingLight && <Spinner />} Fix light
            </button>
            {photo.removeBg && (
              <button className="btn-secondary" onClick={photo.compare} disabled={!photo.compare}>
                Try another way
              </button>
            )}
          </div>
          {/* Locked while Fix light reads the photo: its result replaces these values. */}
          <details className="adjust" open={!isNeutral(adj)} inert={photo.fixingLight}>
            <summary>
              Light and colour
              {!isNeutral(adj) && (
                <button
                  className="btn-text"
                  onClick={(e) => {
                    e.preventDefault()
                    photo.setAdjust(NO_ADJUST)
                  }}
                >
                  Reset
                </button>
              )}
            </summary>
            <Slider label="Brightness" value={adj.exposure} onChange={(exposure) => setAdj({ exposure })} />
            <Slider label="Contrast" value={adj.contrast} onChange={(contrast) => setAdj({ contrast })} />
            <Slider label="Saturation" value={adj.saturation} onChange={(saturation) => setAdj({ saturation })} />
            <Slider label="Warmth" value={adj.warmth} onChange={(warmth) => setAdj({ warmth })} />
          </details>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Look</h2>
          <span className="muted small">Same for every photo</span>
        </div>
        <Field label="Background">
          <BackgroundPicker value={look.bg} onChange={(bg) => setLook({ ...look, bg })} />
        </Field>
        {look.bg !== 'transparent' && (
          <label className="toggle field">
            <input type="checkbox" checked={look.light} onChange={(e) => setLook({ ...look, light: e.target.checked })} />
            <span>Studio light</span>
          </label>
        )}
        <Field label="Format">
          <Chips label="Format" options={ASPECTS} labels={ASPECT_LABELS} value={look.aspect} onChange={(aspect) => setLook({ ...look, aspect })} />
        </Field>
        <Field label={`Margin · ${Math.round(look.padding * 100)}%`}>
          <input
            type="range"
            min={0}
            max={0.3}
            step={0.01}
            value={look.padding}
            onChange={(e) => setLook({ ...look, padding: Number(e.target.value) })}
          />
        </Field>
        <Field label="Shadow">
          <Chips label="Shadow" options={SHADOWS} labels={SHADOW_LABELS} value={look.shadow} onChange={(shadow) => setLook({ ...look, shadow })} />
        </Field>
      </div>
    </>
  )
}
