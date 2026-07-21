using System.Net;
using System.Net.Mail;
using System.Text.Encodings.Web;
using Microsoft.Extensions.Options;

namespace Signal.Server.Services;

public sealed class AccountEmailSender(
    IOptions<SmtpOptions> options,
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
                "Gmail SMTP is not configured. Set Smtp__Username, Smtp__AppPassword and Smtp__FromAddress.");
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
}
