import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: "work/search-vite-cache",
  optimizeDeps: { entries: ["iis-client/main.tsx"], include: ["react", "react-dom/client"] },
  plugins: [react(), { name: "search-test", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (new URL(req.url, "http://localhost").pathname !== "/") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/iis-client/main.tsx"></script></body></html>'));
    });
  } }], server: { host: "127.0.0.1", port: 3031, strictPort: true,
    watch: { ignored: ["**/work/**", "**/Signal.Server/wwwroot/**", "**/iis-publish/**"] } } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const queries = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("signal.weather-audio-on-open.v1", "false"));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      let json = {};
      if (url.pathname === "/api/auth/me") json = { email: "reader@example.test", displayName: "Reader", hasPassword: true };
      if (url.pathname === "/api/auth/csrf") json = { token: "test" };
      if (url.pathname === "/api/preferences") json = { exists: true, preferences: { topics: ["Science", "Technology"], sources: { google: true, gdelt: false, rssFeeds: [] } } };
      if (url.pathname === "/api/topic-refresh") json = { articles: [], topics: [], refreshedAt: null, historyTotal: 1, bookmarkTotal: 1 };
      if (url.pathname === "/api/articles") {
        queries.push(Object.fromEntries(url.searchParams));
        const matched = url.searchParams.get("search") === "quantum manufacturing";
        json = { articles: matched ? [{ title: "Technology policy changes", url: "https://example.test/story", source: "Test publisher", summary: "A policy report", topics: ["Science"], providers: ["Google News"], publishedAt: new Date().toISOString(), isBookmarked: true, isRead: false }] : [],
          historyTotal: 1, bookmarkTotal: 1, matchingTotal: matched ? 1 : 0, filterTotal: matched ? 1 : 0,
          hasMore: false, topicFacets: [], providerFacets: [], bookmarkedUrls: [], readUrls: [] };
      }
      return route.fulfill({ json });
    });
    await page.goto("http://127.0.0.1:3031/");
    const searchButton = page.getByRole("button", { name: "Search topics or full text", exact: true });
    await searchButton.click();
    const dialog = page.getByRole("dialog", { name: "Search", exact: true });
    await dialog.getByRole("searchbox", { name: "Find a followed topic" }).fill("Science");
    await dialog.getByRole("button", { name: /Science,/ }).click();
    assert.equal(await dialog.count(), 0);
    await searchButton.click();
    await dialog.getByRole("button", { name: "Full text", exact: true }).click();
    const input = dialog.getByRole("searchbox", { name: "Search all saved stories" });
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    assert.equal(await dialog.getByRole("button", { name: "Search stories" }).isDisabled(), true);
    await input.fill("  quantum   manufacturing  ");
    await page.screenshot({ path: `work/full-text-search-${width}.png` });
    await input.press("Enter");
    await page.getByRole("heading", { name: "Technology policy changes", exact: true }).waitFor();
    assert.equal(queries.at(-1).search, "quantum manufacturing");
    assert.equal(queries.at(-1).topic, undefined);
    assert.equal(queries.at(-1).provider, undefined);
    await searchButton.click();
    await dialog.getByRole("searchbox").fill("missing");
    await dialog.getByRole("button", { name: "Search stories" }).click();
    await page.getByRole("heading", { name: "Try broader filters." }).waitFor();
    await page.getByRole("button", { name: /Bookmarks/, exact: false }).first().click();
    await searchButton.click();
    await dialog.getByRole("searchbox", { name: "Search bookmarks" }).fill("quantum manufacturing");
    await dialog.getByRole("button", { name: "Search stories" }).click();
    await page.getByRole("heading", { name: "Technology policy changes", exact: true }).waitFor();
    assert.equal(queries.at(-1).bookmarksOnly, "true");
    await searchButton.click();
    await dialog.getByRole("searchbox").press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await dialog.count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Search icon passed topic selection, full text submission, normalization, empty results, bookmark scope, keyboard and mobile checks.");
} finally {
  await browser?.close();
  await server.close();
}
