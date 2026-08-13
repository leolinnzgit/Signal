using System.Net;
using System.Net.Mail;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class AccountEmailSender(
    IOptions<SmtpOptions> options,
    GmailApiEmailSender gmail,
    IWebHostEnvironment environment,
    ILogger<AccountEmailSender> logger) : IAccountEmailSender
{
    private readonly SmtpOptions _options = options.Value;

    public Task SendConfirmationAsync(string email, string confirmationUrl, CancellationToken cancellationToken) =>
        SendAsync(
            email,
            "Confirm your Signal account",
            "Confirm your email",
            "Confirm this email address to activate your Signal account.",
            confirmationUrl,
            cancellationToken);

    public Task SendPasswordResetAsync(string email, string resetUrl, CancellationToken cancellationToken) =>
        SendAsync(
            email,
            "Reset your Signal password",
            "Reset your password",
            "Use this secure link within two hours to choose a new Signal password.",
            resetUrl,
            cancellationToken);

    public Task SendNewsSummaryAsync(
        string email,
        NewsSummaryDigest digest,
        CancellationToken cancellationToken)
    {
        var subject = digest.Articles.Count == 1
            ? "Your Signal briefing - 1 story"
            : $"Your Signal briefing - {digest.Articles.Count} stories";
        return SendHtmlAsync(email, subject, BuildNewsSummaryBody(digest), cancellationToken);
    }

    public Task SendSharedArticleAsync(
        string email,
        SharedArticleEmail sharedArticle,
        CancellationToken cancellationToken)
    {
        var encoder = HtmlEncoder.Default;
        var sender = encoder.Encode(sharedArticle.SenderName);
        var title = encoder.Encode(sharedArticle.Title);
        var source = encoder.Encode(sharedArticle.Source);
        var articleUrl = encoder.Encode(sharedArticle.ArticleUrl);
        var signalUrl = encoder.Encode(sharedArticle.SignalUrl);
        var subject = $"{sharedArticle.SenderName} shared a story with you on Signal";
        var body = $$"""
            <!doctype html>
            <html lang="en"><body style="margin:0;background:#f4f0e7;color:#171815;font-family:Arial,sans-serif">
              <div style="display:none;max-height:0;overflow:hidden">{{sender}} shared {{title}} with you.</div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f0e7">
                <tr><td align="center" style="padding:42px 18px">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px">
                    <tr><td style="padding:0 0 24px;border-bottom:2px solid #171815">
                      <p style="margin:0 0 18px;color:#c83f32;font-size:12px;font-weight:700;letter-spacing:.24em">SIGNAL</p>
                      <h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:38px;font-weight:400;line-height:1.08">{{sender}} shared a story.</h1>
                      <p style="margin:0;color:#657364;font-size:14px;line-height:1.6">You were offline, so Signal saved it in your conversation and sent this notification.</p>
                    </td></tr>
                    <tr><td style="padding:26px 0">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #ded7ca;background:#fffdf8">
                        <tr><td style="padding:24px">
                          <p style="margin:0 0 10px;color:#c83f32;font-size:11px;font-weight:700;letter-spacing:.11em;text-transform:uppercase">{{source}}</p>
                          <h2 style="margin:0;font-family:Georgia,serif;font-size:25px;font-weight:400;line-height:1.28"><a href="{{articleUrl}}" style="color:#171815;text-decoration:none">{{title}}</a></h2>
                        </td></tr>
                      </table>
                    </td></tr>
                    <tr><td style="padding:0 0 24px">
                      <a href="{{signalUrl}}" style="display:inline-block;margin:0 10px 10px 0;background:#171815;color:#f4f0e7;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:700">Open Signal</a>
                      <a href="{{articleUrl}}" style="display:inline-block;color:#c83f32;text-decoration:none;padding:14px 4px;font-weight:700">Read original story &rarr;</a>
                    </td></tr>
                    <tr><td style="padding-top:18px;border-top:1px solid #d9d2c4;color:#77796f;font-size:12px;line-height:1.6">
                      This email was sent because a Signal friend shared a story while you were offline.
                    </td></tr>
                  </table>
                </td></tr>
              </table>
            </body></html>
            """;
        return SendHtmlAsync(email, subject, body, cancellationToken);
    }

    private async Task SendAsync(
        string email,
        string subject,
        string heading,
        string message,
        string actionUrl,
        CancellationToken cancellationToken)
    {
        var safeUrl = HtmlEncoder.Default.Encode(actionUrl);
        var body = $$"""
            <!doctype html>
            <html lang="en"><body style="margin:0;background:#f4f0e7;color:#171815;font-family:Arial,sans-serif">
              <div style="max-width:560px;margin:0 auto;padding:48px 24px">
                <p style="letter-spacing:.24em;font-size:12px;font-weight:700;color:#c83f32">SIGNAL</p>
                <h1 style="font-family:Georgia,serif;font-size:36px;font-weight:400">{{heading}}</h1>
                <p style="line-height:1.6">{{message}}</p>
                <p style="margin:32px 0"><a href="{{safeUrl}}" style="background:#171815;color:#f4f0e7;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:700">{{heading}}</a></p>
                <p style="font-size:12px;color:#657364">If you did not request this, you can safely ignore this email.</p>
              </div>
            </body></html>
            """;

        await SendHtmlAsync(email, subject, body, cancellationToken);
    }

    private static string BuildNewsSummaryBody(NewsSummaryDigest digest)
    {
        var encoder = HtmlEncoder.Default;
        var refreshedAt = encoder.Encode(digest.RefreshedAt.ToLocalTime().ToString("dddd d MMMM, h:mm tt"));
        var topicMarkup = string.Join("", digest.Topics.Select(topic =>
            $"<span style=\"display:inline-block;margin:0 6px 8px 0;padding:7px 10px;border:1px solid #d9d2c4;border-radius:999px;color:#657364;font-size:12px\">{encoder.Encode(topic)}</span>"));
        var articleMarkup = new StringBuilder();

        foreach (var article in digest.Articles)
        {
            var safeUrl = encoder.Encode(article.Url);
            var safeTitle = encoder.Encode(article.Title);
            var safeSource = encoder.Encode(article.Source);
            var safeSummary = encoder.Encode(article.Summary);
            var publishedAt = encoder.Encode(article.PublishedAt.ToLocalTime().ToString("d MMM, h:mm tt"));
            var context = string.Join(" / ", article.Topics.Concat(article.Providers).Distinct(StringComparer.OrdinalIgnoreCase));
            articleMarkup.Append($$"""
                <tr><td style="padding:0 0 14px">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #ded7ca;background:#fffdf8">
                    <tr><td style="padding:22px 22px 20px">
                      <p style="margin:0 0 9px;color:#c83f32;font-size:11px;font-weight:700;letter-spacing:.11em;text-transform:uppercase">{{safeSource}} &middot; {{publishedAt}}</p>
                      <h2 style="margin:0 0 10px;font-family:Georgia,serif;font-size:23px;font-weight:400;line-height:1.25"><a href="{{safeUrl}}" style="color:#171815;text-decoration:none">{{safeTitle}}</a></h2>
                      {{(string.IsNullOrWhiteSpace(safeSummary) ? "" : $"<p style=\"margin:0 0 13px;color:#4f514b;font-size:14px;line-height:1.55\">{safeSummary}</p>")}}
                      <p style="margin:0;color:#77796f;font-size:11px;line-height:1.4">{{encoder.Encode(context)}}</p>
                    </td></tr>
                  </table>
                </td></tr>
                """);
        }

        return $$"""
            <!doctype html>
            <html lang="en"><body style="margin:0;background:#f4f0e7;color:#171815;font-family:Arial,sans-serif">
              <div style="display:none;max-height:0;overflow:hidden">Fresh reporting on {{digest.Topics.Count}} followed {{(digest.Topics.Count == 1 ? "topic" : "topics")}}.</div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f0e7">
                <tr><td align="center" style="padding:38px 18px">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px">
                    <tr><td style="padding:0 0 24px;border-bottom:2px solid #171815">
                      <p style="margin:0 0 20px;color:#c83f32;font-size:12px;font-weight:700;letter-spacing:.24em">SIGNAL</p>
                      <h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:42px;font-weight:400;line-height:1.05">Your refreshed briefing.</h1>
                      <p style="margin:0;color:#657364;font-size:14px;line-height:1.6">{{digest.Articles.Count}} {{(digest.Articles.Count == 1 ? "story" : "stories")}} gathered {{refreshedAt}}</p>
                    </td></tr>
                    <tr><td style="padding:22px 0 16px">{{topicMarkup}}</td></tr>
                    {{articleMarkup}}
                    <tr><td style="padding:20px 0 8px;border-top:1px solid #d9d2c4;color:#77796f;font-size:12px;line-height:1.6">
                      You receive this briefing because email summaries are enabled in your Signal refresh settings. Turn them off there at any time.
                    </td></tr>
                  </table>
                </td></tr>
              </table>
            </body></html>
            """;
    }

    private async Task SendHtmlAsync(
        string email,
        string subject,
        string body,
        CancellationToken cancellationToken)
    {
        if (gmail.IsConfigured)
        {
            try
            {
                await gmail.SendAsync(email, subject, body, cancellationToken);
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception) when (HasSmtpConfiguration())
            {
                logger.LogWarning(exception, "Gmail API delivery failed; using the configured SMTP fallback.");
            }
        }

        if (_options.Mode.Equals("File", StringComparison.OrdinalIgnoreCase))
        {
            var mailDirectory = Path.Combine(environment.ContentRootPath, "App_Data", "maildrop");
            Directory.CreateDirectory(mailDirectory);
            var fileName = $"{DateTime.UtcNow:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}.html";
            await File.WriteAllTextAsync(
                Path.Combine(mailDirectory, fileName),
                $"To: {email}{Environment.NewLine}Subject: {subject}{Environment.NewLine}{Environment.NewLine}{body}",
                cancellationToken);
            logger.LogInformation("Development account email written to {FileName}", fileName);
            return;
        }

        var fromAddress = string.IsNullOrWhiteSpace(_options.FromAddress) ? _options.Username : _options.FromAddress;
        if (string.IsNullOrWhiteSpace(_options.Username)
            || string.IsNullOrWhiteSpace(_options.AppPassword)
            || string.IsNullOrWhiteSpace(fromAddress))
        {
            throw new InvalidOperationException(
                "SMTP is not configured. Set Smtp__Username, Smtp__AppPassword and Smtp__FromAddress.");
        }

        using var mail = new MailMessage
        {
            From = new MailAddress(fromAddress, _options.FromName),
            Subject = subject,
            Body = body,
            IsBodyHtml = true,
        };
        mail.To.Add(email);

        using var smtp = new SmtpClient(_options.Host, _options.Port)
        {
            EnableSsl = _options.EnableSsl,
            UseDefaultCredentials = false,
            Credentials = new NetworkCredential(_options.Username, _options.AppPassword),
        };
        cancellationToken.ThrowIfCancellationRequested();
        await smtp.SendMailAsync(mail, cancellationToken);
    }

    private bool HasSmtpConfiguration()
    {
        var fromAddress = string.IsNullOrWhiteSpace(_options.FromAddress) ? _options.Username : _options.FromAddress;
        return !_options.Mode.Equals("File", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(_options.Username)
            && !string.IsNullOrWhiteSpace(_options.AppPassword)
            && !string.IsNullOrWhiteSpace(fromAddress);
    }
}
