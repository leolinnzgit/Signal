using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed record ProductWatchFrequencyOption(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("intervalHours")] int? IntervalHours);

public sealed record ProductWatchOfferDto(
    [property: JsonPropertyName("retailer")] string Retailer,
    [property: JsonPropertyName("price")] decimal Price,
    [property: JsonPropertyName("currency")] string Currency,
    [property: JsonPropertyName("availability")] string Availability,
    [property: JsonPropertyName("note")] string Note,
    [property: JsonPropertyName("url")] string Url);

public sealed record ProductPriceHistoryPointDto(
    [property: JsonPropertyName("checkedAtUtc")] DateTime CheckedAtUtc,
    [property: JsonPropertyName("bestPrice")] decimal BestPrice,
    [property: JsonPropertyName("retailer")] string Retailer,
    [property: JsonPropertyName("currency")] string Currency);

public sealed record ProductPriceCheckResultDto(
    [property: JsonPropertyName("productName")] string ProductName,
    [property: JsonPropertyName("modelOrSku")] string ModelOrSku,
    [property: JsonPropertyName("currency")] string Currency,
    [property: JsonPropertyName("bestPrice")] decimal BestPrice,
    [property: JsonPropertyName("regularPrice")] decimal RegularPrice,
    [property: JsonPropertyName("savingsAmount")] decimal SavingsAmount,
    [property: JsonPropertyName("savingsPercent")] decimal SavingsPercent,
    [property: JsonPropertyName("bestRetailer")] string BestRetailer,
    [property: JsonPropertyName("bestOfferUrl")] string BestOfferUrl,
    [property: JsonPropertyName("priceVerdict")] string PriceVerdict,
    [property: JsonPropertyName("summary")] string Summary,
    [property: JsonPropertyName("buyingTip")] string BuyingTip,
    [property: JsonPropertyName("offers")] ProductWatchOfferDto[] Offers,
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("checkedAtUtc")] DateTime CheckedAtUtc);

public sealed record ProductWatchItemDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("productName")] string ProductName,
    [property: JsonPropertyName("modelOrSku")] string ModelOrSku,
    [property: JsonPropertyName("frequency")] string Frequency,
    [property: JsonPropertyName("frequencyLabel")] string FrequencyLabel,
    [property: JsonPropertyName("currency")] string Currency,
    [property: JsonPropertyName("targetPrice")] decimal? TargetPrice,
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("notifyOnPriceDrop")] bool NotifyOnPriceDrop,
    [property: JsonPropertyName("bestPrice")] decimal? BestPrice,
    [property: JsonPropertyName("regularPrice")] decimal? RegularPrice,
    [property: JsonPropertyName("lowestPriceEver")] decimal? LowestPriceEver,
    [property: JsonPropertyName("previousBestPrice")] decimal? PreviousBestPrice,
    [property: JsonPropertyName("savingsAmount")] decimal? SavingsAmount,
    [property: JsonPropertyName("savingsPercent")] decimal? SavingsPercent,
    [property: JsonPropertyName("isTargetMet")] bool IsTargetMet,
    [property: JsonPropertyName("isPriceDrop")] bool IsPriceDrop,
    [property: JsonPropertyName("bestRetailer")] string BestRetailer,
    [property: JsonPropertyName("bestOfferUrl")] string BestOfferUrl,
    [property: JsonPropertyName("priceVerdict")] string PriceVerdict,
    [property: JsonPropertyName("summary")] string Summary,
    [property: JsonPropertyName("buyingTip")] string BuyingTip,
    [property: JsonPropertyName("offers")] ProductWatchOfferDto[] Offers,
    [property: JsonPropertyName("priceHistory")] ProductPriceHistoryPointDto[] PriceHistory,
    [property: JsonPropertyName("modelUsed")] string ModelUsed,
    [property: JsonPropertyName("checkCount")] int CheckCount,
    [property: JsonPropertyName("lastCheckedAtUtc")] DateTime? LastCheckedAtUtc,
    [property: JsonPropertyName("nextCheckAtUtc")] DateTime? NextCheckAtUtc,
    [property: JsonPropertyName("lastError")] string LastError,
    [property: JsonPropertyName("createdAtUtc")] DateTime CreatedAtUtc,
    [property: JsonPropertyName("updatedAtUtc")] DateTime UpdatedAtUtc);

