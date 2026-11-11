import { useEffect, useRef, useState } from 'react'
import { loadBitmap, releaseCanvas } from '../lib/image'
import { composeCutout } from '../lib/matte'
import { IconFit, IconRedo, IconUndo, IconZoomIn, IconZoomOut } from './Icons'
import { Chips, Spinner } from './ui'

type Tool = 'erase' | 'restore'
type Pt = { x: number; y: number }
const TOOLS: Tool[] = ['erase', 'restore']
const MAX_HISTORY = 10 // each step is a full-resolution mask copy (~16 MB at 2048px)
const MAX_ZOOM = 8 // CSS px per image px
const BRUSH_MIN = 6
const BRUSH_MAX = 160

interface Doc {
  src: ImageBitmap
  mask: HTMLCanvasElement // full resolution; only its alpha matters
  tmp: HTMLCanvasElement // screen-sized scratch for the masked photo
  checker: CanvasPattern
  undo: HTMLCanvasElement[]
  redo: HTMLCanvasElement[]
}

/** Image px → stage CSS px: X = x + k·u. */
interface View {
  k: number
  x: number
  y: number
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const isTouchDevice = () => matchMedia('(pointer: coarse)').matches

/**
 * Paint the cutout's mask by hand: Erase removes (a finger, a hanger), Restore brings back photo
 * pixels the remover dropped. Removed parts stay faintly visible for orientation. The brush size is
 * in screen pixels, so zooming in gives finer control.
 */
export function MaskEditor({
  src,
  cut,
  auto,
  onDone,
  onCancel,
  active,
}: {
  src: Blob // the photo the cutout was made from (same pixel size)
  cut: Blob // current cutout
  auto?: Blob // automatic result, for Reset; not there yet on a device that got only the edited cutout
  onDone: (cut: Blob) => void
  onCancel: () => void
  active: boolean // the Studio is on screen
}) {
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const doc = useRef<Doc | null>(null)
  const view = useRef<View>({ k: 1, x: 0, y: 0 })
  const fitK = useRef(1)
  const size = useRef({ w: 1, h: 1, dpr: 1 })
  const pointers = useRef(new Map<number, Pt>())
  const stroke = useRef<{ last: Pt } | null>(null)
  const pinch = useRef<{ d: number; m: Pt; v: View } | null>(null)
  const pan = useRef<{ p: Pt; v: View } | null>(null)
  const blockPaint = useRef(false) // after a pinch, until every finger has lifted
  const space = useRef(false)
  const hover = useRef<Pt | null>(null)
  const hoverTimer = useRef(0)
  const frame = useRef(0)
  const [tool, setTool] = useState<Tool>('erase')
  const [brush, setBrush] = useState(40) // diameter, CSS px
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  const [zoom, setZoom] = useState(1) // relative to fit
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  const toolRef = useRef(tool)
  toolRef.current = tool
  const brushRef = useRef(brush)
  brushRef.current = brush

  function render() {
    const d = doc.current
    const c = canvas.current
    if (!d || !c) return
    const { dpr } = size.current
    const { k, x, y } = view.current
    const ctx = c.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = d.checker
    ctx.fillRect(x, y, d.src.width * k, d.src.height * k)
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y)
    ctx.imageSmoothingQuality = 'high'
    ctx.globalAlpha = 0.3
    ctx.drawImage(d.src, 0, 0)
    ctx.globalAlpha = 1

    const t = d.tmp.getContext('2d')!
    t.setTransform(1, 0, 0, 1, 0, 0)
    t.globalCompositeOperation = 'source-over'
    t.clearRect(0, 0, d.tmp.width, d.tmp.height)
    t.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y)
    t.imageSmoothingQuality = 'high'
    t.drawImage(d.src, 0, 0)
    t.globalCompositeOperation = 'destination-in'
    t.drawImage(d.mask, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(d.tmp, 0, 0)

    const hv = hover.current
    if (hv) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.beginPath()
      ctx.arc(hv.x, hv.y, brushRef.current / 2, 0, Math.PI * 2)
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
      ctx.stroke()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = '#fff'
      ctx.stroke()
    }
  }

  const schedule = () => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(render)
  }

  const clampK = (k: number) => Math.min(Math.max(k, fitK.current), Math.max(MAX_ZOOM, fitK.current))

  function setView(v: View) {
    const d = doc.current
    if (!d) return
    const { w, h } = size.current
    const k = clampK(v.k)
    const iw = d.src.width * k
    const ih = d.src.height * k
    view.current = {
      k,
      x: iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, v.x)),
      y: ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, v.y)),
    }
    setZoom(k / fitK.current)
    schedule()
  }

  /** Zoom to `k`, keeping the image point under stage point `c` in place. */
  function zoomTo(k: number, c: Pt, from: View = view.current) {
    const nk = clampK(k)
    const u = (c.x - from.x) / from.k
    const v = (c.y - from.y) / from.k
    setView({ k: nk, x: c.x - u * nk, y: c.y - v * nk })
  }

  const center = (): Pt => ({ x: size.current.w / 2, y: size.current.h / 2 })

  function fit() {
    const d = doc.current
    if (!d) return
    const { w, h } = size.current
    fitK.current = Math.min(w / d.src.width, h / d.src.height)
    setView({ k: fitK.current, x: 0, y: 0 })
  }

  function layout() {
    const el = stage.current
    const c = canvas.current
    const d = doc.current
    if (!el || !c || !d) return
    const w = Math.max(1, el.clientWidth)
    const h = Math.max(1, el.clientHeight)
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    size.current = { w, h, dpr }
    c.width = d.tmp.width = Math.round(w * dpr)
    c.height = d.tmp.height = Math.round(h * dpr)
    fit()
  }

  useEffect(() => {
    let alive = true
    Promise.all([loadBitmap(src), loadBitmap(cut)]).then(([s, c]) => {
      if (!alive || !canvas.current) {
        s.close()
        c.close()
        return
      }
      const mask = document.createElement('canvas')
      mask.width = s.width
      mask.height = s.height
      mask.getContext('2d')!.drawImage(c, 0, 0, s.width, s.height)
      c.close()
      const tile = document.createElement('canvas')
      tile.width = tile.height = 16
      const tc = tile.getContext('2d')!
      tc.fillStyle = '#ffffff'
      tc.fillRect(0, 0, 16, 16)
      tc.fillStyle = '#e1e1e1'
      tc.fillRect(0, 0, 8, 8)
      tc.fillRect(8, 8, 8, 8)
      const checker = canvas.current.getContext('2d')!.createPattern(tile, 'repeat')!
      doc.current = { src: s, mask, tmp: document.createElement('canvas'), checker, undo: [], redo: [] }
      layout()
      setReady(true)
    })
    const ro = new ResizeObserver(() => layout())
    if (stage.current) ro.observe(stage.current)
    return () => {
      alive = false
      ro.disconnect()
      cancelAnimationFrame(frame.current)
      clearTimeout(hoverTimer.current)
      const d = doc.current
      if (d) {
        // Full-size canvases: given back at once rather than when collected (iPhones cap canvas memory).
        d.src.close()
        for (const c of [d.mask, d.tmp, ...d.undo, ...d.redo]) releaseCanvas(c)
      }
      doc.current = null
    }
    // The editor is remounted for a new photo; props don't change while it is open.
  }, [])

  // Wheel and Safari's trackpad gestures need non-passive listeners.
  useEffect(() => {
    const c = canvas.current!
    let gestureK = 1
    const local = (e: { clientX: number; clientY: number }) => {
      const r = c.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomTo(view.current.k * Math.exp(-e.deltaY * 0.01), local(e))
      else setView({ ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY })
    }
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureK = view.current.k
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      if (pointers.current.size >= 2) return // touch pinch is handled by the pointer events
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      zoomTo(gestureK * g.scale, local(g))
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    c.addEventListener('gesturestart', onGestureStart)
    c.addEventListener('gesturechange', onGestureChange)
    return () => {
      c.removeEventListener('wheel', onWheel)
      c.removeEventListener('gesturestart', onGestureStart)
      c.removeEventListener('gesturechange', onGestureChange)
    }
  }, [])

  function snapshot() {
    const d = doc.current!
    const c = document.createElement('canvas')
    c.width = d.mask.width
    c.height = d.mask.height
    c.getContext('2d')!.drawImage(d.mask, 0, 0)
    return c
  }

  const syncHistory = () => {
    const d = doc.current
    if (d) setHistory({ undo: d.undo.length, redo: d.redo.length })
  }

  function pushUndo() {
    const d = doc.current!
    d.undo.push(snapshot())
    if (d.undo.length > MAX_HISTORY) releaseCanvas(d.undo.shift()!)
    d.redo.forEach(releaseCanvas)
    d.redo = []
    syncHistory()
  }

  function replaceMask(from: CanvasImageSource) {
    const d = doc.current!
    const m = d.mask.getContext('2d')!
    m.globalCompositeOperation = 'source-over'
    m.clearRect(0, 0, d.mask.width, d.mask.height)
    m.drawImage(from, 0, 0, d.mask.width, d.mask.height)
    schedule()
  }

  function undo() {
    const d = doc.current
    const prev = d?.undo.pop()
    if (!d || !prev) return
    d.redo.push(snapshot())
    if (d.redo.length > MAX_HISTORY) releaseCanvas(d.redo.shift()!)
    replaceMask(prev)
    releaseCanvas(prev)
    syncHistory()
  }

  function redo() {
    const d = doc.current
    const next = d?.redo.pop()
    if (!d || !next) return
    d.undo.push(snapshot())
    if (d.undo.length > MAX_HISTORY) releaseCanvas(d.undo.shift()!)
    replaceMask(next)
    releaseCanvas(next)
    syncHistory()
  }

  async function reset() {
    if (!doc.current || !auto) return
    pushUndo()
    const a = await loadBitmap(auto)
    replaceMask(a)
    a.close()
  }

  async function done() {
    const d = doc.current
    if (!d || saving) return
    setSaving(true)
    try {
      const edited = await composeCutout(d.src, d.mask, false)
      // Closed meanwhile (another photo opened): nothing is saved, and a new editor isn't closed by this one.
      if (mounted.current) onDone(edited)
    } catch (e) {
      console.error(e)
      if (mounted.current) setSaving(false)
    }
  }

  function paint(a: Pt, b: Pt) {
    const m = doc.current!.mask.getContext('2d')!
    const r = brushRef.current / 2 / view.current.k
    m.globalCompositeOperation = toolRef.current === 'erase' ? 'destination-out' : 'source-over'
    m.strokeStyle = m.fillStyle = '#000'
    m.lineWidth = r * 2
    m.lineCap = m.lineJoin = 'round'
    m.beginPath()
    m.moveTo(a.x, a.y)
    m.lineTo(b.x, b.y)
    m.stroke()
    m.beginPath()
    m.arc(b.x, b.y, r, 0, Math.PI * 2)
    m.fill()
    schedule()
  }

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const toImage = (p: Pt): Pt => ({ x: (p.x - view.current.x) / view.current.k, y: (p.y - view.current.y) / view.current.k })

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!doc.current || saving) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = local(e)
    pointers.current.set(e.pointerId, p)
    if (pointers.current.size === 2) {
      // A second finger: this is a pinch, so take back the stroke the first finger started.
      if (stroke.current) {
        stroke.current = null
        const before = doc.current.undo.pop()
        if (before) replaceMask(before)
        syncHistory()
      }
      const [a, b] = [...pointers.current.values()]
      pinch.current = { d: Math.max(1, dist(a, b)), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v: { ...view.current } }
      blockPaint.current = true
      return
    }
    if (pointers.current.size > 2 || blockPaint.current) return
    if (e.button === 1 || e.button === 2 || space.current) {
      pan.current = { p, v: { ...view.current } }
      return
    }
    if (e.button !== 0) return
    pushUndo()
    const ip = toImage(p)
    stroke.current = { last: ip }
    paint(ip, ip)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = local(e)
    if (e.pointerType !== 'touch') {
      hover.current = p
      schedule()
    }
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, p)
    const g = pinch.current
    if (g && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const k = clampK((g.v.k * dist(a, b)) / g.d)
      // The image point that was under the fingers' midpoint follows the midpoint.
      const u = (g.m.x - g.v.x) / g.v.k
      const v = (g.m.y - g.v.y) / g.v.k
      setView({ k, x: m.x - u * k, y: m.y - v * k })
      return
    }
    if (pan.current) {
      const { p: p0, v } = pan.current
      setView({ ...v, x: v.x + p.x - p0.x, y: v.y + p.y - p0.y })
      return
    }
    if (stroke.current) {
      const ip = toImage(p)
      paint(stroke.current.last, ip)
      stroke.current.last = ip
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) blockPaint.current = false
    stroke.current = null
    pan.current = null
  }

  function showBrush(d: number) {
    setBrush(d)
    // No hover cursor on touch screens: show the new size in the middle for a moment.
    if (!isTouchDevice()) return
    hover.current = center()
    clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => {
      hover.current = null
      schedule()
    }, 900)
    schedule()
  }

  useEffect(() => {
    schedule()
  }, [brush])

  const activeRef = useRef(active)
  activeRef.current = active

  // Keyboard: E / R tools, [ ] brush, ⌘Z / ⇧⌘Z, 0 fit, + / − zoom, Space-drag pan, Esc, Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || document.querySelector('[aria-modal="true"]')) return
      const target = e.target as HTMLElement
      if (target.closest('input:not([type=range]), textarea')) return
      if (target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod || e.altKey) return
      if (key === 'e') setTool('erase')
      else if (key === 'r') setTool('restore')
      else if (key === '[') setBrush((b) => Math.max(BRUSH_MIN, Math.round(b / 1.25)))
      else if (key === ']') setBrush((b) => Math.min(BRUSH_MAX, Math.round(b * 1.25)))
      else if (key === '0') fit()
      else if (key === '+' || key === '=') zoomTo(view.current.k * 1.5, center())
      else if (key === '-') zoomTo(view.current.k / 1.5, center())
      else if (key === ' ') space.current = true
      else if (key === 'escape' || key === 'enter') {
        if (saving) return // the edits are being applied: like the disabled buttons, the keys wait
        if (key === 'escape') onCancel()
        else done()
      }
      else return
      e.preventDefault()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') space.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  })

  const touch = isTouchDevice()

  return (
    <div className="editor">
      <div ref={stage} className="editor-stage">
        <canvas
          ref={canvas}
          aria-label="Cutout editor: drag to erase or restore"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            hover.current = null
            schedule()
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!ready && (
          <div className="editor-overlay">
            <Spinner />
          </div>
        )}
        {saving && (
          <div className="editor-overlay">
            <Spinner /> Applying
          </div>
        )}
        <div className="editor-zoom">
          <button className="icon-btn" aria-label="Zoom out" onClick={() => zoomTo(view.current.k / 1.5, center())} disabled={zoom <= 1}>
            <IconZoomOut />
          </button>
          <button className="icon-btn zoom-label" aria-label="Fit to screen" onClick={fit} title="Fit (0)">
            {zoom > 1.01 ? `${zoom.toFixed(1)}×` : <IconFit />}
          </button>
          <button className="icon-btn" aria-label="Zoom in" onClick={() => zoomTo(view.current.k * 1.5, center())}>
            <IconZoomIn />
          </button>
        </div>
      </div>
      <div className="editor-tools">
        <div className="editor-row">
          <Chips label="Brush" options={TOOLS} labels={{ erase: 'Erase', restore: 'Restore' }} value={tool} onChange={setTool} />
          <span className="spacer" />
          <button className="icon-btn" aria-label="Undo" title="Undo (⌘Z)" onClick={undo} disabled={!history.undo}>
            <IconUndo />
          </button>
          <button className="icon-btn" aria-label="Redo" title="Redo (⇧⌘Z)" onClick={redo} disabled={!history.redo}>
            <IconRedo />
          </button>
        </div>
        <label className="editor-size">
          <span className="muted small">Brush size</span>
          <input
            type="range"
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            value={brush}
            onChange={(e) => showBrush(Number(e.target.value))}
          />
        </label>
        <p className="muted small editor-hint">
          {touch
            ? 'Drag to paint. Pinch to zoom; move around with two fingers.'
            : 'Drag to paint. Pinch or ⌘-scroll to zoom; scroll or hold Space to move. E / R switch tools, [ ] change the brush.'}
        </p>
        <div className="editor-actions">
          <button className="btn-secondary" onClick={reset} disabled={!ready || saving || !auto}>
            Reset
          </button>
          <span className="spacer" />
          <button className="btn-secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="btn" onClick={done} disabled={!ready || saving}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
