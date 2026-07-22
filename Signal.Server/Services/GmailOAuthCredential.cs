namespace Signal.Server.Services;

public sealed record GmailOAuthCredential(
    string ClientId,
    string ClientSecret,
    string RefreshToken,
    string Email,
    string Scope);

