using System.Globalization;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Signal.Server.Models;

namespace Signal.Server.Services;

public static class ApiKeyAuthenticationDefaults
{
    public const string AuthenticationScheme = "ApiKey";
    public const string HeaderName = "X-API-Key";
    public const string NewsReadPolicy = "NewsRead";
    public const string ApiKeyOnlyPolicy = "ApiKeyOnly";
    public const string KeyIdClaimType = "signal_api_key_id";
    public const string KeyNameClaimType = "signal_api_key_name";
    public const string KeyPrefixClaimType = "signal_api_key_prefix";
    public const string KeyExpiresAtClaimType = "signal_api_key_expires_at";
    public const string ScopeClaimType = "signal_api_scope";
    public const string FailureReasonItemKey = "Signal.ApiKey.FailureReason";
}

public sealed class ApiKeyAuthenticationOptions : AuthenticationSchemeOptions;

public sealed class ApiKeyAuthenticationHandler(
    IOptionsMonitor<ApiKeyAuthenticationOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    ApiKeyService apiKeyService)
    : AuthenticationHandler<ApiKeyAuthenticationOptions>(options, logger, encoder)
{
    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var hasAuthorization = Request.Headers.TryGetValue("Authorization", out var authValues);
        var hasApiKeyHeader = Request.Headers.TryGetValue(ApiKeyAuthenticationDefaults.HeaderName, out var apiKeyValues);

        if (!hasAuthorization && !hasApiKeyHeader)
            return AuthenticateResult.NoResult();

        if (hasAuthorization && authValues.Count > 1)
            return FailWithReason("Multiple Authorization headers are not supported.");

        if (hasApiKeyHeader && apiKeyValues.Count > 1)
            return FailWithReason("Multiple X-API-Key headers are not supported.");

        var rawAuthorization = hasAuthorization ? (authValues[0] ?? "").Trim() : null;
        var rawHeaderKey = hasApiKeyHeader ? (apiKeyValues[0] ?? "").Trim() : null;

        string? bearerToken = null;
        if (rawAuthorization is not null)
        {
            if (rawAuthorization.StartsWith("Bearer", StringComparison.OrdinalIgnoreCase))
            {
                if (rawAuthorization.Length == 6 || !char.IsWhiteSpace(rawAuthorization[6]))
                    return FailWithReason("Invalid Bearer authorization header.");

                bearerToken = rawAuthorization[6..].Trim();
                if (string.IsNullOrEmpty(bearerToken))
                    return FailWithReason("Missing Bearer API key.");
            }
            else if (rawHeaderKey is null)
            {
                return FailWithReason("Unsupported authorization scheme. Use Authorization: Bearer <key> or X-API-Key.");
            }
        }

        if (rawHeaderKey is not null && string.IsNullOrEmpty(rawHeaderKey))
            return FailWithReason("Missing X-API-Key header value.");

        if (bearerToken is not null
            && rawHeaderKey is not null
            && !string.Equals(bearerToken, rawHeaderKey, StringComparison.Ordinal))
        {
            return FailWithReason("Conflicting API keys were provided in Authorization and X-API-Key headers.");
        }

        var rawKey = bearerToken ?? rawHeaderKey;
        if (string.IsNullOrEmpty(rawKey))
            return AuthenticateResult.NoResult();

        var validation = await apiKeyService.AuthenticateAsync(rawKey, Context.RequestAborted);
        if (!validation.Succeeded || validation.User is null || validation.Summary is null)
            return FailWithReason(validation.FailureReason ?? "Invalid API key.");

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, validation.User.Id),
            new(ClaimTypes.Name, validation.User.UserName ?? validation.User.Email ?? validation.User.Id),
            new(ApiKeyAuthenticationDefaults.KeyIdClaimType, validation.Summary.Id),
            new(ApiKeyAuthenticationDefaults.KeyNameClaimType, validation.Summary.Name),
            new(ApiKeyAuthenticationDefaults.KeyPrefixClaimType, validation.Summary.KeyPrefix),
        };
        if (!string.IsNullOrWhiteSpace(validation.User.Email))
            claims.Add(new Claim(ClaimTypes.Email, validation.User.Email));
        if (validation.Summary.ExpiresAt is { } expiresAt)
            claims.Add(new Claim(ApiKeyAuthenticationDefaults.KeyExpiresAtClaimType, expiresAt.ToString("O", CultureInfo.InvariantCulture)));
        foreach (var scope in validation.Scopes)
            claims.Add(new Claim(ApiKeyAuthenticationDefaults.ScopeClaimType, scope));

        var identity = new ClaimsIdentity(claims, Scheme.Name);
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name);
        return AuthenticateResult.Success(ticket);
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        if (Response.HasStarted) return;

        if (Context.Items.TryGetValue(ApiKeyAuthenticationDefaults.FailureReasonItemKey, out var reasonObj)
            && reasonObj is string reason)
        {
            Response.Headers.WWWAuthenticate = "Bearer realm=\"Signal API\", error=\"invalid_token\"";
            Response.StatusCode = StatusCodes.Status401Unauthorized;
            await Response.WriteAsJsonAsync(new { error = reason }, Context.RequestAborted);
            return;
        }

        Response.Headers.WWWAuthenticate = "Bearer realm=\"Signal API\"";
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        await Response.WriteAsJsonAsync(
            new { error = "Authentication required. Sign in or pass a Signal API key via the Authorization: Bearer <key> or X-API-Key header." },
            Context.RequestAborted);
    }

    protected override async Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        if (!Response.HasStarted)
        {
            Response.StatusCode = StatusCodes.Status403Forbidden;
            await Response.WriteAsJsonAsync(
                new { error = "This API key does not have permission for this endpoint." },
                Context.RequestAborted);
        }
    }

    private AuthenticateResult FailWithReason(string reason)
    {
        Context.Items[ApiKeyAuthenticationDefaults.FailureReasonItemKey] = reason;
        return AuthenticateResult.Fail(reason);
    }
}

public static class ApiKeyAuthorization
{
    public static void Configure(AuthorizationOptions options)
    {
        options.AddPolicy(ApiKeyAuthenticationDefaults.NewsReadPolicy, policy =>
        {
            policy.AddAuthenticationSchemes(
                IdentityConstants.ApplicationScheme,
                ApiKeyAuthenticationDefaults.AuthenticationScheme);
            policy.RequireAuthenticatedUser();
            policy.RequireAssertion(context =>
            {
                if (context.Resource is HttpContext httpContext
                    && httpContext.Items.ContainsKey(ApiKeyAuthenticationDefaults.FailureReasonItemKey))
                {
                    return false;
                }

                if (context.User.Identities.Any(identity =>
                    identity.IsAuthenticated
                    && string.Equals(identity.AuthenticationType, IdentityConstants.ApplicationScheme, StringComparison.Ordinal)))
                {
                    return true;
                }

                return context.User.Identities.Any(identity =>
                    identity.IsAuthenticated
                    && string.Equals(identity.AuthenticationType, ApiKeyAuthenticationDefaults.AuthenticationScheme, StringComparison.Ordinal))
                    && context.User.HasClaim(ApiKeyAuthenticationDefaults.ScopeClaimType, ApiKeyScopes.NewsRead);
            });
        });

        options.AddPolicy(ApiKeyAuthenticationDefaults.ApiKeyOnlyPolicy, policy =>
        {
            policy.AddAuthenticationSchemes(ApiKeyAuthenticationDefaults.AuthenticationScheme);
            policy.RequireAuthenticatedUser();
        });
    }
}
