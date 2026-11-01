export type MarketQuote = {
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
};

export type MarketWatchlistResult = {
  configured: boolean;
  quotes: MarketQuote[];
};

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
      body: JSON.stringify({ items, maxQuotes: boundedMax }),
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
