using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed record SmartCropRegion(
    double AspectRatio,
    int X,
    int Y,
    int Width,
    int Height
);

public sealed record ArticleImageCaptionResult(
    bool Available,
    string Reason,
    string Caption,
    double Confidence,
    string[] DenseCaptions,
    int Width,
    int Height,
    double FocalX = 0.5,
    double FocalY = 0.5,
    SmartCropRegion[]? SmartCrops = null
)
{
    public SmartCropRegion[] SmartCrops { get; init; } = SmartCrops ?? [];

    public static ArticleImageCaptionResult Unavailable(string reason) =>
        new(false, reason, "", 0.0, [], 0, 0, 0.5, 0.5, []);
}

public sealed record ArticleImageOcrResult(
    bool Available,
    string Reason,
    string Text,
    string[] Lines,
    int LineCount
)
{
    public static ArticleImageOcrResult Unavailable(string reason) =>
        new(false, reason, "", [], 0);
}

public sealed class AzureVisionService(
    IOptions<AzureVisionOptions> visionOptions,
    IOptions<AzureLanguageOptions> languageOptions,
    IHttpClientFactory clients,
    IMemoryCache cache,
    ILogger<AzureVisionService> logger)
{
    public const string HttpClientName = "AzureVision";

    private const string FullAnalyzePath =
        "computervision/imageanalysis:analyze?api-version=2023-10-01&features=caption,denseCaptions,smartCrops&smartcrops-aspect-ratios=1.0,1.6";

    private const string SmartCropsOnlyPath =
        "computervision/imageanalysis:analyze?api-version=2023-10-01&features=smartCrops&smartcrops-aspect-ratios=1.0,1.6";

    private const string ReadOcrPath =
        "computervision/imageanalysis:analyze?api-version=2023-10-01&features=read";

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
            return ArticleImageCaptionResult.Unavailable("No image URL provided.");

        if (!Uri.TryCreate(cleanUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || uri.IsLoopback || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return ArticleImageCaptionResult.Unavailable("Invalid image URL. Must be a public HTTPS link.");
        }

        if (!Enabled)
        {
            return ArticleImageCaptionResult.Unavailable("Azure AI Vision has not been configured yet.");
        }

        var cacheKey = "azure-vision-analysis-v2:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(cleanUrl)));
        if (cache.TryGetValue(cacheKey, out ArticleImageCaptionResult? ready) && ready is not null)
            return ready;

        try
        {
            var (endpoint, key) = ResolveCredentials();
            var client = clients.CreateClient(HttpClientName);

            using var response = await SendAnalyzeRequestAsync(client, new Uri(endpoint, FullAnalyzePath), key, cleanUrl, token);
            HttpResponseMessage activeResponse = response;
            HttpResponseMessage? fallbackResponse = null;

            try
            {
                if (response.StatusCode == HttpStatusCode.BadRequest)
                {
                    // Captioning is restricted in select Azure regions whereas smartCrops is available in all Vision 4.0 regions.
                    fallbackResponse = await SendAnalyzeRequestAsync(client, new Uri(endpoint, SmartCropsOnlyPath), key, cleanUrl, token);
                    if (fallbackResponse.IsSuccessStatusCode)
                    {
                        activeResponse = fallbackResponse;
                    }
                }

                if (!activeResponse.IsSuccessStatusCode)
                {
                    logger.LogWarning("Azure AI Vision returned status {StatusCode}.", (int)activeResponse.StatusCode);
                    return ArticleImageCaptionResult.Unavailable($"Azure AI Vision returned status {(int)activeResponse.StatusCode}.");
                }

                using var json = JsonDocument.Parse(await activeResponse.Content.ReadAsStringAsync(token));
                var result = Parse(json.RootElement);

                if (result.Available)
                {
                    // Cache successful image captions and smart focal crops for 30 days
                    cache.Set(cacheKey, result, TimeSpan.FromDays(30));
                }

                return result;
            }
            finally
            {
                fallbackResponse?.Dispose();
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Azure AI Vision request failed.");
            return ArticleImageCaptionResult.Unavailable("Azure image analysis is temporarily unavailable.");
        }
    }

    private static Task<HttpResponseMessage> SendAnalyzeRequestAsync(
        HttpClient client,
        Uri apiUrl,
        string key,
        string imageUrl,
        CancellationToken token)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, apiUrl);
        request.Headers.Add("Ocp-Apim-Subscription-Key", key);
        request.Headers.Accept.ParseAdd("application/json");
        request.Content = JsonContent.Create(new { url = imageUrl });
        return client.SendAsync(request, token);
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
                        caption = char.ToUpperInvariant(caption[0]) + caption[1..];
                    }
                }
                if (cr.TryGetProperty("confidence", out var c) && c.TryGetDouble(out var conf))
                {
                    confidence = Math.Round(conf, 3);
                }
            }

            var width = 0;
            var height = 0;
            if (root.TryGetProperty("metadata", out var meta))
            {
                if (meta.TryGetProperty("width", out var w) && w.TryGetInt32(out var parsedW)) width = parsedW;
                if (meta.TryGetProperty("height", out var h) && h.TryGetInt32(out var parsedH)) height = parsedH;
            }

            var denseList = new List<string>();
            var denseBoxes = new List<(int X, int Y, int W, int H, double Confidence)>();
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

                    var itemConfidence = val.TryGetProperty("confidence", out var vc) && vc.TryGetDouble(out var parsedConf)
                        ? parsedConf
                        : 0.0;
                    if (val.TryGetProperty("boundingBox", out var bb) && TryReadBoundingBox(bb, out var bx, out var by, out var bw, out var bh))
                    {
                        denseBoxes.Add((bx, by, bw, bh, itemConfidence));
                    }
                }
            }

            var smartCrops = new List<SmartCropRegion>();
            if (root.TryGetProperty("smartCropsResult", out var scr)
                && scr.TryGetProperty("values", out var cropVals) && cropVals.ValueKind == JsonValueKind.Array)
            {
                foreach (var cropVal in cropVals.EnumerateArray())
                {
                    var aspectRatio = cropVal.TryGetProperty("aspectRatio", out var ar) && ar.TryGetDouble(out var parsedAr)
                        ? Math.Round(parsedAr, 3)
                        : 0.0;
                    if (cropVal.TryGetProperty("boundingBox", out var bb) && TryReadBoundingBox(bb, out var bx, out var by, out var bw, out var bh))
                    {
                        smartCrops.Add(new SmartCropRegion(aspectRatio, bx, by, bw, bh));
                    }
                }
            }

            var (focalX, focalY) = ComputeFocalPoint(width, height, smartCrops, denseBoxes);
            var available = !string.IsNullOrWhiteSpace(caption) || smartCrops.Count > 0;
            var reason = available ? "" : "No caption or smart crop generated.";

            return new ArticleImageCaptionResult(
                available,
                reason,
                caption,
                confidence,
                denseList.ToArray(),
                width,
                height,
                focalX,
                focalY,
                smartCrops.ToArray()
            );
        }
        catch
        {
            return ArticleImageCaptionResult.Unavailable("Failed to parse Vision response.");
        }
    }

    private static bool TryReadBoundingBox(JsonElement box, out int x, out int y, out int w, out int h)
    {
        x = y = w = h = 0;
        if (box.ValueKind != JsonValueKind.Object) return false;
        if (!box.TryGetProperty("x", out var px) || !px.TryGetInt32(out x)) return false;
        if (!box.TryGetProperty("y", out var py) || !py.TryGetInt32(out y)) return false;
        if (!box.TryGetProperty("w", out var pw) || !pw.TryGetInt32(out w)) return false;
        if (!box.TryGetProperty("h", out var ph) || !ph.TryGetInt32(out h)) return false;
        return w > 0 && h > 0;
    }

    public static (double FocalX, double FocalY) ComputeFocalPoint(
        int width,
        int height,
        IReadOnlyList<SmartCropRegion> smartCrops,
        IReadOnlyList<(int X, int Y, int W, int H, double Confidence)> denseBoxes)
    {
        if (width <= 0 || height <= 0)
            return (0.5, 0.5);

        // Identify the highest-confidence sub-region subject box (excluding full-frame boxes)
        (int X, int Y, int W, int H, double Confidence)? primarySubject = null;
        foreach (var box in denseBoxes)
        {
            var isFullFrame = box.W >= width * 0.95 && box.H >= height * 0.95;
            if (!isFullFrame && (primarySubject is null || box.Confidence > primarySubject.Value.Confidence))
            {
                primarySubject = box;
            }
        }

        double focalX = 0.5;
        var bestSlackX = 0;
        SmartCropRegion? bestHorizontalCrop = null;
        foreach (var crop in smartCrops)
        {
            var slackX = width - crop.Width;
            if (crop.Width > 0 && crop.Width <= width && slackX >= width * 0.05 && slackX > bestSlackX)
            {
                bestSlackX = slackX;
                bestHorizontalCrop = crop;
            }
        }

        if (bestHorizontalCrop is not null && bestSlackX > 0)
        {
            focalX = Math.Clamp(bestHorizontalCrop.X / (double)bestSlackX, 0.0, 1.0);
        }
        else if (primarySubject is not null)
        {
            focalX = Math.Clamp((primarySubject.Value.X + primarySubject.Value.W / 2.0) / width, 0.0, 1.0);
        }

        double focalY = 0.5;
        var bestSlackY = 0;
        SmartCropRegion? bestVerticalCrop = null;
        foreach (var crop in smartCrops)
        {
            var slackY = height - crop.Height;
            if (crop.Height > 0 && crop.Height <= height && slackY >= height * 0.05 && slackY > bestSlackY)
            {
                bestSlackY = slackY;
                bestVerticalCrop = crop;
            }
        }

        if (bestVerticalCrop is not null && bestSlackY > 0)
        {
            focalY = Math.Clamp(bestVerticalCrop.Y / (double)bestSlackY, 0.0, 1.0);
        }
        else if (primarySubject is not null)
        {
            focalY = Math.Clamp((primarySubject.Value.Y + primarySubject.Value.H / 2.0) / height, 0.0, 1.0);
        }

        return (Math.Round(focalX, 3), Math.Round(focalY, 3));
    }

    public async Task<ArticleImageOcrResult> ExtractTextAsync(string imageUrl, CancellationToken token)
    {
        var cleanUrl = (imageUrl ?? "").Trim();
        if (cleanUrl.Length == 0)
            return ArticleImageOcrResult.Unavailable("No image URL provided.");

        if (!Uri.TryCreate(cleanUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || uri.IsLoopback || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return ArticleImageOcrResult.Unavailable("Invalid image URL. Must be a public HTTPS link.");
        }

        if (!Enabled)
        {
            return ArticleImageOcrResult.Unavailable("Azure AI Vision has not been configured yet.");
        }

        var cacheKey = "azure-vision-ocr-v1:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(cleanUrl)));
        if (cache.TryGetValue(cacheKey, out ArticleImageOcrResult? ready) && ready is not null)
            return ready;

        try
        {
            var (endpoint, key) = ResolveCredentials();
            var client = clients.CreateClient(HttpClientName);

            using var response = await SendAnalyzeRequestAsync(client, new Uri(endpoint, ReadOcrPath), key, cleanUrl, token);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Azure AI Vision OCR returned status {StatusCode}.", (int)response.StatusCode);
                return ArticleImageOcrResult.Unavailable($"Azure AI Vision returned status {(int)response.StatusCode}.");
            }

            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var result = ParseOcr(json.RootElement);

            // Cache positive text extraction for 30 days and empty-photo results for 24 hours to conserve quota
            cache.Set(cacheKey, result, result.Available ? TimeSpan.FromDays(30) : TimeSpan.FromHours(24));
            return result;
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Azure AI Vision OCR request failed.");
            return ArticleImageOcrResult.Unavailable("Azure image text extraction is temporarily unavailable.");
        }
    }

    public static ArticleImageOcrResult ParseOcr(JsonElement root)
    {
        try
        {
            var allLines = new List<string>();
            var blockTexts = new List<string>();

            if (root.TryGetProperty("readResult", out var readResult)
                && readResult.TryGetProperty("blocks", out var blocks)
                && blocks.ValueKind == JsonValueKind.Array)
            {
                foreach (var block in blocks.EnumerateArray())
                {
                    if (!block.TryGetProperty("lines", out var lines) || lines.ValueKind != JsonValueKind.Array)
                        continue;

                    var blockLines = new List<string>();
                    foreach (var line in lines.EnumerateArray())
                    {
                        if (line.TryGetProperty("text", out var lt) && lt.ValueKind == JsonValueKind.String)
                        {
                            var text = (lt.GetString() ?? "").Trim();
                            if (text.Length > 0)
                            {
                                blockLines.Add(text);
                                allLines.Add(text);
                            }
                        }
                    }

                    if (blockLines.Count > 0)
                    {
                        blockTexts.Add(string.Join("\n", blockLines));
                    }
                }
            }

            if (allLines.Count == 0)
            {
                return ArticleImageOcrResult.Unavailable("No readable text detected in this image.");
            }

            var combinedText = string.Join("\n\n", blockTexts);
            return new ArticleImageOcrResult(
                true,
                "",
                combinedText,
                allLines.ToArray(),
                allLines.Count
            );
        }
        catch
        {
            return ArticleImageOcrResult.Unavailable("Failed to parse Vision OCR response.");
        }
    }
}
