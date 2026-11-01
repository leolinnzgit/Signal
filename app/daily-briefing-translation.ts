import { translateTextSnippets, translationLanguages } from "./article-translation.ts";
import type { DailyBriefingData } from "./daily-briefing.ts";

export const DAILY_BRIEFING_LANGUAGE_KEY = "signal:daily-briefing-language:v1";

const SUPPORTED_LANGUAGE_SET = new Set<string>(
  translationLanguages.map(([code]) => code),
);

const SPEECH_LOCALE_BY_LANGUAGE: Record<string, string> = {
  en: "en-NZ",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  ja: "ja-JP",
  ko: "ko-KR",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  it: "it-IT",
  pt: "pt-BR",
  ar: "ar-SA",
  hi: "hi-IN",
};

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

export function normalizeBriefingLanguage(value: unknown): string {
  if (typeof value !== "string") return "en";
  const trimmed = value.trim();
  if (SUPPORTED_LANGUAGE_SET.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower === "zh-cn" || lower === "zh-sg" || lower === "zh") return "zh-Hans";
  if (lower === "zh-tw" || lower === "zh-hk") return "zh-Hant";
  for (const [code] of translationLanguages) {
    if (code.toLowerCase() === lower || lower.startsWith(`${code.toLowerCase()}-`)) {
      return code;
    }
  }
  return "en";
}

export function loadBriefingLanguage(storage?: Storage): string {
  try {
    const store = getSafeStorage(storage);
    if (!store) return "en";
    return normalizeBriefingLanguage(store.getItem(DAILY_BRIEFING_LANGUAGE_KEY));
  } catch {
    return "en";
  }
}

export function saveBriefingLanguage(language: string, storage?: Storage): string {
  const normalized = normalizeBriefingLanguage(language);
  try {
    const store = getSafeStorage(storage);
    store?.setItem(DAILY_BRIEFING_LANGUAGE_KEY, normalized);
  } catch {
    // Ignore storage quota errors
  }
  return normalized;
}

/**
 * Resolves the BCP-47 speech locale for both Azure Neural TTS streaming/recordings
 * and browser SpeechSynthesis fallback.
 */
export function briefingSpeechLocale(language: string): string {
  const normalized = normalizeBriefingLanguage(language);
  if (normalized === "en") {
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en")) {
      return navigator.language;
    }
    return "en-NZ";
  }
  return SPEECH_LOCALE_BY_LANGUAGE[normalized] || normalized;
}

export function getBriefingLanguageLabel(language: string): string {
  const normalized = normalizeBriefingLanguage(language);
  const entry = translationLanguages.find(([code]) => code === normalized);
  return entry ? entry[1] : "English";
}

