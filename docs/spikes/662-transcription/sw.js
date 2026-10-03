// Installation/offline fixture only; never caches reports, clips or POSTs.
const cacheName = "662-spike-v1";
const assets = ["./", "index.html", "spike.mjs", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin)
    return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
