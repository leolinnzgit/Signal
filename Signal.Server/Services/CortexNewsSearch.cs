using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public interface ICortexNewsSearch
{
    Task<CortexPublicNewsHit[]?> SearchAsync(string query, CancellationToken cancellationToken);
    Task<CortexPublicNewsHit[]?> FindCoverageAsync(string title, string summary, DateTimeOffset? publishedAt,
        CancellationToken cancellationToken);
}

internal sealed class CortexNewsSearch(
    IHttpClientFactory clients,
    IOptions<CortexNewsOptions> options,
    ICortexNewsEmbeddings embeddings,
    ILogger<CortexNewsSearch> logger) : ICortexNewsSearch
{
    internal const string QueryClient = "CortexNewsQuery";

    public Task<CortexPublicNewsHit[]?> SearchAsync(string query, CancellationToken cancellationToken) =>
        SearchAsync(query, query, DateTimeOffset.UtcNow.AddDays(-CortexNewsOptions.RetentionDays), null, 5, cancellationToken);

    public Task<CortexPublicNewsHit[]?> FindCoverageAsync(string title, string summary, DateTimeOffset? publishedAt,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var cutoff = now.AddDays(-CortexNewsOptions.RetentionDays);
        DateTimeOffset? latest = null;
        if (publishedAt is { Year: >= 2000 } date && date <= now.AddDays(1))
        {
            latest = date.AddDays(3);
            cutoff = date.AddDays(-3) > cutoff ? date.AddDays(-3) : cutoff;
            if (latest < cutoff) return Task.FromResult<CortexPublicNewsHit[]?>([]);
        }

        var meaning = string.IsNullOrWhiteSpace(summary) ? title : $"{title}. {summary}";
        return SearchAsync(title, meaning, cutoff, latest, 15, cancellationToken);
    }

    private async Task<CortexPublicNewsHit[]?> SearchAsync(string query, string meaning, DateTimeOffset cutoff,
        DateTimeOffset? latest, int count, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        if (!settings.CanSearch || query.Length > 500 || !query.Any(char.IsLetterOrDigit))
            return null;

        try
        {
            using var http = clients.CreateClient(QueryClient);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(http.Timeout);
            var vector = await embeddings.EmbedAsync($"query: {meaning}", timeout.Token);
            var index = new AzureCortexNewsIndex(http, settings);
            var hits = await index.SearchAsync(query, vector, cutoff, timeout.Token, latest, count);
            return hits.Where(hit => ArticleIdentity.NormalizeUrl(hit.Url) is not null).ToArray();
        }
        catch (Exception error) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogDebug("Public news search fell back to local matches ({Failure}).", error.GetType().Name);
            return null;
        }
    }
}