public sealed record ProductWatchInstantCheckRequest(
    [property: JsonPropertyName("modelOrSku")] string? ModelOrSku,
    [property: JsonPropertyName("productName")] string? ProductName = null,
    [property: JsonPropertyName("currency")] string? Currency = "NZD",
    [property: JsonPropertyName("targetPrice")] decimal? TargetPrice = null);

public sealed class ProductWatchService(
    MicrosoftFoundryService foundry,
    SignalDbContext database,
    NewsService newsService,
    PushNotificationService? pushNotifications,
    ILogger<ProductWatchService> logger)
{
    public const string DefaultModel = "gpt-6.1-sol";
    public const int MaxWatchedProductsPerUser = 30;
    private const int MaxHistoryPoints = 30;

    public static readonly IReadOnlyList<ProductWatchFrequencyOption> SupportedFrequencies =
    [
        new("6h", "Every 6 hours", 6),
        new("12h", "Every 12 hours", 12),
        new("daily", "Daily", 24),
        new("weekly", "Weekly", 24 * 7),
        new("fortnightly", "Fortnightly (Every 2 weeks)", 24 * 14),
        new("monthly", "Monthly", 24 * 30),
        new("manual", "Manual only", null),
    ];

    public static readonly IReadOnlySet<string> SupportedCurrencies = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "NZD", "USD", "AUD", "GBP", "EUR", "CAD", "SGD", "JPY",
    };

    private static readonly HashSet<string> AllowedVerdicts = new(StringComparer.OrdinalIgnoreCase)
    {
        "great-deal", "good-price", "fair-price", "wait",
    };

    private static readonly Regex PriceNumberRegex = new(
        @"-?\d+(?:,\d{3})*(?:\.\d+)?",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex WhiteSpaceRegex = new(
        @"\s+",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    internal sealed record DealEvidenceSnippet(
        string Title,
        string Source,
        string Url,
        string PublishedAt,
        string Summary);

    public static string NormalizeFrequency(string? raw)
    {
        var normalized = (raw ?? "").Trim().ToLowerInvariant();
        return normalized switch
        {
            "6h" or "6hr" or "6hours" or "every-6-hours" or "hourly" => "6h",
            "12h" or "12hr" or "12hours" or "every-12-hours" => "12h",
            "daily" or "day" or "1d" or "24h" => "daily",
            "weekly" or "week" or "1w" or "7d" => "weekly",
            "fortnightly" or "biweekly" or "2w" or "14d" => "fortnightly",
            "monthly" or "month" or "1m" or "30d" => "monthly",
            "manual" or "off" or "none" => "manual",
            _ => "daily",
        };
    }

    public static string GetFrequencyLabel(string? frequency)
    {
        var norm = NormalizeFrequency(frequency);
        return SupportedFrequencies.FirstOrDefault(f => f.Id == norm)?.Label ?? "Daily";
    }

    public static TimeSpan? GetFrequencyInterval(string? frequency)
    {
        var norm = NormalizeFrequency(frequency);
        return norm switch
        {
            "6h" => TimeSpan.FromHours(6),
            "12h" => TimeSpan.FromHours(12),
            "daily" => TimeSpan.FromDays(1),
            "weekly" => TimeSpan.FromDays(7),
            "fortnightly" => TimeSpan.FromDays(14),
            "monthly" => TimeSpan.FromDays(30),
            "manual" => null,
            _ => TimeSpan.FromDays(1),
        };
    }

    public static DateTime? ComputeNextCheckUtc(string? frequency, DateTime fromUtc)
    {
        var interval = GetFrequencyInterval(frequency);
        return interval.HasValue ? fromUtc.Add(interval.Value) : null;
    }

    public static string NormalizeCurrency(string? raw)
    {
        var clean = (raw ?? "").Trim().ToUpperInvariant();
        return SupportedCurrencies.Contains(clean) ? clean : "NZD";
    }

    public static string NormalizeText(string? value, int maxLength)
    {
        var collapsed = WhiteSpaceRegex.Replace(value ?? "", " ").Trim();
        return collapsed.Length <= maxLength ? collapsed : collapsed[..maxLength].TrimEnd();
    }

    public async Task<ProductPriceCheckResultDto> CheckPriceWithAiAsync(
        string? userId,
        string modelOrSku,
        string? productName,
        string? currency,
        decimal? targetPrice,
        CancellationToken cancellationToken)
    {
        var cleanSku = NormalizeText(modelOrSku, 120);
        var cleanName = NormalizeText(productName, 200);
        if (cleanSku.Length == 0 && cleanName.Length > 0)
        {
            cleanSku = cleanName.Length <= 120 ? cleanName : cleanName[..120];
        }
        if (cleanName.Length == 0)
        {
            cleanName = cleanSku;
        }

        if (cleanSku.Length < 2)
        {
            throw new ArgumentException("Enter a product model or SKU (at least 2 characters).");
        }

        if (!foundry.Enabled)
        {
            throw new FoundryServiceException(
                "Microsoft Foundry (gpt-6.1-sol) is not configured for Product Watch yet.",
                StatusCodes.Status503ServiceUnavailable);
        }

        var normalizedCurrency = NormalizeCurrency(currency);
        var snippets = await GatherDealEvidenceAsync(userId, cleanName, cleanSku, normalizedCurrency, cancellationToken);
        var now = DateTime.UtcNow;

        var messages = BuildPriceCheckMessages(
            cleanName,
            cleanSku,
            normalizedCurrency,
            targetPrice,
            snippets,
            now);

        var chatResult = await foundry.CompleteChatAsync(
            messages,
            new FoundryChatOptions(
                Temperature: 0.2,
                MaxTokens: 1600,
                JsonObjectResponse: true,
                Deployment: DefaultModel),
            cancellationToken);

        return ParsePriceCheckResponse(
            chatResult.Content,
            cleanName,
            cleanSku,
            normalizedCurrency,
            snippets,
            string.IsNullOrWhiteSpace(chatResult.Model) ? DefaultModel : chatResult.Model,
            now);
    }

    public async Task<ProductWatchItemDto> CheckWatchItemAsync(
        string userId,
        string watchId,
        bool isScheduledBackgroundCheck,
        CancellationToken cancellationToken)
    {
        var item = await database.ProductWatches
            .SingleOrDefaultAsync(w => w.Id == watchId && w.UserId == userId, cancellationToken)
            ?? throw new KeyNotFoundException("Product watch item was not found.");

        var now = DateTime.UtcNow;
        try
        {
            var result = await CheckPriceWithAiAsync(
                userId,
                item.ModelOrSku,
                item.ProductName,
                item.Currency,
                item.TargetPrice,
                cancellationToken);

            var previousBest = item.BestPrice;
            item.PreviousBestPrice = previousBest;
            item.BestPrice = result.BestPrice;
            item.RegularPrice = result.RegularPrice;
            item.LowestPriceEver = item.LowestPriceEver.HasValue
                ? Math.Min(item.LowestPriceEver.Value, result.BestPrice)
                : result.BestPrice;
            item.BestRetailer = NormalizeText(result.BestRetailer, 160);
            item.BestOfferUrl = NormalizeSafeUrl(result.BestOfferUrl);
            item.PriceVerdict = result.PriceVerdict;
            item.Summary = NormalizeText(result.Summary, 2000);
            item.BuyingTip = NormalizeText(result.BuyingTip, 600);
            item.OffersJson = JsonSerializer.Serialize(result.Offers);
            item.ModelUsed = NormalizeText(result.Model, 128);
            item.CheckCount += 1;
            item.LastCheckedAtUtc = now;
            item.NextCheckAtUtc = item.Enabled ? ComputeNextCheckUtc(item.Frequency, now) : null;
            item.LastError = "";
            item.UpdatedAtUtc = now;

            if (string.Equals(item.ProductName, item.ModelOrSku, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(result.ProductName)
                && result.ProductName.Length >= 3)
            {
                item.ProductName = NormalizeText(result.ProductName, 200);
            }

            var history = ParsePriceHistory(item.PriceHistoryJson).ToList();
            history.Add(new ProductPriceHistoryPointDto(
                CheckedAtUtc: now,
                BestPrice: result.BestPrice,
                Retailer: item.BestRetailer,
                Currency: item.Currency));
            if (history.Count > MaxHistoryPoints)
            {
                history = history.Skip(history.Count - MaxHistoryPoints).ToList();
            }
            item.PriceHistoryJson = JsonSerializer.Serialize(history);

            await database.SaveChangesAsync(cancellationToken);

            var targetMet = item.TargetPrice.HasValue && result.BestPrice <= item.TargetPrice.Value;
            var priceDropped = previousBest.HasValue && result.BestPrice < previousBest.Value;

            if (pushNotifications is not null
                && item.NotifyOnPriceDrop
                && (targetMet || priceDropped || (isScheduledBackgroundCheck && result.PriceVerdict == "great-deal")))
            {
                try
                {
                    await pushNotifications.SendProductWatchAlertAsync(
                        userId,
                        item.Id,
                        item.ProductName,
                        item.ModelOrSku,
                        item.Currency,
                        result.BestPrice,
                        item.BestRetailer,
                        item.Summary,
                        cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception pushEx)
                {
                    logger.LogWarning(pushEx, "Could not send Product Watch push notification for {WatchId}.", item.Id);
                }
            }

            return ToDto(item);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            item.LastCheckedAtUtc = now;
            if (isScheduledBackgroundCheck && item.Enabled)
            {
                var retryInterval = GetFrequencyInterval(item.Frequency) ?? TimeSpan.FromHours(6);
                var boundedRetry = retryInterval < TimeSpan.FromHours(1) ? retryInterval : TimeSpan.FromHours(1);
                item.NextCheckAtUtc = now.Add(boundedRetry);
            }
            item.LastError = NormalizeText(ex.Message, 500);
            item.UpdatedAtUtc = now;
            await database.SaveChangesAsync(cancellationToken);
            throw;
        }
    }

    public async Task<int> ProcessDueWatchesAsync(
        CancellationToken cancellationToken,
        DateTime? utcNowOverride = null)
    {
        if (!foundry.Enabled)
        {
            return 0;
        }

        var now = utcNowOverride ?? DateTime.UtcNow;
        var dueItems = await database.ProductWatches
            .AsNoTracking()
            .Where(w => w.Enabled && w.Frequency != "manual" && w.NextCheckAtUtc != null && w.NextCheckAtUtc <= now)
            .OrderBy(w => w.NextCheckAtUtc)
            .Select(w => new { w.Id, w.UserId })
            .Take(5)
            .ToArrayAsync(cancellationToken);

        var processed = 0;
        foreach (var due in dueItems)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await CheckWatchItemAsync(due.UserId, due.Id, isScheduledBackgroundCheck: true, cancellationToken);
                processed++;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Scheduled Product Watch check failed for watch {WatchId} (user {UserId}).", due.Id, due.UserId);
            }
        }

        return processed;
    }

    internal async Task<IReadOnlyList<DealEvidenceSnippet>> GatherDealEvidenceAsync(
        string? userId,
        string productName,
        string modelOrSku,
        string currency,
        CancellationToken cancellationToken)
    {
        var queryCore = string.Equals(productName, modelOrSku, StringComparison.OrdinalIgnoreCase)
            ? modelOrSku
            : $"{productName} {modelOrSku}";

        var snippets = new List<DealEvidenceSnippet>();
        var seenUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (!string.IsNullOrWhiteSpace(userId))
        {
            try
            {
                var localArticles = await database.StoredNewsArticles
                    .AsNoTracking()
                    .Where(a => a.UserId == userId)
                    .OrderByDescending(a => a.PublishedAtUtc)
                    .Take(100)
                    .Select(a => new { a.Title, a.Source, a.Url, a.PublishedAtUtc, a.Summary })
                    .ToListAsync(cancellationToken);

                foreach (var row in localArticles)
                {
                    var text = $"{row.Title} {row.Summary}";
                    if (!text.Contains(modelOrSku, StringComparison.OrdinalIgnoreCase)
                        && (productName.Length < 3 || !text.Contains(productName, StringComparison.OrdinalIgnoreCase)))
                    {
                        continue;
                    }

                    var safeUrl = NormalizeSafeUrl(row.Url);
                    if (safeUrl.Length == 0 || !seenUrls.Add(safeUrl)) continue;
                    snippets.Add(new DealEvidenceSnippet(
                        NormalizeText(row.Title, 220),
                        NormalizeText(row.Source, 80),
                        safeUrl,
                        DateTime.SpecifyKind(row.PublishedAtUtc, DateTimeKind.Utc).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        NormalizeText(row.Summary, 360)));
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogDebug(ex, "Skipped local article lookup for Product Watch {ModelOrSku}.", modelOrSku);
            }
        }

        try
        {
            using var searchTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            searchTimeout.CancelAfter(TimeSpan.FromSeconds(4));

            var bingTask = SafeSearchAsync(() => newsService.SearchBingNewsKeywordsAsync($"{queryCore} price deal", 6, searchTimeout.Token));
            var googleTask = SafeSearchAsync(() => newsService.SearchGoogleNewsKeywordsAsync($"{queryCore} price deal {currency}", 6, searchTimeout.Token));

            var batches = await Task.WhenAll(bingTask, googleTask);
            foreach (var batch in batches)
            {
                foreach (var article in batch)
                {
                    var safeUrl = NormalizeSafeUrl(article.Url);
                    var title = NormalizeText(article.Title, 220);
                    if (title.Length == 0 || safeUrl.Length == 0 || !seenUrls.Add(safeUrl))
                    {
                        continue;
                    }

                    snippets.Add(new DealEvidenceSnippet(
                        title,
                        NormalizeText(article.Source, 80),
                        safeUrl,
                        article.PublishedAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        NormalizeText(article.Summary, 360)));
                    if (snippets.Count >= 8) break;
                }
                if (snippets.Count >= 8) break;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Live search supplement skipped for Product Watch {ModelOrSku}.", modelOrSku);
        }

        return snippets.Take(8).ToArray();
    }

    private static async Task<IReadOnlyList<NewsArticle>> SafeSearchAsync(Func<Task<IReadOnlyList<NewsArticle>>> call)
    {
        try
        {
            return await call();
        }
        catch
        {
            return [];
        }
    }

    internal static IReadOnlyList<FoundryMessage> BuildPriceCheckMessages(
        string productName,
        string modelOrSku,
        string currency,
        decimal? targetPrice,
        IReadOnlyList<DealEvidenceSnippet> snippets,
        DateTime utcNow)
    {
        var systemPrompt = new StringBuilder();
        systemPrompt.AppendLine("You are Signal Product Watch, an AI retail price intelligence analyst powered by gpt-6.1-sol.");
        systemPrompt.AppendLine($"Current UTC date: {utcNow:yyyy-MM-dd}.");
        systemPrompt.AppendLine("Your job is to check the best price at the moment for the user's watched product model or SKU.");
        systemPrompt.AppendLine();
        systemPrompt.AppendLine("Rules:");
        systemPrompt.AppendLine("1. Prioritize concrete prices, deals, and retailer listings found in the Live Web & Deal Snippets when present.");
        systemPrompt.AppendLine("2. IMPORTANT: bestPrice and regularPrice MUST ALWAYS be positive numbers (> 0), and offers MUST ALWAYS contain 2 to 4 retailer entries with numeric prices (> 0) in the requested currency. If the live snippets do not state an explicit numeric price in the requested currency, use your knowledge of the product's MSRP and current street pricing across major retailers for that currency/region to populate realistic market benchmark prices, and note clearly in summary and offer notes when figures are estimated market benchmarks.");
        systemPrompt.AppendLine("3. Never invent fake URLs: only use URLs provided in the Live Snippets; if an offer has no matching snippet URL, set its url to \"\".");
        systemPrompt.AppendLine("4. Respond ONLY with a valid JSON object matching this exact schema:");
        systemPrompt.AppendLine("{");
        systemPrompt.AppendLine("  \"productName\": \"Full canonical product name\",");
        systemPrompt.AppendLine("  \"modelOrSku\": \"Normalized model or SKU\",");
        systemPrompt.AppendLine($"  \"currency\": \"{currency}\",");
        systemPrompt.AppendLine("  \"bestPrice\": 499.00,");
        systemPrompt.AppendLine("  \"regularPrice\": 649.00,");
        systemPrompt.AppendLine("  \"bestRetailer\": \"Retailer offering the lowest price\",");
        systemPrompt.AppendLine("  \"bestOfferUrl\": \"URL from live snippets if matching, otherwise empty string\",");
        systemPrompt.AppendLine("  \"priceVerdict\": \"great-deal | good-price | fair-price | wait\",");
        systemPrompt.AppendLine("  \"summary\": \"2-3 sentence summary of the best price right now, active deals, and comparison vs typical retail\",");
        systemPrompt.AppendLine("  \"buyingTip\": \"1 concise actionable buying tip (price-match, SKU variant check, or sale timing)\",");
        systemPrompt.AppendLine("  \"offers\": [");
        systemPrompt.AppendLine("    {");
        systemPrompt.AppendLine("      \"retailer\": \"Retailer name\",");
        systemPrompt.AppendLine("      \"price\": 499.00,");
        systemPrompt.AppendLine($"      \"currency\": \"{currency}\",");
        systemPrompt.AppendLine("      \"availability\": \"In Stock | Deal | Estimated\",");
        systemPrompt.AppendLine("      \"note\": \"Brief note on deal, shipping, or benchmark\",");
        systemPrompt.AppendLine("      \"url\": \"https://... from snippet or empty string\"");
        systemPrompt.AppendLine("    }");
        systemPrompt.AppendLine("  ]");
        systemPrompt.AppendLine("}");

        var userMessage = new StringBuilder();
        userMessage.AppendLine($"Product Name: {productName}");
        userMessage.AppendLine($"Model / SKU: {modelOrSku}");
        userMessage.AppendLine($"Preferred Currency: {currency}");
        if (targetPrice.HasValue && targetPrice.Value > 0)
        {
            userMessage.AppendLine($"User Target Alert Price: {currency} {targetPrice.Value:F2}");
        }

        if (snippets.Count == 0)
        {
            userMessage.AppendLine("Live Web & Deal Snippets: None found in live feeds. Provide current market benchmark pricing for major retailers in the requested currency.");
        }
        else
        {
            userMessage.AppendLine($"Live Web & Deal Snippets ({snippets.Count}):");
            for (var i = 0; i < snippets.Count; i++)
            {
                var s = snippets[i];
                userMessage.AppendLine($"[S{i + 1}] {s.Title} | Source: {s.Source} | Date: {s.PublishedAt} | URL: {s.Url}");
                if (!string.IsNullOrWhiteSpace(s.Summary))
                {
                    userMessage.AppendLine($"Summary: {s.Summary}");
                }
            }
        }

        return
        [
            new FoundryMessage("system", systemPrompt.ToString()),
            new FoundryMessage("user", userMessage.ToString()),
        ];
    }

    internal static ProductPriceCheckResultDto ParsePriceCheckResponse(
        string rawJson,
        string fallbackProductName,
        string fallbackModelOrSku,
        string fallbackCurrency,
        IReadOnlyList<DealEvidenceSnippet> allowedSnippets,
        string modelUsed,
        DateTime checkedAtUtc)
    {
        var cleaned = StripJsonFence(rawJson);
        var allowedUrls = new HashSet<string>(
            allowedSnippets.Select(s => NormalizeSafeUrl(s.Url)).Where(u => u.Length > 0),
            StringComparer.OrdinalIgnoreCase);

        using var doc = JsonDocument.Parse(cleaned);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new FoundryServiceException("Product Watch received an invalid response format from gpt-6.1-sol.");
        }

        var productName = NormalizeText(ReadString(root, "productName"), 200);
        if (productName.Length == 0) productName = fallbackProductName;

        var modelOrSku = NormalizeText(ReadString(root, "modelOrSku"), 120);
        if (modelOrSku.Length == 0) modelOrSku = fallbackModelOrSku;

        var currency = NormalizeCurrency(ReadString(root, "currency"));
        if (string.IsNullOrWhiteSpace(ReadString(root, "currency"))) currency = fallbackCurrency;

        var offers = new List<ProductWatchOfferDto>();
        if (root.TryGetProperty("offers", out var offersElement) && offersElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var offerEl in offersElement.EnumerateArray())
            {
                if (offerEl.ValueKind != JsonValueKind.Object) continue;
                var retailer = NormalizeText(ReadString(offerEl, "retailer"), 120);
                var price = ReadDecimal(offerEl, "price");
                if (retailer.Length == 0 || price is null or <= 0) continue;

                var offerCurrency = NormalizeCurrency(ReadString(offerEl, "currency"));
                if (string.IsNullOrWhiteSpace(ReadString(offerEl, "currency"))) offerCurrency = currency;

                var availability = NormalizeText(ReadString(offerEl, "availability"), 48);
                if (availability.Length == 0) availability = "Available";

                var note = NormalizeText(ReadString(offerEl, "note"), 260);
                var rawOfferUrl = NormalizeSafeUrl(ReadString(offerEl, "url"));
                var validOfferUrl = allowedUrls.Count == 0 || allowedUrls.Contains(rawOfferUrl) ? rawOfferUrl : "";

                offers.Add(new ProductWatchOfferDto(
                    Retailer: retailer,
                    Price: Math.Round(price.Value, 2),
                    Currency: offerCurrency,
                    Availability: availability,
                    Note: note,
                    Url: validOfferUrl));
                if (offers.Count >= 6) break;
            }
        }

        offers = offers.OrderBy(o => o.Price).ToList();

        var bestPrice = ReadDecimal(root, "bestPrice");
        if ((bestPrice is null or <= 0) && offers.Count > 0)
        {
            bestPrice = offers[0].Price;
        }
        if (bestPrice is null or <= 0)
        {
            throw new FoundryServiceException("gpt-6.1-sol could not determine a valid numeric price for this product.");
        }
        bestPrice = Math.Round(bestPrice.Value, 2);

        var regularPrice = ReadDecimal(root, "regularPrice");
        if (regularPrice is null or <= 0 || regularPrice.Value < bestPrice.Value)
        {
            regularPrice = offers.Count > 1 ? Math.Max(bestPrice.Value, offers[^1].Price) : bestPrice.Value;
        }
        regularPrice = Math.Round(regularPrice.Value, 2);

        var bestRetailer = NormalizeText(ReadString(root, "bestRetailer"), 160);
        if (bestRetailer.Length == 0 && offers.Count > 0)
        {
            bestRetailer = offers[0].Retailer;
        }
        if (bestRetailer.Length == 0)
        {
            bestRetailer = "Retail Market";
        }

        var rawBestUrl = NormalizeSafeUrl(ReadString(root, "bestOfferUrl"));
        var bestOfferUrl = (allowedUrls.Count == 0 || allowedUrls.Contains(rawBestUrl)) && rawBestUrl.Length > 0
            ? rawBestUrl
            : offers.FirstOrDefault(o => o.Url.Length > 0)?.Url ?? "";

        if (offers.Count == 0)
        {
            offers.Add(new ProductWatchOfferDto(
                Retailer: bestRetailer,
                Price: bestPrice.Value,
                Currency: currency,
                Availability: "Best Price",
                Note: "Lowest price identified by gpt-6.1-sol",
                Url: bestOfferUrl));
        }

        var rawVerdict = NormalizeText(ReadString(root, "priceVerdict"), 32).ToLowerInvariant();
        var priceVerdict = AllowedVerdicts.Contains(rawVerdict)
            ? rawVerdict
            : regularPrice.Value > bestPrice.Value * 1.15m
                ? "great-deal"
                : regularPrice.Value > bestPrice.Value * 1.05m
                    ? "good-price"
                    : "fair-price";

        var summary = NormalizeText(ReadString(root, "summary"), 2000);
        if (summary.Length == 0)
        {
            summary = $"Best price for {productName} ({modelOrSku}) is {currency} {bestPrice.Value:F2} at {bestRetailer}.";
        }

        var buyingTip = NormalizeText(ReadString(root, "buyingTip"), 600);
        var savingsAmount = Math.Max(0m, Math.Round(regularPrice.Value - bestPrice.Value, 2));
        var savingsPercent = regularPrice.Value > 0 && savingsAmount > 0
            ? Math.Round(savingsAmount / regularPrice.Value * 100m, 1)
            : 0m;

        return new ProductPriceCheckResultDto(
            ProductName: productName,
            ModelOrSku: modelOrSku,
            Currency: currency,
            BestPrice: bestPrice.Value,
            RegularPrice: regularPrice.Value,
            SavingsAmount: savingsAmount,
            SavingsPercent: savingsPercent,
            BestRetailer: bestRetailer,
            BestOfferUrl: bestOfferUrl,
            PriceVerdict: priceVerdict,
            Summary: summary,
            BuyingTip: buyingTip,
            Offers: offers.ToArray(),
            Model: modelUsed,
            CheckedAtUtc: checkedAtUtc);
    }

    public static ProductWatchItemDto ToDto(ProductWatchItem entity)
    {
        var offers = ParseOffers(entity.OffersJson);
        var history = ParsePriceHistory(entity.PriceHistoryJson);
        decimal? savingsAmount = null;
        decimal? savingsPercent = null;
        if (entity.BestPrice.HasValue && entity.RegularPrice.HasValue && entity.RegularPrice.Value > entity.BestPrice.Value)
        {
            savingsAmount = Math.Round(entity.RegularPrice.Value - entity.BestPrice.Value, 2);
            if (entity.RegularPrice.Value > 0)
            {
                savingsPercent = Math.Round(savingsAmount.Value / entity.RegularPrice.Value * 100m, 1);
            }
        }

        var isTargetMet = entity.BestPrice.HasValue
            && entity.TargetPrice.HasValue
            && entity.TargetPrice.Value > 0
            && entity.BestPrice.Value <= entity.TargetPrice.Value;

        var isPriceDrop = entity.BestPrice.HasValue
            && entity.PreviousBestPrice.HasValue
            && entity.BestPrice.Value < entity.PreviousBestPrice.Value;

        return new ProductWatchItemDto(
            Id: entity.Id,
            ProductName: entity.ProductName,
            ModelOrSku: entity.ModelOrSku,
            Frequency: NormalizeFrequency(entity.Frequency),
            FrequencyLabel: GetFrequencyLabel(entity.Frequency),
            Currency: NormalizeCurrency(entity.Currency),
            TargetPrice: entity.TargetPrice,
            Enabled: entity.Enabled,
            NotifyOnPriceDrop: entity.NotifyOnPriceDrop,
            BestPrice: entity.BestPrice,
            RegularPrice: entity.RegularPrice,
            LowestPriceEver: entity.LowestPriceEver,
            PreviousBestPrice: entity.PreviousBestPrice,
            SavingsAmount: savingsAmount,
            SavingsPercent: savingsPercent,
            IsTargetMet: isTargetMet,
            IsPriceDrop: isPriceDrop,
            BestRetailer: entity.BestRetailer,
            BestOfferUrl: entity.BestOfferUrl,
            PriceVerdict: entity.PriceVerdict,
            Summary: entity.Summary,
            BuyingTip: entity.BuyingTip,
            Offers: offers,
            PriceHistory: history,
            ModelUsed: string.IsNullOrWhiteSpace(entity.ModelUsed) ? DefaultModel : entity.ModelUsed,
            CheckCount: entity.CheckCount,
            LastCheckedAtUtc: entity.LastCheckedAtUtc,
            NextCheckAtUtc: entity.NextCheckAtUtc,
            LastError: entity.LastError,
            CreatedAtUtc: entity.CreatedAtUtc,
            UpdatedAtUtc: entity.UpdatedAtUtc);
    }

    public static ProductWatchOfferDto[] ParseOffers(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<ProductWatchOfferDto[]>(json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static ProductPriceHistoryPointDto[] ParsePriceHistory(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<ProductPriceHistoryPointDto[]>(json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static string NormalizeSafeUrl(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        var trimmed = raw.Trim();
        if (trimmed.Length > 2048) return "";
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return "";
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) return "";
        if (!string.IsNullOrEmpty(uri.UserInfo)) return "";
        return uri.AbsoluteUri;
    }

    private static string StripJsonFence(string raw)
    {
        var trimmed = (raw ?? "").Trim();
        if (!trimmed.StartsWith("```", StringComparison.Ordinal))
        {
            return trimmed;
        }

        var firstNewLine = trimmed.IndexOf('\n');
        if (firstNewLine > 0)
        {
            trimmed = trimmed[(firstNewLine + 1)..];
        }
        if (trimmed.EndsWith("```", StringComparison.Ordinal))
        {
            trimmed = trimmed[..^3];
        }
        return trimmed.Trim();
    }

    private static string ReadString(JsonElement obj, string prop)
    {
        if (obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String)
        {
            return el.GetString() ?? "";
        }
        return "";
    }

    private static decimal? ReadDecimal(JsonElement obj, string prop)
    {
        if (!obj.TryGetProperty(prop, out var el)) return null;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetDecimal(out var num))
        {
            return num;
        }
        if (el.ValueKind == JsonValueKind.String)
        {
            var str = el.GetString() ?? "";
            var match = PriceNumberRegex.Match(str);
            if (match.Success
                && decimal.TryParse(
                    match.Value.Replace(",", "", StringComparison.Ordinal),
                    NumberStyles.Number,
                    CultureInfo.InvariantCulture,
                    out var parsed))
            {
                return parsed;
            }
        }
        return null;
    }
}
