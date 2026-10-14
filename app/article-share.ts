export type ArticleShareData = {
  title: string;
  text: string;
  url: string;
};

type ArticleShareTarget = {
  share?: (data: ArticleShareData) => Promise<void>;
  clipboard?: {
    writeText: (value: string) => Promise<void>;
  };
};

export type ArticleShareResult = "shared" | "copied" | "cancelled" | "failed";

type ArticleUrlResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type ArticleUrlFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<ArticleUrlResponse>;

export type ArticleShareSnapshot = {
  title: string;
  paragraphs: string[];
  language: string;
  byline: string;
};

export async function createHostedArticleShare(
  article: { url: string; title: string; source: string; summary: string },
  snapshot?: ArticleShareSnapshot,
  fetcher: ArticleUrlFetcher = fetch,
): Promise<{ path: string; title: string; language: string; summaryOnly: boolean }> {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
  if (!csrf.ok) throw new Error("Sign in again to create a shared story.");
  const auth = await csrf.json() as { token?: string };
  if (!auth?.token) throw new Error("Sign in again to create a shared story.");
  const response = await fetcher("/api/article-shares", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": auth.token },
    body: JSON.stringify({ url: article.url, title: article.title, source: article.source,
      summary: article.summary, snapshot }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(error?.error || "Signal could not save this story for sharing. Please try again.");
  }
  const data = await response.json() as { path?: string; title?: string; language?: string; summaryOnly?: boolean };
  if (!data || typeof data.path !== "string" || !/^\/shared\/[a-f0-9]{48}$/.test(data.path)
    || typeof data.title !== "string" || !data.title.trim() || typeof data.language !== "string"
    || typeof data.summaryOnly !== "boolean")
    throw new Error("Signal returned an incomplete story link. Please try again.");
  return { path: data.path, title: data.title, language: data.language, summaryOnly: data.summaryOnly };
}

const resolvedArticleUrls = new Map<string, string>();

export async function resolveArticleShareUrl(
  storedUrl: string,
  fetcher: ArticleUrlFetcher = fetch,
  timeoutMs = 2_500,
): Promise<string> {
  const cached = resolvedArticleUrls.get(storedUrl);
  if (cached) return cached;

  const controller = typeof AbortController === "function"
    ? new AbortController()
    : undefined;
  const timeout = controller && timeoutMs > 0
    ? globalThis.setTimeout(() => controller.abort(), timeoutMs)
    : undefined;

  try {
    const query = new URLSearchParams({ url: storedUrl });
    const response = await fetcher(`/api/article-reader/resolve?${query}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller?.signal,
    });
    if (!response.ok) return storedUrl;

    const payload = await response.json();
    if (!payload || typeof payload !== "object" || !("url" in payload)) return storedUrl;
    const resolvedUrl = (payload as { url?: unknown }).url;
    if (typeof resolvedUrl !== "string") return storedUrl;

    const parsed = new URL(resolvedUrl);
    if (parsed.protocol !== "https:") return storedUrl;
    resolvedArticleUrls.set(storedUrl, parsed.href);
    return parsed.href;
  } catch {
    return storedUrl;
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

export async function shareArticle(
  data: ArticleShareData,
  target: ArticleShareTarget = navigator,
): Promise<ArticleShareResult> {
  if (typeof target.share === "function") {
    try {
      await target.share(data);
      return "shared";
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return "cancelled";
      }
    }
  }

  if (typeof target.clipboard?.writeText === "function") {
    try {
      await target.clipboard.writeText(data.url);
      return "copied";
    } catch {
      // The caller can show a useful error when clipboard access is unavailable.
    }
  }

  return "failed";
}
