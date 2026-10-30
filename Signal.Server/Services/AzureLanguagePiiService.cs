using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record PiiEntity(
    string Text,
    string Category,
    string? Subcategory,
    double ConfidenceScore,
    int Offset,
    int Length
);

public sealed record PiiAnalysisResult(
    bool Available,
    string Reason,
    bool HasPii,
    string RedactedText,
    PiiEntity[] Entities
)
{
    private static readonly HashSet<string> HighRiskCategories = new(StringComparer.OrdinalIgnoreCase)
    {
        "Email",
        "PhoneNumber",
        "Address",
        "IPAddress",
        "CreditCardNumber",
        "USSocialSecurityNumber",
        "InternationalBankingAccountNumber",
        "SWIFTCode",
        "DriversLicenseNumber",
        "PassportNumber"
    };

    public bool HasHighRiskPii => Entities.Any(e => HighRiskCategories.Contains(e.Category));
}

public sealed partial class AzureLanguagePiiService(
    IOptions<AzureLanguageOptions> options,
    IHttpClientFactory clients,
    IMemoryCache cache,
    ILogger<AzureLanguagePiiService> logger)
{
    public const string HttpClientName = "AzureLanguagePii";

    public bool Enabled => options.Value.Enabled;

    [GeneratedRegex(@"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", RegexOptions.Compiled)]
    private static partial Regex EmailRegex();

    [GeneratedRegex(@"(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}\b", RegexOptions.Compiled)]
    private static partial Regex PhoneRegex();

    [GeneratedRegex(@"\b(?:\d{4}[-\s]?){3}\d{4}\b", RegexOptions.Compiled)]
    private static partial Regex CreditCardRegex();

    public async Task<PiiAnalysisResult> AnalyzeAndRedactAsync(string text, CancellationToken token)
    {
        var cleanText = (text ?? "").Trim();
        if (cleanText.Length == 0)
            return new(true, "", false, "", []);

        if (cleanText.Length > 4_000)
            cleanText = cleanText[..4_000];

        if (!Enabled)
        {
            // When Azure Language is not configured, apply local regex privacy mask
            return LocalRedact(cleanText, isFallback: true);
        }

        var endpoint = options.Value.Validate();
        var cacheKey = "azure-pii:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(endpoint + "\n" + cleanText)));

        if (cache.TryGetValue(cacheKey, out PiiAnalysisResult? ready) && ready is not null)
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
                kind = "PiiEntityRecognition",
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
                logger.LogWarning("Azure AI Language PII returned status {StatusCode}. Using local fallback.", (int)response.StatusCode);
                return LocalRedact(cleanText, isFallback: true);
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var result = Parse(json.RootElement, cleanText);
            cache.Set(cacheKey, result, TimeSpan.FromHours(24));
            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Azure AI Language PII request failed. Using local fallback.");
            return LocalRedact(cleanText, isFallback: true);
        }
    }

    public static PiiAnalysisResult Parse(JsonElement root, string originalText)
    {
        try
        {
            if (!root.TryGetProperty("results", out var results)
                || !results.TryGetProperty("documents", out var documents)
                || documents.GetArrayLength() == 0)
            {
                return new(true, "", false, originalText, []);
            }

            var doc = documents[0];
            var redactedText = doc.TryGetProperty("redactedText", out var rt) && rt.ValueKind == JsonValueKind.String
                ? rt.GetString() ?? originalText
                : originalText;

            var entitiesList = new List<PiiEntity>();
            if (doc.TryGetProperty("entities", out var entities) && entities.ValueKind == JsonValueKind.Array)
            {
                foreach (var entity in entities.EnumerateArray())
                {
                    var text = entity.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                    var category = entity.TryGetProperty("category", out var c) ? c.GetString() ?? "" : "";
                    var subcategory = entity.TryGetProperty("subcategory", out var sc) && sc.ValueKind == JsonValueKind.String
                        ? sc.GetString()
                        : null;
                    var score = entity.TryGetProperty("confidenceScore", out var cs) ? cs.GetDouble() : 0.0;
                    var offset = entity.TryGetProperty("offset", out var off) ? off.GetInt32() : 0;
                    var length = entity.TryGetProperty("length", out var len) ? len.GetInt32() : text.Length;

                    if (!string.IsNullOrWhiteSpace(text) && !string.IsNullOrWhiteSpace(category))
                    {
                        entitiesList.Add(new(text, category, subcategory, score, offset, length));
                    }
                }
            }

            return new(
                true,
                "",
                entitiesList.Count > 0,
                redactedText,
                entitiesList.ToArray()
            );
        }
        catch
        {
            return LocalRedact(originalText, isFallback: true);
        }
    }

    public static PiiAnalysisResult LocalRedact(string text, bool isFallback = false)
    {
        var entities = new List<PiiEntity>();
        var redacted = text;

        // Mask Credit Cards first
        foreach (Match match in CreditCardRegex().Matches(redacted))
        {
            if (match.Success && match.Length >= 12)
            {
                entities.Add(new(match.Value, "CreditCardNumber", null, 0.95, match.Index, match.Length));
                redacted = redacted.Replace(match.Value, new string('*', match.Length));
            }
        }

        // Mask Emails
        foreach (Match match in EmailRegex().Matches(redacted))
        {
            if (match.Success)
            {
                entities.Add(new(match.Value, "Email", null, 0.98, match.Index, match.Length));
                redacted = redacted.Replace(match.Value, new string('*', match.Length));
            }
        }

        // Mask Phone Numbers
        foreach (Match match in PhoneRegex().Matches(redacted))
        {
            if (match.Success && match.Value.Count(char.IsDigit) >= 7)
            {
                entities.Add(new(match.Value, "PhoneNumber", null, 0.85, match.Index, match.Length));
                redacted = redacted.Replace(match.Value, new string('*', match.Length));
            }
        }

        return new(
            !isFallback,
            isFallback ? "Local privacy filter applied." : "",
            entities.Count > 0,
            redacted,
            entities.ToArray()
        );
    }
}
