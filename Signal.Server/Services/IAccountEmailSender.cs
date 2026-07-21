namespace Signal.Server.Services;

public interface IAccountEmailSender
{
    Task SendConfirmationAsync(string email, string confirmationUrl, CancellationToken cancellationToken);
    Task SendPasswordResetAsync(string email, string resetUrl, CancellationToken cancellationToken);
}
