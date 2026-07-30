using System.ComponentModel.DataAnnotations;

namespace Signal.Server.Models;

public sealed class UserNewsPreferences
{
    [Key]
    public string UserId { get; set; } = "";

    public ApplicationUser User { get; set; } = null!;

    public string TopicsJson { get; set; } = "[]";

    public int StoryLimit { get; set; } = 20;

    public string StoryTitleSize { get; set; } = "large";

    public string TopicHeaderSize { get; set; } = "large";

    public int RefreshMinutes { get; set; } = 15;

    public bool EmailSummaryEnabled { get; set; }

    public int ArticleRetentionDays { get; set; } = 30;

    public bool GoogleEnabled { get; set; } = true;

    public bool GdeltEnabled { get; set; } = true;

    public string RssFeedsJson { get; set; } = "[]";

    public string TickerOverridesJson { get; set; } = "{}";

    public string WeatherLocationJson { get; set; } = "{}";

    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}
