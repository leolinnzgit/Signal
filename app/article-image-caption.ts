export type SmartCropRegion = {
  aspectRatio: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageFocalPoint = {
  focalX: number;
  focalY: number;
};

export type ArticleImageCaptionResponse = {
  available: boolean;
  reason: string;
  caption: string;
  confidence: number;
  denseCaptions: string[];
  width: number;
  height: number;
  focalX?: number;
  focalY?: number;
  smartCrops?: SmartCropRegion[];
};

export type ArticleImageOcrResponse = {
  available: boolean;
  reason: string;
  text: string;
  lines: string[];
  lineCount: number;
};

export const FOCAL_POINT_STORAGE_KEY = "signal:image-focal-points";
const MAX_STORED_FOCAL_POINTS = 300;
const LAZY_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_LAZY_CONCURRENCY = 2;

const captionCache = new Map<string, ArticleImageCaptionResponse>();
const inFlightCache = new Map<string, Promise<ArticleImageCaptionResponse>>();
const ocrCache = new Map<string, ArticleImageOcrResponse>();
const ocrInFlightCache = new Map<string, Promise<ArticleImageOcrResponse>>();

type LazyTask = {
  imageUrl: string;
  fetcher: typeof fetch;
  callbacks: Array<(res: ArticleImageCaptionResponse) => void>;
};

const lazyQueue: LazyTask[] = [];
let activeLazyCount = 0;
let lazyDisabledUntil = 0;

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

export function normalizeFocalCoordinate(value: unknown, fallback = 0.5): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * Formats normalized focal coordinates (0..1) into a CSS `object-position` value (e.g. `"80% 30%"`).
 */
export function formatFocalObjectPosition(focal?: Partial<ImageFocalPoint> | null): string {
  const x = normalizeFocalCoordinate(focal?.focalX, 0.5);
  const y = normalizeFocalCoordinate(focal?.focalY, 0.5);
  const pctX = Number((x * 100).toFixed(1));
  const pctY = Number((y * 100).toFixed(1));
  return `${pctX}% ${pctY}%`;
}

export function saveCachedImageFocalPoint(
  imageUrl: string,
  focal: ImageFocalPoint,
  storage?: Storage,
): void {
  const cleanUrl = imageUrl.trim();
  if (!cleanUrl) return;

  try {
    const store = getSafeStorage(storage);
    if (!store) return;

    const raw = store.getItem(FOCAL_POINT_STORAGE_KEY);
    const parsed: Record<string, [number, number]> = raw ? JSON.parse(raw) : {};
    // Delete first so re-insertion moves key to end (LRU order)
    delete parsed[cleanUrl];
    parsed[cleanUrl] = [
      Math.round(normalizeFocalCoordinate(focal.focalX) * 1000) / 1000,
      Math.round(normalizeFocalCoordinate(focal.focalY) * 1000) / 1000,
    ];

    const keys = Object.keys(parsed);
    if (keys.length > MAX_STORED_FOCAL_POINTS) {
      const excess = keys.length - MAX_STORED_FOCAL_POINTS;
      for (let i = 0; i < excess; i++) {
        delete parsed[keys[i]];
      }
    }

    store.setItem(FOCAL_POINT_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage quota or serialization errors
  }
}

export function getCachedImageFocalPoint(
  imageUrl: string,
  storage?: Storage,
): ImageFocalPoint | null {
  const cleanUrl = imageUrl.trim();
  if (!cleanUrl) return null;

  const mem = captionCache.get(cleanUrl);
  if (mem && mem.available) {
    return {
      focalX: normalizeFocalCoordinate(mem.focalX, 0.5),
      focalY: normalizeFocalCoordinate(mem.focalY, 0.5),
    };
  }

  try {
    const store = getSafeStorage(storage);
    if (!store) return null;
    const raw = store.getItem(FOCAL_POINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, [number, number] | undefined>;
    const tuple = parsed[cleanUrl];
    if (!Array.isArray(tuple) || tuple.length < 2) return null;
    return {
      focalX: normalizeFocalCoordinate(tuple[0], 0.5),
      focalY: normalizeFocalCoordinate(tuple[1], 0.5),
    };
  } catch {
    return null;
  }
}

export function getCachedImageCaption(imageUrl: string): ArticleImageCaptionResponse | null {
  const cleanUrl = imageUrl.trim();
  if (!cleanUrl) return null;
  return captionCache.get(cleanUrl) ?? null;
}

/** Clears the in-memory caption cache and optional persistent focal storage (useful in tests). */
export function clearCaptionCache(storage?: Storage): void {
  captionCache.clear();
  inFlightCache.clear();
  ocrCache.clear();
  ocrInFlightCache.clear();
  lazyQueue.length = 0;
  activeLazyCount = 0;
  lazyDisabledUntil = 0;
  if (storage) {
    try {
      storage.removeItem(FOCAL_POINT_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

function unavailableResponse(reason: string): ArticleImageCaptionResponse {
  return {
    available: false,
    reason,
    caption: "",
    confidence: 0,
    denseCaptions: [],
    width: 0,
    height: 0,
    focalX: 0.5,
    focalY: 0.5,
    smartCrops: [],
  };
}

/**
 * Loads an AI-generated description and smart focal crop for a news photo using Azure AI Vision.
 * Deduplicates concurrent in-flight requests and caches results in memory + focal points in localStorage.
 */
export async function loadArticleImageCaption(
  imageUrl: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  storage?: Storage,
): Promise<ArticleImageCaptionResponse> {
  const cleanUrl = imageUrl.trim();
  if (!cleanUrl) {
    return unavailableResponse("No image URL provided.");
  }

  if (signal?.aborted) {
    return unavailableResponse("Request aborted.");
  }

  const cached = captionCache.get(cleanUrl);
  if (cached) return cached;

  let sharedPromise = inFlightCache.get(cleanUrl);
  if (!sharedPromise) {
    sharedPromise = (async (): Promise<ArticleImageCaptionResponse> => {
      try {
        const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
        if (!csrf.ok) throw new Error("Could not acquire security token.");
        const { token } = (await csrf.json()) as { token?: string };
        if (!token) throw new Error("Security token missing.");

        const response = await fetcher("/api/article-image-caption", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
          body: JSON.stringify({ imageUrl: cleanUrl }),
        });

        if (!response.ok) {
          throw new Error("Azure image analysis is currently unavailable.");
        }

        const rawData = (await response.json()) as ArticleImageCaptionResponse;
        const data: ArticleImageCaptionResponse = {
          ...rawData,
          focalX: normalizeFocalCoordinate(rawData.focalX, 0.5),
          focalY: normalizeFocalCoordinate(rawData.focalY, 0.5),
          smartCrops: Array.isArray(rawData.smartCrops) ? rawData.smartCrops : [],
        };

        if (data.available) {
          captionCache.set(cleanUrl, data);
          saveCachedImageFocalPoint(
            cleanUrl,
            { focalX: data.focalX!, focalY: data.focalY! },
            storage,
          );
          lazyDisabledUntil = 0;
        }
        return data;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load image caption.";
        return unavailableResponse(message);
      } finally {
        inFlightCache.delete(cleanUrl);
      }
    })();

    inFlightCache.set(cleanUrl, sharedPromise);
  }

  if (!signal) {
    return sharedPromise;
  }

  return new Promise<ArticleImageCaptionResponse>((resolve) => {
    const onAbort = () => resolve(unavailableResponse("Request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    sharedPromise!.then((res) => {
      signal.removeEventListener("abort", onAbort);
      if (!signal.aborted) resolve(res);
    });
  });
}

function pumpLazyQueue(): void {
  if (Date.now() < lazyDisabledUntil) {
    while (lazyQueue.length > 0) {
      const skipped = lazyQueue.shift()!;
      const fallback = unavailableResponse("Vision lazy cropping paused.");
      for (const cb of skipped.callbacks) cb(fallback);
    }
    return;
  }

  while (activeLazyCount < MAX_LAZY_CONCURRENCY && lazyQueue.length > 0) {
    const task = lazyQueue.shift()!;
    activeLazyCount++;

    loadArticleImageCaption(task.imageUrl, task.fetcher)
      .then((res) => {
        if (!res.available) {
          const reasonLower = (res.reason || "").toLowerCase();
          if (
            reasonLower.includes("not been configured") ||
            reasonLower.includes("temporarily unavailable") ||
            reasonLower.includes("currently unavailable") ||
            reasonLower.includes("429")
          ) {
            lazyDisabledUntil = Date.now() + LAZY_COOLDOWN_MS;
          }
        }
        for (const cb of task.callbacks) cb(res);
      })
      .finally(() => {
        activeLazyCount = Math.max(0, activeLazyCount - 1);
        pumpLazyQueue();
      });
  }
}

/**
 * Enqueues a low-priority focal analysis for visible feed thumbnails.
 * Uses concurrency limiting and automatically pauses if Azure Vision is unconfigured.
 */
export function enqueueLazyImageFocalAnalysis(
  imageUrl: string,
  onResolved: (res: ArticleImageCaptionResponse) => void,
  fetcher: typeof fetch = fetch,
): () => void {
  const cleanUrl = imageUrl.trim();
  if (!cleanUrl || !cleanUrl.startsWith("https://")) {
    return () => {};
  }

  const cached = captionCache.get(cleanUrl);
  if (cached) {
    onResolved(cached);
    return () => {};
  }

  if (Date.now() < lazyDisabledUntil) {
    return () => {};
  }

  let cancelled = false;
  const wrapped = (res: ArticleImageCaptionResponse) => {
    if (!cancelled) onResolved(res);
  };

  const existing = lazyQueue.find((item) => item.imageUrl === cleanUrl);
  if (existing) {
    existing.callbacks.push(wrapped);
  } else {
    lazyQueue.push({ imageUrl: cleanUrl, fetcher, callbacks: [wrapped] });
    pumpLazyQueue();
  }

  return () => {
    cancelled = true;
    const idx = lazyQueue.findIndex((item) => item.imageUrl === cleanUrl);
    if (idx >= 0) {
      lazyQueue[idx].callbacks = lazyQueue[idx].callbacks.filter((cb) => cb !== wrapped);
      if (lazyQueue[idx].callbacks.length === 0) {
        lazyQueue.splice(idx, 1);
      }
    }
  };
}

function unavailableOcrResponse(reason: string): ArticleImageOcrResponse {
  return {
    available: false,
    reason,
    text: "",
    lines: [],
    lineCount: 0,
  };
}

/**
 * Extracts embedded text from news graphics, charts, and screenshots on demand using Azure AI Vision Read OCR.
 * Deduplicates concurrent requests and caches results in memory.
 */
export async function loadArticleImageOcr(
  imageUrl: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ArticleImageOcrResponse> {
  const cleanUrl = imageUrl.trim();
  if (!cleanUrl) {
    return unavailableOcrResponse("No image URL provided.");
  }

  if (signal?.aborted) {
    return unavailableOcrResponse("Request aborted.");
  }

  const cached = ocrCache.get(cleanUrl);
  if (cached) return cached;

  let sharedPromise = ocrInFlightCache.get(cleanUrl);
  if (!sharedPromise) {
    sharedPromise = (async (): Promise<ArticleImageOcrResponse> => {
      try {
        const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
        if (!csrf.ok) throw new Error("Could not acquire security token.");
        const { token } = (await csrf.json()) as { token?: string };
        if (!token) throw new Error("Security token missing.");

        const response = await fetcher("/api/article-image-caption/ocr", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
          body: JSON.stringify({ imageUrl: cleanUrl }),
        });

        if (!response.ok) {
          throw new Error("Image text extraction is currently unavailable.");
        }

        const raw = (await response.json()) as ArticleImageOcrResponse;
        const lines = Array.isArray(raw.lines) ? raw.lines : [];
        const data: ArticleImageOcrResponse = {
          available: Boolean(raw.available && raw.text),
          reason: raw.reason || "",
          text: raw.text || "",
          lines,
          lineCount: typeof raw.lineCount === "number" ? raw.lineCount : lines.length,
        };

        // Cache both extracted text and confirmed "no text in image" responses to conserve Vision quota
        if (data.available || data.reason.toLowerCase().includes("no readable text")) {
          ocrCache.set(cleanUrl, data);
        }
        return data;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to extract text from image.";
        return unavailableOcrResponse(message);
      } finally {
        ocrInFlightCache.delete(cleanUrl);
      }
    })();

    ocrInFlightCache.set(cleanUrl, sharedPromise);
  }

  if (!signal) {
    return sharedPromise;
  }

  return new Promise<ArticleImageOcrResponse>((resolve) => {
    const onAbort = () => resolve(unavailableOcrResponse("Request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    sharedPromise!.then((res) => {
      signal.removeEventListener("abort", onAbort);
      if (!signal.aborted) resolve(res);
    });
  });
}
