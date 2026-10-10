using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Signal.Server.Data;

namespace Signal.Server.Services;

public sealed class ArticleAudioPreparationService(
    IServiceScopeFactory scopeFactory,
    HeadlineAudioService audio,
    IOptions<KokoroSpeechOptions> options,
    IWebHostEnvironment environment,
    ILogger<ArticleAudioPreparationService> logger) : BackgroundService, IArticleAudioPrewarmer
{
    private readonly ArticleAudioPreparationQueue queue = new();
    private readonly SemaphoreSlim available = new(0, 1);
    private long preparedParts, preparedArticles, failedArticles;
    private DateTime lastStatus;
    private bool Enabled => options.Value.Enabled && options.Value.KokoroPrewarm;

    public void Enqueue(string url, string title, string summary)
    {
        if (!Enabled || string.IsNullOrWhiteSpace(title) || title.Length > 1000 || url.Length > 2048 || summary.Length > 4000
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo)) return;
        var job = new ArticleAudioPreparationJob(url, title, summary) {
            // Headline briefings keep the full title; article reading uses smaller parts.
            Parts = new[] { title }.Concat(ArticleNarrationParts.SplitText(title)).Distinct().ToArray()
        };
        if (queue.Enqueue(job)) { try { available.Release(); } catch (SemaphoreFullException) { } }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!Enabled) return;
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            try { await SeedAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { throw; }
            catch (Exception exception) { logger.LogWarning(exception, "Could not restore recent audio jobs; newly saved news will still be prepared."); }
            while (!stoppingToken.IsCancellationRequested)
            {
                var job = queue.Take();
                if (job is null)
                {
                    await SaveStatusAsync(false, stoppingToken, force: true);
                    await available.WaitAsync(stoppingToken);
                    continue;
                }
                try
                {
                    if (job.Article && !job.Extracted) await ExtractAsync(job, stoppingToken);
                    var ready = await audio.TryPrepareInBackgroundAsync(new HeadlineAudioRequest([job.Parts[job.Index]], 3), stoppingToken);
                    if (!ready)
                    {
                        queue.Resume(job);
                        await SaveStatusAsync(false, stoppingToken);
                        await Task.Delay(TimeSpan.FromMilliseconds(500), stoppingToken);
                        continue;
                    }
                    preparedParts++;
                    job.Index++;
                    if (job.Index < job.Parts.Length) queue.Resume(job);
                    else if (!job.Article)
                    {
                        job.Article = true;
                        job.Index = 0;
                        queue.Resume(job);
                    }
                    else
                    {
                        preparedArticles++;
                        queue.Complete(job);
                    }
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { throw; }
                catch (Exception exception)
                {
                    logger.LogDebug(exception, "Background article audio preparation failed.");
                    if (++job.Failures < 2)
                    {
                        queue.Resume(job);
                        await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                    }
                    else { failedArticles++; queue.Complete(job); }
                }
                await SaveStatusAsync(true, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception exception) { logger.LogWarning(exception, "Could not start background audio preparation."); }
    }

    private async Task SeedAsync(CancellationToken token)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
        var cutoff = DateTime.UtcNow.AddDays(-1);
        var latest = await database.StoredNewsArticles.AsNoTracking()
            .Where(article => article.LastSeenAtUtc >= cutoff)
            .OrderByDescending(article => article.PublishedAtUtc).ThenByDescending(article => article.Id)
            .Select(article => new { article.Url, article.Title, article.Summary }).Take(512).ToArrayAsync(token);
        // Restore the newest stories first without carrying tracked database entities.
        foreach (var article in latest.DistinctBy(article => article.Url).Take(128))
            Enqueue(article.Url, article.Title, article.Summary);
    }

    private async Task ExtractAsync(ArticleAudioPreparationJob job, CancellationToken token)
    {
        ArticleReaderResult? extracted = null;
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(60));
            extracted = await scope.ServiceProvider.GetRequiredService<ArticleReaderService>().ReadAsync(job.Url, deadline.Token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception exception) { logger.LogDebug(exception, "Background reader will use the feed summary."); }
        job.Parts = extracted is { Available: true, Article.Paragraphs.Count: > 0 }
            ? ArticleNarrationParts.Split(job.Title, extracted.Article.Paragraphs)
            : ArticleNarrationParts.Split(string.IsNullOrEmpty(job.Summary) || job.Summary == job.Title ? "" : job.Title,
                [string.IsNullOrEmpty(job.Summary) ? job.Title : job.Summary]);
        job.Extracted = true;
    }

    private async Task SaveStatusAsync(bool active, CancellationToken token, bool force = false)
    {
        if (!force && DateTime.UtcNow - lastStatus < TimeSpan.FromSeconds(10)) return;
        lastStatus = DateTime.UtcNow;
        try
        {
            var directory = Path.Combine(environment.ContentRootPath, "App_Data");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "article-audio-preparation.json");
            var temporary = path + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(new {
                Engine = audio.EngineName, Enabled, CpuThreads = options.Value.KokoroThreads,
                QueuedArticles = queue.Count, Active = active, PreparedParts = preparedParts,
                PreparedArticles = preparedArticles, FailedArticles = failedArticles, UpdatedAt = DateTimeOffset.UtcNow
            }), token);
            File.Move(temporary, path, overwrite: true);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception exception) { logger.LogDebug(exception, "Could not save background audio status."); }
    }
}
