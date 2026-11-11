using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Controllers;
using Signal.Server.Services;

internal static class MarketAvailabilityChecks
{
    public static async Task RunAsync()
    {
        foreach (var plan in new[] { "Pro or Venture", "Grow or Venture", "Enterprise" })
        {
            var handler = new RestrictedHandler(plan);
            using var client = new HttpClient(handler) { BaseAddress = new("https://api.twelvedata.com/") };
            using var cache = new MemoryCache(new MemoryCacheOptions());
            var service = new MarketDataService(client, cache, Options.Create(new MarketDataOptions { ApiKey = "test" }));
            var controller = new MarketController(service, null!, null!, NullLogger<MarketController>.Instance) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
            };
            for (var repeat = 0; repeat < 5; repeat++)
            {
                var automatic = await controller.Get("NVIDIA", null, CancellationToken.None) as OkObjectResult;
                Check(automatic is not null, "An optional plan-restricted topic quote must not return a server error.");
                var payload = JsonSerializer.SerializeToElement(automatic!.Value);
                Check(!payload.GetProperty("matched").GetBoolean() && payload.GetProperty("status").GetString() == "plan-required",
                    "Unavailable automatic quotes must remain explicitly unmatched, without fabricated prices.");
            }
            Check(handler.QuoteRequests == 1, "Revisiting a restricted symbol must reuse the server cooldown.");
            // Typed services are constructed per request; the cooldown must be shared through IMemoryCache.
            var anotherRequest = new MarketDataService(client, cache, Options.Create(new MarketDataOptions { ApiKey = "test" }));
            try { await anotherRequest.GetForTopicAsync("NVIDIA", null, CancellationToken.None); throw new Exception("Restriction was lost."); }
            catch (MarketDataPlanRequiredException) { }
            Check(handler.QuoteRequests == 1, "Provider restrictions must survive service recreation.");
            var explicitTicker = await controller.Get("NVIDIA", "NVDA", CancellationToken.None) as ObjectResult;
            Check(explicitTicker?.StatusCode == 402, "Explicit ticker validation must retain the provider-plan explanation.");
            Check(await controller.Get("NVIDIA", "NVDA", CancellationToken.None, optional: true) is OkObjectResult,
                "Optional playback enrichment must handle a restricted saved ticker without an HTTP error.");
            Check(handler.QuoteRequests == 1, "Explicit ticker validation can reuse the known restriction too.");
        }
        Console.WriteLine("Market availability passed current/legacy plan restrictions, optional enrichment responses, explicit validation and cross-request cooldown checks.");
    }

    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    private sealed class RestrictedHandler(string plan) : HttpMessageHandler
    {
        public int QuoteRequests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            QuoteRequests++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
                Content = new StringContent(JsonSerializer.Serialize(new { status = "error", code = 403, message = $"This symbol is available starting with the {plan} plan. Consider upgrading now." }), Encoding.UTF8, "application/json")
            });
        }
    }
}
