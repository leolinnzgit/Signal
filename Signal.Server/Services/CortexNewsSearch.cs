using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public interface ICortexNewsSearch
{
    Task<CortexPublicNewsHit[]?> SearchAsync(string query, CancellationToken cancellationToken);
}

internal sealed class CortexNewsSearch(
    IHttpClientFactory clients,
    IOptions<CortexNewsOptions> options,
    ICortexNewsEmbeddings embeddings,
    ILogger<CortexNewsSearch> logger) : ICortexNewsSearch
{
    internal const string QueryClient = "CortexNewsQuery";

    public async Task<CortexPublicNewsHit[]?> SearchAsync(string query, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        if (!settings.CanSearch || query.Length > 500 || !query.Any(char.IsLetterOrDigit))
            return null;

        try
        {
            using var http = clients.CreateClient(QueryClient);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(http.Timeout);
            var vector = await embeddings.EmbedAsync($"query: {query}", timeout.Token);
            var index = new AzureCortexNewsIndex(http, settings);
            var hits = await index.SearchAsync(query, vector,
                DateTimeOffset.UtcNow.AddDays(-CortexNewsOptions.RetentionDays), timeout.Token);
            return hits.Where(hit => ArticleIdentity.NormalizeUrl(hit.Url) is not null).ToArray();
        }
        catch (Exception error) when (!cancellationToken.IsCancellationRequested)
        {
            // The local Cortex path stays available. Neither the search phrase nor the key belongs in the log.
            logger.LogDebug("Public news search fell back to local Cortex search ({Failure}).", error.GetType().Name);
            return null;
        }
    }
}
