using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Models;
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

        var nzTranslation = await service.TranslateAsync(
            "New central Hamilton station and hourly trains to Auckland in Te Huia revamp proposal",
            [
                "Over 60 years, the local share of capital and operating costs was estimated to $31.5 million per annum.",
                "Upgrades rose from $350m to US$10 million ($16.5 million), while $10 million (NZ$16.5 million) stayed foreign.",
            ],
            "zh-Hant",
            CancellationToken.None,
            "https://www.rnz.co.nz/news/politics/2193199/new-central-hamilton-station-and-hourly-trains-to-auckland-in-te-huia-revamp-proposal",
            "RNZ",
            "RNZ | Te Reo Irirangi o Aotearoa");
        Assert(handler.Texts[1] == "Over 60 years, the local share of capital and operating costs was estimated to NZ$31.5 million per annum.",
            "New Zealand bare dollar amount was not qualified as NZ$ before translation.");
        Assert(handler.Texts[2] == "Upgrades rose from NZ$350 million to US$10 million (NZ$16.5 million), while $10 million (NZ$16.5 million) stayed foreign.",
            "Shorthand NZD or dual-currency USD/NZD amounts were not prepared accurately.");
        Assert(nzTranslation.Paragraphs[0].Contains("3150萬紐西蘭元", StringComparison.Ordinal)
            && !nzTranslation.Paragraphs[0].Contains("美元", StringComparison.Ordinal),
            "Translated New Zealand story still reported domestic costs in USD.");

        await service.TranslateAsync(
            "White House spending plan",
            ["The White House asked Congress in Washington for $5 billion."],
            "zh-Hant",
            CancellationToken.None,
            "https://www.rnz.co.nz/news/world/99999/white-house-spending-plan",
            "RNZ");
        Assert(handler.Texts[1] == "The White House asked Congress in Washington for $5 billion.",
            "Foreign US world news story on an NZ publisher was mislabelled as NZD.");

        var sharedNzHtml = SharedArticlePage.Render(new SharedNewsArticle
        {
            Id = new string('f', 48),
            OriginalUrl = "https://www.rnz.co.nz/news/politics/2193199/new-central-hamilton-station-and-hourly-trains-to-auckland-in-te-huia-revamp-proposal",
            Source = "RNZ",
            Byline = "RNZ | Te Reo Irirangi o Aotearoa",
            Language = "zh-Hant",
            Title = "新中央漢密爾頓車站及Te Huia改建計畫中每小時一班開往奧克蘭的列車",
            ParagraphsJson = JsonSerializer.Serialize(new[]
            {
                "60年來，當地資本與營運成本的比例估計為每年3150萬美元。",
                "公司籌集了1,000萬美元（1,650萬紐幣）的資金。",
            }),
        }, "/");
        Assert(sharedNzHtml.Contains("每年3150萬紐西蘭元", StringComparison.Ordinal)
            && !sharedNzHtml.Contains("每年3150萬美元", StringComparison.Ordinal)
            && sharedNzHtml.Contains("1,000萬美元（1,650萬紐幣）", StringComparison.Ordinal),
            "Shared New Zealand translation did not normalize USD mistranslation to NZD while preserving dual-currency USD.");

        var disabled = new AzureTranslatorService(Options.Create(new AzureTranslatorOptions()), new Factory(client), cache);
        posts = handler.Posts;
        Assert(!(await disabled.TranslateAsync("Title", ["Body"], "en", CancellationToken.None)).Available && handler.Posts == posts, "Missing key made a cloud call.");

        // Snippet translation checks for image captions & OCR text
        var snippets = await service.TranslateTextsAsync(["A mountain peak at sunset", "Official Cash Rate 4.25%"], "zh-Hans", CancellationToken.None);
        Assert(snippets.Length == 2 && snippets[0] == "Translated:A mountain peak at sunset" && snippets[1] == "Translated:Official Cash Rate 4.25%",
            "Snippet translation failed to return translated texts.");

        var englishNoop = await service.TranslateTextsAsync(["Original english text"], "en", CancellationToken.None);
        Assert(englishNoop[0] == "Original english text", "English snippet translation should return immediately without API calls.");

        Console.WriteLine("Azure Translator passed full-text order, language/text cache, currency disambiguation, endpoint validation, request limits, failures, cancellation, custom endpoint and missing-key checks without cloud calls.");
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
            var responseBody = JsonSerializer.Serialize(items.Select(text => new
            {
                translations = new[]
                {
                    new
                    {
                        text = text.Contains("NZ$31.5 million", StringComparison.Ordinal)
                            ? "60年來，當地資本與營運成本的比例估計為每年3150萬美元。"
                            : "Translated:" + text,
                        to = language,
                    },
                },
            }));
            Submitted?.Invoke();
            token.ThrowIfCancellationRequested();
            return new(Status) { Content = new StringContent(responseBody, Encoding.UTF8, "application/json") };
        }
    }
}
