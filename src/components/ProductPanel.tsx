import { useMemo, useState } from 'react'
import type { GarmentRec } from '../lib/db'
import type { Garments } from '../lib/garments'
import { type Products, STATUS_LABELS, currentPrice, formatPrice, matches, stockText } from '../lib/products'
import type { Currency } from '../lib/settings'
import { IconSearch, IconTag } from './Icons'
import { coverOf } from './Products'
import { Sheet } from './Sheet'
import { Thumb } from './ui'

/** The product the photo on screen belongs to, or ways to make or choose one. */
export function ProductPanel({
  g,
  G,
  P,
  currency,
  openProduct,
}: {
  g: GarmentRec
  G: Garments
  P: Products
  currency: Currency
  openProduct: (id: string) => void
}) {
  // The photo the picker was opened for: the photo on screen can change while it is open.
  const [pickFor, setPickFor] = useState<string>()
  const product = P.products.find((x) => x.id === g.productId)

  function makeProduct() {
    const rec = P.create({ coverId: g.id })
    G.update(g.id, { productId: rec.id })
    openProduct(rec.id)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Product</h2>
        {product && <span className={`badge status-${product.status}`}>{STATUS_LABELS[product.status]}</span>}
      </div>
      {product ? (
        <>
          <p className="product-line">
            <strong>{product.name || 'Untitled'}</strong>
            {[
              formatPrice(currentPrice(product), currency),
              stockText(product) || (product.sizes.length && product.status !== 'sold' ? 'Out of stock' : ''),
              product.code && `Code ${product.code}`,
            ]
              .filter(Boolean)
              .map((t) => (
                <span key={t} className="muted">
                  {' '}
                  · {t}
                </span>
              ))}
          </p>
          <div className="row">
            <button className="btn-secondary" onClick={() => openProduct(product.id)}>
              Edit product
            </button>
            <button className="btn-text" onClick={() => G.update(g.id, { productId: undefined })}>
              Remove photo from product
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">This photo isn’t part of a product yet.</p>
          <div className="row">
            <button className="btn-secondary" onClick={makeProduct}>
              <IconTag /> Make a product
            </button>
            {P.products.length > 0 && (
              <button className="btn-text" onClick={() => setPickFor(g.id)}>
                Add to a product…
              </button>
            )}
          </div>
        </>
      )}
      {pickFor && (
        <ProductPicker
          G={G}
          P={P}
          currency={currency}
          onPick={(id) => {
            G.update(pickFor, { productId: id })
            setPickFor(undefined)
          }}
          onClose={() => setPickFor(undefined)}
        />
      )}
    </div>
  )
}

function ProductPicker({
  G,
  P,
  currency,
  onPick,
  onClose,
}: {
  G: Garments
  P: Products
  currency: Currency
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => P.products.filter((p) => matches(p, { query, status: 'all' })), [P.products, query])
  return (
    <Sheet title="Add to a product" onClose={onClose}>
      <label className="search">
        <IconSearch />
        <input
          className="input"
          type="search"
          autoFocus
          placeholder="Name, code, brand, colour…"
          aria-label="Search products"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="pick-list">
        {shown.map((p) => {
          const cover = coverOf(p, G.garments)
          return (
            <button key={p.id} className="pick-row" onClick={() => onPick(p.id)}>
              <span className="pick-thumb">{cover?.thumb ? <Thumb blob={cover.thumb} alt="" /> : <IconTag />}</span>
              <span className="pick-text">
                <strong>{p.name || 'Untitled'}</strong>
                <span className="muted small">
                  {[p.code && `Code ${p.code}`, formatPrice(currentPrice(p), currency), STATUS_LABELS[p.status]]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </button>
          )
        })}
        {!shown.length && <p className="muted">No product matches.</p>}
      </div>
    </Sheet>
  )
}
