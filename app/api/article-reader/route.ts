import { getChatGPTUser } from "../../chatgpt-auth";

const MAXIMUM_ARTICLE_BYTES = 2_000_000;
const MAXIMUM_PARAGRAPHS = 80;
const MAXIMUM_TEXT_LENGTH = 30_000;
const MAXIMUM_REDIRECTS = 5;

type StructuredArticle = {
  paragraphs: string[];
  byline: string;
  siteName: string;
  publishedAt: string;
  isPaywalled: boolean;
};

const PAYWALL_MARKERS = [
  "subscribe to continue",
  "subscription required",
  "sign in to continue reading",
  "log in to continue reading",
  "register to continue reading",
  "this article is for subscribers",
  "exclusive to subscribers",
  "unlock this article",
  "data-paywall",
  'class="paywall',
  "class='paywall",
];

function unavailable(reason: string, status = 200) {
  return Response.json(
    { available: false, reason },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

function validatePublicArticleUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const forbiddenName = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan");
  const isIpAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname.includes(":");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || forbiddenName
    || isIpAddress
    || (url.port && url.port !== "443")
  ) {
    throw new Error("Articles must use a public HTTPS address.");
  }
  return url;
}

function decodeHtml(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&([a-z]+);/gi, (match, entity: string) => entities[entity.toLowerCase()] ?? match)
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function cleanText(value: string) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function namesFromJson(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return [...new Set(value.map(namesFromJson).filter(Boolean))].join(", ");
  }
  if (value && typeof value === "object" && "name" in value) {
    return namesFromJson((value as { name?: unknown }).name);
  }
  return "";
}

function visitJson(value: unknown, visitor: (candidate: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    value.forEach((child) => visitJson(child, visitor));
    return;
  }
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  visitor(candidate);
  Object.values(candidate).forEach((child) => visitJson(child, visitor));
}

function isArticleType(value: unknown) {
  const types = Array.isArray(value) ? value : [value];
  return types.some((type) => typeof type === "string" && /article$/i.test(type));
}

function extractStructuredArticle(html: string): StructuredArticle {
  const best: StructuredArticle = {
    paragraphs: [],
    byline: "",
    siteName: "",
    publishedAt: "",
    isPaywalled: false,
  };
  const blocks = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  for (const match of blocks) {
    try {
      const data = JSON.parse(decodeHtml(match[1].trim())) as unknown;
      visitJson(data, (candidate) => {
        if (!isArticleType(candidate["@type"])) return;
        const accessibility = candidate.isAccessibleForFree;
        if (accessibility === false || (typeof accessibility === "string" && accessibility.toLowerCase() === "false")) {
          best.isPaywalled = true;
        }
        const body = typeof candidate.articleBody === "string" ? cleanText(candidate.articleBody) : "";
        if (body.length > best.paragraphs.join("").length) {
          best.paragraphs = body.length >= 40 ? [body.slice(0, MAXIMUM_TEXT_LENGTH)] : [];
          best.byline = namesFromJson(candidate.author);
          best.siteName = namesFromJson(candidate.publisher);
          best.publishedAt = typeof candidate.datePublished === "string" ? candidate.datePublished.trim() : "";
        }
      });
    } catch {
      // Invalid publisher metadata should not prevent HTML paragraph extraction.
    }
  }
  return best;
}

function extractParagraphs(html: string) {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)]
    .map((match) => match[1])
    .sort((left, right) => right.length - left.length);
  const mains = articles.length > 0
    ? []
    : [...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi)]
        .map((match) => match[1])
        .sort((left, right) => right.length - left.length);
  let content = articles[0] ?? mains[0] ?? html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ");
  content = content.replace(
    /<(nav|header|footer|aside|form|button|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );

  const paragraphs: string[] = [];
  const seen = new Set<string>();
  let textLength = 0;
  for (const match of content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const paragraph = cleanText(match[1]);
    if (paragraph.length < 40 || seen.has(paragraph)) continue;
    if (textLength + paragraph.length > MAXIMUM_TEXT_LENGTH) break;
    seen.add(paragraph);
    paragraphs.push(paragraph);
    textLength += paragraph.length;
    if (paragraphs.length === MAXIMUM_PARAGRAPHS) break;
  }
  return paragraphs;
}

async function readLimitedHtml(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAXIMUM_ARTICLE_BYTES) throw new Error("too-large");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAXIMUM_ARTICLE_BYTES) {
      await reader.cancel();
      throw new Error("too-large");
    }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unavailable("Sign in with ChatGPT to use Signal Reader.", 401);

  let currentUrl: URL;
  try {
    currentUrl = validatePublicArticleUrl(new URL(request.url).searchParams.get("url") ?? "");
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "Choose a valid article.", 400);
  }

  try {
    for (let redirectCount = 0; redirectCount <= MAXIMUM_REDIRECTS; redirectCount += 1) {
      const response = await fetch(currentUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9",
          "User-Agent": "Mozilla/5.0 (compatible; SignalReader/2.0)",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirectCount === MAXIMUM_REDIRECTS) {
          return unavailable("The publisher redirected this story too many times.");
        }
        currentUrl = validatePublicArticleUrl(new URL(location, currentUrl).toString());
        continue;
      }

      if ([401, 402, 403].includes(response.status)) {
        return unavailable("This publisher requires a subscription or direct access.");
      }
      if (!response.ok) {
        return unavailable("The publisher did not make this article available to Signal Reader.");
      }
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("html")) {
        return unavailable("This link is not a readable web article.");
      }

      const html = await readLimitedHtml(response);
      const structured = extractStructuredArticle(html);
      const paragraphs = structured.paragraphs.length > 0
        ? structured.paragraphs
        : extractParagraphs(html);
      const textLength = paragraphs.reduce((total, paragraph) => total + paragraph.length, 0);
      const paywallDetected = structured.isPaywalled
        || PAYWALL_MARKERS.some((marker) => html.toLowerCase().includes(marker));

      if (structured.isPaywalled || (paywallDetected && textLength < 1_200)) {
        return unavailable("This story appears to require a subscription or publisher login.");
      }
      if (paragraphs.length === 0 || textLength < 300) {
        return unavailable("The publisher blocked extraction or did not expose enough readable text.");
      }

      return Response.json(
        {
          available: true,
          reason: "",
          article: {
            finalUrl: currentUrl.toString(),
            byline: structured.byline,
            siteName: structured.siteName,
            publishedAt: structured.publishedAt,
            paragraphs,
          },
        },
        { headers: { "Cache-Control": "private, max-age=1800" } },
      );
    }
  } catch (error) {
    return unavailable(
      error instanceof Error && error.message === "too-large"
        ? "This article is too large for Signal Reader."
        : "The publisher blocked extraction or the article is temporarily unavailable.",
    );
  }

  return unavailable("The publisher did not make this article available to Signal Reader.");
}
