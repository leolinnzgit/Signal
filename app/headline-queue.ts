type HeadlineArticle = { title: string; url: string; isRead?: boolean };

function headlineKey(title: string) {
  return title.normalize("NFKC").toLowerCase()
    .replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ").trim()
    .replace(/[.!?。！？]+$/u, "").trim();
}

function storyUrlKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const name of Array.from(url.searchParams.keys())) {
      if (/^utm_/i.test(name) || /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi)$/i.test(name)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch { return value.trim(); }
}

export function createUnreadHeadlineQueue<T extends HeadlineArticle>(articles: T[]) {
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
  const queue: T[] = [];
  const duplicates = new Map<string, T[]>();
  for (const group of groups.values()) {
    if (group.some((article) => article.isRead)) continue;
    queue.push(group[0]);
    duplicates.set(group[0].url, group);
  }
  return { articles: queue, duplicates };
}
