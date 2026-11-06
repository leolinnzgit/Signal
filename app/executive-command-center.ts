/**
 * Executive Command Center & Intelligence Suites Registry
 * Consolidates all 18 executive intelligence, radar, and strategic suites
 * into a single unified command hub, eliminating header icon clutter.
 */

export type SuiteCategory = "all" | "risk" | "strategy" | "workflow";

export interface ExecutiveSuite {
  id: string;
  title: string;
  subtitle: string;
  category: "risk" | "strategy" | "workflow";
  categoryLabel: string;
  icon: string;
  keywords: string[];
  shortcutBadge?: string;
}

export const EXECUTIVE_SUITES: ExecutiveSuite[] = [
  // --- Category: Risk & Threat Defense (6) ---
  {
    id: "radar",
    title: "Executive Radar",
    subtitle: "Real-time story velocity, breaking anomalies & market spikes",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "📡",
    keywords: ["velocity", "breaking", "radar", "anomalies", "markets", "spikes", "momentum"],
    shortcutBadge: "R",
  },
  {
    id: "crisis-war-room",
    title: "Crisis War Room",
    subtitle: "Incident command HUD, containment playbooks & triage telemetry",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "🚨",
    keywords: ["crisis", "war room", "incident", "command", "containment", "triage", "emergency"],
    shortcutBadge: "W",
  },
  {
    id: "cyber-incident",
    title: "Cyber Threat Radar",
    subtitle: "CISA alerts, critical CVEs & infrastructure incident command HUD",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "⚡",
    keywords: ["cyber", "cisa", "cve", "zero-day", "ransomware", "security", "infrastructure"],
    shortcutBadge: "C",
  },
  {
    id: "sanctions-radar",
    title: "Sanctions & Tariffs Radar",
    subtitle: "OFAC, BIS & EU export restrictions, SDN watchlists & tariffs",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "🛡️",
    keywords: ["sanctions", "tariffs", "ofac", "bis", "export controls", "sdn", "trade restrictions"],
    shortcutBadge: "S",
  },
  {
    id: "supply-chain",
    title: "Supply Chain Tracker",
    subtitle: "Maritime trade chokepoints, port congestion & supplier vulnerability",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "🚢",
    keywords: ["supply chain", "shipping", "chokepoints", "ports", "freight", "logistics", "red sea"],
    shortcutBadge: "P",
  },
  {
    id: "regulatory-radar",
    title: "Regulatory Horizon",
    subtitle: "Policy compliance radar, antitrust litigation & APAC sector watch",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "📜",
    keywords: ["regulatory", "policy", "compliance", "antitrust", "legislation", "fma", "sec"],
    shortcutBadge: "L",
  },
  {
    id: "geopolitical-transit",
    title: "Signal Sky & Sea (Straits Watch)",
    subtitle: "Maritime chokepoints, Cape detour penalties & NOTAM airspace cones",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "🌐",
    keywords: ["straits", "transit", "airspace", "notam", "sea", "sky", "chokepoint", "hormuz", "red sea"],
    shortcutBadge: "Y",
  },
  {
    id: "sovereign-risk",
    title: "Sovereign Risk & Debt Stress",
    subtitle: "Macro FX velocity, CDS spreads, capital controls & treasury repatriation haircuts",
    category: "risk",
    categoryLabel: "Risk & Defense",
    icon: "🏛️",
    keywords: ["sovereign", "debt", "cds", "fx", "currency", "repatriation", "haircut", "macro", "reserves"],
    shortcutBadge: "F",
  },

  // --- Category: Strategic Foresight & Analysis (6) ---
  {
    id: "knowledge-graph",
    title: "Intelligence Knowledge Graph",
    subtitle: "Interactive force simulation linking organizations, people & vectors",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "🌐",
    keywords: ["knowledge graph", "network", "entities", "relationships", "graph", "simulation", "clusters"],
    shortcutBadge: "G",
  },
  {
    id: "horizon-scanner",
    title: "Horizon Scanner & Dossiers",
    subtitle: "Multi-quarter living strategic dossiers, roadmaps & weekly deltas",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "🔭",
    keywords: ["horizon", "scanner", "dossiers", "deep tech", "inflections", "milestones", "future"],
    shortcutBadge: "H",
  },
  {
    id: "competitor-radar",
    title: "Competitor Radar & M&A",
    subtitle: "Rival peer group monitoring, deal flow & patent intelligence",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "🎯",
    keywords: ["competitor", "m&a", "deals", "patents", "rivals", "peer group", "acquisitions"],
    shortcutBadge: "M",
  },
  {
    id: "market-heatmap",
    title: "Market Heatmap & Sentiment",
    subtitle: "Multi-asset cross-correlation, macro drivers & sector momentum",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "📊",
    keywords: ["market", "heatmap", "sentiment", "stocks", "macro", "rates", "yields", "crypto"],
    shortcutBadge: "K",
  },
  {
    id: "scenario-simulator",
    title: "Boardroom Scenario Simulator",
    subtitle: "Monte Carlo decision trees & counterfactual macro stress tests",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "🎲",
    keywords: ["scenario", "simulator", "boardroom", "decision tree", "stress test", "monte carlo"],
    shortcutBadge: "B",
  },
  {
    id: "claims-arbiter",
    title: "Claims & Fact Arbiter",
    subtitle: "Multi-source contradiction detection & consensus arbitration",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "⚖️",
    keywords: ["claims", "arbiter", "fact check", "contradictions", "verification", "sources"],
    shortcutBadge: "A",
  },
  {
    id: "board-sparring",
    title: "Boardroom & Negotiation Sparring",
    subtitle: "Tactical adversarial sparring against activist, regulator & short-seller personas",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "🤺",
    keywords: ["sparring", "negotiation", "boardroom", "activist", "regulator", "short seller", "tactics"],
    shortcutBadge: "N",
  },
  {
    id: "tariff-matrix",
    title: "Global Tariff & Supply Arbitrage",
    subtitle: "Cross-border tariff shock modeling, COGS variance & FTA nearshoring arbitrage",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "📊",
    keywords: ["tariff", "trade", "arbitrage", "cogs", "usmca", "cptpp", "margin", "customs"],
    shortcutBadge: "X",
  },
  {
    id: "pre-mortem",
    title: "Corporate Pre-Mortem Simulator",
    subtitle: "Adversarial failure cascade modeling, early warning indicators & boardroom hedging directives",
    category: "strategy",
    categoryLabel: "Strategy & Foresight",
    icon: "⚔️",
    keywords: ["pre-mortem", "kill the company", "failure", "adversarial", "autopsy", "hedging", "wargame"],
    shortcutBadge: "Z",
  },

  // --- Category: Executive Operations & Workflows (6) ---
  {
    id: "csuite-report",
    title: "C-Suite Intelligence Report",
    subtitle: "Executive intelligence briefing compilation with instant PDF export",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "📑",
    keywords: ["c-suite", "report", "pdf", "briefing", "executive", "board", "export"],
    shortcutBadge: "E",
  },
  {
    id: "meeting-prep",
    title: "1-Minute Meeting Prep",
    subtitle: "Executive counterparty dossiers, background intel & negotiation angles",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🎯",
    keywords: ["meeting", "prep", "counterparty", "negotiation", "dossier", "brief"],
    shortcutBadge: "T",
  },
  {
    id: "quote-extractor",
    title: "Soundbites & Quotes Tracker",
    subtitle: "Verbatim executive soundbites, stance shifts & audio audiograms",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🎙️",
    keywords: ["quotes", "soundbites", "stances", "executives", "audiogram", "verbatim"],
    shortcutBadge: "Q",
  },
  {
    id: "commute-playlist",
    title: "Executive Commute Playlist",
    subtitle: "Drive-time audio chapter queue & hands-free playback",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🚗",
    keywords: ["commute", "playlist", "audio", "car", "drive", "chapters", "listening"],
    shortcutBadge: "D",
  },
  {
    id: "clock-radio",
    title: "Bedside Clock Radio",
    subtitle: "Scheduled wake-up alarm with auto-playing morning news broadcast",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "⏰",
    keywords: ["clock", "radio", "alarm", "bedside", "wake up", "morning", "time"],
    shortcutBadge: "O",
  },
  {
    id: "voice-debrief",
    title: "Talk to Signal (Voice Debrief)",
    subtitle: "Conversational 2-way spoken executive debrief & strategic Q&A",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🎙️",
    keywords: ["voice", "talk", "speak", "debrief", "assistant", "speech", "ask", "conversation"],
    shortcutBadge: "V",
  },
  {
    id: "quiet-hours",
    title: "Quiet Hours & Crisis VIP",
    subtitle: "Do-not-disturb filters with breaking VIP crisis threshold bypass",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🌙",
    keywords: ["quiet hours", "dnd", "notifications", "vip", "sleep", "bypass", "crisis threshold"],
    shortcutBadge: "U",
  },
  {
    id: "briefing-studio",
    title: "Executive Briefing Studio",
    subtitle: "Autonomous broadcast video reels with animated telemetry & neural voice",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🎬",
    keywords: ["studio", "video", "broadcast", "reel", "media", "storyboard", "webm", "narration"],
    shortcutBadge: "J",
  },
  {
    id: "signal-cortex",
    title: "Signal Cortex (Executive Second Brain)",
    subtitle: "Unified cross-corpus semantic search, verified citations & instant brief synthesis",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🧠",
    keywords: ["cortex", "second brain", "semantic", "corpus", "omni", "digest", "synthesis"],
    shortcutBadge: "⌘J",
  },
  {
    id: "daily-cast",
    title: "Signal Studio Daily Cast",
    subtitle: "Autonomous dual-host executive podcast with real-time vocal sparring & show notes",
    category: "workflow",
    categoryLabel: "Executive Operations",
    icon: "🎙️",
    keywords: ["daily cast", "podcast", "hosts", "vance", "chen", "sparring", "broadcast", "show notes"],
    shortcutBadge: "P",
  },
];

