namespace Signal.Server.Services;

public static class FeedUrlCanonicalizer
{
    private static readonly string[] TrackingParameterPrefixes = ["utm_"];
    private static readonly HashSet<string> TrackingParameters = new(StringComparer.OrdinalIgnoreCase)
    {
        "fbclid",
        "gclid",
        "dclid",
        "msclkid",
        "mc_cid",
        "mc_eid",
        "_hsenc",
        "_hsmi",
    };

    public static string? NormalizeForStorage(string value)
    {
        if (value.Length > 2048
            || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !uri.IsDefaultPort)
            return null;

        var builder = new UriBuilder(uri)
        {
            Fragment = "",
            Query = FilterQuery(uri.Query, sort: false),
        };
        return builder.Uri.AbsoluteUri;
    }

    public static string? GetComparisonKey(string value)
    {
        var normalized = NormalizeForStorage(value);
        if (normalized is null) return null;

        var builder = new UriBuilder(normalized);
        if (builder.Path.Length > 1) builder.Path = builder.Path.TrimEnd('/');
        builder.Query = FilterQuery(builder.Query, sort: true);
        return builder.Uri.AbsoluteUri;
    }

    private static string FilterQuery(string query, bool sort)
    {
        var parameters = query.TrimStart('?')
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(parameter => !IsTrackingParameter(parameter))
            .ToArray();
        if (sort) Array.Sort(parameters, StringComparer.Ordinal);
        return string.Join('&', parameters);
    }

    private static bool IsTrackingParameter(string parameter)
    {
        var separator = parameter.IndexOf('=');
        var rawName = separator < 0 ? parameter : parameter[..separator];
        string name;
        try
        {
            name = Uri.UnescapeDataString(rawName.Replace("+", " ", StringComparison.Ordinal));
        }
        catch (UriFormatException)
        {
            name = rawName;
        }

        return TrackingParameters.Contains(name)
            || TrackingParameterPrefixes.Any(prefix => name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }
}
