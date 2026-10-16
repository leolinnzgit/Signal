import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: "work/comment-news-vite-cache",
  optimizeDeps: { entries: ["iis-client/main.tsx"], include: ["react", "react-dom/client"] },
  plugins: [react(), { name: "comment-news-page", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (new URL(req.url, "http://localhost").pathname !== "/") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/iis-client/main.tsx"></script></body></html>'));
    });
  } }], server: { host: "127.0.0.1", port: 3027, strictPort: true,
    watch: { ignored: ["**/work/**", "**/Signal.Server/wwwroot/**", "**/iis-publish/**"] } } });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
const storyUrl = "https://publisher.example/story?id=123&lang=en#section";
const title = "A story with a conversation";
const user = { email: "reader@example.test", displayName: "reader@example.test", profilePhotoUrl: null, googleConnected: false, hasPassword: true };
const comment = { id: 1, articleUrl: storyUrl, articleTitle: title, body: "A reader's comment", createdAt: "2026-10-16T00:00:00Z",
  author: { userId: "", name: "Jamie", profilePhotoUrl: "" }, canDelete: false, friendshipState: "anonymous" };
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    const errors = [];
    let signedIn = true;
    let available = true;
    let readRequests = 0;
    let readStateWrites = 0;
    let popups = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.text().includes("Encountered two children")) errors.push(message.text()); });
    page.on("popup", () => popups++);
    await page.addInitScript(() => {
      localStorage.setItem("signal.weather-audio-on-open.v1", "false");
      Object.defineProperty(navigator, "standalone", { value: true });
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const path = url.pathname;
      if (path === "/api/auth/me") return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? user : {} });
      if (path === "/api/auth/login") { signedIn = true; return route.fulfill({ json: user }); }
      if (path === "/api/auth/csrf") return route.fulfill({ json: { token: "test-token" } });
      if (path === "/api/auth/providers") return route.fulfill({ json: { google: false } });
      if (path === "/api/preferences") return route.fulfill({ json: { exists: true, preferences: { topics: [], weatherLocation: null } } });
      if (path === "/api/topic-refresh") return route.fulfill({ json: { articles: [], topics: [], refreshedAt: null, historyTotal: 0, bookmarkTotal: 0 } });
      if (path === "/api/articles") return route.fulfill({ json: { articles: [], total: 0, hasMore: false, topicFacets: [], providerFacets: [], bookmarkedUrls: [], readUrls: [] } });
      if (path === "/api/articles/read") { readStateWrites++; return route.fulfill({ status: 404, json: {} }); }
      if (path === "/api/social") return route.fulfill({ json: { unreadMessages: 0 } });
      if (path === "/api/comments/latest") return route.fulfill({ json: { comments: [comment], newCount: 0 } });
      if (path === "/api/comments") return route.fulfill({ json: { comments: [comment], total: 1, hasMore: false } });
      if (path === "/api/article-reader") {
        readRequests++;
        assert.equal(url.searchParams.get("url"), storyUrl);
        return route.fulfill({ json: available ? { available: true, article: { finalUrl: storyUrl, byline: "Reporter", siteName: "Example publisher",
          publishedAt: "2026-10-16T00:00:00Z", paragraphs: ["The news story opened inside Signal."] } } : { available: false, reason: "The publisher did not provide the text." } });
      }
      return route.fulfill({ status: 503, json: { error: "Unavailable in this isolated browser check" } });
    });
    await page.goto("http://127.0.0.1:3027/");
    await page.getByRole("button", { name: "Latest comments", exact: true }).click();
    const storyLink = page.getByRole("link", { name: "Read story in Signal →", exact: true });
    await storyLink.waitFor();
    const href = await storyLink.getAttribute("href");
    assert.ok(href.startsWith("/?article="));
    await page.screenshot({ path: `work/comment-news-links-${width}.png` });
    await storyLink.click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    await page.getByText("The news story opened inside Signal.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Latest comments", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Close article reader", exact: true }).click();
    const previous = readRequests;
    await page.getByRole("button", { name: "Latest comments", exact: true }).click();
    await page.getByRole("button", { name: `Open discussion for ${title}`, exact: true }).click();
    await page.locator(".discussion-article a").click();
    await page.getByText("The news story opened inside Signal.", { exact: true }).waitFor();
    assert.ok(readRequests > previous, "A second comment navigation reopens the story");
    assert.equal(await page.locator(".discussion-panel").count(), 0);
    await page.goto("http://127.0.0.1:3027" + href);
    await page.getByText("The news story opened inside Signal.", { exact: true }).waitFor();
    available = false;
    await page.reload();
    await page.getByText("The publisher did not provide the text.", { exact: true }).waitFor();
    assert.ok(page.url().startsWith("http://127.0.0.1:3027/"));
    assert.equal(popups, 0, "Unavailable text must not unexpectedly open the publisher");
    assert.equal(readStateWrites, 0, "Opening another reader's commented story does not update nonexistent personal history");
    available = true;
    signedIn = false;
    await page.goto("http://127.0.0.1:3027" + href);
    await page.getByRole("heading", { name: "Sign in to Signal", exact: true }).waitFor();
    await page.getByLabel("Email address", { exact: true }).fill("reader@example.test");
    await page.getByLabel("Password", { exact: true }).fill("A-Test-Password-123!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText("The news story opened inside Signal.", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS comment news navigation ${width}: latest comments, discussion, repeat opens, copied links, login continuation and unavailable text`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
