// Post kit: which photos go into posts, the facts drawn on them, file names, and where a product was posted.
// Pure, so tests run without a browser.
import type { GarmentRec, LookRec, ProductRec } from './db'
import type { Facts } from './layout'
import { available, currentPrice, discountText, formatPrice, sizeLabel } from './products'
import type { Currency } from './settings'

export type KitItem = { kind: 'garment'; id: string; rec: GarmentRec } | { kind: 'look'; id: string; rec: LookRec }

/** Up to 10 photos: Android's share sheet takes at most 10 files at once (Instagram itself takes up to 20). */
export const MAX_POST_PHOTOS = 10
export const DEFAULT_POST_PHOTOS = 10
/** How many files one share sheet gets (Android's limit); more are shared in groups. */
export const SHARE_BATCH = 10

const newestFirst = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt

/** A product's photos for posts: its cover, then its try-on results, then its other photos (each newest first). */
export function kitPhotos(p: ProductRec, garments: GarmentRec[], looks: LookRec[]): KitItem[] {
  const own = garments.filter((g) => g.productId === p.id).sort(newestFirst)
  const cover = own.find((g) => g.id === p.coverId) ?? own[0]
  const tryOns = looks.filter((l) => l.productId === p.id).sort(newestFirst)
  return [
    ...(cover ? [{ kind: 'garment' as const, id: cover.id, rec: cover }] : []),
    ...tryOns.map((rec) => ({ kind: 'look' as const, id: rec.id, rec })),
    ...own.filter((g) => g !== cover).map((rec) => ({ kind: 'garment' as const, id: rec.id, rec })),
  ]
}

/** The photo for a catalogue tile: the cover (or with `model`, the newest try-on), else whichever there is. */
export function tilePhoto(p: ProductRec, garments: GarmentRec[], looks: LookRec[], model: boolean): KitItem | undefined {
  const all = kitPhotos(p, garments, looks)
  const look = all.find((i) => i.kind === 'look')
  const cover = all.find((i) => i.kind === 'garment')
  return (model ? (look ?? cover) : (cover ?? look)) ?? undefined
}

/** The story's photo: the one chosen, while still selected; else the first try-on (a standing person suits 9:16); else the first photo. */
export function storyPhoto(selected: KitItem[], chosen?: string) {
  return selected.find((i) => i.id === chosen) ?? selected.find((i) => i.kind === 'look') ?? selected[0]
}

/** The name on images: "Brand · Name" when the brand isn't already in the name. */
export function displayName(p: Pick<ProductRec, 'name' | 'brand'>) {
  const name = p.name.trim()
  const brand = p.brand.trim()
  if (!brand || name.toLowerCase().includes(brand.toLowerCase())) return name
  return name ? `${brand} · ${name}` : brand
}

/** The facts drawn on post images and catalogue tiles. */
export function imageFacts(p: ProductRec, currency: Currency): Facts {
  const now = currentPrice(p)
  const sale = now !== undefined && p.price !== undefined && now < p.price
  return {
    name: displayName(p),
    price: formatPrice(now, currency) || undefined,
    oldPrice: sale ? formatPrice(p.price, currency) : undefined,
    discount: sale ? discountText(p.price, now) : undefined,
    sizes: available(p).map((s) => sizeLabel(p, s.size)),
    code: p.code.trim() || undefined,
  }
}

/** The code as a file name: Latin letters, digits, - and _; "product" when nothing of it is left. */
export const fileBase = (code: string) => code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'product'

/** "0012-instagram-1.jpg" */
export const kitFileName = (code: string, part: 'instagram' | 'story' | 'square', n?: number) =>
  `${fileBase(code)}-${part}${n ? `-${n}` : ''}.jpg`

/** Adds a place to "Posted on" (once, whatever its case) and when the product was posted there. */
export function postedPatch(p: ProductRec, channel: string, now = Date.now()): Pick<ProductRec, 'postedOn' | 'postedAt'> {
  const on = p.postedOn ?? []
  return {
    postedOn: on.some((c) => c.toLowerCase() === channel.toLowerCase()) ? on : [...on, channel],
    postedAt: { ...p.postedAt, [channel]: now },
  }
}

/** Takes a place off "Posted on". */
export function unpostedPatch(p: ProductRec, channel: string): Pick<ProductRec, 'postedOn' | 'postedAt'> {
  const at = { ...p.postedAt }
  for (const k of Object.keys(at)) if (k.toLowerCase() === channel.toLowerCase()) delete at[k]
  return { postedOn: (p.postedOn ?? []).filter((c) => c.toLowerCase() !== channel.toLowerCase()), postedAt: at }
}
