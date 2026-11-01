export type KeywordRules = {
  watchKeywords: string[];
  mutedKeywords: string[];
  noiseCancellationLevel: "off" | "moderate" | "strict";
};

export const DEFAULT_KEYWORD_RULES: KeywordRules = {
  watchKeywords: [],
  mutedKeywords: ["gossip", "celebrity", "rumor", "tabloid"],
  noiseCancellationLevel: "moderate",
};

const LOCAL_STORAGE_KEY = "signal_noise_cancellation_rules";

export function loadLocalKeywordRules(): KeywordRules {
  if (typeof window === "undefined") return DEFAULT_KEYWORD_RULES;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        watchKeywords: Array.isArray(parsed.watchKeywords) ? parsed.watchKeywords : [],
        mutedKeywords: Array.isArray(parsed.mutedKeywords) ? parsed.mutedKeywords : DEFAULT_KEYWORD_RULES.mutedKeywords,
        noiseCancellationLevel: parsed.noiseCancellationLevel || "moderate",
      };
    }
  } catch {
    // Ignore parse error
  }
  return DEFAULT_KEYWORD_RULES;
}

export function saveLocalKeywordRules(rules: KeywordRules): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // Ignore storage error
  }
}

export async function fetchKeywordRules(fetcher: typeof fetch = fetch): Promise<KeywordRules> {
  try {
    const res = await fetcher("/api/preferences/keyword-rules", { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      const rules: KeywordRules = {
        watchKeywords: Array.isArray(data.watchKeywords) ? data.watchKeywords : [],
        mutedKeywords: Array.isArray(data.mutedKeywords) ? data.mutedKeywords : [],
        noiseCancellationLevel: data.noiseCancellationLevel || "moderate",
      };
      saveLocalKeywordRules(rules);
      return rules;
    }
  } catch {
    // Fallback to local
  }
  return loadLocalKeywordRules();
}

export async function syncKeywordRulesToServer(rules: KeywordRules, csrfToken?: string, fetcher: typeof fetch = fetch): Promise<void> {
  saveLocalKeywordRules(rules);
  try {
    let token = csrfToken;
    if (!token) {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin" });
      if (csrf.ok) {
        const body = await csrf.json();
        token = body.token;
      }
    }
    await fetcher("/api/preferences/keyword-rules", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify(rules),
    });
  } catch {
    // Server sync failure handled gracefully
  }
}

export function matchesKeyword(text: string, keyword: string): boolean {
  if (!text || !keyword) return false;
  const kw = keyword.trim().toLowerCase();
  if (!kw) return false;
  return text.toLowerCase().includes(kw);
}

export function isArticleMuted(article: { title?: string; summary?: string }, rules: KeywordRules): boolean {
  if (rules.noiseCancellationLevel === "off") return false;
  const fullText = `${article.title || ""} ${article.summary || ""}`.toLowerCase();
  return rules.mutedKeywords.some((kw) => matchesKeyword(fullText, kw));
}

export function isArticleWatchMatch(article: { title?: string; summary?: string }, rules: KeywordRules): boolean {
  if (!rules.watchKeywords || rules.watchKeywords.length === 0) return false;
  const fullText = `${article.title || ""} ${article.summary || ""}`.toLowerCase();
  return rules.watchKeywords.some((kw) => matchesKeyword(fullText, kw));
}
