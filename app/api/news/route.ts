import { getChatGPTUser } from "../../chatgpt-auth";
import { topicMatchesText } from "./topic-matching";

const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const MAX_FEED_BYTES = 1_500_000;
const MIN_DATE_MS = Date.UTC(2000, 0, 1);

type ProviderKey = "google" | "gdelt" | "rss" | "all";

type ParsedArticle = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
  imageUrl: string;
  matchedTopics?: string[];
};

type NewsDateRange = {
  from: Date | null;
  to: Date | null;
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

function parseBoundary(raw: string, name: string, isEndOfDay: boolean): { value?: Date; error?: string } {
  const trimmed = raw.trim();
  if (trimmed.length > 40) {
    return { error: `Use YYYY-MM-DD or an ISO-8601 UTC timestamp for the '${name}' date parameter.` };
  }

  const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const parsed = isEndOfDay
      ? new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
      : new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    if (
      parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day
    ) {
      return { value: parsed };
    }
    return { error: `Use YYYY-MM-DD or an ISO-8601 UTC timestamp for the '${name}' date parameter.` };
  }

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const isoCandidate = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed) && !hasZone
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = new Date(isoCandidate);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `Use YYYY-MM-DD or an ISO-8601 UTC timestamp for the '${name}' date parameter.` };
  }
  return { value: parsed };
}

function parseDateRange(rawFrom: string | null, rawTo: string | null): { range: NewsDateRange | null; error: string | null } {
  const hasFrom = Boolean(rawFrom && rawFrom.trim());
  const hasTo = Boolean(rawTo && rawTo.trim());
  if (!hasFrom && !hasTo) return { range: null, error: null };

  let from: Date | null = null;
  let to: Date | null = null;

  if (hasFrom) {
    const parsed = parseBoundary(rawFrom!, "from", false);
    if (parsed.error || !parsed.value) return { range: null, error: parsed.error ?? "Invalid 'from' date." };
    from = parsed.value;
  }
  if (hasTo) {
    const parsed = parseBoundary(rawTo!, "to", true);
    if (parsed.error || !parsed.value) return { range: null, error: parsed.error ?? "Invalid 'to' date." };
    to = parsed.value;
  }

  if ((from && from.getTime() < MIN_DATE_MS) || (to && to.getTime() < MIN_DATE_MS)) {
    return { range: null, error: "Dates must be on or after 2000-01-01." };
  }
  if (from && from.getTime() > Date.now() + 2 * 86_400_000) {
    return { range: null, error: "The start date (from) cannot be in the future." };
  }
  if (from && to && from.getTime() > to.getTime()) {
    return { range: null, error: "The start date (from) must be earlier than or equal to the end date (to)." };
  }

  return { range: { from, to }, error: null };
}

function inDateRange(publishedAtIso: string, range: NewsDateRange | null) {
  if (!range || (!range.from && !range.to)) return true;
  const time = Date.parse(publishedAtIso);
  if (Number.isNaN(time)) return false;
  if (range.from && time < range.from.getTime()) return false;
  if (range.to && time > range.to.getTime()) return false;
  return true;
}

function formatUtcDay(date: Date, dayDelta: number) {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayDelta));
  return shifted.toISOString().slice(0, 10);
}

function formatGdeltTimestamp(date: Date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function normalizeImageUrl(value: string, baseUrl: string) {
  if (!value.trim()) return "";
  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) return "";
    return url.href;
  } catch {
    return "";
  }
}

function feedImage(item: string, articleUrl: string) {
  const mediaThumbnail = attribute(item, "media:thumbnail", "url");
  const mediaContent = attribute(item, "media:content", "url");
  const enclosure = attribute(item, "enclosure", "url");
  const enclosureType = attribute(item, "enclosure", "type");
  const embeddedHtml = tag(item, "description") || tag(item, "summary") || tag(item, "content:encoded");
  const embeddedImage = embeddedHtml.match(/<img\b[^>]*\b(?:src|data-src)=["']([^"']+)["']/i)?.[1] ?? "";
  const candidates = [
    mediaThumbnail,
    mediaContent,
    enclosureType.toLowerCase().startsWith("image/") ? enclosure : "",
    embeddedImage,
  ];
  return candidates.map((candidate) => normalizeImageUrl(candidate, articleUrl)).find(Boolean) ?? "";
}

function topicMatches(article: ParsedArticle, topic: string) {
  return topicMatchesText(`${article.title} ${article.summary}`, topic);
}

function normalizeUrlKey(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_")
        || lower.startsWith("syn-")
        || ["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "maca", "cmp", "traffic_source", "at_medium", "at_campaign"].includes(lower)
      ) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const search = parsed.searchParams.toString();
    return `${parsed.protocol}//${host}${pathname}${search ? `?${search}` : ""}`.toLowerCase();
  } catch {
    return rawUrl.toLowerCase();
  }
}

