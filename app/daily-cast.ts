/**
 * Signal Studio Daily Cast (Autonomous 2-Host AI Executive Podcast) Client Engine
 * Orchestrates multi-speaker dialogue sequencing, Azure Neural Studio multi-voice synthesis,
 * chapter markers, and executive podcast transcripts.
 */

export interface CastPreset {
  id: string;
  title: string;
  category: string;
  description: string;
}

export interface CastDialogTurn {
  turnIndex: number;
  speaker: "david" | "sarah";
  speakerName: string;
  speakerRole: string;
  avatarEmoji: string;
  text: string;
  durationSeconds: number;
}

export interface CastChapter {
  timestampSeconds: number;
  title: string;
}

export interface DailyCastResponse {
  episodeId: string;
  episodeTitle: string;
  showNotes: string;
  totalDurationSeconds: number;
  chapters: CastChapter[];
  dialogTurns: CastDialogTurn[];
  synthesizedAt: string;
  liveArticleCount?: number;
  neuralAudioAvailable?: boolean;
}

export interface DailyCastAudioStatus {
  neuralAvailable: boolean;
  requiresAuth: boolean;
  authenticated: boolean;
}

export interface DailyCastAudioResult {
  blob: Blob;
  starts: number[];
  engine: string;
}

/**
 * Returns distinct audio synthesis voice parameters per host
 */
export function getHostVoiceParams(speaker: "david" | "sarah"): {
  pitch: number;
  rate: number;
  accentColor: string;
} {
  if (speaker === "david") {
    // Deeper, measured macro tone
    return { pitch: 0.92, rate: 1.02, accentColor: "#38bdf8" };
  }
  // Clear, energetic tech tone
  return { pitch: 1.15, rate: 1.05, accentColor: "#a855f7" };
}

/**
 * Computes which dialogue turn index corresponds to an audio timestamp in seconds.
 */
export function resolveTurnIndexAtTime(currentTimeSeconds: number, starts: number[]): number {
  if (!starts || starts.length === 0) return 0;
  let active = 0;
  for (let i = 0; i < starts.length; i++) {
    if (currentTimeSeconds + 0.05 >= starts[i]) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Formats full podcast show notes and script for export
 */
export function formatPodcastShowNotes(cast: DailyCastResponse): string {
  const date = new Date().toUTCString();
  return `# SIGNAL DAILY CAST: ${cast.episodeTitle.toUpperCase()}
Recorded & Synthesized: ${date}
Total Duration: ${Math.round(cast.totalDurationSeconds)}s
Co-Hosts: David Vance (Chief Macro Strategist) & Sarah Chen (Geopolitical & Deep Tech Lead)

## Executive Summary & Show Notes
${cast.showNotes}

## Chapter Timestamps
${cast.chapters
  .map(
    (c) =>
      `- [${Math.floor(c.timestampSeconds / 60)}:${String(Math.floor(c.timestampSeconds % 60)).padStart(2, "0")}] ${c.title}`
  )
  .join("\n")}

## Verbatim Podcast Transcript
${cast.dialogTurns
  .map(
    (t) => `**${t.speakerName.toUpperCase()}** (${t.speakerRole}):
"${t.text}"`
  )
  .join("\n\n")}

---
CONFIDENTIAL - SIGNAL STUDIO BROADCAST INTELLIGENCE`;
}

/**
 * Client API fetchers
 */
export async function fetchDailyCastEpisodes(fetcher: typeof fetch = fetch): Promise<CastPreset[]> {
  const res = await fetcher("/api/daily-cast/episodes", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load episodes: HTTP ${res.status}`);
  return res.json();
}

export async function fetchDailyCastAudioStatus(
  fetcher: typeof fetch = fetch,
): Promise<DailyCastAudioStatus> {
  try {
    const res = await fetcher("/api/daily-cast/audio-status", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return { neuralAvailable: false, requiresAuth: true, authenticated: false };
    }
    return (await res.json()) as DailyCastAudioStatus;
  } catch {
    return { neuralAvailable: false, requiresAuth: true, authenticated: false };
  }
}

export async function synthesizeDailyCast(
  episodeTopic: string,
  articles?: Array<{ title: string; source: string; summary?: string }>,
  fetcher: typeof fetch = fetch,
): Promise<DailyCastResponse> {
  const res = await fetcher("/api/daily-cast/synthesize", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      episodeTopic,
      articles: articles ?? [],
    }),
  });
  if (!res.ok) throw new Error(`Failed to synthesize cast: HTTP ${res.status}`);
  return res.json();
}

export async function synthesizeDailyCastAudio(
  dialogTurns: CastDialogTurn[],
  gapMs = 350,
  fetcher: typeof fetch = fetch,
): Promise<DailyCastAudioResult> {
  let csrfToken: string | undefined;
  try {
    const csrfRes = await fetcher("/api/auth/csrf", { credentials: "same-origin" });
    if (csrfRes.ok) {
      const csrfJson = (await csrfRes.json()) as { token?: string };
      csrfToken = csrfJson.token;
    }
  } catch {
    // Proceed cleanly; server decides auth/antiforgery status
  }

  const res = await fetcher("/api/daily-cast/audio", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/wav, application/json",
      ...(csrfToken ? { "X-XSRF-TOKEN": csrfToken } : {}),
    },
    body: JSON.stringify({
      dialogTurns: dialogTurns.map((t) => ({ speaker: t.speaker, text: t.text })),
      gapMs,
    }),
  });

  if (!res.ok) {
    throw new Error(`Studio neural audio unavailable: HTTP ${res.status}`);
  }

  let starts: number[] = [];
  const rawStarts = res.headers.get("X-Signal-Cast-Starts");
  if (rawStarts) {
    try {
      const parsed = JSON.parse(rawStarts);
      if (Array.isArray(parsed)) starts = parsed.map((n) => Number(n) || 0);
    } catch {
      starts = [];
    }
  }

  return {
    blob: await res.blob(),
    starts,
    engine: res.headers.get("X-Signal-Cast-Engine") || "azure-neural",
  };
}
