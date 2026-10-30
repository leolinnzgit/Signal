using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record ContentModerationResult(bool Allowed, string Reason, string FlaggedCategory = "");

public sealed class AzureContentSafetyService(
    IOptions<AzureContentSafetyOptions> options,
    IHttpClientFactory clients,
    ILogger<AzureContentSafetyService> logger)
{
    public const string HttpClientName = "AzureContentSafety";

    public bool Enabled => options.Value.Enabled;

    public async Task<ContentModerationResult> AnalyzeTextAsync(string text, CancellationToken token)
    {
        if (!Enabled || string.IsNullOrWhiteSpace(text))
            return new(true, "");

        try
        {
            var client = clients.CreateClient(HttpClientName);
            var endpoint = options.Value.Endpoint.Trim().TrimEnd('/');
            var url = $"{endpoint}/contentsafety/text:analyze?api-version=2023-10-01-preview";

            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            request.Headers.Add("Ocp-Apim-Subscription-Key", options.Value.SubscriptionKey.Trim());
            request.Content = JsonContent.Create(new
            {
                text = text.Length > 1000 ? text[..1000] : text,
                categories = new[] { "Hate", "Sexual", "SelfHarm", "Violence" },
                outputType = "FourSeverityLevels"
            });

            using var response = await client.SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Azure Content Safety returned status {StatusCode}.", (int)response.StatusCode);
                return new(true, "");
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var (allowed, category) = Evaluate(json.RootElement, options.Value.RejectionThreshold);
            return allowed
                ? new(true, "")
                : new(false, "Your comment could not be posted because it was flagged by content moderation.", category);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Azure Content Safety request failed.");
            return new(true, "");
        }
    }

    public static (bool Allowed, string FlaggedCategory) Evaluate(JsonElement root, int threshold)
    {
        if (!root.TryGetProperty("categoriesAnalysis", out var categories) || categories.ValueKind != JsonValueKind.Array)
            return (true, "");

        foreach (var item in categories.EnumerateArray())
        {
            var category = item.TryGetProperty("category", out var cProp) ? cProp.GetString() ?? "" : "";
            var severity = item.TryGetProperty("severity", out var sProp) && sProp.TryGetInt32(out var s) ? s : 0;
            if (severity >= threshold)
            {
                return (false, category);
            }
        }
        return (true, "");
    }
}
