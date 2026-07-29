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
    public string ImageUrl { get; set; } = "";

    [Required]
    public string TopicsJson { get; set; } = "[]";

    [Required]
    public string ProvidersJson { get; set; } = "[]";

    public DateTime FirstSeenAtUtc { get; set; } = DateTime.UtcNow;

    public DateTime LastSeenAtUtc { get; set; } = DateTime.UtcNow;

    public bool IsBookmarked { get; set; }

    public DateTime? BookmarkedAtUtc { get; set; }

    public bool IsRead { get; set; }

    public DateTime? ReadAtUtc { get; set; }
}
