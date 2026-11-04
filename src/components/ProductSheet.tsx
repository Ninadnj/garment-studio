import { useEffect, useRef, useState } from 'react'
import type { LookRec, ProductRec } from '../lib/db'
import type { Garments } from '../lib/garments'
import {
  AUDIENCES,
  AUDIENCE_LABELS,
  CATEGORIES,
  CHANNELS,
  CONDITIONS,
  type Products,
  SIZE_SYSTEMS,
  SIZE_SYSTEM_IDS,
  STATUSES,
  STATUS_LABELS,
  detailsText,
  parsePrice,
  sameCode,
  statusPatch,
  stockPatch,
  totalStock,
} from '../lib/products'
import type { Currency } from '../lib/settings'
import { IconCopy, IconPlus, IconTrash } from './Icons'
import { photosOf } from './Products'
import { Sheet } from './Sheet'
import { useToast } from './Toast'
import { Chips, Field, Thumb } from './ui'

const COLOURS = [
  'Black',
  'White',
  'Grey',
  'Beige',
  'Brown',
  'Navy',
  'Blue',
  'Green',
  'Red',
  'Pink',
  'Purple',
  'Yellow',
  'Orange',
  'Multicolour',
]

/** Chips where one or none is chosen; tapping the chosen one clears it. */
function OneOf<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  labels?: Partial<Record<T, string>>
  value: T | '' | undefined
  onChange: (v: T | undefined) => void
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          className="chip"
          role="radio"
          aria-checked={o === value}
          onClick={() => onChange(o === value ? undefined : o)}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  )
}

/** The offered spelling of `text` when it matches one regardless of capitals ("black" → "Black"). */
const asOffered = (text: string, offered: string[]) => offered.find((o) => o.toLowerCase() === text.toLowerCase()) ?? text

/** Chips where any number are chosen, plus a field for one that isn't offered. */
function SomeOf({
  label,
  options,
  value,
  onChange,
  other,
}: {
  label: string
  options: string[]
  value: string[]
  onChange: (v: string[]) => void
  other: string // placeholder of the field
}) {
  const [text, setText] = useState('')
  const extra = value.filter((v) => !options.includes(v))
  return (
    <>
      <div className="chips" role="group" aria-label={label}>
        {[...options, ...extra].map((o) => (
          <button
            key={o}
            className="chip"
            aria-pressed={value.includes(o)}
            onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}
          >
            {o}
          </button>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          const t = asOffered(text.trim(), options)
          if (t && !value.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...value, t])
          setText('')
        }}
      >
        <input className="input grow" placeholder={other} aria-label={other} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn-secondary" disabled={!text.trim()} aria-label={`Add: ${other.toLowerCase()}`}>
          Add
        </button>
      </form>
    </>
  )
}

/**
 * A money field typed as text, so "12," on the way to "12,50" isn't wiped, and "1 200" reads as 1200. Text
 * that can't be read is not saved, says so, and goes back to the saved price when the field is left.
 */
function MoneyInput({ value, onChange, label }: { value?: number; onChange: (v?: number) => void; label: string }) {
  const shown = (v?: number) => (v === undefined ? '' : String(v))
  const [text, setText] = useState(() => shown(value))
  const bad = Number.isNaN(parsePrice(text))
  return (
    <>
      <input
        className="input"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={bad}
        value={text}
        placeholder="e.g. 45"
        onChange={(e) => {
          setText(e.target.value)
          const n = parsePrice(e.target.value)
          if (!Number.isNaN(n)) onChange(n)
        }}
        onBlur={() => bad && setText(shown(value))}
      />
      {bad && <div className="field-hint error-hint">Not saved: type a number, e.g. 1200 or 12,50.</div>}
    </>
  )
}

/** A stock count that can be cleared and retyped; the steppers next to it change it too. */
function StockInput({ size, value, onChange }: { size: string; value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText((t) => (t !== '' && Number(t) === value ? t : String(value))), [value])
  return (
    <input
      className="input stock-input"
      inputMode="numeric"
      aria-label={`${size}: stock`}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/\D/g, '')
        setText(t)
        if (t !== '') onChange(Number(t))
      }}
      onBlur={() => text === '' && setText(String(value))}
    />
  )
}

