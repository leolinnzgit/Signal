using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Signal.Server.Controllers;
using Signal.Server.Data;
using Signal.Server.Models;
using Signal.Server.Services;

internal static class SharedCommentChecks
{
    public static async Task RunAsync()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options;
        await using var database = new SignalDbContext(options);
        await database.Database.EnsureCreatedAsync();
        database.Users.Add(new ApplicationUser { Id = "owner", UserName = "private@example.test" });
        await database.SaveChangesAsync();
        // Recreate the production schema from before anonymous comments, including a deleted high ID.
        await database.Database.ExecuteSqlRawAsync("""
            ALTER TABLE SharedNewsArticles DROP COLUMN DiscussionUrl;
            DROP TABLE NewsComments;
            CREATE TABLE NewsComments (
                Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ArticleUrl TEXT NOT NULL,
                ArticleTitle TEXT NOT NULL, UserId TEXT NOT NULL, Body TEXT NOT NULL, CreatedAtUtc TEXT NOT NULL,
                FOREIGN KEY (UserId) REFERENCES AspNetUsers (Id) ON DELETE CASCADE);
            INSERT INTO NewsComments VALUES (7, 'https://example.test/feed-story', 'Story', 'owner', 'Existing comment', '2026-10-16 00:00:00');
            INSERT INTO NewsComments VALUES (70, 'https://example.test/feed-story', 'Story', 'owner', 'Deleted comment', '2026-10-16 00:00:00');
            DELETE FROM NewsComments WHERE Id = 70;
            """);
        await AnonymousCommentSchema.UpgradeAsync(database);
        await AnonymousCommentSchema.UpgradeAsync(database);
        var preserved = await database.NewsComments.Include(item => item.User).SingleAsync();
        Require(preserved.Id == 7 && preserved.UserId == "owner" && preserved.User!.UserName == "private@example.test"
            && preserved.Body == "Existing comment", "Schema upgrade lost an existing comment or its author.");
        var share = new SharedNewsArticle { Id = new string('a', 48), UserId = "owner", ContentHash = "a",
            OriginalUrl = "https://publisher.test/resolved-story", DiscussionUrl = "https://example.test/feed-story", Title = "Story" };
        var otherVersion = new SharedNewsArticle { Id = new string('b', 48), UserId = "owner", ContentHash = "b",
            OriginalUrl = share.OriginalUrl, DiscussionUrl = share.DiscussionUrl, Title = "Translated story", Language = "fr" };
        database.SharedNewsArticles.AddRange(share, otherVersion);
        await database.SaveChangesAsync();
        var controller = new SharedCommentsController(database);
        Require(await controller.Create("missing", new("Hello"), default) is NotFoundResult, "Unknown shares accepted comments.");
        Require(await controller.Get(new string('f', 48)) is NotFoundResult, "Unknown shares exposed a discussion.");
        foreach (var body in new[] { "", "  ", new string('x', 2001) })
            Require(await controller.Create(share.Id, new(body), default) is BadRequestObjectResult, "Invalid comment accepted.");
        var created = ((OkObjectResult)await controller.Create(share.Id, new("  Anonymous <script>alert(1)</script>  "), default)).Value as SharedCommentsController.PublicComment;
        Require(created is { Id: > 70, Author: "Anonymous" } && created.Body.StartsWith("Anonymous <script>"), "Anonymous comment or sequence was not saved correctly.");
        var stored = await database.NewsComments.SingleAsync(item => item.Id == created!.Id);
        Require(stored.UserId is null && stored.ArticleUrl == share.DiscussionUrl, "Anonymous comment has account ownership or wrong news link.");
        var publicPage = (SharedCommentsController.PublicCommentPage)((OkObjectResult)await controller.Get(otherVersion.Id)).Value!;
        Require(publicPage.Total == 2 && publicPage.Comments.All(item => item.Author == "Anonymous"), "Share versions do not use the same anonymous discussion.");
        var publicJson = JsonSerializer.Serialize(publicPage);
        Require(!publicJson.Contains("private@example.test") && !publicJson.Contains("UserId") && !publicJson.Contains("Photo"), "Public discussion leaked account details.");

