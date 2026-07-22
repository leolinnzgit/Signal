using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace Signal.Server.Services;

public sealed class GmailOAuthStore
{
    public const string ProtectorPurpose = "Signal.GmailOAuth.v1";
    public const string FileName = "gmail-oauth.dat";

    private readonly string _credentialPath;
    private readonly IDataProtector _protector;
    private readonly ILogger<GmailOAuthStore> _logger;

    public GmailOAuthStore(
        IDataProtectionProvider dataProtectionProvider,
        IWebHostEnvironment environment,
        ILogger<GmailOAuthStore> logger)
    {
        _credentialPath = Path.Combine(environment.ContentRootPath, "App_Data", FileName);
        _protector = dataProtectionProvider.CreateProtector(ProtectorPurpose);
        _logger = logger;
    }

    public bool IsConfigured => File.Exists(_credentialPath);

    public GmailOAuthCredential? Load()
    {
        if (!File.Exists(_credentialPath)) return null;

        try
        {
            var protectedPayload = File.ReadAllText(_credentialPath);
            var json = _protector.Unprotect(protectedPayload);
            var credential = JsonSerializer.Deserialize<GmailOAuthCredential>(json);
            return IsValid(credential) ? credential : null;
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "The encrypted Gmail OAuth credential could not be loaded.");
            return null;
        }
    }

    private static bool IsValid(GmailOAuthCredential? credential) =>
        credential is not null
        && !string.IsNullOrWhiteSpace(credential.ClientId)
        && !string.IsNullOrWhiteSpace(credential.ClientSecret)
        && !string.IsNullOrWhiteSpace(credential.RefreshToken)
        && !string.IsNullOrWhiteSpace(credential.Email);
}

