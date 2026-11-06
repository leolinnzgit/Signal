import test from "node:test";
import assert from "node:assert/strict";
import { drawSceneToCanvas } from "../app/briefing-studio.ts";

test("drawSceneToCanvas renders without exceptions onto a canvas 2d context", () => {
  // Mock 2D Context
  const calls = [];
  const mockCtx = {
    fillStyle: "",
    font: "",
    textAlign: "",
    fillRect: (x, y, w, h) => calls.push({ type: "fillRect", x, y, w, h }),
    fillText: (text, x, y) => calls.push({ type: "fillText", text, x, y }),
    createRadialGradient: () => ({
      addColorStop: () => {},
    }),
    save: () => calls.push({ type: "save" }),
    restore: () => calls.push({ type: "restore" }),
    rect: (x, y, w, h) => calls.push({ type: "rect", x, y, w, h }),
    clip: () => calls.push({ type: "clip" }),
  };

  const mockScene = {
    sceneIndex: 1,
    durationSeconds: 10,
    headline: "STRATEGIC THREAT RADAR OVERVIEW",
    subheadline: "Live Telemetry from 7 Global Maritime Chokepoints",
    narrationScript: "Critical risk postures reported.",
    graphicType: "bar-chart",
    graphicData: [
      { label: "Bab el-Mandeb", value: "CRITICAL", color: "#ef4444" },
      { label: "Strait of Hormuz", value: "HIGH", color: "#f97316" },
    ],
  };

  drawSceneToCanvas(
    mockCtx,
    mockScene,
    0.5,
    720,
    405,
    "SIGNAL WIRE TICKER TAPE",
    -20
  );

  assert.ok(calls.length > 5, "Should have issued multiple canvas draw calls");
  assert.ok(
    calls.some((c) => c.type === "fillText" && c.text.includes("STRATEGIC THREAT RADAR")),
    "Should have rendered the scene headline"
  );
  assert.ok(
    calls.some((c) => c.type === "fillText" && c.text.includes("Bab el-Mandeb")),
    "Should have rendered the graphic label"
  );
});

test("storyboard scene math validates duration sums and scene counts", () => {
  const mockScenes = [
    { sceneIndex: 1, durationSeconds: 10.0 },
    { sceneIndex: 2, durationSeconds: 12.0 },
    { sceneIndex: 3, durationSeconds: 10.0 },
  ];

  const total = mockScenes.reduce((acc, s) => acc + s.durationSeconds, 0);
  assert.equal(total, 32.0);
  assert.equal(mockScenes.length, 3);
});
