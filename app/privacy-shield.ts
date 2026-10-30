export type PiiEntity = {
  text: string;
  category: string;
  subcategory?: string | null;
  confidenceScore: number;
  offset: number;
  length: number;
};

export type PiiAnalysisResult = {
  available: boolean;
  reason: string;
  hasPii: boolean;
  redactedText: string;
  entities: PiiEntity[];
};

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}\b/g;
const CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;

/** Client-side regex privacy shield fallback when offline or server is unavailable. */
export function localRedactPii(text: string): PiiAnalysisResult {
  if (!text) return { available: true, reason: "", hasPii: false, redactedText: "", entities: [] };

  const entities: PiiEntity[] = [];
  let redacted = text;

  // Mask cards
  for (const match of redacted.matchAll(CARD_REGEX)) {
    if (match.index !== undefined && match[0].length >= 12) {
      entities.push({
        text: match[0],
        category: "CreditCardNumber",
        confidenceScore: 0.95,
        offset: match.index,
        length: match[0].length,
      });
      redacted = redacted.replace(match[0], "*".repeat(match[0].length));
    }
  }

  // Mask emails
  for (const match of redacted.matchAll(EMAIL_REGEX)) {
    if (match.index !== undefined) {
      entities.push({
        text: match[0],
        category: "Email",
        confidenceScore: 0.98,
        offset: match.index,
        length: match[0].length,
      });
      redacted = redacted.replace(match[0], "*".repeat(match[0].length));
    }
  }

  // Mask phones
  for (const match of redacted.matchAll(PHONE_REGEX)) {
    if (match.index !== undefined) {
      const digits = match[0].replace(/\D/g, "");
      if (digits.length >= 7) {
        entities.push({
          text: match[0],
          category: "PhoneNumber",
          confidenceScore: 0.85,
          offset: match.index,
          length: match[0].length,
        });
        redacted = redacted.replace(match[0], "*".repeat(match[0].length));
      }
    }
  }

  return {
    available: true,
    reason: "Client-side privacy shield applied.",
    hasPii: entities.length > 0,
    redactedText: redacted,
    entities,
  };
}

export async function analyzeAndRedactPii(
  text: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PiiAnalysisResult> {
  const cleanText = text.trim();
  if (!cleanText) {
    return { available: true, reason: "", hasPii: false, redactedText: "", entities: [] };
  }

  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!csrf.ok) return localRedactPii(cleanText);
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) return localRedactPii(cleanText);

    const response = await fetcher("/api/privacy/redact-pii", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
      body: JSON.stringify({ text: cleanText }),
    });

    if (!response.ok) return localRedactPii(cleanText);
    const data = (await response.json()) as PiiAnalysisResult;
    return data;
  } catch {
    return localRedactPii(cleanText);
  }
}
