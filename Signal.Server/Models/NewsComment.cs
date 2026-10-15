using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class NewsComment
{
    public long Id { get; set; }

    [Required]
    public string ArticleUrl { get; set; } = "";

    [Required]
    public string ArticleTitle { get; set; } = "";

    public string? UserId { get; set; }

    public ApplicationUser? User { get; set; }

    [MaxLength(80)]
    public string GuestName { get; set; } = "";

    [Required]
    public string Body { get; set; } = "";

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}
