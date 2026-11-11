export type AIService = 'free' | 'fashn'
export type GenMode = 'fast' | 'balanced' | 'quality'
export type Resolution = '1k' | '2k' | '4k'
export type Remover = 'rmbg14' | 'isnet_fp16' | 'isnet_quint8'
export type Aspect = '1:1' | '4:5' | '3:4' | '9:16'
export type ShadowStyle = 'none' | 'soft' | 'close' | 'floor'

export type Currency = 'GEL' | 'USD' | 'EUR' | 'GBP'

export interface Settings {
  currency: Currency // for product prices
  shopInfo: string // added to copied product details: how to order, delivery…
  shopName: string // on catalogue pages
  contactLine: string // at the bottom of catalogue pages, e.g. "@shop · 555 12 34 56"
  ai: AIService
  hfToken: string // optional, raises the free daily allowance on Hugging Face
  fashnKey: string
  mode: GenMode
  resolution: Resolution
  remover: Remover // default for new photos
}

export const REMOVER_LABELS: Record<Remover, string> = {
  rmbg14: 'Standard',
  isnet_fp16: 'Second method',
  isnet_quint8: 'Light',
}

export const SHADOW_LABELS: Record<ShadowStyle, string> = {
  none: 'None',
  soft: 'Soft',
  close: 'Close',
  floor: 'Floor',
}

/** How a cutout is placed on its background. Shared by every photo, the studio and the library. */
export interface LookPrefs {
  bg: string // hex colour, or 'transparent'
  light: boolean // studio light: the background brighter in the middle, darker at the edges
  aspect: Aspect
  padding: number // fraction of the short side, 0–0.3
  shadow: ShadowStyle
}

const SETTINGS_KEY = 'gs.settings'
const LOOK_KEY = 'gs.look'

export const DEFAULT_SETTINGS: Settings = {
  currency: 'GEL',
  shopInfo: '',
  shopName: '',
  contactLine: '',
  ai: 'free',
  hfToken: '',
  fashnKey: '',
  mode: 'balanced',
  resolution: '1k',
  remover: 'rmbg14',
}

export const DEFAULT_LOOK: LookPrefs = { bg: '#ffffff', light: false, aspect: '4:5', padding: 0.1, shadow: 'soft' }

// FASHN credit table for try-on and model-create (same for both endpoints).
const CREDITS: Record<GenMode, Record<Resolution, number>> = {
  fast: { '1k': 1, '2k': 2, '4k': 3 },
  balanced: { '1k': 2, '2k': 3, '4k': 4 },
  quality: { '1k': 3, '2k': 4, '4k': 5 },
}

export const creditCost = (s: Pick<Settings, 'mode' | 'resolution'>, images = 1) =>
  CREDITS[s.mode][s.resolution] * images

function read(key: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or storage full: settings just won't persist.
  }
}

/** Stored settings over the defaults. Someone who already entered a FASHN key keeps using FASHN. */
export function parseSettings(stored: Record<string, unknown>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...stored } as Settings
  if (!('ai' in stored) && s.fashnKey) s.ai = 'fashn'
  if (!(s.remover in REMOVER_LABELS)) s.remover = DEFAULT_SETTINGS.remover // a remover this version doesn't have
  return s
}

/** Stored look over the defaults; `shadow` used to be a boolean. */
export function parseLook(stored: Record<string, unknown>): LookPrefs {
  const l = { ...DEFAULT_LOOK, ...stored } as LookPrefs
  if (typeof stored.shadow === 'boolean') l.shadow = stored.shadow ? 'soft' : 'none'
  return l
}

export const loadSettings = () => parseSettings(read(SETTINGS_KEY))
export const saveSettings = (s: Settings) => write(SETTINGS_KEY, s)
export const loadLook = () => parseLook(read(LOOK_KEY))
export const saveLook = (l: LookPrefs) => write(LOOK_KEY, l)
