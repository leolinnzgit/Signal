import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SIGNAL_PLAYWRIGHT_MODULE || 'playwright');
const html = await readFile(new URL('../public/signalwatch/index.html', import.meta.url));
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.SIGNALWATCH_PREVIEW_URL || `http://127.0.0.1:${server.address().port}`, { timeout: 90_000 });
    const watch = page.locator('#watch');
    await page.getByRole('button', { name: 'A little more perspective', exact: false }).click();
    await watch.getByRole('button', { name: 'Save for later', exact: true }).click();
    await watch.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await watch.getByRole('button', { name: 'Read ✓', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Saved stories', exact: true }).click();
    assert.equal(await watch.locator('.card').count(), 2);
    await watch.getByRole('button', { name: 'A little more perspective', exact: false }).click();
    await watch.getByRole('button', { name: 'Remove saved', exact: true }).click();
    await watch.getByRole('button', { name: 'Back to briefing', exact: true }).click();
    assert.equal(await watch.locator('.card').count(), 1);
    await watch.getByRole('button', { name: 'Keep a good read', exact: false }).click();
    await watch.getByRole('button', { name: 'Remove saved', exact: true }).click();
    await watch.getByRole('button', { name: 'Back to briefing', exact: true }).click();
    await watch.getByText('Save a story to find it here.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Quick actions', exact: true }).click();
    await watch.getByRole('button', { name: 'Refresh briefing', exact: true }).click();
    assert.equal(await watch.locator('.card').count(), 3);
    assert.match(await page.locator('#status').innerText(), /sample content only/);
    assert.equal(await page.locator('.download').getAttribute('href'), 'SignalWatch-debug.apk');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await mkdir('work/signalwatch-preview', { recursive: true });
    await page.screenshot({ path: `work/signalwatch-preview/${width}.png`, fullPage: true });
    await page.close();
    console.log(`PASS: SignalWatch preview interactions and layout at ${width}px`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
