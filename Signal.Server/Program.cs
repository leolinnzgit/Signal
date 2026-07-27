using System.IO;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

var builder = WebApplication.CreateBuilder(args);

var dataDirectory = Path.Combine(builder.Environment.ContentRootPath, "App_Data");
Directory.CreateDirectory(dataDirectory);
var defaultConnection = $"Data Source={Path.Combine(dataDirectory, "signal.db")}";
var connectionString = builder.Configuration.GetConnectionString("SignalDb") ?? defaultConnection;
var keyDirectory = Path.Combine(dataDirectory, "DataProtectionKeys");
Directory.CreateDirectory(keyDirectory);

builder.Services.AddDbContext<SignalDbContext>(options => options.UseSqlite(connectionString));
var dataProtection = builder.Services
    .AddDataProtection()
    .SetApplicationName("Signal")
    .PersistKeysToFileSystem(new DirectoryInfo(keyDirectory));
if (OperatingSystem.IsWindows()) dataProtection.ProtectKeysWithDpapi(protectToLocalMachine: true);
builder.Services
    .AddIdentity<ApplicationUser, IdentityRole>(options =>
    {
        options.SignIn.RequireConfirmedEmail = true;
        options.User.RequireUniqueEmail = true;
        options.Password.RequiredLength = 12;
        options.Password.RequireDigit = true;
        options.Password.RequireLowercase = true;
        options.Password.RequireUppercase = true;
        options.Password.RequireNonAlphanumeric = true;
        options.Lockout.AllowedForNewUsers = true;
        options.Lockout.MaxFailedAccessAttempts = 5;
        options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
    })
    .AddEntityFrameworkStores<SignalDbContext>()
    .AddDefaultTokenProviders();

builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.Name = builder.Environment.IsDevelopment() ? "Signal.Auth" : "__Host-Signal.Auth";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
        ? CookieSecurePolicy.SameAsRequest
        : CookieSecurePolicy.Always;
    options.ExpireTimeSpan = TimeSpan.FromDays(14);
    options.SlidingExpiration = true;
    options.Events = new CookieAuthenticationEvents
    {
        OnRedirectToLogin = context =>
        {
            if (context.Request.Path.StartsWithSegments("/api"))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return Task.CompletedTask;
            }
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        },
        OnRedirectToAccessDenied = context =>
        {
            if (context.Request.Path.StartsWithSegments("/api"))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            }
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        },
    };
});

builder.Services.Configure<DataProtectionTokenProviderOptions>(options =>
    options.TokenLifespan = TimeSpan.FromHours(2));
builder.Services.AddAntiforgery(options =>
{
    options.HeaderName = "X-XSRF-TOKEN";
    options.Cookie.Name = builder.Environment.IsDevelopment()
        ? "Signal.Antiforgery"
        : "__Host-Signal.Antiforgery";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
        ? CookieSecurePolicy.SameAsRequest
        : CookieSecurePolicy.Always;
});
builder.Services.AddControllersWithViews(options =>
    options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute()));
builder.Services.AddAuthorization();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("account", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 30,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true,
        }));
});
builder.Services.AddMemoryCache();
builder.Services.Configure<SmtpOptions>(builder.Configuration.GetSection(SmtpOptions.SectionName));
builder.Services.Configure<MarketDataOptions>(builder.Configuration.GetSection(MarketDataOptions.SectionName));
builder.Services.AddSingleton<GmailOAuthStore>();
builder.Services.AddSingleton<GmailApiEmailSender>();
builder.Services.AddScoped<IAccountEmailSender, AccountEmailSender>();
builder.Services.AddHttpClient(nameof(GmailApiEmailSender), client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("Signal-News-Monitor/2.0");
});
builder.Services.AddHttpClient<NewsService>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(20);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("Signal-News-Monitor/2.0");
}).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
{
    AllowAutoRedirect = false,
    AutomaticDecompression = System.Net.DecompressionMethods.All,
});
builder.Services.AddHttpClient<GoogleTrendsService>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(15);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("Signal-News-Monitor/2.0");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/rss+xml, application/xml;q=0.9");
});
builder.Services.AddHttpClient<MarketDataService>(client =>
{
    client.BaseAddress = new Uri("https://api.twelvedata.com/");
    client.Timeout = TimeSpan.FromSeconds(15);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("Signal-News-Monitor/2.0");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
});
builder.Services.AddHttpClient<ArticleReaderService>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(20);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (compatible; SignalReader/2.0; +https://github.com/leolinnzgit/Signal)");
}).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
{
    AllowAutoRedirect = false,
    AutomaticDecompression = System.Net.DecompressionMethods.All,
});
builder.Services.AddScoped<TopicRefreshService>();
builder.Services.AddHostedService<TopicRefreshBackgroundService>();

