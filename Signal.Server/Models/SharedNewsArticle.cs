namespace Signal.Server.Models;

public sealed class SharedNewsArticle
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public ApplicationUser User { get; set; } = null!;
    public string ContentHash { get; set; } = "";
    public string OriginalUrl { get; set; } = "";
    public string Title { get; set; } = "";
    public string Source { get; set; } = "";
    public string Byline { get; set; } = "";
    public string Language { get; set; } = "";
    public string ParagraphsJson { get; set; } = "[]";
    public bool SummaryOnly { get; set; }
    public DateTime CreatedAtUtc { get; set; }
}
