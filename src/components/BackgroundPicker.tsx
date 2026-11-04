const SWATCHES = [
  '#ffffff',
  '#f4f1ec',
  '#e9e6e1',
  '#d8d4cd',
  '#efe3d6',
  '#f3dede',
  '#e1e8dc',
  '#dbe5ee',
  '#2b2a28',
  '#000000',
]

export function BackgroundPicker({ value, onChange }: { value: string; onChange: (bg: string) => void }) {
  const custom = value !== 'transparent' && !SWATCHES.includes(value.toLowerCase())
  return (
    <div className="swatches" role="radiogroup" aria-label="Background colour">
      {SWATCHES.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          className="swatch"
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label
        className="swatch swatch-custom"
        aria-checked={custom}
        role="radio"
        title="Custom colour"
        style={custom ? { background: value } : undefined}
      >
        <input
          type="color"
          value={value === 'transparent' ? '#ffffff' : value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Custom colour"
        />
        {!custom && <span aria-hidden>+</span>}
      </label>
      <button
        role="radio"
        aria-checked={value === 'transparent'}
        aria-label="Transparent"
        title="Transparent (PNG)"
        className="swatch swatch-none"
        onClick={() => onChange('transparent')}
      />
    </div>
  )
}
