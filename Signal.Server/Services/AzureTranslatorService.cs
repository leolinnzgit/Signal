using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class AzureTranslatorOptions
{
    public const string SectionName = "AzureTranslator";
    public string Endpoint { get; set; } = "https://api.cognitive.microsofttranslator.com/";
    public string Key { get; set; } = "";
    public string Region { get; set; } = "";
    public bool Enabled => !string.IsNullOrWhiteSpace(Key);

    internal Uri Validate()
    {
        if (!Uri.TryCreate(Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || uri.AbsolutePath != "/" || !(uri.Host is "api.cognitive.microsofttranslator.com"
                or "api-nam.cognitive.microsofttranslator.com" or "api-eur.cognitive.microsofttranslator.com"
                or "api-apc.cognitive.microsofttranslator.com"
                || uri.Host.EndsWith(".cognitiveservices.azure.com", StringComparison.OrdinalIgnoreCase))
            || Key.Length is < 20 or > 256 || Key.Any(char.IsWhiteSpace) || Key.Any(char.IsControl)
            || Region.Length > 64 || Region.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-'))
            throw new ArticleTranslationException("Azure translation needs a valid Translator endpoint, key and region.");
        return uri;
    }
}

public sealed class ArticleTranslationException(string message) : Exception(message);
public sealed record ArticleTranslationResult(bool Available, string Reason, string Title, string[] Paragraphs, string Language);

public sealed class AzureTranslatorService(
    IOptions<AzureTranslatorOptions> options, IHttpClientFactory clients, IMemoryCache cache)
{
    public const string HttpClientName = "AzureTranslator";
    internal static readonly string[] Languages = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "fr", "de", "es", "it", "pt", "ar", "hi"];
    private readonly SemaphoreSlim gate = new(1, 1);
    public bool Enabled => options.Value.Enabled;

    public async Task<ArticleTranslationResult> TranslateAsync(string title, IReadOnlyList<string> paragraphs, string language, CancellationToken token)
    {
        if (!Languages.Contains(language, StringComparer.Ordinal)) throw new ArgumentException("Choose a supported translation language.");
        if (!Enabled) return new(false, "Azure Translator has not been configured yet.", "", [], language);
        var endpoint = options.Value.Validate();
        if (string.IsNullOrWhiteSpace(title) || title.Length > 1_000 || paragraphs.Count is < 1 or > 80
            || paragraphs.Any(string.IsNullOrWhiteSpace) || paragraphs.Sum(text => (long)text.Length) > 30_000)
            throw new ArgumentException("This article exceeds the supported translation size.");
        var texts = new[] { title }.Concat(paragraphs).ToArray();
        var cacheKey = "azure-translation:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            endpoint + "\n" + language + "\n" + JsonSerializer.Serialize(texts))));
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));
        var acquired = false;
        try
        {
            await gate.WaitAsync(deadline.Token);
            acquired = true;
            if (cache.TryGetValue(cacheKey, out ArticleTranslationResult? ready) && ready is not null) return ready;
            var path = endpoint.Host.EndsWith(".cognitiveservices.azure.com", StringComparison.OrdinalIgnoreCase)
                ? "translator/text/v3.0/translate" : "translate";
            using var request = new HttpRequestMessage(HttpMethod.Post,
                new Uri(endpoint, path + "?api-version=3.0&textType=plain&to=" + Uri.EscapeDataString(language)));
            request.Headers.Add("Ocp-Apim-Subscription-Key", options.Value.Key);
            if (!string.IsNullOrEmpty(options.Value.Region)) request.Headers.Add("Ocp-Apim-Subscription-Region", options.Value.Region);
            request.Content = JsonContent.Create(texts.Select(text => new { text }).ToArray());
            using var response = await clients.CreateClient(HttpClientName).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode) throw new ArticleTranslationException(response.StatusCode switch
            {
                HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => "Azure Translator could not authorize this request. Check the key, region and subscription quota.",
                HttpStatusCode.TooManyRequests => "Azure's translation request limit was reached. Please try again later.",
                _ => "Azure translation is temporarily unavailable. Please try again.",
            });
            await response.Content.LoadIntoBufferAsync(1_000_000, deadline.Token);
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
            if (body.RootElement.ValueKind != JsonValueKind.Array || body.RootElement.GetArrayLength() != texts.Length)
                throw new ArticleTranslationException("Azure returned an incomplete translation. Please try again.");
            var translated = body.RootElement.EnumerateArray().Select(item => item.GetProperty("translations").EnumerateArray()
                .Single(translation => translation.GetProperty("to").GetString() == language).GetProperty("text").GetString() ?? "").ToArray();
            if (translated.Any(string.IsNullOrWhiteSpace) || translated.Sum(text => (long)text.Length) > 150_000)
                throw new ArticleTranslationException("Azure returned an incomplete translation. Please try again.");
            var result = new ArticleTranslationResult(true, "", translated[0], translated[1..], language);
            cache.Set(cacheKey, result, TimeSpan.FromHours(24));
            return result;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new ArticleTranslationException("The translation took too long. Please try again.");
        }
        finally { if (acquired) gate.Release(); }
    }
}
