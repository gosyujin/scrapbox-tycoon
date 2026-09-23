// Offline app-shell cache. Data itself never needs this: pages live in
// localStorage (own notes) or, later, IndexedDB (imported reference
// project), both already available with zero network. What was missing was
// index.html/css/js loading at all with no network route -- this fixes that.
//
// Deployed assets other than index.html are cache-busted with a `?v=<sha>`
// query param (see deploy-pages.yml / cache-bust-imports.mjs) and are
// therefore immutable for that URL forever: safe to cache-first. index.html
// itself is not versioned, so it's network-first with a cache fallback,
// keeping normal online use always on the latest build while still working
// offline from whatever was last cached. build-info.json is deliberately
// left uncached (app.ts fetches it with cache: 'no-store' to show the truly
// current build) and just falls through to the network as-is, failing
// harmlessly offline (already handled by app.ts).
const CACHE_NAME = 'scrapbox-tycoon-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave the GitHub API etc. alone
  if (url.pathname.endsWith('build-info.json')) return; // always wants a live network answer

  // A background cache write started here but not passed to waitUntil() can
  // be killed mid-write once respondWith()'s promise settles -- the browser
  // is free to shut the worker down right after it has its response.
  const cachePut = (res) => {
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)));
    }
    return res;
  };

  const isVersioned = url.searchParams.has('v');
  if (isVersioned) {
    event.respondWith(caches.match(req).then((cached) => cached || fetch(req).then(cachePut)));
    return;
  }

  event.respondWith(
    fetch(req)
      .then(cachePut)
      .catch(() => caches.match(req))
  );
});
