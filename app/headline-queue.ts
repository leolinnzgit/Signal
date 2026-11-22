import { extractContentTokens } from "./story-clustering.ts";

type HeadlineArticle = { title: string; url: string; publishedAt?: string; isRead?: boolean };

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

const MAX_REPEAT_GAP_MS = 36 * 60 * 60 * 1000;
const CHANGE_TERMS = [
  /\b(?:ris(?:e[sn]?|ing)|rose|rais(?:e[sd]?|ing)|hik(?:e[sd]?|ing)|lift(?:s|ed|ing)?|increas(?:e[sd]?|ing)|gain(?:s|ed)?|up)\b/i,
  /\b(?:falls?|fell|fallen|cut(?:s|ting)?|lower(?:s|ed|ing)?|decreas(?:e[sd]?|ing)|drop(?:s|ped|ping)?|down)\b/i,
  /\b(?:holds?|held|unchanged|steady|paus(?:e[sd]?|ing))\b/i,
  /\b(?:approv(?:e[sd]?|ing)|accept(?:s|ed|ing)?|pass(?:es|ed|ing)?)\b/i,
  /\b(?:reject(?:s|ed|ing)?|den(?:y|ies|ied|ying)|fail(?:s|ed|ing)?)\b/i,
  /\b(?:no|not|never|without)\b|n['’]t\b/i,
];

function audioHeadlineSignature(article: HeadlineArticle) {
  const date = Date.parse(article.publishedAt ?? "");
  const tokens = extractContentTokens(article.title);
  // The visual clusterer retains stems and plurals. Count a word only once
  // here so a single shared phrase cannot look like several shared facts.
  const words = new Set([...tokens].filter((token) =>
    !/\d/.test(token) && !(token.endsWith("s") && tokens.has(token.slice(0, -1)))));
  const figures = [...new Set((article.title.normalize("NFKC").replace(/[−–]/g, "-")
        .match(/[+\-]?(?:[$€£¥]\s*)?\d+(?:[.,]\d+)*%?/g) ?? [])
    .map((figure) => figure.replace(/[,\s]/g, "")))].sort().join("|");
  const changes = CHANGE_TERMS.map((pattern) => pattern.test(article.title)).join("|");
  return { date, words, figures, changes };
}

function isAudioRepeat(a: ReturnType<typeof audioHeadlineSignature>, b: ReturnType<typeof audioHeadlineSignature>) {
  if (!Number.isFinite(a.date) || !Number.isFinite(b.date) || Math.abs(a.date - b.date) > MAX_REPEAT_GAP_MS
    || a.figures !== b.figures || a.changes !== b.changes) return false;
  const shared = [...a.words].filter((word) => b.words.has(word)).length;
  return shared >= 4 && shared / (a.words.size + b.words.size - shared) >= 0.55;
}

function groupNarrationStories<T extends HeadlineArticle>(articles: readonly T[]) {
  const groups: { copies: T[]; isRead: boolean; signature: ReturnType<typeof audioHeadlineSignature> }[] = [];
  const wordToGroup = new Map<string, number[]>();
  for (const copies of groupHeadlineArticles(articles)) {
    const signature = audioHeadlineSignature(copies[0]);
    const isRead = copies.some((copy) => copy.isRead);
    const candidates = new Set<number>();
    if (Number.isFinite(signature.date) && signature.words.size >= 4) {
      for (const word of signature.words) {
        for (const group of wordToGroup.get(word) ?? []) candidates.add(group);
      }
    }
    const match = [...candidates].sort((a, b) => a - b)
      .find((index) => isAudioRepeat(groups[index].signature, signature));
    if (match !== undefined) {
      groups[match].isRead ||= isRead;
      continue;
    }

    // Approximate matches affect playback only. The lead and its exact
    // aliases keep their normal read tracking, and cannot bridge two events.
    const index = groups.push({ copies, isRead, signature }) - 1;
    if (!Number.isFinite(signature.date) || signature.words.size < 4) continue;
    for (const word of signature.words) {
      const bucket = wordToGroup.get(word) ?? [];
      bucket.push(index);
      wordToGroup.set(word, bucket);
    }
  }
  return groups;
}

export function uniqueNarrationStories<T extends HeadlineArticle>(articles: readonly T[]): T[] {
  return groupNarrationStories(articles).map(({ copies }) => copies[0]);
}

export function createUnreadHeadlineQueue<T extends HeadlineArticle>(articles: T[]) {
  const queue: T[] = [];
  const duplicates = new Map<string, T[]>();
  for (const { copies: group, isRead } of groupNarrationStories(articles)) {
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
) {
  const groups = groupNarrationStories(articles);
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
