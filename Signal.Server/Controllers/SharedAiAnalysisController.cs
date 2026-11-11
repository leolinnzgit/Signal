using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

namespace Signal.Server.Controllers;

[ApiController]
public sealed partial class SharedAiAnalysisController(
    SignalDbContext database,
    SharedArticleAudioService? audioService = null,
    AzureLanguagePiiService? piiService = null,
    ILogger<SharedAiAnalysisController>? logger = null) : ControllerBase
{
    private const string AnalysisCsp =
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static readonly HashSet<string> AllowedSentiments = new(StringComparer.OrdinalIgnoreCase)
    {
        "bullish", "bearish", "mixed", "neutral", "urgent",
    };

    [GeneratedRegex(@"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$", RegexOptions.Compiled)]
    private static partial Regex LanguageTagRegex();

    public sealed record CreateSharedAiAnalysisRequest(
        string? Topic,
        string? UserPrompt,
        string? Headline,
        string? Analysis,
        string[]? KeyDrivers = null,
        string[]? Perspectives = null,
        string[]? WatchNext = null,
        string? Sentiment = "neutral",
        SignalBotCitation[]? Citations = null,
        SignalBotMarketSnapshot? MarketQuote = null,
        string? Model = "",
        string? Language = "en",
        string? CoverageNote = "");

    public sealed record SharedAiAnalysisResponse(
        string Id,
        string Path,
        string Headline,
        string Topic,
        string Model,
        string Language,
        DateTime CreatedAtUtc);

    [Authorize]
    [EnableRateLimiting("account")]
    [HttpPost("api/signal-bot/shares")]
    [RequestSizeLimit(262_144)]
    [ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
    public async Task<IActionResult> Create(
        [FromBody] CreateSharedAiAnalysisRequest? request,
        CancellationToken cancellationToken)
    {
        var userId = User?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (string.IsNullOrWhiteSpace(userId))
        {
            return Unauthorized();
        }

        if (request is null)
        {
            return BadRequest(new { error = "Provide an AI analysis to share." });
        }

        var headline = TrimToMax(request.Headline, 300);
        var analysis = TrimToMax(request.Analysis, 40_000);
        if (string.IsNullOrWhiteSpace(analysis))
        {
            return BadRequest(new { error = "Analysis text is required to create a shared link." });
        }

        var topic = TrimToMax(request.Topic, 160);
        if (string.IsNullOrWhiteSpace(topic)) topic = "Topic Analysis";
        if (string.IsNullOrWhiteSpace(headline)) headline = topic;

        var userPrompt = TrimToMax(request.UserPrompt, 1000);
        if (piiService is { Enabled: true })
        {
            userPrompt = await RedactIfHighRiskAsync(piiService, userPrompt, cancellationToken);
            analysis = await RedactIfHighRiskAsync(piiService, analysis, cancellationToken);
        }

        var keyDrivers = NormalizeList(request.KeyDrivers, 12, 600);
        var perspectives = NormalizeList(request.Perspectives, 12, 600);
        var watchNext = NormalizeList(request.WatchNext, 12, 600);
        var sentiment = NormalizeSentiment(request.Sentiment);
        var citations = NormalizeCitations(request.Citations);
        var marketQuote = NormalizeMarketQuote(request.MarketQuote);
        var model = TrimToMax(request.Model, 80);
        var language = NormalizeLanguage(request.Language);
        var coverageNote = TrimToMax(request.CoverageNote, 400);

        var keyDriversJson = JsonSerializer.Serialize(keyDrivers, JsonOptions);
        var perspectivesJson = JsonSerializer.Serialize(perspectives, JsonOptions);
        var watchNextJson = JsonSerializer.Serialize(watchNext, JsonOptions);
        var citationsJson = JsonSerializer.Serialize(citations, JsonOptions);
        var marketQuoteJson = marketQuote is null ? "" : JsonSerializer.Serialize(marketQuote, JsonOptions);

        var canonicalPayload = JsonSerializer.Serialize(new
        {
            topic,
            userPrompt,
            headline,
            analysis,
            keyDriversJson,
            perspectivesJson,
            watchNextJson,
            sentiment,
            citationsJson,
            marketQuoteJson,
            model,
            language,
            coverageNote,
        });
        var contentHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalPayload)));

        var existing = await database.SharedAiAnalyses
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.UserId == userId && x.ContentHash == contentHash, cancellationToken);

        if (existing is not null)
        {
            return Ok(ToResponse(existing));
        }

        var entity = new SharedAiAnalysis
        {
            Id = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(24)),
            UserId = userId,
            ContentHash = contentHash,
            Topic = topic,
            UserPrompt = userPrompt,
            Headline = headline,
            Analysis = analysis,
            KeyDriversJson = keyDriversJson,
            PerspectivesJson = perspectivesJson,
            WatchNextJson = watchNextJson,
            Sentiment = sentiment,
            CitationsJson = citationsJson,
            MarketQuoteJson = marketQuoteJson,
            Model = model,
            Language = language,
            CoverageNote = coverageNote,
            CreatedAtUtc = DateTime.UtcNow,
        };

        database.SharedAiAnalyses.Add(entity);
        try
        {
            await database.SaveChangesAsync(cancellationToken);
            return Ok(ToResponse(entity));
        }
        catch (DbUpdateException)
        {
            var raced = await database.SharedAiAnalyses
                .AsNoTracking()
                .FirstOrDefaultAsync(x => x.UserId == userId && x.ContentHash == contentHash, cancellationToken);
            if (raced is not null)
            {
                return Ok(ToResponse(raced));
            }
            throw;
        }
    }

    [AllowAnonymous]
    [HttpGet("shared/analysis/{id}")]
    [ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
    public async Task<IActionResult> View(string id, CancellationToken cancellationToken)
    {
        var homePath = BuildHomePath();
        Response.Headers.XContentTypeOptions = "nosniff";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        Response.Headers["X-Robots-Tag"] = "noindex, nofollow";
        Response.Headers["Content-Security-Policy"] = AnalysisCsp;

        if (!SharedAiAnalysisPage.IsValidShareId(id))
        {
            return HtmlResult(SharedAiAnalysisPage.RenderMissing(homePath), StatusCodes.Status404NotFound);
        }

        var item = await database.SharedAiAnalyses
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id, cancellationToken);

        if (item is null)
        {
            return HtmlResult(SharedAiAnalysisPage.RenderMissing(homePath), StatusCodes.Status404NotFound);
        }

        return HtmlResult(SharedAiAnalysisPage.Render(item, homePath), StatusCodes.Status200OK);
    }

    [AllowAnonymous]
    [EnableRateLimiting("audio")]
    [HttpGet("shared/analysis/{id}/audio/voices")]
    [ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
    public async Task<IActionResult> AudioVoices(string id, CancellationToken cancellationToken)
    {
        if (audioService is null)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Audio narration is not configured." });
        }

        var item = await FindSharedAnalysisAsync(id, cancellationToken);
        if (item is null)
        {
            return NotFound();
        }

        try
        {
            var article = SharedAiAnalysisPage.ToSharedAudioArticle(item);
            var catalog = await audioService.GetVoicesAsync(article, cancellationToken);
            return Ok(catalog);
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger?.LogDebug(exception, "Shared AI analysis voice catalog unavailable for {Id}.", id);
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Azure narration voices are unavailable right now." });
        }
    }

    [AllowAnonymous]
    [EnableRateLimiting("audio")]
    [HttpGet("shared/analysis/{id}/audio")]
    [HttpHead("shared/analysis/{id}/audio")]
    [ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
    public async Task<IActionResult> Audio(
        string id,
        [FromQuery] string? voice = null,
        CancellationToken cancellationToken = default)
    {
        if (audioService is null)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Audio narration is not configured." });
        }

        var item = await FindSharedAnalysisAsync(id, cancellationToken);
        if (item is null)
        {
            return NotFound();
        }

        try
        {
            var article = SharedAiAnalysisPage.ToSharedAudioArticle(item);
            var recording = await audioService.PrepareAsync(article, cancellationToken, voice);
            if (SharedArticleAudioService.IsCached(recording) && !string.IsNullOrWhiteSpace(recording.Path))
            {
                return PhysicalFile(recording.Path, "audio/wav", enableRangeProcessing: true);
            }

            if (HttpMethods.IsHead(Request.Method))
            {
                Response.ContentType = "audio/wav";
                return Ok();
            }

            return new FileCallbackResult("audio/wav", async (output, token) =>
            {
                await audioService.WriteAsync(recording, output, token);
            });
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger?.LogWarning(exception, "Shared AI analysis audio failed for {Id}.", id);
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Audio narration is temporarily unavailable." });
        }
    }

    [AllowAnonymous]
    [EnableRateLimiting("audio")]
    [HttpGet("shared/analysis/{id}/audio/timing")]
    [ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
    public async Task<IActionResult> AudioTiming(
        string id,
        [FromQuery] string? voice = null,
        CancellationToken cancellationToken = default)
    {
        if (audioService is null)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Audio narration is not configured." });
        }

        var item = await FindSharedAnalysisAsync(id, cancellationToken);
        if (item is null)
        {
            return NotFound();
        }

        try
        {
            var article = SharedAiAnalysisPage.ToSharedAudioArticle(item);
            var recording = await audioService.PrepareAsync(article, cancellationToken, voice);
            return Ok(audioService.GetTiming(recording));
        }
        catch (ArgumentException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(499);
        }
        catch (Exception exception)
        {
            logger?.LogDebug(exception, "Shared AI analysis timing unavailable for {Id}.", id);
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Audio timing is temporarily unavailable." });
        }
    }

    private async Task<SharedAiAnalysis?> FindSharedAnalysisAsync(string id, CancellationToken cancellationToken)
    {
        if (!SharedAiAnalysisPage.IsValidShareId(id)) return null;
        return await database.SharedAiAnalyses
            .AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id, cancellationToken);
    }

    private async Task<string> RedactIfHighRiskAsync(
        AzureLanguagePiiService service,
        string text,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;
        try
        {
            var result = await service.AnalyzeAndRedactAsync(text, cancellationToken);
            return result.HasHighRiskPii && !string.IsNullOrWhiteSpace(result.RedactedText)
                ? result.RedactedText
                : text;
        }
        catch (Exception exception)
        {
            logger?.LogDebug(exception, "Optional PII check skipped during Signal Bot share creation.");
            return text;
        }
    }

    private SharedAiAnalysisResponse ToResponse(SharedAiAnalysis item)
    {
        var basePath = Request?.PathBase.Value?.TrimEnd('/') ?? "";
        var path = $"{basePath}/shared/analysis/{item.Id}";
        return new SharedAiAnalysisResponse(
            Id: item.Id,
            Path: path,
            Headline: item.Headline,
            Topic: item.Topic,
            Model: item.Model,
            Language: item.Language,
            CreatedAtUtc: item.CreatedAtUtc);
    }

    private string BuildHomePath()
    {
        var basePath = Request?.PathBase.Value;
        return string.IsNullOrEmpty(basePath) ? "/" : basePath.TrimEnd('/') + "/";
    }

    private static ContentResult HtmlResult(string html, int statusCode) =>
        new()
        {
            StatusCode = statusCode,
            ContentType = "text/html; charset=utf-8",
            Content = html,
        };

    private static string TrimToMax(string? raw, int maxChars)
    {
        var value = (raw ?? "").Trim();
        return value.Length <= maxChars ? value : value[..maxChars].TrimEnd();
    }

    private static string[] NormalizeList(string[]? raw, int maxItems, int maxChars)
    {
        if (raw is null || raw.Length == 0) return [];
        return raw
            .Select(x => TrimToMax(x, maxChars))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Take(maxItems)
            .ToArray();
    }

    private static string NormalizeSentiment(string? raw)
    {
        var clean = (raw ?? "").Trim().ToLowerInvariant();
        return AllowedSentiments.Contains(clean) ? clean : "neutral";
    }

    private static string NormalizeLanguage(string? raw)
    {
        var clean = (raw ?? "").Trim();
        return LanguageTagRegex().IsMatch(clean) ? clean : "en";
    }

    private static SignalBotCitation[] NormalizeCitations(SignalBotCitation[]? raw)
    {
        if (raw is null || raw.Length == 0) return [];
        var list = new List<SignalBotCitation>(Math.Min(raw.Length, 20));
        foreach (var item in raw.Take(20))
        {
            if (item.Index <= 0) continue;
            var url = (item.Url ?? "").Trim();
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                (!string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
                 !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)))
            {
                url = "";
            }
            list.Add(new SignalBotCitation(
                Index: item.Index,
                Url: url,
                Title: TrimToMax(item.Title, 300),
                Source: TrimToMax(item.Source, 120),
                PublishedAt: TrimToMax(item.PublishedAt, 80),
                Summary: TrimToMax(item.Summary, 600)));
        }
        return [.. list];
    }

    private static SignalBotMarketSnapshot? NormalizeMarketQuote(SignalBotMarketSnapshot? raw)
    {
        if (raw is null || string.IsNullOrWhiteSpace(raw.Symbol)) return null;
        return new SignalBotMarketSnapshot(
            Symbol: TrimToMax(raw.Symbol, 24),
            Name: TrimToMax(raw.Name, 120),
            Exchange: TrimToMax(raw.Exchange, 40),
            Currency: TrimToMax(raw.Currency, 16),
            Price: raw.Price,
            Change: raw.Change,
            PercentChange: raw.PercentChange,
            QuoteTime: TrimToMax(raw.QuoteTime, 80));
    }

    private sealed class FileCallbackResult(
        string contentType,
        Func<Stream, CancellationToken, Task> callback) : FileResult(contentType)
    {
        public override Task ExecuteResultAsync(ActionContext context)
        {
            ArgumentNullException.ThrowIfNull(context);
            var response = context.HttpContext.Response;
            response.ContentType = ContentType;
            return callback(response.Body, context.HttpContext.RequestAborted);
        }
    }
}
