import { getChatGPTUser } from "../../chatgpt-auth";

type StockMatch = { symbol: string; name: string; exchange: string };
type TickerOverride = { symbol: string; exchange: string };

type TwelveDataSearchResponse = {
  data?: Array<{
    symbol?: string;
    instrument_name?: string;
    exchange?: string;
    instrument_type?: string;
  }>;
  status?: string;
  message?: string;
};

type TwelveDataQuoteResponse = {
  symbol?: string;
  name?: string;
  exchange?: string;
  currency?: string;
  datetime?: string;
  last_quote_at?: string | number;
  close?: string;
  change?: string;
  percent_change?: string;
  is_market_open?: boolean;
  extended_price?: string | number;
  extended_change?: string | number;
  extended_percent_change?: string | number;
  extended_timestamp?: string | number;
  extended_datetime?: string;
  status?: string;
  message?: string;
};

const KNOWN_SYMBOLS = new Map<string, string>([
  ["adobe", "ADBE"],
  ["alibaba", "BABA"],
  ["alphabet", "GOOGL"],
  ["amd", "AMD"],
  ["amazon", "AMZN"],
  ["apple", "AAPL"],
  ["arm", "ARM"],
  ["broadcom", "AVGO"],
  ["coinbase", "COIN"],
  ["google", "GOOGL"],
  ["ibm", "IBM"],
  ["intel", "INTC"],
  ["meta", "META"],
  ["microsoft", "MSFT"],
  ["netflix", "NFLX"],
  ["nvidia", "NVDA"],
  ["oracle", "ORCL"],
  ["palantir", "PLTR"],
  ["salesforce", "CRM"],
  ["spacex", "SPCX"],
  ["space x", "SPCX"],
  ["starbucks", "SBUX"],
  ["taiwan semiconductor", "TSM"],
  ["tesla", "TSLA"],
  ["tsmc", "TSM"],
]);

const KNOWN_NZX_SYMBOLS = new Map<string, string>([
  ["air new zealand", "AIR"],
  ["auckland airport", "AIA"],
  ["auckland international airport", "AIA"],
  ["contact energy", "CEN"],
  ["fisher & paykel healthcare", "FPH"],
  ["fletcher building", "FBU"],
  ["infratil", "IFT"],
  ["mainfreight", "MFT"],
  ["mercury nz", "MCY"],
  ["meridian energy", "MEL"],
  ["spark new zealand", "SPK"],
  ["the a2 milk company", "ATM"],
  ["the warehouse group", "WHS"],
]);

const SUPPORTED_TYPES = new Set([
  "american depositary receipt",
  "common stock",
  "depositary receipt",
  "etf",
  "global depositary receipt",
  "reit",
]);

const matchCache = new Map<string, { expiresAt: number; match: StockMatch | null }>();
const quoteCache = new Map<string, { expiresAt: number; quote: Record<string, unknown> }>();

function normalizeTopic(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeTicker(value: string): TickerOverride {
  const parts = value.trim().replace(/^\$/, "").toUpperCase().split(":");
  const symbol = parts[0]?.trim() ?? "";
  const requestedExchange = parts[1]?.trim() ?? "";
  const exchange = requestedExchange === "XNZE" ? "NZX" : requestedExchange;
  if (parts.length > 2
    || !/^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(symbol)
    || (parts.length === 2 && !/^[A-Z0-9][A-Z0-9._-]{1,11}$/.test(exchange))) {
    throw new Error("Enter a ticker such as AAPL or an exchange-qualified ticker such as AIR:NZX.");
  }
  return {
    symbol,
    exchange,
  };
}

function normalizeForMatch(value: string) {
  const drop = new Set([
    "adr", "co", "company", "corp", "corporation", "holdings", "inc",
    "incorporated", "limited", "ltd", "plc", "sa",
  ]);
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && !drop.has(word))
    .join(" ");
}

function isConfidentMatch(topic: string, match: StockMatch) {
  if (topic.toLowerCase() === match.symbol.toLowerCase()) return true;
  const normalizedTopic = normalizeForMatch(topic);
  const normalizedName = normalizeForMatch(match.name);
  if (normalizedTopic.length < 2 || normalizedName.length < 2) return false;
  return normalizedTopic === normalizedName
    || normalizedName.startsWith(`${normalizedTopic} `)
    || normalizedTopic.startsWith(`${normalizedName} `);
}

function isExtendedHoursUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("pre/post")
    || message.includes("pre-market")
    || message.includes("extended hours")
    || message.includes("prepost");
}

function formatEtTimestamp(unixSeconds: number): { label: string; isPreMarket: boolean } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(unixSeconds * 1000));
  const map = new Map(parts.map((part) => [part.type, part.value]));
  const hour = Number(map.get("hour") ?? "0");
  const minute = Number(map.get("minute") ?? "0");
  const datePart = `${map.get("year") ?? "0000"}-${map.get("month") ?? "01"}-${map.get("day") ?? "01"}`;
  const timePart = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return {
    label: `${datePart} ${timePart} ET`,
    isPreMarket: hour >= 4 && (hour < 9 || (hour === 9 && minute < 30)),
  };
}

async function requestTwelveData<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`https://api.twelvedata.com/${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `apikey ${apiKey}`,
      "User-Agent": "Signal News Monitor/2.0",
    },
    cache: "no-store",
  });
  const data = await response.json() as T & { status?: string; message?: string };
  if (!response.ok || data.status === "error") {
    throw new Error(data.message || "Market pricing is temporarily unavailable.");
  }
  return data;
}

async function findMatch(topic: string, apiKey: string) {
  const known = KNOWN_SYMBOLS.get(topic.toLowerCase());
  if (known) return { symbol: known, name: "", exchange: "" };
  const knownNzx = KNOWN_NZX_SYMBOLS.get(topic.toLowerCase());
  if (knownNzx) return { symbol: knownNzx, name: "", exchange: "NZX" };

  const cacheKey = topic.toLowerCase();
  const cached = matchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.match;

  const result = await requestTwelveData<TwelveDataSearchResponse>(
    `symbol_search?symbol=${encodeURIComponent(topic)}&outputsize=10`,
    apiKey,
  );
  const match = (result.data ?? [])
    .map((candidate): StockMatch => ({
      symbol: candidate.symbol?.trim() ?? "",
      name: candidate.instrument_name?.trim() ?? "",
      exchange: candidate.exchange?.trim() ?? "",
    }))
    .find((candidate, index) => {
      const instrumentType = result.data?.[index]?.instrument_type?.toLowerCase() ?? "";
      return candidate.symbol && candidate.name && SUPPORTED_TYPES.has(instrumentType) && isConfidentMatch(topic, candidate);
    }) ?? null;

  matchCache.set(cacheKey, {
    match,
    expiresAt: Date.now() + (match ? 24 * 60 * 60_000 : 4 * 60 * 60_000),
  });
  return match;
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) {
    return Response.json(
      { error: "Sign in with ChatGPT to use Signal." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const searchParams = new URL(request.url).searchParams;
  const topic = normalizeTopic(searchParams.get("topic") ?? "");
  if (!topic) return Response.json({ error: "Choose a topic." }, { status: 400 });
  const requestedTicker = searchParams.get("symbol");
  let tickerOverride: TickerOverride | null = null;
  try {
    tickerOverride = requestedTicker ? normalizeTicker(requestedTicker) : null;
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Enter a valid ticker." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "Market pricing is not configured." }, { status: 503 });
  }

  try {
    const match = tickerOverride
      ? { symbol: tickerOverride.symbol, name: "", exchange: tickerOverride.exchange }
      : await findMatch(topic, apiKey);
    if (!match) {
      return Response.json(
        {
          matched: false,
          topic,
          status: "not-found",
          message: "No confident public stock match was found.",
        },
        { headers: { "Cache-Control": "private, max-age=300" } },
      );
    }

    const quoteCacheKey = `${match.symbol}:${match.exchange}`.toLowerCase();
    const cached = quoteCache.get(quoteCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return Response.json(
        { matched: true, quote: { ...cached.quote, topic } },
        { headers: { "Cache-Control": "private, max-age=60" } },
      );
    }

    const exchange = match.exchange ? `&exchange=${encodeURIComponent(match.exchange)}` : "";
    const baseQuotePath = `quote?symbol=${encodeURIComponent(match.symbol)}${exchange}`;
    let quote: TwelveDataQuoteResponse;
    try {
      quote = await requestTwelveData<TwelveDataQuoteResponse>(`${baseQuotePath}&prepost=true`, apiKey);
    } catch (error) {
      if (!isExtendedHoursUnsupported(error)) throw error;
      quote = await requestTwelveData<TwelveDataQuoteResponse>(baseQuotePath, apiKey);
    }
    const price = Number(quote.close);
    if (!Number.isFinite(price)) throw new Error("The latest quote did not include a price.");

    const isMarketOpen = typeof quote.is_market_open === "boolean" ? quote.is_market_open : null;
    const lastQuoteAt = Number(quote.last_quote_at);
    const extendedPriceRaw = Number(quote.extended_price);
    const extendedTimestamp = Number(quote.extended_timestamp);
    const extendedDatetime = typeof quote.extended_datetime === "string" ? quote.extended_datetime.trim() : "";

    let extendedPrice: number | null = null;
    let extendedChange: number | null = null;
    let extendedPercentChange: number | null = null;
    let extendedQuoteTime: string | null = null;
    let extendedSession: "after-hours" | "pre-market" | null = null;

    const isStalePreMarket = isMarketOpen === true
      && Number.isFinite(lastQuoteAt)
      && Number.isFinite(extendedTimestamp)
      && extendedTimestamp < lastQuoteAt;

    if (Number.isFinite(extendedPriceRaw) && extendedPriceRaw > 0 && !isStalePreMarket) {
      extendedPrice = extendedPriceRaw;
      const rawExtChange = Number(quote.extended_change);
      extendedChange = Number.isFinite(rawExtChange)
        ? rawExtChange
        : Math.round((extendedPrice - price) * 10000) / 10000;
      const rawExtPct = Number(quote.extended_percent_change);
      extendedPercentChange = Number.isFinite(rawExtPct)
        ? rawExtPct
        : price > 0 ? Math.round((extendedChange / price) * 10000) / 100 : 0;

      if (Number.isFinite(extendedTimestamp) && extendedTimestamp > 0) {
        const formatted = formatEtTimestamp(extendedTimestamp);
        extendedQuoteTime = extendedDatetime || formatted.label;
        extendedSession = formatted.isPreMarket ? "pre-market" : "after-hours";
      } else if (extendedDatetime) {
        extendedQuoteTime = extendedDatetime;
        const matchTime = /(\d{2}):(\d{2})/.exec(extendedDatetime);
        const h = matchTime ? Number(matchTime[1]) : 16;
        const m = matchTime ? Number(matchTime[2]) : 0;
        extendedSession = h >= 4 && (h < 9 || (h === 9 && m < 30)) ? "pre-market" : "after-hours";
      } else {
        extendedSession = "after-hours";
      }
    }

    const result = {
      topic,
      symbol: quote.symbol || match.symbol,
      name: quote.name || match.name || match.symbol,
      exchange: quote.exchange || match.exchange,
      currency: quote.currency || "",
      price,
      change: Number(quote.change) || 0,
      percentChange: Number(quote.percent_change) || 0,
      quoteTime: quote.datetime || "",
      isMarketOpen,
      provider: "Twelve Data",
      extendedPrice,
      extendedChange,
      extendedPercentChange,
      extendedQuoteTime,
      extendedSession,
    };
    quoteCache.set(quoteCacheKey, { quote: result, expiresAt: Date.now() + 2 * 60_000 });

    return Response.json(
      { matched: true, quote: result },
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  } catch (error) {
    console.error("Market pricing failed", error);
    const planRestricted = error instanceof Error
      && error.message.toLowerCase().includes("available starting with the pro or venture plan");
    const qualifiedSymbol = tickerOverride?.exchange
      ? `${tickerOverride.symbol}:${tickerOverride.exchange}`
      : tickerOverride?.symbol ?? "This ticker";
    return Response.json(
      {
        error: planRestricted
          ? tickerOverride?.exchange === "NZX"
            ? `${qualifiedSymbol} is a valid NZX ticker, but NZX prices require a Twelve Data Pro or Venture plan.`
            : `${qualifiedSymbol} is not available on the configured Twelve Data plan.`
          : tickerOverride ? "That ticker could not be verified." : "Market pricing is temporarily unavailable.",
      },
      { status: planRestricted ? 402 : tickerOverride ? 400 : 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