function mergeArticles(articles: ParsedArticle[], topics: string[], maxArticles: number) {
  const byUrl = new Map<string, ParsedArticle>();
  for (const article of articles) {
    const key = normalizeUrlKey(article.url);
    const matchedSet = new Set(article.matchedTopics ?? []);
    for (const topic of topics) {
      if (topicMatches(article, topic)) matchedSet.add(topic);
    }
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, {
        ...article,
        matchedTopics: topics.filter((t) => matchedSet.has(t)),
      });
    } else {
      for (const t of existing.matchedTopics ?? []) matchedSet.add(t);
      byUrl.set(key, {
        ...existing,
        url: existing.url.length <= article.url.length ? existing.url : article.url,
        summary: existing.summary || article.summary,
        imageUrl: existing.imageUrl || article.imageUrl,
        matchedTopics: topics.filter((t) => matchedSet.has(t)),
      });
    }
  }
  return Array.from(byUrl.values())
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, maxArticles);
}

function parseGoogleFeed(xml: string, topic: string, limit: number, dateRange: NewsDateRange | null): ParsedArticle[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.map((item) => {
    const rawTitle = stripHtml(tag(item, "title"));
    const source = stripHtml(tag(item, "source")) || rawTitle.split(" - ").at(-1) || "News source";
    const suffix = ` - ${source}`;
    const url = tag(item, "link");
    return {
      title: rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle,
      url,
      source,
      publishedAt: toIsoDate(tag(item, "pubDate")),
      summary: "",
      imageUrl: feedImage(item, url),
      matchedTopics: [topic],
    };
  })
    .filter((article) => topicMatches(article, topic) && inDateRange(article.publishedAt, dateRange))
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, limit);
}

function parsePublisherFeed(xml: string, feedUrl: string, topics: string[], limit: number, dateRange: NewsDateRange | null) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const channel = xml.match(/<channel\b[\s\S]*?<\/channel>/i)?.[0] ?? xml;
  const feedTitle = stripHtml(tag(channel, "title"));
  const fallbackSource = feedTitle || new URL(feedUrl).hostname.replace(/^www\./, "");

  return blocks
    .slice(0, 500)
    .map((item): ParsedArticle => {
      const title = stripHtml(tag(item, "title"));
      const url = tag(item, "link") || attribute(item, "link", "href") || tag(item, "guid");
      const summary = stripHtml(tag(item, "description") || tag(item, "summary") || tag(item, "content:encoded")).slice(0, 240);
      const publishedAt = toIsoDate(tag(item, "pubDate") || tag(item, "published") || tag(item, "updated"));
      const base: ParsedArticle = {
        title,
        url,
        source: stripHtml(tag(item, "source")) || fallbackSource,
        publishedAt,
        summary,
        imageUrl: feedImage(item, url),
      };
      const matchedTopics = topics.filter((topic) => topicMatches(base, topic));
      return { ...base, matchedTopics };
    })
    .filter((article) => article.title && article.url && (article.matchedTopics?.length ?? 0) > 0 && inDateRange(article.publishedAt, dateRange))
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, Math.min(500, limit * topics.length));
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

function buildGoogleDateQuery(topic: string, dateRange: NewsDateRange | null) {
  if (!dateRange || (!dateRange.from && !dateRange.to)) {
    return `\"${topic}\" when:7d`;
  }
  const parts = [`\"${topic}\"`];
  if (dateRange.from) parts.push(`after:${formatUtcDay(dateRange.from, -1)}`);
  if (dateRange.to) parts.push(`before:${formatUtcDay(dateRange.to, 1)}`);
  return parts.join(" ");
}

