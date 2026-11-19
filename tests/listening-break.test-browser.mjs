import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-listening-break",
  optimizeDeps: { entries: ["tests/listening-break.fixture.tsx"] },
  plugins: [react(), {
    name: "listening-break-test-page",
    configureServer(server) {
      server.middlewares.use("/listening-break", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml("/listening-break", `<!doctype html><html><body>
          <div id="root"></div><dialog><audio controls loop></audio></dialog>
          <script type="module" src="/tests/listening-break.fixture.tsx"></script></body></html>`));
      });
    },
  }],
  server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/work/**", "**/iis-publish/**"] } },
});

const wav = Buffer.alloc(44 + 8000 * 2 * 5);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const source = `data:audio/wav;base64,${wav.toString("base64")}`;
const minute = 60_000;
const storageKey = "signal.listening-break.v1";

await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SIGNAL_BROWSER_CHANNEL,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const address = server.httpServer.address();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${address.port}/listening-break`);
  await page.getByRole("status").waitFor({ state: "attached" });

  await page.evaluate(async source => {
    document.querySelector("dialog").showModal();
    const audio = document.querySelector("audio");
    audio.src = source;
    await audio.play();
  }, source);
  await page.clock.fastForward(20 * minute);
  await page.evaluate(() => {
    const audio = document.querySelector("audio");
    return new Promise(resolve => { audio.addEventListener("pause", resolve, { once: true }); audio.pause(); });
  });
  await page.clock.fastForward(9 * minute);
  await page.evaluate(() => window.testListening.speak());
  await page.clock.fastForward(30 * minute);
  await page.evaluate(async source => {
    window.detachedAudio = window.testListening.createAudio(source);
    window.detachedAudio.loop = true;
    await window.detachedAudio.play();
  }, source);
  await page.clock.fastForward(9 * minute);
  assert.equal(await page.evaluate(() => window.detachedAudio.paused), false, "Overlapping sources count once");
  await page.clock.fastForward(minute);
  await page.getByRole("dialog").getByText("Listening break", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.detachedAudio.paused), true);
  assert.equal(await page.evaluate(() => window.testListening.interruptions()), 1);

  await page.evaluate(async () => {
    const audio = document.querySelector("audio");
    await audio.play().catch(() => {});
    await window.detachedAudio.play().catch(() => {});
  });
  assert.equal(await page.evaluate(() => document.querySelector("audio").paused && window.detachedAudio.paused), true);
  assert.equal(await page.evaluate(() => window.testListening.speak()), false, "Browser speech is blocked during a break");

  await page.clock.fastForward(4 * minute);
  await page.reload();
  await page.getByText("Listening break", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.testListening.speak()), false, "Reload preserves the required break");
  await page.clock.fastForward(6 * minute);
  await page.getByText("Listening break", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.querySelector("audio").paused), true);
  assert.equal(await page.evaluate(() => window.testListening.speak()), true);

  await page.clock.fastForward(50 * minute);
  await page.evaluate(() => window.testListening.cancelSpeech());
  await page.clock.fastForward(10 * minute);
  await page.evaluate(() => window.testListening.speak());
  await page.clock.fastForward(11 * minute);
  const saved = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), storageKey);
  assert.equal(saved.breakUntil, 0, "A voluntary ten-minute break resets listening time");
  assert.deepEqual(errors, []);
  console.log("PASS shared listening time, overlapping audio, playback blocking, reload, and voluntary breaks");
} finally {
  await browser?.close();
  await server.close();
}
