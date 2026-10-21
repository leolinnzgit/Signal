using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class AzureTranslatorChecks
{
    public static async Task RunAsync()
    {
        var settings = new AzureTranslatorOptions { Key = "fake-test-key-not-a-credential", Region = "australiaeast" };
        foreach (var endpoint in new[] { "http://api.cognitive.microsofttranslator.com/", "https://example.com/", "https://api.cognitive.microsofttranslator.com/other", "https://api.cognitive.microsofttranslator.com/?key=test", "https://api.cognitive.microsofttranslator.com.example.com/" })
        {
            try { new AzureTranslatorOptions { Endpoint = endpoint, Key = settings.Key }.Validate(); throw new Exception("Unsafe Translator endpoint accepted."); }
            catch (ArticleTranslationException) { }
        }
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var handler = new TranslationHandler(settings);
        using var client = new HttpClient(handler);
        var service = new AzureTranslatorService(Options.Create(settings), new Factory(client), cache);
        var result = await service.TranslateAsync("Original title", ["First paragraph.", "Second paragraph."], "zh-Hans", CancellationToken.None);
        Assert(result.Available && result.Title == "Translated:Original title" && result.Paragraphs.SequenceEqual(new[] { "Translated:First paragraph.", "Translated:Second paragraph." }), "Title or paragraph order was lost.");
        Assert(handler.Posts == 1 && handler.Texts.SequenceEqual(new[] { "Original title", "First paragraph.", "Second paragraph." }), "Full article text was not submitted.");
        await service.TranslateAsync("Original title", ["First paragraph.", "Second paragraph."], "zh-Hans", CancellationToken.None);
        Assert(handler.Posts == 1, "Repeated translation was not cached.");
        await service.TranslateAsync("Original title", ["First paragraph.", "Second paragraph."], "en", CancellationToken.None);
        await service.TranslateAsync("Changed title", ["First paragraph.", "Second paragraph."], "en", CancellationToken.None);
        Assert(handler.Posts == 3, "Language or text changes reused the wrong translation.");
        try { await service.TranslateAsync("Title", ["Body"], "en&to=fr", CancellationToken.None); throw new Exception("Invalid language accepted."); }
        catch (ArgumentException) { }
        try { await service.TranslateAsync("Title", [new string('x', 30_001)], "en", CancellationToken.None); throw new Exception("Oversized article accepted."); }
        catch (ArgumentException) { }
        Assert(handler.Posts == 3, "Invalid requests reached Azure.");
        foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.TooManyRequests, HttpStatusCode.Redirect })
        {
            handler.Status = status;
            try { await service.TranslateAsync(status.ToString(), ["Body"], "en", CancellationToken.None); throw new Exception("Azure failure accepted."); }
            catch (ArticleTranslationException exception) { Assert(!exception.ToString().Contains(settings.Key), "Failure exposed credentials."); }
        }
        handler.Status = HttpStatusCode.OK;
        handler.Incomplete = true;
        try { await service.TranslateAsync("Incomplete", ["Body"], "en", CancellationToken.None); throw new Exception("Partial output accepted."); }
        catch (ArticleTranslationException) { }
        handler.Incomplete = false;
        using var abort = new CancellationTokenSource();
        handler.Submitted = () => abort.Cancel();
        try { await service.TranslateAsync("Canceled", ["Body"], "en", abort.Token); throw new Exception("Cancellation ignored."); }
        catch (OperationCanceledException) { }
        handler.Submitted = null;
        var posts = handler.Posts;
        await service.TranslateAsync("Canceled", ["Body"], "en", CancellationToken.None);
        Assert(handler.Posts == posts + 1, "Canceled request was cached or held the queue.");
        settings.Endpoint = "https://signal-translator.cognitiveservices.azure.com/";
        await service.TranslateAsync("Custom", ["Body"], "en", CancellationToken.None);
        Assert(handler.LastUri!.AbsolutePath == "/translator/text/v3.0/translate", "Custom resource path was incorrect.");
        var disabled = new AzureTranslatorService(Options.Create(new AzureTranslatorOptions()), new Factory(client), cache);
        posts = handler.Posts;
        Assert(!(await disabled.TranslateAsync("Title", ["Body"], "en", CancellationToken.None)).Available && handler.Posts == posts, "Missing key made a cloud call.");
        Console.WriteLine("Azure Translator passed full-text order, language/text cache, endpoint validation, request limits, failures, cancellation, custom endpoint and missing-key checks without cloud calls.");
    }

    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    private sealed class Factory(HttpClient client) : IHttpClientFactory { public HttpClient CreateClient(string name) => client; }
    private sealed class TranslationHandler(AzureTranslatorOptions settings) : HttpMessageHandler
    {
        public int Posts;
        public string[] Texts = [];
        public Uri? LastUri;
        public HttpStatusCode Status = HttpStatusCode.OK;
        public bool Incomplete;
        public Action? Submitted;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Posts++;
            LastUri = request.RequestUri!;
            Assert(request.Headers.GetValues("Ocp-Apim-Subscription-Key").Single() == settings.Key
                && request.Headers.GetValues("Ocp-Apim-Subscription-Region").Single() == settings.Region, "Missing server authentication headers.");
            Assert(!LastUri.Query.Contains("from=") && LastUri.Query.Contains("textType=plain"), "Source detection or plain text translation was lost.");
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Texts = body.RootElement.EnumerateArray().Select(item => item.GetProperty("text").GetString()!).ToArray();
            var language = Uri.UnescapeDataString(LastUri.Query.Split("to=")[1]);
            var items = Incomplete ? Texts.Take(1) : Texts;
            var responseBody = JsonSerializer.Serialize(items.Select(text => new { translations = new[] { new { text = "Translated:" + text, to = language } } }));
            Submitted?.Invoke();
            token.ThrowIfCancellationRequested();
            return new(Status) { Content = new StringContent(responseBody, Encoding.UTF8, "application/json") };
        }
    }
}
