import type { TimelineMilestone } from "./daily-briefing-timeline";

export interface DossierPerspective {
  publisher: string;
  primaryFocus: string;
  framingTone: string;
}

export interface DossierRiskItem {
  category: string;
  description: string;
  severity: "Elevated" | "Moderate" | "Medium" | string;
}

export interface DossierArticleInput {
  url: string;
  title: string;
  source: string;
  summary?: string;
}

export interface ClusterDossierResponse {
  available: boolean;
  topic: string;
  executiveSummary: string;
  perspectives: DossierPerspective[];
  risks: DossierRiskItem[];
  milestones: TimelineMilestone[];
  citedSources: string[];
}

export async function compileExecutiveDossier(
  topic: string,
  articles: DossierArticleInput[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ClusterDossierResponse> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return synthesizeDossierLocally(topic, articles);
  }

  try {
    let token = "";
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const res = await fetcher("/api/story-cluster/dossier", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        topic,
        articles: articles.slice(0, 8),
      }),
      signal,
    });

    if (!res.ok) {
      return synthesizeDossierLocally(topic, articles);
    }

    const data = await res.json();
    return {
      available: Boolean(data.available),
      topic: data.topic || topic,
      executiveSummary: data.executiveSummary || "",
      perspectives: Array.isArray(data.perspectives) ? data.perspectives : [],
      risks: Array.isArray(data.risks) ? data.risks : [],
      milestones: Array.isArray(data.milestones) ? data.milestones : [],
      citedSources: Array.isArray(data.citedSources) ? data.citedSources : [],
    };
  } catch {
    return synthesizeDossierLocally(topic, articles);
  }
}

export function synthesizeDossierLocally(
  topic: string,
  articles: DossierArticleInput[],
): ClusterDossierResponse {
  const lead = articles[0] || {
    title: topic,
    source: "Signal Intelligence",
    url: "",
    summary: "Preceding structural buildup and industry developments.",
  };

  const execSummary = articles.length > 1
    ? `Comprehensive intelligence dossier compiling reporting across ${articles.length} news organizations (${Array.from(new Set(articles.map((a) => a.source))).join(", ")}). The developing situation focuses on ${lead.title}, with secondary emphasis on structural consequences, policy constraints, and operational timelines.`
    : `Single-source executive briefing based on reporting by ${lead.source}: "${lead.title}". ${lead.summary || ""}`;

  const perspectives: DossierPerspective[] = articles.map((art, idx) => ({
    publisher: art.source,
    primaryFocus: art.summary ? (art.summary.length > 160 ? art.summary.slice(0, 157) + "..." : art.summary) : art.title,
    framingTone: idx === 0 ? "Direct Catalyst Reporting" : (idx % 2 === 1 ? "Scrutiny & Operational Risks" : "Market & Consumer Response"),
  }));

  const risks: DossierRiskItem[] = [
    {
      category: "Regulatory & Compliance",
      description: `Potential policy scrutiny, reporting disclosures, or legislative amendments regarding ${topic}.`,
      severity: "Elevated",
    },
    {
      category: "Operational Execution",
      description: "Downstream execution delays, supply chain dependencies, and regional deployment friction.",
      severity: "Moderate",
    },
    {
      category: "Market & Capital Exposure",
      description: "Shifts in investor sentiment, capital expenditure revisions, and competitive repositioning.",
      severity: "Medium",
    },
  ];

  const milestones: TimelineMilestone[] = [
    {
      phase: "Past Context",
      dateOrEra: "Preceding Cycle",
      headline: `Historical Precedent: ${topic}`,
      summary: "Foundational events, regulatory reviews, and multi-year positioning that created today's conditions.",
      source: lead.source,
      sourceUrl: lead.url,
    },
    {
      phase: "Today's Catalyst",
      dateOrEra: "Breaking Nexus",
      headline: lead.title,
      summary: lead.summary || "Verified reporting marking a major policy or market inflection point.",
      source: lead.source,
      sourceUrl: lead.url,
    },
    {
      phase: "Forward Milestone",
      dateOrEra: "Next 30-90 Days",
      headline: "Projected Regulatory & Capital Horizon",
      summary: "Key watch items: formal compliance filings, cross-sector peer disclosures, and secondary implementation deadlines.",
      source: "Signal Desk",
      sourceUrl: null,
    },
  ];

  const citedSources = articles.map((a) => `${a.source}: "${a.title}" (${a.url})`);

  return {
    available: true,
    topic,
    executiveSummary: execSummary,
    perspectives,
    risks,
    milestones,
    citedSources,
  };
}

