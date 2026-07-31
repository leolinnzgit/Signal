export const APP_BADGE_MESSAGE = "signal:update-app-badge";

type BadgeServiceWorker = {
  postMessage: (message: { type: string; count: number }) => void;
};

type BadgeServiceWorkerRegistration = {
  active?: BadgeServiceWorker | null;
};

type BadgeServiceWorkerContainer = {
  ready: Promise<BadgeServiceWorkerRegistration>;
};

export type AppBadgeTarget = {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  serviceWorker?: BadgeServiceWorkerContainer;
};

export function normalizeAppBadgeCount(count: number) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.floor(count), 99);
}

export async function updateInstalledAppBadge(
  count: number,
  target: AppBadgeTarget = navigator as Navigator & AppBadgeTarget,
) {
  const normalizedCount = normalizeAppBadgeCount(count);
  let updated = false;

  try {
    if (normalizedCount > 0 && typeof target.setAppBadge === "function") {
      await target.setAppBadge(normalizedCount);
      updated = true;
    }
    if (normalizedCount === 0 && typeof target.clearAppBadge === "function") {
      await target.clearAppBadge();
      updated = true;
    }
  } catch {
    // Some browser shells expose the API before the PWA has been installed.
    // The active service worker can still handle the update when supported.
  }

  try {
    const registration = await target.serviceWorker?.ready;
    if (!registration?.active) return updated;
    registration.active.postMessage({
      type: APP_BADGE_MESSAGE,
      count: normalizedCount,
    });
    return true;
  } catch {
    return updated;
  }
}
