type HeadlineArticle = {
  title: string;
  url: string;
  summary?: string;
  publishedAt?: string;
  isRead?: boolean;
  audioThreadId?: string | null;
};

function headlineKey(title: string) {
  return title.normalize("NFKC").toLowerCase()
    .replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ").trim()
    .replace(/[.!?。！？]+$/u, "").trim();
}

function normalizePublisherPath(host: string, pathname: string) {
  if (host === "dw.com") {
    const match = pathname.match(/^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?[^/]+\/(a-\d+)\/?$/i);
    if (match) return match[1] ? `/${match[1].toLowerCase()}/${match[2].toLowerCase()}` : `/${match[2].toLowerCase()}`;
  } else if (host === "channelnewsasia.com") {
    const match = pathname.match(/^\/([^/]+)\/[^/]*-(\d{6,})\/?$/i);
    if (match) return `/${match[1].toLowerCase()}/${match[2]}`;
  } else if (host === "cbc.ca") {
    const match = pathname.match(/^\/news(?:\/[^/]+)+\/[^/]*-(\d+\.\d+)\/?$/i);
    if (match) return `/news/${match[1]}`;
  } else if (host === "abc.net.au") {
    const match = pathname.match(/^\/news\/\d{4}-\d{2}-\d{2}\/[^/]+\/(\d{6,})\/?$/i);
    if (match) return `/news/${match[1]}`;
  } else if (host === "stuff.co.nz") {
    const match = pathname.match(/^\/(?:[^/]+\/)*(\d{8,})\/[^/]+\/?$/i);
    if (match) return `/${match[1]}`;
  }
  return pathname;
}

export function storyUrlKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const name of Array.from(url.searchParams.keys())) {
      if (
        /^(?:utm_|syn-)/i.test(name)
        || /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|maca|cmp|traffic_source|at_medium|at_campaign)$/i.test(name)
      ) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    url.pathname = normalizePublisherPath(url.hostname, url.pathname);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch { return value.trim(); }
}

