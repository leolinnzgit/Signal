using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class UserPresence
{
    [Key]
    public string UserId { get; set; } = "";

    public DateTime LastSeenAtUtc { get; set; } = DateTime.UtcNow;

    public ApplicationUser User { get; set; } = null!;
}
