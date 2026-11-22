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

test('fetchOpenCoverage fetches CSRF token, posts request payload, and normalizes open articles response', async () => {
  const controller = new AbortController();
  const calls = [];

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
    calls.push({ path, options });
    if (path === '/api/auth/csrf') {
      return Response.json({ token: 'csrf-token-123' });
    }
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

  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, '/api/auth/csrf');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.signal, controller.signal);

  const postCall = calls[1];
  assert.equal(postCall.path, '/api/article-reader/open-coverage');
  assert.equal(postCall.options.method, 'POST');
  assert.equal(postCall.options.credentials, 'same-origin');
  assert.equal(postCall.options.cache, 'no-store');
  assert.equal(postCall.options.signal, controller.signal);
  assert.equal(postCall.options.headers['Content-Type'], 'application/json');
  assert.equal(postCall.options.headers['X-XSRF-TOKEN'], 'csrf-token-123');
  assert.deepEqual(JSON.parse(postCall.options.body), {
    url: 'https://www.nzherald.co.nz/premium/123',
    title: 'New Taipei-Auckland flights confirmed',
    source: ''
  });
  assert.equal(result.available, true);
  assert.equal(result.queryUsed, 'Taipei Auckland Starlux flights');
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].source, 'aeroroutes.com');
});

test('fetchOpenCoverage surfaces CSRF errors, server validation message, or falls back on invalid JSON error', async () => {
  await assert.rejects(
    () => fetchOpenCoverage(
      { url: 'https://example.com/story', title: 'CSRF failure' },
      async path => path === '/api/auth/csrf'
        ? new Response('forbidden', { status: 403 })
        : Response.json({})
    ),
    /Could not verify your session to search open news sources\./
  );

  await assert.rejects(
    () => fetchOpenCoverage(
      { url: 'https://localhost/story', title: 'Bad URL' },
      async path => path === '/api/auth/csrf'
        ? Response.json({ token: 'csrf-token' })
        : Response.json({ message: 'Private addresses are not allowed.' }, { status: 400 })
    ),
    /Private addresses are not allowed\./
  );

  await assert.rejects(
    () => fetchOpenCoverage(
      { url: 'https://example.com/story', title: 'Gateway failure' },
      async path => path === '/api/auth/csrf'
        ? Response.json({ token: 'csrf-token' })
        : new Response('<html>502 Bad Gateway</html>', { status: 502 })
    ),
    /Could not search open news sources right now\./
  );
});


test("More coverage combines indexed and local stories across distinct publishers", async () => {
  const { findCoverageMatches } = await import("../app/more-coverage.ts");
  const publishedAt = "2026-11-21T12:00:00Z";
  const anchor = { title: "Auckland port strike delays freight deliveries", source: "Radio New Zealand",
    url: "https://www.rnz.co.nz/news/a", publishedAt };
  const samePublisher = { ...anchor, source: "RNZ", url: "https://rnz.co.nz/news/b" };
  const irrelevant = { ...anchor, title: "Markets brace for wage announcement", source: "Other",
    url: "https://other.example/news", summary: "Stocks closed broadly higher." };
  const indexed = { title: "Exports disrupted after walkout", summary: "Freight and port deliveries delayed in Auckland.",
    source: "BBC News", url: "https://bbc.com/news/one", publishedAt };
  const duplicatePublisher = { ...indexed, source: "BBC", url: "https://www.bbc.co.uk/news/two" };
  const local = { ...anchor, title: "Freight deliveries delayed after Auckland port strike",
    source: "Stuff", url: "https://stuff.co.nz/one" };
  const old = { ...local, source: "Archive", url: "https://archive.example/story", publishedAt: "2026-11-01T12:00:00Z" };
  assert.deepEqual(findCoverageMatches(anchor, [samePublisher, irrelevant, indexed, duplicatePublisher], [old, local]), [indexed, local]);
  assert.deepEqual(findCoverageMatches(anchor, [], [samePublisher, old, local]), [local]);
});

test("More coverage submits the article seed with CSRF protection and maps Azure results", async () => {
  const { fetchMoreCoverage } = await import("../app/more-coverage.ts");
  const requests = [];
  const signal = new AbortController().signal;
  const story = { title: "  Auckland port strike ", summary: " Freight delays ", publishedAt: "2026-11-21",
    url: "https://www.rnz.co.nz/news/a", source: "RNZ" };
  const hit = { title: "Freight delays across Auckland", publisher: "BBC", url: "https://bbc.com/news/a",
    publishedAt: "2026-11-21T00:00:00Z", excerpt: "Port strike continues." };
  const result = await fetchMoreCoverage(story, signal, async (path, options) => {
    requests.push({ path, options });
    return Response.json(path === "/api/auth/csrf" ? { token: "token" } : { articles: [hit] });
  });
  assert.equal(requests[1].path, "/api/article-reader/more-coverage");
  assert.equal(requests[1].options.headers["X-XSRF-TOKEN"], "token");
  assert.equal(requests[1].options.signal, signal);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    url: story.url, title: "Auckland port strike", summary: "Freight delays", publishedAt: "2026-11-21T00:00:00.000Z",
  });
  assert.deepEqual(result, [{ title: hit.title, source: hit.publisher, url: hit.url,
    publishedAt: hit.publishedAt, summary: hit.excerpt }]);
});
