import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: "work/daily-briefing-dialog-vite-cache",
  plugins: [react(), { name: "daily-dialog-check", configureServer(server) {
    server.middlewares.use("/daily-dialog-test", async (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(await server.transformIndexHtml("/daily-dialog-test", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/daily-briefing-dialog.fixture.tsx"></script></body></html>'));
    });
  } }], optimizeDeps: { entries: ["tests/daily-briefing-dialog.fixture.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 3019, strictPort: true, watch: { ignored: ["**/work/**", "**/Signal.Server/**", "**/Signal.Server.TopicMatcher.Tests/**", "**/iis-publish/**"] } }
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultNavigationTimeout(90000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      return route.fulfill({ json: path.endsWith("/voices") ? [] : {} });
    });
    await page.goto("http://127.0.0.1:3019/daily-dialog-test");
    await page.getByRole("button", { name: "Open daily briefing", exact: true }).click();
    const dialog = page.locator(".daily-briefing-dialog");
    await dialog.waitFor({ state: "visible" });
    // Flush queued native close events, including the Strict Mode setup/cleanup cycle.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.count(), 1, "Opening the daily briefing must not immediately close it");
    assert.equal(await dialog.evaluate(node => node.matches(":modal")), true, "Briefing must use a native modal dialog");
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.refreshDailyBriefing());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await dialog.count(), 1, "Clock/feed updates and fresh callbacks must not close the briefing");
    }
    assert.equal(await page.getByTestId("close-count").innerText(), "0");
    await page.getByRole("button", { name: "Minimize executive briefing", exact: true }).click();
    await page.getByRole("complementary", { name: "Minimized audio player" }).waitFor();
    await page.evaluate(() => window.refreshDailyBriefing());
    assert.equal(await page.getByTestId("close-count").innerText(), "0", "Minimizing must not dismiss the briefing");
    await page.getByRole("button", { name: "Restore audio player", exact: true }).click();
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.evaluate(node => node.matches(":modal")), true, "Restoring returns to a native modal");
    assert.equal(await page.getByTestId("close-count").innerText(), "0");
    await page.evaluate(() => {
      const child = document.createElement("dialog");
      child.id = "child-dialog-check";
      child.textContent = "Child dialog";
      document.body.append(child);
      child.showModal();
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("child-dialog-check").open);
    assert.equal(await dialog.count(), 1, "Escape in a child dialog must not dismiss the briefing underneath");
    assert.equal(await page.getByTestId("close-count").innerText(), "0");
    await page.evaluate(() => document.getElementById("child-dialog-check").remove());
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("close-count").innerText(), "1", "Explicit Escape closes the briefing exactly once");
    await page.getByRole("button", { name: "Open daily briefing", exact: true }).click();
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.evaluate(node => node.matches(":modal")), true, "Briefing reopens after an explicit close");
    await page.getByRole("button", { name: "Close executive briefing", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("close-count").innerText(), "2", "The close button remains functional");
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS daily briefing stays open across mounting and parent refreshes at ${width}px`);
  }
} finally { await browser?.close(); await server.close(); }
