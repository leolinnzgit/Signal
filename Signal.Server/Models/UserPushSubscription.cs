namespace Signal.Server.Models;

public sealed class UserPushSubscription
{
    public long Id { get; set; }

    public string UserId { get; set; } = "";

    public string Endpoint { get; set; } = "";

    public string P256Dh { get; set; } = "";

    public string Auth { get; set; } = "";

    public DateTime CreatedAtUtc { get; set; }

    public DateTime UpdatedAtUtc { get; set; }

    public ApplicationUser User { get; set; } = null!;
}
