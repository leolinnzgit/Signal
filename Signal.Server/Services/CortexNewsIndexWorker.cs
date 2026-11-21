using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Signal.Server.Models;

namespace Signal.Server.Services;

internal sealed class CortexNewsIndexWorker(
    IServiceScopeFactory services,
    IHttpClientFactory clients,
    IOptions<CortexNewsOptions> options,
    ICortexNewsEmbeddings embeddings,
    ILogger<CortexNewsIndexWorker> logger) : BackgroundService
{
    internal const string IndexClient = "CortexNewsIndex";
    private static readonly string[] PublicFeeds =
    [
        "https://www.rnz.co.nz/rss/national.xml",
        "https://www.rnz.co.nz/rss/business.xml",
        "https://www.rnz.co.nz/rss/media-technology.xml",
        "https://feeds.bbci.co.uk/news/world/rss.xml",
        "https://feeds.bbci.co.uk/news/business/rss.xml",
        "https://feeds.bbci.co.uk/news/technology/rss.xml",
    ];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var settings = options.Value;
        if (!settings.Enabled) return;
        if (!settings.CanSearch || string.IsNullOrWhiteSpace(settings.AdminKey))
        {
            logger.LogWarning("Cortex public news requires an Azure Search endpoint and separate query and admin keys.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var delay = TimeSpan.FromMinutes(30);
            try
            {
                await RefreshAsync(settings, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                logger.LogWarning("Cortex public news refresh failed ({Failure}, HTTP {Status}).",
                    error.GetType().Name, (error as HttpRequestException)?.StatusCode);
                delay = TimeSpan.FromMinutes(5);
            }
            await Task.Delay(delay, stoppingToken);
        }
    }

    private async Task RefreshAsync(CortexNewsOptions settings, CancellationToken token)
    {
        using var scope = services.CreateScope();
        var news = scope.ServiceProvider.GetRequiredService<NewsService>();
        var now = DateTimeOffset.UtcNow;
        var cutoff = now.AddDays(-CortexNewsOptions.RetentionDays);
        var range = new NewsDateRange(cutoff, now);
        var feeds = await Task.WhenAll(PublicFeeds.Select(feed => FetchFeedAsync(news, feed, range, token)));
        if (feeds.All(feed => feed is null))
            throw new InvalidOperationException("Cortex could not read any public feed.");

        using var http = clients.CreateClient(IndexClient);
        var index = new AzureCortexNewsIndex(http, settings);
        await index.EnsureIndexAsync(token);
        var existing = (await index.ListAsync(token)).ToDictionary(item => item.Id, StringComparer.Ordinal);
        var articles = feeds.OfType<NewsArticle[]>().SelectMany(feed => feed)
            .Select(ToIndexArticle)
            .OfType<CortexIndexedArticle>()
            .OrderByDescending(article => article.PublishedAt)
            .DistinctBy(article => article.Id)
            .ToDictionary(article => article.Id, StringComparer.Ordinal);
        var retained = SelectRetainedIds(existing.Values, articles.Values, cutoff, settings.MaxArticles);
        var expired = existing.Keys.Where(id => !retained.Contains(id)).ToArray();
        if (expired.Length > 0)
            await index.DeleteAsync(expired, token);

        var pending = articles.Values.Where(article => retained.Contains(article.Id)
            && (!existing.TryGetValue(article.Id, out var current) || current.Fingerprint != article.Fingerprint));
        var indexed = 0;
        foreach (var batch in pending.Chunk(25))
        {
            var documents = new List<(CortexIndexedArticle Article, float[] Vector)>(batch.Length);
            foreach (var article in batch)
            {
                var vector = await embeddings.EmbedAsync($"passage: {article.Title}. {article.Excerpt}", token);
                documents.Add((article, vector));
            }
            await index.UpsertAsync(documents, token);
            indexed += documents.Count;
        }

        logger.LogInformation("Cortex public news refreshed ({Indexed} updated, {Removed} removed, {Total} retained).",
            indexed, expired.Length, retained.Count);
    }

    internal static HashSet<string> SelectRetainedIds(
        IEnumerable<CortexIndexEntry> existing, IEnumerable<CortexIndexedArticle> incoming,
        DateTimeOffset cutoff, int maxArticles) =>
        incoming.Select(article => new CortexIndexEntry(article.Id, article.PublishedAt, article.Fingerprint))
            .Concat(existing)
            .DistinctBy(article => article.Id)
            .Where(article => article.PublishedAt >= cutoff)
            .OrderByDescending(article => article.PublishedAt)
            .ThenBy(article => article.Id, StringComparer.Ordinal)
            .Take(Math.Clamp(maxArticles, 1, 2500))
            .Select(article => article.Id)
            .ToHashSet(StringComparer.Ordinal);

    private async Task<NewsArticle[]?> FetchFeedAsync(
        NewsService news, string feedUrl, NewsDateRange range, CancellationToken token)
    {
        try
        {
            var result = await news.GetPublisherFeedAsync(feedUrl, ["Public news"], 100, range, token);
            return result.Articles.ToArray();
        }
        catch (Exception error) when (!token.IsCancellationRequested)
        {
            logger.LogWarning("Cortex public feed {Feed} could not be read ({Failure}).", feedUrl, error.GetType().Name);
            return null;
        }
    }

    internal static CortexIndexedArticle? ToIndexArticle(NewsArticle article)
    {
        var url = ArticleIdentity.NormalizeUrl(article.Url);
        if (url is null || string.IsNullOrWhiteSpace(article.Title)) return null;
        var title = Clip(article.Title, 250);
        var publisher = Clip(article.Source, 100);
        var excerpt = Clip(article.Summary ?? "", 1000);
        var publishedAt = article.PublishedAt.ToUniversalTime();
        var id = Hash(ArticleIdentity.GetStoryUrlKey(url));
        var fingerprint = Hash(JsonSerializer.Serialize(new { title, publisher, url, publishedAt, excerpt }));
        return new(id, title, publisher, url, publishedAt, excerpt, fingerprint);
    }

    private static string Hash(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string Clip(string value, int limit)
    {
        var text = string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (text.Length <= limit) return text;
        var length = char.IsHighSurrogate(text[limit - 1]) ? limit - 1 : limit;
        return text[..length].TrimEnd() + "…";
    }
}
