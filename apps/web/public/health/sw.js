const CACHE = 'tleehealth-health-v3';
const SHELL = ['/health/', '/health/health.css', '/health/health.js', '/health/manifest.webmanifest', '/assets/vault-crypto.js', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('tleehealth-health-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (!url.pathname.startsWith('/health/') && url.pathname !== '/assets/vault-crypto.js') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => event.request.mode === 'navigate' ? caches.match('/health/') : Response.error())),
  );
});
