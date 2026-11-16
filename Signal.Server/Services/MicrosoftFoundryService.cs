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

    private static readonly string[] BuiltInSelectableModels = ["gpt-4.1-mini", "gpt-5-mini", "gpt-6.1-sol"];

    internal static readonly Regex DeploymentNameRegex = new(
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
    public string[] Deployments { get; set; } = [];
    public string ApiVersion { get; set; } = DefaultApiVersion;

    public bool Enabled =>
        !string.IsNullOrWhiteSpace(Endpoint)
        && !string.IsNullOrWhiteSpace(Key)
        && !string.IsNullOrWhiteSpace(Deployment);

    public string[] GetSelectableDeployments()
    {
        if (!Enabled) return [];

        var list = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void TryAdd(string? candidate)
        {
            var trimmed = (candidate ?? "").Trim();
            if (trimmed.Length is >= 1 and <= 128
                && DeploymentNameRegex.IsMatch(trimmed)
                && !trimmed.Contains("embedding", StringComparison.OrdinalIgnoreCase)
                && seen.Add(trimmed))
            {
                list.Add(trimmed);
            }
        }

        TryAdd(Deployment);
        foreach (var item in Deployments ?? [])
        {
            TryAdd(item);
        }
        foreach (var builtIn in BuiltInSelectableModels)
        {
            TryAdd(builtIn);
        }

        return list.ToArray();
    }

    internal (Uri BaseUri, string Key, string Deployment, string ApiVersion) Validate(string? deploymentOverride = null)
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

        var targetDeployment = string.IsNullOrWhiteSpace(deploymentOverride)
            ? (Deployment ?? "").Trim()
            : ResolveAllowedDeployment(deploymentOverride);

        if (targetDeployment.Length is < 1 or > 128 || !DeploymentNameRegex.IsMatch(targetDeployment))
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

        return (uri, trimmedKey, targetDeployment, trimmedApiVersion);
    }

    public string ResolveAllowedDeployment(string? requested)
    {
        var defaultDeployment = (Deployment ?? "").Trim();
        if (string.IsNullOrWhiteSpace(requested))
        {
            return defaultDeployment;
        }

        var candidate = requested.Trim();
        foreach (var allowed in GetSelectableDeployments())
        {
            if (string.Equals(allowed, candidate, StringComparison.OrdinalIgnoreCase))
            {
                return allowed;
            }
        }

        throw new ArgumentException($"Choose an available Signal Bot model ({string.Join(", ", GetSelectableDeployments())}).");
    }

    public static void BindConfiguration(MicrosoftFoundryOptions target, IConfiguration configuration)
    {
        var primary = configuration.GetSection(PrimarySectionName);
        var fallback = configuration.GetSection(SecondarySectionName);
        primary.Bind(target);
        if (string.IsNullOrWhiteSpace(target.Endpoint)) target.Endpoint = fallback["Endpoint"] ?? "";
        if (string.IsNullOrWhiteSpace(target.Key)) target.Key = fallback["Key"] ?? "";
        if (string.IsNullOrWhiteSpace(target.Deployment)) target.Deployment = fallback["Deployment"] ?? "";
        if ((target.Deployments is null || target.Deployments.Length == 0))
        {
            var fallbackList = fallback.GetSection("Deployments").Get<string[]>();
            if (fallbackList is { Length: > 0 })
            {
                target.Deployments = fallbackList;
            }
        }
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
    bool JsonObjectResponse = true,
    string? Deployment = null);

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
    public string[] AvailableDeployments => options.Value.GetSelectableDeployments();

    public string ResolveDeployment(string? requestedDeployment) =>
        options.Value.ResolveAllowedDeployment(requestedDeployment);

    internal static bool IsReasoningDeployment(string deployment)
    {
        var normalized = (deployment ?? "").Trim().ToLowerInvariant();
        return normalized.StartsWith("gpt-5", StringComparison.Ordinal)
            || normalized.StartsWith("gpt-6", StringComparison.Ordinal)
            || normalized.StartsWith("o1", StringComparison.Ordinal)
            || normalized.StartsWith("o3", StringComparison.Ordinal)
            || normalized.StartsWith("o4", StringComparison.Ordinal);
    }

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

        var effectiveOptions = chatOptions ?? new FoundryChatOptions();
        var (baseUri, apiKey, deployment, apiVersion) = options.Value.Validate(effectiveOptions.Deployment);
        var isReasoningModel = IsReasoningDeployment(deployment);
        var requestUri = new Uri(
            baseUri,
            $"openai/deployments/{Uri.EscapeDataString(deployment)}/chat/completions?api-version={Uri.EscapeDataString(apiVersion)}");

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(isReasoningModel ? 60 : 45));

        try
        {
            var client = clients.CreateClient(HttpClientName);
            using var request = new HttpRequestMessage(HttpMethod.Post, requestUri);
            request.Headers.Add("api-key", apiKey);

            var payload = new Dictionary<string, object?>
            {
                ["messages"] = messages.Select(m => new { role = m.Role, content = m.Content }).ToArray(),
            };
            if (isReasoningModel)
            {
                // Reasoning models (gpt-5*, o-series) reject temperature/max_tokens and share the token budget with thinking.
                payload["max_completion_tokens"] = Math.Clamp(Math.Max(effectiveOptions.MaxTokens * 2, 2800), 1000, 6000);
                payload["reasoning_effort"] = "low";
            }
            else
            {
                payload["temperature"] = Math.Clamp(effectiveOptions.Temperature, 0.0, 1.0);
                payload["max_tokens"] = Math.Clamp(effectiveOptions.MaxTokens, 64, 4096);
            }
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
