import { getChatGPTUser } from "../../chatgpt-auth";

const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const MAX_FEED_BYTES = 1_500_000;

type ProviderKey = "google" | "gdelt" | "rss";

type ParsedArticle = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
  matchedTopics?: string[];
};

function decodeXml(value: string) {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (match) => entities[match] ?? match)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripHtml(value: string) {
  return decodeXml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(item: string, name: string) {
  const escapedName = name.replace(":", "\\:");
  const match = item.match(new RegExp(`<${escapedName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function attribute(item: string, tagName: string, attributeName: string) {
  const match = item.match(new RegExp(`<${tagName}\\b[^>]*\\b${attributeName}=["']([^"']+)["'][^>]*>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function toIsoDate(value: string) {
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const normalized = compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseGoogleFeed(xml: string, limit: number): ParsedArticle[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.slice(0, limit).map((item) => {
    const rawTitle = stripHtml(tag(item, "title"));
    const source = stripHtml(tag(item, "source")) || rawTitle.split(" - ").at(-1) || "News source";
    const suffix = ` - ${source}`;
    return {
      title: rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle,
      url: tag(item, "link"),
      source,
      publishedAt: toIsoDate(tag(item, "pubDate")),
      summary: "",
    };
  });
}

function topicMatches(article: ParsedArticle, topic: string) {
  const searchable = `${article.title} ${article.summary}`.toLowerCase();
  const phrase = topic.toLowerCase();
  if (searchable.includes(phrase)) return true;
  const usefulWords = phrase.split(/\W+/).filter((word) => word.length > 2);
  return usefulWords.length === 0 || usefulWords.some((word) => searchable.includes(word));
}

function parsePublisherFeed(xml: string, feedUrl: string, topic: string, limit: number) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const channel = xml.match(/<channel\b[\s\S]*?<\/channel>/i)?.[0] ?? xml;
  const feedTitle = stripHtml(tag(channel, "title"));
  const fallbackSource = feedTitle || new URL(feedUrl).hostname.replace(/^www\./, "");

  return blocks
    .slice(0, 100)
    .map((item): ParsedArticle => {
      const title = stripHtml(tag(item, "title"));
      const url = tag(item, "link") || attribute(item, "link", "href") || tag(item, "guid");
      const summary = stripHtml(tag(item, "description") || tag(item, "summary") || tag(item, "content:encoded")).slice(0, 240);
      return {
        title,
        url,
        source: stripHtml(tag(item, "source")) || fallbackSource,
        publishedAt: toIsoDate(tag(item, "pubDate") || tag(item, "published") || tag(item, "updated")),
        summary,
      };
    })
    .filter((article) => article.title && article.url && topicMatches(article, topic))
    .slice(0, limit);
}

function validateFeedUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const forbiddenName = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan");
  const isIpAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");

  if (url.protocol !== "https:" || url.username || url.password || forbiddenName || isIpAddress) {
    throw new Error("Publisher feeds must use a public HTTPS domain.");
  }
  if (url.port && url.port !== "443") {
    throw new Error("Publisher feeds must use the standard HTTPS port.");
  }
  return url;
}

async function fetchPublisherFeed(feedUrl: string) {
  let current = validateFeedUrl(feedUrl);

  for (let redirectCount = 0; redirectCount < 3; redirectCount += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9",
        "User-Agent": "Signal News Monitor/1.0",
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Publisher feed redirected without a destination.");
      current = validateFeedUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) throw new Error(`Publisher feed returned ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > MAX_FEED_BYTES) throw new Error("Publisher feed is too large.");
    const xml = await response.text();
    if (xml.length > MAX_FEED_BYTES) throw new Error("Publisher feed is too large.");
    return { xml, finalUrl: current.toString() };
  }

  throw new Error("Publisher feed redirected too many times.");
}

async function getGoogleNews(topic: string, limit: number) {
  const query = new URLSearchParams({ q: `\"${topic}\" when:7d`, hl: "en-NZ", gl: "NZ", ceid: "NZ:en" });
  const response = await fetch(`${GOOGLE_NEWS_RSS}?${query.toString()}`, {
    headers: { "User-Agent": "Signal News Monitor/1.0" },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) throw new Error(`Google News returned ${response.status}.`);
  return { articles: parseGoogleFeed(await response.text(), limit), provider: "Google News" };
}

async function getGdeltNews(topics: string[], limit: number) {
  const query = new URLSearchParams({
    query: topics.map((topic) => `\"${topic}\"`).join(" OR "),
    mode: "ArtList",
    maxrecords: String(Math.min(250, Math.max(50, limit * topics.length * 3))),
    format: "json",
    sort: "DateDesc",
    timespan: "1week",
  });
  const response = await fetch(`${GDELT_DOC_API}?${query.toString()}`, {
    headers: { "User-Agent": "Signal News Monitor/1.0" },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) throw new Error(`GDELT returned ${response.status}.`);

  const responseText = await response.text();
  if (!responseText.trim().startsWith("{")) throw new Error("GDELT is currently rate limited.");
  const payload = JSON.parse(responseText) as {
    articles?: Array<{ title?: string; url?: string; domain?: string; seendate?: string }>;
  };
  const articles = (payload.articles ?? [])
    .filter((article) => article.title && article.url)
    .map((article): ParsedArticle => ({
      title: stripHtml(article.title ?? ""),
      url: article.url ?? "",
      source: article.domain?.replace(/^www\./, "") || new URL(article.url ?? "https://gdeltproject.org").hostname,
      publishedAt: toIsoDate(article.seendate ?? ""),
      summary: "",
    }))
    .map((article) => ({ ...article, matchedTopics: topics.filter((topic) => topicMatches(article, topic)) }))
    .filter((article) => article.matchedTopics.length > 0);
  return { articles, provider: "GDELT" };
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) {
    return Response.json(
      { error: "Sign in with ChatGPT to use Signal." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const { searchParams } = new URL(request.url);
  const topic = (searchParams.get("topic") ?? "Artificial intelligence").trim().slice(0, 80);
  const topics = searchParams.getAll("topic").map((value) => value.trim().slice(0, 80)).filter(Boolean);
  const limit = Math.min(10, Math.max(1, Number(searchParams.get("limit")) || 6));
  const provider = (searchParams.get("provider") ?? "google") as ProviderKey;

  if (!topic) return Response.json({ error: "Choose a topic to follow." }, { status: 400 });
  if (!["google", "gdelt", "rss"].includes(provider)) {
    return Response.json({ error: "Unknown news provider." }, { status: 400 });
  }

  try {
    let result: { articles: ParsedArticle[]; provider: string };
    if (provider === "google") {
      result = await getGoogleNews(topic, limit);
    } else if (provider === "gdelt") {
      result = await getGdeltNews(topics.length > 0 ? topics : [topic], limit);
    } else {
      const feed = searchParams.get("feed") ?? "";
      const { xml, finalUrl } = await fetchPublisherFeed(feed);
      const articles = parsePublisherFeed(xml, finalUrl, topic, limit);
      const sourceName = articles[0]?.source || new URL(finalUrl).hostname.replace(/^www\./, "");
      result = { articles, provider: `RSS / ${sourceName}` };
    }

    return Response.json(
      { topic, ...result, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "private, max-age=120" } },
    );
  } catch (error) {
    console.error("News fetch failed", error);
    const message = error instanceof Error && error.message.includes("Publisher feed")
      ? error.message
      : "This news source is temporarily unavailable.";
    return Response.json({ error: message }, { status: 502 });
  }
}
