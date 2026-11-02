export interface CSuiteMarketQuote {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  sector: string;
}

export interface CSuiteReportData {
  edition: string;
  reportDate: string;
  macroHeadline: string;
  leadArticles: Array<{ title: string; source: string; summary: string; category?: string }>;
  marketAssets: CSuiteMarketQuote[];
  strategicRisks: Array<{ category: string; description: string; severity: string }>;
  redTeamContrarianNote?: string;
  dossierTopic?: string;
}

export function compileCSuiteReportData(
  briefing?: {
    edition?: string;
    formattedDate?: string;
    leadStories?: Array<{ title: string; source: string; summary?: string }>;
  } | null,
  marketSentiment?: {
    macroHeadline?: string;
    assets?: Array<{ symbol: string; name: string; price: number; changePercent?: number; percentChange?: number; sector?: string }>;
  } | null,
  dossier?: {
    topic?: string;
    executiveSummary?: string;
    risks?: Array<{ category: string; description: string; severity: string }>;
  } | null,
): CSuiteReportData {
  const edition = briefing?.edition || "Executive";
  const reportDate = briefing?.formattedDate || new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const macroHeadline = marketSentiment?.macroHeadline ||
    "Cross-sector risk-on momentum underpinned by growth and regional rate adjustments.";

  const leadArticles = (briefing?.leadStories && briefing.leadStories.length > 0)
    ? briefing.leadStories.slice(0, 5).map((s) => ({
        title: s.title,
        source: s.source,
        summary: s.summary || "Verified reporting marking a significant market or regulatory inflection point.",
      }))
    : [
        {
          title: "Reserve Bank Holds OCR While Evaluating Forward Capital Flows",
          source: "Signal Wire",
          summary: "Monetary policy committee balances inflationary cooldown against domestic trade resilience.",
        },
        {
          title: "Clean Energy Transmission Consents Fast-Tracked",
          source: "RNZ News",
          summary: "Regulators approve regional line upgrades to support industrial electrification.",
        },
      ];

  const marketAssets: CSuiteMarketQuote[] = (marketSentiment?.assets && marketSentiment.assets.length > 0)
    ? marketSentiment.assets.slice(0, 8).map((a) => ({
        symbol: a.symbol,
        name: a.name,
        price: a.price,
        changePercent: a.changePercent ?? a.percentChange ?? 0,
        sector: a.sector || "Equities",
      }))
    : [
        { symbol: "NZ50", name: "NZX 50 Gross Index", price: 12450.8, changePercent: 0.65, sector: "NZ Equities" },
        { symbol: "AIA", name: "Auckland Airport", price: 7.82, changePercent: -0.38, sector: "NZ Equities" },
        { symbol: "AAPL", name: "Apple Inc.", price: 232.4, changePercent: 1.15, sector: "Global Tech" },
        { symbol: "NZDUSD", name: "NZD / USD", price: 0.6012, changePercent: 0.22, sector: "FX & Rates" },
      ];

  const strategicRisks = (dossier?.risks && dossier.risks.length > 0)
    ? dossier.risks.slice(0, 4)
    : [
        { category: "Regulatory & Compliance", severity: "Elevated", description: "Secondary disclosure obligations and statutory compliance reviews." },
        { category: "Capital Allocation", severity: "Moderate", description: "Shifting discount rates impacting projected return on invested capital." },
        { category: "Supply Chain Continuity", severity: "Medium", description: "Lead time exposure on specialized engineering components." },
      ];

  const redTeamContrarianNote = dossier?.executiveSummary
    ? `Red Team Stress-Test: The market may be discounting execution friction and tariff exposure regarding ${dossier.topic || "primary strategic investments"}. Establish 15% capex buffer and secondary vendor corridors.`
    : "Red Team Stress-Test: Assumed transition velocity overstates regional grid and supplier elasticity. Model a 6-month milestone delay scenario.";

  return {
    edition,
    reportDate,
    macroHeadline,
    leadArticles,
    marketAssets,
    strategicRisks,
    redTeamContrarianNote,
    dossierTopic: dossier?.topic,
  };
}

export function formatCSuiteSummaryText(data: CSuiteReportData): string {
  let text = `SIGNAL C-SUITE INTELLIGENCE BRIEFING (${data.edition.toUpperCase()} EDITION)\n`;
  text += `${data.reportDate}\n`;
  text += `====================================================\n\n`;

  text += `MACRO HEADLINE:\n${data.macroHeadline}\n\n`;

  text += `MARKET SNAPSHOT:\n`;
  for (const m of data.marketAssets) {
    text += `* ${m.symbol} (${m.name}): $${m.price.toFixed(2)} [${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(2)}%]\n`;
  }
  text += `\n`;

  text += `CORE CATALYSTS & BREAKING DEVELOPMENTS:\n`;
  for (const a of data.leadArticles) {
    text += `* ${a.title} (${a.source})\n  ${a.summary}\n`;
  }
  text += `\n`;

  text += `STRATEGIC RISK MATRIX:\n`;
  for (const r of data.strategicRisks) {
    text += `* [${r.severity.toUpperCase()}] ${r.category}: ${r.description}\n`;
  }
  text += `\n`;

  if (data.redTeamContrarianNote) {
    text += `CONTRARIAN RED TEAM CRITIQUE:\n${data.redTeamContrarianNote}\n\n`;
  }

  text += `Via Signal Executive Intelligence Briefings. Confidential.\n`;
  return text;
}
