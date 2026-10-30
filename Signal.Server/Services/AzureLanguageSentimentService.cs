using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record ArticleSentimentResult(
    bool Available,
    string Reason,
    string Sentiment,
    double PositiveScore,
    double NeutralScore,
    double NegativeScore
);

public sealed class AzureLanguageSentimentService(
    IOptions<AzureLanguageOptions> options,
    IHttpClientFactory clients,
    IMemoryCache cache)
{
    public const string HttpClientName = "AzureLanguageSentiment";

    public bool Enabled => options.Value.Enabled;

    public async Task<ArticleSentimentResult> AnalyzeSentimentAsync(string text, CancellationToken token)
    {
        if (!Enabled)
            return new(false, "Azure AI Language has not been configured yet.", "neutral", 0, 0, 0);

        var cleanText = (text ?? "").Trim();
        if (cleanText.Length < 30)
            return new(false, "Not enough text to analyze sentiment.", "neutral", 0, 0, 0);

        if (cleanText.Length > 4_000)
            cleanText = cleanText[..4_000];

        var endpoint = options.Value.Validate();
        var cacheKey = "azure-sentiment:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(endpoint + "\n" + cleanText)));

        if (cache.TryGetValue(cacheKey, out ArticleSentimentResult? ready) && ready is not null)
            return ready;

        try
        {
            var client = clients.CreateClient(HttpClientName);
            var isChinese = cleanText.Count(c => c is >= '\u4e00' and <= '\u9fff') > cleanText.Length / 5;
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(endpoint, "language/:analyze-text?api-version=2023-04-01"));
            request.Headers.Add("Ocp-Apim-Subscription-Key", options.Value.Key);
            request.Headers.Accept.ParseAdd("application/json");

            request.Content = JsonContent.Create(new
            {
                kind = "SentimentAnalysis",
                parameters = new
                {
                    modelVersion = "latest",
                    loggingOptOut = true
                },
                analysisInput = new
                {
                    documents = new[]
                    {
                        new
                        {
                            id = "1",
                            language = isChinese ? "zh-hans" : "en",
                            text = cleanText
                        }
                    }
                }
            });

            using var response = await client.SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                return new(false, $"Azure AI Language returned status {(int)response.StatusCode}.", "neutral", 0, 0, 0);
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var parsed = Parse(json.RootElement);

            cache.Set(cacheKey, parsed, TimeSpan.FromHours(24));
            return parsed;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return new(false, "Azure sentiment analysis is temporarily unavailable.", "neutral", 0, 0, 0);
        }
    }

    public static ArticleSentimentResult Parse(JsonElement root)
    {
        if (!root.TryGetProperty("results", out var results) ||
            !results.TryGetProperty("documents", out var docs) ||
            docs.ValueKind != JsonValueKind.Array)
            return new(false, "Unrecognized sentiment response.", "neutral", 0, 0, 0);

        var first = docs.EnumerateArray().FirstOrDefault();
        if (first.ValueKind != JsonValueKind.Object)
            return new(false, "Empty sentiment document.", "neutral", 0, 0, 0);

        var sentiment = first.TryGetProperty("sentiment", out var sentProp) && sentProp.ValueKind == JsonValueKind.String
            ? sentProp.GetString()?.ToLowerInvariant() ?? "neutral"
            : "neutral";

        double pos = 0, neu = 0, neg = 0;
        if (first.TryGetProperty("confidenceScores", out var conf) && conf.ValueKind == JsonValueKind.Object)
        {
            if (conf.TryGetProperty("positive", out var p)) pos = p.GetDouble();
            if (conf.TryGetProperty("neutral", out var n)) neu = n.GetDouble();
            if (conf.TryGetProperty("negative", out var g)) neg = g.GetDouble();
        }

        return new ArticleSentimentResult(true, "", sentiment, pos, neu, neg);
    }
}
