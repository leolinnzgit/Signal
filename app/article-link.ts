export type SignalArticleLink = { url: string; title: string; source: string };

export function parseSignalArticleLink(search: string): SignalArticleLink | null {
  const query = new URLSearchParams(search);
  const value = query.get("article");
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return { url: url.href, title: query.get("title")?.trim().slice(0, 500) || "News story",
      source: query.get("source")?.trim().slice(0, 256) || "Signal community" };
  } catch { return null; }
}

export function signalArticlePath(article: SignalArticleLink): string {
  return `/?${new URLSearchParams({ article: article.url, title: article.title, source: article.source })}`;
}
