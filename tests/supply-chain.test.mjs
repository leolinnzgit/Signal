import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchSupplyChainStatus,
  formatSupplyChainDigest,
} from "../app/supply-chain.ts";

test("fetchSupplyChainStatus calls GET /api/supply-chain/status when no articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    return {
      ok: true,
      json: async () => ({
        available: true,
        compositeExposureIndex: 68,
        exposureLabel: "Elevated Global Exposure",
        exposure: {
          energyAndFuel: 74,
          electronicsAndChips: 62,
          agriCommodities: 51,
          freightAndTransit: 78,
        },
        chokepoints: [
          {
            id: "bab-el-mandeb",
            name: "Bab-el-Mandeb & Southern Red Sea",
            region: "Middle East / Red Sea",
            latitude: 12.58,
            longitude: 43.33,
            status: "Disrupted",
            riskScore: 92,
            dailyVolumeShare: "12% of global trade",
            primaryHazards: ["Drone & missile strikes"],
            alternativeRoute: "Cape of Good Hope",
            extraTransitDays: 12,
            impactedCommodities: ["Refined petroleum", "Electronics"],
            incidents: [
              {
                headline: "Commercial boxship forced to divert",
                date: "Today",
                source: "Maritime Security Center",
                severity: "Critical",
              },
            ],
          },
        ],
        carrierAlerts: [
          {
            carrier: "Maersk Line",
            action: "Cape of Good Hope Reroute",
            impactedRoute: "Asia to Europe",
            effectiveDate: "Active",
            surcharge: "+$700/TEU",
          },
        ],
        spokenAudioScript: "Executive supply chain briefing script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const res = await fetchSupplyChainStatus(undefined, mockFetcher);

  assert.equal(calledUrl, "/api/supply-chain/status");
  assert.equal(calledMethod, "GET");
  assert.equal(res.available, true);
  assert.equal(res.compositeExposureIndex, 68);
  assert.equal(res.chokepoints.length, 1);
  assert.equal(res.chokepoints[0].id, "bab-el-mandeb");
});

test("fetchSupplyChainStatus calls POST /api/supply-chain/analyze when articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";
  let sentBody = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    sentBody = opts?.body || "";
    return {
      ok: true,
      json: async () => ({
        available: true,
        compositeExposureIndex: 82,
        exposureLabel: "Severe Global Exposure",
        exposure: {
          energyAndFuel: 85,
          electronicsAndChips: 70,
          agriCommodities: 60,
          freightAndTransit: 94,
        },
        chokepoints: [],
        carrierAlerts: [],
        spokenAudioScript: "Elevated Red Sea conflict script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const res = await fetchSupplyChainStatus(
    {
      articles: [
        {
          title: "Houthi drone swarm targets Red Sea container ship",
          source: "Reuters",
          url: "https://example.com/houthi-redsea",
          summary: "Vessel diverted south around Africa.",
        },
      ],
    },
    mockFetcher
  );

  assert.equal(calledUrl, "/api/supply-chain/analyze");
  assert.equal(calledMethod, "POST");
  assert.ok(sentBody.includes("Houthi drone swarm"));
  assert.equal(res.compositeExposureIndex, 82);
  assert.equal(res.exposureLabel, "Severe Global Exposure");
});

test("formatSupplyChainDigest generates complete executive text report", () => {
  const data = {
    available: true,
    compositeExposureIndex: 71,
    exposureLabel: "Elevated Global Exposure",
    exposure: {
      energyAndFuel: 76,
      electronicsAndChips: 65,
      agriCommodities: 54,
      freightAndTransit: 82,
    },
    chokepoints: [
      {
        id: "panama-canal",
        name: "Panama Canal Locks",
        region: "Central America",
        latitude: 9.08,
        longitude: -79.68,
        status: "Restricted",
        riskScore: 72,
        dailyVolumeShare: "5% of global trade",
        primaryHazards: ["Gatun Lake reservoir drought"],
        alternativeRoute: "US Intermodal Rail Bridge",
        extraTransitDays: 7,
        impactedCommodities: ["US grain & soybean exports", "LNG to Asia"],
        incidents: [
          {
            headline: "Daily slot allocations restricted",
            date: "Today",
            source: "Canal Authority",
            severity: "Moderate",
          },
        ],
      },
    ],
    carrierAlerts: [
      {
        carrier: "MSC",
        action: "Southern Route Routing",
        impactedRoute: "Far East to East Coast NA",
        effectiveDate: "Active",
        surcharge: "+$850/FEU",
      },
    ],
    spokenAudioScript: "Executive speech script.",
    generatedAt: "2026-11-03T01:00:00Z",
  };

  const text = formatSupplyChainDigest(data);

  assert.ok(text.includes("EXECUTIVE SUPPLY CHAIN & TRADE CHOKEPOINT RADAR"));
  assert.ok(text.includes("Global Maritime Exposure: 71/100"));
  assert.ok(text.includes("Panama Canal Locks"));
  assert.ok(text.includes("Daily slot allocations restricted"));
  assert.ok(text.includes("MSC: Southern Route Routing"));
});
