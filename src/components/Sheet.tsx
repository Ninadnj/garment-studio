import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconClose } from './Icons'

/**
 * Bottom sheet on phones, centred dialog on wider screens. `confirmClose` is asked before closing (return false
 * to stay open), e.g. while closing would throw away unsaved work.
 */
export function Sheet({
  title,
  onClose,
  confirmClose,
  children,
}: {
  title: string
  onClose: () => void
  confirmClose?: () => boolean
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const close = () => {
    if (!confirmClose || confirmClose()) onClose()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  // A click on the backdrop closes only when it also started there: selecting text in a field and letting go
  // outside the sheet is not a click on the backdrop.
  const downOnBackdrop = useRef(false)
  // What had focus before the sheet opened (read while rendering, before a field inside takes focus).
  const [opener] = useState(() => document.activeElement as HTMLElement | null)

  // Focus moves into the sheet, and back to what opened it when it closes.
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) box.current?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [opener])

  /** Tab and Shift-Tab go round inside the sheet, not to the page behind it. */
  function trap(e: React.KeyboardEvent) {
    if (e.key !== 'Tab' || !box.current) return
    const items = [
      ...box.current.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'),
    ].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [])

  return (
    <div
      className="sheet-backdrop"
      onPointerDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) close()
        downOnBackdrop.current = false
      }}
    >
      <div
        ref={box}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={trap}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
