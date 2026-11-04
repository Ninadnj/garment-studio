import { useCallback, useEffect, useState } from 'react'
import {
  type DbState,
  type LookRec,
  type ModelRec,
  deleteRec,
  getRec,
  listAll,
  onDbState,
  onOtherWindowChange,
  onWriteError,
  putRec,
  reportWriteError,
  requestPersistence,
} from './lib/db'
import { cutout } from './lib/cutout'
import { useGarments } from './lib/garments'
import { downscale, normalizeImage, uid } from './lib/image'
import { useProducts } from './lib/products'
import { hostOf, loadConfig, readSetupLink, saveConfig, saveSession } from './lib/team'
import { resetSyncState, startTeamSync, teamSync } from './lib/teamSync'
import { type LookPrefs, type Settings, loadLook, loadSettings, saveLook, saveSettings } from './lib/settings'
import { IconGear, IconGrid, IconHanger, IconPerson, IconTag } from './components/Icons'
import { NewModelSheet } from './components/NewModelSheet'
import { ProductSheet } from './components/ProductSheet'
import { ProductsView } from './components/Products'
import { Studio } from './components/Studio'
import { useToast } from './components/Toast'
import { LibraryView, ModelsView, SettingsView } from './components/Views'

type Tab = 'studio' | 'products' | 'models' | 'library' | 'settings'

const TABS: { id: Tab; label: string; icon: () => React.JSX.Element }[] = [
  { id: 'studio', label: 'Studio', icon: IconHanger },
  { id: 'products', label: 'Products', icon: IconTag },
  { id: 'models', label: 'Models', icon: IconPerson },
  { id: 'library', label: 'Library', icon: IconGrid },
  { id: 'settings', label: 'Settings', icon: IconGear },
]

const SELECTED_KEY = 'gs.selectedModel'
const CURRENT_KEY = 'gs.currentGarment'

