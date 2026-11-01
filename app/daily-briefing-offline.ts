import type { DailyBriefingData } from "./daily-briefing.ts";
import {
  articleNarrationParts,
  normalizeReadingVoices,
  prepareHeadlineAudio,
  READING_VOICES_STORAGE_KEY,
  type PreparedHeadlineAudio,
  type ReadingVoicePreferences,
} from "./headline-audio.ts";
import {
  getCachedOfflineArticle,
  prewarmBookmarkedArticle,
  type PrewarmResult,
} from "./offline-prewarm.ts";

export const OFFLINE_BRIEFING_CACHE_NAME = "signal-offline-briefing-v1";
export const OFFLINE_BRIEFING_AUDIO_URL = "/__offline_briefing__/daily-briefing.wav";
export const OFFLINE_BRIEFING_META_KEY = "signal:offline-briefing-pack:v1";
export const OFFLINE_BRIEFING_AUTO_KEY = "signal:offline-briefing-auto:v1";

export type OfflineBriefingPackMeta = {
  id: string;
  savedAt: string;
  briefing: DailyBriefingData;
  hasNeuralAudio: boolean;
  audioBytes: number;
  prewarmedStoryCount: number;
  language: string;
  audioWarning?: string;
};

export interface BriefingAudioCacheStore {
  put(packId: string, blob: Blob): Promise<void>;
  get(packId?: string): Promise<Blob | null>;
  clear(): Promise<void>;
}

/**
 * Stores neural WAV audio chunks inside Web Cache Storage (`caches.open("signal-offline-briefing-v1")`)
 * so offline commute playback works across reloads and airplane mode.
 */
export class BrowserCacheStorageAudioStore implements BriefingAudioCacheStore {
  private readonly cacheStorage: CacheStorage | undefined;

  constructor(
    cacheStorage: CacheStorage | undefined = typeof caches !== "undefined"
      ? caches
      : undefined,
  ) {
    this.cacheStorage = cacheStorage;
  }

