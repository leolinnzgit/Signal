export type WordLookupMode = "english" | "chinese";

export type WordLookupMeaning = {
  partOfSpeech: string;
  definitions: string[];
  example?: string | null;
  synonyms?: string[] | null;
};

export type WordLookupChineseSense = {
  partOfSpeech: string;
  translation: string;
  backTranslations: string[];
};

export type WordLookupResponse = {
  available: boolean;
  reason: string;
  word: string;
  mode: WordLookupMode;
  phonetic?: string | null;
  meanings: WordLookupMeaning[];
  contextNote?: string | null;
  chineseSimplified?: string | null;
  chineseTraditional?: string | null;
  pinyin?: string | null;
  chineseSenses: WordLookupChineseSense[];
  source: string;
};

export type PopoverRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type PopoverPosition = {
  left: number;
  top: number;
  placement: "above" | "below";
};

const EDGE_TRIM_REGEX =
  /^["'“”‘’()[\]{},.;:!?—–…«»《》「」『』。，、]+|["'“”‘’()[\]{},.;:!?—–…«»《》「」『』。，、]+$/g;
const HAS_LETTER_REGEX = /[\p{L}]/u;
const MAX_CACHE_ENTRIES = 100;

const lookupCache = new Map<string, WordLookupResponse>();

export function clearWordLookupCache(): void {
  lookupCache.clear();
}

/**
 * Extracts and validates a highlighted word or short phrase (1 to 6 words, up to 80 chars).
 * Returns null for multi-line selections, empty strings, punctuation-only, or pure numbers.
 */
export function extractLookupSelection(rawText: string): string | null {
  if (typeof rawText !== "string") return null;
  if (/[\r\n]/.test(rawText)) return null;

  const collapsed = rawText.trim().replace(/\s+/g, " ");
  const cleaned = collapsed.replace(EDGE_TRIM_REGEX, "").trim();
  if (!cleaned || cleaned.length > 80) return null;
  if (!HAS_LETTER_REGEX.test(cleaned)) return null;

  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) return null;

  return cleaned;
}

/**
 * Extracts a concise sentence or word-boundary snippet around the highlighted word for context.
 */
export function extractSelectionContext(
  blockText: string,
  selectedWord: string,
  maxLength = 240,
): string {
  const normalized = (blockText || "").replace(/\s+/g, " ").trim();
  if (!normalized || maxLength <= 0) return "";

  const needle = (selectedWord || "").trim().toLowerCase();
  const idx = needle ? normalized.toLowerCase().indexOf(needle) : -1;
  if (idx < 0) {
    return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trimEnd();
  }

  // Try to isolate the enclosing sentence when possible.
  let sentenceStart = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = normalized[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "！" || ch === "？") {
      sentenceStart = i + 1;
      break;
    }
  }
  let sentenceEnd = normalized.length;
  for (let i = idx + needle.length; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "！" || ch === "？") {
      sentenceEnd = i + 1;
      break;
    }
  }

  const sentence = normalized.slice(sentenceStart, sentenceEnd).trim();
  if (sentence.length > 0 && sentence.length <= maxLength) {
    return sentence;
  }
  if (normalized.length <= maxLength) return normalized;

  const center = idx + Math.floor(needle.length / 2);
  let start = Math.max(0, center - Math.floor(maxLength / 2));
  let end = Math.min(normalized.length, start + maxLength);
  if (end - start < maxLength) {
    start = Math.max(0, end - maxLength);
  }

  if (start > 0) {
    const nextSpace = normalized.indexOf(" ", start);
    if (nextSpace > start && nextSpace < idx) {
      start = nextSpace + 1;
    }
  }
  if (end < normalized.length) {
    const prevSpace = normalized.lastIndexOf(" ", end);
    if (prevSpace > idx + needle.length) {
      end = prevSpace;
    }
  }

  return normalized.slice(start, end).trim();
}

/**
 * Computes fixed-viewport coordinates for a floating popover anchored to a selection rect,
 * preferring placement above the selection and flipping below when near the top edge.
 */
export function computePopoverPosition(
  rect: PopoverRect,
  viewport: { width: number; height: number },
  popoverSize: { width: number; height: number },
): PopoverPosition {
  const margin = 12;
  const gap = 10;

  const centerX = (rect.left + rect.right) / 2;
  const maxLeft = Math.max(margin, viewport.width - popoverSize.width - margin);
  const left = Math.round(Math.min(maxLeft, Math.max(margin, centerX - popoverSize.width / 2)));

  const aboveTop = rect.top - popoverSize.height - gap;
  const belowTop = rect.bottom + gap;
  const maxTop = Math.max(margin, viewport.height - popoverSize.height - margin);

  if (aboveTop >= margin) {
    return {
      left,
      top: Math.round(Math.min(maxTop, aboveTop)),
      placement: "above",
    };
  }

  return {
    left,
    top: Math.round(Math.min(maxTop, Math.max(margin, belowTop))),
    placement: "below",
  };
}

function buildCacheKey(word: string, mode: WordLookupMode, context?: string): string {
  const ctxKey = (context ?? "").trim().slice(0, 80);
  return `${mode}::${word.toLowerCase()}::${ctxKey}`;
}

export async function fetchWordLookup(
  word: string,
  mode: WordLookupMode,
  context: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<WordLookupResponse> {
  const key = buildCacheKey(word, mode, context);
  const cached = lookupCache.get(key);
  if (cached) {
    return cached;
  }

  const csrf = await fetcher("/api/auth/csrf", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!csrf.ok) {
    throw new Error("Sign in again to look up words.");
  }
  const { token } = (await csrf.json()) as { token?: string };
  if (!token) {
    throw new Error("Sign in again to look up words.");
  }

  const response = await fetcher("/api/word-lookup", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": token,
    },
    body: JSON.stringify({
      word,
      mode,
      context: context?.trim() || undefined,
    }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Sign in again to look up words."
        : response.status === 429
          ? "Too many lookup requests. Please try again shortly."
          : "Word lookup could not be completed. Please try again.",
    );
  }

  const data = (await response.json()) as WordLookupResponse;
  if (
    typeof data.available !== "boolean" ||
    typeof data.reason !== "string" ||
    typeof data.word !== "string"
  ) {
    throw new Error("The word lookup response was incomplete. Please try again.");
  }

  if (data.available) {
    if (lookupCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = lookupCache.keys().next().value;
      if (oldest) lookupCache.delete(oldest);
    }
    lookupCache.set(key, data);
  }

  return data;
}
