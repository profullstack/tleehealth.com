const CACHE = 'tleehealth-health-v4';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('tleehealth-health-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => {
        setTimeout(() => {
          self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const client of clients) {
              const path = new URL(client.url).pathname;
              if (path === '/health' || path.startsWith('/health/')) client.navigate('/health/').catch(() => {});
            }
          });
        }, 0);
      }),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (!url.pathname.startsWith('/health/') && url.pathname !== '/assets/vault-crypto.js') return;
  event.respondWith(fetch(event.request));
});
