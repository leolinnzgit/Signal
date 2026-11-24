using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class StoredNewsArticle
{
    public long Id { get; set; }

    [Required]
    public string UserId { get; set; } = "";

    public ApplicationUser User { get; set; } = null!;

    [Required]
    public string Url { get; set; } = "";

    [Required]
    public string Title { get; set; } = "";

    [Required]
    public string Source { get; set; } = "";

    public DateTime PublishedAtUtc { get; set; }

    [Required]
    public string Summary { get; set; } = "";

    [Required]
    public string FullText { get; set; } = "";

    [Required]
    public string ImageUrl { get; set; } = "";

    [Required]
    public string TopicsJson { get; set; } = "[]";

    [Required]
    public string ProvidersJson { get; set; } = "[]";

    [Required]
    public string MarketQuotesJson { get; set; } = "[]";

    public DateTime FirstSeenAtUtc { get; set; } = DateTime.UtcNow;

    public DateTime LastSeenAtUtc { get; set; } = DateTime.UtcNow;

    public bool IsBookmarked { get; set; }

    public DateTime? BookmarkedAtUtc { get; set; }

    public bool IsRead { get; set; }

    public DateTime? ReadAtUtc { get; set; }

    [Required]
    public string LocationName { get; set; } = "";

    public double? LocationLatitude { get; set; }

    public double? LocationLongitude { get; set; }

    public DateTime? LocationExtractedAtUtc { get; set; }
}

public sealed record ArticleMarketQuote(
    string Topic,
    string Symbol,
    string Name,
    string Exchange,
    string Currency,
    decimal Price,
    decimal Change,
    decimal PercentChange,
    string QuoteTime,
    bool? IsMarketOpen,
    DateTime RecordedAtUtc,
    decimal? ExtendedPrice = null,
    decimal? ExtendedChange = null,
    decimal? ExtendedPercentChange = null,
    string? ExtendedQuoteTime = null,
    string? ExtendedSession = null);