async function getGoogleNewsSingle(topic: string, limit: number, dateRange: NewsDateRange | null) {
  const query = new URLSearchParams({
    q: buildGoogleDateQuery(topic, dateRange),
    hl: "en-NZ",
    gl: "NZ",
    ceid: "NZ:en",
  });
  const response = await fetch(`${GOOGLE_NEWS_RSS}?${query.toString()}`, {
    headers: { "User-Agent": "Signal News Monitor/1.0" },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) throw new Error(`Google News returned ${response.status}.`);
  return { articles: parseGoogleFeed(await response.text(), topic, limit, dateRange), provider: "Google News" };
}

async function getGoogleNews(topics: string[], limit: number, dateRange: NewsDateRange | null) {
  if (topics.length === 1) return getGoogleNewsSingle(topics[0], limit, dateRange);
  const settled = await Promise.allSettled(topics.map((topic) => getGoogleNewsSingle(topic, limit, dateRange)));
  const fulfilled = settled.filter((item): item is PromiseFulfilledResult<{ articles: ParsedArticle[]; provider: string }> => item.status === "fulfilled");
  if (fulfilled.length === 0) {
    const firstRejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    throw firstRejected?.reason ?? new Error("Google News failed.");
  }
  const articles = mergeArticles(
    fulfilled.flatMap((item) => item.value.articles),
    topics,
    Math.min(500, limit * topics.length),
  );
  return { articles, provider: "Google News" };
}

async function getGdeltNews(topics: string[], limit: number, dateRange: NewsDateRange | null) {
  const params: Record<string, string> = {
    query: topics.map((topic) => `\"${topic}\"`).join(" OR "),
    mode: "ArtList",
    maxrecords: String(Math.min(250, Math.max(50, limit * topics.length * 3))),
    format: "json",
    sort: "DateDesc",
  };
  if (dateRange && (dateRange.from || dateRange.to)) {
    if (dateRange.from) params.startdatetime = formatGdeltTimestamp(dateRange.from);
    if (dateRange.to) params.enddatetime = formatGdeltTimestamp(dateRange.to);
  } else {
    params.timespan = "1week";
  }

  const query = new URLSearchParams(params);
  const response = await fetch(`${GDELT_DOC_API}?${query.toString()}`, {
    headers: { "User-Agent": "Signal News Monitor/1.0" },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) throw new Error(`GDELT returned ${response.status}.`);

  const responseText = await response.text();
  if (!responseText.trim().startsWith("{")) throw new Error("GDELT is currently rate limited.");
  const payload = JSON.parse(responseText) as {
    articles?: Array<{ title?: string; url?: string; domain?: string; seendate?: string; socialimage?: string }>;
  };
  const articles = (payload.articles ?? [])
    .filter((article) => article.title && article.url)
    .map((article): ParsedArticle => ({
      title: stripHtml(article.title ?? ""),
      url: article.url ?? "",
      source: article.domain?.replace(/^www\./, "") || new URL(article.url ?? "https://gdeltproject.org").hostname,
      publishedAt: toIsoDate(article.seendate ?? ""),
      summary: "",
      imageUrl: normalizeImageUrl(article.socialimage ?? "", article.url ?? ""),
    }))
    .filter((article) => inDateRange(article.publishedAt, dateRange))
    .map((article) => ({ ...article, matchedTopics: topics.filter((topic) => topicMatches(article, topic)) }))
    .filter((article) => article.matchedTopics.length > 0)
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, Math.min(500, limit * topics.length));
  return { articles, provider: "GDELT" };
}

async function getCombinedNews(topics: string[], limit: number, dateRange: NewsDateRange | null) {
  const [googleResult, gdeltResult] = await Promise.allSettled([
    getGoogleNews(topics, limit, dateRange),
    getGdeltNews(topics, limit, dateRange),
  ]);
  if (googleResult.status === "rejected" && gdeltResult.status === "rejected") {
    throw googleResult.reason;
  }
  if (googleResult.status === "fulfilled" && gdeltResult.status === "rejected") {
    return googleResult.value;
  }
  if (gdeltResult.status === "fulfilled" && googleResult.status === "rejected") {
    return gdeltResult.value;
  }
  const combined = mergeArticles(
    [
      ...(googleResult as PromiseFulfilledResult<{ articles: ParsedArticle[]; provider: string }>).value.articles,
      ...(gdeltResult as PromiseFulfilledResult<{ articles: ParsedArticle[]; provider: string }>).value.articles,
    ],
    topics,
    Math.min(500, limit * topics.length),
  );
  return { articles: combined, provider: "Google News + GDELT" };
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
  const seenTopics = new Set<string>();
  const topics: string[] = [];
  for (const raw of searchParams.getAll("topic")) {
    const trimmed = raw.trim().slice(0, 80);
    if (!trimmed) continue;
    const lowered = trimmed.toLowerCase();
    if (seenTopics.has(lowered)) continue;
    seenTopics.add(lowered);
    topics.push(trimmed);
    if (topics.length >= 20) break;
  }
  if (topics.length === 0) topics.push("Artificial intelligence");

  const { range: dateRange, error: dateError } = parseDateRange(searchParams.get("from"), searchParams.get("to"));
  if (dateError) {
    return Response.json({ error: dateError }, { status: 400 });
  }

  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit")) || 20));
  const provider = (searchParams.get("provider") ?? "google").trim().toLowerCase() as ProviderKey;

  if (!["google", "gdelt", "rss", "all"].includes(provider)) {
    return Response.json({ error: "Unknown news provider." }, { status: 400 });
  }

  try {
    let result: { articles: ParsedArticle[]; provider: string };
    if (provider === "google") {
      result = await getGoogleNews(topics, limit, dateRange);
    } else if (provider === "gdelt") {
      result = await getGdeltNews(topics, limit, dateRange);
    } else if (provider === "all") {
      result = await getCombinedNews(topics, limit, dateRange);
    } else {
      const feed = searchParams.get("feed") ?? "";
      const { xml, finalUrl } = await fetchPublisherFeed(feed);
      const articles = parsePublisherFeed(xml, finalUrl, topics, limit, dateRange);
      const sourceName = articles[0]?.source || new URL(finalUrl).hostname.replace(/^www\./, "");
      result = { articles, provider: `RSS / ${sourceName}` };
    }

    return Response.json(
      {
        topic: topics[0],
        topics,
        from: dateRange?.from?.toISOString() ?? null,
        to: dateRange?.to?.toISOString() ?? null,
        ...result,
        fetchedAt: new Date().toISOString(),
      },
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
