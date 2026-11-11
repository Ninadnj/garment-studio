// Catalogue to send: which products go in, pages, and the words around them. Pure.
import type { ProductRec } from './db'
import { available, sizeLabel } from './products'

export interface Skipped {
  reserved: number
  draft: number
  sold: number
  noStock: number
  noPhoto: number
}

/**
 * What can be sold now, in the order shown: for sale, with stock (in `size` when a size filter is on; a product
 * with no sizes entered counts as in stock without one), and with a photo. The rest is counted by reason.
 */
export function catalogueProducts(shown: ProductRec[], hasPhoto: (p: ProductRec) => boolean, size?: string) {
  const products: ProductRec[] = []
  const skipped: Skipped = { reserved: 0, draft: 0, sold: 0, noStock: 0, noPhoto: 0 }
  for (const p of shown) {
    if (p.status === 'reserved') skipped.reserved++
    else if (p.status === 'draft') skipped.draft++
    else if (p.status === 'sold') skipped.sold++
    else if (p.sizes.length ? !available(p).some((s) => !size || sizeLabel(p, s.size) === size) : !!size) skipped.noStock++
    else if (!hasPhoto(p)) skipped.noPhoto++
    else products.push(p)
  }
  return { products, skipped }
}

/** "Not included: 2 reserved, 1 without a photo." or ''. */
export function skippedText(s: Skipped, size?: string) {
  const parts = [
    s.reserved && `${s.reserved} reserved`,
    s.draft && `${s.draft} draft${s.draft === 1 ? '' : 's'}`,
    s.sold && `${s.sold} sold`,
    s.noStock && `${s.noStock} out of stock${size ? ` in ${size}` : ''}`,
    s.noPhoto && `${s.noPhoto} without a photo`,
  ].filter(Boolean)
  return parts.length ? `Not included: ${parts.join(', ')}.` : ''
}

export function paginate<T>(items: T[], perPage: number): T[][] {
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage))
  return pages
}

/** Codes used by more than one of these products (buyers ask by code), each once, as first written. */
export function repeatedCodes(products: ProductRec[]) {
  const count = new Map<string, { code: string; n: number }>()
  for (const p of products) {
    const code = p.code.trim()
    if (!code) continue
    const k = code.toLowerCase()
    count.set(k, { code: count.get(k)?.code ?? code, n: (count.get(k)?.n ?? 0) + 1 })
  }
  return [...count.values()].filter((c) => c.n > 1).map((c) => c.code)
}

const two = (n: number) => String(n).padStart(2, '0')

/** "09.11.2026" */
export const dateText = (d: Date) => `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`

/** "catalogue-2026-11-09-1.jpg" for a page, "catalogue-2026-11-09.pdf" for all of them. */
export function catalogueFileName(d: Date, page?: number) {
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
  return page ? `catalogue-${day}-${page}.jpg` : `catalogue-${day}.pdf`
}

/** The text sent with the pages: the title, the contact line and the shop's own lines. */
export function catalogueMessage(title: string, contactLine: string, shopInfo: string) {
  return [title, contactLine, shopInfo]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
}
