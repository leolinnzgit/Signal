using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record ArticleKeyPhrasesResult(
    bool Available,
    string Reason,
    string[] KeyPhrases
);

public sealed class AzureLanguageKeyPhraseService(
    IOptions<AzureLanguageOptions> options,
    IHttpClientFactory clients,
    IMemoryCache cache)
{
    public const string HttpClientName = "AzureLanguageKeyPhrases";

    public bool Enabled => options.Value.Enabled;

    public async Task<ArticleKeyPhrasesResult> ExtractKeyPhrasesAsync(string text, CancellationToken token)
    {
        if (!Enabled)
            return new(false, "Azure AI Language has not been configured yet.", []);

        var cleanText = (text ?? "").Trim();
        if (cleanText.Length < 30)
            return new(false, "Not enough text to extract key phrases.", []);

        if (cleanText.Length > 4_000)
            cleanText = cleanText[..4_000];

        var endpoint = options.Value.Validate();
        var cacheKey = "azure-keyphrases:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(endpoint + "\n" + cleanText)));

        if (cache.TryGetValue(cacheKey, out ArticleKeyPhrasesResult? ready) && ready is not null)
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
                kind = "KeyPhraseExtraction",
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
            var parsed = Parse(json.RootElement);

            cache.Set(cacheKey, parsed, TimeSpan.FromHours(24));
            return parsed;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return new(false, "Azure key phrase extraction is temporarily unavailable.", []);
        }
    }

    public static ArticleKeyPhrasesResult Parse(JsonElement root)
    {
        if (!root.TryGetProperty("results", out var results) ||
            !results.TryGetProperty("documents", out var docs) ||
            docs.ValueKind != JsonValueKind.Array)
            return new(false, "Unrecognized key phrase response.", []);

        var first = docs.EnumerateArray().FirstOrDefault();
        if (first.ValueKind != JsonValueKind.Object)
            return new(false, "Empty key phrase document.", []);

        if (!first.TryGetProperty("keyPhrases", out var phrases) || phrases.ValueKind != JsonValueKind.Array)
            return new(true, "", []);

        var list = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var phrase in phrases.EnumerateArray())
        {
            if (phrase.ValueKind != JsonValueKind.String) continue;
            var text = phrase.GetString()?.Trim() ?? "";
            if (text.Length < 2 || text.Length > 80) continue;
            if (seen.Add(text))
            {
                list.Add(text);
                if (list.Count >= 6) break;
            }
        }

        return new ArticleKeyPhrasesResult(true, "", list.ToArray());
    }
}
