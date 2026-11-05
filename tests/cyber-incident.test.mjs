import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchCyberIncidentStatus,
  formatCyberIncidentDigest,
  getSectorIcon,
  getSeverityBadgeClass,
} from "../app/cyber-incident.ts";

test("fetchCyberIncidentStatus calls GET /api/cyber-incident-hud/status when no articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    return {
      ok: true,
      json: async () => ({
        available: true,
        defconLevel: "DEFCON 2 — Severe Advisory",
        compositeThreatIndex: 88,
        threatSummary: "Active zero-day exploitation and targeted infrastructure reconnaissance observed.",
        activeZeroDays: 2,
        activeAptCampaigns: 1,
        ransomwareSurges: 1,
        criticalOutages: 1,
        sectors: [
          {
            sector: "Cloud & Telecom Backbone",
            riskLevel: "Critical",
            threatVector: "BGP Route Hijacking",
            trend: "Escalating",
            activeThreats: 3,
            description: "Undersea fiber rerouting detected.",
          },
        ],
        incidents: [
          {
            id: "inc-cve-2026-edge",
            title: "Critical Edge Firewall & SSL-VPN Memory Corruption RCE",
            threatActor: "UNC3886 / Volt Typhoon Group",
            cve: "CVE-2026-4819 (CVSS 9.8)",
            category: "Zero-Day Exploit",
            severity: "Critical",
            affectedSystems: ["Perimeter SSL-VPN Concentrators"],
            impactAssessment: "Unauthenticated remote code execution.",
            mitigationDirectives: ["Isolate management interfaces."],
            source: "CISA Cybersecurity Advisory",
            timestamp: "Active Alert",
          },
        ],
        mitigations: [
          {
            urgency: "Immediate (P0)",
            action: "Isolate perimeter edge gateway management ports.",
            targetDomain: "Perimeter & Identity",
          },
        ],
        spokenAudioScript: "Signal CISO incident dispatch script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const result = await fetchCyberIncidentStatus({}, mockFetcher);

  assert.equal(calledUrl, "/api/cyber-incident-hud/status");
  assert.equal(calledMethod, "GET");
  assert.equal(result.available, true);
  assert.equal(result.defconLevel, "DEFCON 2 — Severe Advisory");
  assert.equal(result.compositeThreatIndex, 88);
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].cve, "CVE-2026-4819 (CVSS 9.8)");
});

test("fetchCyberIncidentStatus calls POST /api/cyber-incident-hud/analyze when articles provided", async () => {
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
        defconLevel: "DEFCON 2 — Severe Advisory",
        compositeThreatIndex: 92,
        threatSummary: "Active zero-day in user feed.",
        activeZeroDays: 3,
        activeAptCampaigns: 2,
        ransomwareSurges: 1,
        criticalOutages: 0,
        sectors: [],
        incidents: [],
        mitigations: [],
        spokenAudioScript: "Custom feed script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const sampleArticles = [
    {
      title: "Critical Zero-Day Exploit Found in Core Network Gateways",
      source: "Ars Technica",
      url: "https://example.com/zeroday",
      summary: "Attackers are actively exploiting unpatched bug.",
    },
  ];

  const result = await fetchCyberIncidentStatus({ articles: sampleArticles }, mockFetcher);

  assert.equal(calledUrl, "/api/cyber-incident-hud/analyze");
  assert.equal(calledMethod, "POST");
  assert.ok(calledBody.includes("Critical Zero-Day Exploit"));
  assert.equal(result.compositeThreatIndex, 92);
});

test("fetchCyberIncidentStatus handles HTTP failure gracefully", async () => {
  const failingFetcher = async () => ({
    ok: false,
    status: 503,
  });

  await assert.rejects(
    async () => {
      await fetchCyberIncidentStatus({}, failingFetcher);
    },
    /Failed to load cyber incident status: HTTP 503/
  );
});

test("formatCyberIncidentDigest generates structured CISO intelligence briefing", () => {
  const data = {
    available: true,
    defconLevel: "DEFCON 2 — Severe Advisory",
    compositeThreatIndex: 88,
    threatSummary: "Undersea cable outage and active edge firewall exploits.",
    activeZeroDays: 2,
    activeAptCampaigns: 1,
    ransomwareSurges: 1,
    criticalOutages: 1,
    sectors: [
      {
        sector: "Cloud & Telecom Backbone",
        riskLevel: "Critical",
        threatVector: "BGP Route Hijacking",
        trend: "Escalating",
        activeThreats: 3,
        description: "Core transit latency spikes.",
      },
    ],
    incidents: [
      {
        id: "inc-1",
        title: "Perimeter VPN Gateway RCE",
        threatActor: "Volt Typhoon",
        cve: "CVE-2026-4819",
        category: "Zero-Day Exploit",
        severity: "Critical",
        affectedSystems: ["Edge Gateways"],
        impactAssessment: "Root gateway compromise.",
        mitigationDirectives: ["Apply emergency patch."],
        source: "CISA",
        timestamp: "Active",
        articleUrl: "https://example.com/alert",
      },
    ],
    mitigations: [
      {
        urgency: "Immediate (P0)",
        action: "Enforce hardware MFA.",
        targetDomain: "Identity",
      },
    ],
    spokenAudioScript: "Spoken briefing.",
    generatedAt: "2026-11-05T06:00:00Z",
  };

  const digest = formatCyberIncidentDigest(data);

  assert.ok(digest.includes("SIGNAL CISO CYBER THREAT RADAR & INCIDENT COMMAND HUD"));
  assert.ok(digest.includes("DEFCON 2 — Severe Advisory"));
  assert.ok(digest.includes("Risk Index: 88/100"));
  assert.ok(digest.includes("Active Zero-Days in Wild:   2"));
  assert.ok(digest.includes("Cloud & Telecom Backbone"));
  assert.ok(digest.includes("Perimeter VPN Gateway RCE"));
  assert.ok(digest.includes("Volt Typhoon"));
  assert.ok(digest.includes("Enforce hardware MFA."));
  assert.ok(digest.includes("https://example.com/alert"));
});

test("getSectorIcon returns distinct iconography for each infrastructure sector", () => {
  assert.equal(getSectorIcon("Cloud & Telecom Backbone"), "☁️");
  assert.equal(getSectorIcon("Energy Grid & SCADA Utilities"), "⚡");
  assert.equal(getSectorIcon("Financial & Payment Rails"), "🏦");
  assert.equal(getSectorIcon("Healthcare & MedTech"), "🏥");
  assert.equal(getSectorIcon("Defense & Aerospace"), "🛡️");
  assert.equal(getSectorIcon("Government & Public Sector"), "🏛️");
  assert.equal(getSectorIcon("Other"), "🔒");
});

test("getSeverityBadgeClass maps threat severity to CSS utility classes", () => {
  assert.equal(getSeverityBadgeClass("Critical"), "cyber-badge-critical");
  assert.equal(getSeverityBadgeClass("High"), "cyber-badge-high");
  assert.equal(getSeverityBadgeClass("Elevated"), "cyber-badge-elevated");
  assert.equal(getSeverityBadgeClass("Medium"), "cyber-badge-elevated");
  assert.equal(getSeverityBadgeClass("Normal"), "cyber-badge-nominal");
});
