const STATIC_CACHE = "signal-static-v4";
const APP_BADGE_MESSAGE = "signal:update-app-badge";
const NEWS_NOTIFICATION_TAG = "signal-new-stories";
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
  const operations = [];
  if (count > 0 && typeof self.navigator.setAppBadge === "function") {
    operations.push(self.navigator.setAppBadge(count));
  } else if (count === 0 && typeof self.navigator.clearAppBadge === "function") {
    operations.push(self.navigator.clearAppBadge());
  }
  if (count === 0) {
    operations.push(
      self.registration.getNotifications({ tag: NEWS_NOTIFICATION_TAG })
        .then((notifications) => notifications.forEach((notification) => notification.close())),
    );
  }

  if (operations.length > 0) {
    event.waitUntil(Promise.all(operations.map((operation) => operation.catch(() => {
      // Badging and notification cleanup are optional OS integrations.
    }))));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = {};
  }

  const requestedCount = Number(payload.badgeCount);
  const count = Number.isFinite(requestedCount) && requestedCount > 0
    ? Math.min(Math.floor(requestedCount), 99)
    : 0;
  const requestedUrl = new URL(payload.url || "/", self.location.origin);
  const url = requestedUrl.origin === self.location.origin
    ? `${requestedUrl.pathname}${requestedUrl.search}${requestedUrl.hash}`
    : "/";
  const operations = [
    self.registration.showNotification(payload.title || "New stories in Signal", {
      body: payload.body || "Fresh coverage is ready in your briefing.",
      icon: payload.icon || "/icons/signal-192.png",
      badge: payload.badge || "/icons/signal-192.png",
      tag: NEWS_NOTIFICATION_TAG,
      renotify: false,
      data: { url },
    }),
  ];

  if (count > 0 && typeof self.navigator.setAppBadge === "function") {
    operations.push(self.navigator.setAppBadge(count));
  } else if (count === 0 && typeof self.navigator.clearAppBadge === "function") {
    operations.push(self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(operations));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windows) => {
        const existing = windows.find((client) =>
          new URL(client.url).origin === self.location.origin);
        if (existing) {
          await existing.navigate(url);
          return existing.focus();
        }
        return self.clients.openWindow(url);
      }),
  );
});
