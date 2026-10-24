namespace Signal.Server.Models;

/// <summary>A native installation. Browser replacement is scoped to one explicitly linked endpoint.</summary>
public sealed class NativeNotificationDevice
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Token { get; set; } = "";
    public string Kind { get; set; } = "phone";
    public string? BrowserEndpoint { get; set; }
    public DateTime ExpiresAtUtc { get; set; }
}
