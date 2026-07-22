using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;

const string GmailSendScope = "https://www.googleapis.com/auth/gmail.send";
const string OAuthAuthorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const string OAuthTokenEndpoint = "https://oauth2.googleapis.com/token";

Console.Title = "Signal Gmail OAuth setup";
Console.WriteLine("Signal Gmail API setup");
Console.WriteLine("======================");
Console.WriteLine();
Console.WriteLine("This opens Google in your browser and stores an encrypted refresh token for IIS.");
Console.WriteLine("Signal never receives your Google password or security key.");
Console.WriteLine();

try
{
    var arguments = ParseArguments(args);
    var credentialsPath = GetRequiredArgument(arguments, "credentials");
    var sitePath = GetRequiredArgument(arguments, "site");
    var sourcePath = GetRequiredArgument(arguments, "source");
    if (!File.Exists(credentialsPath))
        throw new FileNotFoundException("The Google OAuth client file was not found.", credentialsPath);
    if (!Directory.Exists(sitePath))
        throw new DirectoryNotFoundException($"The Signal IIS directory was not found: {sitePath}");
    if (!File.Exists(Path.Combine(sourcePath, "Signal.Server.dll")))
        throw new FileNotFoundException("The validated Signal IIS package was not found.");

    Console.WriteLine("Updating the local IIS site while preserving App_Data...");
    DeployIisPackage(sourcePath, sitePath);

    var client = LoadOAuthClient(credentialsPath);
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
    http.DefaultRequestHeaders.UserAgent.ParseAdd("Signal-News-Monitor/2.0");

    var authorization = await AuthorizeAsync(http, client);
    var email = await GetEmailAsync(http, authorization.AccessToken);
    await SendTestMessageAsync(http, authorization.AccessToken, email);
    SaveEncryptedCredential(sitePath, new GmailOAuthCredential(
        client.ClientId,
        client.ClientSecret,
        authorization.RefreshToken,
        email,
        GmailSendScope));

    Console.ForegroundColor = ConsoleColor.Green;
    Console.WriteLine();
    Console.WriteLine($"Connected Gmail API as {email}.");
    Console.WriteLine("A test message was sent and Signal is ready to deliver account emails.");
    Console.ResetColor();
}
catch (Exception exception)
{
    Console.ForegroundColor = ConsoleColor.Red;
    Console.WriteLine();
    Console.WriteLine("Gmail OAuth setup did not complete.");
    Console.WriteLine(exception.Message);
    Console.ResetColor();
    Environment.ExitCode = 1;
}

Console.WriteLine();
Console.Write("Press Enter to close...");
Console.ReadLine();

static Dictionary<string, string> ParseArguments(string[] values)
{
    var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var index = 0; index + 1 < values.Length; index += 2)
    {
        if (!values[index].StartsWith("--", StringComparison.Ordinal)) continue;
        result[values[index][2..]] = Path.GetFullPath(values[index + 1]);
    }
    return result;
}

static string GetRequiredArgument(IReadOnlyDictionary<string, string> arguments, string name) =>
    arguments.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
        ? value
        : throw new ArgumentException($"Missing required --{name} argument.");

static OAuthClient LoadOAuthClient(string path)
{
    using var document = JsonDocument.Parse(File.ReadAllText(path));
    if (!document.RootElement.TryGetProperty("installed", out var installed))
        throw new InvalidOperationException("Use a Google OAuth client of type Desktop app.");

    var clientId = installed.GetProperty("client_id").GetString();
    var clientSecret = installed.GetProperty("client_secret").GetString();
    if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
        throw new InvalidOperationException("The Google OAuth client file is incomplete.");
    return new OAuthClient(clientId, clientSecret);
}

