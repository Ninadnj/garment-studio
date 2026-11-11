import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

export interface ToastInput {
  text: string
  action?: { label: string; run: () => void }
  error?: boolean
}

type Toast = ToastInput & { id: number }

const ToastContext = createContext<(t: ToastInput) => void>(() => {})

export const useToast = () => useContext(ToastContext)

/**
 * Short messages at the bottom of the screen; one with an action (Undo) stays longer, and none goes away while
 * the pointer or focus is on it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])
  const later = useCallback(
    (id: number, ms: number) => {
      clearTimeout(timers.current.get(id))
      timers.current.set(id, window.setTimeout(() => dismiss(id), ms))
    },
    [dismiss],
  )
  const hold = (id: number) => clearTimeout(timers.current.get(id))

  const show = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current
      setToasts((ts) => [...ts.slice(-2), { ...t, id }])
      later(id, t.action ? 10_000 : t.error ? 6000 : 3500)
    },
    [later],
  )

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.error ? 'toast-error' : ''}`}
            onPointerEnter={() => hold(t.id)}
            onPointerLeave={() => later(t.id, 3000)}
            onFocus={() => hold(t.id)}
            onBlur={() => later(t.id, 3000)}
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  dismiss(t.id)
                  t.action!.run()
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