function groupHeadlineArticles<T extends HeadlineArticle>(articles: readonly T[]) {
  const parents = articles.map((_, index) => index);
  const identities = new Map<string, number>();
  function root(index: number): number {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  articles.forEach((article, index) => {
    const title = headlineKey(article.title);
    const url = storyUrlKey(article.url);
    for (const key of [title && `title:${title}`, url && `url:${url}`].filter(Boolean)) {
      const existing = identities.get(key);
      if (existing === undefined) identities.set(key, index);
      else parents[root(index)] = root(existing);
    }
  });
  // Group before filtering read stories: a read copy should also suppress its
  // unread aliases. Keep the feed order and original objects for read tracking.
  const groups = new Map<number, T[]>();
  articles.forEach((article, index) => {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(article);
    groups.set(key, group);
  });
  return Array.from(groups.values());
}

const MAX_REPEAT_GAP_MS = 60 * 60 * 60 * 1000;
const SUMMARY_SNIPPET_LENGTH = 280;

const STOP_AND_BOILERPLATE_WORDS = new Set([
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
  "united", "state", "states", "government", "minister", "official", "officials", "people",
  "million", "billion", "percent", "world", "global", "local", "today", "week", "month", "year",
  "years", "day", "days", "time", "news", "report", "reports", "latest", "update", "updates",
  "live", "video", "watch", "breaking", "exclusive", "opinion", "analysis", "explained",
]);

const CJK_FILLER_BIGRAMS = new Set([
  "表示", "指出", "報導", "报道", "最新", "新聞", "新闻", "消息", "今日", "今天", "目前", "持續", "持续", "相關", "相关",
]);

function stripPublisherSuffix(title: string): string {
  const cleaned = title.trim().replace(/\s+/g, " ");
  for (const separator of [" - ", " | "]) {
    const index = cleaned.lastIndexOf(separator);
    if (index >= 12 && cleaned.length - index <= 35) {
      return cleaned.slice(0, index).trim();
    }
  }
  return cleaned;
}

function extractThreadTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;

  let normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[−–]/g, "-")
    .replace(/['’]s\b/g, "")
    .replace(/['’]/g, "")
    .replace(/\brbnz\b/g, "reserve bank rbnz")
    .replace(/\bfed\b/g, "federal reserve fed")
    .replace(/\bocr\b/g, "official cash rate ocr");

  normalized = normalized.replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  normalized = normalized.replace(/[^a-z0-9.%$€£¥-]+/g, " ");

  for (const rawPart of normalized.split(/\s+/)) {
    const trimmed = rawPart.replace(/^[-.]+|[-.]+$/g, "");
    if (trimmed.length < 2 || STOP_AND_BOILERPLATE_WORDS.has(trimmed)) continue;

    let canonical = trimmed;
    if (
      canonical.length > 3
      && canonical.endsWith("s")
      && !canonical.endsWith("ss")
      && !canonical.endsWith("bps")
      && /[a-z]/.test(canonical)
    ) {
      canonical = canonical.slice(0, -1);
    }

    if (canonical.length < 2 || STOP_AND_BOILERPLATE_WORDS.has(canonical)) continue;
    tokens.add(canonical);
  }

  return tokens;
}

function extractCjkBigrams(text: string): Set<string> {
  const bigrams = new Set<string>();
  if (!text) return bigrams;

  for (const match of text.matchAll(/[\u4E00-\u9FFF]{2,}/g)) {
    const run = match[0];
    for (let i = 0; i <= run.length - 2; i++) {
      const bigram = run.slice(i, i + 2);
      if (!CJK_FILLER_BIGRAMS.has(bigram)) {
        bigrams.add(bigram);
      }
    }
  }

  return bigrams;
}

function buildCombinedText(cleanTitle: string, summary?: string): string {
  const trimmed = (summary ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return cleanTitle;
  const snippet = trimmed.length > SUMMARY_SNIPPET_LENGTH ? trimmed.slice(0, SUMMARY_SNIPPET_LENGTH) : trimmed;
  return `${cleanTitle} ${snippet}`;
}

type AudioThreadSignature = {
  date: number;
  titleTokens: Set<string>;
  fullTokens: Set<string>;
  cjkTitleBigrams: Set<string>;
  cjkFullBigrams: Set<string>;
  threadId: string | null;
};

function audioHeadlineSignature(article: HeadlineArticle, summaryOverride?: string, threadIdOverride?: string | null): AudioThreadSignature {
  const date = Date.parse(article.publishedAt ?? "");
  const cleanTitle = stripPublisherSuffix(article.title);
  const combined = buildCombinedText(cleanTitle, summaryOverride ?? article.summary);
  const threadId = (threadIdOverride ?? article.audioThreadId ?? "").trim() || null;
  return {
    date,
    titleTokens: extractThreadTokens(cleanTitle),
    fullTokens: extractThreadTokens(combined),
    cjkTitleBigrams: extractCjkBigrams(cleanTitle),
    cjkFullBigrams: extractCjkBigrams(combined),
    threadId,
  };
}

function measureOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size === 0 || right.size === 0) return { shared: 0, overlap: 0, jaccard: 0 };
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) shared++;
  }
  if (shared === 0) return { shared: 0, overlap: 0, jaccard: 0 };
  const overlap = shared / smaller.size;
  const union = left.size + right.size - shared;
  const jaccard = union > 0 ? shared / union : 0;
  return { shared, overlap, jaccard };
}

function isAudioRepeat(a: AudioThreadSignature, b: AudioThreadSignature) {
  if (!Number.isFinite(a.date) || !Number.isFinite(b.date) || Math.abs(a.date - b.date) > MAX_REPEAT_GAP_MS) {
    return false;
  }

  if (a.threadId && b.threadId && a.threadId === b.threadId) {
    return true;
  }

  const title = measureOverlap(a.titleTokens, b.titleTokens);
  if (title.shared >= 3 && (title.overlap >= 0.40 || title.jaccard >= 0.25)) {
    return true;
  }

  const full = measureOverlap(a.fullTokens, b.fullTokens);
  if ((full.shared >= 5 && (full.overlap >= 0.35 || full.jaccard >= 0.22) && title.shared >= 1)
    || (full.shared >= 6 && full.overlap >= 0.42)) {
    return true;
  }

  const cjkTitle = measureOverlap(a.cjkTitleBigrams, b.cjkTitleBigrams);
  if ((cjkTitle.shared >= 3 && cjkTitle.overlap >= 0.33)
    || (cjkTitle.shared >= 2 && cjkTitle.overlap >= 0.50)) {
    return true;
  }

  const cjkFull = measureOverlap(a.cjkFullBigrams, b.cjkFullBigrams);
  return cjkFull.shared >= 5 && cjkFull.overlap >= 0.38 && cjkTitle.shared >= 1;
}

function addIndexBuckets(index: Map<string, number[]>, keys: Iterable<string>, groupIndex: number) {
  for (const key of keys) {
    const bucket = index.get(key) ?? [];
    if (bucket[bucket.length - 1] !== groupIndex) {
      bucket.push(groupIndex);
      index.set(key, bucket);
    }
  }
}

