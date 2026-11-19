export type ArticleSummary = { available: boolean; reason: string; paragraphs: string[] };

export function formatArticleSummaryText(paragraphs: readonly string[]): string {
  return paragraphs.map((text) => text.trim()).filter(Boolean).join("\n\n");
}

export async function copyArticleSummary(
  paragraphs: readonly string[],
  clipboard?: { writeText: (text: string) => Promise<void> } | null,
): Promise<boolean> {
  const text = formatArticleSummaryText(paragraphs);
  if (!text) return false;
  const target = clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (typeof target?.writeText !== "function") return false;
  try {
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function loadArticleSummary(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ArticleSummary> {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) throw new Error("Sign in again to prepare an article summary.");
  const { token } = await csrf.json() as { token?: string };
  if (!token) throw new Error("Sign in again to prepare an article summary.");
  const response = await fetcher("/api/article-summary", {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error(response.status === 429
    ? "Too many summary requests. Please try again shortly." : "The article summary could not be prepared. Please try again.");
  const data = await response.json() as ArticleSummary;
  if (!Array.isArray(data.paragraphs) || data.paragraphs.some((text) => typeof text !== "string")
    || (data.available && !data.paragraphs.some((text) => text.trim())))
    throw new Error("The article summary was incomplete. Please try again.");
  return data;
}
