namespace Signal.Server.Services;

public interface IAccountEmailSender
{
    Task SendConfirmationAsync(string email, string confirmationUrl, CancellationToken cancellationToken);
    Task SendPasswordResetAsync(string email, string resetUrl, CancellationToken cancellationToken);
    Task SendNewsSummaryAsync(string email, NewsSummaryDigest digest, CancellationToken cancellationToken);
    Task SendSharedArticleAsync(
        string email,
        SharedArticleEmail sharedArticle,
        CancellationToken cancellationToken);
    Task SendExecutiveBriefingEmailAsync(
        string email,
        ExecutiveBriefingEmailDigest digest,
        CancellationToken cancellationToken) => Task.CompletedTask;
    Task SendExecutiveDossierEmailAsync(
        string email,
        ExecutiveDossierEmailDigest digest,
        CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed record SharedArticleEmail(
    string SenderName,
    string Title,
    string Source,
    string ArticleUrl,
    string SignalUrl);

public sealed record NewsSummaryDigest(
    DateTimeOffset RefreshedAt,
    IReadOnlyList<string> Topics,
    IReadOnlyList<NewsSummaryArticle> Articles);

public sealed record NewsSummaryArticle(
    string Title,
    string Url,
    string Source,
    DateTimeOffset PublishedAt,
    string Summary,
    IReadOnlyList<string> Topics,
    IReadOnlyList<string> Providers);

public sealed record ExecutiveBriefingEmailStory(
    string Title,
    string Url,
    string Source,
    string Summary,
    string? PriorityTopic = null);

public sealed record ExecutiveBriefingEmailMarket(
    string Symbol,
    string Name,
    string FormattedPrice,
    decimal PercentChange);

public sealed record ExecutiveBriefingEmailDigest(
    string Greeting,
    string EditionLabel,
    string FormattedDate,
    string OpenBriefingUrl,
    string? HostedAudioShareUrl,
    IReadOnlyList<string> PriorityTopics,
    IReadOnlyList<ExecutiveBriefingEmailMarket> Markets,
    IReadOnlyList<ExecutiveBriefingEmailStory> LeadStories);

public sealed record ExecutiveDossierEmailDigest(
    string Topic,
    string ExecutiveSummary,
    IReadOnlyList<DossierPerspectiveDigest> Perspectives,
    IReadOnlyList<DossierRiskDigest> Risks,
    IReadOnlyList<DossierMilestoneDigest> Milestones,
    IReadOnlyList<string> CitedSources);

public sealed record DossierPerspectiveDigest(
    string Publisher,
    string PrimaryFocus,
    string FramingTone);

public sealed record DossierRiskDigest(
    string Category,
    string Description,
    string Severity);

public sealed record DossierMilestoneDigest(
    string Phase,
    string DateOrEra,
    string Headline,
    string Summary);
