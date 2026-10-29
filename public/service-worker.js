const STATIC_CACHE = "signal-static-v11";
const APP_BADGE_MESSAGE = "signal:update-app-badge";
const NEWS_NOTIFICATION_TAG = "signal-new-stories";
const publicShell = (html) => /<div\s+id=["']root["']\s*>\s*<\/div>/i.test(html) && /["']\/assets\/index-[^"']+\.js["']/i.test(html);
const STATIC_ASSETS = [
  "/seasonal-branding.js",
  "/icons/signal-halloween.svg",
  "/icons/signal-christmas.svg",
  "/icons/signal-new-year.svg",
  "/icons/signal-chinese-new-year.svg",
  "/manifest.webmanifest",
  "/icons/signal-medallion-64.png",
  "/icons/signal-medallion-180.png",
  "/icons/signal-medallion-192.png",
  "/icons/signal-medallion-512.png",
  "/icons/signal-medallion-maskable-192.png",
  "/icons/signal-medallion-maskable-512.png",
  "/icons/signal-notification-medallion-96.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(async (cache) => {
        // IIS serves a public, static React shell here. Account/API responses are never cached.
        await cache.addAll(STATIC_ASSETS);
        const shell = await fetch("/", { cache: "no-store" });
        const html = shell.ok ? await shell.clone().text() : "";
        if (!publicShell(html)) return;
        await cache.put("/", shell);
        const assets = [...html.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)]
          .map((match) => new URL(match[1], self.location.origin))
          .filter((url) => url.origin === self.location.origin && url.pathname.startsWith("/assets/"))
          .map((url) => url.href);
        await cache.addAll([...new Set(assets)]);
      })
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

  if (request.mode === "navigate" && url.pathname === "/") {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok && !url.search && response.headers.get("Content-Type")?.includes("text/html")) {
        const copy = response.clone();
        if (publicShell(await copy.clone().text())) await caches.open(STATIC_CACHE).then((cache) => cache.put("/", copy));
      }
      return response;
    }).catch(async () => {
      const shell = await caches.match("/");
      return shell || new Response("Signal is offline. Open it once while connected to save the app.", { status: 503, headers: { "Content-Type": "text/plain" } });
    }));
    return;
  }

  const isStaticAsset = url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/icons/")
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
      self.registration.getNotifications()
        .then((notifications) => notifications
          .filter((notification) => notification.tag === NEWS_NOTIFICATION_TAG
            || notification.tag.startsWith(`${NEWS_NOTIFICATION_TAG}-`))
          .forEach((notification) => notification.close())),
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
      icon: payload.icon || "/icons/signal-medallion-192.png",
      badge: payload.badge || "/icons/signal-notification-medallion-96.png",
      tag: typeof payload.tag === "string" && (payload.tag.startsWith(`${NEWS_NOTIFICATION_TAG}-`) || payload.tag.startsWith("signal-earthquake-") || payload.tag.startsWith("signal-disaster-"))
        ? payload.tag
        : NEWS_NOTIFICATION_TAG,
      renotify: false,
      data: { url },
    }),
  ];

  if (typeof payload.tag === "string" && (payload.tag.startsWith("signal-earthquake-") || payload.tag.startsWith("signal-disaster-"))) {
    // Earthquake alerts must not clear the unrelated unread-news badge.
    event.waitUntil(Promise.all(operations));
    return;
  }
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
  event.waitUntil(openSignalFromNotification(url));
});

async function openSignalFromNotification(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const exactWindow = windows.find((client) => client.url === url);
  if (exactWindow) {
    try {
      await exactWindow.focus();
      return;
    } catch {
      // Android can retain a stale window client after the installed app closes.
    }
  }

  // On Android, openWindow plus the manifest launch handler routes an in-scope
  // URL into the installed PWA and reuses its existing window when possible.
  try {
    const opened = await self.clients.openWindow(url);
    if (opened) {
      try {
        await opened.focus();
      } catch {
        // The newly launched window may already be foregrounded.
      }
      return;
    }
  } catch {
    // Fall through to an existing same-origin client if app launch is blocked.
  }

  const existing = windows.find((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  if (!existing) return;

  try {
    const navigated = await existing.navigate(url);
    await (navigated || existing).focus();
  } catch {
    try {
      await existing.focus();
    } catch {
      // There is no remaining client to foreground.
    }
  }
}
