using System.Text;
using System.Text.RegularExpressions;

namespace Signal.Server.Services;

public static partial class ArticleIdentity
{
    private static readonly string[] TrackingParameterPrefixes = ["utm_", "syn-"];
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
        "maca",
        "cmp",
        "traffic_source",
        "at_medium",
        "at_campaign",
    };

    public static string? NormalizeUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        if (trimmed.Length > 2048 || !Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return null;
        if ((uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || !string.IsNullOrEmpty(uri.UserInfo))
            return null;
        var normalized = uri.AbsoluteUri;
        return normalized.Length <= 2048 ? normalized : null;
    }

    public static string[] GetUrlLookupCandidates(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return [];
        var trimmed = value.Trim();
        var candidates = new List<string>(3);
        var normalized = NormalizeUrl(trimmed);
        if (normalized is not null)
        {
            candidates.Add(normalized);
            try
            {
                var unescaped = Uri.UnescapeDataString(normalized);
                if (unescaped.Length <= 2048
                    && !candidates.Contains(unescaped, StringComparer.OrdinalIgnoreCase))
                {
                    candidates.Add(unescaped);
                }
            }
            catch (UriFormatException)
            {
            }
        }
        if (trimmed.Length <= 2048 && !candidates.Contains(trimmed, StringComparer.OrdinalIgnoreCase))
            candidates.Add(trimmed);
        return [.. candidates];
    }

    public static string GetHeadlineKey(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return "";
        var normalized = title.Normalize(NormalizationForm.FormKC).ToLowerInvariant()
            .Replace('\u2018', '\'')
            .Replace('\u2019', '\'')
            .Replace('\u201C', '"')
            .Replace('\u201D', '"')
            .Replace('\u2010', '-')
            .Replace('\u2011', '-')
            .Replace('\u2012', '-')
            .Replace('\u2013', '-')
            .Replace('\u2014', '-');
        normalized = WhitespaceRegex().Replace(normalized, " ").Trim();
        normalized = TrailingPunctuationRegex().Replace(normalized, "").Trim();
        return normalized;
    }

    public static string GetStoryUrlKey(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var trimmed = value.Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
            return trimmed;

        var host = uri.DnsSafeHost.ToLowerInvariant();
        if (host.StartsWith("www.", StringComparison.Ordinal)) host = host[4..];

        var path = NormalizePublisherPath(host, uri.AbsolutePath);
        if (path.Length > 1) path = path.TrimEnd('/');

        var query = FilterAndSortQuery(uri.Query);
        var scheme = uri.Scheme.ToLowerInvariant();
        var portPart = uri.IsDefaultPort ? "" : $":{uri.Port}";
        return query.Length > 0
            ? $"{scheme}://{host}{portPart}{path}?{query}"
            : $"{scheme}://{host}{portPart}{path}";
    }

    public static IReadOnlyList<T[]> GroupDuplicates<T>(
        IReadOnlyList<T> items,
        Func<T, string> getTitle,
        Func<T, string> getUrl)
    {
        if (items.Count == 0) return [];

        var parents = new int[items.Count];
        for (var i = 0; i < parents.Length; i++) parents[i] = i;
        var identities = new Dictionary<string, int>(StringComparer.Ordinal);

        int Root(int index)
        {
            while (parents[index] != index)
            {
                parents[index] = parents[parents[index]];
                index = parents[index];
            }
            return index;
        }

        for (var index = 0; index < items.Count; index++)
        {
            var item = items[index];
            var titleKey = GetHeadlineKey(getTitle(item));
            var urlKey = GetStoryUrlKey(getUrl(item));
            if (titleKey.Length > 0) LinkKey($"title:{titleKey}", index);
            if (urlKey.Length > 0) LinkKey($"url:{urlKey}", index);
        }

        void LinkKey(string key, int index)
        {
            if (!identities.TryGetValue(key, out var existing))
                identities[key] = index;
            else
                parents[Root(index)] = Root(existing);
        }

        var groups = new Dictionary<int, List<T>>();
        var order = new List<int>();
        for (var index = 0; index < items.Count; index++)
        {
            var root = Root(index);
            if (!groups.TryGetValue(root, out var group))
            {
                group = [];
                groups[root] = group;
                order.Add(root);
            }
            group.Add(items[index]);
        }

        return order.Select(root => groups[root].ToArray()).ToArray();
    }

    public static bool IsGoogleNewsWrapperUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.DnsSafeHost.Equals("news.google.com", StringComparison.OrdinalIgnoreCase);

    private static string NormalizePublisherPath(string host, string path)
    {
        if (host.Equals("dw.com", StringComparison.Ordinal))
        {
            var match = DwArticlePathRegex().Match(path);
            if (match.Success)
            {
                var lang = match.Groups[1].Value.ToLowerInvariant();
                var id = match.Groups[2].Value.ToLowerInvariant();
                return lang.Length > 0 ? $"/{lang}/{id}" : $"/{id}";
            }
        }
        else if (host.Equals("channelnewsasia.com", StringComparison.Ordinal))
        {
            var match = CnaArticlePathRegex().Match(path);
            if (match.Success)
                return $"/{match.Groups[1].Value.ToLowerInvariant()}/{match.Groups[2].Value}";
        }
        else if (host.Equals("cbc.ca", StringComparison.Ordinal))
        {
            var match = CbcArticlePathRegex().Match(path);
            if (match.Success)
                return $"/news/{match.Groups[1].Value}";
        }
        else if (host.Equals("abc.net.au", StringComparison.Ordinal))
        {
            var match = AbcArticlePathRegex().Match(path);
            if (match.Success)
                return $"/news/{match.Groups[1].Value}";
        }
        else if (host.Equals("stuff.co.nz", StringComparison.Ordinal))
        {
            var match = StuffArticlePathRegex().Match(path);
            if (match.Success)
                return $"/{match.Groups[1].Value}";
        }

        return path;
    }

    private static string FilterAndSortQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query)) return "";
        var parameters = query.TrimStart('?')
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(parameter => !IsTrackingParameter(parameter))
            .ToArray();
        if (parameters.Length == 0) return "";
        Array.Sort(parameters, StringComparer.Ordinal);
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

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex(@"[.!?。！？]+$")]
    private static partial Regex TrailingPunctuationRegex();

    [GeneratedRegex(@"^/(?:([a-z]{2}(?:-[a-z]{2})?)/)?[^/]+/(a-\d+)/?$", RegexOptions.IgnoreCase)]
    private static partial Regex DwArticlePathRegex();

    [GeneratedRegex(@"^/([^/]+)/[^/]*-(\d{6,})/?$", RegexOptions.IgnoreCase)]
    private static partial Regex CnaArticlePathRegex();

    [GeneratedRegex(@"^/news(?:/[^/]+)+/[^/]*-(\d+\.\d+)/?$", RegexOptions.IgnoreCase)]
    private static partial Regex CbcArticlePathRegex();

    [GeneratedRegex(@"^/news/\d{4}-\d{2}-\d{2}/[^/]+/(\d{6,})/?$", RegexOptions.IgnoreCase)]
    private static partial Regex AbcArticlePathRegex();

    [GeneratedRegex(@"^/(?:[^/]+/)*(\d{8,})/[^/]+/?$", RegexOptions.IgnoreCase)]
    private static partial Regex StuffArticlePathRegex();
}
