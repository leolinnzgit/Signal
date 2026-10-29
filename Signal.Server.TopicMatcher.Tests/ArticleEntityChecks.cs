using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class ArticleEntityChecks
{
    public static async Task RunAsync()
    {
        static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }

        var sampleNerJson = """
        {
          "kind": "EntityRecognitionResults",
          "results": {
            "documents": [
              {
                "id": "1",
                "entities": [
                  {
                    "text": "Microsoft",
                    "category": "Organization",
                    "confidenceScore": 0.98
                  },
                  {
                    "text": "microsoft",
                    "category": "Organization",
                    "confidenceScore": 0.95
                  },
                  {
                    "text": "Satya Nadella",
                    "category": "Person",
                    "confidenceScore": 0.99
                  },
                  {
                    "text": "Seattle",
                    "category": "Location",
                    "subcategory": "GPE",
                    "confidenceScore": 0.88
                  },
                  {
                    "text": "Uncertain Entity",
                    "category": "Person",
                    "confidenceScore": 0.40
                  },
                  {
                    "text": "Unknown Category Entity",
                    "category": "Quantity",
                    "confidenceScore": 0.99
                  }
                ]
              }
            ]
          }
        }
        """;

        using var doc = JsonDocument.Parse(sampleNerJson);
        var parsed = AzureLanguageEntityService.Parse(doc.RootElement);

        Assert(parsed.Length == 3, $"Expected 3 filtered entities, got {parsed.Length}.");
        Assert(parsed.Any(e => e.Text == "Satya Nadella" && e.Category == "Person"), "Expected Satya Nadella as Person.");
        Assert(parsed.Any(e => e.Text == "Microsoft" && e.Category == "Organization"), "Expected Microsoft as Organization.");
        Assert(parsed.Any(e => e.Text == "Seattle" && e.Category == "Location"), "Expected Seattle as Location.");
        Assert(!parsed.Any(e => e.Text == "Uncertain Entity"), "Low confidence entity must be filtered out.");
        Assert(!parsed.Any(e => e.Category == "Quantity"), "Unsupported categories must be excluded.");

        var disabledOptions = Options.Create(new AzureLanguageOptions());
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var disabledService = new AzureLanguageEntityService(disabledOptions, new DummyClientFactory(), cache);
        var result = await disabledService.ExtractEntitiesAsync("Sample article text about Microsoft and tech.", CancellationToken.None);
        Assert(!result.Available, "Disabled service must report unavailable.");
        Assert(result.Entities.Length == 0, "Disabled service must return no entities.");

        Console.WriteLine("Azure Language entity recognition checks passed: parsing, confidence filtering, deduplication and disabled state.");
    }

    private sealed class DummyClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
