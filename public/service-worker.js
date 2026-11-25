/* Library Portal service worker: offline app shell only. No API caching (auth is live). */
const VERSION = 'v6';
const SHELL = ["/css/tokens.css", "/css/app.css", "/css/site.css", "/js/app.js", "/js/app.js?v=6", "/js/boot.js", "/js/landing.js", "/vendor/webauthn.js", "/app", "/"];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('library-' + VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== 'library-' + VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((res) => {
          if (res && res.ok && (url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.html') || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.webmanifest'))) {
            const copy = res.clone();
            caches.open('library-' + VERSION).then((c) => c.put(event.request, copy));
          }
          return res;
        }).catch(() => caches.match('/app'))
    )
  );
});
