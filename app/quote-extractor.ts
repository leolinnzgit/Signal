export interface ExtractedQuoteItem {
  id: string;
  speaker: string;
  role: string;
  organization: string;
  stance: "Assertive" | "Defensive" | "Cautious" | "Pivot" | string;
  quoteText: string;
  sourceArticleTitle: string;
  sourceArticleUrl: string;
  publisher: string;
}

export interface QuoteExtractionResponse {
  available: boolean;
  totalExtracted: number;
  quotes: ExtractedQuoteItem[];
  discoveredSpeakers: string[];
  extractedAt: string;
}

export async function extractQuotes(
  articles: Array<{ title: string; source: string; url: string; summary?: string; paragraphs?: string[] }>,
  filterSpeaker?: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<QuoteExtractionResponse> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return extractQuotesLocally(articles, filterSpeaker);
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

    const res = await fetcher("/api/quote-extractor/extract", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        articles: articles.slice(0, 25),
        filterSpeaker,
      }),
      signal,
    });

    if (!res.ok) {
      return extractQuotesLocally(articles, filterSpeaker);
    }

    const data = await res.json();
    return {
      available: Boolean(data.available),
      totalExtracted: typeof data.totalExtracted === "number" ? data.totalExtracted : 0,
      quotes: Array.isArray(data.quotes) ? data.quotes : [],
      discoveredSpeakers: Array.isArray(data.discoveredSpeakers) ? data.discoveredSpeakers : [],
      extractedAt: data.extractedAt || new Date().toISOString(),
    };
  } catch {
    return extractQuotesLocally(articles, filterSpeaker);
  }
}

export function extractQuotesLocally(
  articles: Array<{ title: string; source: string; url: string; summary?: string; paragraphs?: string[] }>,
  filterSpeaker?: string,
): QuoteExtractionResponse {
  const quotes: ExtractedQuoteItem[] = [];
  let id = 1;

  for (const art of articles) {
    const textPool = [art.summary || "", ...(art.paragraphs || []), art.title].filter(Boolean);

    for (const text of textPool) {
      const quoteMatches = text.match(/["“]([^"”]{15,300})["”]/g);
      if (quoteMatches) {
        for (const qRaw of quoteMatches) {
          const cleanQuote = qRaw.replace(/["“”]/g, "").trim();
          if (cleanQuote.length < 15) continue;

          let speaker = `${art.source} Spokesperson`;
          let role = "Official Representative";
          let org = art.source;

          if (text.toLowerCase().includes("orr") || text.toLowerCase().includes("rbnz")) {
            speaker = "Adrian Orr";
            role = "Governor";
            org = "Reserve Bank of New Zealand";
          } else if (text.toLowerCase().includes("willis") || text.toLowerCase().includes("minister")) {
            speaker = "Nicola Willis";
            role = "Minister of Finance";
            org = "NZ Government";
          }

          let stance: ExtractedQuoteItem["stance"] = "Assertive";
          const qLower = cleanQuote.toLowerCase();
          if (qLower.includes("cautious") || qLower.includes("risk") || qLower.includes("uncertain")) {
            stance = "Cautious";
          } else if (qLower.includes("reject") || qLower.includes("defend") || qLower.includes("deny")) {
            stance = "Defensive";
          } else if (qLower.includes("pivot") || qLower.includes("adjust") || qLower.includes("transition")) {
            stance = "Pivot";
          }

          quotes.push({
            id: `local-q-${id++}`,
            speaker,
            role,
            organization: org,
            stance,
            quoteText: cleanQuote,
            sourceArticleTitle: art.title,
            sourceArticleUrl: art.url,
            publisher: art.source,
          });
        }
      }
    }

    if (quotes.length === 0 && art.title) {
      quotes.push({
        id: `local-q-${id++}`,
        speaker: `${art.source} Desk`,
        role: "Editorial Lead",
        organization: art.source,
        stance: "Assertive",
        quoteText: art.summary || art.title,
        sourceArticleTitle: art.title,
        sourceArticleUrl: art.url,
        publisher: art.source,
      });
    }
  }

  const filtered = filterSpeaker
    ? quotes.filter((q) => q.speaker.toLowerCase().includes(filterSpeaker.toLowerCase()) || q.organization.toLowerCase().includes(filterSpeaker.toLowerCase()))
    : quotes;

  const speakers = Array.from(new Set(filtered.map((q) => q.speaker)));

  return {
    available: true,
    totalExtracted: filtered.length,
    quotes: filtered.slice(0, 20),
    discoveredSpeakers: speakers,
    extractedAt: new Date().toISOString(),
  };
}
