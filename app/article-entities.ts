export type RecognizedEntity = {
  text: string;
  category: string;
  subcategory?: string | null;
  confidenceScore: number;
};

export type ArticleEntitiesResponse = {
  available: boolean;
  reason: string;
  entities: RecognizedEntity[];
};

export function getEntityIcon(category: string): string {
  switch (category.toLowerCase()) {
    case "person":
      return "👤";
    case "organization":
      return "🏢";
    case "location":
      return "📍";
    case "product":
      return "📦";
    case "event":
      return "📅";
    case "skill":
      return "💡";
    default:
      return "🏷️";
  }
}

export async function loadArticleEntities(
  url: string,
  title?: string,
  paragraphs?: string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ArticleEntitiesResponse> {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) throw new Error("Sign in again to extract entities.");
  const { token } = (await csrf.json()) as { token?: string };
  if (!token) throw new Error("Sign in again to extract entities.");

  const response = await fetcher("/api/article-entities", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
    body: JSON.stringify({ url, title, paragraphs }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 429
        ? "Too many entity extraction requests. Please try again shortly."
        : "Article entities could not be extracted.",
    );
  }

  const data = (await response.json()) as ArticleEntitiesResponse;
  return data;
}
