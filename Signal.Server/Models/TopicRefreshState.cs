using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class TopicRefreshState
{
    [Required]
    public string UserId { get; set; } = "";

    public ApplicationUser User { get; set; } = null!;

    [Required]
    public string TopicKey { get; set; } = "";

    [Required]
    public string Topic { get; set; } = "";

    public DateTime? LastAttemptedAtUtc { get; set; }

    public DateTime? LastSuccessfulAtUtc { get; set; }

    public DateTime? NextRefreshAtUtc { get; set; }

    public DateTime? LastViewedAtUtc { get; set; }

    public bool HasUnread { get; set; }

    [Required]
    public string LastError { get; set; } = "";
}
