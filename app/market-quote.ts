import { topicMatchesText } from "./api/news/topic-matching.ts";

export type ExtendedMarketQuoteFields = {
  extendedPrice?: number | null;
  extendedChange?: number | null;
  extendedPercentChange?: number | null;
  extendedQuoteTime?: string | null;
  extendedSession?: "after-hours" | "pre-market" | string | null;
};

export type MarketQuote = ExtendedMarketQuoteFields & {
  topic: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: number;
  change: number;
  percentChange: number;
  quoteTime: string;
  isMarketOpen: boolean | null;
  provider: string;
  sparkline?: number[];
};

export function hasExtendedMarketQuote<T extends ExtendedMarketQuoteFields>(
  quote: T | null | undefined,
): quote is T & { extendedPrice: number } {
  return Boolean(
    quote &&
      typeof quote.extendedPrice === "number" &&
      Number.isFinite(quote.extendedPrice) &&
      quote.extendedPrice > 0,
  );
}

export function getExtendedMarketSessionLabel(
  session?: string | null,
  style: "short" | "full" = "short",
): string {
  if (session && session.trim().toLowerCase() === "pre-market") {
    return "Pre-market";
  }
  return style === "full" ? "After hours · Post-market" : "After hours";
}

export type SparklineGeometry = {
  linePath: string;
  areaPath: string;
  min: number;
  max: number;
  first: number;
  last: number;
  isUp: boolean;
};

export type MarketStoryCatalyst<T> = {
  symbol: string;
  story: T;
  score: number;
};

export type MarketWatchlistResult = {
  configured: boolean;
  quotes: MarketQuote[];
};

export interface MarketPortfolioItem {
  symbol: string;
  displayName: string;
  alertThresholdPercent: number;
  alertEnabled: boolean;
}

export interface MarketPortfolioQuoteItem {
  symbol: string;
  displayName: string;
  alertThresholdPercent: number;
  alertEnabled: boolean;
  isAlertTriggered: boolean;
  alertDirection: "up" | "down" | null;
  quote?: MarketQuote | null;
}

export interface MarketPortfolioResponse {
  configured: boolean;
  items: MarketPortfolioQuoteItem[];
  hasAlerts: boolean;
}

export function formatMarketPrice(price: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? "currency" : "decimal",
      currency: currency || undefined,
      maximumFractionDigits: 2,
    }).format(price);
  } catch {
    return `${currency ? `${currency} ` : ""}${price.toFixed(2)}`;
  }
}

/**
 * Deduplicates market quotes by symbol + exchange and orders them by largest
 * absolute percentage move descending so top movers surface first.
 */
