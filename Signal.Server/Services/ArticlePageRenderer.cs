using System.Net;
using Microsoft.Playwright;

namespace Signal.Server.Services;

public sealed record RenderedArticlePage(Uri Url, string Html);

public interface IArticlePageRenderer
{
    Task<RenderedArticlePage?> RenderAsync(Uri uri, string html, CancellationToken cancellationToken);
}

/// <summary>Renders public article HTML only after static extraction fails.</summary>
public sealed class ArticlePageRenderer(
    IHttpClientFactory clients,
    ILogger<ArticlePageRenderer> logger) : IArticlePageRenderer, IDisposable
{
    public const string HttpClientName = "ArticleReaderBrowser";
    private readonly SemaphoreSlim slots = new(2);

    public async Task<RenderedArticlePage?> RenderAsync(Uri uri, string html, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(25));
        var acquired = false;
        try
        {
            await slots.WaitAsync(deadline.Token);
            acquired = true;
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync(new()
            {
                Channel = OperatingSystem.IsWindows() ? "msedge" : null,
                Headless = true,
                Timeout = 8_000,
            });
            await using var context = await browser.NewContextAsync(new()
            {
                AcceptDownloads = false,
                ServiceWorkers = ServiceWorkerPolicy.Block,
            });
            using var client = clients.CreateClient(HttpClientName);
            // Route every request through our HTTP client: Chromium never follows an
            // unchecked redirect or contacts an internal address on the site's behalf.
            var requests = 0;
            long receivedBytes = 0;
            await context.RouteWebSocketAsync("**/*", socket => socket.CloseAsync());
            await context.RouteAsync("**/*", async route =>
            {
                try
                {
                    if (deadline.IsCancellationRequested
                        || Interlocked.Increment(ref requests) > 60
                        || route.Request.Method != "GET"
                        || route.Request.ResourceType is not ("document" or "script" or "stylesheet" or "xhr" or "fetch"))
                    {
                        await route.AbortAsync();
                        return;
                    }

                    if (route.Request.IsNavigationRequest && route.Request.Url == uri.AbsoluteUri)
                    {
                        await route.FulfillAsync(new() { ContentType = "text/html; charset=utf-8", Body = html });
                        return;
                    }

                    var resourceUri = await ArticleReaderService.ValidatePublicArticleUriAsync(route.Request.Url, deadline.Token);
                    for (var redirect = 0; redirect <= 5; redirect++)
                    {
                        using var request = new HttpRequestMessage(HttpMethod.Get, resourceUri);
                        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                        if (response.StatusCode is HttpStatusCode.MovedPermanently or HttpStatusCode.Redirect
                            or HttpStatusCode.SeeOther or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect)
                        {
                            if (redirect == 5 || response.Headers.Location is null) break;
                            resourceUri = await ArticleReaderService.ValidatePublicArticleUriAsync(
                                new Uri(resourceUri, response.Headers.Location).AbsoluteUri, deadline.Token);
                            continue;
                        }
                        if (!response.IsSuccessStatusCode) break;
                        var body = await ArticleReaderService.ReadLimitedHtmlAsync(response.Content, deadline.Token);
                        if (Interlocked.Add(ref receivedBytes, System.Text.Encoding.UTF8.GetByteCount(body)) > 8_000_000) break;
                        await route.FulfillAsync(new()
                        {
                            Status = (int)response.StatusCode,
                            ContentType = response.Content.Headers.ContentType?.ToString() ?? "text/plain",
                            Headers = response.Headers
                                .Where(header => header.Key.StartsWith("Access-Control-", StringComparison.OrdinalIgnoreCase))
                                .ToDictionary(header => header.Key, header => string.Join(", ", header.Value)),
                            Body = body,
                        });
                        return;
                    }
                    await route.AbortAsync();
                }
                catch (Exception exception) when (exception is ArgumentException or HttpRequestException
                    or OperationCanceledException or InvalidOperationException or PlaywrightException)
                {
                    try { await route.AbortAsync(); } catch (PlaywrightException) { }
                }
            });

            try
            {
                return await ReadPageAsync(context, uri, deadline.Token);
            }
            finally
            {
                // Closing the context interrupts navigation and pending page requests.
                await context.CloseAsync();
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogDebug("Browser article extraction timed out for {ArticleUrl}.", uri);
            return null;
        }
        catch (ArgumentException exception)
        {
            logger.LogDebug(exception, "Browser article navigation was rejected for {ArticleUrl}.", uri);
            return null;
        }
        catch (Exception exception) when (exception is PlaywrightException or TimeoutException)
        {
            logger.LogInformation(exception, "Browser article extraction was unavailable for {ArticleUrl}.", uri);
            return null;
        }
        finally
        {
            if (acquired) slots.Release();
        }
    }

    private static async Task<RenderedArticlePage?> ReadPageAsync(IBrowserContext context, Uri uri, CancellationToken token)
    {
        var page = await context.NewPageAsync();
        await page.GotoAsync(uri.AbsoluteUri, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 15_000 }).WaitAsync(token);
        try
        {
            await page.WaitForFunctionAsync("""
                () => {
                    const content = document.querySelector('article, main') || document.body;
                    return content && content.innerText.trim().length >= 300;
                }
                """, options: new() { Timeout = 6_000 }).WaitAsync(token);
            // Allow a completed hydration tick to replace its loading placeholder.
            await Task.Delay(300, token);
        }
        catch (TimeoutException) { }
        var finalUri = await ArticleReaderService.ValidatePublicArticleUriAsync(page.Url, token);
        var content = await page.ContentAsync().WaitAsync(token);
        return System.Text.Encoding.UTF8.GetByteCount(content) <= 2_000_000
            ? new RenderedArticlePage(finalUri, content)
            : null;
    }

    public void Dispose() => slots.Dispose();
}