var app = builder.Build();

app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
});
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        if (context.Request.Path == "/" || context.Request.Path == "/index.html")
            context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        return Task.CompletedTask;
    });
    await next();
});

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/error");
    app.UseHsts();
    app.UseHttpsRedirection();
}

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.MapControllers();
app.MapFallbackToFile("index.html");

await using (var scope = app.Services.CreateAsyncScope())
{
    var database = scope.ServiceProvider.GetRequiredService<SignalDbContext>();
    await database.Database.EnsureCreatedAsync();
    // EnsureCreated does not add new tables to an existing Identity database.
    await database.Database.ExecuteSqlRawAsync("""
        CREATE TABLE IF NOT EXISTS "UserNewsPreferences" (
            "UserId" TEXT NOT NULL CONSTRAINT "PK_UserNewsPreferences" PRIMARY KEY,
            "TopicsJson" TEXT NOT NULL,
            "StoryLimit" INTEGER NOT NULL,
            "StoryTitleSize" TEXT NOT NULL DEFAULT 'large',
            "RefreshMinutes" INTEGER NOT NULL,
            "EmailSummaryEnabled" INTEGER NOT NULL DEFAULT 0,
            "ArticleRetentionDays" INTEGER NOT NULL DEFAULT 30,
            "GoogleEnabled" INTEGER NOT NULL,
            "GdeltEnabled" INTEGER NOT NULL,
            "RssFeedsJson" TEXT NOT NULL,
            "UpdatedAtUtc" TEXT NOT NULL,
            CONSTRAINT "FK_UserNewsPreferences_AspNetUsers_UserId"
                FOREIGN KEY ("UserId") REFERENCES "AspNetUsers" ("Id") ON DELETE CASCADE
        );
        """);
    await database.Database.ExecuteSqlRawAsync("""
        CREATE TABLE IF NOT EXISTS "StoredNewsArticles" (
            "Id" INTEGER NOT NULL CONSTRAINT "PK_StoredNewsArticles" PRIMARY KEY AUTOINCREMENT,
            "UserId" TEXT NOT NULL,
            "Url" TEXT NOT NULL,
            "Title" TEXT NOT NULL,
            "Source" TEXT NOT NULL,
            "PublishedAtUtc" TEXT NOT NULL,
            "Summary" TEXT NOT NULL,
            "TopicsJson" TEXT NOT NULL,
            "ProvidersJson" TEXT NOT NULL,
            "FirstSeenAtUtc" TEXT NOT NULL,
            "LastSeenAtUtc" TEXT NOT NULL,
            "IsBookmarked" INTEGER NOT NULL DEFAULT 0,
            "BookmarkedAtUtc" TEXT NULL,
            CONSTRAINT "FK_StoredNewsArticles_AspNetUsers_UserId"
                FOREIGN KEY ("UserId") REFERENCES "AspNetUsers" ("Id") ON DELETE CASCADE
        );
        """);
    await database.Database.ExecuteSqlRawAsync(
        "CREATE UNIQUE INDEX IF NOT EXISTS \"IX_StoredNewsArticles_UserId_Url\" ON \"StoredNewsArticles\" (\"UserId\", \"Url\");");
    await database.Database.ExecuteSqlRawAsync(
        "CREATE INDEX IF NOT EXISTS \"IX_StoredNewsArticles_UserId_IsBookmarked_LastSeenAtUtc\" ON \"StoredNewsArticles\" (\"UserId\", \"IsBookmarked\", \"LastSeenAtUtc\");");
    await database.Database.ExecuteSqlRawAsync("""
        CREATE TABLE IF NOT EXISTS "TopicRefreshStates" (
            "UserId" TEXT NOT NULL,
            "TopicKey" TEXT NOT NULL,
            "Topic" TEXT NOT NULL,
            "LastAttemptedAtUtc" TEXT NULL,
            "LastSuccessfulAtUtc" TEXT NULL,
            "NextRefreshAtUtc" TEXT NULL,
            "LastError" TEXT NOT NULL DEFAULT '',
            CONSTRAINT "PK_TopicRefreshStates" PRIMARY KEY ("UserId", "TopicKey"),
            CONSTRAINT "FK_TopicRefreshStates_AspNetUsers_UserId"
                FOREIGN KEY ("UserId") REFERENCES "AspNetUsers" ("Id") ON DELETE CASCADE
        );
        """);
    await database.Database.ExecuteSqlRawAsync(
        "CREATE INDEX IF NOT EXISTS \"IX_TopicRefreshStates_NextRefreshAtUtc\" ON \"TopicRefreshStates\" (\"NextRefreshAtUtc\");");

    var existingPreferences = await database.UserNewsPreferences.AsNoTracking().ToArrayAsync();
    var existingStateKeys = await database.TopicRefreshStates
        .AsNoTracking()
        .Select(item => new { item.UserId, item.TopicKey })
        .ToArrayAsync();
    var knownStates = existingStateKeys
        .Select(item => $"{item.UserId}\n{item.TopicKey}")
        .ToHashSet(StringComparer.Ordinal);
    var scheduleCreatedAt = DateTime.UtcNow;
    foreach (var preferences in existingPreferences)
    {
        string[] topics;
        try { topics = JsonSerializer.Deserialize<string[]>(preferences.TopicsJson) ?? []; }
        catch (JsonException) { topics = []; }
        foreach (var topic in topics)
        {
            var key = TopicRefreshService.NormalizeTopicKey(topic);
            if (!knownStates.Add($"{preferences.UserId}\n{key}")) continue;
            database.TopicRefreshStates.Add(new TopicRefreshState
            {
                UserId = preferences.UserId,
                TopicKey = key,
                Topic = topic,
                NextRefreshAtUtc = preferences.RefreshMinutes == 0 ? null : scheduleCreatedAt,
            });
        }
    }
    await database.SaveChangesAsync();

    await database.Database.OpenConnectionAsync();
    try
    {
        await using var columnCheck = database.Database.GetDbConnection().CreateCommand();
        columnCheck.CommandText = "SELECT COUNT(*) FROM pragma_table_info('UserNewsPreferences') WHERE name = 'EmailSummaryEnabled';";
        var emailSummaryColumnExists = Convert.ToInt32(await columnCheck.ExecuteScalarAsync()) > 0;
        if (!emailSummaryColumnExists)
        {
            await database.Database.ExecuteSqlRawAsync(
                "ALTER TABLE \"UserNewsPreferences\" ADD COLUMN \"EmailSummaryEnabled\" INTEGER NOT NULL DEFAULT 0;");
        }

        columnCheck.CommandText = "SELECT COUNT(*) FROM pragma_table_info('UserNewsPreferences') WHERE name = 'ArticleRetentionDays';";
        var retentionColumnExists = Convert.ToInt32(await columnCheck.ExecuteScalarAsync()) > 0;
        if (!retentionColumnExists)
        {
            await database.Database.ExecuteSqlRawAsync(
                "ALTER TABLE \"UserNewsPreferences\" ADD COLUMN \"ArticleRetentionDays\" INTEGER NOT NULL DEFAULT 30;");
        }

        columnCheck.CommandText = "SELECT COUNT(*) FROM pragma_table_info('UserNewsPreferences') WHERE name = 'StoryTitleSize';";
        var storyTitleSizeColumnExists = Convert.ToInt32(await columnCheck.ExecuteScalarAsync()) > 0;
        if (!storyTitleSizeColumnExists)
        {
            await database.Database.ExecuteSqlRawAsync(
                "ALTER TABLE \"UserNewsPreferences\" ADD COLUMN \"StoryTitleSize\" TEXT NOT NULL DEFAULT 'large';");
        }
    }
    finally
    {
        await database.Database.CloseConnectionAsync();
    }
}

await app.RunAsync();

public partial class Program;
