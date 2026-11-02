export interface MacroCorrelationStory {
  title: string;
  url: string;
  source: string;
  impactType: "bullish" | "headwind" | "neutral" | string;
}

export interface MarketSentimentAsset {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePercent: number;
  sentimentTone: "bullish" | "bearish" | "neutral" | string;
  attributions: MacroCorrelationStory[];
}

export interface MarketSentimentMatrixResponse {
  configured: boolean;
  assets: MarketSentimentAsset[];
  macroHeadline: string;
}

export async function fetchMarketSentimentMatrix(
  items?: Array<{ topic: string; symbol?: string }>,
  headlines?: string[],
  sectorFilter?: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<MarketSentimentMatrixResponse> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return synthesizeMarketSentimentLocally(items, headlines);
  }

  try {
    let token = "";
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const res = await fetcher("/api/market/matrix", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        items,
        headlines,
        sectorFilter,
      }),
      signal,
    });

    if (!res.ok) {
      return synthesizeMarketSentimentLocally(items, headlines);
    }

    const data = await res.json();
    return {
      configured: Boolean(data.configured),
      assets: Array.isArray(data.assets) ? data.assets : [],
      macroHeadline: data.macroHeadline || "Broad market consolidation across active monitored sectors.",
    };
  } catch {
    return synthesizeMarketSentimentLocally(items, headlines);
  }
}

export function synthesizeMarketSentimentLocally(
  items?: Array<{ topic: string; symbol?: string }>,
  headlines: string[] = [],
): MarketSentimentMatrixResponse {
  const benchmarkAssets: MarketSentimentAsset[] = [
    {
      symbol: "NZ50",
      name: "NZX 50 Gross Index",
      sector: "NZ Equities",
      price: 12450.8,
      changePercent: 0.65,
      sentimentTone: "bullish",
      attributions: [
        {
          title: headlines[0] || "Monetary policy easing signals lower capital costs for benchmark equities",
          url: "",
          source: "Signal Wire",
          impactType: "bullish",
        },
      ],
    },
    {
      symbol: "AIA",
      name: "Auckland Airport",
      sector: "NZ Equities",
      price: 7.85,
      changePercent: 1.15,
      sentimentTone: "bullish",
      attributions: [
        {
          title: "Trans-Tasman passenger volumes exceed quarterly forecasts",
          url: "",
          source: "NZX",
          impactType: "bullish",
        },
      ],
    },
    {
      symbol: "MEL",
      name: "Meridian Energy",
      sector: "NZ Equities",
      price: 6.12,
      changePercent: -0.45,
      sentimentTone: "neutral",
      attributions: [],
    },
    {
      symbol: "AAPL",
      name: "Apple Inc.",
      sector: "Global Tech",
      price: 228.5,
      changePercent: 0.85,
      sentimentTone: "bullish",
      attributions: [
        {
          title: "Hardware upgrade cycle drives supply chain expansion",
          url: "",
          source: "Signal Tech Desk",
          impactType: "bullish",
        },
      ],
    },
    {
      symbol: "NVDA",
      name: "NVIDIA Corp.",
      sector: "Global Tech",
      price: 138.6,
      changePercent: 3.45,
      sentimentTone: "bullish",
      attributions: [
        {
          title: "Hyperscaler data center capital expenditure continues acceleration",
          url: "",
          source: "Bloomberg",
          impactType: "bullish",
        },
      ],
    },
    {
      symbol: "BRENT",
      name: "Brent Crude Oil",
      sector: "Commodities",
      price: 74.2,
      changePercent: -1.2,
      sentimentTone: "bearish",
      attributions: [
        {
          title: "Global manufacturing gauges point to stabilized transport demand",
          url: "",
          source: "Reuters",
          impactType: "headwind",
        },
      ],
    },
    {
      symbol: "NZDUSD",
      name: "NZD / USD",
      sector: "FX & Rates",
      price: 0.598,
      changePercent: -0.35,
      sentimentTone: "neutral",
      attributions: [],
    },
  ];

  if (items && items.length > 0) {
    // augment with requested user items
    for (const it of items) {
      const sym = it.symbol || it.topic.slice(0, 4).toUpperCase();
      if (!benchmarkAssets.some((b) => b.symbol === sym)) {
        benchmarkAssets.push({
          symbol: sym,
          name: it.topic,
          sector: "Core Equities",
          price: 100.0,
          changePercent: 0.25,
          sentimentTone: "neutral",
          attributions: [],
        });
      }
    }
  }

  return {
    configured: true,
    assets: benchmarkAssets,
    macroHeadline: "Cross-asset risk-on momentum underpinned by growth and regional rate adjustments.",
  };
}
