import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = async file => ts.transpileModule(await readFile(new URL('../app/' + file, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText;
const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const { isPaywallReason, fetchOpenCoverage } = await import(url(await compile('open-coverage.ts')));

test('isPaywallReason detects explicit paywall flags and reason messages', () => {
  assert.equal(isPaywallReason('', true), true);
  assert.equal(isPaywallReason('Subscriber-only story', false), true);
  assert.equal(isPaywallReason('Requires a subscription or publisher login to read.', false), true);
  assert.equal(isPaywallReason('Blocked by publisher paywall', undefined), true);
  assert.equal(isPaywallReason('This publisher did not allow direct article text extraction.', false), false);
  assert.equal(isPaywallReason(null, false), false);
});

test('fetchOpenCoverage posts request payload and normalizes open articles response', async () => {
  const controller = new AbortController();
  let capturedPath = '';
  let capturedOptions = null;

  const sampleArticle = {
    title: 'Starlux Plans Sydney / Auckland late-March 2027 Debut',
    url: 'https://www.aeroroutes.com/eng/261110-jxns27sw',
    source: 'aeroroutes.com',
    publishedAt: '2026-11-11T00:00:00Z',
    snippet: 'Starlux Airlines plans Taipei - Sydney - Auckland service from late March 2027.',
    readerArticle: {
      finalUrl: 'https://www.aeroroutes.com/eng/261110-jxns27sw',
      byline: 'Jim Liu',
      siteName: 'AeroRoutes',
      publishedAt: '2026-11-11T00:00:00Z',
      paragraphs: ['Starlux Airlines plans Taipei - Sydney - Auckland service from late March 2027.']
    }
  };

  const fetcher = async (path, options) => {
    capturedPath = path;
    capturedOptions = options;
    return Response.json({
      available: true,
      queryUsed: 'Taipei Auckland Starlux flights',
      message: 'Found 1 readable open report covering this story.',
      articles: [sampleArticle]
    });
  };

  const result = await fetchOpenCoverage(
    { url: 'https://www.nzherald.co.nz/premium/123', title: 'New Taipei-Auckland flights confirmed' },
    fetcher,
    controller.signal
  );

  assert.equal(capturedPath, '/api/article-reader/open-coverage');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.cache, 'no-store');
  assert.equal(capturedOptions.signal, controller.signal);
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    url: 'https://www.nzherald.co.nz/premium/123',
    title: 'New Taipei-Auckland flights confirmed',
    source: ''
  });
  assert.equal(result.available, true);
  assert.equal(result.queryUsed, 'Taipei Auckland Starlux flights');
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].source, 'aeroroutes.com');
});

test('fetchOpenCoverage surfaces server validation message or falls back on invalid JSON error', async () => {
  await assert.rejects(
    () => fetchOpenCoverage(
      { url: 'https://localhost/story', title: 'Bad URL' },
      async () => Response.json({ message: 'Private addresses are not allowed.' }, { status: 400 })
    ),
    /Private addresses are not allowed\./
  );

  await assert.rejects(
    () => fetchOpenCoverage(
      { url: 'https://example.com/story', title: 'Gateway failure' },
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })
    ),
    /Could not search open news sources right now\./
  );
});
