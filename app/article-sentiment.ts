export type SentimentKind = "positive" | "neutral" | "negative" | "mixed";

export type ArticleSentimentResponse = {
  available: boolean;
  reason?: string;
  sentiment: SentimentKind;
  positiveScore: number;
  neutralScore: number;
  negativeScore: number;
};

export type ResolvedArticleSentiment = ArticleSentimentResponse & {
  source: "azure" | "heuristic";
};

export const SENTIMENT_STORAGE_KEY = "signal:article-sentiment-cache";
const MAX_STORED_SENTIMENTS = 400;

type CompactStoredSentiment = [SentimentKind, number, number, number];

const sentimentCache = new Map<string, ArticleSentimentResponse>();
const urlSentimentCache = new Map<string, ArticleSentimentResponse>();

const POSITIVE_NEWS_TERMS = new Set([
  "agreement", "approved", "approves", "award", "awarded", "boost", "boosts",
  "breakthrough", "celebrate", "celebrates", "cure", "deal", "expand", "expands",
  "expansion", "gain", "gains", "grows", "growth", "historic", "improve", "improved",
  "improves", "innovation", "launch", "launches", "milestone", "optimism", "optimistic",
  "outperform", "outperforms", "partnership", "peace", "praise", "praised", "profit",
  "profitable", "profits", "rallies", "rally", "rebound", "rebounds", "record",
  "recover", "recovered", "recovers", "recovery", "relief", "rescue", "rescued",
  "rise", "rises", "rising", "soar", "soaring", "soars", "strong", "succeed",
  "succeeded", "success", "successful", "surge", "surges", "surging", "thriving",
  "triumph", "upgrade", "upgraded", "upgrades", "victory", "win", "winning", "wins",
]);

const NEGATIVE_NEWS_TERMS = new Set([
  "accident", "allegation", "allegations", "arrest", "arrested", "attack", "attacked",
  "attacks", "backlash", "ban", "banned", "bans", "bankrupt", "bankruptcy", "breach",
  "cancel", "canceled", "cancelled", "casualties", "collapse", "collapsed", "collapses",
  "concern", "concerns", "conflict", "corruption", "crash", "crashed", "crashes",
  "crisis", "criticize", "criticized", "criticism", "cut", "cuts", "damage", "damaged",
  "danger", "dead", "deadly", "death", "deaths", "decline", "declines", "declining",
  "deficit", "delay", "delayed", "delays", "disaster", "downgrade", "downgraded",
  "drop", "dropped", "drops", "emergency", "fail", "failed", "failing", "fails",
  "failure", "fear", "fears", "fine", "fined", "fraud", "guilty", "hack", "hacked",
  "hazard", "inflation", "injured", "injury", "investigation", "killed", "lawsuit",
  "layoff", "layoffs", "loss", "losses", "outage", "outages", "penalty", "plunge",
  "plunged", "plunges", "probe", "protest", "protests", "recall", "recalled",
  "recession", "risk", "risks", "scandal", "shortage", "shortages", "slump", "slumps",
  "strike", "strikes", "sued", "threat", "threaten", "threatens", "tragedy", "turmoil",
  "victim", "victims", "violation", "violence", "violent", "warn", "warning", "warnings",
  "warns", "weak", "worsen", "worsens", "worst",
]);

const NEGATION_TOKENS = new Set(["no", "not", "never", "without", "neither", "nor"]);

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

export function normalizeSentimentUrl(url: string): string {
  return (url || "").trim().toLowerCase();
}

function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

type StoredSentimentMap = Record<string, CompactStoredSentiment | undefined>;
const storedSentimentMapCache = new WeakMap<Storage, { raw: string; map: StoredSentimentMap }>();

function readStoredSentimentMap(store: Storage): StoredSentimentMap | null {
  const raw = store.getItem(SENTIMENT_STORAGE_KEY);
  if (!raw) {
    storedSentimentMapCache.delete(store);
    return null;
  }
  const cached = storedSentimentMapCache.get(store);
  if (cached && cached.raw === raw) {
    return cached.map;
  }
  const map = JSON.parse(raw) as StoredSentimentMap;
  storedSentimentMapCache.set(store, { raw, map });
  return map;
}

export function recordArticleSentiment(
  url: string,
  data: ArticleSentimentResponse,
  storage?: Storage,
): void {
  const key = normalizeSentimentUrl(url);
  if (!key || !data.available) return;

  urlSentimentCache.set(key, data);

  try {
    const store = getSafeStorage(storage);
    if (!store) return;

    const existing = readStoredSentimentMap(store);
    const parsed: Record<string, CompactStoredSentiment> = existing ? { ...(existing as Record<string, CompactStoredSentiment>) } : {};
    delete parsed[key];
    parsed[key] = [
      data.sentiment,
      roundScore(data.positiveScore),
      roundScore(data.neutralScore),
      roundScore(data.negativeScore),
    ];

    const keys = Object.keys(parsed);
    if (keys.length > MAX_STORED_SENTIMENTS) {
      const excess = keys.length - MAX_STORED_SENTIMENTS;
      for (let i = 0; i < excess; i++) {
        delete parsed[keys[i]];
      }
    }

    const serialized = JSON.stringify(parsed);
    store.setItem(SENTIMENT_STORAGE_KEY, serialized);
    storedSentimentMapCache.set(store, { raw: serialized, map: parsed });
  } catch {
    // Ignore storage quota errors
  }
}

