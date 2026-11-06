/**
 * Signal Studio Daily Cast (Autonomous 2-Host AI Executive Podcast) Client Engine
 * Orchestrates multi-speaker dialogue sequencing, speech synthesis pitch variance,
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
export async function fetchDailyCastEpisodes(): Promise<CastPreset[]> {
  const res = await fetch("/api/daily-cast/episodes", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load episodes: HTTP ${res.status}`);
  return res.json();
}

export async function synthesizeDailyCast(
  episodeTopic: string,
  articles?: Array<{ title: string; source: string; summary?: string }>
): Promise<DailyCastResponse> {
  const res = await fetch("/api/daily-cast/synthesize", {
    method: "POST",
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
