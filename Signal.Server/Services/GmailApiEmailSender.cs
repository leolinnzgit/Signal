using System.Net.Http.Headers;
using System.Net.Mail;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Signal.Server.Services;

public sealed class GmailApiEmailSender(
    GmailOAuthStore credentialStore,
    IHttpClientFactory httpClientFactory,
    ILogger<GmailApiEmailSender> logger)
{
    private readonly SemaphoreSlim _tokenLock = new(1, 1);
    private string? _accessToken;
    private DateTimeOffset _accessTokenExpiresAt;

    public bool IsConfigured => credentialStore.IsConfigured && credentialStore.Load() is not null;

    public string? ConnectedEmail => credentialStore.Load()?.Email;

    public async Task SendAsync(
        string recipient,
        string subject,
        string htmlBody,
        CancellationToken cancellationToken)
    {
        var credential = credentialStore.Load()
            ?? throw new InvalidOperationException("Gmail OAuth has not been connected for Signal.");
        var accessToken = await GetAccessTokenAsync(credential, cancellationToken);
        var rawMessage = BuildRawMessage(credential.Email, recipient, subject, htmlBody);

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Content = JsonContent.Create(new { raw = rawMessage });

        using var response = await httpClientFactory.CreateClient(nameof(GmailApiEmailSender))
            .SendAsync(request, cancellationToken);
        if (response.IsSuccessStatusCode) return;

        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
        logger.LogError(
            "Gmail API send failed with status {StatusCode}: {ResponseBody}",
            (int)response.StatusCode,
            responseBody);
        throw new InvalidOperationException("Gmail API could not deliver the account email.");
    }

    private async Task<string> GetAccessTokenAsync(
        GmailOAuthCredential credential,
        CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(_accessToken)
            && _accessTokenExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2))
        {
            return _accessToken;
        }

        await _tokenLock.WaitAsync(cancellationToken);
        try
        {
            if (!string.IsNullOrWhiteSpace(_accessToken)
                && _accessTokenExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2))
            {
                return _accessToken;
            }

            using var request = new HttpRequestMessage(HttpMethod.Post, "https://oauth2.googleapis.com/token")
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = credential.ClientId,
                    ["client_secret"] = credential.ClientSecret,
                    ["refresh_token"] = credential.RefreshToken,
                    ["grant_type"] = "refresh_token",
                }),
            };
            using var response = await httpClientFactory.CreateClient(nameof(GmailApiEmailSender))
                .SendAsync(request, cancellationToken);
            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogError(
                    "Gmail OAuth token refresh failed with status {StatusCode}: {ResponseBody}",
                    (int)response.StatusCode,
                    responseBody);
                throw new InvalidOperationException("The Gmail connection has expired or was revoked.");
            }

            var token = JsonSerializer.Deserialize<OAuthTokenResponse>(responseBody)
                ?? throw new InvalidOperationException("Google returned an invalid OAuth token response.");
            if (string.IsNullOrWhiteSpace(token.AccessToken))
                throw new InvalidOperationException("Google did not return a Gmail access token.");

            _accessToken = token.AccessToken;
            _accessTokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, token.ExpiresIn));
            return _accessToken;
        }
        finally
        {
            _tokenLock.Release();
        }
    }

    internal static string BuildRawMessage(
        string sender,
        string recipient,
        string subject,
        string htmlBody)
    {
        _ = new MailAddress(sender);
        _ = new MailAddress(recipient);
        if (subject.Contains('\r') || subject.Contains('\n'))
            throw new ArgumentException("Email subjects cannot contain line breaks.", nameof(subject));

        var encodedSubject = Convert.ToBase64String(Encoding.UTF8.GetBytes(subject));
        var encodedBody = Convert.ToBase64String(Encoding.UTF8.GetBytes(htmlBody));
        var mime = $"From: Signal <{sender}>\r\n"
            + $"To: <{recipient}>\r\n"
            + $"Subject: =?UTF-8?B?{encodedSubject}?=\r\n"
            + "MIME-Version: 1.0\r\n"
            + "Content-Type: text/html; charset=UTF-8\r\n"
            + "Content-Transfer-Encoding: base64\r\n\r\n"
            + encodedBody;
        return Base64UrlEncode(Encoding.UTF8.GetBytes(mime));
    }

    private static string Base64UrlEncode(byte[] value) =>
        Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed record OAuthTokenResponse(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);
}

