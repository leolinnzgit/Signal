export type ArticleTranslation = { available: boolean; reason: string; title: string; paragraphs: string[]; language: string };

export const translationLanguages = [
  ["en", "English"], ["zh-Hans", "Chinese (Simplified)"], ["zh-Hant", "Chinese (Traditional)"],
  ["ja", "Japanese"], ["ko", "Korean"], ["fr", "French"], ["de", "German"],
  ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"], ["ar", "Arabic"], ["hi", "Hindi"],
] as const;

export async function loadArticleTranslation(url: string, title: string, language: string,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ArticleTranslation> {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) throw new Error("Sign in again to translate an article.");
  const { token } = await csrf.json() as { token?: string };
  if (!token) throw new Error("Sign in again to translate an article.");
  const response = await fetcher("/api/article-translation", {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
    body: JSON.stringify({ url, title, language }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to translate an article."
    : response.status === 429 ? "Too many translation requests. Please try again shortly."
      : "The article could not be translated. Please try again.");
  const data = await response.json() as ArticleTranslation;
  if (typeof data.available !== "boolean" || typeof data.reason !== "string"
    || !Array.isArray(data.paragraphs) || data.paragraphs.some((text) => typeof text !== "string" || !text.trim())
    || (data.available && (typeof data.title !== "string" || !data.title.trim()
      || data.paragraphs.length === 0 || data.language !== language)))
    throw new Error("The article translation was incomplete. Please try again.");
  return data;
}

export type SnippetsTranslationResponse = {
  available: boolean;
  translations: string[];
  language: string;
};

/**
 * Translates short UI text snippets (such as AI image captions and OCR extracted text)
 * into the active reader translation language using Azure Translator.
 */
export async function translateTextSnippets(
  texts: string[],
  language: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SnippetsTranslationResponse> {
  const cleanTexts = (texts || []).filter((t) => typeof t === "string" && t.trim().length > 0);
  if (cleanTexts.length === 0 || !language || language === "en") {
    return { available: true, translations: texts || [], language: language || "en" };
  }

  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!csrf.ok) return { available: false, translations: texts, language };
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) return { available: false, translations: texts, language };

    const response = await fetcher("/api/article-translation/snippets", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
      body: JSON.stringify({ texts: cleanTexts, language }),
    });

    if (!response.ok) {
      return { available: false, translations: texts, language };
    }

    const data = (await response.json()) as {
      available: boolean;
      translations?: string[];
      language?: string;
    };

    return {
      available: Boolean(data.available),
      translations: Array.isArray(data.translations) && data.translations.length === cleanTexts.length
        ? data.translations
        : texts,
      language: data.language || language,
    };
  } catch {
    return { available: false, translations: texts, language };
  }
}
