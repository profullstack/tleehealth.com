// Minimal service worker: makes the app installable and keeps the shell offline.
// Bump VERSION on every shell change or returning visitors keep the old page.
const VERSION = 'tleehealth-v9';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(['/', '/app', '/assets/app.js', '/assets/app.css', '/assets/vault-crypto.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tleehealth-v') && k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname.startsWith('/health/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
