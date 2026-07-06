// Minimal service worker: makes the app installable + caches the shell so it
// opens instantly. Network-first for everything; falls back to cache offline.
const CACHE = 'cc-mobile-v96';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || request.url.includes('/api/') || request.url.includes('/ws')) return;
  e.respondWith(
    fetch(request).then((res) => {
      if (res.ok && new URL(request.url).origin === location.origin) {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }).catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
  );
});
