// AgentSwarms service worker — deliberately conservative so it can never serve
// stale app code or interfere with auth/data:
//   • Only same-origin GET requests are considered.
//   • /api/* (and anything cross-origin, e.g. Supabase) is never touched.
//   • Content-hashed assets under /assets/* are cache-first (immutable).
//   • Navigations are network-first with an offline fallback page.
// Bump VERSION when this file changes to drop the old caches.
const VERSION = "v1";
const STATIC_CACHE = `as-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // cross-origin: passthrough
  if (url.pathname.startsWith("/api/")) return; // never cache API / server fns

  // Immutable, content-hashed build assets: cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return hit || Response.error();
        }
      }),
    );
    return;
  }

  // Page navigations: always try the network first (fresh SSR), fall back to
  // the offline shell when there's no connection.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
    );
    return;
  }
  // Everything else falls through to the default network behaviour.
});
