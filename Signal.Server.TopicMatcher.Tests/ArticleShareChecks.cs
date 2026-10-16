using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
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
        var audioScript = await File.ReadAllTextAsync("public/shared-story-audio.js");
        var pcm = new byte[64_000];
        for (var sample = 0; sample < pcm.Length / 2; sample++)
            BitConverter.TryWriteBytes(pcm.AsSpan(sample * 2, 2), (short)(Math.Sin(sample * Math.PI * 440 / 8000) * 8000));
        var wave = RecordedNarration.Assemble([pcm], 3).Wave;
        foreach (var (language, title, text) in new[] {
            ("en", "Researchers reveal a promising advance in clean energy", "Researchers have developed a new way to store renewable energy. Their early experiments suggest it could help homes make better use of solar power after sunset."),
            ("zh-Hans", "研究人员公布清洁能源新突破", "研究人员开发了一种储存可再生能源的新方法。初步实验表明，这项技术可以帮助家庭在日落之后更好地使用太阳能。"),
            ("ar", "باحثون يكشفون عن تقدم واعد في الطاقة النظيفة", "طور الباحثون طريقة جديدة لتخزين الطاقة المتجددة. وتشير تجاربهم الأولية إلى أنها قد تساعد المنازل على الاستفادة بشكل أفضل من الطاقة الشمسية بعد غروب الشمس.")
        })
        foreach (var width in new[] { 390, 1280 })
        {
            var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = 844 } });
            var html = SharedArticlePage.Render(new SharedNewsArticle {
                Id = new string('a', 48),
                Title = title, Source = "Science news", Byline = "Example Reporter", Language = language,
                OriginalUrl = "https://example.com/clean-energy", ParagraphsJson = JsonSerializer.Serialize(new[] { text, text, text }) }, "/");
            var audioRequests = 0;
            var requestedVoice = "";
            var failure = false;
            await page.RouteAsync("https://shared.example.test/**", async route =>
            {
                var url = new Uri(route.Request.Url);
                if (url.AbsolutePath.EndsWith("/audio"))
                {
                    audioRequests++;
                    requestedVoice = url.Query;
                    await route.FulfillAsync(new() { Status = failure ? 503 : 200, ContentType = "audio/wav", BodyBytes = failure ? [] : wave });
                }
                else if (url.AbsolutePath.EndsWith("/audio/voices"))
                    await route.FulfillAsync(new() { ContentType = "application/json", Body = "{\"selected\":\"default\",\"voices\":[{\"id\":\"default\",\"name\":\"Default\",\"language\":\"" + language + "\",\"gender\":\"Female\"},{\"id\":\"alternate\",\"name\":\"Alternate\",\"language\":\"" + language + "\",\"gender\":\"Male\"}]}" });
                else if (url.AbsolutePath.EndsWith("/audio/timing"))
                    await route.FulfillAsync(new() { ContentType = "application/json", Body = "{\"starts\":[0,0.45,1.1,1.65],\"sections\":[0,1,2,3],\"complete\":true,\"duration\":2}" });
                else if (url.AbsolutePath.EndsWith("shared-story-audio.js"))
                    await route.FulfillAsync(new() { ContentType = "text/javascript", Body = audioScript });
                else await route.FulfillAsync(new() { ContentType = "text/html", Body = html,
                    Headers = new Dictionary<string, string> { ["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'" } });
            });
            await page.GotoAsync("https://shared.example.test/shared/" + new string('a', 48));
            Require(await page.Locator("h1").InnerTextAsync() == title, "Rendered title changed.");
            Require(await page.Locator(".body p").CountAsync() == 3, "Rendered paragraphs disappeared.");
            Require(await page.EvaluateAsync<bool>("document.documentElement.scrollWidth <= innerWidth"), "Shared page overflows on a phone.");
            if (language == "ar") Require(await page.Locator(".body p").First.EvaluateAsync<string>("el => getComputedStyle(el).direction") == "rtl", "Arabic paragraphs lost their reading direction.");
            Require(audioRequests == 0, "Page previews or initial loading triggered paid audio synthesis.");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#story-voice")).ToBeEnabledAsync();
            Require(await page.Locator("#story-voice option").CountAsync() == 2, "The voice picker did not load under the page CSP.");
            await page.GetByRole(Microsoft.Playwright.AriaRole.Button, new() { Name = "Play audio" }).ClickAsync();
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#audio-status")).ToHaveTextAsync("Playing the saved story with Azure narration.");
            var audio = page.Locator("#story-audio");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("h1")).ToHaveClassAsync(new System.Text.RegularExpressions.Regex("audio-current"));
            Require(await audio.GetAttributeAsync("controls") is not null && audioRequests > 0, "Audio did not play with native controls under the page's CSP.");
            await Task.Delay(250);
            await audio.EvaluateAsync("el => el.pause()");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#audio-status")).ToHaveTextAsync("Paused. Press play to continue.");
            Require(await page.Locator(".audio-current").CountAsync() == 0, "Paused playback kept a speaking highlight.");
            await audio.EvaluateAsync("el => { el.currentTime = 1.15; }");
            await audio.EvaluateAsync("el => el.play()");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#audio-status")).ToHaveTextAsync("Playing the saved story with Azure narration.");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("[data-audio-section='2']")).ToHaveClassAsync(new System.Text.RegularExpressions.Regex("audio-current"));
            await audio.EvaluateAsync("el => { el.currentTime = 0.5; }");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("[data-audio-section='1']")).ToHaveClassAsync(new System.Text.RegularExpressions.Regex("audio-current"));
            await audio.EvaluateAsync("el => el.pause()");
            var previousRequests = audioRequests;
            await page.Locator("#story-voice").SelectOptionAsync("alternate");
            Require(audioRequests == previousRequests && await page.Locator(".audio-current").CountAsync() == 0, "Changing a paused voice generated audio or kept stale highlighting.");
            await page.GetByRole(Microsoft.Playwright.AriaRole.Button, new() { Name = "Play audio" }).ClickAsync();
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#audio-status")).ToHaveTextAsync("Playing the saved story with Azure narration.");
            Require(requestedVoice == "?voice=alternate", "Playback ignored the listener's voice choice.");
            await page.Locator("#story-voice").SelectOptionAsync("default");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#audio-status")).ToHaveTextAsync("Playing the saved story with Azure narration.");
            Require(requestedVoice == "?voice=default", "Changing a playing voice did not restart narration.");
            await audio.EvaluateAsync("el => { el.currentTime = el.duration - 0.05; }");
            await Microsoft.Playwright.Assertions.Expect(page.Locator("#audio-status")).ToHaveTextAsync("End of story. Press play to listen again.");
            Require(await page.Locator(".audio-current").CountAsync() == 0, "Completed playback retained a speaking highlight.");
            if (language == "en")
            {
                failure = true;
                await page.ReloadAsync();
                await page.GetByRole(Microsoft.Playwright.AriaRole.Button, new() { Name = "Play audio" }).ClickAsync();
                await page.GetByRole(Microsoft.Playwright.AriaRole.Button, new() { Name = "Try audio again" }).WaitForAsync();
                failure = false;
                await page.GetByRole(Microsoft.Playwright.AriaRole.Button, new() { Name = "Try audio again" }).ClickAsync();
                await Microsoft.Playwright.Assertions.Expect(page.Locator("#audio-status")).ToHaveTextAsync("Playing the saved story with Azure narration.");
            }
            await page.ScreenshotAsync(new() { Path = $"work/shared-story-{language}-{width}.png", FullPage = true });
            await page.CloseAsync();
        }
        await RunAudioScrollAsync(browser, audioScript);
        Console.WriteLine("Hosted pages passed desktop/phone layout, Chinese and Arabic text, CSP, voice selection and switching, synchronized highlights, viewport following, reduced motion, forward/backward seeking, pause/resume, completion and failed-audio retry checks.");
    }

    private static async Task RunAudioScrollAsync(Microsoft.Playwright.IBrowser browser, string audioScript)
    {
        foreach (var width in new[] { 390, 1280 })
        {
            var reducedMotion = width == 390;
            var page = await browser.NewPageAsync(new() {
                ViewportSize = new() { Width = width, Height = 844 },
                ReducedMotion = reducedMotion ? Microsoft.Playwright.ReducedMotion.Reduce : Microsoft.Playwright.ReducedMotion.NoPreference
            });
            var text = string.Join(" ", Enumerable.Repeat("This long paragraph explains the local news in detail so readers can follow along with the narration.", 30));
            var html = SharedArticlePage.Render(new SharedNewsArticle {
                Id = new string('b', 48), Title = "A long shared story", Source = "Example", Language = "en",
                OriginalUrl = "https://example.com/story", ParagraphsJson = JsonSerializer.Serialize(new[] { text, text, text }) }, "/");
            await page.AddInitScriptAsync("""
                window.playback = { paused: true, currentTime: 0 };
                window.scrollOptions = [];
                const scroll = Element.prototype.scrollIntoView;
                Element.prototype.scrollIntoView = function(options) {
                    window.scrollOptions.push(options);
                    return scroll.call(this, options);
                };
                Object.defineProperties(HTMLMediaElement.prototype, {
                    paused: { get: () => playback.paused },
                    currentTime: { get: () => playback.currentTime, set: value => playback.currentTime = value },
                    ended: { get: () => false }
                });
                HTMLMediaElement.prototype.load = function() {};
                HTMLMediaElement.prototype.play = function() {
                    playback.paused = false;
                    this.dispatchEvent(new Event('playing'));
                    return Promise.resolve();
                };
                """);
            await page.RouteAsync("https://shared.example.test/**", route => {
                var url = new Uri(route.Request.Url);
                var (type, body) = url.AbsolutePath.EndsWith("/timing")
                    ? ("application/json", "{\"starts\":[0,10,20,30],\"sections\":[0,1,2,3],\"complete\":true}")
                    : url.AbsolutePath.EndsWith("/voices")
                        ? ("application/json", "{\"selected\":\"\",\"voices\":[]}")
                        : url.AbsolutePath.EndsWith("shared-story-audio.js")
                            ? ("text/javascript", audioScript) : ("text/html", html);
                return route.FulfillAsync(new() { ContentType = type, Body = body });
            });
            await page.GotoAsync("https://shared.example.test/shared/" + new string('b', 48));
            await page.GetByRole(Microsoft.Playwright.AriaRole.Button, new() { Name = "Play audio" }).ClickAsync();
            await Microsoft.Playwright.Assertions.Expect(page.Locator("h1")).ToHaveClassAsync(new System.Text.RegularExpressions.Regex("audio-current"));
            await page.EvaluateAsync("playback.currentTime = 20; document.querySelector('audio').dispatchEvent(new Event('timeupdate'))");
            await ExpectSectionOnScreenAsync(2);
            Require(await page.EvaluateAsync<string>("scrollOptions.at(-1).behavior") == (reducedMotion ? "instant" : "smooth"), "Audio following must honor reduced motion.");
            await page.EvaluateAsync("playback.currentTime = 10; document.querySelector('audio').dispatchEvent(new Event('seeked'))");
            await ExpectSectionOnScreenAsync(1);
            await page.EvaluateAsync("playback.paused = true; document.querySelector('audio').dispatchEvent(new Event('pause')); scrollTo(0, 0); playback.currentTime = 30; document.querySelector('audio').dispatchEvent(new Event('seeked'))");
            Require(await page.EvaluateAsync<bool>("scrollY === 0 && !document.querySelector('.audio-current')"), "Paused seeking must not scroll the page or keep a speaking highlight.");
            await page.EvaluateAsync("document.querySelector('audio').play()");
            await ExpectSectionOnScreenAsync(3);
            await page.ScreenshotAsync(new() { Path = $"work/shared-story-audio-follow-{width}.png" });
            await page.CloseAsync();

            async Task ExpectSectionOnScreenAsync(int section)
            {
                await page.WaitForFunctionAsync("""
                    section => {
                        const element = document.querySelector(`[data-audio-section='${section}']`);
                        const top = element.getBoundingClientRect().top;
                        return element.classList.contains('audio-current') && Math.abs(top - 32) < 4;
                    }
                    """, section);
            }
        }
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
        var feedLinked = await CreateAsync(controller, request with { DiscussionUrl = "https://news.example.test/original-feed-story" });
        var feedLinkedId = feedLinked.GetProperty("path").GetString()!.Split('/').Last();
        Require((await database.SharedNewsArticles.SingleAsync(item => item.Id == feedLinkedId)).DiscussionUrl
            == "https://news.example.test/original-feed-story", "Reader sharing lost the original feed discussion URL.");
        Require(await controller.Create(request with { DiscussionUrl = "javascript:alert(1)" }, CancellationToken.None)
            is BadRequestObjectResult, "Invalid discussion URL was accepted.");
        var french = await CreateAsync(controller, request with { Snapshot = snapshot with { Title = "Titre", Paragraphs = ["Texte français."], Language = "fr" } });
        Require(french.GetProperty("path").GetString() != path, "Different languages reused the same page.");
        var revised = await CreateAsync(controller, request with { Snapshot = snapshot with { Paragraphs = ["新版本。"] } });
        Require(revised.GetProperty("path").GetString() == path, "Changed text created a second hosted URL for the same news story.");

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
        var unsafeText = await CreateAsync(controller, request with { Url = "https://93.184.216.34/unsafe-story", Snapshot = snapshot with {
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
        await RunReuseChecksAsync();
        Console.WriteLine("Hosted article sharing passed stable news URLs, saved translations, legacy link reuse, concurrent creation, anonymous reading, authorization, text escaping, input limits and summary fallback checks.");
    }

    private static async Task RunReuseChecksAsync()
    {
        using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var options = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).Options;
        await using var database = new SignalDbContext(options);
        await database.Database.EnsureCreatedAsync();
        database.Users.Add(new ApplicationUser { Id = "owner", UserName = "owner" });
        var first = new SharedNewsArticle { Id = new string('1', 48), UserId = "owner", ContentHash = "legacy-first",
            OriginalUrl = "https://93.184.216.34/legacy", Title = "First saved title", Source = "Publisher",
            ParagraphsJson = "[\"First saved text.\"]", CreatedAtUtc = DateTime.UtcNow.AddDays(-2) };
        var later = new SharedNewsArticle { Id = new string('2', 48), UserId = "owner", ContentHash = "legacy-later",
            OriginalUrl = first.OriginalUrl, DiscussionUrl = first.OriginalUrl, Title = "Later saved title",
            ParagraphsJson = "[\"Later saved text.\"]", CreatedAtUtc = DateTime.UtcNow.AddDays(-1) };
        database.SharedNewsArticles.AddRange(first, later);
        database.NewsComments.Add(new NewsComment { ArticleUrl = first.OriginalUrl, ArticleTitle = first.Title, Body = "Keep this discussion", GuestName = "Jamie" });
        await database.SaveChangesAsync();
        // Upgrade the deployed schema without removing any historical URL or snapshot.
        await database.Database.ExecuteSqlRawAsync("DROP INDEX IX_SharedNewsArticles_UserId_ShareKey; ALTER TABLE SharedNewsArticles DROP COLUMN ShareKey;");
        await SharedArticleLinkSchema.UpgradeAsync(database);
        await SharedArticleLinkSchema.UpgradeAsync(database);
        Require(await database.SharedNewsArticles.CountAsync() == 2 && await database.NewsComments.CountAsync() == 1,
            "Share-key upgrade removed a hosted page or comment.");
        var network = new UnavailableHandler();
        using var client = new HttpClient(network);
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var reader = new ArticleReaderService(client, cache, NullLogger<ArticleReaderService>.Instance);
        var controller = CreateController(database, reader, "owner");
        var request = new ArticleSharesController.CreateShareRequest(first.OriginalUrl, "Updated feed title", "Updated source", "Updated summary", null);
        var reused = await CreateAsync(controller, request);
        Require(reused.GetProperty("path").GetString() == "/shared/" + first.Id && reused.GetProperty("title").GetString() == first.Title,
            "Legacy sharing did not reuse the oldest saved page and its metadata.");
        Require(network.Calls == 0, "Sharing an existing hosted story fetched the publisher again.");
        var snapshot = new ArticleSharesController.ArticleSnapshot("Updated reader title", ["Updated reader paragraphs."], "", "Updated byline");
        var readerShare = await CreateAsync(controller, request with { Snapshot = snapshot });
        Require(readerShare.GetProperty("path").GetString() == reused.GetProperty("path").GetString()
            && await database.SharedNewsArticles.CountAsync() == 2, "Reader content changes created another URL.");
        var existingPage = (ContentResult)await controller.Read(first.Id, default);
        var laterPage = (ContentResult)await controller.Read(later.Id, default);
        Require(existingPage.Content!.Contains("First saved text.") && laterPage.Content!.Contains("Later saved text."),
            "Reusing a link rewrote an already shared page.");
        Require((await database.NewsComments.SingleAsync()).GuestName == "Jamie", "Reusing a link changed its discussion.");
        var different = await CreateAsync(controller, request with { Url = "https://93.184.216.34/different-story", Snapshot = snapshot });
        Require(different.GetProperty("path").GetString() != reused.GetProperty("path").GetString(), "Different stories reused one hosted page.");
        controller.Request.PathBase = "/signal";
        var nested = await CreateAsync(controller, request);
        Require(nested.GetProperty("path").GetString() == "/signal/shared/" + first.Id, "Reused URL lost the hosting path base.");

        var winner = new ShareRaceInterceptor(options);
        var racingOptions = new DbContextOptionsBuilder<SignalDbContext>().UseSqlite(connection).AddInterceptors(winner).Options;
        await using var racingDatabase = new SignalDbContext(racingOptions);
        var raced = await CreateAsync(CreateController(racingDatabase, reader, "owner"), request with {
            Url = "https://93.184.216.34/concurrent-story", Snapshot = snapshot });
        Require(raced.GetProperty("path").GetString() == "/shared/" + new string('3', 48)
            && raced.GetProperty("title").GetString() == "Concurrent saved version"
            && await database.SharedNewsArticles.CountAsync(item => item.DiscussionUrl == "https://93.184.216.34/concurrent-story") == 1,
            "Concurrent requests with different saved text did not reuse one URL.");
    }

    private sealed class ShareRaceInterceptor(DbContextOptions<SignalDbContext> options) : SaveChangesInterceptor
    {
        private bool inserted;
        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
            InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            var pending = eventData.Context!.ChangeTracker.Entries<SharedNewsArticle>()
                .FirstOrDefault(entry => entry.State == EntityState.Added)?.Entity;
            if (inserted || pending is null) return result;
            inserted = true;
            await using var other = new SignalDbContext(options);
            other.SharedNewsArticles.Add(new SharedNewsArticle { Id = new string('3', 48), UserId = pending.UserId,
                ShareKey = pending.ShareKey, ContentHash = "concurrent-different-text", OriginalUrl = pending.OriginalUrl,
                DiscussionUrl = pending.DiscussionUrl, Language = pending.Language, Title = "Concurrent saved version",
                ParagraphsJson = "[\"The first request already saved this story.\"]", CreatedAtUtc = DateTime.UtcNow });
            await other.SaveChangesAsync(cancellationToken);
            return result;
        }
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