const RECENT_SUITES_STORAGE_KEY = "signal-recent-executive-suites";
const MAX_RECENT_SUITES = 4;

/**
 * Filter suites based on search query and category filter.
 */
export function filterExecutiveSuites(
  suites: ExecutiveSuite[],
  query: string,
  category: SuiteCategory = "all",
): ExecutiveSuite[] {
  const normalizedQuery = query.trim().toLowerCase();

  return suites.filter((suite) => {
    // Check category match
    if (category !== "all" && suite.category !== category) {
      return false;
    }

    // Check search query match
    if (!normalizedQuery) {
      return true;
    }

    const titleMatch = suite.title.toLowerCase().includes(normalizedQuery);
    const subtitleMatch = suite.subtitle.toLowerCase().includes(normalizedQuery);
    const categoryMatch = suite.categoryLabel.toLowerCase().includes(normalizedQuery);
    const keywordMatch = suite.keywords.some((kw) => kw.toLowerCase().includes(normalizedQuery));

    return titleMatch || subtitleMatch || categoryMatch || keywordMatch;
  });
}

/**
 * Get category item counts.
 */
export function getCategoryCounts(suites: ExecutiveSuite[]): Record<SuiteCategory, number> {
  const counts: Record<SuiteCategory, number> = {
    all: suites.length,
    risk: 0,
    strategy: 0,
    workflow: 0,
  };

  for (const suite of suites) {
    if (suite.category in counts) {
      counts[suite.category]++;
    }
  }

  return counts;
}

/**
 * Safely load recent suites from storage.
 */
export function getRecentSuites(
  suites: ExecutiveSuite[],
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null,
): ExecutiveSuite[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_SUITES_STORAGE_KEY);
    if (!raw) return [];
    const ids: string[] = JSON.parse(raw);
    if (!Array.isArray(ids)) return [];

    const suiteMap = new Map(suites.map((s) => [s.id, s]));
    const result: ExecutiveSuite[] = [];
    for (const id of ids) {
      const suite = suiteMap.get(id);
      if (suite) {
        result.push(suite);
      }
    }
    return result.slice(0, MAX_RECENT_SUITES);
  } catch {
    return [];
  }
}

/**
 * Safely record a recently opened suite ID into storage.
 */
export function recordRecentSuite(
  suiteId: string,
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null,
): void {
  if (!storage) return;
  try {
    const raw = storage.getItem(RECENT_SUITES_STORAGE_KEY);
    const existing: string[] = raw ? JSON.parse(raw) : [];
    const filtered = existing.filter((id) => id !== suiteId);
    filtered.unshift(suiteId);
    storage.setItem(RECENT_SUITES_STORAGE_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT_SUITES)));
  } catch {
    // Ignore storage quota or access errors
  }
}