        var services = new ServiceCollection().AddLogging().AddSingleton(database);
        services.AddIdentityCore<ApplicationUser>().AddEntityFrameworkStores<SignalDbContext>();
        using var provider = services.BuildServiceProvider();
        var comments = new CommentsController(database, provider.GetRequiredService<UserManager<ApplicationUser>>()) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "owner")], "test")) } } };
        var newsPage = (CommentPageResponse)((OkObjectResult)await comments.Get(share.DiscussionUrl)).Value!;
        var anonymous = newsPage.Comments.Single(item => item.Id == created!.Id);
        Require(anonymous.Author.Name == "Anonymous" && anonymous.Author.UserId == "" && anonymous.Author.ProfilePhotoUrl == ""
            && !anonymous.CanDelete && anonymous.FriendshipState == "anonymous", "News view did not correctly show anonymous comment.");
        Require(newsPage.Comments.Single(item => item.Id == 7).CanDelete, "Existing author lost comment ownership.");
        var latest = (LatestCommentsResponse)((OkObjectResult)await comments.GetLatest(afterId: 70)).Value!;
        Require(latest.NewCount == 1 && latest.Comments.Any(item => item.Id == created!.Id), "Anonymous activity missing from latest comments or unread count.");
        Require(await comments.Delete(created!.Id, default) is ForbidResult
            && await comments.Update(created.Id, new("Changed"), default) is ForbidResult, "A reader can edit/delete an anonymous visitor's comment.");
        for (var index = 0; index < 55; index++) await controller.Create(share.Id, new($"Comment {index}"), default);
        publicPage = (SharedCommentsController.PublicCommentPage)((OkObjectResult)await controller.Get(share.Id)).Value!;
        Require(publicPage.Total == 57 && publicPage.Comments.Length == 50 && publicPage.HasMore, "Public comments are not bounded or paginated.");
        var older = (SharedCommentsController.PublicCommentPage)((OkObjectResult)await controller.Get(share.Id, publicPage.Comments[0].Id)).Value!;
        Require(older.Comments.Length == 7 && !older.HasMore && !older.Comments.Any(item => publicPage.Comments.Any(next => next.Id == item.Id)), "Older comments overlap or disappear.");
        // Existing shared links have no stored feed URL and continue using their original URL.
        otherVersion.DiscussionUrl = "";
        await database.SaveChangesAsync();
        var legacy = (SharedCommentsController.PublicComment)((OkObjectResult)await controller.Create(otherVersion.Id, new("Legacy link"), default)).Value!;
        Require((await database.NewsComments.FindAsync(legacy.Id))!.ArticleUrl == share.OriginalUrl, "Existing shared link cannot accept comments.");
        Require(await database.Database.SqlQueryRaw<long>("SELECT COUNT(*) AS Value FROM pragma_foreign_key_check").SingleAsync() == 0, "Upgrade damaged foreign keys.");
        Console.WriteLine("Shared comments passed legacy schema upgrade, preserved IDs/authors, anonymous posting, URL linkage, news/latest views, privacy, ownership, validation and pagination.");
    }

    public static async Task RunBrowserAsync()
    {
        using var playwright = await Microsoft.Playwright.Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new() { Headless = true, Channel = "msedge" });
        var script = await File.ReadAllTextAsync("public/shared-story-comments.js");
        foreach (var width in new[] { 390, 1280 })
        {
            var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = 900 } });
            var html = SharedArticlePage.Render(new() { Id = new string('a', 48), Title = "A shared news story", Source = "Publisher",
                OriginalUrl = "https://example.test/story", ParagraphsJson = "[\"The saved article appears above its discussion.\"]" }, "/signal/");
            var comments = new List<object>();
            var fail = false;
            await page.RouteAsync("https://shared.example.test/**", async route => {
                var path = new Uri(route.Request.Url).AbsolutePath;
                if (path.EndsWith("shared-story-comments.js")) await route.FulfillAsync(new() { ContentType = "text/javascript", Body = script });
                else if (path.EndsWith("/api/auth/csrf")) await route.FulfillAsync(new() { ContentType = "application/json", Body = "{\"token\":\"test-token\"}" });
                else if (path.EndsWith("/comments"))
                {
                    if (route.Request.Method == "POST")
                    {
                        Require(route.Request.Headers.GetValueOrDefault("x-xsrf-token") == "test-token", "Anonymous form omitted CSRF token.");
                        if (fail) { await route.FulfillAsync(new() { Status = 429 }); return; }
                        var body = JsonDocument.Parse(route.Request.PostData!).RootElement.GetProperty("body").GetString();
                        var comment = new { id = comments.Count + 1, body, createdAt = "2026-10-16T00:00:00Z", author = "Anonymous" };
                        comments.Add(comment);
                        await route.FulfillAsync(new() { ContentType = "application/json", Body = JsonSerializer.Serialize(comment) });
                    }
                    else await route.FulfillAsync(new() { ContentType = "application/json", Body = JsonSerializer.Serialize(new { comments, total = comments.Count, hasMore = false }) });
                }
                else if (path.Contains("/shared/")) await route.FulfillAsync(new() { ContentType = "text/html", Body = html,
                    Headers = new Dictionary<string, string> { ["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'" } });
                else await route.FulfillAsync(new() { ContentType = "text/javascript", Body = "" });
            });
            await page.GotoAsync("https://shared.example.test/signal/shared/" + new string('a', 48));
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#comment-submit")).ToBeEnabledAsync();
            await page.Locator("#comment-body").FillAsync("Anonymous <img src=x onerror=alert(1)>\nSecond line.");
            await page.Locator("#comment-submit").ClickAsync();
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#comment-status")).ToContainTextAsync("Comment posted anonymously");
            Require(await page.Locator("#comment-list li").CountAsync() == 1 && await page.Locator("#comment-list img").CountAsync() == 0, "Comment was not shown safely as text.");
            Require(await page.Locator("#comment-body").InputValueAsync() == "", "Successful submission did not clear draft.");
            await page.ReloadAsync();
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#comment-list li")).ToHaveCountAsync(1);
            fail = true;
            await page.Locator("#comment-body").FillAsync("Keep this draft");
            await page.Locator("#comment-submit").ClickAsync();
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#comment-status")).ToContainTextAsync("wait a minute");
            Require(await page.Locator("#comment-body").InputValueAsync() == "Keep this draft", "Failed submission lost the draft.");
            Require(await page.EvaluateAsync<bool>("document.documentElement.scrollWidth <= innerWidth"), "Comments overflow on mobile.");
            await page.Locator("#story-comments").ScreenshotAsync(new() { Path = $"work/shared-comments-{width}.png" });
            await page.CloseAsync();
        }
        Console.WriteLine("Shared comment browser checks passed mobile/desktop submission, CSP, CSRF, text escaping, reload persistence, error recovery and layout.");
    }

    private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
}
