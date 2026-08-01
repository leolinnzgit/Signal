namespace Signal.Server.Models;

public sealed class UserProfilePhoto
{
    public string UserId { get; set; } = "";

    public byte[] ImageBytes { get; set; } = [];

    public DateTime UpdatedAtUtc { get; set; }

    public ApplicationUser User { get; set; } = null!;
}
