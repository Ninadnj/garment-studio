// Pages: network-first so new deploys show up; falls back to cache offline.
// Hashed /assets/ and background-removal model files (staticimgly.com, versioned): cache-first.
const SHELL = 'gs-shell-v1'
const MODELS = 'gs-models-v1'

async function cacheFirst(name, req) {
  const cache = await caches.open(name)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) cache.put(req, res.clone())
  return res
}

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Only this app's old caches: other sites on the same origin (e.g. GitHub Pages) keep theirs.
      Promise.all(
        keys.filter((k) => k.startsWith('gs-') && k !== SHELL && k !== MODELS).map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  if (url.hostname === 'staticimgly.com') {
    event.respondWith(cacheFirst(MODELS, req))
    return
  }

  if (url.origin !== self.location.origin) return

  // Hashed build files never change under the same name.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(SHELL, req))
    return
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(SHELL).then((cache) => cache.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./'))),
  )
})
