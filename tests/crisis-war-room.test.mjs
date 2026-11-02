import test from "node:test";
import assert from "node:assert/strict";
import {
  activateCrisisWarRoom,
  synthesizeCrisisWarRoomLocally,
  formatCrisisWarRoomClipboard,
} from "../app/crisis-war-room.ts";

test("synthesizeCrisisWarRoomLocally produces incident response playbook", () => {
  const warRoom = synthesizeCrisisWarRoomLocally(
    "Cloud Outage & Data Pipeline Failure",
    "Auckland Core Operations",
    "Critical",
  );

  assert.equal(warRoom.available, true);
  assert.equal(warRoom.incidentTitle, "Cloud Outage & Data Pipeline Failure");
  assert.equal(warRoom.affectedEntity, "Auckland Core Operations");
  assert.equal(warRoom.severityLevel, "Critical");
  assert.ok(warRoom.timeline.length >= 2);
  assert.ok(warRoom.holdingStatements.length >= 1);
  assert.ok(warRoom.stakeholderImpacts.length >= 2);
  assert.ok(warRoom.anticipatedQuestions.length >= 1);
  assert.ok(warRoom.urgentSituationScript.includes("Auckland Core Operations"));
});

test("activateCrisisWarRoom calls backend endpoint and parses incident structure", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/crisis-war-room/activate") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          incidentId: "crisis-test-123",
          incidentTitle: "Port Congestion Emergency",
          affectedEntity: "Supply Chain Operations",
          severityLevel: "High",
          containmentStatus: "Active Response",
          timeline: [
            { timestamp: "T - 1 hour", milestone: "Vessel queue doubles", source: "Ops", severityDelta: "+1" },
          ],
          stakeholderImpacts: [
            { group: "Importers", exposureLevel: "High", immediateRisk: "Delay", mitigationAction: "Reroute" },
          ],
          holdingStatements: [
            { audience: "Media", statement: "Operations are resolving delays.", guidanceTone: "Calm" },
          ],
          anticipatedQuestions: [
            { question: "Who is at fault?", suggestedResponse: "Focusing on resolution.", landminesToAvoid: "Blame" },
          ],
          urgentSituationScript: "Port incident brief.",
          activatedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await activateCrisisWarRoom("Port Congestion Emergency", "Supply Chain Operations", "High", [], undefined, mockFetcher);

  assert.equal(res.available, true);
  assert.equal(res.incidentId, "crisis-test-123");
  assert.equal(res.affectedEntity, "Supply Chain Operations");
  assert.equal(res.holdingStatements[0].audience, "Media");
});

test("formatCrisisWarRoomClipboard creates structured executive incident memo", () => {
  const warRoom = synthesizeCrisisWarRoomLocally("Cyber Incident", "National Network", "Critical");
  const text = formatCrisisWarRoomClipboard(warRoom);

  assert.ok(text.includes("EXECUTIVE CRISIS WAR ROOM: CYBER INCIDENT"));
  assert.ok(text.includes("VERIFIED HOLDING STATEMENTS:"));
  assert.ok(text.includes("STAKEHOLDER EXPOSURE & MITIGATION:"));
  assert.ok(text.includes("INCIDENT CHRONOLOGY:"));
});
