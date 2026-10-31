export type ArticleImageCaptionResponse = {
  available: boolean;
  reason: string;
  caption: string;
  confidence: number;
  denseCaptions: string[];
  width: number;
  height: number;
};

const captionCache = new Map<string, ArticleImageCaptionResponse>();

/** Clears the in-memory caption cache (useful in tests). */
export function clearCaptionCache(): void {
  captionCache.clear();
}

/**
 * Loads an AI-generated description for a news photo using Azure AI Vision.
 * Results are cached in memory.
 */
export async function loadArticleImageCaption(
  imageUrl: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ArticleImageCaptionResponse> {
  const cleanUrl = imageUrl.trim();
  if (!cleanUrl) {
    return { available: false, reason: "No image URL provided.", caption: "", confidence: 0, denseCaptions: [], width: 0, height: 0 };
  }

  const cached = captionCache.get(cleanUrl);
  if (cached) return cached;

  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!csrf.ok) throw new Error("Could not acquire security token.");
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) throw new Error("Security token missing.");

    const response = await fetcher("/api/article-image-caption", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
      body: JSON.stringify({ imageUrl: cleanUrl }),
    });

    if (!response.ok) {
      throw new Error("Azure image analysis is currently unavailable.");
    }

    const data = (await response.json()) as ArticleImageCaptionResponse;
    if (data.available && data.caption) {
      captionCache.set(cleanUrl, data);
    }
    return data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load image caption.";
    return {
      available: false,
      reason: message,
      caption: "",
      confidence: 0,
      denseCaptions: [],
      width: 0,
      height: 0,
    };
  }
}
