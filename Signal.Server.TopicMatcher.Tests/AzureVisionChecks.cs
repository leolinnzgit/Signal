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
        Require(disabledResult.FocalX == 0.5 && disabledResult.FocalY == 0.5, "Default focal point should be centered (0.5, 0.5).");
        Require(disabledResult.SmartCrops.Length == 0, "SmartCrops should be empty when unconfigured.");

        // 2. URL validation
        var emptyUrl = await service.CaptionImageAsync("", CancellationToken.None);
        Require(!emptyUrl.Available, "Empty URL should return unavailable.");

        var localUrl = await service.CaptionImageAsync("https://localhost/photo.jpg", CancellationToken.None);
        Require(!localUrl.Available, "Localhost URL should be rejected.");

        var httpUrl = await service.CaptionImageAsync("http://example.com/photo.jpg", CancellationToken.None);
        Require(!httpUrl.Available, "Insecure HTTP URL should be rejected.");

        // 3. Azure Image Analysis JSON Parsing (caption + denseCaptions + smartCrops on landscape photo)
        const string visionJson = """
        {
            "captionResult": {
                "text": "a group of people gathered at a conference hall",
                "confidence": 0.892
            },
            "denseCaptionsResult": {
                "values": [
                    {
                        "text": "a group of people gathered at a conference hall",
                        "confidence": 0.95,
                        "boundingBox": { "x": 0, "y": 0, "w": 1600, "h": 900 }
                    },
                    {
                        "text": "a person speaking at a podium",
                        "confidence": 0.91,
                        "boundingBox": { "x": 1000, "y": 90, "w": 300, "h": 360 }
                    },
                    {
                        "text": "an audience listening",
                        "confidence": 0.85,
                        "boundingBox": { "x": 100, "y": 400, "w": 800, "h": 400 }
                    }
                ]
            },
            "smartCropsResult": {
                "values": [
                    {
                        "aspectRatio": 1.0,
                        "boundingBox": { "x": 560, "y": 0, "w": 900, "h": 900 }
                    },
                    {
                        "aspectRatio": 1.6,
                        "boundingBox": { "x": 160, "y": 0, "w": 1440, "h": 900 }
                    }
                ]
            },
            "metadata": {
                "width": 1600,
                "height": 900
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
            Require(parsed.DenseCaptions.Length == 3, "Dense captions should be extracted.");
            Require(parsed.Width == 1600 && parsed.Height == 900, "Metadata dimensions should match.");
            Require(parsed.SmartCrops.Length == 2, "Both 1.0 and 1.6 smart crops should be parsed.");
            // Horizontal slack on 1.0 crop is 1600 - 900 = 700, x = 560 => 560 / 700 = 0.8
            Require(parsed.FocalX == 0.8, $"FocalX should align with subject on right (0.8), got {parsed.FocalX}.");
            // Vertical slack is 0 on both crops, so fallback uses primary sub-region box (y=90, h=360 => center 270 / 900 = 0.3)
            Require(parsed.FocalY == 0.3, $"FocalY should focus on primary speaker sub-region (0.3), got {parsed.FocalY}.");
        }

        // 4. Portrait smartCrops-only JSON (e.g. region where captionResult is omitted, subject face near top)
        const string portraitSmartCropOnlyJson = """
        {
            "smartCropsResult": {
                "values": [
                    {
                        "aspectRatio": 1.0,
                        "boundingBox": { "x": 0, "y": 40, "w": 800, "h": 800 }
                    },
                    {
                        "aspectRatio": 1.6,
                        "boundingBox": { "x": 0, "y": 70, "w": 800, "h": 500 }
                    }
                ]
            },
            "metadata": {
                "width": 800,
                "height": 1200
            }
        }
        """;

        using (var portraitDoc = JsonDocument.Parse(portraitSmartCropOnlyJson))
        {
            var portrait = AzureVisionService.Parse(portraitDoc.RootElement);
            Require(portrait.Available, "SmartCrops-only response should be marked available for focal cropping.");
            Require(portrait.Caption == "", "Caption should be empty when captionResult is absent.");
            Require(portrait.FocalX == 0.5, $"Portrait horizontal focal point should stay centered (0.5), got {portrait.FocalX}.");
            // Largest vertical slack is 1200 - 500 = 700, y = 70 => 70 / 700 = 0.1
            Require(portrait.FocalY == 0.1, $"Portrait vertical focal point should shift to upper face region (0.1), got {portrait.FocalY}.");
        }

        // 5. Controller validation
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
