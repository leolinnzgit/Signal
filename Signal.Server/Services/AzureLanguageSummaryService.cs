using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class AzureLanguageOptions
{
    public const string SectionName = "AzureLanguage";
    public string Endpoint { get; set; } = "";
    public string Key { get; set; } = "";
    public bool Enabled => !string.IsNullOrWhiteSpace(Endpoint) && !string.IsNullOrWhiteSpace(Key);

    internal Uri Validate()
    {
        if (!Uri.TryCreate(Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || uri.AbsolutePath != "/" || !uri.Host.EndsWith(".cognitiveservices.azure.com", StringComparison.OrdinalIgnoreCase)
            || Key.Length is < 20 or > 256 || Key.Any(char.IsWhiteSpace) || Key.Any(char.IsControl))
            throw new ArticleSummaryException("Azure article summaries need a valid Language resource endpoint and key.");
        return uri;
    }
}

public sealed class ArticleSummaryException(string message) : Exception(message);
public sealed record ArticleSummaryResult(bool Available, string Reason, string[] Paragraphs);

public sealed class AzureLanguageSummaryService(
    IOptions<AzureLanguageOptions> options, IHttpClientFactory clients, IMemoryCache cache)
{
    public const string HttpClientName = "AzureLanguage";
    private readonly SemaphoreSlim gate = new(1, 1);
    public bool Enabled => options.Value.Enabled;

    public async Task<ArticleSummaryResult> SummarizeAsync(IReadOnlyList<string> paragraphs, CancellationToken token)
    {
        if (!Enabled) return new(false, "Azure article summaries have not been configured yet.", []);
        var endpoint = options.Value.Validate();
        var text = string.Join("\n\n", paragraphs).Trim();
        if (text.Length < 100 || text.Length > 30_000)
            return new(false, "There is not enough supported article text to summarize.", []);
        var key = "azure-summary:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(endpoint + "\n" + text)));
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(75));
        await gate.WaitAsync(deadline.Token);
        try
        {
            if (cache.TryGetValue(key, out ArticleSummaryResult? ready) && ready is not null) return ready;
            var client = clients.CreateClient(HttpClientName);
            using var request = CreateRequest(HttpMethod.Post, new Uri(endpoint, "language/analyze-text/jobs?api-version=2023-04-01"));
            request.Content = JsonContent.Create(new
            {
                displayName = "Signal article summary",
                analysisInput = new { documents = new[] { new { id = "1", text, language = text.Count(character => character is >= '\u4e00' and <= '\u9fff') > text.Length / 5 ? "zh-hans" : "en" } } },
                tasks = new[] { new { kind = "AbstractiveSummarization", taskName = "summary", parameters = new { sentenceCount = 3, loggingOptOut = true } } },
            });
            using var submitted = await client.SendAsync(request, deadline.Token);
            EnsureSuccess(submitted);
            if (!submitted.Headers.TryGetValues("operation-location", out var locations)
                || !Uri.TryCreate(locations.FirstOrDefault(), UriKind.Absolute, out var job)
                || job.GetLeftPart(UriPartial.Authority) != endpoint.GetLeftPart(UriPartial.Authority)
                || job.UserInfo.Length != 0 || !job.AbsolutePath.StartsWith("/language/analyze-text/jobs/", StringComparison.Ordinal))
                throw new ArticleSummaryException("Azure did not return a valid summary job.");
            while (true)
            {
                await Task.Delay(TimeSpan.FromSeconds(1), deadline.Token);
                using var poll = CreateRequest(HttpMethod.Get, job);
                using var response = await client.SendAsync(poll, deadline.Token);
                EnsureSuccess(response);
                await response.Content.LoadIntoBufferAsync(1_000_000, deadline.Token);
                using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
                var root = body.RootElement;
                var status = root.GetProperty("status").GetString();
                if (status == "succeeded")
                {
                    var items = root.GetProperty("tasks").GetProperty("items");
                    var summaries = items.EnumerateArray()
                        .Where(item => item.GetProperty("status").GetString() == "succeeded")
                        .SelectMany(item => item.GetProperty("results").GetProperty("documents").EnumerateArray())
                        .SelectMany(document => document.GetProperty("summaries").EnumerateArray())
                        .Select(summary => summary.GetProperty("text").GetString()?.Trim() ?? "")
                        .Where(summary => summary.Length > 0).ToArray();
                    if (summaries.Length == 0 || summaries.Sum(summary => summary.Length) > 10_000)
                        throw new ArticleSummaryException("Azure could not summarize this article's language or text.");
                    var result = new ArticleSummaryResult(true, "", summaries);
                    cache.Set(key, result, TimeSpan.FromHours(24));
                    return result;
                }
                if (status is not ("notStarted" or "running"))
                    throw new ArticleSummaryException("Azure could not summarize this article's language or text.");
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new ArticleSummaryException("The summary took too long. Please try again.");
        }
        finally { gate.Release(); }
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, Uri uri)
    {
        var request = new HttpRequestMessage(method, uri);
        request.Headers.Add("Ocp-Apim-Subscription-Key", options.Value.Key);
        return request;
    }

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return;
        throw new ArticleSummaryException(response.StatusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => "Azure summaries could not authenticate. Check the Language resource key and endpoint.",
            HttpStatusCode.TooManyRequests => "Azure's summary request limit was reached. Please try again later.",
            _ => "Azure article summaries are temporarily unavailable. Please try again.",
        });
    }
}