static void DeployIisPackage(string sourcePath, string sitePath)
{
    var expectedSitePath = Path.GetFullPath(@"C:\inetpub\Signal")
        .TrimEnd(Path.DirectorySeparatorChar);
    var resolvedSitePath = Path.GetFullPath(sitePath)
        .TrimEnd(Path.DirectorySeparatorChar);
    if (!resolvedSitePath.Equals(expectedSitePath, StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("The IIS target must be C:\\inetpub\\Signal.");

    var appCmd = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Windows),
        "System32", "inetsrv", "appcmd.exe");
    if (!File.Exists(appCmd))
        throw new FileNotFoundException("IIS appcmd.exe was not found.", appCmd);

    RunProcess(appCmd, "stop apppool /apppool.name:SignalAppPool", allowAlreadyStopped: true);
    try
    {
        foreach (var sourceFile in Directory.EnumerateFiles(sourcePath, "*", SearchOption.AllDirectories))
        {
            var relativePath = Path.GetRelativePath(sourcePath, sourceFile);
            if (relativePath.Equals("App_Data", StringComparison.OrdinalIgnoreCase)
                || relativePath.StartsWith($"App_Data{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var destinationFile = Path.Combine(sitePath, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(destinationFile)!);
            File.Copy(sourceFile, destinationFile, overwrite: true);
        }
    }
    finally
    {
        RunProcess(appCmd, "start apppool /apppool.name:SignalAppPool", allowAlreadyStopped: false);
    }
}

static void RunProcess(string fileName, string arguments, bool allowAlreadyStopped)
{
    using var process = Process.Start(new ProcessStartInfo(fileName, arguments)
    {
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    }) ?? throw new InvalidOperationException($"Could not start {Path.GetFileName(fileName)}.");
    var output = process.StandardOutput.ReadToEnd();
    var error = process.StandardError.ReadToEnd();
    process.WaitForExit();
    if (process.ExitCode == 0) return;
    if (allowAlreadyStopped && (output.Contains("already been stopped", StringComparison.OrdinalIgnoreCase)
        || error.Contains("already been stopped", StringComparison.OrdinalIgnoreCase))) return;
    throw new InvalidOperationException($"IIS application-pool operation failed ({process.ExitCode}).");
}

static async Task<OAuthAuthorization> AuthorizeAsync(HttpClient http, OAuthClient client)
{
    var port = ReserveLoopbackPort();
    var redirectUri = $"http://localhost:{port}/";
    var state = Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
    var codeVerifier = Base64UrlEncode(RandomNumberGenerator.GetBytes(64));
    var codeChallenge = Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(codeVerifier)));

    using var listener = new HttpListener();
    listener.Prefixes.Add(redirectUri);
    listener.Start();

    var authorizationUrl = BuildUrl(OAuthAuthorizeEndpoint, new Dictionary<string, string>
    {
        ["client_id"] = client.ClientId,
        ["redirect_uri"] = redirectUri,
        ["response_type"] = "code",
        ["scope"] = $"openid email {GmailSendScope}",
        ["access_type"] = "offline",
        ["prompt"] = "consent",
        ["include_granted_scopes"] = "true",
        ["state"] = state,
        ["code_challenge"] = codeChallenge,
        ["code_challenge_method"] = "S256",
    });

    Console.WriteLine("Opening Google authorization in your browser...");
    Process.Start(new ProcessStartInfo(authorizationUrl) { UseShellExecute = true });

    using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(5));
    var context = await listener.GetContextAsync().WaitAsync(timeout.Token);
    var callbackState = context.Request.QueryString["state"] ?? "";
    var code = context.Request.QueryString["code"];
    var oauthError = context.Request.QueryString["error"];
    await WriteBrowserResponseAsync(context.Response, string.IsNullOrWhiteSpace(oauthError));
    listener.Stop();

    if (!FixedTimeEquals(state, callbackState))
        throw new InvalidOperationException("Google returned an invalid OAuth state value.");
    if (!string.IsNullOrWhiteSpace(oauthError))
        throw new InvalidOperationException($"Google authorization was not granted: {oauthError}");
    if (string.IsNullOrWhiteSpace(code))
        throw new InvalidOperationException("Google did not return an authorization code.");

    using var tokenRequest = new HttpRequestMessage(HttpMethod.Post, OAuthTokenEndpoint)
    {
        Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = client.ClientId,
            ["client_secret"] = client.ClientSecret,
            ["code"] = code,
            ["code_verifier"] = codeVerifier,
            ["grant_type"] = "authorization_code",
            ["redirect_uri"] = redirectUri,
        }),
    };
    using var tokenResponse = await http.SendAsync(tokenRequest);
    var tokenBody = await tokenResponse.Content.ReadAsStringAsync();
    if (!tokenResponse.IsSuccessStatusCode)
        throw new InvalidOperationException($"Google token exchange failed ({(int)tokenResponse.StatusCode}).");

    var token = JsonSerializer.Deserialize<OAuthTokenResponse>(tokenBody)
        ?? throw new InvalidOperationException("Google returned an invalid OAuth token response.");
    if (string.IsNullOrWhiteSpace(token.AccessToken) || string.IsNullOrWhiteSpace(token.RefreshToken))
        throw new InvalidOperationException("Google did not return the access and refresh tokens Signal requires.");
    return new OAuthAuthorization(token.AccessToken, token.RefreshToken);
}

static int ReserveLoopbackPort()
{
    var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var port = ((IPEndPoint)listener.LocalEndpoint).Port;
    listener.Stop();
    return port;
}

