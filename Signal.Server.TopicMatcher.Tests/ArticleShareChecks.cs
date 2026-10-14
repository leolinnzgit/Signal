using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class ArticleShareChecks
{
    public static async Task RunBrowserAsync()
    {
        using var playwright = await Microsoft.Playwright.Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new() { Headless = true, Channel = "msedge" });
        Directory.CreateDirectory("work");
        foreach (var (language, title, text) in new[] {
            ("en", "Researchers reveal a promising advance in clean energy", "Researchers have developed a new way to store renewable energy. Their early experiments suggest it could help homes make better use of solar power after sunset."),
            ("zh-Hans", "研究人员公布清洁能源新突破", "研究人员开发了一种储存可再生能源的新方法。初步实验表明，这项技术可以帮助家庭在日落之后更好地使用太阳能。"),
            ("ar", "باحثون يكشفون عن تقدم واعد في الطاقة النظيفة", "طور الباحثون طريقة جديدة لتخزين الطاقة المتجددة. وتشير تجاربهم الأولية إلى أنها قد تساعد المنازل على الاستفادة بشكل أفضل من الطاقة الشمسية بعد غروب الشمس.")
        })
        foreach (var width in new[] { 390, 1280 })
        {
            var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = 844 } });
            await page.SetContentAsync(SharedArticlePage.Render(new SharedNewsArticle {
                Title = title, Source = "Science news", Byline = "Example Reporter", Language = language,
                OriginalUrl = "https://example.com/clean-energy", ParagraphsJson = JsonSerializer.Serialize(new[] { text, text, text }) }, "/"));
            Require(await page.Locator("h1").InnerTextAsync() == title, "Rendered title changed.");
            Require(await page.Locator(".body p").CountAsync() == 3, "Rendered paragraphs disappeared.");
            Require(await page.EvaluateAsync<bool>("document.documentElement.scrollWidth <= innerWidth"), "Shared page overflows on a phone.");
            if (language == "ar") Require(await page.Locator(".body p").First.EvaluateAsync<string>("el => getComputedStyle(el).direction") == "rtl", "Arabic paragraphs lost their reading direction.");
            await page.ScreenshotAsync(new() { Path = $"work/shared-story-{language}-{width}.png", FullPage = true });
            await page.CloseAsync();
        }
        Console.WriteLine("Hosted pages passed real-browser desktop/phone layout, Chinese text and Arabic direction checks.");
    }

    public static async Task RunAsync()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options;
        await using var database = new SignalDbContext(options);
        await database.Database.EnsureCreatedAsync();
        database.Users.AddRange(new ApplicationUser { Id = "owner", UserName = "owner" },
            new ApplicationUser { Id = "other", UserName = "other" });
        await database.SaveChangesAsync();
        var network = new UnavailableHandler();
        using var client = new HttpClient(network);
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var reader = new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance);
        var controller = CreateController(database, reader, "owner");
        var snapshot = new ArticleSharesController.ArticleSnapshot("中文标题", ["第一段，保留翻译。", "第二段。"], "zh-Hans", "Reporter");
        var request = new ArticleSharesController.CreateShareRequest("https://93.184.216.34/story", "Original title", "Publisher", "Feed summary", snapshot);
        var first = await CreateAsync(controller, request);
        Require(first.GetProperty("language").GetString() == "zh-Hans" && !first.GetProperty("summaryOnly").GetBoolean(), "Translated share metadata was lost.");
        var path = first.GetProperty("path").GetString()!;
        Require(path.StartsWith("/shared/") && path.Length == 56, "Share did not use an opaque public link.");
        Require(network.Calls == 0, "Sharing an existing translation fetched or translated the article again.");
        var repeated = await CreateAsync(controller, request);
        Require(repeated.GetProperty("path").GetString() == path && await database.SharedNewsArticles.CountAsync() == 1, "Identical shares created multiple pages.");
        var french = await CreateAsync(controller, request with { Snapshot = snapshot with { Title = "Titre", Paragraphs = ["Texte français."], Language = "fr" } });
        Require(french.GetProperty("path").GetString() != path, "Different languages reused the same page.");
        var revised = await CreateAsync(controller, request with { Snapshot = snapshot with { Paragraphs = ["新版本。"] } });
        Require(revised.GetProperty("path").GetString() != path, "Changed text overwrote an existing link.");

        // Read in a fresh context, without an authenticated identity or access to the source.
        await using var freshDatabase = new SignalDbContext(options);
        var anonymous = CreateController(freshDatabase, reader, null);
        var page = (ContentResult)await anonymous.Read(path.Split('/').Last(), CancellationToken.None);
        var html = WebUtility.HtmlDecode(page.Content!);
        Require(html.Contains("lang=\"zh-Hans\"") && html.Contains("中文标题") && html.Contains("第一段，保留翻译。") && html.Contains("第二段。"), "Saved translation changed after other versions were shared.");
        Require(html.IndexOf("第一段，保留翻译。", StringComparison.Ordinal) < html.IndexOf("第二段。", StringComparison.Ordinal), "Paragraph order changed.");
        Require(!html.Contains("Feed summary") && !html.Contains("Texte français."), "Unrelated text leaked into the saved translation.");
        Require(anonymous.Response.Headers["X-Robots-Tag"] == "noindex, nofollow", "Shared pages are discoverable by search indexing.");
        Require((await anonymous.Read(new string('a', 48), CancellationToken.None) as ContentResult)?.StatusCode == 404, "Unknown share did not return 404.");
        Require((await anonymous.Read("invalid", CancellationToken.None) as ContentResult)?.StatusCode == 404, "Invalid share did not return 404.");
        Require(await anonymous.Create(request, CancellationToken.None) is UnauthorizedResult, "Anonymous visitors can create public shares.");
        Require(typeof(ArticleSharesController).GetMethod(nameof(ArticleSharesController.Create))!.IsDefined(typeof(AuthorizeAttribute), true)
            && typeof(ArticleSharesController).GetMethod(nameof(ArticleSharesController.Read))!.IsDefined(typeof(AllowAnonymousAttribute), true), "Share authorization is not enforced on HTTP endpoints.");

        foreach (var invalid in new[] {
            request with { Url = "javascript:alert(1)" },
            request with { Snapshot = snapshot with { Language = "zh-Hans\" onload=\"alert(1)" } },
            request with { Snapshot = snapshot with { Paragraphs = [] } },
            request with { Snapshot = snapshot with { Paragraphs = [" "] } },
            request with { Snapshot = snapshot with { Paragraphs = [new string('x', 80_001)] } }
        }) Require(await controller.Create(invalid, CancellationToken.None) is BadRequestObjectResult, "Invalid or oversized public share was accepted.");
        var unsafeText = await CreateAsync(controller, request with { Snapshot = snapshot with {
            Title = "<script>alert(1)</script>", Paragraphs = ["<img src=x onerror=alert(1)>"] } });
        var unsafePage = (ContentResult)await anonymous.Read(unsafeText.GetProperty("path").GetString()!.Split('/').Last(), CancellationToken.None);
        Require(!unsafePage.Content!.Contains("<script>") && !unsafePage.Content.Contains("<img ")
            && unsafePage.Content.Contains("&lt;script&gt;"), "Saved article text injected active HTML.");

        var summary = await CreateAsync(controller, request with { Snapshot = null });
        var summaryPage = (ContentResult)await anonymous.Read(summary.GetProperty("path").GetString()!.Split('/').Last(), CancellationToken.None);
        Require(summary.GetProperty("summaryOnly").GetBoolean() && summaryPage.Content!.Contains("Headline and feed summary")
            && summaryPage.Content.Contains("Feed summary") && summaryPage.Content.Contains("https://93.184.216.34/story"), "Unavailable full text did not save a clearly labelled feed summary.");
        const string fullArticleUrl = "https://93.184.216.34/full-story";
        cache.Set("article-reader:" + fullArticleUrl, new ArticleReaderResult(true, "", new ReaderArticle(
            "https://93.184.216.34/resolved-story", "Original reporter", "Publisher", "", ["Full original article text."])), TimeSpan.FromMinutes(1));
        var full = await CreateAsync(controller, request with { Url = fullArticleUrl, Snapshot = null });
        var fullPage = (ContentResult)await anonymous.Read(full.GetProperty("path").GetString()!.Split('/').Last(), CancellationToken.None);
        Require(!full.GetProperty("summaryOnly").GetBoolean() && fullPage.Content!.Contains("Full original article text.")
            && fullPage.Content.Contains("https://93.184.216.34/resolved-story") && !fullPage.Content.Contains("Feed summary"), "Original share did not save the full reader text and resolved publisher link.");
        var other = await CreateAsync(CreateController(database, reader, "other"), request);
        Require(other.GetProperty("path").GetString() != path, "Different users shared ownership of a page.");
        Console.WriteLine("Hosted article sharing passed persisted translations, immutable versions, deduplication, anonymous reading, authorization, text escaping, input limits and summary fallback checks.");
    }

    private static ArticleSharesController CreateController(SignalDbContext database, ArticleReaderService reader, string? userId) => new(database, reader, NullLogger<ArticleSharesController>.Instance)
    {
        ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
            User = userId is null ? new ClaimsPrincipal() : new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, userId)], "test")) } }
    };
    private static async Task<JsonElement> CreateAsync(ArticleSharesController controller, ArticleSharesController.CreateShareRequest request)
    {
        var result = await controller.Create(request, CancellationToken.None);
        Require(result is OkObjectResult, "Creating a valid share failed.");
        return JsonSerializer.SerializeToElement(((OkObjectResult)result).Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    }
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private sealed class UnavailableHandler : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Calls++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
        }
    }
}
