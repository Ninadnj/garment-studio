import { describe, expect, it } from 'vitest'
import type { ProductRec } from './db'
import {
  availableStock,
  detailsText,
  formatPrice,
  matches,
  newProduct,
  nextCode,
  parsePrice,
  sameCode,
  sizesInStock,
  sizesText,
  statusPatch,
  stockPatch,
  stockText,
  totalStock,
} from './products'

const product = (patch: Partial<ProductRec>) => newProduct(patch, [], 0)

describe('products', () => {
  it('numbers new products after the highest number code, skipping codes typed in another form', () => {
    expect(nextCode([])).toBe('0001')
    const existing = [product({ code: '0007' }), product({ code: 'SUMMER-12' }), product({ code: '0003' })]
    expect(nextCode(existing)).toBe('0008')
    expect(newProduct({}, existing, 5)).toMatchObject({ code: '0008', status: 'draft', createdAt: 5, updatedAt: 5 })
  })

  it('counts stock and lists the sizes still in stock', () => {
    const p = product({ sizes: [{ size: 'S', stock: 2 }, { size: 'M', stock: 0 }, { size: 'L', stock: 1 }] })
    expect(totalStock(p)).toBe(3)
    expect(stockText(p)).toBe('S 2 · L 1')
  })

  it('finds products by every word of the search, by status and by a size in stock', () => {
    const shirt = product({
      name: 'Linen shirt',
      code: '0004',
      colours: ['White'],
      brand: 'Zara',
      status: 'for_sale',
      sizes: [{ size: 'M', stock: 1 }],
    })
    const skirt = product({ name: 'Pleated skirt', colours: ['Navy'], status: 'sold', sizes: [{ size: 'S', stock: 0 }] })
    const all = { query: '', status: 'all' as const }
    expect(matches(shirt, { ...all, query: 'white zara' })).toBe(true)
    expect(matches(shirt, { ...all, query: 'white navy' })).toBe(false)
    expect(matches(shirt, { ...all, query: '0004' })).toBe(true)
    expect(matches(skirt, { ...all, status: 'for_sale' })).toBe(false)
    expect(matches(shirt, { ...all, size: 'M' })).toBe(true)
    expect(matches(skirt, { ...all, size: 'S' })).toBe(false) // in the list, but none left
  })

  it('orders sizes in stock as letters, then numbers, then the rest', () => {
    const ps = [
      product({ sizes: [{ size: '40', stock: 1 }, { size: 'XL', stock: 1 }] }),
      product({ sizes: [{ size: 'S', stock: 1 }, { size: '36', stock: 2 }, { size: '10 years', stock: 1 }] }),
      product({ sizes: [{ size: 'M', stock: 0 }] }),
    ]
    expect(sizesInStock(ps)).toEqual(['S', 'XL', '36', '40', '10 years'])
  })

  it('writes plain details for a post: only what is filled in, sizes in stock, no notes', () => {
    const p = product({
      name: 'Linen shirt',
      price: 45,
      sizes: [{ size: 'S', stock: 1 }, { size: 'M', stock: 0 }],
      colours: ['White'],
      material: '100% linen',
      code: '0004',
      notes: 'Bought at the market',
    })
    const text = detailsText(p, 'GEL')
    expect(text.split('\n')).toEqual([
      'Linen shirt',
      `Price: ${formatPrice(45, 'GEL')}`,
      'Size: S',
      'Colour: White',
      'Material: 100% linen',
      'Code: 0004',
    ])
    expect(text).not.toContain('market')
    expect(formatPrice(12.5, 'EUR')).toMatch(/12[.,]50/)
    expect(formatPrice(undefined, 'GEL')).toBe('')
  })

  it('marks a product sold when its last piece sells, and for sale again when stock comes back', () => {
    const p = product({ status: 'for_sale', sizes: [{ size: 'S', stock: 1 }, { size: 'M', stock: 0 }] })
    const none = [{ size: 'S', stock: 0 }, { size: 'M', stock: 0 }]
    expect(stockPatch(p, none, 99)).toEqual({ sizes: none, status: 'sold', soldAt: 99 })
    const sold = { ...p, sizes: none, status: 'sold' as const, soldAt: 99 }
    const back = [{ size: 'S', stock: 2 }, { size: 'M', stock: 0 }]
    expect(stockPatch(sold, back)).toEqual({ sizes: back, status: 'for_sale', soldAt: undefined })
    // A draft with no stock yet stays a draft.
    expect(stockPatch(product({ sizes: [{ size: 'S', stock: 0 }] }), back)).toEqual({ sizes: back })
    expect(statusPatch(p, 'sold', 5)).toEqual({ status: 'sold', soldAt: 5 })
    expect(statusPatch(sold, 'sold', 7)).toEqual({ status: 'sold', soldAt: 99 })
    expect(statusPatch(sold, 'for_sale')).toEqual({ status: 'for_sale', soldAt: undefined })
  })

  it('writes numbers with their size system, other sizes as written', () => {
    expect(sizesText(product({ sizeSystem: 'eu', sizes: [{ size: '38', stock: 1 }, { size: '40', stock: 1 }] }))).toBe('38, 40 EU')
    expect(sizesText(product({ sizeSystem: 'it', sizes: [{ size: '42', stock: 1 }] }))).toBe('42 IT')
    expect(sizesText(product({ sizes: [{ size: 'S', stock: 1 }, { size: 'M', stock: 1 }] }))).toBe('S, M')
    expect(sizesText(product({ sizeSystem: 'kids', sizes: [{ size: '4 years', stock: 1 }] }))).toBe('4 years')
  })

  it('adds the sale price and the shop lines to the details', () => {
    const p = product({ name: 'Wool coat', price: 300, salePrice: 220, sizeSystem: 'eu', sizes: [{ size: '38', stock: 1 }] })
    const text = detailsText(p, 'GEL', 'Order by DM. Delivery in Tbilisi: 5 GEL.')
    expect(text).toContain(`Price: ${formatPrice(220, 'GEL')} (was ${formatPrice(300, 'GEL')})`)
    expect(text).toContain('Size: 38 EU')
    expect(text.endsWith('\n\nOrder by DM. Delivery in Tbilisi: 5 GEL.')).toBe(true)
  })

  it('filters available products and by who they are for; finds them by channel and reservation', () => {
    const reserved = product({ status: 'reserved', audience: 'women', reservedFor: '@nino', postedOn: ['Instagram'] })
    const draft = product({ status: 'draft', audience: 'men' })
    expect(matches(reserved, { query: '', status: 'available' })).toBe(true)
    expect(matches(draft, { query: '', status: 'available' })).toBe(false)
    expect(matches(reserved, { query: '', status: 'all', audience: 'men' })).toBe(false)
    expect(matches(reserved, { query: 'instagram @nino', status: 'all' })).toBe(true)
  })

  it('reads prices the way they are typed, and refuses ones it cannot read', () => {
    expect(parsePrice('')).toBeUndefined()
    expect(parsePrice('45')).toBe(45)
    expect(parsePrice('1 200')).toBe(1200)
    expect(parsePrice('12,50')).toBe(12.5)
    expect(parsePrice('12,')).toBe(12) // on the way to 12,50
    expect(parsePrice('1.200,50')).toBe(1200.5)
    expect(parsePrice('1,200')).toBe(1200)
    expect(parsePrice('45 ₾')).toBe(45)
    expect(parsePrice('GEL 45.90')).toBe(45.9)
    expect(parsePrice('1,2345')).toBeNaN()
    expect(parsePrice('abc')).toBeNaN()
  })

  it('counts nothing as in stock once a product is sold', () => {
    const p = product({ status: 'sold', sizes: [{ size: 'S', stock: 1 }] })
    expect(availableStock(p)).toBe(0)
    expect(stockText(p)).toBe('')
    expect(sizesInStock([p])).toEqual([])
    expect(matches(p, { query: '', status: 'all', size: 'S' })).toBe(false)
  })

  it('does not hand out a deleted product’s code again, and spots codes used twice', () => {
    expect(nextCode([product({ code: '0003' })], 7)).toBe('0008')
    const a = product({ code: '0009', name: 'Coat' })
    const b = product({ code: ' 0009 ', name: 'Scarf' })
    expect(sameCode(a, [a, b]).map((x) => x.name)).toEqual(['Scarf'])
    expect(sameCode(product({ code: '' }), [a, b])).toEqual([])
  })
})
