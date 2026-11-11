namespace Signal.Server.Models;

public sealed class SharedAiAnalysis
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public ApplicationUser User { get; set; } = null!;
    public string ContentHash { get; set; } = "";
    public string Topic { get; set; } = "";
    public string UserPrompt { get; set; } = "";
    public string Headline { get; set; } = "";
    public string Analysis { get; set; } = "";
    public string KeyDriversJson { get; set; } = "[]";
    public string PerspectivesJson { get; set; } = "[]";
    public string WatchNextJson { get; set; } = "[]";
    public string Sentiment { get; set; } = "neutral";
    public string CitationsJson { get; set; } = "[]";
    public string MarketQuoteJson { get; set; } = "";
    public string Model { get; set; } = "";
    public string Language { get; set; } = "en";
    public string CoverageNote { get; set; } = "";
    public DateTime CreatedAtUtc { get; set; }
}
