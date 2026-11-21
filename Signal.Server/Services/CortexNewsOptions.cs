using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public sealed class CortexNewsOptions
{
    public const string SectionName = "CortexNews";
    public const int RetentionDays = 30;
    public bool Enabled { get; set; }
    public string Endpoint { get; set; } = "";
    public string IndexName { get; set; } = "signal-cortex-news-v1";
    public string QueryKey { get; set; } = "";
    public string AdminKey { get; set; } = "";
    public int MaxArticles { get; set; } = 1500;

    internal bool CanSearch => Enabled && EndpointUri is not null
        && !string.IsNullOrWhiteSpace(IndexName) && Regex.IsMatch(IndexName, "^[a-z0-9][a-z0-9-]{1,126}[a-z0-9]$")
        && !string.IsNullOrWhiteSpace(QueryKey);

    internal Uri? EndpointUri => Uri.TryCreate(Endpoint, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort && uri.UserInfo.Length == 0
        && uri.Host.EndsWith(".search.windows.net", StringComparison.OrdinalIgnoreCase)
        && uri.PathAndQuery == "/" && uri.Fragment.Length == 0
            ? uri : null;
}
