// Minimal offline shell cache. No offline data, no background sync — the app
// has nothing to sync, it only needs its own files available without a
// network round trip on repeat visits.
const CACHE = 'delay-detector-v4';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './src/app.js', './src/engine.js', './src/capture.js', './src/dropdown.js',
  './src/log.js', './src/store.js', './src/recorder-worklet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
