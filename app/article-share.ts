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
