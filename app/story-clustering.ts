import type { FollowedArticle } from "./NewsDashboard.tsx";
import { resolveArticleSentiment, type SentimentKind } from "./article-sentiment.ts";

export type StoryCluster = {
  id: string;
  leadArticle: FollowedArticle;
  articles: FollowedArticle[];
  sources: string[];
  dominantTone: SentimentKind;
  toneBreakdown: Record<SentimentKind, number>;
};

export type ClusteredStoryFeedItem = {
  article: FollowedArticle;
  cluster?: StoryCluster;
};

export type ClusterSynthesisResult = {
  available: boolean;
  source: "azure" | "local";
  reason: string;
  paragraphs: string[];
  sourceCount: number;
};

const NEWS_STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
  "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most",
  "my", "myself", "new", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other",
  "our", "ours", "ourselves", "out", "over", "own", "said", "same", "say", "says", "she", "should",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves", "then",
  "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will",
  "with", "would", "you", "your", "yours", "yourself", "yourselves", "amid", "amidst", "first",
]);

/**
 * Extracts significant tokens and numbers from a headline for content similarity matching.
 */
export function extractContentTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  if (!title) return tokens;

  // Expand common news synonyms/acronyms to align cross-publisher reporting
  let normalized = title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\brbnz\b/g, "reserve bank rbnz")
    .replace(/\bfed\b/g, "federal reserve fed");

  // Keep decimal points in numbers (e.g. 4.25%), replace other periods with space
  normalized = normalized.replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  normalized = normalized.replace(/[^a-z0-9.%$€£¥-]/g, " ");

  for (const part of normalized.split(/\s+/)) {
    const trimmed = part.replace(/^[-.]+|[-.]+$/g, "").trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (NEWS_STOPWORDS.has(trimmed)) continue;

    // Stem common trailing plurals/inflections: "cuts" -> "cut"
    if (trimmed.endsWith("s") && trimmed.length > 3 && !trimmed.endsWith("ss") && !trimmed.endsWith("bps")) {
      tokens.add(trimmed.slice(0, -1));
    }
    tokens.add(trimmed);
  }

  return tokens;
}

/**
 * Computes Jaccard similarity between two sets of tokens.
 */
export function computeJaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const item of setA) {
    if (setB.has(item)) shared++;
  }
  const union = setA.size + setB.size - shared;
  return union > 0 ? shared / union : 0;
}

/**
 * Determines whether two articles are reporting on the same event based on
 * headline content token overlap and publication recency (within 48 hours).
 */
export function areArticlesSimilar(
  a: { title: string; publishedAt?: string },
  b: { title: string; publishedAt?: string },
): boolean {
  if (!a.title || !b.title) return false;

  // Check publication timestamp window if both are valid
  if (a.publishedAt && b.publishedAt) {
    const timeA = new Date(a.publishedAt).getTime();
    const timeB = new Date(b.publishedAt).getTime();
    if (!isNaN(timeA) && !isNaN(timeB)) {
      const diffHours = Math.abs(timeA - timeB) / (1000 * 60 * 60);
      if (diffHours > 60) return false;
    }
  }

  const tokensA = extractContentTokens(a.title);
  const tokensB = extractContentTokens(b.title);
  if (tokensA.size === 0 || tokensB.size === 0) return false;

  let sharedCount = 0;
  let hasSharedNumber = false;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      sharedCount++;
      if (/\d/.test(token)) {
        hasSharedNumber = true;
      }
    }
  }

  const jaccard = computeJaccardSimilarity(tokensA, tokensB);

  // High word overlap (e.g. 35%+ token match)
  if (jaccard >= 0.35) return true;

  // Moderate overlap with specific numbers/data points (e.g. 4.25%, 50bps, 7.1)
  if (jaccard >= 0.14 && hasSharedNumber && sharedCount >= 2) return true;

  // 3 or more substantial shared content words
  if (sharedCount >= 3) return true;

  return false;
}

/**
 * Groups related articles reporting on the same breaking story into multi-source clusters.
 * The earliest or lead article stays in its natural feed position with a cluster badge,
 * while duplicate/cross-publisher angles are grouped under it.
 */
export function clusterArticles(articles: readonly FollowedArticle[]): ClusteredStoryFeedItem[] {
  if (!articles || articles.length === 0) return [];

  const clusters: StoryCluster[] = [];
  const assignedCluster = new Map<string, StoryCluster>();

  // Cluster assignment pass
  for (const article of articles) {
    if (!article.url || assignedCluster.has(article.url)) continue;

    let matchedCluster: StoryCluster | undefined;
    for (const cluster of clusters) {
      if (cluster.articles.some((existing) => areArticlesSimilar(existing, article))) {
        matchedCluster = cluster;
        break;
      }
    }

    if (matchedCluster) {
      matchedCluster.articles.push(article);
      if (!matchedCluster.sources.includes(article.source)) {
        matchedCluster.sources.push(article.source);
      }
      assignedCluster.set(article.url, matchedCluster);
    } else {
      const newCluster: StoryCluster = {
        id: `cluster-${article.url}`,
        leadArticle: article,
        articles: [article],
        sources: [article.source],
        dominantTone: "neutral",
        toneBreakdown: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
      };
      clusters.push(newCluster);
      assignedCluster.set(article.url, newCluster);
    }
  }

  // Calculate sentiment distribution for multi-article clusters
  for (const cluster of clusters) {
    if (cluster.articles.length > 1) {
      const breakdown: Record<SentimentKind, number> = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
      for (const art of cluster.articles) {
        const sent = resolveArticleSentiment(art);
        breakdown[sent.sentiment] = (breakdown[sent.sentiment] || 0) + 1;
      }
      cluster.toneBreakdown = breakdown;

      let dominant: SentimentKind = "neutral";
      let highestCount = breakdown.neutral;
      for (const kind of ["positive", "negative", "mixed"] as SentimentKind[]) {
        if (breakdown[kind] > highestCount) {
          dominant = kind;
          highestCount = breakdown[kind];
        }
      }
      cluster.dominantTone = dominant;
    }
  }

  // Construct feed items: only emit the lead article for clusters with >= 2 articles
  const items: ClusteredStoryFeedItem[] = [];
  const emittedClusterIds = new Set<string>();

  for (const article of articles) {
    const cluster = assignedCluster.get(article.url);
    if (!cluster || cluster.articles.length <= 1) {
      items.push({ article });
      continue;
    }

    if (!emittedClusterIds.has(cluster.id)) {
      emittedClusterIds.add(cluster.id);
      items.push({
        article: cluster.leadArticle,
        cluster,
      });
    }
  }

  return items;
}

