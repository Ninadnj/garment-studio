import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider } from './components/Toast'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
)

// A part of the app that loads on first use (background removal, HEIC, zip) and belongs to an older version
// that the server no longer has: the app was opened from the cache on a slow connection, or stayed open across
// an update. Load the current version once instead of failing.
const RELOADED = 'gs.reloadedForUpdate'
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem(RELOADED)) return // already tried: let the error show
    sessionStorage.setItem(RELOADED, '1')
  } catch {
    return
  }
  e.preventDefault()
  location.reload()
})
window.addEventListener('load', () =>
  setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOADED)
    } catch {}
  }, 15_000),
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}))
}
