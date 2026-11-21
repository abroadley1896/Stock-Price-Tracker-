// Caches the app shell so it opens instantly / offline. Prices always come from the network.
const CACHE = 'tickerwatch-v7';
const SHELL = ['./', 'index.html', 'styles.css?v=7', 'app.js?v=7', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return; // price lookups go straight to the network
  // Network first so updates show up, fall back to cache when offline
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // always check GitHub for a newer version
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
