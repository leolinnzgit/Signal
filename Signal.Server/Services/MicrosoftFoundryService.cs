using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class MicrosoftFoundryOptions
{
    public const string PrimarySectionName = "OpenAI";
    public const string SecondarySectionName = "MicrosoftFoundry";
    public const string DefaultApiVersion = "2024-10-21";

    private static readonly Regex DeploymentNameRegex = new(
        @"^[A-Za-z0-9._-]+$",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    private static readonly Regex ApiVersionRegex = new(
        @"^[A-Za-z0-9.-]+$",
        RegexOptions.Compiled,
        TimeSpan.FromSeconds(1));

    public string Endpoint { get; set; } = "";
    public string Key { get; set; } = "";
    public string Deployment { get; set; } = "";
    public string ApiVersion { get; set; } = DefaultApiVersion;

    public bool Enabled =>
        !string.IsNullOrWhiteSpace(Endpoint)
        && !string.IsNullOrWhiteSpace(Key)
        && !string.IsNullOrWhiteSpace(Deployment);

    internal (Uri BaseUri, string Key, string Deployment, string ApiVersion) Validate()
    {
        var rawEndpoint = (Endpoint ?? "").Trim().TrimEnd('/') + "/";
        if (!Uri.TryCreate(rawEndpoint, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !uri.IsDefaultPort
            || uri.UserInfo.Length != 0
            || uri.Query.Length != 0
            || uri.Fragment.Length != 0
            || uri.AbsolutePath != "/"
            || !(uri.Host.EndsWith(".services.ai.azure.com", StringComparison.OrdinalIgnoreCase)
                || uri.Host.EndsWith(".openai.azure.com", StringComparison.OrdinalIgnoreCase)
                || uri.Host.EndsWith(".cognitiveservices.azure.com", StringComparison.OrdinalIgnoreCase)))
        {
            throw new FoundryServiceException(
                "Microsoft Foundry needs a valid HTTPS Azure AI Foundry or Azure OpenAI endpoint.",
                StatusCodes.Status503ServiceUnavailable);
        }

        var trimmedKey = (Key ?? "").Trim();
        if (trimmedKey.Length is < 20 or > 256 || trimmedKey.Any(char.IsWhiteSpace) || trimmedKey.Any(char.IsControl))
        {
            throw new FoundryServiceException(
                "Microsoft Foundry API credentials are invalid or incomplete.",
                StatusCodes.Status503ServiceUnavailable);
        }

        var trimmedDeployment = (Deployment ?? "").Trim();
        if (trimmedDeployment.Length is < 1 or > 128 || !DeploymentNameRegex.IsMatch(trimmedDeployment))
        {
            throw new FoundryServiceException(
                "Microsoft Foundry deployment name is missing or invalid.",
                StatusCodes.Status503ServiceUnavailable);
        }

        var trimmedApiVersion = string.IsNullOrWhiteSpace(ApiVersion) ? DefaultApiVersion : ApiVersion.Trim();
        if (trimmedApiVersion.Length > 40 || !ApiVersionRegex.IsMatch(trimmedApiVersion))
        {
            throw new FoundryServiceException(
                "Microsoft Foundry API version setting is invalid.",
                StatusCodes.Status503ServiceUnavailable);
        }

        return (uri, trimmedKey, trimmedDeployment, trimmedApiVersion);
    }

    public static void BindConfiguration(MicrosoftFoundryOptions target, IConfiguration configuration)
    {
        var primary = configuration.GetSection(PrimarySectionName);
        var fallback = configuration.GetSection(SecondarySectionName);
        primary.Bind(target);
        if (string.IsNullOrWhiteSpace(target.Endpoint)) target.Endpoint = fallback["Endpoint"] ?? "";
        if (string.IsNullOrWhiteSpace(target.Key)) target.Key = fallback["Key"] ?? "";
        if (string.IsNullOrWhiteSpace(target.Deployment)) target.Deployment = fallback["Deployment"] ?? "";
        if (string.IsNullOrWhiteSpace(primary["ApiVersion"]))
        {
            var fallbackVersion = fallback["ApiVersion"];
            target.ApiVersion = string.IsNullOrWhiteSpace(fallbackVersion) ? DefaultApiVersion : fallbackVersion.Trim();
        }
    }
}

public sealed class FoundryServiceException(string message, int statusCode = StatusCodes.Status502BadGateway)
    : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

public sealed record FoundryMessage(string Role, string Content);

public sealed record FoundryChatOptions(
    double Temperature = 0.25,
    int MaxTokens = 1200,
    bool JsonObjectResponse = true);

public sealed record FoundryChatUsage(int PromptTokens, int CompletionTokens, int TotalTokens);

public sealed record FoundryChatResult(string Content, string Model, FoundryChatUsage? Usage);

public sealed class MicrosoftFoundryService(
    IOptions<MicrosoftFoundryOptions> options,
    IHttpClientFactory clients,
    ILogger<MicrosoftFoundryService> logger)
{
    public const string HttpClientName = "MicrosoftFoundry";
    private const int MaxResponseBytes = 1_048_576;

    public bool Enabled => options.Value.Enabled;
    public string DeploymentName => (options.Value.Deployment ?? "").Trim();

    public async Task<FoundryChatResult> CompleteChatAsync(
        IReadOnlyList<FoundryMessage> messages,
        FoundryChatOptions? chatOptions = null,
        CancellationToken token = default)
    {
        if (!Enabled)
        {
            throw new FoundryServiceException(
                "Microsoft Foundry has not been configured for Signal Bot yet.",
                StatusCodes.Status503ServiceUnavailable);
        }

        if (messages is null || messages.Count == 0)
        {
            throw new ArgumentException("At least one chat message is required.", nameof(messages));
        }

        var (baseUri, apiKey, deployment, apiVersion) = options.Value.Validate();
        var effectiveOptions = chatOptions ?? new FoundryChatOptions();
        var requestUri = new Uri(
            baseUri,
            $"openai/deployments/{Uri.EscapeDataString(deployment)}/chat/completions?api-version={Uri.EscapeDataString(apiVersion)}");

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));

        try
        {
            var client = clients.CreateClient(HttpClientName);
            using var request = new HttpRequestMessage(HttpMethod.Post, requestUri);
            request.Headers.Add("api-key", apiKey);

            var payload = new Dictionary<string, object?>
            {
                ["messages"] = messages.Select(m => new { role = m.Role, content = m.Content }).ToArray(),
                ["temperature"] = Math.Clamp(effectiveOptions.Temperature, 0.0, 1.0),
                ["max_tokens"] = Math.Clamp(effectiveOptions.MaxTokens, 64, 4096),
            };
            if (effectiveOptions.JsonObjectResponse)
            {
                payload["response_format"] = new { type = "json_object" };
            }

            request.Content = JsonContent.Create(payload);

            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning(
                    "Microsoft Foundry returned HTTP {StatusCode} for deployment {Deployment}.",
                    (int)response.StatusCode,
                    deployment);
                throw MapHttpError(response.StatusCode);
            }

            await response.Content.LoadIntoBufferAsync(MaxResponseBytes, deadline.Token);
            var rawJson = await response.Content.ReadAsStringAsync(deadline.Token);
            return ParseCompletionResponse(rawJson, deployment);
        }
        catch (FoundryServiceException)
        {
            throw;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            throw new FoundryServiceException(
                "Microsoft Foundry took too long to respond. Please try again.",
                StatusCodes.Status504GatewayTimeout);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException)
        {
            logger.LogWarning("Microsoft Foundry request failed ({FailureType}).", ex.GetType().Name);
            throw new FoundryServiceException(
                "Microsoft Foundry is temporarily unavailable. Please try again.",
                StatusCodes.Status502BadGateway);
        }
    }

    internal static FoundryChatResult ParseCompletionResponse(string rawJson, string fallbackModel)
    {
        using var document = JsonDocument.Parse(rawJson);
        var root = document.RootElement;

        if (!root.TryGetProperty("choices", out var choices)
            || choices.ValueKind != JsonValueKind.Array
            || choices.GetArrayLength() == 0)
        {
            throw new FoundryServiceException("Microsoft Foundry returned an empty response.");
        }

        var firstChoice = choices[0];
        if (!firstChoice.TryGetProperty("message", out var message)
            || !message.TryGetProperty("content", out var contentElement))
        {
            throw new FoundryServiceException("Microsoft Foundry returned an incomplete response.");
        }

        var content = (contentElement.GetString() ?? "").Trim();
        if (content.Length == 0)
        {
            throw new FoundryServiceException("Microsoft Foundry returned an empty message.");
        }

        var model = root.TryGetProperty("model", out var modelElement) && modelElement.ValueKind == JsonValueKind.String
            ? (modelElement.GetString() ?? fallbackModel).Trim()
            : fallbackModel;
        if (model.Length == 0) model = fallbackModel;

        FoundryChatUsage? usage = null;
        if (root.TryGetProperty("usage", out var usageEl) && usageEl.ValueKind == JsonValueKind.Object)
        {
            var promptTokens = usageEl.TryGetProperty("prompt_tokens", out var p) && p.TryGetInt32(out var pt) ? pt : 0;
            var completionTokens = usageEl.TryGetProperty("completion_tokens", out var c) && c.TryGetInt32(out var ct) ? ct : 0;
            var totalTokens = usageEl.TryGetProperty("total_tokens", out var t) && t.TryGetInt32(out var tt) ? tt : promptTokens + completionTokens;
            usage = new FoundryChatUsage(promptTokens, completionTokens, totalTokens);
        }

        return new FoundryChatResult(content, model, usage);
    }

    private static FoundryServiceException MapHttpError(HttpStatusCode statusCode) =>
        statusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => new FoundryServiceException(
                "Microsoft Foundry could not authenticate. Check the endpoint and key in production settings.",
                StatusCodes.Status502BadGateway),
            HttpStatusCode.NotFound => new FoundryServiceException(
                "The configured Microsoft Foundry deployment was not found.",
                StatusCodes.Status502BadGateway),
            HttpStatusCode.TooManyRequests => new FoundryServiceException(
                "Microsoft Foundry's request limit was reached. Please wait a moment and try again.",
                StatusCodes.Status429TooManyRequests),
            HttpStatusCode.BadRequest => new FoundryServiceException(
                "Microsoft Foundry rejected the analysis request. Try shortening your prompt.",
                StatusCodes.Status400BadRequest),
            _ => new FoundryServiceException(
                "Microsoft Foundry is temporarily unavailable. Please try again.",
                StatusCodes.Status502BadGateway),
        };
}
