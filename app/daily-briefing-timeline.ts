export interface TimelineMilestone {
  phase: "Past Context" | "Today's Catalyst" | "Forward Milestone" | string;
  dateOrEra: string;
  headline: string;
  summary: string;
  source?: string | null;
  sourceUrl?: string | null;
}

export interface ClusterTimelineResponse {
  available: boolean;
  topic: string;
  milestones: TimelineMilestone[];
}

export async function fetchStoryTimeline(
  topic: string,
  articles: Array<{ url?: string; title?: string; source?: string; summary?: string }>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ClusterTimelineResponse> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return synthesizeTimelineLocally(topic, articles);
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

    const res = await fetcher("/api/story-cluster/timeline", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        topic,
        articles: articles.slice(0, 5),
      }),
      signal,
    });

    if (!res.ok) {
      return synthesizeTimelineLocally(topic, articles);
    }

    const data = await res.json();
    return {
      available: Boolean(data.available),
      topic: data.topic || topic,
      milestones: Array.isArray(data.milestones) ? data.milestones : [],
    };
  } catch {
    return synthesizeTimelineLocally(topic, articles);
  }
}

export function synthesizeTimelineLocally(
  topic: string,
  articles: Array<{ url?: string; title?: string; source?: string; summary?: string }>,
): ClusterTimelineResponse {
  const lead = articles[0] || {
    title: topic,
    source: "Signal Intelligence",
    summary: "Preceding structural buildup and industry developments.",
  };

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
      headline: lead.title || topic,
      summary: lead.summary || "Verified ground-level reporting marking a major policy or market inflection point.",
      source: lead.source,
      sourceUrl: lead.url,
    },
  ];

  if (articles.length > 1) {
    milestones.push({
      phase: "Today's Catalyst",
      dateOrEra: "Contrasting Angle",
      headline: articles[1].title || "Secondary Perspective",
      summary: articles[1].summary || "Opposing publisher emphasis highlighting downstream friction and execution risks.",
      source: articles[1].source,
      sourceUrl: articles[1].url,
    });
  }

  milestones.push({
    phase: "Forward Milestone",
    dateOrEra: "Next 30-90 Days",
    headline: "Projected Regulatory & Capital Horizon",
    summary: "Watch items: formal compliance filings, cross-sector peer disclosures, and secondary implementation deadlines.",
    source: "Signal Desk",
    sourceUrl: null,
  });

  return {
    available: true,
    topic,
    milestones,
  };
}