const stored = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export default function App() {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('studio')
  const [settings, setSettingsState] = useState<Settings>(loadSettings)
  const [look, setLookState] = useState<LookPrefs>(loadLook)
  const [models, setModels] = useState<ModelRec[]>([])
  const [looks, setLooks] = useState<LookRec[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(() => stored(SELECTED_KEY))
  const [newModelOpen, setNewModelOpen] = useState(false)
  const [cutoutBusy, setCutoutBusy] = useState<Set<string>>(new Set())
  // Garment photos and products are shared by the Studio and the Products view.
  const [currentGarment, setCurrentGarmentState] = useState<string | undefined>(() => stored(CURRENT_KEY))
  const G = useGarments(settings.remover, currentGarment)
  const P = useProducts()
  const [openProduct, setOpenProduct] = useState<string>()

  const setCurrentGarment = (id: string | undefined) => {
    setCurrentGarmentState(id)
    try {
      if (id) localStorage.setItem(CURRENT_KEY, id)
      else localStorage.removeItem(CURRENT_KEY)
    } catch {}
  }

  /** Shows a photo in the Studio, e.g. from a product. */
  const showGarment = (id: string) => {
    setCurrentGarment(id)
    setOpenProduct(undefined)
    setTab('studio')
    window.scrollTo(0, 0)
  }

  const [dbState, setDbState] = useState<DbState>('ok')

  useEffect(() => {
    listAll('models').then(setModels).catch(reportWriteError)
    listAll('looks').then(setLooks).catch(reportWriteError)
    const offState = onDbState(setDbState)
    const offError = onWriteError((e) =>
      toast({ text: `Could not save on this device: ${(e as Error)?.message ?? e}`, error: true }),
    )
    // Saved by another window or by team sync.
    const offChange = onOtherWindowChange((store) => {
      if (store === 'models') listAll('models').then(setModels).catch(reportWriteError)
      if (store === 'looks') listAll('looks').then(setLooks).catch(reportWriteError)
    })
    return () => {
      offState()
      offError()
      offChange()
    }
  }, [])

  // Team sync, and the setup link a teammate shares (it connects to the same project; each person signs in).
  // The link is read when the app opens, and when it is opened in a tab that already shows the app.
  useEffect(() => {
    const readLink = () => {
      if (!/[#&]team=/.test(location.hash)) return
      const linked = readSetupLink(location.hash)
      history.replaceState(null, '', location.pathname + location.search)
      const current = loadConfig()
      if (!linked) toast({ text: 'That setup link is not valid. Ask for a new one.', error: true })
      else if (linked.url === current?.url) saveConfig(linked) // the same project, perhaps a new key
      else if (
        confirm(`Connect this app to the team catalogue at ${hostOf(linked.url)}? You will sign in with your own account.`)
      ) {
        // Nothing of another project (its sign-in, what it synced) carries over to this one.
        saveSession(undefined)
        resetSyncState()
        saveConfig(linked)
        teamSync.setStatus({ phase: 'signed-out', error: undefined })
        setTab('settings')
        toast({ text: 'Connected to your team’s catalogue. Sign in under Team.' })
      }
    }
    readLink()
    window.addEventListener('hashchange', readLink)
    const stop = startTeamSync()
    return () => {
      window.removeEventListener('hashchange', readLink)
      stop()
    }
  }, [])

  const setSettings = (s: Settings) => {
    setSettingsState(s)
    saveSettings(s)
  }
  const setLook = (l: LookPrefs) => {
    setLookState(l)
    saveLook(l)
  }
  const selectModel = (id: string) => {
    setSelectedModelId(id)
    try {
      localStorage.setItem(SELECTED_KEY, id)
    } catch {}
  }

  async function addModels(images: Blob[], source: ModelRec['source'], prompt?: string) {
    requestPersistence()
    const recs: ModelRec[] = []
    for (const img of images) {
      // AI services return up to 2304 px PNGs; try-ons never use more than 2048 px.
      const image = await downscale(img, 2048)
      const rec: ModelRec = { id: uid(), image, createdAt: Date.now(), source, prompt }
      await putRec('models', rec)
      recs.push(rec)
    }
    setModels((ms) => [...recs, ...ms])
    if (recs[0]) selectModel(recs[0].id)
  }

  async function uploadModel(file: File) {
    try {
      await addModels([await downscale(await normalizeImage(file), 2048, 'image/jpeg', true)], 'upload')
    } catch {
      toast({ text: 'This file could not be opened as an image.', error: true })
    }
  }

  async function removeModel(id: string) {
    await deleteRec('models', id)
    setModels((ms) => ms.filter((m) => m.id !== id))
  }

  const saveLookRec = useCallback((rec: LookRec) => {
    requestPersistence()
    putRec('looks', rec).catch(reportWriteError)
    setLooks((ls) => [rec, ...ls.filter((l) => l.id !== rec.id)])
  }, [])

  async function removeLook(id: string) {
    await deleteRec('looks', id)
    setLooks((ls) => ls.filter((l) => l.id !== id))
  }

  const busy = (id: string, on: boolean) =>
    setCutoutBusy((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })

  /** Cut the person out of a try-on result so its background colour can be changed. */
  async function makeCutout(rec: LookRec) {
    if (rec.cutout || cutoutBusy.has(rec.id)) return
    busy(rec.id, true)
    try {
      const cut = await cutout(rec.image, settings.remover)
      // Deleted meanwhile (here or by the team): it stays deleted. The cutout is this device's own, not shared.
      const current = await getRec('looks', rec.id)
      if (!current) return
      const next = { ...current, cutout: cut }
      await putRec('looks', next, true)
      setLooks((ls) => ls.map((l) => (l.id === next.id ? next : l)))
    } catch (e) {
      console.error(e)
      toast({ text: 'Could not cut out the person to change the background.', error: true })
    } finally {
      busy(rec.id, false)
    }
  }

  return (
    <div className="app">
      {dbState !== 'ok' && (
        <div className="db-notice" role="alertdialog" aria-modal="true" aria-labelledby="db-notice-text">
          <div className="db-notice-box">
            <p id="db-notice-text">
              {dbState === 'blocked'
                ? 'The app was updated, and another Garment Studio tab or window still uses the old version. Close the other tabs and windows, then reload this one.'
                : 'A newer version of the app is open in another tab or window. Reload this one to keep saving.'}
            </p>
            <button className="btn" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )}
      <header className="topbar">
        <div className="brand">Garment Studio</div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className="tab" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              <t.icon />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </header>

      <main>
        <div hidden={tab !== 'studio'}>
          <Studio
            active={tab === 'studio'}
            G={G}
            currentId={currentGarment}
            setCurrentId={setCurrentGarment}
            P={P}
            openProduct={setOpenProduct}
            settings={settings}
            setSettings={setSettings}
            look={look}
            setLook={setLook}
            models={models}
            looks={looks}
            selectedModelId={selectedModelId}
            selectModel={selectModel}
            onNewModel={() => setNewModelOpen(true)}
            onUploadModel={uploadModel}
            onLookSaved={saveLookRec}
            makeCutout={makeCutout}
            cutoutBusy={cutoutBusy}
            goSettings={() => setTab('settings')}
          />
        </div>
        <div hidden={tab !== 'products'}>
          <ProductsView P={P} garments={G.garments} currency={settings.currency} open={setOpenProduct} />
        </div>
        <div hidden={tab !== 'models'}>
          <ModelsView
            models={models}
            selectedId={selectedModelId}
            select={selectModel}
            remove={removeModel}
            onNew={() => setNewModelOpen(true)}
            onUpload={uploadModel}
          />
        </div>
        <div hidden={tab !== 'library'}>
          <LibraryView
            looks={looks}
            look={look}
            setLook={setLook}
            remove={removeLook}
            makeCutout={makeCutout}
            cutoutBusy={cutoutBusy}
          />
        </div>
        <div hidden={tab !== 'settings'}>
          <SettingsView settings={settings} setSettings={setSettings} />
        </div>
      </main>

      {openProduct && P.products.some((x) => x.id === openProduct) && (
        <ProductSheet
          key={openProduct}
          product={P.products.find((x) => x.id === openProduct)!}
          P={P}
          G={G}
          looks={looks}
          currency={settings.currency}
          shopInfo={settings.shopInfo}
          onShowPhoto={showGarment}
          onOpen={setOpenProduct}
          onClose={() => setOpenProduct(undefined)}
          onDeleted={(rec) =>
            toast({ text: 'Product deleted. Its photos stay in the Studio.', action: { label: 'Undo', run: () => P.restore(rec) } })
          }
        />
      )}

      {newModelOpen && (
        <NewModelSheet
          settings={settings}
          onClose={() => setNewModelOpen(false)}
          onSave={(images, prompt) => addModels(images, 'ai', prompt)}
        />
      )}
    </div>
  )
}
