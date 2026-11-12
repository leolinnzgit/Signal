export type ExtractedOpenReaderArticle = {
  finalUrl: string;
  byline: string;
  siteName: string;
  publishedAt: string;
  paragraphs: string[];
};

export type OpenCoverageArticle = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  snippet: string;
  readerArticle: ExtractedOpenReaderArticle;
};

export type OpenCoverageResponse = {
  available: boolean;
  queryUsed?: string;
  message: string;
  articles: OpenCoverageArticle[];
};

export type OpenCoverageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; queryUsed: string; message: string; articles: OpenCoverageArticle[] }
  | { status: "empty"; queryUsed: string; message: string }
  | { status: "error"; message: string };

export function isPaywallReason(reason?: string | null, paywalled?: boolean): boolean {
  if (paywalled) return true;
  if (!reason) return false;
  return /subscription|subscriber|publisher login|paywall/i.test(reason);
}

export async function fetchOpenCoverage(
  request: { url: string; title: string; source?: string },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OpenCoverageResponse> {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) {
    throw new Error("Could not verify your session to search open news sources.");
  }
  const { token } = (await csrf.json()) as { token?: string };
  if (!token) {
    throw new Error("Could not verify your session to search open news sources.");
  }

  const response = await fetcher("/api/article-reader/open-coverage", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
    body: JSON.stringify({
      url: request.url,
      title: request.title,
      source: request.source ?? "",
    }),
    cache: "no-store",
    signal,
  });

  let payload: Partial<OpenCoverageResponse> | null = null;
  try {
    payload = await response.json() as Partial<OpenCoverageResponse>;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.message || "Could not search open news sources right now.");
  }

  return {
    available: Boolean(payload?.available),
    queryUsed: typeof payload?.queryUsed === "string" ? payload.queryUsed : "",
    message: typeof payload?.message === "string"
      ? payload.message
      : "No readable open coverage was found for this headline yet.",
    articles: Array.isArray(payload?.articles) ? payload.articles : [],
  };
}
