namespace Signal.Server.Services;

public sealed class SmtpOptions
{
    public const string SectionName = "Smtp";

    public string Mode { get; set; } = "Smtp";
    public string Host { get; set; } = "smtp.gmail.com";
    public int Port { get; set; } = 587;
    public bool EnableSsl { get; set; } = true;
    public string Username { get; set; } = "";
    public string AppPassword { get; set; } = "";
    public string FromAddress { get; set; } = "";
    public string FromName { get; set; } = "Signal";
}
