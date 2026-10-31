using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record ArticleImageCaptionResult(
    bool Available,
    string Reason,
    string Caption,
    double Confidence,
    string[] DenseCaptions,
    int Width,
    int Height
);

public sealed class AzureVisionService(
    IOptions<AzureVisionOptions> visionOptions,
    IOptions<AzureLanguageOptions> languageOptions,
    IHttpClientFactory clients,
    IMemoryCache cache,
    ILogger<AzureVisionService> logger)
{
    public const string HttpClientName = "AzureVision";

    public bool Enabled => visionOptions.Value.Enabled || languageOptions.Value.Enabled;

    private (Uri endpoint, string key) ResolveCredentials()
    {
        if (visionOptions.Value.Enabled)
        {
            return (visionOptions.Value.Validate(), visionOptions.Value.Key);
        }
        if (languageOptions.Value.Enabled)
        {
            return (languageOptions.Value.Validate(), languageOptions.Value.Key);
        }
        throw new InvalidOperationException("Azure Vision is not configured.");
    }

    public async Task<ArticleImageCaptionResult> CaptionImageAsync(string imageUrl, CancellationToken token)
    {
        var cleanUrl = (imageUrl ?? "").Trim();
        if (cleanUrl.Length == 0)
            return new(false, "No image URL provided.", "", 0.0, [], 0, 0);

        if (!Uri.TryCreate(cleanUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || uri.IsLoopback || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return new(false, "Invalid image URL. Must be a public HTTPS link.", "", 0.0, [], 0, 0);
        }

        if (!Enabled)
        {
            return new(false, "Azure AI Vision has not been configured yet.", "", 0.0, [], 0, 0);
        }

        var cacheKey = "azure-vision-caption:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(cleanUrl)));
        if (cache.TryGetValue(cacheKey, out ArticleImageCaptionResult? ready) && ready is not null)
            return ready;

        try
        {
            var (endpoint, key) = ResolveCredentials();
            var client = clients.CreateClient(HttpClientName);
            var apiUrl = new Uri(endpoint, "computervision/imageanalysis:analyze?api-version=2023-10-01&features=caption,denseCaptions");

            using var request = new HttpRequestMessage(HttpMethod.Post, apiUrl);
            request.Headers.Add("Ocp-Apim-Subscription-Key", key);
            request.Headers.Accept.ParseAdd("application/json");
            request.Content = JsonContent.Create(new { url = cleanUrl });

            using var response = await client.SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Azure AI Vision returned status {StatusCode}.", (int)response.StatusCode);
                return new(false, $"Azure AI Vision returned status {(int)response.StatusCode}.", "", 0.0, [], 0, 0);
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var result = Parse(json.RootElement);

            if (result.Available && !string.IsNullOrWhiteSpace(result.Caption))
            {
                // Cache successful image captions for 30 days
                cache.Set(cacheKey, result, TimeSpan.FromDays(30));
            }

            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Azure AI Vision request failed.");
            return new(false, "Azure image analysis is temporarily unavailable.", "", 0.0, [], 0, 0);
        }
    }

    public static ArticleImageCaptionResult Parse(JsonElement root)
    {
        try
        {
            var caption = "";
            var confidence = 0.0;

            if (root.TryGetProperty("captionResult", out var cr))
            {
                if (cr.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                {
                    caption = t.GetString() ?? "";
                    if (caption.Length > 0)
                    {
                        // Capitalize first letter
                        caption = char.ToUpperInvariant(caption[0]) + caption[1..];
                    }
                }
                if (cr.TryGetProperty("confidence", out var c) && c.TryGetDouble(out var conf))
                {
                    confidence = Math.Round(conf, 3);
                }
            }

            var denseList = new List<string>();
            if (root.TryGetProperty("denseCaptionsResult", out var dcr)
                && dcr.TryGetProperty("values", out var vals) && vals.ValueKind == JsonValueKind.Array)
            {
                foreach (var val in vals.EnumerateArray())
                {
                    if (val.TryGetProperty("text", out var vt) && vt.ValueKind == JsonValueKind.String)
                    {
                        var text = vt.GetString();
                        if (!string.IsNullOrWhiteSpace(text) && !denseList.Contains(text, StringComparer.OrdinalIgnoreCase))
                        {
                            denseList.Add(text);
                        }
                    }
                }
            }

            var width = 0;
            var height = 0;
            if (root.TryGetProperty("metadata", out var meta))
            {
                if (meta.TryGetProperty("width", out var w)) width = w.GetInt32();
                if (meta.TryGetProperty("height", out var h)) height = h.GetInt32();
            }

            return new(
                !string.IsNullOrWhiteSpace(caption),
                string.IsNullOrWhiteSpace(caption) ? "No caption generated." : "",
                caption,
                confidence,
                denseList.ToArray(),
                width,
                height
            );
        }
        catch
        {
            return new(false, "Failed to parse Vision response.", "", 0.0, [], 0, 0);
        }
    }
}
