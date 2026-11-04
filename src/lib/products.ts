import { useEffect, useRef, useState } from 'react'
import {
  type Audience,
  type ProductRec,
  type ProductStatus,
  type SizeStock,
  type SizeSystem,
  deleteRec,
  listAll,
  onBeforeClose,
  onOtherWindowChange,
  putRec,
  reportWriteError,
  requestPersistence,
} from './db'
import { uid } from './image'
import type { Currency } from './settings'

export const STATUSES: ProductStatus[] = ['for_sale', 'draft', 'reserved', 'sold']

export const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Draft',
  for_sale: 'For sale',
  reserved: 'Reserved',
  sold: 'Sold',
}

export const CATEGORIES = [
  'Tops',
  'Shirts',
  'Knitwear',
  'Jackets & coats',
  'Dresses',
  'Jumpsuits',
  'Skirts',
  'Trousers & jeans',
  'Shorts',
  'Shoes',
  'Bags',
  'Accessories',
]

// The scale most second-hand marketplaces use (Vinted, Depop, eBay pre-owned).
export const CONDITIONS = ['New with tags', 'New without tags', 'Very good', 'Good', 'Satisfactory']

export const AUDIENCES: Audience[] = ['women', 'men', 'unisex', 'kids']
export const AUDIENCE_LABELS: Record<Audience, string> = { women: 'Women', men: 'Men', unisex: 'Unisex', kids: 'Kids' }

// Where a product can be listed; any other name can be added by hand.
export const CHANNELS = ['Instagram', 'Facebook', 'Marketplace', 'Vinted', 'mymarket.ge']

/**
 * Size systems: the quick sizes offered for each, and the label numbers get, since 38 means different
 * sizes in EU and Italian sizing. Sizes are kept as written on the label; nothing is converted.
 */
export const SIZE_SYSTEMS: Record<SizeSystem, { label: string; sizes: string[]; suffix?: string }> = {
  letter: { label: 'Letters', sizes: ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] },
  eu: { label: 'EU', sizes: ['32', '34', '36', '38', '40', '42', '44', '46', '48'], suffix: 'EU' },
  it: { label: 'IT', sizes: ['36', '38', '40', '42', '44', '46', '48', '50'], suffix: 'IT' },
  fr: { label: 'FR', sizes: ['32', '34', '36', '38', '40', '42', '44', '46'], suffix: 'FR' },
  uk: { label: 'UK', sizes: ['4', '6', '8', '10', '12', '14', '16', '18'], suffix: 'UK' },
  us: { label: 'US', sizes: ['0', '2', '4', '6', '8', '10', '12', '14'], suffix: 'US' },
  kids: { label: 'Kids', sizes: ['1 year', '2 years', '4 years', '6 years', '8 years', '10 years', '12 years', '14 years'] },
  one: { label: 'One size', sizes: ['One size'] },
}

export const SIZE_SYSTEM_IDS = Object.keys(SIZE_SYSTEMS) as SizeSystem[]

/**
 * Next number code (0001, 0002…), after the highest in use and the highest ever given out here (`given`), so a
 * deleted product's code isn't reused. Codes typed by hand in another form are skipped.
 */
export function nextCode(products: ProductRec[], given = 0) {
  const max = Math.max(given, ...products.map((p) => (/^\d+$/.test(p.code) ? Number(p.code) : 0)))
  return String(max + 1).padStart(4, '0')
}

export function newProduct(patch: Partial<ProductRec>, existing: ProductRec[], now = Date.now(), given = 0): ProductRec {
  return {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    name: '',
    code: nextCode(existing, given),
    status: 'draft',
    sizes: [],
    colours: [],
    category: '',
    brand: '',
    condition: '',
    material: '',
    measurements: '',
    notes: '',
    ...patch,
  }
}

export const totalStock = (p: Pick<ProductRec, 'sizes'>) => p.sizes.reduce((n, s) => n + s.stock, 0)

/** Sizes that can still be sold: those with stock, none once the product is marked sold. */
export const available = (p: ProductRec) => (p.status === 'sold' ? [] : p.sizes.filter((s) => s.stock > 0))

/** How many pieces can still be sold. */
export const availableStock = (p: ProductRec) => totalStock({ sizes: available(p) })

/**
 * New sizes and stock, and what follows from them: selling the last piece marks the product sold (with the
 * date); stock coming back puts a sold product up for sale again.
 */