function splitScriptIntoChunks(script: string, maxChunkLength = 1500): string[] {
  const cleaned = (script || "").trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChunkLength) return [cleaned];

  const sentences = cleaned.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [cleaned];
  const chunks: string[] = [];
  let current = "";

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= maxChunkLength) {
      current += ` ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function translateBatchedSnippets(
  texts: string[],
  language: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ available: boolean; translations: string[] }> {
  if (texts.length === 0) return { available: true, translations: [] };

  const MAX_BATCH_CHARS = 5000;
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentChars = 0;

  for (const item of texts) {
    if (currentBatch.length > 0 && currentChars + item.length > MAX_BATCH_CHARS) {
      batches.push(currentBatch);
      currentBatch = [item];
      currentChars = item.length;
    } else {
      currentBatch.push(item);
      currentChars += item.length;
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const output: string[] = [];
  let allAvailable = true;

  for (const batch of batches) {
    const res = await translateTextSnippets(batch, language, signal, fetcher);
    if (!res.available) {
      allAvailable = false;
    }
    output.push(...(res.translations.length === batch.length ? res.translations : batch));
  }

  return { available: allAvailable, translations: output };
}

const briefingTranslationCache = new Map<string, DailyBriefingData>();

export function clearBriefingTranslationCache(): void {
  briefingTranslationCache.clear();
}

/**
 * Translates an Executive Daily Briefing (greeting, date, weather/pulse descriptors,
 * lead headlines & summaries, and the spoken anchor narration script) into any of
 * Signal's 12 supported translation languages using Azure Translator.
 */
export async function translateDailyBriefing(
  briefing: DailyBriefingData,
  language: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ briefing: DailyBriefingData; translated: boolean; language: string }> {
  const normalizedLang = normalizeBriefingLanguage(language);
  if (normalizedLang === "en") {
    return { briefing, translated: true, language: "en" };
  }

  const cacheKey = `${normalizedLang}::${briefing.greeting}::${briefing.formattedDate}::${briefing.spokenScript}`;
  const cached = briefingTranslationCache.get(cacheKey);
  if (cached) {
    return { briefing: cached, translated: true, language: normalizedLang };
  }

  const textsToTranslate: string[] = [];
  const pushSlot = (val?: string): number => {
    const clean = (val || "").trim();
    if (!clean) return -1;
    textsToTranslate.push(clean);
    return textsToTranslate.length - 1;
  };

  const greetingSlot = pushSlot(briefing.greeting);
  const dateSlot = pushSlot(briefing.formattedDate);
  const weatherConditionSlot = pushSlot(briefing.weatherGlance?.condition);
  const weatherAlertSlot = pushSlot(briefing.weatherGlance?.topAlertHeadline);
  const pulseToneSlot = pushSlot(briefing.pulseGlance?.sentimentToneLabel);

  const storySlots = briefing.leadStories.map((story) => ({
    titleSlot: pushSlot(story.title),
    summarySlot: pushSlot(story.summary),
  }));

  const chapterList = Array.isArray(briefing.chapters) ? briefing.chapters : [];
  const chapterSlots = chapterList.map((chapter) => ({
    labelSlot: pushSlot(chapter.label),
    textSlot: pushSlot(chapter.text),
  }));

  const scriptChunks =
    chapterList.length === 0 ? splitScriptIntoChunks(briefing.spokenScript, 1500) : [];
  const scriptSlots = scriptChunks.map((chunk) => pushSlot(chunk));

  const { available, translations } = await translateBatchedSnippets(
    textsToTranslate,
    normalizedLang,
    signal,
    fetcher,
  );

  if (!available || translations.length !== textsToTranslate.length) {
    return { briefing, translated: false, language: normalizedLang };
  }

  const pick = (slot: number, fallback: string): string =>
    slot >= 0 && translations[slot] ? translations[slot] : fallback;

  const translatedChapters = chapterList.map((chapter, idx) => ({
    ...chapter,
    label: pick(chapterSlots[idx].labelSlot, chapter.label),
    text: pick(chapterSlots[idx].textSlot, chapter.text),
  }));

  const translatedBriefing: DailyBriefingData = {
    ...briefing,
    greeting: pick(greetingSlot, briefing.greeting),
    formattedDate: pick(dateSlot, briefing.formattedDate),
    weatherGlance: briefing.weatherGlance
      ? {
          ...briefing.weatherGlance,
          condition: pick(weatherConditionSlot, briefing.weatherGlance.condition),
          topAlertHeadline: briefing.weatherGlance.topAlertHeadline
            ? pick(weatherAlertSlot, briefing.weatherGlance.topAlertHeadline)
            : undefined,
        }
      : undefined,
    pulseGlance: briefing.pulseGlance
      ? {
          ...briefing.pulseGlance,
          sentimentToneLabel: pick(pulseToneSlot, briefing.pulseGlance.sentimentToneLabel),
        }
      : undefined,
    leadStories: briefing.leadStories.map((story, idx) => ({
      ...story,
      title: pick(storySlots[idx].titleSlot, story.title),
      summary: story.summary ? pick(storySlots[idx].summarySlot, story.summary) : story.summary,
    })),
    chapters: translatedChapters,
    spokenScript:
      translatedChapters.length > 0
        ? translatedChapters.map((ch) => ch.text).join(" ")
        : scriptSlots.length > 0
          ? scriptSlots.map((slot, idx) => pick(slot, scriptChunks[idx])).join(" ")
          : briefing.spokenScript,
  };

  if (briefingTranslationCache.size >= 24) {
    const oldest = briefingTranslationCache.keys().next().value;
    if (oldest) briefingTranslationCache.delete(oldest);
  }
  briefingTranslationCache.set(cacheKey, translatedBriefing);

  return { briefing: translatedBriefing, translated: true, language: normalizedLang };
}
