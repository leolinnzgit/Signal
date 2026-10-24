namespace Signal.Server.Models;

// Shared by this account's watches; phone/browser news preferences are independent.
public sealed class WatchAlertPreferences
{
    public string UserId { get; set; } = "";
    public string TopicsJson { get; set; } = "[]";
    public string KeywordsJson { get; set; } = "[]";
}