export function stockPatch(p: ProductRec, sizes: SizeStock[], now = Date.now()): Partial<ProductRec> {
  const before = totalStock(p)
  const after = totalStock({ sizes })
  if (before > 0 && after === 0 && (p.status === 'for_sale' || p.status === 'reserved'))
    return { sizes, status: 'sold', soldAt: now }
  if (before === 0 && after > 0 && p.status === 'sold') return { sizes, status: 'for_sale', soldAt: undefined }
  return { sizes }
}

/** A new status, with the sold date set or cleared to match. */
export const statusPatch = (p: ProductRec, status: ProductStatus, now = Date.now()): Partial<ProductRec> => ({
  status,
  soldAt: status === 'sold' ? (p.soldAt ?? now) : undefined,
})

/** Sizes as buyers read them: numbers with their system ("38, 40 EU"), other sizes as written. */
export function sizesText(p: ProductRec, sizes = p.sizes.map((s) => s.size)) {
  const suffix = SIZE_SYSTEMS[p.sizeSystem ?? 'letter'].suffix
  const numbers = suffix && sizes.length > 0 && sizes.every((s) => /^\d+(\.\d+)?$/.test(s))
  return sizes.join(', ') + (numbers ? ` ${suffix}` : '')
}

export function formatPrice(price: number | undefined, currency: Currency) {
  if (price === undefined) return ''
  const digits = Number.isInteger(price) ? 0 : 2
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price)
}

/** "S 2 · M 1": sizes still for sale, with how many. */
export const stockText = (p: ProductRec) =>
  available(p)
    .map((s) => `${s.size} ${s.stock}`)
    .join(' · ')

export interface ProductFilter {
  query: string
  status: ProductStatus | 'all' | 'available' // available: for sale or reserved
  size?: string // only products with this size in stock
  audience?: Audience
}

/** Every word of the query must appear in one of the product's text fields. */
export function matches(p: ProductRec, f: ProductFilter) {
  if (f.status === 'available' ? p.status !== 'for_sale' && p.status !== 'reserved' : f.status !== 'all' && p.status !== f.status)
    return false
  if (f.size && !available(p).some((s) => s.size === f.size)) return false
  if (f.audience && p.audience !== f.audience) return false
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [
    p.name,
    p.code,
    p.brand,
    p.category,
    p.material,
    p.condition,
    p.measurements,
    p.notes,
    p.reservedFor ?? '',
    ...p.colours,
    ...p.sizes.map((s) => s.size),
    ...(p.postedOn ?? []),
  ]
    .join(' ')
    .toLowerCase()
  return words.every((w) => text.includes(w))
}

// Letter sizes in body order; numbers sort as numbers after them; anything else last.
const LETTER_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', 'One size']

/** Sizes that are in stock somewhere in the catalogue, in a sensible order (letters, then numbers). */
export function sizesInStock(products: ProductRec[]) {
  const sizes = new Set(products.flatMap((p) => available(p).map((s) => s.size)))
  const rank = (s: string) => {
    const i = LETTER_ORDER.indexOf(s)
    if (i >= 0) return i
    const n = Number(s)
    return Number.isFinite(n) ? 100 + n : 100_000
  }
  return [...sizes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }))
}

/**
 * Plain facts for a post or a listing, one per line, in the order buyers ask for them; then the shop's own
 * lines from Settings (how to order, delivery).
 */
