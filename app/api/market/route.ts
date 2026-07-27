import { getChatGPTUser } from "../../chatgpt-auth";

type StockMatch = { symbol: string; name: string; exchange: string };

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
  close?: string;
  change?: string;
  percent_change?: string;
  is_market_open?: boolean;
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
  ["starbucks", "SBUX"],
  ["taiwan semiconductor", "TSM"],
  ["tesla", "TSLA"],
  ["tsmc", "TSM"],
]);

const NON_PUBLIC_COMPANIES = new Map<string, string>([
  ["spacex", "SpaceX is privately held and does not have a public stock ticker."],
  ["space x", "SpaceX is privately held and does not have a public stock ticker."],
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

  const topic = normalizeTopic(new URL(request.url).searchParams.get("topic") ?? "");
  if (!topic) return Response.json({ error: "Choose a topic." }, { status: 400 });

  const nonPublicMessage = NON_PUBLIC_COMPANIES.get(topic.toLowerCase());
  if (nonPublicMessage) {
    return Response.json(
      { matched: false, topic, status: "private", message: nonPublicMessage },
      { headers: { "Cache-Control": "private, max-age=3600" } },
    );
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "Market pricing is not configured." }, { status: 503 });
  }

  try {
    const match = await findMatch(topic, apiKey);
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
    const quote = await requestTwelveData<TwelveDataQuoteResponse>(
      `quote?symbol=${encodeURIComponent(match.symbol)}${exchange}`,
      apiKey,
    );
    const price = Number(quote.close);
    if (!Number.isFinite(price)) throw new Error("The latest quote did not include a price.");

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
      isMarketOpen: typeof quote.is_market_open === "boolean" ? quote.is_market_open : null,
      provider: "Twelve Data",
    };
    quoteCache.set(quoteCacheKey, { quote: result, expiresAt: Date.now() + 2 * 60_000 });

    return Response.json(
      { matched: true, quote: result },
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  } catch (error) {
    console.error("Market pricing failed", error);
    return Response.json(
      { error: "Market pricing is temporarily unavailable." },
      { status: 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
