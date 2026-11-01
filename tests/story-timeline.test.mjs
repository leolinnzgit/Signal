import test from "node:test";
import assert from "node:assert/strict";
import { fetchStoryTimeline, synthesizeTimelineLocally } from "../app/daily-briefing-timeline.ts";

test("synthesizeTimelineLocally produces structured chronological milestones", () => {
  const articles = [
    { title: "NZ Wind Farm Approved", source: "NZ Herald", summary: "Consents issued for $200M wind farm." },
    { title: "Grid Capacity Concerns", source: "RNZ", summary: "Transmission constraints noted." },
  ];
  const res = synthesizeTimelineLocally("Renewable Energy", articles);
  assert.ok(res.milestones.length >= 3, "Expected at least 3 milestones");
  assert.equal(res.milestones[0].phase, "Past Context");
  assert.equal(res.milestones[1].phase, "Today's Catalyst");
  assert.equal(res.milestones[2].phase, "Today's Catalyst");
  assert.equal(res.milestones[3].phase, "Forward Milestone");
  assert.ok(res.milestones[1].headline.includes("NZ Wind Farm Approved"));
});

test("fetchStoryTimeline uses fetcher when online", async () => {
  const mockFetch = async (url, opts) => {
    assert.equal(url, "/api/story-cluster/timeline");
    assert.equal(opts.method, "POST");
    const body = JSON.parse(opts.body);
    assert.equal(body.topic, "AI Regulation");
    return {
      ok: true,
      json: async () => ({
        available: true,
        topic: "AI Regulation",
        milestones: [
          { phase: "Historical Roots", dateOrEra: "2023", headline: "EU AI Act Drafted", summary: "Initial regulation drafted." },
          { phase: "Today's Catalyst", dateOrEra: "Today", headline: "Enforcement Starts", summary: "Compliance phase begins." },
          { phase: "Future Catalyst", dateOrEra: "2027", headline: "Global Treaty Review", summary: "International alignment check." },
        ],
      }),
    };
  };

  const res = await fetchStoryTimeline(
    "AI Regulation",
    [{ title: "Enforcement Starts", summary: "Compliance phase begins." }],
    undefined,
    mockFetch,
  );

  assert.equal(res.milestones.length, 3);
  assert.equal(res.milestones[0].headline, "EU AI Act Drafted");
  assert.equal(res.milestones[1].phase, "Today's Catalyst");
});

test("fetchStoryTimeline falls back to local synthesis when offline or network fails", async () => {
  const failFetch = async () => {
    throw new Error("Network down");
  };

  const res = await fetchStoryTimeline(
    "Space Exploration",
    [{ title: "Mars Rover Finds Water", summary: "Ice detected." }],
    undefined,
    failFetch,
  );

  assert.ok(res.milestones.length >= 3);
  assert.equal(res.milestones[1].headline, "Mars Rover Finds Water");
});
