using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class AzureVisionChecks
{
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    public static async Task RunAsync()
    {
        // 1. Unconfigured state
        var visionOpts = Options.Create(new AzureVisionOptions());
        var langOpts = Options.Create(new AzureLanguageOptions());
        var cache = new MemoryCache(new MemoryCacheOptions());
        var factory = new TestHttpClientFactory();
        var service = new AzureVisionService(visionOpts, langOpts, factory, cache, NullLogger<AzureVisionService>.Instance);

        Require(!service.Enabled, "Service should not be enabled when options are empty.");
        var disabledResult = await service.CaptionImageAsync("https://example.com/photo.jpg", CancellationToken.None);
        Require(!disabledResult.Available, "Unconfigured service should return unavailable.");
        Require(disabledResult.Caption == "", "Caption should be empty when unconfigured.");

        // 2. URL validation
        var emptyUrl = await service.CaptionImageAsync("", CancellationToken.None);
        Require(!emptyUrl.Available, "Empty URL should return unavailable.");

        var localUrl = await service.CaptionImageAsync("https://localhost/photo.jpg", CancellationToken.None);
        Require(!localUrl.Available, "Localhost URL should be rejected.");

        var httpUrl = await service.CaptionImageAsync("http://example.com/photo.jpg", CancellationToken.None);
        Require(!httpUrl.Available, "Insecure HTTP URL should be rejected.");

        // 3. Azure Image Analysis JSON Parsing
        const string visionJson = """
        {
            "captionResult": {
                "text": "a group of people gathered at a conference hall",
                "confidence": 0.892
            },
            "denseCaptionsResult": {
                "values": [
                    {
                        "text": "a person speaking at a podium",
                        "confidence": 0.91,
                        "boundingBox": { "x": 50, "y": 60, "w": 100, "h": 200 }
                    },
                    {
                        "text": "an audience listening",
                        "confidence": 0.85,
                        "boundingBox": { "x": 10, "y": 200, "w": 500, "h": 300 }
                    }
                ]
            },
            "metadata": {
                "width": 1280,
                "height": 720
            },
            "modelVersion": "2023-10-01"
        }
        """;

        using (var doc = JsonDocument.Parse(visionJson))
        {
            var parsed = AzureVisionService.Parse(doc.RootElement);
            Require(parsed.Available, "Valid JSON should parse successfully.");
            Require(parsed.Caption == "A group of people gathered at a conference hall", "Caption should be capitalized.");
            Require(parsed.Confidence == 0.892, "Confidence score should match.");
            Require(parsed.DenseCaptions.Length == 2, "Dense captions should be extracted.");
            Require(parsed.Width == 1280 && parsed.Height == 720, "Metadata dimensions should match.");
        }

        // 4. Controller validation
        var controller = new ArticleImageCaptionController(service);
        var badReq = await controller.Caption(new(""), CancellationToken.None);
        Require(badReq is BadRequestObjectResult, "Empty URL to controller should return BadRequest.");

        var badHost = await controller.Caption(new("https://localhost/bad.jpg"), CancellationToken.None);
        Require(badHost is BadRequestObjectResult, "Localhost to controller should return BadRequest.");
    }

    private sealed class TestHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
