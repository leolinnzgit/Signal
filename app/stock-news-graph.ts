import { topicMatchesText } from "./api/news/topic-matching.ts";
import { hasExtendedMarketQuote, type ExtendedMarketQuoteFields, type MarketQuote } from "./market-quote.ts";

export type ArticleMarketQuote = ExtendedMarketQuoteFields & {
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
  recordedAtUtc: string;
};

export type StockNewsSeriesSummary = ExtendedMarketQuoteFields & {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  topic: string;
  articleCount: number;
  latestPrice: number;
  latestPercentChange: number;
};

export type StockNewsChartEvent = ExtendedMarketQuoteFields & {
  title: string;
  url: string;
  source: string;
  publishedAtUtc: string;
  recordedAtUtc: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: number;
  change: number;
  percentChange: number;
  quoteTime: string;
  isMarketOpen: boolean | null;
  isRecordedSnapshot: boolean;
  topics: string[];
};

export type StockNewsPricePoint = {
  timestamp: string;
  price: number;
  sourceType: string;
};

export type StockNewsGraphResponse = {
  configured: boolean;
  activeSymbol: string;
  activeName: string;
  activeExchange: string;
  activeCurrency: string;
  activeTopic: string;
  availableSeries: StockNewsSeriesSummary[];
  pricePoints: StockNewsPricePoint[];
  events: StockNewsChartEvent[];
};

export type StockNewsChartMode = "combined" | "snapshots";

export type StockNewsChartNode = {
  index: number;
  x: number;
  y: number;
  isPositive: boolean | null;
  event: StockNewsChartEvent;
};

export type StockNewsChartGridLine = {
  y: number;
  price: number;
};

export type StockNewsChartAxisTick = {
  x: number;
  label: string;
};

export type StockNewsChartCurvePoint = {
  x: number;
  y: number;
  price: number;
  timestamp: string;
  sourceType: string;
};

export type StockNewsChartGeometry = {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  minPrice: number;
  maxPrice: number;
  firstPrice: number;
  lastPrice: number;
  isUp: boolean;
  linePath: string;
  areaPath: string;
  curvePoints: StockNewsChartCurvePoint[];
  nodes: StockNewsChartNode[];
  yGridLines: StockNewsChartGridLine[];
  xTicks: StockNewsChartAxisTick[];
};

export type GraphArticleLike = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  topics?: string[];
  matchedTopics?: string[];
  marketQuotes?: ArticleMarketQuote[];
};