export function getCachedArticleSentiment(
  url: string,
  storage?: Storage,
): ArticleSentimentResponse | null {
  const key = normalizeSentimentUrl(url);
  if (!key) return null;

  const mem = urlSentimentCache.get(key);
  if (mem) return mem;

  try {
    const store = getSafeStorage(storage);
    if (!store) return null;
    const parsed = readStoredSentimentMap(store);
    if (!parsed) return null;
    const entry = parsed[key];
    if (!Array.isArray(entry) || entry.length < 4) return null;

    const hydrated: ArticleSentimentResponse = {
      available: true,
      sentiment: entry[0],
      positiveScore: roundScore(entry[1]),
      neutralScore: roundScore(entry[2]),
      negativeScore: roundScore(entry[3]),
    };
    urlSentimentCache.set(key, hydrated);
    return hydrated;
  } catch {
    return null;
  }
}

export function clearSentimentCache(storage?: Storage): void {
  sentimentCache.clear();
  urlSentimentCache.clear();
  if (storage) {
    storedSentimentMapCache.delete(storage);
    try {
      storage.removeItem(SENTIMENT_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
}

function scoreSegmentTokens(text: string, weight: number): { pos: number; neg: number } {
  if (!text) return { pos: 0, neg: 0 };
  const tokens = text.toLowerCase().match(/[a-z]+/g);
  if (!tokens || tokens.length === 0) return { pos: 0, neg: 0 };

  let pos = 0;
  let neg = 0;

  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : "";
    const prev2 = i > 1 ? tokens[i - 2] : "";
    const negated = NEGATION_TOKENS.has(prev) || NEGATION_TOKENS.has(prev2);

    if (POSITIVE_NEWS_TERMS.has(word)) {
      if (negated) neg += weight * 0.75;
      else pos += weight;
    } else if (NEGATIVE_NEWS_TERMS.has(word)) {
      if (negated) pos += weight * 0.5;
      else neg += weight;
    }
  }

  return { pos, neg };
}

/**
 * Fast, deterministic client-side tone classifier for news headlines and summaries.
 * Used as a zero-API fallback when an article has not yet been analyzed by Azure AI Language.
 */
export function classifyHeadlineSentiment(
  title?: string,
  summary?: string,
): ArticleSentimentResponse {
  const titleScores = scoreSegmentTokens(title || "", 2.0);
  const summaryScores = scoreSegmentTokens(summary || "", 1.0);

  const pos = titleScores.pos + summaryScores.pos;
  const neg = titleScores.neg + summaryScores.neg;

  if (pos === 0 && neg === 0) {
    return {
      available: true,
      sentiment: "neutral",
      positiveScore: 0.1,
      neutralScore: 0.8,
      negativeScore: 0.1,
    };
  }

  const totalSignal = pos + neg + 1.5; // +1.5 prior stabilizes single-word cues
  const positiveScore = roundScore(pos / totalSignal);
  const negativeScore = roundScore(neg / totalSignal);
  const neutralScore = roundScore(Math.max(0, 1 - positiveScore - negativeScore));

  let sentiment: SentimentKind = "neutral";
  if (pos >= 1.5 && neg >= 1.5 && pos <= neg * 2.2 && neg <= pos * 2.2) {
    sentiment = "mixed";
  } else if (pos > neg && pos >= 1.5) {
    sentiment = "positive";
  } else if (neg > pos && neg >= 1.5) {
    sentiment = "negative";
  }

  return {
    available: true,
    sentiment,
    positiveScore,
    neutralScore,
    negativeScore,
  };
}

/**
 * Resolves article sentiment with zero external API calls:
 * prefers cached Azure AI Language sentiment and falls back to local headline/summary analysis.
 */
export function resolveArticleSentiment(
  article: { url?: string; title?: string; summary?: string },
  storage?: Storage,
): ResolvedArticleSentiment {
  if (article.url) {
    const cached = getCachedArticleSentiment(article.url, storage);
    if (cached && cached.available) {
      return { ...cached, source: "azure" };
    }
  }
  return {
    ...classifyHeadlineSentiment(article.title, article.summary),
    source: "heuristic",
  };
}

export async function loadArticleSentiment(
  url: string,
  title?: string,
  paragraphs?: string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  storage?: Storage,
): Promise<ArticleSentimentResponse> {
  const cacheKey = `${url}::${(title || "").slice(0, 50)}`;
  const cached = sentimentCache.get(cacheKey) ?? getCachedArticleSentiment(url, storage);
  if (cached) return cached;

  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!csrf.ok) throw new Error("Could not start a secure article request.");
    const { token } = await csrf.json() as { token?: string };
    if (!token) throw new Error("Could not start a secure article request.");
    signal?.throwIfAborted();
    const response = await fetcher("/api/article-sentiment", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
      body: JSON.stringify({
        url,
        title: title || undefined,
        paragraphs: paragraphs && paragraphs.length > 0 ? paragraphs.slice(0, 4) : undefined,
      }),
      signal,
    });

    if (!response.ok) {
      return {
        available: false,
        reason: `Server returned status ${response.status}`,
        sentiment: "neutral",
        positiveScore: 0,
        neutralScore: 0,
        negativeScore: 0,
      };
    }

    const data = (await response.json()) as ArticleSentimentResponse;
    if (data.available) {
      sentimentCache.set(cacheKey, data);
      recordArticleSentiment(url, data, storage);
    }
    return data;
  } catch {
    return {
      available: false,
      reason: "Sentiment analysis failed",
      sentiment: "neutral",
      positiveScore: 0,
      neutralScore: 0,
      negativeScore: 0,
    };
  }
}

export function getSentimentIcon(sentiment: string): string {
  switch (sentiment.toLowerCase()) {
    case "positive":
      return "😊";
    case "negative":
      return "😟";
    case "mixed":
      return "⚖️";
    case "neutral":
    default:
      return "😐";
  }
}
