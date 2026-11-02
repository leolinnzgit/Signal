import test from "node:test";
import assert from "node:assert/strict";
import {
  simulateScenario,
  synthesizeScenarioLocally,
  formatScenarioClipboard,
} from "../app/scenario-simulator.ts";

test("synthesizeScenarioLocally models 1st, 2nd, and 3rd order impacts", () => {
  const result = synthesizeScenarioLocally("Port logistics strike halts freight operations");

  assert.equal(result.available, true);
  assert.equal(result.scenario, "Port logistics strike halts freight operations");
  assert.equal(result.impacts.length, 3);
  assert.equal(result.impacts[0].orderLevel, 1);
  assert.equal(result.impacts[1].orderLevel, 2);
  assert.equal(result.impacts[2].orderLevel, 3);
  assert.ok(result.impacts[0].domain.includes("Port"));
  assert.ok(result.resilienceScore >= 35 && result.resilienceScore <= 95);
  assert.ok(result.mitigationPlan.length === 3);
  assert.ok(result.mitigationPlan[0].ownerRole.includes("Officer"));
});

test("simulateScenario calls server endpoint and returns structured playbook", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/scenario-simulator/simulate") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          scenario: "OCR Cut by 50bps",
          executiveSummary: "Rapid yield curve steepening.",
          resilienceScore: 78,
          riskLevel: "Resilient Posture",
          impacts: [
            { orderLevel: 1, domain: "Yields", impactSummary: "Rates drop.", transmissionChannel: "Interbank", severity: "Elevated" },
          ],
          mitigationPlan: [
            { priority: "Immediate", action: "Review debt covenants.", ownerRole: "CFO" },
          ],
          simulatedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await simulateScenario("OCR Cut by 50bps", [], undefined, undefined, mockFetcher);

  assert.equal(res.available, true);
  assert.equal(res.resilienceScore, 78);
  assert.equal(res.impacts.length, 1);
  assert.equal(res.mitigationPlan.length, 1);
});

test("formatScenarioClipboard produces structured boardroom playbook text", () => {
  const res = synthesizeScenarioLocally("Agricultural tariffs imposed");
  const text = formatScenarioClipboard(res);

  assert.ok(text.includes("BOARDROOM SCENARIO SIMULATION PLAYBOOK"));
  assert.ok(text.includes("MULTI-ORDER TRANSMISSION IMPACTS:"));
  assert.ok(text.includes("[ORDER 1]"));
  assert.ok(text.includes("MITIGATION & PLAYBOOK CHECKLIST:"));
});
