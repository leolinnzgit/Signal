const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";

type ParsedArticle = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
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
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(value: string) {
  return decodeXml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function parseFeed(xml: string, limit: number): ParsedArticle[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.slice(0, limit).map((item) => {
    const rawTitle = stripHtml(tag(item, "title"));
    const source = stripHtml(tag(item, "source")) || rawTitle.split(" - ").at(-1) || "News source";
    const suffix = ` - ${source}`;
    const title = rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
    return {
      title,
      url: tag(item, "link"),
      source,
      publishedAt: new Date(tag(item, "pubDate")).toISOString(),
      summary: "",
    };
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topic = (searchParams.get("topic") ?? "Artificial intelligence").trim().slice(0, 80);
  const limit = Math.min(10, Math.max(1, Number(searchParams.get("limit")) || 6));

  if (!topic) {
    return Response.json({ error: "Choose a topic to follow." }, { status: 400 });
  }

  const query = new URLSearchParams({ q: `\"${topic}\" when:7d`, hl: "en-NZ", gl: "NZ", ceid: "NZ:en" });

  try {
    const response = await fetch(`${GOOGLE_NEWS_RSS}?${query.toString()}`, {
      headers: { "User-Agent": "Signal News Monitor/1.0" },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);

    if (!response.ok) throw new Error(`News provider returned ${response.status}`);
    const articles = parseFeed(await response.text(), limit);

    return Response.json(
      { topic, articles, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=120, s-maxage=300" } },
    );
  } catch (error) {
    console.error("News fetch failed", error);
    return Response.json(
      { error: "Live news is temporarily unavailable. Please try again shortly." },
      { status: 502 },
    );
  }
}
