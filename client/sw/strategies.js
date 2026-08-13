// sw/strategies.js — cache strategies shared by the service worker.
self.CACHE_NAME = "newspop-v3";
self.PRECACHE_URLS = [
  "/",
  "/css/base.css",
  "/css/feed.css",
  "/css/sources.css",
  "/css/mybias.css",
  "/css/responsive.css",
  "/js/state.js",
  "/js/util.js",
  "/js/render.js",
  "/js/views.js",
  "/js/interactions.js",
  "/js/init.js",
  "/manifest.webmanifest",
];

// Only these small, stable data endpoints are worth an offline mirror. The feed
// goes stale within ~15 minutes anyway (re-ingest) and is the #1 source of
// cache bloat — every filter/search/scroll page is a distinct URL cached for
// ever, which grew the Android SW cache past 700MB. Other /api/* stay
// network-only (their network-first catch still serves the offline shell).
const CACHEABLE_API_PREFIXES = ["/api/sources", "/api/filters", "/api/my-bias"];
const MAX_API_ENTRIES = 30; // ~5MB of stale snapshots max; oldest evicted first

function isCacheableApi(url) {
  return CACHEABLE_API_PREFIXES.some((p) => url.pathname.startsWith(p));
}

function cachePut(request, response) {
  if (!response || response.status !== 200) return;
  const copy = response.clone();
  const url = new URL(request.url);
  caches.open(self.CACHE_NAME).then((cache) =>
    cache.put(request, copy).then(() => trimApiCache(cache, url))
  );
}

// Bounded cache: after each write, keep at most MAX_API_ENTRIES /api/ entries,
// dropping the oldest (cache keys come back in insertion order). This is what
// stops the SW cache from accumulating hundreds of MB of stale feed snapshots.
function trimApiCache(cache, currentUrl) {
  return cache.keys().then((keys) => {
    const apiKeys = keys.filter((k) => k.url.includes("/api/"));
    if (apiKeys.length <= MAX_API_ENTRIES) return;
    const victims = apiKeys.filter((k) => k.url !== currentUrl.href).slice(0, apiKeys.length - MAX_API_ENTRIES);
    return Promise.all(victims.map((k) => cache.delete(k)));
  });
}

// Data APIs: network-first, cached fallback for offline.
function networkFirst(req) {
  const url = new URL(req.url);
  return fetch(req)
    .then((res) => {
      if (isCacheableApi(url)) cachePut(req, res);
      return res;
    })
    .catch(() =>
      caches.match(req).then((cached) => cached || caches.match("/").then((shell) => shell || Response.error()))
    );
}

// Static shell + manifest: stale-while-revalidate.
function staleWhileRevalidate(req) {
  return caches.match(req).then((cached) => {
    // `cache: "no-store"` stops the revalidation fetch from being answered by
    // the browser's HTTP cache, so the SW always learns about the newest file.
    const network = fetch(req, { cache: "no-store" })
      .then((res) => {
        cachePut(req, res);
        return res;
      })
      .catch(() => cached);
    return cached || network;
  });
}

// Logos and icons: cache-first. Only hit the network on a cache miss — a
// background refetch on every render used to flood the server with logo
// requests each time the feed re-rendered (defeating the browser's HTTP cache).
function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      cachePut(req, res);
      return res;
    });
  });
}
