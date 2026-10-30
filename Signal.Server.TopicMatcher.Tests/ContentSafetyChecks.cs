using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Signal.Server.Services;

internal static class ContentSafetyChecks
{
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    public static async Task RunAsync()
    {
        // 1. Options validation
        var unconfigured = new AzureContentSafetyOptions();
        Check(!unconfigured.Enabled, "AzureContentSafetyOptions should be disabled when unconfigured.");

        var invalidKey = new AzureContentSafetyOptions
        {
            Endpoint = "https://example.cognitiveservices.azure.com/",
            SubscriptionKey = "short"
        };
        Check(!invalidKey.Enabled, "AzureContentSafetyOptions should reject short keys.");

        var validOptions = new AzureContentSafetyOptions
        {
            Endpoint = "https://signal-safety.cognitiveservices.azure.com/",
            SubscriptionKey = "12345678901234567890123456789012",
            RejectionThreshold = 2
        };
        Check(validOptions.Enabled, "AzureContentSafetyOptions should be enabled with valid endpoint and key.");

        // 2. Evaluation parsing - Safe response
        const string safeJson = """
        {
            "categoriesAnalysis": [
                { "category": "Hate", "severity": 0 },
                { "category": "SelfHarm", "severity": 0 },
                { "category": "Sexual", "severity": 0 },
                { "category": "Violence", "severity": 0 }
            ]
        }
        """;
        using (var doc = JsonDocument.Parse(safeJson))
        {
            var (allowed, flagged) = AzureContentSafetyService.Evaluate(doc.RootElement, 2);
            Check(allowed, "Safe content with 0 severity should be allowed.");
            Check(string.IsNullOrEmpty(flagged), "Flagged category should be empty for safe content.");
        }

        // 3. Evaluation parsing - Flagged Hate content
        const string flaggedJson = """
        {
            "categoriesAnalysis": [
                { "category": "Hate", "severity": 4 },
                { "category": "SelfHarm", "severity": 0 },
                { "category": "Sexual", "severity": 0 },
                { "category": "Violence", "severity": 2 }
            ]
        }
        """;
        using (var doc = JsonDocument.Parse(flaggedJson))
        {
            var (allowed, flagged) = AzureContentSafetyService.Evaluate(doc.RootElement, 2);
            Check(!allowed, "Content with severity >= threshold should be rejected.");
            Check(flagged == "Hate", "Flagged category should identify the offending category.");
        }

        // 4. Threshold sensitivity
        using (var doc = JsonDocument.Parse(flaggedJson))
        {
            // If threshold is 6 (high only), severity 4 is allowed
            var (allowed, _) = AzureContentSafetyService.Evaluate(doc.RootElement, 6);
            Check(allowed, "Content below threshold should be allowed when threshold is higher.");
        }

        // 5. Disabled service passes through
        var disabledService = new AzureContentSafetyService(
            Options.Create(new AzureContentSafetyOptions()),
            new DummyHttpClientFactory(),
            NullLogger<AzureContentSafetyService>.Instance
        );
        var disabledResult = await disabledService.AnalyzeTextAsync("Any text here", CancellationToken.None);
        Check(disabledResult.Allowed, "Disabled Content Safety service must allow all comments.");

        Console.WriteLine("Azure Content Safety moderation checks passed: options, safe/flagged evaluation, thresholds and disabled state.");
    }

    private sealed class DummyHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
