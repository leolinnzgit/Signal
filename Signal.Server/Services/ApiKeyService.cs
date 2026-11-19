using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class ApiKeyService(
    SignalDbContext database,
    ILogger<ApiKeyService> logger,
    TimeProvider? timeProvider = null)
{
    public const string KeyPrefixLiteral = "sig_";
    public const int RawSecretByteCount = 32;
    public const int ExpectedKeyLength = 47;
    public const int MaxActiveKeysPerUser = 10;
    public static readonly TimeSpan LastUsedWriteInterval = TimeSpan.FromMinutes(5);

    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;

    public sealed record ApiKeySummary(
        string Id,
        string Name,
        string KeyPrefix,
        string[] Scopes,
        DateTimeOffset CreatedAt,
        DateTimeOffset? ExpiresAt,
        DateTimeOffset? LastUsedAt,
        bool IsExpired);

    public sealed record CreatedApiKeyResult(
        string PlaintextKey,
        ApiKeySummary Summary);

    public sealed record ApiKeyValidationResult(
        bool Succeeded,
        string? FailureReason,
        ApplicationUser? User,
        ApiKeySummary? Summary,
        string[] Scopes);

    public async Task<CreatedApiKeyResult> CreateAsync(
        string userId,
        string name,
        int? expiresInDays,
        string[]? scopes,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("A valid account is required.", nameof(userId));

        var normalizedName = NormalizeName(name);
        if (normalizedName.Length == 0 || normalizedName.Length > 80)
            throw new ArgumentException("Choose a key name between 1 and 80 characters.", nameof(name));

        if (expiresInDays is { } days && (days < 1 || days > 365))
            throw new ArgumentException("Expiration must be between 1 and 365 days, or omitted for no expiration.", nameof(expiresInDays));

        var normalizedScopes = NormalizeScopes(scopes);
        var utcNow = clock.GetUtcNow().UtcDateTime;

        var activeCount = await database.ApiKeys
            .AsNoTracking()
            .CountAsync(
                item => item.UserId == userId
                    && item.RevokedAtUtc == null
                    && (item.ExpiresAtUtc == null || item.ExpiresAtUtc > utcNow),
                cancellationToken);
        if (activeCount >= MaxActiveKeysPerUser)
            throw new InvalidOperationException($"You can have at most {MaxActiveKeysPerUser} active API keys. Revoke an unused key first.");

        var plaintextKey = KeyPrefixLiteral + WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(RawSecretByteCount));
        var entity = new ApiKey
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            Name = normalizedName,
            KeyPrefix = plaintextKey[..12],
            KeyHash = ComputeHash(plaintextKey),
            ScopesJson = JsonSerializer.Serialize(normalizedScopes),
            CreatedAtUtc = utcNow,
            ExpiresAtUtc = expiresInDays is { } validDays ? utcNow.AddDays(validDays) : null,
        };

        database.ApiKeys.Add(entity);
        await database.SaveChangesAsync(cancellationToken);

        return new CreatedApiKeyResult(plaintextKey, ToSummary(entity, utcNow));
    }

    public async Task<ApiKeySummary[]> ListActiveAsync(
        string userId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(userId)) return [];
        var utcNow = clock.GetUtcNow().UtcDateTime;
        var rows = await database.ApiKeys
            .AsNoTracking()
            .Where(item => item.UserId == userId && item.RevokedAtUtc == null)
            .OrderByDescending(item => item.CreatedAtUtc)
            .ToArrayAsync(cancellationToken);
        return rows.Select(item => ToSummary(item, utcNow)).ToArray();
    }

    public async Task<bool> RevokeAsync(
        string userId,
        string keyId,
        CancellationToken cancellationToken)
    {
        var trimmedId = (keyId ?? "").Trim();
        if (string.IsNullOrWhiteSpace(userId) || trimmedId.Length == 0) return false;

        var entity = await database.ApiKeys
            .SingleOrDefaultAsync(
                item => item.UserId == userId && item.Id == trimmedId && item.RevokedAtUtc == null,
                cancellationToken);
        if (entity is null) return false;

        entity.RevokedAtUtc = clock.GetUtcNow().UtcDateTime;
        await database.SaveChangesAsync(cancellationToken);
        return true;
    }

    public async Task<ApiKeyValidationResult> AuthenticateAsync(
        string rawKey,
        CancellationToken cancellationToken)
    {
        if (!IsValidKeyFormat(rawKey))
            return Failure("Invalid API key.");

        var hash = ComputeHash(rawKey);
        var row = await database.ApiKeys
            .AsNoTracking()
            .Include(item => item.User)
            .SingleOrDefaultAsync(item => item.KeyHash == hash, cancellationToken);
        if (row is null)
            return Failure("Invalid API key.");

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(hash),
                Encoding.UTF8.GetBytes(row.KeyHash)))
        {
            return Failure("Invalid API key.");
        }

        if (row.RevokedAtUtc is not null)
            return Failure("This API key has been revoked.");

        var now = clock.GetUtcNow();
        var utcNow = now.UtcDateTime;
        if (row.ExpiresAtUtc is { } expiresAt && expiresAt <= utcNow)
            return Failure("This API key has expired.");

        if (row.User is null || !row.User.EmailConfirmed)
            return Failure("The owning account is not permitted to use API keys.");

        if (row.User.LockoutEnabled && row.User.LockoutEnd is { } lockoutEnd && lockoutEnd > now)
            return Failure("The owning account is temporarily locked.");

        if (row.LastUsedAtUtc is null || utcNow - row.LastUsedAtUtc.Value >= LastUsedWriteInterval)
        {
            try
            {
                await database.ApiKeys
                    .Where(item => item.Id == row.Id && item.RevokedAtUtc == null)
                    .ExecuteUpdateAsync(
                        setters => setters.SetProperty(item => item.LastUsedAtUtc, utcNow),
                        cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception)
            {
                logger.LogDebug(exception, "Could not update LastUsedAtUtc for API key {KeyId}.", row.Id);
            }
        }

        var scopes = DeserializeScopes(row.ScopesJson);
        return new ApiKeyValidationResult(true, null, row.User, ToSummary(row, utcNow), scopes);
    }

    public static bool IsValidKeyFormat(string? rawKey)
    {
        if (string.IsNullOrEmpty(rawKey)
            || rawKey.Length != ExpectedKeyLength
            || !rawKey.StartsWith(KeyPrefixLiteral, StringComparison.Ordinal))
        {
            return false;
        }

        for (var i = KeyPrefixLiteral.Length; i < rawKey.Length; i++)
        {
            var ch = rawKey[i];
            if (!char.IsAsciiLetterOrDigit(ch) && ch != '-' && ch != '_')
                return false;
        }

        return true;
    }

    public static string ComputeHash(string rawKey) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(rawKey)));

    private static string NormalizeName(string? name) =>
        string.Join(' ', (name ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static string[] NormalizeScopes(string[]? scopes)
    {
        if (scopes is null || scopes.Length == 0)
            return [ApiKeyScopes.NewsRead];

        var cleaned = scopes
            .Select(scope => (scope ?? "").Trim().ToLowerInvariant())
            .Where(scope => scope.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (cleaned.Length == 0)
            return [ApiKeyScopes.NewsRead];

        foreach (var scope in cleaned)
        {
            if (!ApiKeyScopes.All.Contains(scope, StringComparer.Ordinal))
                throw new ArgumentException($"Unsupported API key scope '{scope}'.", nameof(scopes));
        }

        return cleaned;
    }

    private static string[] DeserializeScopes(string json)
    {
        try
        {
            var parsed = JsonSerializer.Deserialize<string[]>(json);
            return parsed is { Length: > 0 } ? parsed : [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static ApiKeySummary ToSummary(ApiKey entity, DateTime utcNow) => new(
        entity.Id,
        entity.Name,
        entity.KeyPrefix,
        DeserializeScopes(entity.ScopesJson),
        new DateTimeOffset(DateTime.SpecifyKind(entity.CreatedAtUtc, DateTimeKind.Utc)),
        entity.ExpiresAtUtc is { } exp ? new DateTimeOffset(DateTime.SpecifyKind(exp, DateTimeKind.Utc)) : null,
        entity.LastUsedAtUtc is { } lastUsed ? new DateTimeOffset(DateTime.SpecifyKind(lastUsed, DateTimeKind.Utc)) : null,
        entity.ExpiresAtUtc is { } expiry && expiry <= utcNow);

    private static ApiKeyValidationResult Failure(string reason) =>
        new(false, reason, null, null, []);
}
