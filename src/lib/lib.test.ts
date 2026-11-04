import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyAdjust, buildLuts, NO_ADJUST } from './adjust'
import { parseLook, parseSettings } from './settings'
import { crc32, zip } from './zip'

const px = (...rgba: number[]) => Uint8ClampedArray.from(rgba)

describe('adjust', () => {
  it('is the identity when every control is at zero', () => {
    for (const lut of buildLuts(NO_ADJUST)) for (let v = 0; v < 256; v++) expect(lut[v]).toBe(v)
  })

  it('brightens with exposure and keeps black and white fixed points', () => {
    const [r] = buildLuts({ ...NO_ADJUST, exposure: 1 })
    expect(r[0]).toBe(0)
    expect(r[255]).toBe(255)
    expect(r[118]).toBeGreaterThan(150) // mid grey up about one stop
  })

  it('warms by raising red and lowering blue', () => {
    const p = px(128, 128, 128, 255)
    applyAdjust(p, { ...NO_ADJUST, warmth: 1 })
    expect(p[0]).toBeGreaterThan(128)
    expect(p[2]).toBeLessThan(128)
  })

  it('desaturates to grey and skips transparent pixels', () => {
    const p = px(200, 40, 40, 255, 200, 40, 40, 0)
    applyAdjust(p, { ...NO_ADJUST, saturation: -1 })
    expect(p[0]).toBe(p[1])
    expect(p[1]).toBe(p[2])
    expect([...p.slice(4)]).toEqual([200, 40, 40, 0])
  })

  it('adds contrast without clipping the ends', () => {
    const [r] = buildLuts({ ...NO_ADJUST, contrast: 1 })
    expect(r[64]).toBeLessThan(64)
    expect(r[192]).toBeGreaterThan(192)
    expect(r[255]).toBe(255)
  })
})

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes an archive that unzip accepts, with the files intact', async () => {
    const files = [
      { name: 'garment-1.jpg', data: new Blob([new Uint8Array([1, 2, 3, 255])]) },
      { name: 'garment-2.png', data: new Blob(['hello world']) },
    ]
    const dir = mkdtempSync(join(tmpdir(), 'gs-zip-'))
    const path = join(dir, 'test.zip')
    writeFileSync(path, new Uint8Array(await (await zip(files)).arrayBuffer()))
    expect(execFileSync('unzip', ['-t', path]).toString()).toContain('No errors detected')
    expect(execFileSync('unzip', ['-p', path, 'garment-2.png']).toString()).toBe('hello world')
  })
})

describe('settings', () => {
  it('keeps FASHN for people who already set a key', () => {
    expect(parseSettings({ fashnKey: 'fa-x' }).ai).toBe('fashn')
    expect(parseSettings({}).ai).toBe('free')
    expect(parseSettings({ fashnKey: 'fa-x', ai: 'free' }).ai).toBe('free')
  })

  it('migrates the old on/off shadow', () => {
    expect(parseLook({ shadow: true }).shadow).toBe('soft')
    expect(parseLook({ shadow: false }).shadow).toBe('none')
    expect(parseLook({}).shadow).toBe('soft')
  })
})
