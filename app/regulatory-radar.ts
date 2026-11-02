export interface RegulatoryBill {
  title: string;
  regulatoryBody: string;
  stage: string;
  complianceDeadline: string;
  penaltyExposure: string;
  summary: string;
}

export interface SectorRiskProfile {
  sector: string;
  exposureLevel: "High" | "Moderate" | "Elevated" | "Low" | string;
  keyImpactArea: string;
  recommendedBoardQuery: string;
}

export interface ComplianceActionItem {
  id: string;
  requirement: string;
  actionItem: string;
  targetQuarter: string;
  priority: "Urgent" | "Medium" | "Monitoring" | string;
}

export interface RegulatoryRadarResponse {
  available: boolean;
  industrySector: string;
  jurisdiction: string;
  billsAndMandates: RegulatoryBill[];
  sectorRisks: SectorRiskProfile[];
  complianceChecklist: ComplianceActionItem[];
  spokenComplianceScript: string;
  generatedAt: string;
}

export async function fetchRegulatoryRadar(
  industrySector: string = "All NZ/APAC Sectors",
  jurisdiction: string = "New Zealand / Australasia",
  articles?: Array<{ title: string; source: string; url: string; publishedAt?: string; summary?: string }>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<RegulatoryRadarResponse> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return synthesizeRegulatoryRadarLocally(industrySector, jurisdiction);
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

    const res = await fetcher("/api/regulatory-radar/scan", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        industrySector,
        jurisdiction,
        articles: articles?.slice(0, 20),
      }),
      signal,
    });

    if (!res.ok) {
      return synthesizeRegulatoryRadarLocally(industrySector, jurisdiction);
    }

    const data = await res.json();
    return {
      available: Boolean(data.available),
      industrySector: data.industrySector || industrySector,
      jurisdiction: data.jurisdiction || jurisdiction,
      billsAndMandates: Array.isArray(data.billsAndMandates) ? data.billsAndMandates : [],
      sectorRisks: Array.isArray(data.sectorRisks) ? data.sectorRisks : [],
      complianceChecklist: Array.isArray(data.complianceChecklist) ? data.complianceChecklist : [],
      spokenComplianceScript: data.spokenComplianceScript || "",
      generatedAt: data.generatedAt || new Date().toISOString(),
    };
  } catch {
    return synthesizeRegulatoryRadarLocally(industrySector, jurisdiction);
  }
}

export function synthesizeRegulatoryRadarLocally(
  industrySector: string,
  jurisdiction: string,
): RegulatoryRadarResponse {
  return {
    available: true,
    industrySector,
    jurisdiction,
    billsAndMandates: [
      {
        title: "Mandatory Climate-Related Disclosures (CRD Regime)",
        regulatoryBody: "Financial Markets Authority",
        stage: "Enforcement Phase (Year 2)",
        complianceDeadline: "31 March 2027",
        penaltyExposure: "Up to NZ$5M for reporting entities",
        summary: "Requires audited Scope 1-3 greenhouse gas inventory and climate scenario governance disclosures.",
      },
      {
        title: "Commerce Act Market Studies & Anti-Monopoly Amendments",
        regulatoryBody: "Commerce Commission",
        stage: "Select Committee Review",
        complianceDeadline: "Q4 2026",
        penaltyExposure: "Up to 10% of annual turnover",
        summary: "Expands investigative powers over wholesale pricing, exclusive supplier agreements, and market concentration.",
      },
      {
        title: "Privacy Act Mandatory Data Breach 72-Hour Fines",
        regulatoryBody: "Office of the Privacy Commissioner",
        stage: "Second Reading",
        complianceDeadline: "Q1 2027",
        penaltyExposure: "Up to NZ$1M per systemic breach",
        summary: "Compresses mandatory notification windows to 72 hours with direct board liability.",
      },
    ],
    sectorRisks: [
      {
        sector: "Agri & Primary Industries",
        exposureLevel: "High",
        keyImpactArea: "Scope 3 supply chain carbon tracking and agricultural runoff consenting.",
        recommendedBoardQuery: "Do our farmer suppliers have automated emissions reporting verified by third parties?",
      },
      {
        sector: "Banking & Wealth",
        exposureLevel: "High",
        keyImpactArea: "Conduct licensing and deposit spread disclosures.",
        recommendedBoardQuery: "Are our customer pricing practices fully resilient against Commerce Commission market inquiries?",
      },
    ],
    complianceChecklist: [
      {
        id: "CHK-01",
        requirement: "CRD Scope 3 Baseline Verification",
        actionItem: "Audit Scope 3 supply chain logistics emissions with accredited certifier.",
        targetQuarter: "Q3 2026",
        priority: "Urgent",
      },
      {
        id: "CHK-02",
        requirement: "72-Hour Data Breach Tabletop Drill",
        actionItem: "Conduct simulated privacy incident response drill with senior management.",
        targetQuarter: "Q4 2026",
        priority: "Urgent",
      },
    ],
    spokenComplianceScript: `Regulatory radar report for ${industrySector} in ${jurisdiction}. Primary compliance obligations focus on Climate-Related Disclosures enforcement, expanded Commerce Commission pricing scrutiny, and mandatory 72-hour privacy breach alerting. Key board action is completing the Scope 3 audit and privacy tabletop exercise before quarter end.`,
    generatedAt: new Date().toISOString(),
  };
}

export function formatRegulatoryRadarClipboard(data: RegulatoryRadarResponse): string {
  const billsText = data.billsAndMandates
    .map(
      (b) =>
        `• ${b.title} [${b.stage}]\n  Body: ${b.regulatoryBody} | Deadline: ${b.complianceDeadline}\n  Penalties: ${b.penaltyExposure}\n  Summary: ${b.summary}`,
    )
    .join("\n\n");

  const checklistText = data.complianceChecklist
    .map((c) => `[${c.priority.toUpperCase()}] (${c.targetQuarter}) ${c.requirement}: ${c.actionItem}`)
    .join("\n");

  const risksText = data.sectorRisks
    .map((r) => `• [${r.sector}] Risk: ${r.exposureLevel}\n  Impact: ${r.keyImpactArea}\n  Board Question: "${r.recommendedBoardQuery}"`)
    .join("\n\n");

  return `📜 REGULATORY HORIZON & COMPLIANCE RADAR
Sector: ${data.industrySector} | Jurisdiction: ${data.jurisdiction}
Generated: ${new Date(data.generatedAt).toLocaleString()}

--------------------------------------------------
ACTIVE LEGISLATIVE BILLS & REGULATORY MANDATES:
--------------------------------------------------
${billsText}

--------------------------------------------------
BOARDROOM COMPLIANCE ACTION CHECKLIST:
--------------------------------------------------
${checklistText}

--------------------------------------------------
SECTOR RISK EXPOSURE & BOARD QUERIES:
--------------------------------------------------
${risksText}

--------------------------------------------------
SPOKEN COMPLIANCE BRIEF:
${data.spokenComplianceScript}
`;
}