export function detailsText(p: ProductRec, currency: Currency, shopInfo = '') {
  const sizes = available(p).map((s) => s.size)
  const sale = p.salePrice !== undefined && p.price !== undefined && p.salePrice < p.price
  return [
    p.name,
    sale
      ? `Price: ${formatPrice(p.salePrice, currency)} (was ${formatPrice(p.price, currency)})`
      : p.price !== undefined && `Price: ${formatPrice(p.price, currency)}`,
    sizes.length > 0 && `Size${sizes.length > 1 ? 's' : ''}: ${sizesText(p, sizes)}`,
    p.colours.length > 0 && `Colour: ${p.colours.join(', ')}`,
    p.brand && `Brand: ${p.brand}`,
    p.material && `Material: ${p.material}`,
    p.condition && `Condition: ${p.condition}`,
    p.measurements && `Measurements: ${p.measurements}`,
    p.code && `Code: ${p.code}`,
    shopInfo.trim() && `\n${shopInfo.trim()}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * A price as typed: "1 200", "12,50", "1.200,50", "45 ₾". Undefined when empty, NaN when it can't be read. A
 * separator followed by one or two digits at the end is the decimal point; others group thousands.
 */
export function parsePrice(text: string): number | undefined {
  if (!text.trim()) return undefined
  const t = text
    .replace(/[^\d.,-]/g, '') // spaces, currency signs and codes
    .replace(/[.,]$/, '') // "12," on the way to "12,50"
  const m = t.match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/)
  return m ? Number(m[1].replace(/[.,]/g, '') + (m[2] ? `.${m[2]}` : '')) : NaN
}

/** The price a buyer pays now: the sale price when there is a lower one. */
export const currentPrice = (p: ProductRec) =>
  p.salePrice !== undefined && (p.price === undefined || p.salePrice < p.price) ? p.salePrice : p.price

const GIVEN_KEY = 'gs.lastCode'
const readGiven = () => {
  try {
    return Number(localStorage.getItem(GIVEN_KEY)) || 0
  } catch {
    return 0
  }
}

/** Products whose code is also used by another product: two devices can give out the same number offline. */
export function sameCode(p: ProductRec, products: ProductRec[]) {
  const code = p.code.trim().toLowerCase()
  return code ? products.filter((x) => x.id !== p.id && x.code.trim().toLowerCase() === code) : []
}

/** The catalogue, kept in IndexedDB. Edits are written shortly after the last change (typing changes a record on every key). */
export function useProducts() {
  const [products, setProducts] = useState<ProductRec[]>([])
  const [loaded, setLoaded] = useState(false)
  const list = useRef<ProductRec[]>([])
  const writes = useRef(new Map<string, number>())

  const commit = (next: ProductRec[]) => {
    list.current = next
    setProducts(next)
  }

  useEffect(() => {
    listAll('products')
      .then(commit)
      .catch(reportWriteError)
      .finally(() => setLoaded(true))
  }, [])

  // Saved by another window or by team sync: re-read, keeping edits here that are still waiting to be saved.
  useEffect(
    () =>
      onOtherWindowChange((store) => {
        if (store !== 'products') return
        listAll('products')
          .then((rows) => commit(rows.map((r) => (writes.current.has(r.id) ? (list.current.find((p) => p.id === r.id) ?? r) : r))))
          .catch(reportWriteError)
      }),
    [],
  )

  function write(id: string) {
    clearTimeout(writes.current.get(id))
    writes.current.delete(id)
    const latest = list.current.find((p) => p.id === id)
    if (latest) putRec('products', latest).catch(reportWriteError)
  }

  // Leaving the app (closing the tab, switching apps on a phone), or a newer version taking over the
  // database, writes what is still waiting.
  useEffect(() => {
    const flushAll = () => [...writes.current.keys()].forEach(write)
    const flush = () => document.visibilityState === 'hidden' && flushAll()
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flushAll)
    const off = onBeforeClose(flushAll)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flushAll)
      off()
    }
  }, [])

  function create(patch: Partial<ProductRec> = {}) {
    requestPersistence()
    const rec = newProduct(patch, list.current, Date.now(), readGiven())
    if (/^\d+$/.test(rec.code))
      try {
        localStorage.setItem(GIVEN_KEY, String(Number(rec.code)))
      } catch {}
    commit([rec, ...list.current])
    putRec('products', rec).catch(reportWriteError)
    return rec
  }

  function update(id: string, patch: Partial<ProductRec>) {
    commit(list.current.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)))
    clearTimeout(writes.current.get(id))
    writes.current.set(
      id,
      window.setTimeout(() => write(id), 300),
    )
  }

  /** Deletes the product. Its photos stay in the Studio and its try-on results in the Library. */
  function remove(id: string) {
    clearTimeout(writes.current.get(id))
    writes.current.delete(id)
    const rec = list.current.find((p) => p.id === id)
    commit(list.current.filter((p) => p.id !== id))
    deleteRec('products', id).catch(reportWriteError)
    return rec
  }

  function restore(deleted: ProductRec) {
    // A new change: team sync must not take the deletion for the newer one.
    const rec = { ...deleted, updatedAt: Date.now() }
    commit([rec, ...list.current].sort((a, b) => b.createdAt - a.createdAt))
    putRec('products', rec).catch(reportWriteError)
  }

  return { products, loaded, create, update, remove, restore }
}

export type Products = ReturnType<typeof useProducts>
