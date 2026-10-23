using System.Security.Cryptography;
using System.Text;

namespace Signal.Server.Services;

/// <summary>Short-lived, single-use watch approvals. No passwords or credentials are persisted.</summary>
public sealed class WatchPairingService(TimeProvider? clock = null, int capacity = 256)
{
    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private readonly TimeProvider time = clock ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private sealed record Entry(string Code, DateTimeOffset ExpiresAt, string? UserId = null);
    public sealed record Challenge(string DeviceSecret, string UserCode, DateTimeOffset ExpiresAt);
    public sealed record ClaimResult(string Status, string? UserId = null);

    public Challenge Create()
    {
        lock (gate)
        {
            foreach (var key in entries.Where(pair => pair.Value.ExpiresAt <= time.GetUtcNow()).Select(pair => pair.Key).ToArray())
                entries.Remove(key);
            if (entries.Count >= capacity) throw new InvalidOperationException("Watch pairing is busy. Try again shortly.");
            string code;
            do { code = string.Concat(Enumerable.Range(0, 8).Select(_ => Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)])); }
            while (entries.Values.Any(entry => entry.Code == code));
            var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var expiry = time.GetUtcNow().AddMinutes(10);
            entries.Add(Hash(secret), new Entry(code, expiry));
            return new Challenge(secret, code[..4] + "-" + code[4..], expiry);
        }
    }

    public bool Approve(string rawCode, string userId)
    {
        var code = new string(rawCode.Where(char.IsLetterOrDigit).ToArray()).ToUpperInvariant();
        if (code.Length != 8 || userId.Length == 0) return false;
        lock (gate)
        {
            var match = entries.FirstOrDefault(pair => pair.Value.Code == code);
            if (match.Value is null || match.Value.ExpiresAt <= time.GetUtcNow() || match.Value.UserId is not null) return false;
            entries[match.Key] = match.Value with { UserId = userId };
            return true;
        }
    }

    public ClaimResult Claim(string secret)
    {
        if (secret.Length != 64 || !secret.All(char.IsAsciiHexDigit)) return new("expired");
        lock (gate)
        {
            var key = Hash(secret);
            if (!entries.TryGetValue(key, out var entry)) return new("expired");
            if (entry.ExpiresAt <= time.GetUtcNow()) { entries.Remove(key); return new("expired"); }
            if (entry.UserId is null) return new("pending");
            entries.Remove(key); // Atomic consumption: exactly one caller can acquire this account.
            return new("approved", entry.UserId);
        }
    }

    private static string Hash(string secret) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(secret)));
}