function cleanCompanyLookupName(name: string): string {
  return name
    .replace(/\b(Inc|Corp|Corporation|Ltd|Limited|PLC|ETF|Group|Holdings|Co|Company|Class\s+[A-Z]|SPDR|Trust)\b\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimeMs(value: string | undefined | null): number {
  if (!value || !value.trim()) return Number.NaN;
  const trimmed = value.trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    return Date.UTC(
      Number(dateOnlyMatch[1]),
      Number(dateOnlyMatch[2]) - 1,
      Number(dateOnlyMatch[3]),
      16,
      0,
      0,
    );
  }
  return Date.parse(trimmed);
}

function formatAxisDateLabel(timestamp: string, spanMs: number): string {
  const ms = parseTimeMs(timestamp);
  if (!Number.isFinite(ms)) return timestamp.slice(0, 10);
  const date = new Date(ms);
  if (spanMs <= 36 * 60 * 60 * 1000) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function extractExtendedFields(quote: ExtendedMarketQuoteFields | null | undefined): ExtendedMarketQuoteFields {
  if (!hasExtendedMarketQuote(quote)) {
    return {};
  }
  return {
    extendedPrice: quote.extendedPrice,
    extendedChange: typeof quote.extendedChange === "number" && Number.isFinite(quote.extendedChange) ? quote.extendedChange : null,
    extendedPercentChange:
      typeof quote.extendedPercentChange === "number" && Number.isFinite(quote.extendedPercentChange)
        ? quote.extendedPercentChange
        : null,
    extendedQuoteTime: quote.extendedQuoteTime || null,
    extendedSession: quote.extendedSession || null,
  };
}

export function marketQuoteToArticleQuote(
  quote: MarketQuote,
  recordedAtUtc = new Date().toISOString(),
): ArticleMarketQuote {
  return {
    topic: quote.topic || quote.name || quote.symbol,
    symbol: quote.symbol.trim().toUpperCase(),
    name: quote.name || quote.symbol,
    exchange: (quote.exchange || "").trim().toUpperCase(),
    currency: (quote.currency || "").trim().toUpperCase(),
    price: quote.price,
    change: Number.isFinite(quote.change) ? quote.change : 0,
    percentChange: Number.isFinite(quote.percentChange) ? quote.percentChange : 0,
    quoteTime: quote.quoteTime || "",
    isMarketOpen: quote.isMarketOpen ?? null,
    recordedAtUtc,
    ...extractExtendedFields(quote),
  };
}

function quoteMatchesArticle(quote: MarketQuote, article: {
  title: string;
  topics?: string[];
  matchedTopics?: string[];
}): boolean {
  const tags = [
    ...(Array.isArray(article.topics) ? article.topics : []),
    ...(Array.isArray(article.matchedTopics) ? article.matchedTopics : []),
  ];
  const quoteTopic = (quote.topic || "").trim();
  const quoteSymbol = (quote.symbol || "").trim().toUpperCase();
  const cleanName = cleanCompanyLookupName(quote.name || "");

  if (quoteTopic && tags.some((t) => t.trim().toLowerCase() === quoteTopic.toLowerCase())) {
    return true;
  }
  if (quoteSymbol && tags.some((t) => t.trim().toUpperCase() === quoteSymbol)) {
    return true;
  }
  if (quoteTopic && topicMatchesText(article.title, quoteTopic)) {
    return true;
  }
  if (quoteSymbol.length >= 2 && topicMatchesText(article.title, quoteSymbol)) {
    return true;
  }
  if (cleanName.length >= 3 && topicMatchesText(article.title, cleanName)) {
    return true;
  }
  return false;
}

/**
 * Attaches live watchlist/topic quotes to articles that do not yet carry a persisted
 * snapshot, while strictly preserving any already-recorded article marketQuotes.
 */
export function enrichArticlesWithMarketQuotes<
  T extends {
    title: string;
    publishedAt?: string;
    topics?: string[];
    matchedTopics?: string[];
    marketQuotes?: ArticleMarketQuote[];
  },
>(articles: readonly T[], liveQuotes: readonly MarketQuote[], recordedAtUtc?: string): T[] {
  if (!Array.isArray(articles) || articles.length === 0) return [];
  const validQuotes = (liveQuotes || []).filter(
    (q) => q && typeof q.symbol === "string" && q.symbol.trim() && Number.isFinite(q.price) && q.price > 0,
  );
  if (validQuotes.length === 0) {
    return articles.slice();
  }

  const allowAnyAge = Boolean(recordedAtUtc);
  const nowMs = Date.now();
  const maxLiveAgeMs = 2 * 60 * 60 * 1000;
  const stamp = recordedAtUtc || new Date().toISOString();
  return articles.map((article) => {
    if (Array.isArray(article.marketQuotes) && article.marketQuotes.length > 0) {
      return article;
    }

    if (!allowAnyAge && article.publishedAt) {
      const publishedMs = parseTimeMs(article.publishedAt);
      if (Number.isFinite(publishedMs) && Math.abs(nowMs - publishedMs) > maxLiveAgeMs) {
        return article;
      }
    }

    const matched: ArticleMarketQuote[] = [];
    const seen = new Set<string>();
    for (const quote of validQuotes) {
      if (!quoteMatchesArticle(quote, article)) continue;
      const key = `${quote.symbol.trim().toUpperCase()}:${(quote.exchange || "").trim().toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push(marketQuoteToArticleQuote(quote, stamp));
      if (matched.length >= 6) break;
    }

    if (matched.length === 0) return article;
    return { ...article, marketQuotes: matched };
  });
}

export function buildClientStockNewsGraph(
  articles: readonly GraphArticleLike[],
  liveQuotes: readonly MarketQuote[],
  options: { symbol?: string; topic?: string } = {},
): StockNewsGraphResponse {
  const seriesMap = new Map<string, StockNewsSeriesSummary & { latestTimeMs: number }>();

  for (const article of articles) {
    const quotes = Array.isArray(article.marketQuotes) ? article.marketQuotes : [];
    const seenInArticle = new Set<string>();
    for (const q of quotes) {
      if (!q?.symbol || !Number.isFinite(q.price) || q.price <= 0) continue;
      const symbol = q.symbol.trim().toUpperCase();
      if (seenInArticle.has(symbol)) continue;
      seenInArticle.add(symbol);

      const timeMs = Math.max(
        parseTimeMs(q.recordedAtUtc) || 0,
        parseTimeMs(article.publishedAt) || 0,
      );
      const existing = seriesMap.get(symbol);
      const ext = extractExtendedFields(q);
      if (!existing) {
        seriesMap.set(symbol, {
          symbol,
          name: q.name || symbol,
          exchange: q.exchange || "",
          currency: q.currency || "",
          topic: q.topic || q.name || symbol,
          articleCount: 1,
          latestPrice: q.price,
          latestPercentChange: Number.isFinite(q.percentChange) ? q.percentChange : 0,
          latestTimeMs: timeMs,
          ...ext,
        });
      } else {
        existing.articleCount += 1;
        if (timeMs >= existing.latestTimeMs) {
          existing.latestTimeMs = timeMs;
          existing.latestPrice = q.price;
          existing.latestPercentChange = Number.isFinite(q.percentChange) ? q.percentChange : 0;
          Object.assign(existing, ext);
        }
      }
    }
  }

  for (const q of liveQuotes || []) {
    if (!q?.symbol || !Number.isFinite(q.price) || q.price <= 0) continue;
    const symbol = q.symbol.trim().toUpperCase();
    const existing = seriesMap.get(symbol);
    const ext = extractExtendedFields(q);
    if (!existing) {
      seriesMap.set(symbol, {
        symbol,
        name: q.name || symbol,
        exchange: q.exchange || "",
        currency: q.currency || "",
        topic: q.topic || q.name || symbol,
        articleCount: 0,
        latestPrice: q.price,
        latestPercentChange: Number.isFinite(q.percentChange) ? q.percentChange : 0,
        latestTimeMs: Date.now(),
        ...ext,
      });
    } else if (Date.now() >= existing.latestTimeMs) {
      existing.latestPrice = q.price;
      existing.latestPercentChange = Number.isFinite(q.percentChange) ? q.percentChange : existing.latestPercentChange;
      Object.assign(existing, ext);
    }
  }

  const availableSeries: StockNewsSeriesSummary[] = Array.from(seriesMap.values())
    .map(({ latestTimeMs: _ignored, ...rest }) => rest)
    .sort((a, b) => b.articleCount - a.articleCount || a.symbol.localeCompare(b.symbol));

  let activeSymbol = (options.symbol || "").trim().split(":")[0].toUpperCase();
  let activeTopic = (options.topic || "").trim();

  if (!activeSymbol && activeTopic) {
    const byTopic = availableSeries.find((s) => s.topic.toLowerCase() === activeTopic.toLowerCase());
    if (byTopic) activeSymbol = byTopic.symbol;
  }
  if (!activeSymbol && !activeTopic && availableSeries.length > 0) {
    activeSymbol = availableSeries[0].symbol;
    activeTopic = availableSeries[0].topic;
  }

  const activeSeries = availableSeries.find((s) => s.symbol === activeSymbol);
  const matchingLive = (liveQuotes || []).find(
    (q) =>
      (activeSymbol && q.symbol.trim().toUpperCase() === activeSymbol) ||
      (activeTopic && q.topic.trim().toLowerCase() === activeTopic.toLowerCase()),
  );

  if (!activeSymbol && matchingLive) {
    activeSymbol = matchingLive.symbol.trim().toUpperCase();
  }
  const activeName = matchingLive?.name || activeSeries?.name || activeTopic || activeSymbol;
  const activeExchange = matchingLive?.exchange || activeSeries?.exchange || "";
  const activeCurrency = matchingLive?.currency || activeSeries?.currency || "";
  if (!activeTopic) activeTopic = activeSeries?.topic || matchingLive?.topic || activeName;

  const sortedArticles = articles
    .slice()
    .sort((a, b) => (parseTimeMs(a.publishedAt) || 0) - (parseTimeMs(b.publishedAt) || 0));

  const events: StockNewsChartEvent[] = [];
  for (const article of sortedArticles) {
    const recorded = (article.marketQuotes || []).find(
      (q) => activeSymbol && q.symbol.trim().toUpperCase() === activeSymbol && Number.isFinite(q.price) && q.price > 0,
    );
    const articleTopics = Array.isArray(article.topics)
      ? article.topics
      : Array.isArray(article.matchedTopics)
        ? article.matchedTopics
        : [];
    const publishedIso = article.publishedAt || new Date().toISOString();

    if (recorded) {
      events.push({
        title: article.title,
        url: article.url,
        source: article.source,
        publishedAtUtc: publishedIso,
        recordedAtUtc: recorded.recordedAtUtc || publishedIso,
        symbol: recorded.symbol.toUpperCase(),
        name: recorded.name || activeName,
        exchange: recorded.exchange || activeExchange,
        currency: recorded.currency || activeCurrency,
        price: recorded.price,
        change: recorded.change,
        percentChange: recorded.percentChange,
        quoteTime: recorded.quoteTime,
        isMarketOpen: recorded.isMarketOpen,
        isRecordedSnapshot: true,
        topics: articleTopics,
        ...extractExtendedFields(recorded),
      });
      continue;
    }

    if (!matchingLive || !Number.isFinite(matchingLive.price) || matchingLive.price <= 0) continue;
    if (!quoteMatchesArticle(matchingLive, article)) continue;

    events.push({
      title: article.title,
      url: article.url,
      source: article.source,
      publishedAtUtc: publishedIso,
      recordedAtUtc: publishedIso,
      symbol: activeSymbol,
      name: activeName,
      exchange: activeExchange,
      currency: activeCurrency,
      price: matchingLive.price,
      change: matchingLive.change,
      percentChange: matchingLive.percentChange,
      quoteTime: matchingLive.quoteTime,
      isMarketOpen: matchingLive.isMarketOpen,
      isRecordedSnapshot: false,
      topics: articleTopics,
      ...extractExtendedFields(matchingLive),
    });
  }

  const pricePoints: StockNewsPricePoint[] = [];
  if (matchingLive?.sparkline && matchingLive.sparkline.length >= 2) {
    const spark = matchingLive.sparkline.filter((n) => Number.isFinite(n) && n > 0);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    spark.forEach((price, idx) => {
      const daysBack = spark.length - 1 - idx;
      const ts = new Date(now - daysBack * dayMs).toISOString().slice(0, 10);
      pricePoints.push({ timestamp: ts, price, sourceType: "historical-close" });
    });
  }
  for (const ev of events) {
    pricePoints.push({
      timestamp: ev.publishedAtUtc,
      price: ev.price,
      sourceType: ev.isRecordedSnapshot ? "news-snapshot" : "news-aligned",
    });
  }

  pricePoints.sort((a, b) => (parseTimeMs(a.timestamp) || 0) - (parseTimeMs(b.timestamp) || 0));

  return {
    configured: Boolean(matchingLive),
    activeSymbol,
    activeName,
    activeExchange,
    activeCurrency,
    activeTopic,
    availableSeries,
    pricePoints,
    events,
  };
}

export function mergeStockNewsGraphData(
  serverData: StockNewsGraphResponse | null | undefined,
  clientData: StockNewsGraphResponse,
): StockNewsGraphResponse {
  if (!serverData) return clientData;

  const seriesBySymbol = new Map<string, StockNewsSeriesSummary>();
  for (const s of clientData.availableSeries) {
    seriesBySymbol.set(s.symbol.toUpperCase(), { ...s });
  }
  for (const s of serverData.availableSeries) {
    const key = s.symbol.toUpperCase();
    const existing = seriesBySymbol.get(key);
    if (!existing) {
      seriesBySymbol.set(key, { ...s });
    } else {
      const serverExt = extractExtendedFields(s);
      const clientExt = extractExtendedFields(existing);
      const mergedExt = hasExtendedMarketQuote(s) ? serverExt : clientExt;
      seriesBySymbol.set(key, {
        ...s,
        ...mergedExt,
        articleCount: Math.max(s.articleCount, existing.articleCount),
        latestPrice: s.latestPrice > 0 ? s.latestPrice : existing.latestPrice,
        latestPercentChange: s.latestPrice > 0 ? s.latestPercentChange : existing.latestPercentChange,
      });
    }
  }

  const eventsByUrl = new Map<string, StockNewsChartEvent>();
  for (const ev of clientData.events) {
    const key = ev.url.trim().toLowerCase();
    if (key) eventsByUrl.set(key, ev);
  }
  for (const ev of serverData.events) {
    const key = ev.url.trim().toLowerCase();
    if (!key) continue;
    const existing = eventsByUrl.get(key);
    if (!existing || ev.isRecordedSnapshot || !existing.isRecordedSnapshot) {
      eventsByUrl.set(key, ev);
    }
  }

  const mergedEvents = Array.from(eventsByUrl.values()).sort(
    (a, b) => (parseTimeMs(a.publishedAtUtc) || 0) - (parseTimeMs(b.publishedAtUtc) || 0),
  );

  const points: StockNewsPricePoint[] = [];
  const seenPointKeys = new Set<string>();
  const addPoint = (pt: StockNewsPricePoint) => {
    if (!Number.isFinite(pt.price) || pt.price <= 0) return;
    const ms = parseTimeMs(pt.timestamp);
    const key = `${Number.isFinite(ms) ? ms : pt.timestamp}:${pt.sourceType}`;
    if (seenPointKeys.has(key)) return;
    seenPointKeys.add(key);
    points.push(pt);
  };

  for (const pt of serverData.pricePoints) addPoint(pt);
  if (serverData.pricePoints.length === 0) {
    for (const pt of clientData.pricePoints) addPoint(pt);
  } else {
    for (const ev of mergedEvents) {
      addPoint({
        timestamp: ev.publishedAtUtc,
        price: ev.price,
        sourceType: ev.isRecordedSnapshot ? "news-snapshot" : "news-aligned",
      });
    }
  }

  points.sort((a, b) => {
    const diff = (parseTimeMs(a.timestamp) || 0) - (parseTimeMs(b.timestamp) || 0);
    if (diff !== 0) return diff;
    return a.sourceType === "historical-close" ? -1 : 1;
  });

  const activeSymbol = serverData.activeSymbol || clientData.activeSymbol;
  const availableSeries = Array.from(seriesBySymbol.values()).sort(
    (a, b) => b.articleCount - a.articleCount || a.symbol.localeCompare(b.symbol),
  );

  return {
    configured: serverData.configured || clientData.configured,
    activeSymbol,
    activeName: serverData.activeName || clientData.activeName,
    activeExchange: serverData.activeExchange || clientData.activeExchange,
    activeCurrency: serverData.activeCurrency || clientData.activeCurrency,
    activeTopic: serverData.activeTopic || clientData.activeTopic,
    availableSeries,
    pricePoints: points,
    events: mergedEvents,
  };
}

function selectChartPinEvents(
  sortedEvents: readonly StockNewsChartEvent[],
  selectedEventUrl?: string,
  maxPins = 32,
): StockNewsChartEvent[] {
  if (sortedEvents.length <= maxPins) return sortedEvents.slice();

  const selectedIndices = new Set<number>([0, sortedEvents.length - 1]);
  if (selectedEventUrl) {
    const targetLower = selectedEventUrl.trim().toLowerCase();
    const matchIdx = sortedEvents.findIndex((ev) => ev.url.trim().toLowerCase() === targetLower);
    if (matchIdx >= 0) selectedIndices.add(matchIdx);
  }

  // Include peak percentage movers
  const byMagnitude = sortedEvents
    .map((ev, idx) => ({ idx, mag: Math.abs(ev.percentChange || 0) }))
    .filter((item) => item.mag > 0)
    .sort((a, b) => b.mag - a.mag);
  for (const item of byMagnitude.slice(0, 8)) {
    if (selectedIndices.size >= maxPins) break;
    selectedIndices.add(item.idx);
  }

  // Fill remaining slots evenly across the timeline
  const remainingSlots = maxPins - selectedIndices.size;
  if (remainingSlots > 0) {
    const step = (sortedEvents.length - 1) / (remainingSlots + 1);
    for (let i = 1; i <= remainingSlots; i++) {
      const idx = Math.min(sortedEvents.length - 1, Math.round(i * step));
      selectedIndices.add(idx);
    }
  }

  let cursor = 0;
  while (selectedIndices.size < maxPins && cursor < sortedEvents.length) {
    selectedIndices.add(cursor);
    cursor++;
  }

  return Array.from(selectedIndices)
    .sort((a, b) => a - b)
    .map((idx) => sortedEvents[idx]);
}

export function buildStockNewsChartGeometry(
  pricePoints: readonly StockNewsPricePoint[],
  events: readonly StockNewsChartEvent[],
  width = 760,
  height = 280,
  mode: StockNewsChartMode = "combined",
  selectedEventUrl?: string,
): StockNewsChartGeometry | null {
  const sortedEvents = events
    .filter((ev) => Number.isFinite(ev.price) && ev.price > 0)
    .slice()
    .sort((a, b) => (parseTimeMs(a.publishedAtUtc) || 0) - (parseTimeMs(b.publishedAtUtc) || 0));

  const pinnedEvents = selectChartPinEvents(sortedEvents, selectedEventUrl, 32);

  const rawPoints: StockNewsPricePoint[] =
    mode === "snapshots"
      ? pinnedEvents.map((ev) => ({
          timestamp: ev.publishedAtUtc,
          price: ev.price,
          sourceType: ev.isRecordedSnapshot ? "news-snapshot" : "news-aligned",
        }))
      : pricePoints.length > 0
        ? pricePoints.filter((pt) => Number.isFinite(pt.price) && pt.price > 0)
        : pinnedEvents.map((ev) => ({
            timestamp: ev.publishedAtUtc,
            price: ev.price,
            sourceType: ev.isRecordedSnapshot ? "news-snapshot" : "news-aligned",
          }));

  if (rawPoints.length === 0) return null;

  const plotLeft = 64;
  const plotRight = width - 22;
  const plotTop = 20;
  const plotBottom = height - 34;
  const innerW = Math.max(40, plotRight - plotLeft);
  const innerH = Math.max(40, plotBottom - plotTop);

  const rawPrices = rawPoints.map((p) => p.price);
  for (const ev of sortedEvents) rawPrices.push(ev.price);

  const rawMin = Math.min(...rawPrices);
  const rawMax = Math.max(...rawPrices);
  const rawSpan = rawMax - rawMin;
  const pad = rawSpan < 1e-4 ? Math.max(0.5, rawMax * 0.025) : rawSpan * 0.14;
  const minPrice = Math.max(0, rawMin - pad);
  const maxPrice = rawMax + pad;
  const span = Math.max(1e-6, maxPrice - minPrice);

  const priceToY = (price: number): number => {
    const ratio = (price - minPrice) / span;
    return Math.round((plotBottom - ratio * innerH) * 100) / 100;
  };

  const parsedTimes = rawPoints.map((pt, idx) => {
    const ms = parseTimeMs(pt.timestamp);
    return Number.isFinite(ms) ? ms : idx;
  });
  const minTime = Math.min(...parsedTimes);
  const maxTime = Math.max(...parsedTimes);
  const timeSpan = maxTime - minTime;

  const timeToX = (ms: number, fallbackIndex: number, totalCount: number): number => {
    if (totalCount <= 1) return Math.round((plotLeft + innerW / 2) * 100) / 100;
    if (mode === "snapshots" || timeSpan <= 0) {
      return Math.round((plotLeft + (fallbackIndex / (totalCount - 1)) * innerW) * 100) / 100;
    }
    const ratio = (ms - minTime) / timeSpan;
    const clamped = Math.max(0, Math.min(1, ratio));
    return Math.round((plotLeft + clamped * innerW) * 100) / 100;
  };

  const curvePoints: StockNewsChartCurvePoint[] = rawPoints.map((pt, idx) => {
    const ms = parsedTimes[idx];
    const x = rawPoints.length === 1 && idx === 0
      ? plotLeft + innerW * 0.5
      : timeToX(ms, idx, rawPoints.length);
    return {
      x,
      y: priceToY(pt.price),
      price: pt.price,
      timestamp: pt.timestamp,
      sourceType: pt.sourceType,
    };
  });

  let linePath: string;
  let areaPath: string;
  if (curvePoints.length === 1) {
    const single = curvePoints[0];
    linePath = `M ${plotLeft} ${single.y} L ${plotRight} ${single.y}`;
    areaPath = `M ${plotLeft} ${single.y} L ${plotRight} ${single.y} L ${plotRight} ${plotBottom} L ${plotLeft} ${plotBottom} Z`;
  } else {
    linePath = curvePoints
      .map((pt, idx) => `${idx === 0 ? "M" : "L"} ${pt.x} ${pt.y}`)
      .join(" ");
    const first = curvePoints[0];
    const last = curvePoints[curvePoints.length - 1];
    areaPath = `${linePath} L ${last.x} ${plotBottom} L ${first.x} ${plotBottom} Z`;
  }

  const nodes: StockNewsChartNode[] = pinnedEvents.map((event, idx) => {
    const ms = parseTimeMs(event.publishedAtUtc);
    const baseX =
      pinnedEvents.length === 1 && curvePoints.length === 1
        ? plotLeft + innerW * 0.5
        : timeToX(Number.isFinite(ms) ? ms : idx, idx, pinnedEvents.length);
    const x = Math.max(plotLeft + 6, Math.min(plotRight - 6, baseX));
    const y = Math.max(plotTop + 6, Math.min(plotBottom - 6, priceToY(event.price)));
    const isPositive =
      event.percentChange > 0.001
        ? true
        : event.percentChange < -0.001
          ? false
          : null;
    return {
      index: idx,
      x,
      y,
      isPositive,
      event,
    };
  });

  // Gently separate catalyst nodes that land within 6px of each other on X so every news pin stays clickable.
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const curr = nodes[i];
    if (Math.abs(curr.x - prev.x) < 7 && Math.abs(curr.y - prev.y) < 10) {
      curr.x = Math.min(plotRight - 6, prev.x + 8);
    }
  }

  const gridCount = 4;
  const yGridLines: StockNewsChartGridLine[] = [];
  for (let i = 0; i <= gridCount; i++) {
    const price = minPrice + ((maxPrice - minPrice) * i) / gridCount;
    yGridLines.push({
      y: priceToY(price),
      price,
    });
  }

  const xTicks: StockNewsChartAxisTick[] = [];
  if (rawPoints.length === 1) {
    xTicks.push({
      x: plotLeft + innerW * 0.5,
      label: formatAxisDateLabel(rawPoints[0].timestamp, 0),
    });
  } else {
    const tickIndices = rawPoints.length <= 3
      ? rawPoints.map((_, idx) => idx)
      : [0, Math.floor((rawPoints.length - 1) / 2), rawPoints.length - 1];
    const seenX = new Set<number>();
    for (const idx of tickIndices) {
      const pt = curvePoints[idx];
      if (!pt || seenX.has(pt.x)) continue;
      seenX.add(pt.x);
      xTicks.push({
        x: pt.x,
        label: formatAxisDateLabel(pt.timestamp, Math.max(0, timeSpan)),
      });
    }
  }

  const firstPrice = rawPoints[0].price;
  const lastPrice = rawPoints[rawPoints.length - 1].price;

  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    minPrice,
    maxPrice,
    firstPrice,
    lastPrice,
    isUp: lastPrice >= firstPrice,
    linePath,
    areaPath,
    curvePoints,
    nodes,
    yGridLines,
    xTicks,
  };
}

export async function fetchStockNewsGraph(
  params: { topic?: string; symbol?: string; days?: number },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<StockNewsGraphResponse | null> {
  const query = new URLSearchParams();
  if (params.topic) query.set("topic", params.topic);
  if (params.symbol) query.set("symbol", params.symbol);
  if (params.days) query.set("days", String(params.days));

  try {
    const response = await fetcher(`/api/market/news-graph?${query.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<StockNewsGraphResponse>;
    return {
      configured: Boolean(data?.configured),
      activeSymbol: data?.activeSymbol || "",
      activeName: data?.activeName || "",
      activeExchange: data?.activeExchange || "",
      activeCurrency: data?.activeCurrency || "",
      activeTopic: data?.activeTopic || "",
      availableSeries: Array.isArray(data?.availableSeries) ? data.availableSeries : [],
      pricePoints: Array.isArray(data?.pricePoints) ? data.pricePoints : [],
      events: Array.isArray(data?.events) ? data.events : [],
    };
  } catch {
    return null;
  }
}