/**
 * Cleanly extracts the first sentence of an article summary or headline.
 */
function cleanFirstSentence(text: string): string {
  if (!text) return "";
  const match = text.trim().match(/^([^.?!]+[.?!])/);
  return match ? match[1].trim() : text.trim();
}

/**
 * Fast, deterministic client-side synthesis of multi-source coverage.
 * Generates an executive comparison highlighting consensus and distinct publisher angles
 * without requiring any external cloud calls.
 */
export function synthesizeClusterLocally(articles: readonly FollowedArticle[]): string[] {
  if (!articles || articles.length === 0) return [];

  const uniqueSources = Array.from(new Set(articles.map((a) => a.source))).filter(Boolean);
  const sourcesText =
    uniqueSources.length === 2
      ? `${uniqueSources[0]} and ${uniqueSources[1]}`
      : uniqueSources.length > 2
        ? `${uniqueSources.slice(0, -1).join(", ")}, and ${uniqueSources[uniqueSources.length - 1]}`
        : uniqueSources[0] || "multiple publishers";

  const lead = articles[0];
  const leadHeadline = cleanFirstSentence(lead.title);
  const leadExcerpt = cleanFirstSentence(lead.summary || "");

  const sentences: string[] = [
    `Coverage from ${sourcesText} reports on: ${leadHeadline}.${leadExcerpt ? ` ${leadExcerpt}` : ""}`,
  ];

  // Highlight distinct angles or details from secondary sources
  for (let i = 1; i < Math.min(articles.length, 4); i++) {
    const sec = articles[i];
    const secHeadline = cleanFirstSentence(sec.title);
    const secExcerpt = cleanFirstSentence(sec.summary || "");

    if (sec.source !== lead.source) {
      if (secExcerpt && !leadExcerpt.includes(secExcerpt.slice(0, 20))) {
        sentences.push(`${sec.source} highlights that ${secExcerpt.charAt(0).toLowerCase() + secExcerpt.slice(1)}`);
      } else if (secHeadline && !leadHeadline.includes(secHeadline.slice(0, 20))) {
        sentences.push(`${sec.source} notes: "${secHeadline}".`);
      }
    }
  }

  return [sentences.join(" ")];
}

const synthesisCache = new Map<string, ClusterSynthesisResult>();

/**
 * Loads cross-publisher synthesis for a story cluster:
 * 1. Calls Signal's Azure AI Language synthesis endpoint (`POST /api/story-cluster/synthesize`).
 * 2. Automatically falls back to deterministic local multi-source synthesis if Azure is unconfigured
 *    or offline, ensuring instant comparison on any device.
 */
export async function loadClusterSynthesis(
  articles: readonly FollowedArticle[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ClusterSynthesisResult> {
  if (!articles || articles.length < 2) {
    return {
      available: false,
      source: "local",
      reason: "At least two sources are required to compare coverage.",
      paragraphs: [],
      sourceCount: articles?.length || 0,
    };
  }

  const cacheKey = articles
    .map((a) => a.url)
    .sort()
    .join("::");

  const cached = synthesisCache.get(cacheKey);
  if (cached) return cached;

  const distinctSources = Array.from(new Set(articles.map((a) => a.source))).length;

  try {
    const csrf = await fetcher("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });

    if (!csrf.ok) throw new Error("Security token missing");
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) throw new Error("Security token missing");

    const payload = {
      articles: articles.slice(0, 6).map((a) => ({
        url: a.url,
        title: a.title,
        source: a.source,
        summary: a.summary || "",
      })),
    };

    const response = await fetcher("/api/story-cluster/synthesize", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": token,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        available: boolean;
        reason: string;
        paragraphs: string[];
        sourceCount: number;
      };

      if (data.available && data.paragraphs && data.paragraphs.length > 0) {
        const result: ClusterSynthesisResult = {
          available: true,
          source: "azure",
          reason: "",
          paragraphs: data.paragraphs,
          sourceCount: data.sourceCount || distinctSources,
        };
        synthesisCache.set(cacheKey, result);
        return result;
      }
    }
  } catch {
    // Cloud synthesis failed or unconfigured -> fall back to local extractive synthesis cleanly
  }

  const localParagraphs = synthesizeClusterLocally(articles);
  const fallbackResult: ClusterSynthesisResult = {
    available: true,
    source: "local",
    reason: "",
    paragraphs: localParagraphs,
    sourceCount: distinctSources,
  };
  synthesisCache.set(cacheKey, fallbackResult);
  return fallbackResult;
}
