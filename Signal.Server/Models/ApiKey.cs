using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class ApiKey
{
    [Required]
    public string Id { get; set; } = "";

    [Required]
    public string UserId { get; set; } = "";

    public ApplicationUser? User { get; set; }

    [Required]
    public string Name { get; set; } = "";

    [Required]
    public string KeyPrefix { get; set; } = "";

    [Required]
    public string KeyHash { get; set; } = "";

    [Required]
    public string ScopesJson { get; set; } = "[\"news:read\"]";

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    public DateTime? ExpiresAtUtc { get; set; }

    public DateTime? LastUsedAtUtc { get; set; }

    public DateTime? RevokedAtUtc { get; set; }
}

public static class ApiKeyScopes
{
    public const string NewsRead = "news:read";

    public static readonly string[] All = [NewsRead];
}
