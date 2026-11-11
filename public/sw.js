// Pages: the network first, so new deploys show up, but the cached app opens after 3 s on a weak connection
// (the network answer still updates the cache). Offline, the cached app opens.
// Hashed /assets/ and background-removal model files (staticimgly.com, versioned): cache-first.
const SHELL = 'gs-shell-v1'
const MODELS = 'gs-models-v1'
const NETWORK_WAIT = 3000

// onnxruntime's WebAssembly files are about 25 MB each; when an update brings a new one, the old one goes.
const family = (url) => new URL(url).pathname.replace(/-[\w-]{8}(\.wasm)$/, '$1')
async function dropOldVersions(cache, url) {
  if (!url.endsWith('.wasm')) return
  for (const k of await cache.keys()) if (k.url !== url && k.url.endsWith('.wasm') && family(k.url) === family(url)) await cache.delete(k)
}

async function cacheFirst(name, req) {
  const cache = await caches.open(name)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok)
    cache
      .put(req, res.clone())
      .then(() => name === SHELL && dropOldVersions(cache, req.url))
      .catch(() => {})
  return res
}

// The page and the files it loads first, so the app opens offline after one online visit (the first page load
// happens before this worker controls the page, so it is not cached otherwise).
async function precache() {
  const cache = await caches.open(SHELL)
  const res = await fetch('./', { cache: 'no-cache' })
  if (!res.ok) return
  const html = await res.clone().text()
  await cache.put('./', res)
  const urls = [...html.matchAll(/(?:src|href)="(\.?\/?(?:assets\/[^"]+|manifest\.webmanifest))"/g)].map((m) => new URL(m[1], self.registration.scope).href)
  await Promise.all(urls.map((u) => cache.add(u).catch(() => {})))
}

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Garment Studio</title>
<p style="font: 16px/1.5 system-ui, sans-serif; padding: 24px">Garment Studio needs a connection the first time it opens. Connect to the internet and reload.</p>`

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(precache().catch(() => {}))
})

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

  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone()
      caches.open(SHELL).then((cache) => cache.put(req, copy))
    }
    return res
  })
  event.waitUntil(network.catch(() => {}))
  event.respondWith(
    (async () => {
      const cached = (await caches.match(req)) ?? (req.mode === 'navigate' ? await caches.match('./') : undefined)
      if (!cached)
        return network.catch(() =>
          req.mode === 'navigate' ? new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : Response.error(),
        )
      const waited = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT))
      return Promise.race([network.catch(() => cached), waited])
    })(),
  )
})