static async Task WriteBrowserResponseAsync(HttpListenerResponse response, bool success)
{
    var title = success ? "Signal is connected" : "Signal was not connected";
    var message = success
        ? "Google authorization returned to Signal. You can close this tab and return to the setup window."
        : "Google authorization was cancelled or rejected. You can close this tab.";
    var html = $"<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>"
        + $"<body style=\"font-family:system-ui;max-width:680px;margin:10vh auto;padding:32px\"><h1>{title}</h1><p>{message}</p></body></html>";
    var bytes = Encoding.UTF8.GetBytes(html);
    response.ContentType = "text/html; charset=utf-8";
    response.ContentLength64 = bytes.Length;
    await response.OutputStream.WriteAsync(bytes);
    response.Close();
}

static async Task<string> GetEmailAsync(HttpClient http, string accessToken)
{
    using var request = new HttpRequestMessage(HttpMethod.Get, "https://openidconnect.googleapis.com/v1/userinfo");
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
    using var response = await http.SendAsync(request);
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode)
        throw new InvalidOperationException("Google authorized Gmail but did not return the account address.");
    var user = JsonSerializer.Deserialize<GoogleUserInfo>(body);
    return !string.IsNullOrWhiteSpace(user?.Email)
        ? user.Email
        : throw new InvalidOperationException("Google did not return the Gmail address.");
}

static async Task SendTestMessageAsync(HttpClient http, string accessToken, string email)
{
    var body = "<h1>Signal Gmail API connected</h1><p>Signal successfully sent this message through Google OAuth and the Gmail API.</p>";
    var raw = BuildRawMessage(email, email, "Signal Gmail API setup successful", body);
    using var request = new HttpRequestMessage(
        HttpMethod.Post,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
    request.Content = JsonContent.Create(new { raw });
    using var response = await http.SendAsync(request);
    if (!response.IsSuccessStatusCode)
        throw new InvalidOperationException($"Gmail API test message failed ({(int)response.StatusCode}).");
}

static void SaveEncryptedCredential(string sitePath, GmailOAuthCredential credential)
{
    var appDataPath = Path.Combine(sitePath, "App_Data");
    var keyPath = Path.Combine(appDataPath, "DataProtectionKeys");
    Directory.CreateDirectory(appDataPath);
    Directory.CreateDirectory(keyPath);

    var provider = DataProtectionProvider.Create(
        new DirectoryInfo(keyPath),
        configuration =>
        {
            configuration.SetApplicationName("Signal");
            configuration.ProtectKeysWithDpapi(protectToLocalMachine: true);
        });
    var protector = provider.CreateProtector("Signal.GmailOAuth.v1");
    var protectedPayload = protector.Protect(JsonSerializer.Serialize(credential));
    var destination = Path.Combine(appDataPath, "gmail-oauth.dat");
    var temporary = destination + ".tmp";
    File.WriteAllText(temporary, protectedPayload, Encoding.UTF8);
    File.Move(temporary, destination, overwrite: true);
}

static string BuildRawMessage(string sender, string recipient, string subject, string htmlBody)
{
    var encodedSubject = Convert.ToBase64String(Encoding.UTF8.GetBytes(subject));
    var encodedBody = Convert.ToBase64String(Encoding.UTF8.GetBytes(htmlBody));
    var mime = $"From: Signal <{sender}>\r\nTo: <{recipient}>\r\n"
        + $"Subject: =?UTF-8?B?{encodedSubject}?=\r\nMIME-Version: 1.0\r\n"
        + "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        + encodedBody;
    return Base64UrlEncode(Encoding.UTF8.GetBytes(mime));
}

static string BuildUrl(string endpoint, IReadOnlyDictionary<string, string> values) =>
    endpoint + "?" + string.Join("&", values.Select(pair =>
        $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));

static string Base64UrlEncode(byte[] value) =>
    Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

static bool FixedTimeEquals(string expected, string actual)
{
    var expectedBytes = Encoding.UTF8.GetBytes(expected);
    var actualBytes = Encoding.UTF8.GetBytes(actual);
    return expectedBytes.Length == actualBytes.Length
        && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
}

internal sealed record OAuthClient(string ClientId, string ClientSecret);
internal sealed record OAuthAuthorization(string AccessToken, string RefreshToken);
internal sealed record GmailOAuthCredential(
    string ClientId,
    string ClientSecret,
    string RefreshToken,
    string Email,
    string Scope);
internal sealed record OAuthTokenResponse(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("refresh_token")] string RefreshToken);
internal sealed record GoogleUserInfo(
    [property: JsonPropertyName("email")] string Email);
