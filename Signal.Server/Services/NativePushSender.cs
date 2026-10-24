using FirebaseAdmin;
using FirebaseAdmin.Messaging;
using Google.Apis.Auth.OAuth2;

namespace Signal.Server.Services;

public enum NativePushResult { Delivered, Unregistered, Unavailable }

public interface INativePushSender
{
    bool Ready { get; }
    Task<NativePushResult> SendAsync(string token, IReadOnlyDictionary<string, string> data, CancellationToken ct);
}

/// <summary>Credentials stay on the server; only public Firebase Android options reach installations.</summary>
public sealed class NativePushSender(IConfiguration configuration, ILogger<NativePushSender> logger) : INativePushSender, IDisposable
{
    private FirebaseApp? app;
    private readonly object gate = new();
    public bool Ready => new[] { "ProjectId", "ApplicationId", "ApiKey", "SenderId", "ServiceAccountFile" }
        .All(key => !string.IsNullOrWhiteSpace(configuration[$"NativePush:{key}"]))
        && File.Exists(configuration["NativePush:ServiceAccountFile"]);

    public async Task<NativePushResult> SendAsync(string token, IReadOnlyDictionary<string, string> data, CancellationToken ct)
    {
        if (!Ready) return NativePushResult.Unavailable;
        try
        {
            lock (gate)
            {
                app ??= FirebaseApp.Create(new AppOptions {
                    ProjectId = configuration["NativePush:ProjectId"],
                    Credential = CredentialFactory.FromFile<ServiceAccountCredential>(configuration["NativePush:ServiceAccountFile"]).ToGoogleCredential(),
                }, "signal-notifications");
            }
            await FirebaseMessaging.GetMessaging(app).SendAsync(new Message {
                Token = token, Data = data,
                Android = new AndroidConfig { Priority = Priority.High, TimeToLive = TimeSpan.FromHours(1) },
            }, ct);
            return NativePushResult.Delivered;
        }
        catch (FirebaseMessagingException error) when (error.MessagingErrorCode == MessagingErrorCode.Unregistered)
        { return NativePushResult.Unregistered; }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception error)
        {
            // Do not log tokens, payloads, endpoint URLs or credential contents.
            logger.LogWarning("Native push delivery unavailable ({ErrorType}); browser delivery remains enabled.", error.GetType().Name);
            return NativePushResult.Unavailable;
        }
    }
    public void Dispose() { app?.Delete(); }
}
