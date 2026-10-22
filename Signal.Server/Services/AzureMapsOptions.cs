namespace Signal.Server.Services;

public sealed class AzureMapsOptions
{
    public const string SectionName = "AzureMaps";
    public string SubscriptionKey { get; set; } = "";

    public bool Enabled => !string.IsNullOrWhiteSpace(SubscriptionKey)
        && SubscriptionKey.Trim().Length is >= 20 and <= 256
        && !SubscriptionKey.Any(char.IsWhiteSpace)
        && !SubscriptionKey.Any(char.IsControl);
}
