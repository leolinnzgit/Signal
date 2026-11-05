import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchKnowledgeGraph,
  formatKnowledgeGraphDigest,
  getCategoryColor,
  initializeSimulation,
  stepSimulation,
} from "../app/knowledge-graph.ts";

test("fetchKnowledgeGraph calls GET /api/knowledge-graph/network when no articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    return {
      ok: true,
      json: async () => ({
        available: true,
        totalNodes: 2,
        totalEdges: 1,
        networkSummary: "Baseline test network.",
        nodes: [
          {
            id: "NVIDIA",
            label: "NVIDIA",
            category: "Organization",
            mentionCount: 5,
            sentimentScore: 0.4,
            velocityIndex: 0.8,
            primaryContext: "AI compute accelerators.",
          },
          {
            id: "TSMC",
            label: "TSMC",
            category: "Organization",
            mentionCount: 4,
            sentimentScore: 0.2,
            velocityIndex: 0.7,
            primaryContext: "Advanced foundry fabrication.",
          },
        ],
        edges: [
          {
            source: "NVIDIA",
            target: "TSMC",
            weight: 0.95,
            relationshipType: "Supply Dependency",
            summary: "Exclusive foundry partner.",
          },
        ],
        clusters: [
          {
            clusterName: "Semiconductor Nexus",
            nodeIds: ["NVIDIA", "TSMC"],
            dominantTheme: "Fabrication concentration.",
            threatOrOpportunity: "High commercial demand.",
          },
        ],
        spokenAudioScript: "Spoken network script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const result = await fetchKnowledgeGraph({}, mockFetcher);

  assert.equal(calledUrl, "/api/knowledge-graph/network");
  assert.equal(calledMethod, "GET");
  assert.equal(result.totalNodes, 2);
  assert.equal(result.nodes[0].label, "NVIDIA");
  assert.equal(result.edges[0].relationshipType, "Supply Dependency");
});

test("fetchKnowledgeGraph calls POST /api/knowledge-graph/build when articles provided", async () => {
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
        totalNodes: 1,
        totalEdges: 0,
        networkSummary: "Custom article network.",
        nodes: [],
        edges: [],
        clusters: [],
        spokenAudioScript: "Custom audio script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const articles = [
    { title: "NVIDIA unveils next-gen Blackwell architecture", source: "Bloomberg", url: "https://example.com/nv" },
  ];

  const result = await fetchKnowledgeGraph({ articles }, mockFetcher);

  assert.equal(calledUrl, "/api/knowledge-graph/build");
  assert.equal(calledMethod, "POST");
  assert.ok(calledBody.includes("Blackwell"));
  assert.equal(result.networkSummary, "Custom article network.");
});

test("fetchKnowledgeGraph rejects on HTTP error", async () => {
  const failingFetcher = async () => ({
    ok: false,
    status: 500,
  });

  await assert.rejects(
    async () => {
      await fetchKnowledgeGraph({}, failingFetcher);
    },
    /Failed to load knowledge graph: HTTP 500/
  );
});

test("formatKnowledgeGraphDigest formats complete text briefing", () => {
  const data = {
    available: true,
    totalNodes: 2,
    totalEdges: 1,
    networkSummary: "Strong interconnectedness in semiconductor supply chain.",
    nodes: [
      {
        id: "NVIDIA",
        label: "NVIDIA",
        category: "Organization",
        mentionCount: 6,
        sentimentScore: 0.5,
        velocityIndex: 0.9,
        primaryContext: "AI GPU dominance.",
      },
    ],
    edges: [
      {
        source: "NVIDIA",
        target: "TSMC",
        weight: 0.95,
        relationshipType: "Supply Dependency",
        summary: "Primary foundry.",
      },
    ],
    clusters: [
      {
        clusterName: "Compute Cluster",
        nodeIds: ["NVIDIA", "TSMC"],
        dominantTheme: "Advanced nodes.",
        threatOrOpportunity: "High growth.",
      },
    ],
    spokenAudioScript: "Spoken script.",
    generatedAt: "2026-11-05T09:00:00Z",
  };

  const text = formatKnowledgeGraphDigest(data);
  assert.ok(text.includes("SIGNAL INTERACTIVE INTELLIGENCE KNOWLEDGE GRAPH"));
  assert.ok(text.includes("Entities Tracked: 2"));
  assert.ok(text.includes("Compute Cluster"));
  assert.ok(text.includes("NVIDIA ──[Supply Dependency (95%)]──> TSMC"));
});

test("getCategoryColor returns distinct palette per category", () => {
  assert.equal(getCategoryColor("Organization"), "#38bdf8");
  assert.equal(getCategoryColor("Person"), "#a78bfa");
  assert.equal(getCategoryColor("Regulator"), "#fbbf24");
  assert.equal(getCategoryColor("Geopolitical"), "#f87171");
  assert.equal(getCategoryColor("Commodity"), "#34d399");
});

test("initializeSimulation and stepSimulation calculate positions smoothly", () => {
  const sampleNodes = [
    {
      id: "A",
      label: "Node A",
      category: "Organization",
      mentionCount: 3,
      sentimentScore: 0.1,
      velocityIndex: 0.4,
      primaryContext: "Context A",
    },
    {
      id: "B",
      label: "Node B",
      category: "Person",
      mentionCount: 2,
      sentimentScore: 0.2,
      velocityIndex: 0.3,
      primaryContext: "Context B",
    },
  ];

  const simNodes = initializeSimulation(sampleNodes, 800, 600);
  assert.equal(simNodes.length, 2);
  assert.ok(simNodes[0].x > 0);
  assert.ok(simNodes[0].y > 0);
  assert.ok(simNodes[0].radius >= 16);

  const edges = [
    { source: "A", target: "B", weight: 0.8, relationshipType: "Partnership", summary: "Collab" },
  ];

  // Run simulation steps
  stepSimulation(simNodes, edges, 800, 600, 0.05);

  assert.ok(!Number.isNaN(simNodes[0].x));
  assert.ok(!Number.isNaN(simNodes[0].y));
  assert.ok(simNodes[0].x > 0 && simNodes[0].x <= 800);
  assert.ok(simNodes[0].y > 0 && simNodes[0].y <= 600);
});
