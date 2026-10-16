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
const comment = { id: 3, articleUrl: storyUrl, articleTitle: title, body: "A reader's comment", createdAt: "2026-10-16T00:00:00Z",
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
    let failComments = false;
    let thread = [
      { ...comment, id: 1, body: "The oldest comment", author: { ...comment.author, name: "Early reader" } },
      { ...comment, id: 2, body: "An anonymous reader's comment", author: { ...comment.author, name: "Anonymous" } },
      comment,
      { ...comment, id: 4, body: "My existing comment", author: { ...comment.author, userId: "me", name: "Reader" }, canDelete: true, friendshipState: "self" },
    ];
    const otherUrl = "https://publisher.example/another-story";
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
      if (path === "/api/comments") {
        if (route.request().method() === "POST") {
          const request = route.request().postDataJSON();
          assert.equal(request.articleUrl, storyUrl);
          const parent = request.parentCommentId ? thread.find(item => item.id === request.parentCommentId) : null;
          const created = {
            ...thread.at(-1),
            id: thread.length + 1,
            body: request.body,
            canDelete: true,
            friendshipState: "self",
            parentCommentId: parent?.id ?? null,
            replyTo: parent ? { id: parent.id, authorName: parent.author.name, body: parent.body } : null,
          };
          thread.push(created);
          return route.fulfill({ json: created });
        }
        if (failComments) return route.fulfill({ status: 503, json: { error: "Comments temporarily unavailable" } });
        if (url.searchParams.get("url") === otherUrl) return route.fulfill({ json: {
          comments: [{ ...comment, articleUrl: otherUrl, articleTitle: "Another story", body: "Only the other story's comment" }], total: 1, hasMore: false } });
        assert.equal(url.searchParams.get("url"), storyUrl);
        const before = Number(url.searchParams.get("beforeId"));
        const comments = before ? thread.filter(item => item.id < before) : thread.filter(item => item.id >= 2);
        return route.fulfill({ json: { comments, total: thread.length, hasMore: !before && thread.length > comments.length } });
      }
      if (path === "/api/article-reader") {
        readRequests++;
        const requested = url.searchParams.get("url");
        assert.ok([storyUrl, otherUrl].includes(requested));
        return route.fulfill({ json: available ? { available: true, article: { finalUrl: requested, byline: "Reporter", siteName: "Example publisher",
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
    const inline = page.locator(".article-reader-comments");
    await inline.getByText("A reader's comment", { exact: true }).waitFor();
    await inline.getByText("An anonymous reader's comment", { exact: true }).waitFor();
    await inline.getByText("My existing comment", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Boolean(document.querySelector(".article-reader-end").compareDocumentPosition(document.querySelector(".article-reader-comments")) & Node.DOCUMENT_POSITION_FOLLOWING)), true,
      "Comments appear after the article text");
    await inline.getByRole("button", { name: "Load earlier comments", exact: true }).click();
    await inline.getByText("The oldest comment", { exact: true }).waitFor();
    assert.equal(await inline.locator(".comment-list > li").count(), 4);
    assert.equal(await inline.getByRole("button", { name: "Load earlier comments", exact: true }).count(), 0);
    await inline.getByLabel("Join the discussion", { exact: true }).fill("Posted below the news article");
    await inline.getByRole("button", { name: "Post comment", exact: true }).click();
    await inline.getByText("Posted below the news article", { exact: true }).waitFor();
    assert.equal(await inline.getByLabel("Join the discussion", { exact: true }).inputValue(), "");
    const jamieItem = inline.locator(".comment-list > li").filter({ hasText: "A reader's comment" });
    await jamieItem.getByRole("button", { name: "Reply", exact: true }).click();
    await jamieItem.getByLabel("Reply to Jamie", { exact: true }).fill("Replying directly to Jamie");
    await jamieItem.getByRole("button", { name: "Post reply", exact: true }).click();
    await inline.getByText("Replying directly to Jamie", { exact: true }).waitFor();
    await inline.locator(".comment-reply-context").filter({ hasText: "Replying to Jamie: A reader's comment" }).waitFor();
    await inline.getByRole("heading", { name: "Comments", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `work/reader-comments-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole("button", { name: "Close article reader", exact: true }).click();
    const previous = readRequests;
    await page.getByRole("button", { name: "Latest comments", exact: true }).click();
    await page.getByRole("button", { name: `Open discussion for ${title}`, exact: true }).click();
    await page.locator(".discussion-article a").click();
    await page.getByText("The news story opened inside Signal.", { exact: true }).waitFor();
    assert.ok(readRequests > previous, "A second comment navigation reopens the story");
    assert.equal(await page.locator(".discussion-panel").count(), 0);
    await page.locator(".article-reader-comments").getByText("Posted below the news article", { exact: true }).waitFor();
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
    failComments = true;
    await page.goto("http://127.0.0.1:3027" + href);
    await page.locator(".article-reader-comments").getByRole("alert").filter({ hasText: "Comments temporarily unavailable" }).waitFor();
    assert.equal(await page.locator(".article-reader-comments").getByText("No comments yet. Start the conversation.", { exact: true }).count(), 0);
    failComments = false;
    await page.locator(".article-reader-comments").getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator(".article-reader-comments").getByText("Posted below the news article", { exact: true }).waitFor();
    thread = [];
    await page.goto("http://127.0.0.1:3027" + href);
    await page.locator(".article-reader-comments").getByText("No comments yet. Start the conversation.", { exact: true }).waitFor();
    await page.goto("http://127.0.0.1:3027/?" + new URLSearchParams({ article: otherUrl, title: "Another story", source: "Publisher" }));
    await page.locator(".article-reader-comments").getByText("Only the other story's comment", { exact: true }).waitFor();
    assert.equal(await page.locator(".article-reader-comments").getByText("A reader's comment", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS comment news navigation ${width}: latest comments, discussion, repeat opens, copied links, login continuation, inline comments, pagination, posting, retry, empty state and story isolation`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
