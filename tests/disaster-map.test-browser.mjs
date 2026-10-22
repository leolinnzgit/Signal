import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, plugins: [react(), {
  name: "disaster-map-test", configureServer(server) {
    server.middlewares.use("/disaster-test", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/disaster-test", '<html><head></head><body><div id="root"></div><script type="module" src="/tests/disaster-map.fixture.tsx"></script></body></html>'));
    });
  },
}], optimizeDeps: { entries: ["tests/disaster-map.fixture.tsx"] }, server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/Signal.Server/**", "**/iis-publish/**", "**/work/**"] } } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  await mkdir("outputs/disaster-map", { recursive: true });
  for (const azure of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultNavigationTimeout(90_000);
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    if (azure) await page.addInitScript(() => {
      class Control {}
      window.atlas = {
        Map: class {
          constructor(container) {
            this.container = container;
            this.controls = { add() {} };
            this.markers = { add: marker => container.appendChild(marker.htmlContent) };
            this.events = { add: (name, marker, callback) => {
              if (name === "ready") setTimeout(marker, 0);
              if (name === "click") marker.htmlContent.addEventListener("click", callback);
            } };
          }
          setCamera(camera) { window.lastCamera = camera; }
          getCamera() { return { zoom: 2 }; }
          dispose() { this.container.replaceChildren(); }
        },
        HtmlMarker: class { constructor(options) { Object.assign(this, options); } },
        control: { ZoomControl: Control, PitchControl: Control, CompassControl: Control, StyleControl: Control },
      };
    });
    let fail = false;
    let warning = false;
    let emptyQuakes = false;
    let requests = 0;
    await page.route("**/api/earthquakes/map-feed?*", route => {
      requests++;
      if (fail) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: {
        azureMapsConfigured: azure, subscriptionKey: azure ? "test-key" : "", source: "GeoNet", userLocation: null,
        checkedAtUtc: new Date().toISOString(), warnings: warning ? ["Earthquake feed unavailable. Retry to check for updates."] : [],
        events: emptyQuakes ? [] : [{ id: "q", source: "GeoNet", magnitude: 4.5, depthKm: 12, place: "Cook Strait", latitude: -41, longitude: 175, timeUtc: new Date().toISOString(), distanceKm: 0, url: "https://www.geonet.org.nz/" }],
        disasters: [
          { id: "f", kind: "flood", source: "GDACS", title: "Flooding in Fiji", description: "Heavy rain reported by the source.", alertLevel: "orange", latitude: -18, longitude: 178, distanceKm: null, timeUtc: "2026-10-21T00:00:00Z", url: "https://www.gdacs.org/" },
          { id: "w", kind: "wildfire", source: "GDACS", title: "Wildfire in California", alertLevel: "red", latitude: 35, longitude: -119, distanceKm: null, timeUtc: "2026-10-21T00:00:00Z", url: "https://www.gdacs.org/" },
        ],
      } });
    });
    await page.goto(`${server.resolvedUrls.local[0]}disaster-test`);
    await page.getByRole("button", { name: "Open disaster map" }).click();
    const dialog = page.getByRole("dialog", { name: "Disaster map", exact: true });
    await dialog.getByText("3 reports", { exact: false }).waitFor();
    const drawer = page.getByRole("contentinfo", { name: "Recent disaster reports" });
    await drawer.getByRole("button", { name: /Flooding in Fiji/ }).click();
    const details = page.getByRole("complementary", { name: "Selected disaster details" });
    assert((await details.innerText()).includes("orange alert"));
    assert(!(await details.innerText()).includes("km depth"));
    assert.equal(await details.getByRole("link", { name: /Full report/ }).getAttribute("href"), "https://www.gdacs.org/");
    await page.getByRole("button", { name: "5.0+", exact: true }).click();
    assert.equal(await drawer.getByRole("button").count(), 2, "Magnitude filter must preserve non-earthquake disasters.");
    await page.getByRole("button", { name: "Floods (1)", exact: true }).click();
    assert.equal(await drawer.getByRole("button").count(), 1);
    assert(!(await details.innerText()).includes("Flooding in Fiji"), "Hidden events must not remain selected.");
    await page.getByRole("button", { name: "Floods (1)", exact: true }).click();
    await page.getByRole("button", { name: "All magnitudes", exact: true }).click();
    fail = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    fail = false; warning = true; emptyQuakes = true;
    const beforeRetry = requests;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("alert").getByText(/Earthquake feed unavailable/).waitFor();
    assert(requests > beforeRetry, "Retry must make a new request.");
    assert.equal(await drawer.getByRole("button").count(), 2, "Other disaster reports remain available when earthquakes fail.");
    if (azure) {
      await page.locator(".earthquake-map-pin").first().waitFor();
      assert.equal(await page.locator(".earthquake-map-pin").count(), 2);
      await page.getByRole("button", { name: "World view" }).click();
      assert.deepEqual(await page.evaluate(() => window.lastCamera.center), [0, 20]);
    }
    assert(await page.getByRole("button", { name: "Close disaster map" }).isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile must not overflow horizontally.");
    await page.screenshot({ path: `outputs/disaster-map/${azure ? "azure" : "overview"}-mobile.png` });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.screenshot({ path: `outputs/disaster-map/${azure ? "azure" : "overview"}-desktop.png` });
    await page.getByRole("button", { name: "Close disaster map" }).click();
    assert.equal(await dialog.count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Disaster map browser checks passed: mobile/desktop, Atlas markers, filters, details, retry and partial feed failure.");
} finally { await browser?.close(); await server.close(); }
