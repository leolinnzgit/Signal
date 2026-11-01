export interface InterrogateArticleResponse {
  available: boolean;
  question: string;
  answer: string;
  supportingEvidence: string[];
  omittedPerspectives: string[];
  stakeholderImpact: string;
  mode: string;
}

export async function interrogateArticle(
  params: {
    url: string;
    title: string;
    source: string;
    paragraphs?: string[];
    question: string;
    language?: string;
  },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<InterrogateArticleResponse> {
  let token = "";
  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
    if (csrf.ok) {
      const json = await csrf.json();
      token = json?.token || "";
    }
  } catch {}

  const res = await fetcher("/api/article-reader/interrogate", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-XSRF-TOKEN": token } : {}),
    },
    body: JSON.stringify(params),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || "Could not complete socratic interrogation.");
  }

  return await res.json();
}
