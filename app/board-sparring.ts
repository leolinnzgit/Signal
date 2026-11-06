/**
 * Adversarial Board Sparring & Negotiation Arena Client Engine
 * Models adversarial roleplay, live posture telemetry, linguistic traps, and executive scorecards.
 */

export interface SparringPersona {
  id: string;
  name: string;
  title: string;
  organization: string;
  avatarEmoji: string;
  archetype: string;
  pressurePoints: string[];
  openingStatement: string;
}

export interface DialogTurn {
  sender: "user" | "adversary";
  text: string;
}

export interface PostureTelemetry {
  leverage: number; // 0 - 100
  credibility: number; // 0 - 100
  defensiveness: number; // 0 - 100
  concessionVelocity: number; // 0 - 100
}

export interface SparringResponse {
  personaId: string;
  adversaryReply: string;
  posture: PostureTelemetry;
  trapsDetected: string[];
  recommendedPivot: string;
}

export interface SparringScorecard {
  personaId: string;
  overallGrade: string;
  executiveReadinessScore: number;
  strengths: string[];
  vulnerabilities: string[];
  tacticalRecommendations: string[];
}

/**
 * Returns gauge color representation for telemetry scores
 */
export function getGaugeColor(score: number, inverse = false): string {
  const normalized = inverse ? 100 - score : score;
  if (normalized >= 70) return "#10b981"; // green
  if (normalized >= 45) return "#f59e0b"; // amber
  return "#ef4444"; // red
}

/**
 * Formats full sparring debrief memo for export
 */
export function formatScorecardMemo(
  persona: SparringPersona,
  scorecard: SparringScorecard,
  turns: DialogTurn[]
): string {
  const date = new Date().toUTCString();
  return `# SIGNAL BOARDROOM SPARRING DEBRIEF
Adversary: ${persona.name} (${persona.title}, ${persona.organization})
Archetype: ${persona.archetype}
Session Completed: ${date}

Overall Grade: ${scorecard.overallGrade}
Executive Readiness Score: ${scorecard.executiveReadinessScore}/100

## Executive Strengths
${scorecard.strengths.map((s) => `* ${s}`).join("\n")}

## Identified Vulnerabilities
${scorecard.vulnerabilities.map((v) => `* ${v}`).join("\n")}

## Tactical Recommendations for Actual Boardroom Encounter
${scorecard.tacticalRecommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

## Transcript Excerpts (${turns.length} turns)
${turns
  .slice(-6)
  .map((t) => `**${t.sender === "user" ? "EXECUTIVE" : persona.name.toUpperCase()}**: ${t.text}`)
  .join("\n\n")}

---
CONFIDENTIAL - SIGNAL EXECUTIVE SPARRING SIMULATION`;
}

/**
 * Client API fetchers
 */
export async function fetchSparringPersonas(): Promise<SparringPersona[]> {
  const res = await fetch("/api/board-sparring/personas", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load personas: HTTP ${res.status}`);
  return res.json();
}

export async function sendSparringTurn(
  personaId: string,
  userMessage: string,
  dialogHistory: DialogTurn[]
): Promise<SparringResponse> {
  const res = await fetch("/api/board-sparring/spar", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ personaId, userMessage, dialogHistory }),
  });
  if (!res.ok) throw new Error(`Failed to send sparring turn: HTTP ${res.status}`);
  return res.json();
}

export async function fetchSparringScorecard(
  personaId: string,
  dialogHistory: DialogTurn[]
): Promise<SparringScorecard> {
  const res = await fetch("/api/board-sparring/scorecard", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ personaId, dialogHistory }),
  });
  if (!res.ok) throw new Error(`Failed to fetch scorecard: HTTP ${res.status}`);
  return res.json();
}
