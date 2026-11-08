using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class ExecutiveTripwire
{
    [Required]
    public string Id { get; set; } = "";

    [Required]
    public string UserId { get; set; } = "";

    public ApplicationUser User { get; set; } = null!;

    [Required]
    public string Name { get; set; } = "";

    [Required]
    public string KeywordsJson { get; set; } = "[]";

    [Required]
    public string TargetSuiteId { get; set; } = "radar";

    [Required]
    public string TargetEntityId { get; set; } = "";

    [Required]
    public string Severity { get; set; } = "High";

    public bool Enabled { get; set; } = true;

    public bool PushOnMatch { get; set; } = true;

    public int TriggerCount { get; set; }

    public DateTime? LastTriggeredAtUtc { get; set; }

    [Required]
    public string LastMatchedTitle { get; set; } = "";

    [Required]
    public string LastMatchedUrl { get; set; } = "";

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}
