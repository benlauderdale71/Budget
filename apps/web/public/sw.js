const CACHE = "budgetcents-__CACHE_ID__";
const PRECACHE = [];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("budgetcents-") && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/stocks-crypto" || url.pathname.startsWith("/stocks-crypto/")) return;
  if (url.pathname.startsWith("/api")) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE);
        await cache.put("/index.html", response.clone());
        return response;
      } catch {
        const cached = await caches.match("/index.html");
        if (cached) return cached;
        return new Response("BudgetCents is offline and this page is not saved on the device.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icon"))) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return new Response("This file is not available offline.", {
        status: 504,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  })());
});
