using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class AzureLanguageSummaryChecks
{
    public static async Task RunAsync()
    {
        var settings = new AzureLanguageOptions { Endpoint = "https://signal-language.cognitiveservices.azure.com/", Key = "fake-test-key-not-a-credential" };
        foreach (var endpoint in new[] { "http://signal-language.cognitiveservices.azure.com/", "https://example.com/", "https://signal-language.cognitiveservices.azure.com/other", "https://signal-language.cognitiveservices.azure.com/?key=test" })
        {
            try { new AzureLanguageOptions { Endpoint = endpoint, Key = settings.Key }.Validate(); throw new Exception("Unsafe summary endpoint accepted."); }
            catch (ArticleSummaryException) { }
        }
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var handler = new SummaryHandler(settings.Key);
        using var client = new HttpClient(handler);
        var service = new AzureLanguageSummaryService(Options.Create(settings), new Factory(client), cache);
        var text = new[] { "This is the actual extracted article text, rather than a headline or feed snippet. " + new string('a', 150) };
        var result = await service.SummarizeAsync(text, CancellationToken.None);
        Assert(result.Available && result.Paragraphs.SequenceEqual(new[] { "A useful article summary." }), "Azure result was lost.");
        Assert(handler.Posts == 1 && handler.Polls == 2 && handler.Text == text[0] && handler.Language == "en", "Article text or asynchronous polling was incorrect.");
        await service.SummarizeAsync(text, CancellationToken.None);
        Assert(handler.Posts == 1, "Reopening charged for the same text again.");
        await service.SummarizeAsync([new string('新', 200)], CancellationToken.None);
        Assert(handler.Posts == 2 && handler.Language == "zh-hans", "Changed Chinese text reused an English summary.");
        handler.Status = HttpStatusCode.TooManyRequests;
        try { await service.SummarizeAsync([text[0] + " changed"], CancellationToken.None); throw new Exception("Quota failure accepted."); }
        catch (ArticleSummaryException exception) { Assert(exception.Message.Contains("limit") && !exception.ToString().Contains(settings.Key), "Quota diagnosis leaked a key or lost its reason."); }
        handler.Status = HttpStatusCode.Accepted;
        handler.ForeignJob = true;
        try { await service.SummarizeAsync([text[0] + " foreign"], CancellationToken.None); throw new Exception("Foreign polling origin accepted."); }
        catch (ArticleSummaryException) { }
        handler.ForeignJob = false;
        using var abort = new CancellationTokenSource();
        handler.Submitted = () => abort.Cancel();
        try { await service.SummarizeAsync([text[0] + " cancel"], abort.Token); throw new Exception("Cancellation ignored."); }
        catch (OperationCanceledException) { }
        handler.Submitted = null;
        var posts = handler.Posts;
        await service.SummarizeAsync([text[0] + " cancel"], CancellationToken.None);
        Assert(handler.Posts == posts + 1, "Canceled summary was cached or held the queue.");
        var disabled = new AzureLanguageSummaryService(Options.Create(new AzureLanguageOptions()), new Factory(client), cache);
        Assert(!(await disabled.SummarizeAsync(text, CancellationToken.None)).Available && handler.Posts == posts + 1, "Missing configuration made a cloud call.");
        Console.WriteLine("Azure summaries passed full-text submission, job polling, text cache, Chinese language, quota, credential origin, cancellation and missing configuration checks without cloud calls.");
    }

    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    private sealed class Factory(HttpClient client) : IHttpClientFactory { public HttpClient CreateClient(string name) => client; }
    private sealed class SummaryHandler(string key) : HttpMessageHandler
    {
        public int Posts, Polls;
        public string Text = "", Language = "";
        public HttpStatusCode Status = HttpStatusCode.Accepted;
        public bool ForeignJob;
        public Action? Submitted;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Assert(request.Headers.GetValues("Ocp-Apim-Subscription-Key").Single() == key, "Missing server credential.");
            if (request.Method == HttpMethod.Post)
            {
                Posts++; Polls = 0;
                using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                var document = json.RootElement.GetProperty("analysisInput").GetProperty("documents")[0];
                Text = document.GetProperty("text").GetString()!;
                Language = document.GetProperty("language").GetString()!;
                var task = json.RootElement.GetProperty("tasks")[0];
                Assert(task.GetProperty("kind").GetString() == "AbstractiveSummarization" && task.GetProperty("parameters").GetProperty("loggingOptOut").GetBoolean(), "Wrong summary mode or logging enabled.");
                var response = new HttpResponseMessage(Status);
                response.Headers.Add("operation-location", ForeignJob ? "https://example.com/language/analyze-text/jobs/1" : "https://signal-language.cognitiveservices.azure.com/language/analyze-text/jobs/1?api-version=2023-04-01");
                Submitted?.Invoke();
                return response;
            }
            Polls++;
            var body = Polls == 1 ? "{\"status\":\"running\"}" : "{\"status\":\"succeeded\",\"tasks\":{\"items\":[{\"status\":\"succeeded\",\"results\":{\"documents\":[{\"summaries\":[{\"text\":\"A useful article summary.\"}]}]}}]}}";
            return new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }
}
