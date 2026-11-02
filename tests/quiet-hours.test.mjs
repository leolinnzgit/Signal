import test from "node:test";
import assert from "node:assert/strict";
import {
  isTimeInQuietHours,
  evaluateTriageLocally,
  evaluateQuietHoursTriage,
  DEFAULT_QUIET_HOURS,
} from "../app/quiet-hours.ts";

test("isTimeInQuietHours handles overnight window correctly", () => {
  const config = {
    ...DEFAULT_QUIET_HOURS,
    startTime: "22:00",
    endTime: "06:30",
    activeDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  };

  // 23:30 is in quiet hours
  const nightTime = new Date("2026-11-02T23:30:00");
  assert.equal(isTimeInQuietHours(nightTime, config), true);

  // 04:15 is in quiet hours
  const earlyMorning = new Date("2026-11-02T04:15:00");
  assert.equal(isTimeInQuietHours(earlyMorning, config), true);

  // 14:00 is NOT in quiet hours
  const afternoon = new Date("2026-11-02T14:00:00");
  assert.equal(isTimeInQuietHours(afternoon, config), false);
});

test("evaluateTriageLocally suppresses routine news during active quiet hours", () => {
  const activeConfig = {
    ...DEFAULT_QUIET_HOURS,
    startTime: "00:00",
    endTime: "23:59", // Always active for test
  };

  const routineArticle = {
    title: "Regional Council Approves Public Transport Timetable Update",
    source: "RNZ News",
    summary: "New bus schedules commence from Monday across eastern routes.",
  };

  const result = evaluateTriageLocally(routineArticle, activeConfig);

  assert.equal(result.isQuietHoursActive, true);
  assert.equal(result.triageAction, "suppress_to_morning_briefing");
  assert.equal(result.breakthroughAllowed, false);
});

test("evaluateTriageLocally allows crisis keywords and market shocks to break through", () => {
  const activeConfig = {
    ...DEFAULT_QUIET_HOURS,
    startTime: "00:00",
    endTime: "23:59",
    shockThresholdPercent: 2.5,
    vipEntities: ["Fonterra"],
  };

  // Critical keyword + VIP match
  const vipCrisis = {
    title: "Fonterra Faces Urgent Regulatory Investigation Into Supply Contamination",
    source: "NZ Herald",
    summary: "Ministry confirms audit after probe initiated.",
  };
  const res1 = evaluateTriageLocally(vipCrisis, activeConfig);
  assert.equal(res1.triageAction, "break_through_crisis_alert");
  assert.equal(res1.breakthroughAllowed, true);
  assert.equal(res1.crisisSeverity, "Crisis");

  // Market price shock > threshold
  const marketShock = {
    title: "Wholesale Energy Utility Faces Sudden Trading Halt",
    source: "Bloomberg",
    priceChangePercent: -4.2,
    symbol: "MEL",
  };
  const res2 = evaluateTriageLocally(marketShock, activeConfig);
  assert.equal(res2.triageAction, "break_through_crisis_alert");
  assert.equal(res2.breakthroughAllowed, true);
  assert.equal(res2.crisisSeverity, "Crisis");
});
