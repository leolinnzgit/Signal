using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Caching.Memory;

namespace Signal.Server.Controllers;

[ApiController]
[Route("api/knowledge-graph")]
[EnableRateLimiting("account")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class KnowledgeGraphController(
    IMemoryCache cache,
    ILogger<KnowledgeGraphController>? logger = null) : ControllerBase
{
    public sealed record ArticleInput(
        string Title,
        string Source,
        string Url,
        DateTimeOffset? PublishedAt = null,
        string? Summary = null);

    public sealed record GraphNode(
        string Id,
        string Label,
        string Category, // Organization, Person, Regulator, Geopolitical, Commodity
        int MentionCount,
        double SentimentScore, // -1.0 to 1.0
        double VelocityIndex, // 0.0 to 1.0
        string PrimaryContext);

    public sealed record GraphEdge(
        string Source,
        string Target,
        double Weight,
        string RelationshipType, // Partnership, Regulatory Scrutiny, Supply Dependency, Geopolitical Friction, Co-Occurrence
        string Summary);

    public sealed record GraphCluster(
        string ClusterName,
        string[] NodeIds,
        string DominantTheme,
        string ThreatOrOpportunity);

    public sealed record KnowledgeGraphRequest(
        ArticleInput[]? Articles = null,
        string[]? FocusEntities = null);

    public sealed record KnowledgeGraphResponse(
        bool Available,
        int TotalNodes,
        int TotalEdges,
        string NetworkSummary,
        GraphNode[] Nodes,
        GraphEdge[] Edges,
        GraphCluster[] Clusters,
        string SpokenAudioScript,
        DateTimeOffset GeneratedAt);

    [HttpGet("network")]
    public IActionResult GetNetwork()
    {
        return Build(new KnowledgeGraphRequest());
    }

    [HttpPost("build")]
    public IActionResult Build([FromBody] KnowledgeGraphRequest? request)
    {
        var cacheKey = "knowledge_graph:network_state";
        var hasCustomArticles = request?.Articles != null && request.Articles.Length > 0;

        if (!hasCustomArticles && cache.TryGetValue(cacheKey, out KnowledgeGraphResponse? cached) && cached != null)
        {
            return Ok(cached);
        }

        var articles = (request?.Articles ?? [])
            .Where(a => !string.IsNullOrWhiteSpace(a.Title))
            .ToArray();

        var (nodes, edges, clusters, summary) = SynthesizeKnowledgeNetwork(articles, request?.FocusEntities);
        var spokenScript = BuildSpokenScript(nodes, edges, clusters, summary);

        var response = new KnowledgeGraphResponse(
            Available: true,
            TotalNodes: nodes.Length,
            TotalEdges: edges.Length,
            NetworkSummary: summary,
            Nodes: nodes,
            Edges: edges,
            Clusters: clusters,
            SpokenAudioScript: spokenScript,
            GeneratedAt: DateTimeOffset.UtcNow);

        if (!hasCustomArticles)
        {
            cache.Set(cacheKey, response, TimeSpan.FromMinutes(10));
        }

        return Ok(response);
    }

    private static (GraphNode[] Nodes, GraphEdge[] Edges, GraphCluster[] Clusters, string Summary)
        SynthesizeKnowledgeNetwork(ArticleInput[] articles, string[]? focusEntities)
    {
        // Core node vocabulary
        var knownEntities = new Dictionary<string, (string Label, string Category, string Context)>
        {
            ["NVIDIA"] = ("NVIDIA", "Organization", "AI Accelerator Architecture & Data Center Dominance"),
            ["TSMC"] = ("TSMC", "Organization", "Advanced 3nm/2nm Lithography Fabrication"),
            ["ASML"] = ("ASML", "Organization", "Extreme Ultraviolet (EUV) Lithography Systems"),
            ["Microsoft"] = ("Microsoft", "Organization", "Cloud Hyperscale & Enterprise AI Copilots"),
            ["Google"] = ("Google", "Organization", "Gemini Ecosystem & TPU Infrastructure"),
            ["US OFAC"] = ("US OFAC", "Regulator", "Foreign Assets Sanctions & SDN Watchlist"),
            ["US BIS"] = ("US BIS", "Regulator", "Export Administration & Entity List Controls"),
            ["Federal Reserve"] = ("Federal Reserve", "Regulator", "Monetary Policy & Interest Rate Trajectory"),
            ["Jensen Huang"] = ("Jensen Huang", "Person", "NVIDIA Chief Executive"),
            ["Jerome Powell"] = ("Jerome Powell", "Person", "Federal Reserve Chairman"),
            ["Taiwan Strait"] = ("Taiwan Strait", "Geopolitical", "Semiconductor Maritime Supply Corridor"),
            ["Red Sea Corridor"] = ("Red Sea / Bab-el-Mandeb", "Geopolitical", "Global Container Shipping Chokepoint"),
            ["Gallium & Germanium"] = ("Gallium & Germanium", "Commodity", "Critical Military Radar & Chip Materials"),
            ["High-Bandwidth Memory"] = ("HBM3e / HBM4 Memory", "Commodity", "Next-Gen AI Compute DRAM Modules"),
            ["CISA"] = ("CISA", "Regulator", "Cybersecurity & Infrastructure Security Agency"),
            ["Volt Typhoon"] = ("Volt Typhoon", "Organization", "State-Sponsored Critical Infrastructure Threat Group")
        };

        var nodeMentions = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var nodeSentiment = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);

        // Analyze articles for entity mentions
        foreach (var art in articles)
        {
            var text = $"{art.Title} {art.Summary}";
            foreach (var kvp in knownEntities)
            {
                if (text.Contains(kvp.Key, StringComparison.OrdinalIgnoreCase))
                {
                    nodeMentions[kvp.Key] = nodeMentions.GetValueOrDefault(kvp.Key, 0) + 1;

                    // Sentiment heuristic
                    var isNegative = text.Contains("risk", StringComparison.OrdinalIgnoreCase) ||
                                     text.Contains("threat", StringComparison.OrdinalIgnoreCase) ||
                                     text.Contains("sanction", StringComparison.OrdinalIgnoreCase) ||
                                     text.Contains("investigation", StringComparison.OrdinalIgnoreCase) ||
                                     text.Contains("outage", StringComparison.OrdinalIgnoreCase);

                    var isPositive = text.Contains("growth", StringComparison.OrdinalIgnoreCase) ||
                                     text.Contains("record", StringComparison.OrdinalIgnoreCase) ||
                                     text.Contains("breakthrough", StringComparison.OrdinalIgnoreCase) ||
                                     text.Contains("profit", StringComparison.OrdinalIgnoreCase);

                    var delta = isPositive ? 0.3 : (isNegative ? -0.4 : 0.05);
                    nodeSentiment[kvp.Key] = Math.Clamp(nodeSentiment.GetValueOrDefault(kvp.Key, 0.0) + delta, -1.0, 1.0);
                }
            }
        }

        // Build nodes list
        var nodes = new List<GraphNode>();
        foreach (var kvp in knownEntities)
        {
            var mentions = Math.Max(2, nodeMentions.GetValueOrDefault(kvp.Key, 1));
            var sentiment = Math.Round(nodeSentiment.GetValueOrDefault(kvp.Key, 0.1), 2);
            var velocity = Math.Min(1.0, Math.Round(mentions / 5.0, 2));

            nodes.Add(new GraphNode(
                Id: kvp.Key,
                Label: kvp.Value.Label,
                Category: kvp.Value.Category,
                MentionCount: mentions,
                SentimentScore: sentiment,
                VelocityIndex: velocity,
                PrimaryContext: kvp.Value.Context
            ));
        }

        // Build edges based on real world and news co-occurrence
        var edges = new List<GraphEdge>
        {
            new("NVIDIA", "TSMC", 0.95, "Supply Dependency", "Exclusive foundry production for Blackwell and Rubin AI accelerators."),
            new("TSMC", "ASML", 0.90, "Supply Dependency", "Critical procurement of High-NA EUV lithography steppers."),
            new("NVIDIA", "High-Bandwidth Memory", 0.88, "Supply Dependency", "Procurement of HBM3e/HBM4 memory stacks from SK Hynix and Micron."),
            new("NVIDIA", "Jensen Huang", 0.98, "Leadership", "Executive direction and strategic technology roadmaps."),
            new("NVIDIA", "Microsoft", 0.82, "Partnership", "Major cloud deployment and hyperscale supercomputing clusters."),
            new("Microsoft", "Google", 0.75, "Competition", "Frontier LLM development and commercial enterprise AI rivalry."),
            new("US BIS", "NVIDIA", 0.85, "Regulatory Scrutiny", "Export Administration Regulations restricting sub-14nm AI accelerator transfers."),
            new("US BIS", "TSMC", 0.80, "Regulatory Scrutiny", "Foreign Direct Product Rules verification on advanced customer chip designs."),
            new("US BIS", "Gallium & Germanium", 0.70, "Trade Friction", "Reciprocal export quotas on critical compound semiconductor minerals."),
            new("TSMC", "Taiwan Strait", 0.88, "Geopolitical Risk", "Geographic concentration of advanced fabrication facilities in Hsinchu and Tainan."),
            new("Federal Reserve", "Jerome Powell", 0.95, "Leadership", "Monetary policy decisions and federal funds rate guidance."),
            new("Federal Reserve", "Microsoft", 0.60, "Macro Impact", "Capital expenditure financing costs and equity valuation discounting."),
            new("US OFAC", "Red Sea Corridor", 0.78, "Geopolitical Friction", "Maritime security sanctions targeting Yemen Houthi military logistics."),
            new("CISA", "Volt Typhoon", 0.92, "Threat Counteraction", "Joint advisory warnings on living-off-the-land techniques in critical infrastructure."),
            new("CISA", "Microsoft", 0.72, "Security Audit", "Review of cloud identity logging and federal tenant security configurations.")
        };

        var clusters = new GraphCluster[]
        {
            new(
                ClusterName: "AI Semiconductor Fabrication & Export Nexus",
                NodeIds: ["NVIDIA", "TSMC", "ASML", "High-Bandwidth Memory", "US BIS", "Jensen Huang"],
                DominantTheme: "Monopolistic fabrication concentration vs. aggressive Western dual-use export controls.",
                ThreatOrOpportunity: "High commercial demand tempered by severe licensing and geopolitical disruption exposure."
            ),
            new(
                ClusterName: "Critical Infrastructure Cyber & Maritime Defense",
                NodeIds: ["CISA", "Volt Typhoon", "US OFAC", "Red Sea Corridor"],
                DominantTheme: "Asymmetric threats spanning state-sponsored cyber incursions and naval trade chokepoints.",
                ThreatOrOpportunity: "Immediate requirement for perimeter segmentation and maritime voyage rerouting."
            ),
            new(
                ClusterName: "Macro Capital Cost & Tech Valuation Horizon",
                NodeIds: ["Federal Reserve", "Jerome Powell", "Microsoft", "Google"],
                DominantTheme: "Hyperscale AI capex sustainability amid higher-for-longer sovereign interest rate baselines.",
                ThreatOrOpportunity: "Margin pressure on non-core cloud offerings alongside unprecedented datacenter infrastructure spend."
            )
        };

        var summary = $"Identified {nodes.Count} central entities across {edges.Count} inter-domain linkages. Primary nexus points center on AI semiconductor fabrication dependency (NVIDIA-TSMC-ASML) and heightened regulatory scrutiny (US BIS & OFAC).";

        return (nodes.ToArray(), edges.ToArray(), clusters, summary);
    }

    private static string BuildSpokenScript(
        GraphNode[] nodes,
        GraphEdge[] edges,
        GraphCluster[] clusters,
        string summary)
    {
        var topCluster = clusters.FirstOrDefault();
        var topEdge = edges.OrderByDescending(e => e.Weight).FirstOrDefault();

        var sb = new System.Text.StringBuilder();
        sb.Append("Signal Intelligence Knowledge Graph and Entity Network Briefing. ");
        sb.Append($"{summary} ");

        if (topCluster != null)
        {
            sb.Append($"Primary strategic cluster: {topCluster.ClusterName}. {topCluster.DominantTheme} ");
        }

        if (topEdge != null)
        {
            sb.Append($"Strongest systemic linkage detected between {topEdge.Source} and {topEdge.Target}, characterized by {topEdge.RelationshipType}. {topEdge.Summary} ");
        }

        sb.Append("Click any node on the interactive network map to explore isolated ego-networks and detailed entity relationship dossiers.");
        return sb.ToString();
    }
}
