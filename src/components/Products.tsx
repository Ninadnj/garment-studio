import { useEffect, useMemo, useState } from 'react'
import type { GarmentRec, ProductRec } from '../lib/db'
import type { Audience } from '../lib/db'
import {
  AUDIENCES,
  AUDIENCE_LABELS,
  type Products,
  STATUSES,
  STATUS_LABELS,
  availableStock,
  currentPrice,
  formatPrice,
  matches,
  sizesInStock,
  stockText,
} from '../lib/products'
import type { Currency } from '../lib/settings'
import { IconPlus, IconSearch, IconTag } from './Icons'
import { Chips, Thumb } from './ui'

const FILTERS = ['available', ...STATUSES, 'all'] as const
type Filter = (typeof FILTERS)[number]
const FILTER_LABELS: Record<Filter, string> = { available: 'Available', all: 'All', ...STATUS_LABELS }

/** A product's photos, in the order of the Studio's photo strip. */
export const photosOf = (p: ProductRec, garments: GarmentRec[]) =>
  garments.filter((g) => g.productId === p.id).sort((a, b) => b.createdAt - a.createdAt)

/** The photo shown for a product: its cover, else its first photo. */
export function coverOf(p: ProductRec, garments: GarmentRec[]) {
  const photos = photosOf(p, garments)
  return photos.find((g) => g.id === p.coverId) ?? photos[0]
}

export function ProductsView({
  P,
  garments,
  currency,
  open,
}: {
  P: Products
  garments: GarmentRec[]
  currency: Currency
  open: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Filter>('available')
  const [size, setSize] = useState<string>()
  const [audience, setAudience] = useState<Audience>()
  const sizes = useMemo(() => sizesInStock(P.products), [P.products])
  const audiences = useMemo(() => AUDIENCES.filter((a) => P.products.some((p) => p.audience === a)), [P.products])
  const shown = useMemo(
    () =>
      P.products.filter((p) =>
        matches(p, {
          query,
          status,
          size: sizes.includes(size!) ? size : undefined,
          audience: audiences.includes(audience!) ? audience : undefined,
        }),
      ),
    [P.products, query, status, size, sizes, audience, audiences],
  )
  const inStock = shown.reduce((n, p) => n + availableStock(p), 0)

  // A filter whose size or group is gone (sold out, deleted) is cleared, not kept hidden.
  useEffect(() => {
    if (size && !sizes.includes(size)) setSize(undefined)
    if (audience && !audiences.includes(audience)) setAudience(undefined)
  }, [size, sizes, audience, audiences])

  return (
    <div className="page">
      <div className="page-head">
        <h1>Products</h1>
        <button className="btn" onClick={() => open(P.create().id)} disabled={!P.loaded}>
          <IconPlus /> New product
        </button>
      </div>
      {!P.loaded ? null : P.products.length === 0 ? (
        <p className="muted empty">
          No products yet. In the Studio, “Make a product” turns the photo on screen into one. You can also start one
          here and add photos to it.
        </p>
      ) : (
        <>
          <label className="search">
            <IconSearch />
            <input
              className="input"
              type="search"
              placeholder="Name, code, brand, colour…"
              aria-label="Search products"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="filters">
            <Chips label="Status" options={FILTERS} labels={FILTER_LABELS} value={status} onChange={setStatus} />
            {audiences.length > 1 && (
              <div className="chips" role="radiogroup" aria-label="For">
                {audiences.map((a) => (
                  <button
                    key={a}
                    className="chip"
                    role="radio"
                    aria-checked={audience === a}
                    onClick={() => setAudience(audience === a ? undefined : a)}
                  >
                    {AUDIENCE_LABELS[a]}
                  </button>
                ))}
              </div>
            )}
            {sizes.length > 0 && (
              <div className="chips" role="radiogroup" aria-label="Size in stock">
                {sizes.map((s) => (
                  <button
                    key={s}
                    className="chip"
                    role="radio"
                    aria-checked={size === s}
                    onClick={() => setSize(size === s ? undefined : s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="muted small" role="status">
            {shown.length} product{shown.length === 1 ? '' : 's'} · {inStock} in stock
          </p>
          {shown.length ? (
            <div className="grid products-grid">
              {shown.map((p) => (
                <ProductCard
                  key={p.id}
                  p={p}
                  cover={coverOf(p, garments)}
                  currency={currency}
                  onOpen={() => open(p.id)}
                />
              ))}
            </div>
          ) : (
            <p className="muted empty">No product matches.</p>
          )}
        </>
      )}
    </div>
  )
}

function ProductCard({
  p,
  cover,
  currency,
  onOpen,
}: {
  p: ProductRec
  cover?: GarmentRec
  currency: Currency
  onOpen: () => void
}) {
  const stock = stockText(p)
  const price = currentPrice(p)
  const reserved = p.status === 'reserved' && p.reservedFor
  return (
    <button className="product-card" onClick={onOpen}>
      <div className="product-thumb">{cover?.thumb ? <Thumb blob={cover.thumb} alt="" /> : <IconTag />}</div>
      <div className="product-info">
        <span className="product-name">{p.name || 'Untitled'}</span>
        <span className="product-meta">
          {[formatPrice(price, currency), stock || (p.sizes.length && p.status !== 'sold' ? 'Out of stock' : '')]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className={`badge status-${p.status}`}>
          {STATUS_LABELS[p.status]}
          {reserved ? ` · ${p.reservedFor}` : ''}
        </span>
      </div>
    </button>
  )
}
