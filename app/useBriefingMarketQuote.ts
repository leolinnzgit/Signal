import { useEffect, useRef, useState } from "react";
import type { MarketQuote } from "./market-quote";

const REFRESH_MS = 5 * 60 * 1_000;
const FAILURE_MS = 60 * 1_000;
const PLAN_REQUIRED_MS = 30 * 60 * 1_000;

export function useBriefingMarketQuote(
  topics: string[],
  preferredTopic: string | undefined,
  tickerOverrides: Record<string, string>,
) {
  const candidates = Array.from(new Set([preferredTopic, ...topics]
    .filter((topic): topic is string => Boolean(topic?.trim()))
    .map((topic) => topic.trim().toLowerCase())));
  const requests = candidates.map((topic) => {
    const params = new URLSearchParams({ topic, optional: "true" });
    const symbol = Object.entries(tickerOverrides)
      .find(([name]) => name.toLowerCase() === topic)?.[1];
    if (symbol) params.set("symbol", symbol);
    return params.toString();
  });
  const key = JSON.stringify(requests);
  const cache = useRef(new Map<string, { quote: MarketQuote | null; expires: number }>());
  const inFlight = useRef(new Map<string, { request: AbortController; promise: Promise<MarketQuote | null> }>());
  const [result, setResult] = useState<{ key: string; quote: MarketQuote | null } | null>(null);

  useEffect(() => () => {
    for (const pending of inFlight.current.values()) pending.request.abort();
    inFlight.current.clear();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const queries = JSON.parse(key) as string[];
    function requestQuote(query: string): Promise<MarketQuote | null> {
      const pending = inFlight.current.get(query);
      if (pending) return pending.promise;
      const request = new AbortController();
      const promise = (async () => {
        try {
          const response = await fetch(`/api/market?${query}`, {
            credentials: "same-origin", cache: "no-store",
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
          });
          if (!response.ok) {
            cache.current.set(query, { quote: null, expires: Date.now() + FAILURE_MS });
            return null;
          }
          const data = await response.json() as { matched: boolean; quote?: MarketQuote; status?: string };
          const quote = data.matched && data.quote && Number.isFinite(data.quote.price) ? data.quote : null;
          if (!request.signal.aborted)
            cache.current.set(query, { quote, expires: Date.now() + (data.status === "plan-required" ? PLAN_REQUIRED_MS : REFRESH_MS) });
          return quote;
        } catch {
          if (!request.signal.aborted)
            cache.current.set(query, { quote: null, expires: Date.now() + FAILURE_MS });
          return null;
        } finally {
          if (inFlight.current.get(query)?.request === request) inFlight.current.delete(query);
        }
      })();
      inFlight.current.set(query, { request, promise });
      return promise;
    }
    async function load() {
      for (const query of queries) {
        if (abort.signal.aborted) return;
        const cached = cache.current.get(query);
        let quote = cached && cached.expires > Date.now() ? cached.quote : undefined;
        if (quote === undefined) {
          // Keep a bounded request alive across headline changes so revisiting
          // its topic shares the result instead of cancelling and fetching again.
          quote = await requestQuote(query);
          if (abort.signal.aborted) return;
        }
        if (quote) {
          setResult({ key, quote });
          return;
        }
      }
      if (!abort.signal.aborted) setResult({ key, quote: null });
    }
    // Rapid next/previous clicks should not start a provider lookup for every
    // headline flashed through on the way to the user's chosen story.
    const pending = window.setTimeout(() => void load(), 100);
    const refresh = window.setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => { abort.abort(); window.clearTimeout(pending); window.clearInterval(refresh); };
  }, [key]);

  // A new headline must never display the previous company's quote while loading.
  return result?.key === key ? result.quote : null;
}
