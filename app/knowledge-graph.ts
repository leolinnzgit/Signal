// Interactive Intelligence Knowledge Graph (Entity Network Explorer)

export interface GraphNode {
  id: string;
  label: string;
  category: "Organization" | "Person" | "Regulator" | "Geopolitical" | "Commodity";
  mentionCount: number;
  sentimentScore: number; // -1.0 to 1.0
  velocityIndex: number;  // 0.0 to 1.0
  primaryContext: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  relationshipType: string;
  summary: string;
}

export interface GraphCluster {
  clusterName: string;
  nodeIds: string[];
  dominantTheme: string;
  threatOrOpportunity: string;
}

export interface KnowledgeGraphResponse {
  available: boolean;
  totalNodes: number;
  totalEdges: number;
  networkSummary: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  spokenAudioScript: string;
  generatedAt: string;
}

export interface SimulatedNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface FetchKnowledgeGraphOptions {
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  focusEntities?: string[];
  signal?: AbortSignal;
}

export async function fetchKnowledgeGraph(
  options?: FetchKnowledgeGraphOptions,
  fetcher: typeof fetch = fetch
): Promise<KnowledgeGraphResponse> {
  const hasArticles = options?.articles && options.articles.length > 0;
  const endpoint = hasArticles ? "/api/knowledge-graph/build" : "/api/knowledge-graph/network";
  const method = hasArticles ? "POST" : "GET";

  let token = "";
  if (hasArticles && typeof window !== "undefined") {
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal: options?.signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (hasArticles) {
    headers["Content-Type"] = "application/json";
    if (token) {
      headers["X-XSRF-TOKEN"] = token;
    }
  }

  const response = await fetcher(endpoint, {
    method,
    headers,
    credentials: "same-origin",
    body: hasArticles ? JSON.stringify({ articles: options?.articles, focusEntities: options?.focusEntities }) : undefined,
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to load knowledge graph: HTTP ${response.status}`);
  }

  return (await response.json()) as KnowledgeGraphResponse;
}

export function formatKnowledgeGraphDigest(data: KnowledgeGraphResponse): string {
  const lines: string[] = [
    `🌐 SIGNAL INTERACTIVE INTELLIGENCE KNOWLEDGE GRAPH`,
    `Network Summary: ${data.networkSummary}`,
    `Entities Tracked: ${data.totalNodes} | Relationships Identified: ${data.totalEdges}`,
    `Generated: ${new Date(data.generatedAt).toLocaleString()}`,
    ``,
    `STRATEGIC ENTITY CLUSTERS:`,
  ];

  for (const c of data.clusters) {
    lines.push(`  • [${c.clusterName}]`);
    lines.push(`    Nodes: ${c.nodeIds.join(", ")}`);
    lines.push(`    Theme: ${c.dominantTheme}`);
    lines.push(`    Outlook: ${c.threatOrOpportunity}`);
  }

  lines.push(``);
  lines.push(`KEY ENTITY NODES & VELOCITY:`);
  for (const n of data.nodes) {
    const sent = n.sentimentScore > 0 ? `+${n.sentimentScore}` : `${n.sentimentScore}`;
    lines.push(`  • [${n.category.toUpperCase()}] ${n.label} (Mentions: ${n.mentionCount}, Sentiment: ${sent}, Velocity: ${n.velocityIndex})`);
    lines.push(`    Context: ${n.primaryContext}`);
  }

  lines.push(``);
  lines.push(`CRITICAL SYSTEMIC RELATIONSHIPS:`);
  for (const e of data.edges) {
    lines.push(`  • ${e.source} ──[${e.relationshipType} (${Math.round(e.weight * 100)}%)]──> ${e.target}`);
    lines.push(`    ${e.summary}`);
  }

  return lines.join("\n");
}

export function getCategoryColor(category: string): string {
  switch (category) {
    case "Organization":
      return "#38bdf8"; // Sky blue
    case "Person":
      return "#a78bfa"; // Purple
    case "Regulator":
      return "#fbbf24"; // Amber/gold
    case "Geopolitical":
      return "#f87171"; // Rose/red
    case "Commodity":
      return "#34d399"; // Emerald
    default:
      return "#94a3b8"; // Slate
  }
}

export function initializeSimulation(
  nodes: GraphNode[],
  width: number,
  height: number
): SimulatedNode[] {
  const radiusCenter = Math.min(width, height) * 0.35;
  const cx = width / 2;
  const cy = height / 2;

  return nodes.map((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * 2 * Math.PI;
    const r = radiusCenter * (0.6 + 0.4 * (i % 3));
    return {
      ...n,
      x: cx + r * Math.cos(angle) + (Math.random() - 0.5) * 40,
      y: cy + r * Math.sin(angle) + (Math.random() - 0.5) * 40,
      vx: 0,
      vy: 0,
      radius: Math.max(16, Math.min(32, 14 + n.mentionCount * 3)),
    };
  });
}

export function stepSimulation(
  nodes: SimulatedNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
  alpha = 0.05
): void {
  const cx = width / 2;
  const cy = height / 2;

  // Node to node repulsion (Coulomb)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy || 1;
      const dist = Math.sqrt(distSq);
      const minDist = a.radius + b.radius + 30;

      if (dist < 400) {
        const force = (minDist * minDist) / (distSq * 1.5);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  // Edge attraction (Hooke's law)
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const s = nodeMap.get(edge.source);
    const t = nodeMap.get(edge.target);
    if (!s || !t) continue;

    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const targetDist = 120 + (1 - edge.weight) * 100;
    const force = (dist - targetDist) * 0.05 * edge.weight;

    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    s.vx += fx;
    s.vy += fy;
    t.vx -= fx;
    t.vy -= fy;
  }

  // Centering gravity & position update with damping
  const damping = 0.85;
  for (const node of nodes) {
    const gx = (cx - node.x) * 0.005;
    const gy = (cy - node.y) * 0.005;
    node.vx = (node.vx + gx) * damping;
    node.vy = (node.vy + gy) * damping;

    node.x += node.vx * alpha;
    node.y += node.vy * alpha;

    // Soft bounds
    const pad = node.radius + 20;
    node.x = Math.max(pad, Math.min(width - pad, node.x));
    node.y = Math.max(pad, Math.min(height - pad, node.y));
  }
}