export function ProductSheet({
  product: p,
  P,
  G,
  looks,
  currency,
  shopInfo,
  onShowPhoto,
  onOpen,
  onClose,
  onDeleted,
}: {
  product: ProductRec
  P: Products
  G: Garments
  looks: LookRec[]
  currency: Currency
  shopInfo: string
  onShowPhoto: (garmentId: string) => void
  onOpen: (productId: string) => void
  onClose: () => void
  onDeleted: (rec: ProductRec) => void
}) {
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [otherSize, setOtherSize] = useState('')
  const set = (patch: Partial<ProductRec>) => P.update(p.id, patch)

  const photos = photosOf(p, G.garments)
  const coverId = photos.some((g) => g.id === p.coverId) ? p.coverId : photos[0]?.id
  const results = looks.filter((l) => l.productId === p.id)
  const stock = totalStock(p)
  const system = p.sizeSystem ?? 'letter'

  function setStock(size: string, value: number) {
    const n = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
    set(stockPatch(p, p.sizes.map((s) => (s.size === size ? { ...s, stock: n } : s))))
  }

  function addSize(size: string) {
    const s = asOffered(size.trim(), SIZE_SYSTEMS[system].sizes)
    if (!s || p.sizes.some((x) => x.size.toLowerCase() === s.toLowerCase())) return
    set(stockPatch(p, [...p.sizes, { size: s, stock: 1 }]))
  }

  async function addPhotos(files: File[]) {
    const { ids, failed } = await G.add(files, undefined, { productId: p.id })
    // The first photo picked is the cover, unless there is one.
    if (ids.length && !coverId) set({ coverId: ids[0] })
    if (failed)
      toast({
        text: failed === 1 ? 'One file could not be opened as an image.' : `${failed} files could not be opened as images.`,
        error: true,
      })
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(detailsText(p, currency, shopInfo))
      toast({ text: 'Details copied' })
    } catch {
      toast({ text: 'Copying is not allowed here.', error: true })
    }
  }

  /** The same design in another colour: everything but the photos, colours, stock and sale history. */
  function copyAsNewColour() {
    const { id: _id, createdAt: _c, updatedAt: _u, code: _code, coverId: _cover, soldAt: _sold, ...rest } = p
    const rec = P.create({
      ...rest,
      colours: [],
      sizes: p.sizes.map((s) => ({ ...s, stock: 0 })),
      status: 'draft',
      reservedFor: undefined,
      reservedUntil: undefined,
      postedOn: [],
    })
    onOpen(rec.id)
  }

  function remove() {
    if (!confirm(`Delete ${p.name ? `“${p.name}”` : 'this product'}? Its photos stay in the Studio.`)) return
    const rec = P.remove(p.id)
    onClose()
    if (rec) onDeleted(rec)
  }

  const quickSizes = SIZE_SYSTEMS[system].sizes.filter((s) => !p.sizes.some((x) => x.size.toLowerCase() === s.toLowerCase()))
  const twins = sameCode(p, P.products)

  return (
    <Sheet title={p.name || 'Untitled'} onClose={onClose}>
      <Field label="Photos" hint={photos.length ? 'Tap a photo to open it in the Studio.' : undefined}>
        <div className="product-photos">
          {photos.map((g, i) => (
            <div key={g.id} className="product-photo">
              <button
                className="product-photo-open"
                onClick={() => onShowPhoto(g.id)}
                aria-label={`Photo ${i + 1}${g.id === coverId ? ', cover' : ''}: open in the Studio`}
              >
                {g.thumb && <Thumb blob={g.thumb} alt="" />}
              </button>
              {g.id === coverId ? (
                <span className="badge">Cover</span>
              ) : (
                <button className="btn-text small" onClick={() => set({ coverId: g.id })} aria-label={`Make photo ${i + 1} the cover`}>
                  Make cover
                </button>
              )}
            </div>
          ))}
          <button className="product-photo add" onClick={() => fileInput.current?.click()}>
            <IconPlus />
            <span>Add photos</span>
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length) addPhotos(files)
          }}
        />
      </Field>

      <Field label="Name">
        <input
          className="input"
          aria-label="Name"
          value={p.name}
          placeholder="e.g. Linen shirt, white"
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>

      <div className="field-pair">
        <Field label={`Price (${currency})`}>
          <MoneyInput label="Price" value={p.price} onChange={(price) => set({ price })} />
        </Field>
        <Field label={`Sale price (${currency})`}>
          <MoneyInput label="Sale price" value={p.salePrice} onChange={(salePrice) => set({ salePrice })} />
        </Field>
      </div>

      <Field label="Status" hint={p.status === 'sold' && p.soldAt ? `Sold on ${new Date(p.soldAt).toLocaleDateString()}.` : undefined}>
        <Chips
          label="Status"
          options={STATUSES}
          labels={STATUS_LABELS}
          value={p.status}
          onChange={(status) => set(statusPatch(p, status))}
        />
      </Field>

      {p.status === 'reserved' && (
        <div className="field-pair">
          <Field label="Reserved for">
            <input
              className="input"
              aria-label="Reserved for"
              value={p.reservedFor ?? ''}
              placeholder="Name, @handle or phone"
              onChange={(e) => set({ reservedFor: e.target.value })}
            />
          </Field>
          <Field label="Until">
            <input
              className="input"
              type="date"
              aria-label="Reserved until"
              value={p.reservedUntil ?? ''}
              onChange={(e) => set({ reservedUntil: e.target.value || undefined })}
            />
          </Field>
        </div>
      )}

      <Field
        label="Sizes and stock"
        hint={p.sizes.length ? `${stock} in stock in total. Selling the last piece marks it sold.` : undefined}
      >
        <OneOf
          label="Size system"
          options={SIZE_SYSTEM_IDS}
          labels={Object.fromEntries(SIZE_SYSTEM_IDS.map((id) => [id, SIZE_SYSTEMS[id].label]))}
          value={system}
          onChange={(sizeSystem) => set({ sizeSystem: sizeSystem ?? 'letter' })}
        />
        {p.sizes.length > 0 && (
          <div className="stock-list">
            {p.sizes.map((s) => (
              <div className="stock-row" key={s.size}>
                <span className="stock-size">{s.size}</span>
                <button
                  className="icon-btn"
                  aria-label={`${s.size}: one less`}
                  disabled={s.stock === 0}
                  onClick={() => setStock(s.size, s.stock - 1)}
                >
                  −
                </button>
                <StockInput size={s.size} value={s.stock} onChange={(n) => setStock(s.size, n)} />
                <button className="icon-btn" aria-label={`${s.size}: one more`} onClick={() => setStock(s.size, s.stock + 1)}>
                  +
                </button>
                <span className="spacer" />
                <button
                  className="btn-text"
                  aria-label={`Remove ${s.size}`}
                  onClick={() => set(stockPatch(p, p.sizes.filter((x) => x.size !== s.size)))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chips" role="group" aria-label="Add a size">
          {quickSizes.map((s) => (
            <button key={s} className="chip" onClick={() => addSize(s)}>
              + {s}
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            addSize(otherSize)
            setOtherSize('')
          }}
        >
          <input
            className="input grow"
            placeholder="Another size, e.g. W30 L32"
            aria-label="Another size"
            value={otherSize}
            onChange={(e) => setOtherSize(e.target.value)}
          />
          <button className="btn-secondary" disabled={!otherSize.trim()} aria-label="Add size">
            Add
          </button>
        </form>
      </Field>

      <Field label="Colour">
        <SomeOf label="Colour" options={COLOURS} value={p.colours} onChange={(colours) => set({ colours })} other="Another colour" />
      </Field>

      <Field label="For">
        <OneOf
          label="For"
          options={AUDIENCES}
          labels={AUDIENCE_LABELS}
          value={p.audience}
          onChange={(audience) => set({ audience })}
        />
      </Field>

      <Field label="Category">
        <OneOf label="Category" options={CATEGORIES} value={p.category} onChange={(category) => set({ category: category ?? '' })} />
      </Field>

      <Field label="Condition">
        <OneOf
          label="Condition"
          options={CONDITIONS}
          value={p.condition}
          onChange={(condition) => set({ condition: condition ?? '' })}
        />
      </Field>

      <div className="field-pair">
        <Field label="Brand">
          <input className="input" aria-label="Brand" value={p.brand} onChange={(e) => set({ brand: e.target.value })} />
        </Field>
        <Field label="Material">
          <input
            className="input"
            aria-label="Material"
            value={p.material}
            placeholder="e.g. 100% cotton"
            onChange={(e) => set({ material: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Measurements">
        <input
          className="input"
          aria-label="Measurements"
          value={p.measurements}
          placeholder="e.g. Chest 52 cm, length 70 cm"
          onChange={(e) => set({ measurements: e.target.value })}
        />
      </Field>

      <Field label="Posted on" hint="Where it is listed, so it can be taken down there once sold.">
        <SomeOf
          label="Posted on"
          options={CHANNELS}
          value={p.postedOn ?? []}
          onChange={(postedOn) => set({ postedOn })}
          other="Another place"
        />
      </Field>

      <Field
        label="Code"
        hint={
          twins.length
            ? `Also used by ${twins.map((t) => t.name || 'an untitled product').join(', ')}. Give one of them another code.`
            : undefined
        }
      >
        <input
          className="input code-input"
          aria-label="Code"
          aria-invalid={twins.length > 0}
          value={p.code}
          onChange={(e) => set({ code: e.target.value })}
        />
      </Field>

      <Field label="Notes" hint="Not in the copied details.">
        <textarea
          className="input"
          aria-label="Notes"
          rows={3}
          value={p.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </Field>

      {results.length > 0 && (
        <Field label="On models">
          <div className="product-photos">
            {results.map((l) => (
              <Thumb key={l.id} blob={l.image} alt="Try-on result" className="product-result" />
            ))}
          </div>
        </Field>
      )}

      <div className="row sheet-actions">
        <button className="btn-text danger" onClick={remove}>
          <IconTrash /> Delete
        </button>
        <button className="btn-text" onClick={copyAsNewColour}>
          Copy as new colour
        </button>
        <span className="spacer" />
        <button className="btn-secondary" onClick={copy}>
          <IconCopy /> Copy details
        </button>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  )
}
