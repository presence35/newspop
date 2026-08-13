// NewsPop service worker.
// Strategy (helpers in /sw/strategies.js):
//   - Static shell (/, css/*, js/*, manifest): precached, stale-while-revalidate.
//   - Logos (/logo/*): cache-first.
//   - Data APIs: /api/sources, /api/filters, /api/my-bias are network-first with a
//     bounded (MAX_API_ENTRIES) offline mirror; the volatile /api/feed and
//     /api/blindspots are network-only so the cache can't balloon again. POSTs
//     (clicks, manual ingest) always hit the network.
//   - Old cache versions are cleaned up on activate.
importScripts("/sw/strategies.js");

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(self.CACHE_NAME).then((cache) => cache.addAll(self.PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== self.CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST /api/click, /api/ingest always go to network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Data APIs: network-first, cached fallback for offline.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Static shell + manifest: stale-while-revalidate.
  if (url.pathname === "/" || url.pathname.startsWith("/css/") || url.pathname.startsWith("/js/") || url.pathname === "/sw.js" || url.pathname.startsWith("/sw/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Logos and icons: cache-first.
  if (url.pathname.startsWith("/logo/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(req));
  }
});
