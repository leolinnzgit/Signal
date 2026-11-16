export interface SignalBotArticleInput {
  url: string;
  title: string;
  source: string;
  summary: string;
  publishedAt?: string;
  topics?: string[];
}

export interface SignalBotHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SignalBotCitation {
  index: number;
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  summary: string;
}

export interface SignalBotMarketSnapshot {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: number;
  change: number;
  percentChange: number;
  quoteTime: string;
}

export interface SignalBotStatusResponse {
  available: boolean;
  provider: string;
  model: string;
  availableModels: string[];
}

export type SignalBotSentiment = "bullish" | "bearish" | "mixed" | "neutral" | "urgent";

export interface SignalBotAnalyzeRequest {
  topic: string;
  prompt?: string;
  articles?: SignalBotArticleInput[];
  history?: SignalBotHistoryTurn[];
  tickerOverride?: string;
  language?: string;
  includeLiveSearch?: boolean;
  model?: string;
}

export interface SharedSignalBotAnalysisRequest {
  topic: string;
  userPrompt?: string;
  headline: string;
  analysis: string;
  keyDrivers?: string[];
  perspectives?: string[];
  watchNext?: string[];
  sentiment?: SignalBotSentiment | string;
  citations?: SignalBotCitation[];
  marketQuote?: SignalBotMarketSnapshot | null;
  model?: string;
  language?: string;
  coverageNote?: string;
}

export interface SharedSignalBotAnalysisResponse {
  id: string;
  path: string;
  headline: string;
  topic: string;
  model: string;
  language: string;
  createdAtUtc: string;
}

export interface SignalBotAnalyzeResponse {
  available: boolean;
  topic: string;
  headline: string;
  analysis: string;
  keyDrivers: string[];
  perspectives: string[];
  watchNext: string[];
  sentiment: SignalBotSentiment;
  suggestedFollowUps: string[];
  citations: SignalBotCitation[];
  marketQuote: SignalBotMarketSnapshot | null;
  model: string;
  language: string;
  analyzedAt: string;
  coverageNote: string;
}

export interface SignalBotPreset {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

export const SIGNAL_BOT_PRESETS: readonly SignalBotPreset[] = [
  {
    id: "overview",
    label: "Deep Overview",
    icon: "🧭",
    prompt: "Analyze what is happening right now with this topic, the main drivers, and why it matters.",
  },
  {
    id: "changes",
    label: "What Changed",
    icon: "⚡",
    prompt: "Identify the newest developments, turning points, and momentum shifts in recent coverage.",
  },
  {
    id: "risks",
    label: "Risks & Angles",
    icon: "⚖️",
    prompt: "Compare competing viewpoints, key risks, and who stands to gain or lose.",
  },
  {
    id: "watch-next",
    label: "Watch Next",
    icon: "🔭",
    prompt: "Outline the concrete catalysts, policy decisions, or signals to watch next.",
  },
];

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeSignalBotArticles(
  articles: ReadonlyArray<{
    url?: string;
    title?: string;
    source?: string;
    summary?: string;
    publishedAt?: string;
    topics?: string[];
  }>,
  topic: string,
  maxArticles = 40,
): SignalBotArticleInput[] {
  const normalizedTopic = topic.trim().toLowerCase();
  const isSpecificTopic = normalizedTopic.length > 0
    && normalizedTopic !== "all"
    && normalizedTopic !== "all topics"
    && normalizedTopic !== "all followed topics";

  const seen = new Set<string>();
  const matched: SignalBotArticleInput[] = [];
  const other: SignalBotArticleInput[] = [];

  for (const raw of articles) {
    const title = (raw.title ?? "").trim();
    const url = (raw.url ?? "").trim();
    if (!title || !url || !isSafeHttpUrl(url)) continue;

    const dedupeKey = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const summary = (raw.summary ?? "").trim().slice(0, 600);
    const topics = Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === "string" && t.trim()) : [];
    const entry: SignalBotArticleInput = {
      url,
      title: title.slice(0, 240),
      source: (raw.source ?? "").trim().slice(0, 100),
      summary,
      publishedAt: (raw.publishedAt ?? "").trim(),
      topics,
    };

    if (isSpecificTopic) {
      const topicHit = topics.some((t) => t.trim().toLowerCase() === normalizedTopic)
        || `${title} ${summary}`.toLowerCase().includes(normalizedTopic);
      if (topicHit) {
        matched.push(entry);
      } else {
        other.push(entry);
      }
    } else {
      matched.push(entry);
    }
  }

