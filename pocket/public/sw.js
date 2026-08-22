const CACHE = "heddle-pocket-v1";
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("/")).catch(() => undefined));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const isNavigation = event.request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html");
  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response && response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put("/", copy)); }
        return response;
      } catch { return (await caches.match("/")) || Response.error(); }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response && response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); }
    return response;
  })());
});
