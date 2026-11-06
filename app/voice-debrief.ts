/**
 * Executive Voice Debrief ("Talk to Signal") Client Module
 * Provides 2-way conversational voice interrogation, preset loading,
 * query processing, speech audio streaming, and text synchronization.
 */

export interface DebriefPreset {
  id: string;
  title: string;
  query: string;
  category: string;
  icon: string;
}

export interface DebriefCitation {
  url: string;
  title: string;
  source: string;
}

export interface DebriefArticlePayload {
  url?: string;
  title?: string;
  source?: string;
  summary?: string;
  topics?: string[];
}

export interface DebriefQueryRequest {
  query: string;
  articles?: DebriefArticlePayload[];
  marketContext?: string;
  voice?: string;
  language?: string;
}

export interface VoiceDebriefResponse {
  available: boolean;
  query: string;
  intentCategory: string;
  spokenScript: string;
  executiveSummary: string;
  keyTakeaways: string[];
  citations: DebriefCitation[];
  suggestedFollowUps: string[];
  audioAvailable: boolean;
  generatedAt: string;
}

export const FALLBACK_PRESETS: DebriefPreset[] = [
  {
    id: "risk-roundup",
    title: "Morning Risk Roundup",
    query: "Summarize the top three high-velocity risk and threat signals this morning.",
    category: "Risk",
    icon: "🛡️",
  },
  {
    id: "semiconductors",
    title: "Semiconductor Nexus",
    query: "What are the latest developments in advanced semiconductor fabrication and export controls?",
    category: "Strategy",
    icon: "⚡",
  },
  {
    id: "market-anomalies",
    title: "Macro & Market Movers",
    query: "What significant market price anomalies and interest rate developments are reported?",
    category: "Markets",
    icon: "📊",
  },
  {
    id: "cyber-threats",
    title: "Critical Cyber & Zero-Day",
    query: "What active cyber incidents, zero-day CVEs, and infrastructure advisories are flagged?",
    category: "Cyber",
    icon: "🚨",
  },
  {
    id: "supply-chokepoints",
    title: "Maritime & Trade Chokepoints",
    query: "Summarize current shipping chokepoint delays across the Red Sea and Pacific trade lanes.",
    category: "Supply Chain",
    icon: "🚢",
  },
];

/**
 * Fetch executive debrief presets.
 */
export async function fetchDebriefPresets(
  fetcher: typeof fetch = fetch,
): Promise<DebriefPreset[]> {
  try {
    const res = await fetcher("/api/voice-debrief/presets", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return FALLBACK_PRESETS;
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data : FALLBACK_PRESETS;
  } catch {
    return FALLBACK_PRESETS;
  }
}

/**
 * Submit voice debrief query to the backend synthesis engine.
 */
export async function sendVoiceDebriefQuery(
  request: DebriefQueryRequest,
  fetcher: typeof fetch = fetch,
): Promise<VoiceDebriefResponse> {
  let token: string | undefined;
  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin" });
    if (csrf.ok) {
      const json = await csrf.json();
      token = json?.token;
    }
  } catch {}

  const res = await fetcher("/api/voice-debrief/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { "X-XSRF-TOKEN": token } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Voice debrief query failed.");
    throw new Error(errText || `Server error: ${res.status}`);
  }

  return (await res.json()) as VoiceDebriefResponse;
}

/**
 * Request neural speech audio (WAV) for a given text.
 */
export async function fetchDebriefAudioBlob(
  text: string,
  voice?: string,
  language = "en-NZ",
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  let token: string | undefined;
  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin" });
    if (csrf.ok) {
      const json = await csrf.json();
      token = json?.token;
    }
  } catch {}

  const res = await fetcher("/api/voice-debrief/speak", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/wav",
      ...(token ? { "X-XSRF-TOKEN": token } : {}),
    },
    body: JSON.stringify({ text, voice, language }),
  });

  if (!res.ok) {
    throw new Error(`Audio synthesis failed with status ${res.status}`);
  }

  return await res.blob();
}

/**
 * Returns distinct styling badge colors for intent categories.
 */
export function getIntentBadgeColor(intent: string): { bg: string; border: string; text: string } {
  const lower = (intent || "").toLowerCase();
  if (lower.includes("risk") || lower.includes("threat") || lower.includes("cyber")) {
    return { bg: "rgba(239, 68, 68, 0.15)", border: "rgba(239, 68, 68, 0.35)", text: "#f87171" };
  }
  if (lower.includes("market") || lower.includes("macro")) {
    return { bg: "rgba(34, 197, 94, 0.15)", border: "rgba(34, 197, 94, 0.35)", text: "#4ade80" };
  }
  if (lower.includes("tech") || lower.includes("silicon")) {
    return { bg: "rgba(56, 189, 248, 0.15)", border: "rgba(56, 189, 248, 0.35)", text: "#38bdf8" };
  }
  if (lower.includes("trade") || lower.includes("geopolitical") || lower.includes("supply")) {
    return { bg: "rgba(245, 158, 11, 0.15)", border: "rgba(245, 158, 11, 0.35)", text: "#fbbf24" };
  }
  return { bg: "rgba(168, 85, 247, 0.15)", border: "rgba(168, 85, 247, 0.35)", text: "#c084fc" };
}

/**
 * Returns appropriate icon for intent categories.
 */
export function getIntentIcon(intent: string): string {
  const lower = (intent || "").toLowerCase();
  if (lower.includes("risk") || lower.includes("threat")) return "🚨";
  if (lower.includes("cyber")) return "⚡";
  if (lower.includes("market") || lower.includes("macro")) return "📊";
  if (lower.includes("tech") || lower.includes("silicon")) return "🔬";
  if (lower.includes("trade") || lower.includes("supply")) return "🚢";
  return "🎙️";
}

/**
 * Split text into individual sentences for karaoke pacing.
 */
export function splitIntoSentences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g);
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Formats a clean clipboard/memo digest of a voice debrief response.
 */
export function formatDebriefDigest(debrief: VoiceDebriefResponse): string {
  const dateStr = new Date(debrief.generatedAt || Date.now()).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines: string[] = [
    `SIGNAL EXECUTIVE VOICE DEBRIEF`,
    `Generated: ${dateStr}`,
    `Inquiry: "${debrief.query}"`,
    `Intent Focus: ${debrief.intentCategory}`,
    ``,
    `EXECUTIVE SUMMARY:`,
    debrief.executiveSummary,
    ``,
    `KEY TAKEAWAYS:`,
    ...debrief.keyTakeaways.map((t, i) => `  ${i + 1}. ${t}`),
    ``,
    `SPOKEN RECORDING TRANSCRIPT:`,
    debrief.spokenScript,
  ];

  if (debrief.citations.length > 0) {
    lines.push(``, `VERIFIED CITATIONS:`);
    for (const c of debrief.citations) {
      lines.push(`  - ${c.title} (${c.source}) [${c.url}]`);
    }
  }

  if (debrief.suggestedFollowUps.length > 0) {
    lines.push(``, `RECOMMENDED FOLLOW-UP INQUIRIES:`);
    for (const f of debrief.suggestedFollowUps) {
      lines.push(`  ? ${f}`);
    }
  }

  return lines.join("\n");
}