  return [...matched, ...other].slice(0, maxArticles);
}

const SIGNAL_BOT_MODEL_STORAGE_KEY = "signal:signal-bot-model:v1";

export function getModelDisplayLabel(model: string): string {
  const clean = (model || "").trim();
  if (!clean) return "Microsoft Foundry";
  if (clean.toLowerCase() === "gpt-6.1-sol") return "GPT-6.1 Sol";
  if (clean.toLowerCase() === "gpt-5-mini") return "GPT-5 mini";
  if (clean.toLowerCase() === "gpt-4.1-mini") return "GPT-4.1 mini";
  return clean;
}

export function loadPreferredSignalBotModel(): string {
  try {
    if (typeof window === "undefined" || !window.localStorage) return "";
    return (window.localStorage.getItem(SIGNAL_BOT_MODEL_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function savePreferredSignalBotModel(model: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const clean = model.trim();
    if (clean) {
      window.localStorage.setItem(SIGNAL_BOT_MODEL_STORAGE_KEY, clean);
    } else {
      window.localStorage.removeItem(SIGNAL_BOT_MODEL_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

export function resolveSelectedSignalBotModel(
  status: SignalBotStatusResponse | null,
  preferredModel: string,
): string {
  if (!status || !status.available) return "";
  const available = status.availableModels.length > 0
    ? status.availableModels
    : status.model
      ? [status.model]
      : [];
  if (available.length === 0) return status.model || "";
  const match = available.find((m) => m.toLowerCase() === preferredModel.trim().toLowerCase());
  return match || status.model || available[0] || "";
}

async function postWithCsrf<TResponse>(
  url: string,
  body: unknown,
  fallbackError: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TResponse> {
  const csrf = await fetcher("/api/auth/csrf", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!csrf.ok) {
    throw new Error("Sign in again to use Signal Bot.");
  }

  const csrfData = (await csrf.json()) as { token?: string };
  if (!csrfData.token) {
    throw new Error("Sign in again to use Signal Bot.");
  }

  const response = await fetcher(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": csrfData.token,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let serverError = "";
    try {
      const payload = (await response.json()) as { error?: string };
      if (typeof payload.error === "string") serverError = payload.error.trim();
    } catch {
      // Ignore non-JSON error payloads.
    }

    if (serverError) {
      throw new Error(serverError);
    }
    if (response.status === 401) {
      throw new Error("Sign in again to use Signal Bot.");
    }
    if (response.status === 429) {
      throw new Error("Too many Signal Bot requests. Please wait a moment and try again.");
    }
    throw new Error(fallbackError);
  }

  return (await response.json()) as TResponse;
}

export async function fetchSignalBotStatus(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SignalBotStatusResponse> {
  const response = await fetcher("/api/signal-bot/status", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Sign in again to check Signal Bot availability.");
    }
    throw new Error("Could not check Signal Bot availability.");
  }

  const data = (await response.json()) as Partial<SignalBotStatusResponse>;
  const model = typeof data.model === "string" ? data.model.trim() : "";
  const rawModels = Array.isArray(data.availableModels)
    ? data.availableModels.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim())
    : [];
  const availableModels = Array.from(new Set(rawModels.length > 0 ? rawModels : model ? [model] : []));

  return {
    available: Boolean(data.available),
    provider: typeof data.provider === "string" && data.provider.trim() ? data.provider : "Microsoft Foundry",
    model,
    availableModels,
  };
}

export async function analyzeNewsTopicWithSignalBot(
  request: SignalBotAnalyzeRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SignalBotAnalyzeResponse> {
  const result = await postWithCsrf<SignalBotAnalyzeResponse>(
    "/api/signal-bot/analyze",
    request,
    "Signal Bot could not analyze that topic right now.",
    signal,
    fetcher,
  );

  if (!result || typeof result.analysis !== "string" || !result.analysis.trim()) {
    throw new Error("Signal Bot returned an incomplete analysis. Please try again.");
  }

  return {
    ...result,
    keyDrivers: Array.isArray(result.keyDrivers) ? result.keyDrivers : [],
    perspectives: Array.isArray(result.perspectives) ? result.perspectives : [],
    watchNext: Array.isArray(result.watchNext) ? result.watchNext : [],
    suggestedFollowUps: Array.isArray(result.suggestedFollowUps) ? result.suggestedFollowUps : [],
    citations: Array.isArray(result.citations) ? result.citations : [],
  };
}

export async function createHostedSignalBotShare(
  request: SharedSignalBotAnalysisRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SharedSignalBotAnalysisResponse> {
  if (!request || typeof request.analysis !== "string" || !request.analysis.trim()) {
    throw new Error("Analysis content is required to share.");
  }

  const result = await postWithCsrf<SharedSignalBotAnalysisResponse>(
    "/api/signal-bot/shares",
    request,
    "Could not create a hosted share link right now.",
    signal,
    fetcher,
  );

  if (!result || typeof result.id !== "string" || !result.id.trim() || typeof result.path !== "string" || !result.path.trim()) {
    throw new Error("Signal returned an incomplete share link. Please try again.");
  }

  return result;
}

export function sentimentBadgeMeta(sentiment: string): { label: string; toneClass: string } {
  switch ((sentiment || "").toLowerCase()) {
    case "bullish":
      return { label: "Constructive / Bullish", toneClass: "sentiment-bullish" };
    case "bearish":
      return { label: "Cautious / Bearish", toneClass: "sentiment-bearish" };
    case "urgent":
      return { label: "Developing / Urgent", toneClass: "sentiment-urgent" };
    case "mixed":
      return { label: "Mixed Signals", toneClass: "sentiment-mixed" };
    default:
      return { label: "Balanced / Neutral", toneClass: "sentiment-neutral" };
  }
}

export function formatSignalBotMarkdown(result: SignalBotAnalyzeResponse): string {
  const lines: string[] = [
    `# Signal Bot: ${result.topic}`,
    `## ${result.headline}`,
    `*Sentiment: ${sentimentBadgeMeta(result.sentiment).label} • Model: ${result.model || "Microsoft Foundry"}*`,
  ];

  if (result.coverageNote) {
    lines.push(`*${result.coverageNote}*`);
  }

  if (result.marketQuote) {
    const q = result.marketQuote;
    const sign = q.change >= 0 ? "+" : "";
    lines.push(
      `\n**Market Snapshot:** ${q.name} (${q.symbol}) — ${q.currency} ${q.price.toFixed(2)} (${sign}${q.change.toFixed(2)}, ${sign}${q.percentChange.toFixed(2)}%)`,
    );
  }

  lines.push(`\n${result.analysis}`);

  if (result.keyDrivers.length > 0) {
    lines.push("\n### Key Drivers");
    for (const driver of result.keyDrivers) {
      lines.push(`- ${driver}`);
    }
  }

  if (result.perspectives.length > 0) {
    lines.push("\n### Perspectives & Risks");
    for (const item of result.perspectives) {
      lines.push(`- ${item}`);
    }
  }

  if (result.watchNext.length > 0) {
    lines.push("\n### Watch Next");
    for (const next of result.watchNext) {
      lines.push(`- ${next}`);
    }
  }

  if (result.citations.length > 0) {
    lines.push("\n### Grounded Sources");
    for (const cite of result.citations) {
      lines.push(`[S${cite.index}] [${cite.title}](${cite.url}) — ${cite.source || "Publisher"}`);
    }
  }

  return lines.join("\n");
}