export function sortWatchlistByMagnitude(quotes: readonly MarketQuote[]): MarketQuote[] {
  if (!Array.isArray(quotes) || quotes.length === 0) return [];
  const seen = new Set<string>();
  const unique: MarketQuote[] = [];

  for (const quote of quotes) {
    if (!quote || typeof quote.symbol !== "string" || !quote.symbol.trim()) continue;
    if (!Number.isFinite(quote.price) || !Number.isFinite(quote.percentChange)) continue;
    const key = `${quote.symbol.trim().toUpperCase()}:${(quote.exchange || "").trim().toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(quote);
  }

  return unique.sort((a, b) => {
    const diff = Math.abs(b.percentChange) - Math.abs(a.percentChange);
    if (Math.abs(diff) > 1e-9) return diff;
    return a.symbol.localeCompare(b.symbol);
  });
}

function findTickerOverride(topic: string, overrides: Record<string, string>): string | undefined {
  if (!overrides) return undefined;
  if (typeof overrides[topic] === "string" && overrides[topic].trim()) {
    return overrides[topic].trim();
  }
  const lower = topic.toLowerCase();
  for (const [key, val] of Object.entries(overrides)) {
    if (key.toLowerCase() === lower && typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

/**
 * Resolves live multi-ticker watchlist quotes across the user's followed topics
 * and custom ticker overrides via POST /api/market/watchlist.
 */
export async function loadMarketWatchlist(
  topics: readonly string[],
  tickerOverrides: Record<string, string> = {},
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  maxQuotes = 5,
): Promise<MarketWatchlistResult> {
  const seenTopics = new Set<string>();
  const items: Array<{ topic: string; symbol?: string }> = [];

  for (const rawTopic of topics || []) {
    if (typeof rawTopic !== "string") continue;
    const cleaned = rawTopic.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.length > 80) continue;
    const lower = cleaned.toLowerCase();
    if (seenTopics.has(lower)) continue;
    seenTopics.add(lower);
    const symbol = findTickerOverride(cleaned, tickerOverrides);
    items.push(symbol ? { topic: cleaned, symbol } : { topic: cleaned });
    if (items.length >= 24) break;
  }

  if (items.length === 0) {
    return { configured: true, quotes: [] };
  }

  try {
    const csrf = await fetcher("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!csrf.ok) return { configured: false, quotes: [] };
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) return { configured: false, quotes: [] };

    const boundedMax = Math.max(1, Math.min(8, Math.floor(maxQuotes)));
    const response = await fetcher("/api/market/watchlist", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": token,
      },
      body: JSON.stringify({ items, maxQuotes: boundedMax, includeSparklines: true }),
    });

    if (!response.ok) {
      return { configured: false, quotes: [] };
    }

    const payload = (await response.json()) as {
      configured?: boolean;
      quotes?: MarketQuote[];
    };

    return {
      configured: Boolean(payload?.configured),
      quotes: sortWatchlistByMagnitude(Array.isArray(payload?.quotes) ? payload.quotes : []).slice(
        0,
        boundedMax,
      ),
    };
  } catch {
    return { configured: false, quotes: [] };
  }
}

export async function loadMarketPortfolio(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<MarketPortfolioResponse> {
  try {
    const response = await fetcher("/api/market/portfolio", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) return { configured: false, items: [], hasAlerts: false };
    const data = (await response.json()) as MarketPortfolioResponse;
    return {
      configured: Boolean(data?.configured),
      items: Array.isArray(data?.items) ? data.items : [],
      hasAlerts: Boolean(data?.hasAlerts),
    };
  } catch {
    return { configured: false, items: [], hasAlerts: false };
  }
}

export async function saveMarketPortfolio(
  items: readonly MarketPortfolioItem[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<MarketPortfolioResponse> {
  try {
    const csrf = await fetcher("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!csrf.ok) return { configured: false, items: [], hasAlerts: false };
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) return { configured: false, items: [], hasAlerts: false };

    const response = await fetcher("/api/market/portfolio", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": token,
      },
      body: JSON.stringify(items),
    });
    if (!response.ok) return { configured: false, items: [], hasAlerts: false };
    const data = (await response.json()) as MarketPortfolioResponse;
    return {
      configured: Boolean(data?.configured),
      items: Array.isArray(data?.items) ? data.items : [],
      hasAlerts: Boolean(data?.hasAlerts),
    };
  } catch {
    return { configured: false, items: [], hasAlerts: false };
  }
}

export function evaluateMarketAlerts(
  items: readonly MarketPortfolioItem[],
  quotes: readonly MarketQuote[],
): MarketPortfolioQuoteItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const quoteMap = new Map<string, MarketQuote>();
  for (const q of quotes || []) {
    if (q?.symbol) quoteMap.set(q.symbol.toUpperCase(), q);
    if (q?.topic) quoteMap.set(q.topic.toUpperCase(), q);
  }

  return items.map((item) => {
    const quote =
      quoteMap.get(item.symbol.toUpperCase()) ||
      quoteMap.get((item.displayName || "").toUpperCase()) ||
      null;
    const isTriggered = Boolean(
      quote &&
        item.alertEnabled &&
        Math.abs(quote.percentChange) >= item.alertThresholdPercent,
    );
    return {
      symbol: item.symbol,
      displayName: item.displayName || item.symbol,
      alertThresholdPercent: item.alertThresholdPercent,
      alertEnabled: item.alertEnabled,
      isAlertTriggered: isTriggered,
      alertDirection: quote ? (quote.percentChange >= 0 ? "up" : "down") : null,
      quote,
    };
  });
}

export function buildSparklineGeometry(
  points: readonly number[] | undefined | null,
  width = 56,
  height = 18,
  padding = 2,
): SparklineGeometry | null {
  if (!Array.isArray(points)) return null;
  const valid = points.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (valid.length < 2) return null;

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const span = max - min;
  const innerW = Math.max(4, width - padding * 2);
  const innerH = Math.max(4, height - padding * 2);

  const coords = valid.map((val, idx) => {
    const x = padding + (idx / (valid.length - 1)) * innerW;
    const y = span < 1e-6 ? height / 2 : padding + (1 - (val - min) / span) * innerH;
    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    };
  });

  const linePath = coords
    .map((pt, idx) => `${idx === 0 ? "M" : "L"} ${pt.x} ${pt.y}`)
    .join(" ");
  const firstPt = coords[0];
  const lastPt = coords[coords.length - 1];
  const baseline = Math.round((height - 1) * 100) / 100;
  const areaPath = `${linePath} L ${lastPt.x} ${baseline} L ${firstPt.x} ${baseline} Z`;

  return {
    linePath,
    areaPath,
    min,
    max,
    first: valid[0],
    last: valid[valid.length - 1],
    isUp: valid[valid.length - 1] >= valid[0],
  };
}

function cleanCompanyLookupName(name: string): string {
  return name
    .replace(/\b(Inc|Corp|Corporation|Ltd|Limited|PLC|ETF|Group|Holdings|Co|Company|Class\s+[A-Z]|SPDR|Trust)\b\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Attributes notable watchlist movers (`|percentChange| >= minAbsPercent`) to the
 * strongest matching story in the user's feed so Signal can display "Why it's moving".
 */
export function attributeMarketMoversToStories<
  T extends {
    title: string;
    url: string;
    source: string;
    summary?: string;
    topics?: string[];
    matchedTopics?: string[];
  },
>(
  quotes: readonly MarketQuote[],
  articles: readonly T[],
  minAbsPercent = 1.0,
): Record<string, MarketStoryCatalyst<T>> {
  const result: Record<string, MarketStoryCatalyst<T>> = {};
  if (!Array.isArray(quotes) || !Array.isArray(articles) || quotes.length === 0 || articles.length === 0) {
    return result;
  }

  for (const quote of quotes) {
    if (!quote || typeof quote.symbol !== "string" || !quote.symbol.trim()) continue;
    if (!Number.isFinite(quote.percentChange) || Math.abs(quote.percentChange) < minAbsPercent) continue;

    const symUpper = quote.symbol.trim().toUpperCase();
    if (result[symUpper]) continue;

    const topic = (quote.topic || "").trim();
    const cleanName = cleanCompanyLookupName(quote.name || "");
    const candidateTerms = Array.from(
      new Set(
        [topic, cleanName, symUpper.length >= 3 ? symUpper : ""]
          .map((s) => s.trim())
          .filter((s) => s.length >= 2),
      ),
    );
    if (candidateTerms.length === 0) continue;

    let bestStory: T | null = null;
    let bestScore = 0;

    for (const article of articles) {
      if (!article || !article.title) continue;
      let score = 0;
      const tags = [
        ...(Array.isArray(article.matchedTopics) ? article.matchedTopics : []),
        ...(Array.isArray(article.topics) ? article.topics : []),
      ];
      const lowerTags = tags.map((t) => t.toLowerCase());

      if (topic && lowerTags.includes(topic.toLowerCase())) score += 5;
      if (lowerTags.includes(symUpper.toLowerCase())) score += 5;
      if (cleanName && lowerTags.includes(cleanName.toLowerCase())) score += 4;

      for (const term of candidateTerms) {
        if (topicMatchesText(article.title, term)) {
          score += term === symUpper ? 3 : 4;
        } else if (article.summary && topicMatchesText(article.summary, term)) {
          score += 2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestStory = article;
      }
    }

    if (bestStory && bestScore >= 3) {
      result[symUpper] = {
        symbol: symUpper,
        story: bestStory,
        score: bestScore,
      };
    }
  }

  return result;
}