  async put(packId: string, blob: Blob): Promise<void> {
    if (!this.cacheStorage) {
      throw new Error("Cache Storage is unavailable in this browser.");
    }
    const cache = await this.cacheStorage.open(OFFLINE_BRIEFING_CACHE_NAME);
    const response = new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": blob.type || "audio/wav",
        "Content-Length": String(blob.size),
        "X-Signal-Briefing-Id": packId,
      },
    });
    await cache.put(OFFLINE_BRIEFING_AUDIO_URL, response);
  }

  async get(expectedPackId?: string): Promise<Blob | null> {
    if (!this.cacheStorage) return null;
    try {
      const cache = await this.cacheStorage.open(OFFLINE_BRIEFING_CACHE_NAME);
      const response = await cache.match(OFFLINE_BRIEFING_AUDIO_URL);
      if (!response || !response.ok) return null;
      if (expectedPackId) {
        const storedId = response.headers.get("X-Signal-Briefing-Id");
        if (storedId && storedId !== expectedPackId) return null;
      }
      const blob = await response.blob();
      return blob.size > 44 ? blob : null;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    if (!this.cacheStorage) return;
    try {
      await this.cacheStorage.delete(OFFLINE_BRIEFING_CACHE_NAME);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * In-memory fallback store used in unit tests or restricted webviews without CacheStorage.
 */
export class MemoryBriefingAudioStore implements BriefingAudioCacheStore {
  private entry: { packId: string; blob: Blob } | null = null;

  async put(packId: string, blob: Blob): Promise<void> {
    this.entry = { packId, blob };
  }

  async get(expectedPackId?: string): Promise<Blob | null> {
    if (!this.entry) return null;
    if (expectedPackId && this.entry.packId !== expectedPackId) return null;
    return this.entry.blob.size > 44 ? this.entry.blob : null;
  }

  async clear(): Promise<void> {
    this.entry = null;
  }
}

const fallbackMemoryAudioStore = new MemoryBriefingAudioStore();

function resolveAudioStore(audioStore?: BriefingAudioCacheStore): BriefingAudioCacheStore {
  if (audioStore) return audioStore;
  if (typeof caches !== "undefined") return new BrowserCacheStorageAudioStore(caches);
  return fallbackMemoryAudioStore;
}

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

/**
 * Computes a deterministic FNV-1a pack identifier from the briefing spoken script,
 * edition, lead story URLs, and target language.
 */
export function computeBriefingPackId(briefing: DailyBriefingData, language = "en-NZ"): string {
  const payload = JSON.stringify([
    briefing.edition,
    briefing.formattedDate,
    language,
    briefing.spokenScript,
    briefing.leadStories.map((s) => s.url),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `briefing-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function formatAudioByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function loadAutoOfflineBriefingPref(storage?: Storage): boolean {
  try {
    const store = getSafeStorage(storage);
    if (!store) return false;
    return store.getItem(OFFLINE_BRIEFING_AUTO_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveAutoOfflineBriefingPref(enabled: boolean, storage?: Storage): boolean {
  try {
    const store = getSafeStorage(storage);
    store?.setItem(OFFLINE_BRIEFING_AUTO_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore quota errors
  }
  return enabled;
}

export function loadOfflineBriefingPackMeta(storage?: Storage): OfflineBriefingPackMeta | null {
  try {
    const store = getSafeStorage(storage);
    if (!store) return null;
    const raw = store.getItem(OFFLINE_BRIEFING_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OfflineBriefingPackMeta;
    if (!parsed || typeof parsed.id !== "string" || !parsed.briefing?.spokenScript) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function loadOfflineBriefingAudio(
  expectedPackId?: string,
  audioStore?: BriefingAudioCacheStore,
): Promise<Blob | null> {
  return resolveAudioStore(audioStore).get(expectedPackId);
}

export async function clearOfflineBriefingPack(
  storage?: Storage,
  audioStore?: BriefingAudioCacheStore,
): Promise<void> {
  try {
    const store = getSafeStorage(storage);
    store?.removeItem(OFFLINE_BRIEFING_META_KEY);
  } catch {
    // Ignore
  }
  await resolveAudioStore(audioStore).clear();
}

export type SaveOfflineBriefingOptions = {
  briefing: DailyBriefingData;
  language?: string;
  voices?: ReadingVoicePreferences;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  storage?: Storage;
  audioStore?: BriefingAudioCacheStore;
  prepareAudio?: (
    titles: string[],
    seconds: number,
    language: string,
    signal: AbortSignal,
    fetcher: typeof fetch,
    onProgress?: (prepared: number, total: number) => void,
    maximumBatchCharacters?: number,
    voices?: ReadingVoicePreferences,
  ) => Promise<PreparedHeadlineAudio>;
  prewarmStory?: (
    article: { url: string; title: string; imageUrl?: string },
    fetcher?: typeof fetch,
    storage?: Storage,
  ) => Promise<PrewarmResult>;
  onProgress?: (percent: number, stage: string) => void;
};

/**
 * Builds and saves a complete Offline Briefing Pack:
 * 1. Synthesizes neural spoken briefing WAV chunks and stores the recording in Cache Storage.
 * 2. Prewarms full reader text & AI takeaways of all lead stories for offline reading.
 * 3. Saves the DailyBriefingData snapshot metadata so Signal can present & play it offline.
 */
export async function saveOfflineBriefingPack(
  options: SaveOfflineBriefingOptions,
): Promise<OfflineBriefingPackMeta> {
  const {
    briefing,
    signal,
    fetcher = fetch,
    storage,
    audioStore,
    prepareAudio = prepareHeadlineAudio,
    prewarmStory = prewarmBookmarkedArticle,
    onProgress,
  } = options;

  const abortController = new AbortController();
  const activeSignal = signal ?? abortController.signal;
  activeSignal.throwIfAborted();

  const resolvedLanguage =
    options.language ||
    (typeof navigator !== "undefined" && navigator.language.startsWith("en")
      ? navigator.language
      : "en-NZ");

  let resolvedVoices = options.voices;
  if (!resolvedVoices) {
    try {
      const store = getSafeStorage(storage);
      resolvedVoices = normalizeReadingVoices(
        JSON.parse(store?.getItem(READING_VOICES_STORAGE_KEY) ?? "null"),
      );
    } catch {
      resolvedVoices = normalizeReadingVoices(null);
    }
  }

  const packId = computeBriefingPackId(briefing, resolvedLanguage);
  const store = resolveAudioStore(audioStore);

  onProgress?.(5, "Preparing neural audio briefing...");

  let hasNeuralAudio = false;
  let audioBytes = 0;
  let audioWarning: string | undefined;

  const narrationParts = articleNarrationParts("", [briefing.spokenScript], 900);
  if (narrationParts.length > 0) {
    try {
      const prepared = await prepareAudio(
        narrationParts,
        3,
        resolvedLanguage,
        activeSignal,
        fetcher,
        (done, total) => {
          const pct = 5 + Math.round((done / Math.max(1, total)) * 65);
          onProgress?.(pct, "Downloading neural audio pack...");
        },
        4_000,
        resolvedVoices,
      );
      activeSignal.throwIfAborted();
      await store.put(packId, prepared.blob);
      hasNeuralAudio = true;
      audioBytes = prepared.blob.size;
    } catch (err) {
      activeSignal.throwIfAborted();
      audioWarning =
        err instanceof Error ? err.message : "Neural audio unavailable; text pack saved for device voice.";
    }
  }

  activeSignal.throwIfAborted();

  // Prewarm lead stories for offline full-text reading
  const stories = briefing.leadStories;
  let prewarmedStoryCount = 0;
  for (let i = 0; i < stories.length; i++) {
    activeSignal.throwIfAborted();
    const story = stories[i];
    const pct = 72 + Math.round(((i + 1) / Math.max(1, stories.length)) * 25);
    onProgress?.(pct, `Saving story ${i + 1} of ${stories.length} for offline reading...`);

    const alreadyCached = getCachedOfflineArticle(story.url, storage);
    if (alreadyCached && alreadyCached.paragraphs.length > 0) {
      prewarmedStoryCount += 1;
      continue;
    }
    try {
      const res = await prewarmStory({ url: story.url, title: story.title }, fetcher, storage);
      if (res.success) {
        prewarmedStoryCount += 1;
      }
    } catch {
      // Continue saving remaining stories
    }
  }

  const meta: OfflineBriefingPackMeta = {
    id: packId,
    savedAt: new Date().toISOString(),
    briefing,
    hasNeuralAudio,
    audioBytes,
    prewarmedStoryCount,
    language: resolvedLanguage,
    ...(audioWarning ? { audioWarning } : {}),
  };

  try {
    const metaStore = getSafeStorage(storage);
    metaStore?.setItem(OFFLINE_BRIEFING_META_KEY, JSON.stringify(meta));
  } catch {
    // Ignore storage quota errors
  }

  if (typeof navigator !== "undefined") {
    void navigator.storage?.persist?.().catch(() => false);
  }

  onProgress?.(100, "Offline briefing pack ready");
  return meta;
}