export function formatDossierMarkdown(dossier: ClusterDossierResponse): string {
  let md = `# Signal Executive Dossier: ${dossier.topic}\n\n`;
  md += `## Executive Summary\n${dossier.executiveSummary}\n\n`;

  if (dossier.perspectives.length > 0) {
    md += `## Multi-Publisher Perspectives\n`;
    for (const p of dossier.perspectives) {
      md += `* **${p.publisher}** (${p.framingTone}): ${p.primaryFocus}\n`;
    }
    md += `\n`;
  }

  if (dossier.risks.length > 0) {
    md += `## Strategic & Downstream Risk Matrix\n`;
    for (const r of dossier.risks) {
      md += `* **[${r.severity.toUpperCase()}] ${r.category}**: ${r.description}\n`;
    }
    md += `\n`;
  }

  if (dossier.milestones.length > 0) {
    md += `## Story Evolution Timeline\n`;
    for (const m of dossier.milestones) {
      md += `* **${m.phase}** (${m.dateOrEra}): ${m.headline} — ${m.summary}\n`;
    }
    md += `\n`;
  }

  if (dossier.citedSources.length > 0) {
    md += `## Cited Intelligence Sources\n`;
    for (const src of dossier.citedSources) {
      md += `* ${src}\n`;
    }
  }

  return md;
}

export interface WatchDossierSyncResult {
  success: boolean;
  topic: string;
  syncedAt?: string;
  error?: string;
}

export async function syncDossierToWatch(
  dossier: ClusterDossierResponse,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<WatchDossierSyncResult> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return { success: false, topic: dossier.topic, error: "Network offline. Connect to sync with paired watch." };
  }

  try {
    let token = "";
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const leadMilestone = dossier.milestones.find((m) => m.phase === "Today's Catalyst") || dossier.milestones[0];
    const res = await fetcher("/api/watch/dossier/sync", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        topic: dossier.topic,
        executiveSummary: dossier.executiveSummary,
        catalyst: leadMilestone ? leadMilestone.headline : undefined,
        risks: dossier.risks.map((r) => ({ category: r.category, severity: r.severity, description: r.description })),
        publisherCount: dossier.perspectives.length,
        citedSources: dossier.citedSources,
      }),
      signal,
    });

    if (!res.ok) {
      return { success: false, topic: dossier.topic, error: "Watch sync failed. Try again shortly." };
    }

    const data = await res.json();
    return {
      success: Boolean(data.success),
      topic: data.topic || dossier.topic,
      syncedAt: data.syncedAt || new Date().toISOString(),
    };
  } catch (err) {
    return {
      success: false,
      topic: dossier.topic,
      error: err instanceof Error ? err.message : "Failed syncing to watch.",
    };
  }
}

export interface DossierDigestDispatchOptions {
  destination?: "email" | "webhook" | "both";
  recipientEmail?: string;
  webhookUrl?: string;
}

export interface DossierDigestDispatchResult {
  success: boolean;
  emailSent: boolean;
  webhookSent: boolean;
  message: string;
}

export async function dispatchDossierDigest(
  dossier: ClusterDossierResponse,
  options: DossierDigestDispatchOptions = {},
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DossierDigestDispatchResult> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return {
      success: false,
      emailSent: false,
      webhookSent: false,
      message: "Network offline. Connect to dispatch executive dossier.",
    };
  }

  try {
    let token = "";
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const res = await fetcher("/api/story-cluster/dossier/digest", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        dossier,
        destination: options.destination || "email",
        recipientEmail: options.recipientEmail,
        webhookUrl: options.webhookUrl,
      }),
      signal,
    });

    if (!res.ok) {
      return {
        success: false,
        emailSent: false,
        webhookSent: false,
        message: "Failed to dispatch executive dossier digest.",
      };
    }

    const data = await res.json();
    return {
      success: Boolean(data.success),
      emailSent: Boolean(data.emailSent),
      webhookSent: Boolean(data.webhookSent),
      message: data.message || "Executive dossier digest dispatched.",
    };
  } catch (err) {
    return {
      success: false,
      emailSent: false,
      webhookSent: false,
      message: err instanceof Error ? err.message : "Error dispatching digest.",
    };
  }
}
