import { useEffect, useRef, useState } from "react";
import { topicMatchesText } from "./api/news/topic-matching.ts";
import type { MarketQuote } from "./market-quote";

const REFRESH_MS = 5 * 60 * 1_000;
const FAILURE_MS = 60 * 1_000;
const PLAN_REQUIRED_MS = 30 * 60 * 1_000;

function findTickerOverride(topic: string, tickerOverrides: Record<string, string>): string | undefined {
  return Object.entries(tickerOverrides)
    .find(([name]) => name.toLowerCase() === topic)?.[1]?.trim() || undefined;
}

function topicMatchesHeadline(
  topic: string,
  headlineTitle: string,
  tickerOverrides: Record<string, string>,
): boolean {
  if (topicMatchesText(headlineTitle, topic)) return true;
  const overrideSymbol = findTickerOverride(topic, tickerOverrides)?.split(":")[0]?.trim();
  return Boolean(overrideSymbol && overrideSymbol.length >= 2 && topicMatchesText(headlineTitle, overrideSymbol));
}

function prioritizeTopic(topics: string[], preferred: string): string[] {
  const index = topics.indexOf(preferred);
  if (index <= 0) return topics;
  return [preferred, ...topics.slice(0, index), ...topics.slice(index + 1)];
}

/**
 * Selects and orders candidate topics for a briefing headline's market quote.
 * Topics appearing in the headline title take precedence over secondary topics,
 * and an active dashboard topic filter only breaks ties within the article's own topics.
 */
export function selectBriefingMarketTopics(
  topics: readonly string[],
  preferredTopic?: string,
  headlineTitle?: string,
  tickerOverrides: Record<string, string> = {},
): string[] {
  const uniqueTopics: string[] = [];
  const seen = new Set<string>();
  for (const raw of topics) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    uniqueTopics.push(lower);
  }
  if (uniqueTopics.length === 0) return [];

  const preferred = preferredTopic?.trim().toLowerCase();
  const hasPreferred = Boolean(preferred && seen.has(preferred));
  const title = headlineTitle?.trim();

  if (!title) {
    return hasPreferred && preferred ? prioritizeTopic(uniqueTopics, preferred) : uniqueTopics;
  }

  let titleMatched: string[] = [];
  let otherTopics: string[] = [];
  for (const topic of uniqueTopics) {
    if (topicMatchesHeadline(topic, title, tickerOverrides)) titleMatched.push(topic);
    else otherTopics.push(topic);
  }
  if (hasPreferred && preferred) {
    titleMatched = prioritizeTopic(titleMatched, preferred);
    otherTopics = prioritizeTopic(otherTopics, preferred);
  }
  return [...titleMatched, ...otherTopics];
}

export function useBriefingMarketQuote(
  topics: string[],
  preferredTopic: string | undefined,
  tickerOverrides: Record<string, string>,
  headlineTitle?: string,
) {
  const candidates = selectBriefingMarketTopics(topics, preferredTopic, headlineTitle, tickerOverrides);
  const requests = candidates.map((topic) => {
    const params = new URLSearchParams({ topic, optional: "true" });
    const symbol = findTickerOverride(topic, tickerOverrides);
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
