import type { ReactNode } from 'react'
import { useObjectURL } from '../lib/hooks'

export function Chips<T extends string>({
  options,
  value,
  onChange,
  labels,
  label,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  labels?: Partial<Record<T, ReactNode>>
  label: string
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} role="radio" aria-checked={o === value} className="chip" onClick={() => onChange(o)}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

export function Thumb({ blob, alt, className }: { blob: Blob; alt: string; className?: string }) {
  const url = useObjectURL(blob)
  return url ? <img src={url} alt={alt} className={className} draggable={false} /> : <div className={className} />
}

export function Spinner() {
  return <span className="spinner" aria-hidden />
}

/** −1…1 slider shown as −100…+100; double-click (or double-tap) the label to reset to 0. */
export function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const shown = Math.round(value * 100)
  return (
    <label className="slider">
      <span className="slider-label" onDoubleClick={() => onChange(0)}>
        {label}
      </span>
      <input type="range" min={-1} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{shown > 0 ? `+${shown}` : shown}</span>
    </label>
  )
}
