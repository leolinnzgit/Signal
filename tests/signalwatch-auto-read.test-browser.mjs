import { previewHandler } from './preview-assets.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SIGNAL_PLAYWRIGHT_MODULE || 'playwright');
const html = await readFile(new URL('../public/signalwatch/index.html', import.meta.url));
const server = createServer(previewHandler(html));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.SIGNALWATCH_PREVIEW_URL || `http://127.0.0.1:${server.address().port}`);
    const watch = page.locator('#watch');
    const action = name => watch.getByRole('button', { name, exact: true });
    const first = watch.getByRole('button', { name: /^Your briefing A little more perspective/ });
    await action('Catch me up').click();
    await action('Finish story').click();
    await action('Next story').click(); // Skipped news remains unread.
    await action('Back to briefing').click();
    assert.match(await first.innerText(), /Read/);
    assert.match(await watch.getByRole('button', { name: /^Quick actions Keep a good read/ }).innerText(), /New/);
    await watch.getByRole('button', { name: /^Quick actions Keep a good read/ }).click();
    await action('Listen to full story').click();
    await action('Next section').click();
    await action('Pause').click();
    await action('Stop listening').click();
    await watch.getByRole('button', { name: /^Quick actions Keep a good read/ }).click();
    await action('Mark as read').waitFor(); // Partial, paused, stopped playback stays unread.
    await action('Back to briefing').click();
    await action('Resume listening').click();
    await action('Finish listening').click();
    await watch.getByRole('button', { name: /^Quick actions Keep a good read/ }).click();
    await action('Read ✓').waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Queue tile', exact: true }).click();
    await action('Play queue').click();
    await action('Finish listening').click();
    await watch.getByRole('heading', { name: 'Keep a good read for later', exact: true }).waitFor();
    await action('Stop listening').click();
    assert.match(await first.innerText(), /Read/);
    assert.match(await watch.getByRole('button', { name: /^Quick actions Keep a good read/ }).innerText(), /New/);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS: SignalWatch completed/paused/skipped read status at ${width}px`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
