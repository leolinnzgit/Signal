const STATIC_CACHE = "signal-static-v2";
const APP_BADGE_MESSAGE = "signal:update-app-badge";
const STATIC_ASSETS = [
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/signal-180.png",
  "/icons/signal-192.png",
  "/icons/signal-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith("signal-static-") && name !== STATIC_CACHE)
          .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isStaticAsset = url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/icons/")
    || url.pathname === "/favicon.svg"
    || url.pathname === "/manifest.webmanifest";
  if (!isStaticAsset) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== APP_BADGE_MESSAGE) return;

  const requestedCount = Number(event.data.count);
  const count = Number.isFinite(requestedCount) && requestedCount > 0
    ? Math.min(Math.floor(requestedCount), 99)
    : 0;
  const badgeNavigator = self.navigator;
  const operation = count > 0
    ? badgeNavigator.setAppBadge?.(count)
    : badgeNavigator.clearAppBadge?.();

  if (operation) {
    event.waitUntil(operation.catch(() => {
      // Badging is optional and can be blocked by the browser or OS.
    }));
  }
});
