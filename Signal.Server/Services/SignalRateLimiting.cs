using System.Globalization;
using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Signal.Server.Services;

public static class SignalRateLimiting
{
    public static void Configure(RateLimiterOptions options)
    {
        options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
        options.OnRejected = async (context, token) =>
        {
            var seconds = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter)
                ? Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)) : 60;
            context.HttpContext.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
            await context.HttpContext.Response.WriteAsJsonAsync(new { error = "Too many requests. Please try again shortly." }, token);
        };
        // Credential attempts must not share a budget with ordinary signed-in activity.
        options.AddPolicy("authentication", context => Limit(Ip(context), 30));
        options.AddPolicy("account", context =>
        {
            var user = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
            if (context.User.Identity?.IsAuthenticated != true || user is null) return Limit(Ip(context), 30);
            var read = HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method);
            return Limit($"user:{user}:{(read ? "read" : "write")}", read ? 240 : 120);
        });
        // Token issuance is cheap and must remain available after another API is throttled.
        options.AddPolicy("csrf", context =>
        {
            var user = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
            return context.User.Identity?.IsAuthenticated == true && user is not null
                ? Limit($"user:{user}", 240) : Limit(Ip(context), 60);
        });
        options.AddPolicy("news-extract", context =>
        {
            var keyId = context.User.FindFirstValue(ApiKeyAuthenticationDefaults.KeyIdClaimType);
            if (!string.IsNullOrEmpty(keyId)) return Limit($"apikey:{keyId}", 60);
            var user = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
            return context.User.Identity?.IsAuthenticated == true && user is not null
                ? Limit($"user:{user}:news", 240) : Limit(Ip(context), 30);
        });
    }

    private static string Ip(HttpContext context) => $"ip:{context.Connection.RemoteIpAddress?.ToString() ?? "unknown"}";
    private static RateLimitPartition<string> Limit(string key, int permits) => RateLimitPartition.GetFixedWindowLimiter(key,
        _ => new FixedWindowRateLimiterOptions { PermitLimit = permits, Window = TimeSpan.FromMinutes(1), QueueLimit = 0, AutoReplenishment = true });
}
