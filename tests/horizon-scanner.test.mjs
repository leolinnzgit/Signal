import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchHorizonDossiers,
  formatHorizonScannerDigest,
  getDomainIcon,
  getMilestoneStatusClass,
  getDossierStatusClass,
} from "../app/horizon-scanner.ts";

test("fetchHorizonDossiers calls GET /api/horizon-scanner/dossiers when no articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    return {
      ok: true,
      json: async () => ({
        available: true,
        activeDossiersCount: 1,
        inflectionsCount: 1,
        strategicSummary: "Tracking 1 strategic horizon.",
        dossiers: [
          {
            id: "horizon-sub-2nm-lithography",
            strategicTopic: "Sub-2nm Logic Commercialization",
            domain: "Semiconductors & Deep Tech",
            maturityPhase: "Commercial Pilot",
            status: "Inflection Point Detected",
            confidenceScore: 88,
            horizonWindow: "2026 – 2028",
            executiveThesis: "Transition to GAA nanosheets.",
            milestones: [
              {
                date: "Q1 2026",
                milestone: "Delivery of High-NA EUV tools",
                status: "Completed",
                verificationSource: "ASML Filing",
              },
            ],
            weeklyDelta: {
              inflectionPointsThisWeek: ["Yield curves improved 4%."],
              invalidatedAssumptions: ["Double-exposure unnecessary."],
              catalystsNext90Days: ["Quarterly earnings update."],
            },
            keyWatchEntities: ["TSMC", "ASML"],
            lastUpdated: new Date().toISOString(),
          },
        ],
        spokenAudioScript: "Spoken horizon script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const result = await fetchHorizonDossiers({}, mockFetcher);

  assert.equal(calledUrl, "/api/horizon-scanner/dossiers");
  assert.equal(calledMethod, "GET");
  assert.equal(result.activeDossiersCount, 1);
  assert.equal(result.dossiers[0].id, "horizon-sub-2nm-lithography");
  assert.equal(result.dossiers[0].status, "Inflection Point Detected");
});

test("fetchHorizonDossiers calls POST /api/horizon-scanner/analyze when articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";
  let calledBody = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    calledBody = opts?.body || "";
    return {
      ok: true,
      json: async () => ({
        available: true,
        activeDossiersCount: 3,
        inflectionsCount: 2,
        strategicSummary: "Updated with articles.",
        dossiers: [],
        spokenAudioScript: "Custom script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const articles = [
    { title: "TSMC announces 2nm test wafer yield breakthrough", source: "Reuters", url: "https://example.com/2nm" },
  ];

  const result = await fetchHorizonDossiers({ articles }, mockFetcher);

  assert.equal(calledUrl, "/api/horizon-scanner/analyze");
  assert.equal(calledMethod, "POST");
  assert.ok(calledBody.includes("yield breakthrough"));
  assert.equal(result.inflectionsCount, 2);
});

test("fetchHorizonDossiers rejects on HTTP error", async () => {
  const failingFetcher = async () => ({
    ok: false,
    status: 504,
  });

  await assert.rejects(
    async () => {
      await fetchHorizonDossiers({}, failingFetcher);
    },
    /Failed to load horizon dossiers: HTTP 504/
  );
});

test("formatHorizonScannerDigest formats complete C-Suite Strategy Memo", () => {
  const data = {
    available: true,
    activeDossiersCount: 1,
    inflectionsCount: 1,
    strategicSummary: "Active tracking across sub-2nm nodes.",
    dossiers: [
      {
        id: "horizon-1",
        strategicTopic: "Sub-2nm Logic Commercialization",
        domain: "Semiconductors & Deep Tech",
        maturityPhase: "Commercial Pilot",
        status: "Inflection Point Detected",
        confidenceScore: 88,
        horizonWindow: "2026 – 2028",
        executiveThesis: "GAA transition underway.",
        milestones: [
          {
            date: "Q1 2026",
            milestone: "High-NA EUV Delivery",
            status: "Completed",
            verificationSource: "ASML",
          },
        ],
        weeklyDelta: {
          inflectionPointsThisWeek: ["Yield curves improved 4%."],
          invalidatedAssumptions: ["Double-exposure unnecessary."],
          catalystsNext90Days: ["Quarterly earnings."],
        },
        keyWatchEntities: ["TSMC", "ASML"],
        lastUpdated: "2026-11-05T09:00:00Z",
      },
    ],
    spokenAudioScript: "Spoken script.",
    generatedAt: "2026-11-05T09:00:00Z",
  };

  const memo = formatHorizonScannerDigest(data);

  assert.ok(memo.includes("SIGNAL AUTONOMOUS HORIZON SCANNER & LIVING DOSSIERS"));
  assert.ok(memo.includes("Sub-2nm Logic Commercialization"));
  assert.ok(memo.includes("Yield curves improved 4%."));
  assert.ok(memo.includes("Double-exposure unnecessary."));
  assert.ok(memo.includes("High-NA EUV Delivery"));
});

test("getDomainIcon returns appropriate icon for domains", () => {
  assert.equal(getDomainIcon("Semiconductors & Deep Tech"), "🔬");
  assert.equal(getDomainIcon("Cybersecurity & Cryptography"), "🔐");
  assert.equal(getDomainIcon("Clean Energy & Mobility"), "🔋");
  assert.equal(getDomainIcon("Geopolitics & Maritime Security"), "⚓");
  assert.equal(getDomainIcon("Monetary Policy & Digital Currency"), "🪙");
  assert.equal(getDomainIcon("General Domain"), "🔭");
});

test("getMilestoneStatusClass and getDossierStatusClass return valid CSS utility classes", () => {
  assert.equal(getMilestoneStatusClass("Completed"), "horizon-milestone-completed");
  assert.equal(getMilestoneStatusClass("In Progress"), "horizon-milestone-progress");
  assert.equal(getMilestoneStatusClass("Delayed"), "horizon-milestone-delayed");
  assert.equal(getMilestoneStatusClass("Target"), "horizon-milestone-target");

  assert.equal(getDossierStatusClass("Inflection Point Detected"), "horizon-status-inflection");
  assert.equal(getDossierStatusClass("Accelerating"), "horizon-status-accelerating");
  assert.equal(getDossierStatusClass("Active Monitoring"), "horizon-status-monitoring");
});
