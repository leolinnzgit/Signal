using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record RecognizedEntity(
    string Text,
    string Category,
    string? Subcategory,
    double ConfidenceScore
);

public sealed record ArticleEntitiesResult(
    bool Available,
    string Reason,
    RecognizedEntity[] Entities
);

public sealed class AzureLanguageEntityService(
    IOptions<AzureLanguageOptions> options,
    IHttpClientFactory clients,
    IMemoryCache cache)
{
    public const string HttpClientName = "AzureLanguageEntities";
    private static readonly HashSet<string> DesiredCategories = new(StringComparer.OrdinalIgnoreCase)
    {
        "Person", "Organization", "Location", "Product", "Event", "Skill"
    };

    public bool Enabled => options.Value.Enabled;

    public async Task<ArticleEntitiesResult> ExtractEntitiesAsync(string text, CancellationToken token)
    {
        if (!Enabled)
            return new(false, "Azure AI Language has not been configured yet.", []);

        var cleanText = (text ?? "").Trim();
        if (cleanText.Length < 30)
            return new(false, "Not enough text to extract entities.", []);

        if (cleanText.Length > 4_000)
            cleanText = cleanText[..4_000];

        var endpoint = options.Value.Validate();
        var cacheKey = "azure-ner:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(endpoint + "\n" + cleanText)));

        if (cache.TryGetValue(cacheKey, out ArticleEntitiesResult? ready) && ready is not null)
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
                kind = "EntityRecognition",
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
                return new(false, $"Azure AI Language returned status {(int)response.StatusCode}.", []);
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var entities = Parse(json.RootElement);

            var result = new ArticleEntitiesResult(true, "", entities);
            cache.Set(cacheKey, result, TimeSpan.FromHours(24));
            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return new(false, "Azure entity recognition is temporarily unavailable.", []);
        }
    }

    public static RecognizedEntity[] Parse(JsonElement root)
    {
        var list = new List<RecognizedEntity>();
        if (!root.TryGetProperty("results", out var results) ||
            !results.TryGetProperty("documents", out var docs) ||
            docs.ValueKind != JsonValueKind.Array)
            return [];

        foreach (var doc in docs.EnumerateArray())
        {
            if (!doc.TryGetProperty("entities", out var entities) || entities.ValueKind != JsonValueKind.Array)
                continue;

            foreach (var entity in entities.EnumerateArray())
            {
                try
                {
                    var text = entity.GetProperty("text").GetString()?.Trim() ?? "";
                    var category = entity.GetProperty("category").GetString()?.Trim() ?? "";
                    var confidence = entity.GetProperty("confidenceScore").GetDouble();
                    string? subcategory = entity.TryGetProperty("subcategory", out var subProp) && subProp.ValueKind == JsonValueKind.String
                        ? subProp.GetString()?.Trim()
                        : null;

                    if (text.Length is < 2 or > 100 || confidence < 0.65)
                        continue;

                    if (!DesiredCategories.Contains(category))
                        continue;

                    list.Add(new RecognizedEntity(text, category, subcategory, confidence));
                }
                catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException)
                {
                    // Skip malformed entity
                }
            }
        }

        // Deduplicate entities case-insensitively, keeping the entry with the highest confidence
        var unique = list
            .GroupBy(e => e.Text, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.OrderByDescending(e => e.ConfidenceScore).First())
            .OrderByDescending(e => e.ConfidenceScore)
            .Take(12)
            .ToArray();

        return unique;
    }
}
