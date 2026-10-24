using System.Text.Json;
using Microsoft.AspNetCore.Hosting;

namespace Signal.Server.Services;

public sealed class UserVoicePreferencesService
{
    private readonly string _filePath;
    private readonly object _lock = new();
    private readonly Dictionary<string, Dictionary<string, string>> _users;

    public UserVoicePreferencesService(IWebHostEnvironment environment)
        : this(Path.Combine(environment.ContentRootPath, "App_Data", "user-voices.json"))
    {
    }

    public UserVoicePreferencesService(string filePath)
    {
        _filePath = filePath;
        _users = Load(filePath);
    }

    public IReadOnlyDictionary<string, string> Get(string? userId)
    {
        if (string.IsNullOrWhiteSpace(userId))
            return new Dictionary<string, string>(StringComparer.Ordinal) { ["en"] = "", ["zh"] = "" };

        lock (_lock)
        {
            if (_users.TryGetValue(userId, out var saved))
            {
                return new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["en"] = saved.GetValueOrDefault("en", ""),
                    ["zh"] = saved.GetValueOrDefault("zh", ""),
                };
            }
            return new Dictionary<string, string>(StringComparer.Ordinal) { ["en"] = "", ["zh"] = "" };
        }
    }

    public IReadOnlyDictionary<string, string> Save(string? userId, IReadOnlyDictionary<string, string>? voices, bool replaceEmpty = true)
    {
        var normalized = Normalize(voices);
        if (string.IsNullOrWhiteSpace(userId))
            return normalized;

        lock (_lock)
        {
            if (!_users.TryGetValue(userId, out var current))
            {
                current = new Dictionary<string, string>(StringComparer.Ordinal) { ["en"] = "", ["zh"] = "" };
            }

            var changed = false;
            foreach (var key in new[] { "en", "zh" })
            {
                var incoming = normalized[key];
                var existing = current.GetValueOrDefault(key, "");
                if (replaceEmpty || !string.IsNullOrEmpty(incoming))
                {
                    if (!string.Equals(existing, incoming, StringComparison.Ordinal))
                    {
                        current[key] = incoming;
                        changed = true;
                    }
                }
            }

            if (changed || !_users.ContainsKey(userId))
            {
                _users[userId] = current;
                PersistLocked();
            }

            return new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["en"] = current.GetValueOrDefault("en", ""),
                ["zh"] = current.GetValueOrDefault("zh", ""),
            };
        }
    }

    public HeadlineAudioRequest ApplyToRequest(string? userId, HeadlineAudioRequest request)
    {
        if (string.IsNullOrWhiteSpace(userId))
            return request;

        if (request.Voices is { Count: > 0 })
        {
            // Keep invalid voice dictionaries intact so HeadlineAudioService.Validate rejects them with 400.
            if (request.Voices.Count > 2 || request.Voices.Any(pair => pair.Key is not ("en" or "zh") || pair.Value is null || pair.Value.Length > 160))
                return request;

            // Sync any non-empty language choice into the user's saved account preferences.
            var saved = Get(userId);
            var incomingEn = request.Voices.GetValueOrDefault("en")?.Trim() ?? "";
            var incomingZh = request.Voices.GetValueOrDefault("zh")?.Trim() ?? "";
            if ((!string.IsNullOrEmpty(incomingEn) && !string.Equals(saved.GetValueOrDefault("en", ""), incomingEn, StringComparison.Ordinal))
                || (!string.IsNullOrEmpty(incomingZh) && !string.Equals(saved.GetValueOrDefault("zh", ""), incomingZh, StringComparison.Ordinal)))
            {
                saved = Save(userId, request.Voices, replaceEmpty: false);
            }

            var merged = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["en"] = !string.IsNullOrWhiteSpace(request.Voices.GetValueOrDefault("en"))
                    ? request.Voices["en"].Trim()
                    : saved.GetValueOrDefault("en", ""),
                ["zh"] = !string.IsNullOrWhiteSpace(request.Voices.GetValueOrDefault("zh"))
                    ? request.Voices["zh"].Trim()
                    : saved.GetValueOrDefault("zh", ""),
            };
            return request with { Voices = merged };
        }

        var preferences = Get(userId);
        if (string.IsNullOrEmpty(preferences.GetValueOrDefault("en")) && string.IsNullOrEmpty(preferences.GetValueOrDefault("zh")))
            return request;

        return request with { Voices = preferences };
    }

    public static Dictionary<string, string> Normalize(IReadOnlyDictionary<string, string>? voices)
    {
        if (voices is not null && (voices.Count > 2
            || voices.Any(pair => pair.Key is not ("en" or "zh") || pair.Value is null || pair.Value.Length > 160)))
        {
            throw new ArgumentException("Choose an available English or Chinese reading voice.");
        }

        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["en"] = voices?.GetValueOrDefault("en")?.Trim() ?? "",
            ["zh"] = voices?.GetValueOrDefault("zh")?.Trim() ?? "",
        };
    }

    private static Dictionary<string, Dictionary<string, string>> Load(string filePath)
    {
        try
        {
            if (!File.Exists(filePath))
                return new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);

            var json = File.ReadAllText(filePath);
            var raw = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(json);
            if (raw is null)
                return new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);

            var result = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
            foreach (var (userId, prefs) in raw)
            {
                if (string.IsNullOrWhiteSpace(userId) || prefs is null) continue;
                var en = prefs.GetValueOrDefault("en")?.Trim() ?? "";
                var zh = prefs.GetValueOrDefault("zh")?.Trim() ?? "";
                result[userId] = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["en"] = en.Length <= 160 ? en : "",
                    ["zh"] = zh.Length <= 160 ? zh : "",
                };
            }
            return result;
        }
        catch
        {
            return new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        }
    }

    private void PersistLocked()
    {
        try
        {
            var directory = Path.GetDirectoryName(_filePath);
            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);
            var tempPath = _filePath + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(_users));
            File.Move(tempPath, _filePath, overwrite: true);
        }
        catch
        {
            // Voice playback remains available if disk persistence is temporarily unavailable.
        }
    }
}
