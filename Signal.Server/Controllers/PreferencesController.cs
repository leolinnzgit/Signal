using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;

namespace Signal.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/preferences")]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
public sealed class PreferencesController(
    SignalDbContext database,
    UserManager<ApplicationUser> userManager) : ControllerBase
{
    private static readonly int[] AllowedRefreshMinutes = [0, 5, 15, 30, 60, 120, 180, 240, 300, 360, 420, 480];

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();

        var preferences = await database.UserNewsPreferences
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);

        return Ok(new PreferencesEnvelope(
            preferences is not null,
            preferences is null ? NewsPreferencesResponse.Default : ToResponse(preferences)));
    }

    [HttpPost]
    public async Task<IActionResult> Save(
        NewsPreferencesRequest request,
        CancellationToken cancellationToken)
    {
        var userId = userManager.GetUserId(User);
        if (userId is null) return Unauthorized();
        if (!AllowedRefreshMinutes.Contains(request.RefreshMinutes))
            return BadRequest(new { error = "Choose a supported refresh interval." });

        var topics = NormalizeTopics(request.Topics);
        var rssFeeds = NormalizeRssFeeds(request.Sources.RssFeeds);
        var preferences = await database.UserNewsPreferences
            .SingleOrDefaultAsync(item => item.UserId == userId, cancellationToken);

        if (preferences is null)
        {
            preferences = new UserNewsPreferences { UserId = userId };
            database.UserNewsPreferences.Add(preferences);
        }

        preferences.TopicsJson = JsonSerializer.Serialize(topics);
        preferences.StoryLimit = request.Limit;
        preferences.RefreshMinutes = request.RefreshMinutes;
        preferences.EmailSummaryEnabled = request.EmailSummaryEnabled;
        preferences.GoogleEnabled = request.Sources.Google;
        preferences.GdeltEnabled = request.Sources.Gdelt;
        preferences.RssFeedsJson = JsonSerializer.Serialize(rssFeeds);
        preferences.UpdatedAtUtc = DateTimeOffset.UtcNow;

        await database.SaveChangesAsync(cancellationToken);
        return Ok(new PreferencesEnvelope(true, ToResponse(preferences)));
    }

    private static string[] NormalizeTopics(IEnumerable<string> values) => values
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Select(value => string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)))
        .Select(value => value[..Math.Min(value.Length, 80)])
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Take(20)
        .ToArray();

    private static string[] NormalizeRssFeeds(IEnumerable<string> values) => values
        .Where(value => value.Length <= 2048)
        .Select(value => Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ? uri : null)
        .Where(uri => uri is not null
            && uri.Scheme == Uri.UriSchemeHttps
            && string.IsNullOrEmpty(uri.UserInfo))
        .Select(uri => uri!.AbsoluteUri)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Take(20)
        .ToArray();

    private static NewsPreferencesResponse ToResponse(UserNewsPreferences preferences) => new(
        DeserializeList(preferences.TopicsJson),
        Math.Clamp(preferences.StoryLimit, 1, 10),
        AllowedRefreshMinutes.Contains(preferences.RefreshMinutes) ? preferences.RefreshMinutes : 15,
        preferences.EmailSummaryEnabled,
        new NewsSourcesResponse(
            preferences.GoogleEnabled,
            preferences.GdeltEnabled,
            DeserializeList(preferences.RssFeedsJson)));

    private static string[] DeserializeList(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<string[]>(json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}

public sealed record PreferencesEnvelope(bool Exists, NewsPreferencesResponse Preferences);

public sealed record NewsPreferencesResponse(
    string[] Topics,
    int Limit,
    int RefreshMinutes,
    bool EmailSummaryEnabled,
    NewsSourcesResponse Sources)
{
    public static NewsPreferencesResponse Default { get; } = new(
        ["Artificial intelligence"],
        6,
        15,
        false,
        new NewsSourcesResponse(true, true, []));
}

public sealed record NewsSourcesResponse(bool Google, bool Gdelt, string[] RssFeeds);

public sealed record NewsPreferencesRequest(
    [Required] string[] Topics,
    [Range(1, 10)] int Limit,
    int RefreshMinutes,
    bool EmailSummaryEnabled,
    [Required] NewsSourcesRequest Sources);

public sealed record NewsSourcesRequest(
    bool Google,
    bool Gdelt,
    [Required] string[] RssFeeds);
