import type { SignalArticleLink } from "./article-link.ts";
import { storyUrlKey } from "./headline-queue.ts";
import { areArticlesSimilar, extractContentTokens } from "./story-clustering.ts";

export type CoverageArticle = SignalArticleLink & { publishedAt?: string; summary?: string };

type IndexedCoverageArticle = {
  title: string;
  publisher: string;
  url: string;
  publishedAt: string;
  excerpt: string;
};

function publisherKey(article: CoverageArticle): string {
  const source = article.source.toLowerCase().replace(/[^a-z0-9]/g, "");
  try {
    const url = new URL(article.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    const host = url.hostname.replace(/^(?:www|m|amp)\./, "");
    if (/(^|\.)bbc\.(?:com|co\.uk)$/.test(host) || /^bbc(?:news|world)?$/.test(source)) return "bbc";
    if (/(^|\.)rnz\.co\.nz$/.test(host) || /^(?:rnz|radionewzealand)$/.test(source)) return "rnz";
    return source || host;
  } catch {
    return "";
  }
}

const GENERIC_TERMS = new Set(["live", "news", "report", "reports", "latest", "update", "updates", "world"]);

function hasCoverageContext(anchor: Set<string>, article: CoverageArticle) {
  const words = extractContentTokens(article.title + " " + (article.summary ?? ""));
  let matches = 0;
  for (const token of anchor) {
    if (token.length <= 2 || GENERIC_TERMS.has(token) || /^\d+$/.test(token)
        || (token.endsWith("s") && anchor.has(token.slice(0, -1)))) continue;
    if (words.has(token) && ++matches >= 2) return true;
  }
  return false;
}

export function findCoverageMatches(
  story: CoverageArticle,
  indexed: readonly CoverageArticle[],
  local: readonly CoverageArticle[],
): CoverageArticle[] {
  const seenUrls = new Set([storyUrlKey(story.url)]);
  const seenPublishers = new Set([publisherKey(story)]);
  const headline = extractContentTokens(story.title);
  const candidates = [
    ...indexed.filter((article) => hasCoverageContext(headline, article)),
    ...local.filter((article) => areArticlesSimilar(story, article)),
  ];
  const matches: CoverageArticle[] = [];
  for (const article of candidates) {
    const publisher = publisherKey(article);
    const key = storyUrlKey(article.url);
    if (!publisher || !article.title.trim() || seenPublishers.has(publisher) || seenUrls.has(key)) continue;
    seenPublishers.add(publisher);
    seenUrls.add(key);
    matches.push(article);
    if (matches.length === 5) break;
  }
  return matches;
}

export async function fetchMoreCoverage(
  story: CoverageArticle, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<CoverageArticle[]> {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) return [];
  const { token } = await csrf.json() as { token?: string };
  if (!token) return [];

  const date = Date.parse(story.publishedAt ?? "");
  const response = await fetcher("/api/article-reader/more-coverage", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
    body: JSON.stringify({
      url: story.url,
      title: [...story.title.trim()].slice(0, 250).join(""),
      summary: [...(story.summary ?? "").trim()].slice(0, 400).join(""),
      publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
    }),
    signal,
  });
  if (!response.ok) return [];
  const { articles } = await response.json() as { articles?: IndexedCoverageArticle[] };
  return (articles ?? []).map(({ title, publisher, url, publishedAt, excerpt }) => ({
    title, source: publisher, url, publishedAt, summary: excerpt,
  }));
}
