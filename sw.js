// Offline shell cache.
//
// Deliberately NETWORK-FIRST, not cache-first. This app's answers are only as
// correct as the code computing them — a stale engine.js silently produces
// wrong delay numbers, which is far worse than a slower load or no offline
// mode. An earlier cache-first version meant every deploy was invisible until
// the second reload, and users measured against old DSP without knowing.
// Cache is the fallback for genuinely being offline, nothing more.
const CACHE = 'delay-detector-v9';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './src/app.js', './src/engine.js', './src/capture.js', './src/dropdown.js',
  './src/log.js', './src/store.js', './src/version.js', './src/recorder-worklet.js',
  './src/batch.js', './src/dialog.js', './src/meter.js', './src/bridge.js',
  './src/vmsync.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {
      // A single missing asset must not abort the install and leave the page
      // without a controller.
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // The local companion app is a different, plain-HTTP origin. Letting a
  // service worker touch it turns a clean connection-refused into an opaque
  // failure and hides the bridge's own error codes, so stay out of the way.
  const url = new URL(req.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
