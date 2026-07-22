namespace Signal.Server.Services;

public interface IAccountEmailSender
{
    Task SendConfirmationAsync(string email, string confirmationUrl, CancellationToken cancellationToken);
    Task SendPasswordResetAsync(string email, string resetUrl, CancellationToken cancellationToken);
    Task SendNewsSummaryAsync(string email, NewsSummaryDigest digest, CancellationToken cancellationToken);
}

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
