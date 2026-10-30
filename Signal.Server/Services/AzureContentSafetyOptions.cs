namespace Signal.Server.Services;

public sealed class AzureContentSafetyOptions
{
    public const string SectionName = "AzureContentSafety";

    public string Endpoint { get; set; } = "";
    public string SubscriptionKey { get; set; } = "";
    public int RejectionThreshold { get; set; } = 2; // FourSeverityLevels: 0 = Safe, 2 = Low, 4 = Medium, 6 = High

    public bool Enabled =>
        !string.IsNullOrWhiteSpace(SubscriptionKey)
        && SubscriptionKey.Trim().Length is >= 20 and <= 256
        && !SubscriptionKey.Any(char.IsWhiteSpace)
        && !SubscriptionKey.Any(char.IsControl)
        && !string.IsNullOrWhiteSpace(Endpoint)
        && Uri.TryCreate(Endpoint.Trim(), UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);
}
