import { useEffect, useRef, useState } from "react";
import type { MarketQuote } from "./market-quote";

const REFRESH_MS = 5 * 60 * 1_000;

export function useBriefingMarketQuote(
  topics: string[],
  preferredTopic: string | undefined,
  tickerOverrides: Record<string, string>,
) {
  const candidates = Array.from(new Set([preferredTopic, ...topics]
    .filter((topic): topic is string => Boolean(topic?.trim()))
    .map((topic) => topic.trim().toLowerCase())));
  const requests = candidates.map((topic) => {
    const params = new URLSearchParams({ topic });
    const symbol = Object.entries(tickerOverrides)
      .find(([name]) => name.toLowerCase() === topic)?.[1];
    if (symbol) params.set("symbol", symbol);
    return params.toString();
  });
  const key = JSON.stringify(requests);
  const cache = useRef(new Map<string, { quote: MarketQuote | null; expires: number }>());
  const [result, setResult] = useState<{ key: string; quote: MarketQuote | null } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    const queries = JSON.parse(key) as string[];
    async function load() {
      for (const query of queries) {
        if (abort.signal.aborted) return;
        const cached = cache.current.get(query);
        let quote = cached && cached.expires > Date.now() ? cached.quote : undefined;
        if (quote === undefined) {
          try {
            const response = await fetch(`/api/market?${query}`, {
              credentials: "same-origin", cache: "no-store", signal: abort.signal,
            });
            if (!response.ok) continue;
            const data = await response.json() as { matched: boolean; quote?: MarketQuote };
            quote = data.matched && data.quote && Number.isFinite(data.quote.price) ? data.quote : null;
            if (abort.signal.aborted) return;
            cache.current.set(query, { quote, expires: Date.now() + REFRESH_MS });
          } catch {
            if (abort.signal.aborted) return;
            continue;
          }
        }
        if (quote) {
          setResult({ key, quote });
          return;
        }
      }
      if (!abort.signal.aborted) setResult({ key, quote: null });
    }
    void load();
    const refresh = window.setInterval(() => void load(), REFRESH_MS);
    return () => { abort.abort(); window.clearInterval(refresh); };
  }, [key]);

  // A new headline must never display the previous company's quote while loading.
  return result?.key === key ? result.quote : null;
}