function groupNarrationStories<T extends HeadlineArticle>(
  articles: readonly T[],
  recentlyRead: readonly HeadlineArticle[] = [],
) {
  const recentKeys = new Set<string>();
  const recentSignatures: AudioThreadSignature[] = [];
  for (const item of recentlyRead) {
    if (item.isRead === false) continue;
    const title = headlineKey(item.title);
    const url = storyUrlKey(item.url);
    if (title) recentKeys.add(`title:${title}`);
    if (url) recentKeys.add(`url:${url}`);
    recentSignatures.push(audioHeadlineSignature(item));
  }

  const groups: { copies: T[]; isRead: boolean; signature: AudioThreadSignature }[] = [];
  const tokenToGroup = new Map<string, number[]>();
  const cjkToGroup = new Map<string, number[]>();
  const threadToGroup = new Map<string, number[]>();

  for (const copies of groupHeadlineArticles(articles)) {
    const leadSummary = copies.find((copy) => copy.summary?.trim())?.summary;
    const leadThreadId = copies.find((copy) => copy.audioThreadId?.trim())?.audioThreadId;
    const signature = audioHeadlineSignature(copies[0], leadSummary, leadThreadId);

    let isRead = copies.some((copy) => copy.isRead)
      || copies.some((copy) => {
        const title = headlineKey(copy.title);
        const url = storyUrlKey(copy.url);
        return (title && recentKeys.has(`title:${title}`)) || (url && recentKeys.has(`url:${url}`));
      })
      || recentSignatures.some((recentSig) => isAudioRepeat(recentSig, signature));

    const candidates = new Set<number>();
    if (Number.isFinite(signature.date)) {
      if (signature.threadId) {
        for (const group of threadToGroup.get(signature.threadId) ?? []) candidates.add(group);
      }
      for (const word of signature.fullTokens) {
        for (const group of tokenToGroup.get(word) ?? []) candidates.add(group);
      }
      for (const bigram of signature.cjkFullBigrams) {
        for (const group of cjkToGroup.get(bigram) ?? []) candidates.add(group);
      }
    }

    const match = [...candidates].sort((a, b) => a - b)
      .find((index) => isAudioRepeat(groups[index].signature, signature));
    if (match !== undefined) {
      groups[match].copies.push(...copies);
      groups[match].isRead ||= isRead;
      continue;
    }

    const index = groups.push({ copies: [...copies], isRead, signature }) - 1;
    if (!Number.isFinite(signature.date)) continue;
    if (signature.threadId) addIndexBuckets(threadToGroup, [signature.threadId], index);
    addIndexBuckets(tokenToGroup, signature.fullTokens, index);
    addIndexBuckets(cjkToGroup, signature.cjkFullBigrams, index);
  }
  return groups;
}

export function uniqueNarrationStories<T extends HeadlineArticle>(articles: readonly T[]): T[] {
  return groupNarrationStories(articles).map(({ copies }) => copies[0]);
}

export function createUnreadHeadlineQueue<T extends HeadlineArticle>(
  articles: T[],
  recentlyRead: readonly HeadlineArticle[] = [],
) {
  const queue: T[] = [];
  const duplicates = new Map<string, T[]>();
  for (const { copies: group, isRead } of groupNarrationStories(articles, recentlyRead)) {
    if (isRead) continue;
    queue.push(group[0]);
    for (const copy of group) duplicates.set(copy.url, group);
  }
  return { articles: queue, duplicates };
}

export function shuffleHeadlineArticles<T>(articles: readonly T[], random: () => number = Math.random): T[] {
  const shuffled = [...articles];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const value = random();
    const bounded = Number.isFinite(value) ? Math.min(0.999999999999, Math.max(0, value)) : 0;
    const pick = Math.floor(bounded * (index + 1));
    [shuffled[index], shuffled[pick]] = [shuffled[pick], shuffled[index]];
  }
  if (random === Math.random && shuffled.length > 1 && shuffled.every((item, index) => item === articles[index])) {
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  }
  return shuffled;
}

export function createRandomHeadlineQueue<T extends HeadlineArticle>(
  articles: T[],
  random: () => number = Math.random,
  recentlyRead: readonly HeadlineArticle[] = [],
) {
  const groups = groupNarrationStories(articles, recentlyRead);
  const unreadGroups = groups.filter(({ isRead }) => !isRead);
  const activeGroups = unreadGroups.length > 0 ? unreadGroups : groups;
  const representatives: T[] = [];
  const duplicates = new Map<string, T[]>();
  for (const { copies: group } of activeGroups) {
    representatives.push(group[0]);
    for (const copy of group) duplicates.set(copy.url, group);
  }
  return {
    articles: shuffleHeadlineArticles(representatives, random),
    duplicates,
    includesRead: unreadGroups.length === 0 && activeGroups.length > 0,
  };
}
