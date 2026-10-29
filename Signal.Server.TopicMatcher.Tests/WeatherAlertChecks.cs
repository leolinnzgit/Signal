using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class WeatherAlertChecks
{
    public static async Task RunAsync()
    {
        static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }

        var sampleJson = """
        {
          "results": [
            {
              "countryCode": "NZ",
              "alertId": 100201,
              "source": "MetService",
              "category": "Met",
              "level": "Warning",
              "description": {
                "localized": "Heavy Rain Warning",
                "english": "Heavy Rain Warning"
              },
              "alertDetails": [
                {
                  "areaName": "Wellington and Kapiti Coast",
                  "headline": "Heavy Rain Warning - Orange",
                  "description": "Heavy rain may cause streams and rivers to rise rapidly. Surface flooding and slips are also possible.",
                  "effectiveTime": "2026-10-29T10:00:00+13:00",
                  "expires": "2026-10-30T04:00:00+13:00"
                }
              ]
            },
            {
              "alertId": 100202,
              "category": "Wind",
              "level": "Watch",
              "description": { "english": "Strong Wind Watch" }
            }
          ]
        }
        """;

        using var doc = JsonDocument.Parse(sampleJson);
        var parsed = AzureMapsWeatherService.Parse(doc.RootElement);

        Assert(parsed.Length == 2, "Expected 2 parsed weather alerts.");
        Assert(parsed[0].Headline == "Heavy Rain Warning - Orange", "Alert headline was parsed incorrectly.");
        Assert(parsed[0].AreaName == "Wellington and Kapiti Coast", "Area name was parsed incorrectly.");
        Assert(parsed[0].Level == "Warning", "Level was parsed incorrectly.");
        Assert(parsed[0].EffectiveTime.HasValue, "Effective time was not parsed.");
        Assert(parsed[1].Headline == "Strong Wind Watch", "Second alert fallback headline was not parsed.");

        using var emptyDoc = JsonDocument.Parse("{\"results\":[]}");
        var emptyParsed = AzureMapsWeatherService.Parse(emptyDoc.RootElement);
        Assert(emptyParsed.Length == 0, "Empty results must produce empty array.");

        var disabledOptions = Options.Create(new AzureMapsOptions { SubscriptionKey = "" });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var disabledService = new AzureMapsWeatherService(disabledOptions, new DummyClientFactory(), cache);
        var result = await disabledService.GetAlertsAsync(-41.28, 174.77, CancellationToken.None);
        Assert(!result.Available, "Disabled Azure Maps must report unavailable.");
        Assert(result.Alerts.Length == 0, "Disabled service must return no alerts.");

        Console.WriteLine("Azure Maps weather alert checks passed: parsing, area details, timing, fallbacks and disabled state.");
    }

    private sealed class DummyClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
