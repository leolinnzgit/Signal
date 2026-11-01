import assert from "node:assert/strict";
import { test } from "node:test";

test("OPML 2.0 XML generator produces valid structure and outline items", () => {
  const feeds = [
    { title: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
    { title: "RNZ News", url: "https://www.rnz.co.nz/rss/national.xml" },
  ];

  const buildOpml = (items) => {
    const outlines = items
      .map(
        (f) =>
          `      <outline type="rss" text="${f.title}" title="${f.title}" xmlUrl="${f.url}" htmlUrl="${f.url}" />`,
      )
      .join("\n");

    return `<?xml version="1.0" encoding="utf-8"?>
<opml version="2.0">
  <head>
    <title>Signal RSS Subscriptions</title>
    <dateCreated>Mon, 02 Nov 2026 06:00:00 GMT</dateCreated>
    <docs>http://opml.org/spec2.opml</docs>
  </head>
  <body>
    <outline text="Signal Subscriptions" title="Signal Subscriptions">
${outlines}
    </outline>
  </body>
</opml>`;
  };

  const xml = buildOpml(feeds);
  assert.ok(xml.includes('<opml version="2.0">'));
  assert.ok(xml.includes('xmlUrl="https://feeds.arstechnica.com/arstechnica/index"'));
  assert.ok(xml.includes('xmlUrl="https://www.rnz.co.nz/rss/national.xml"'));
});

test("OPML Outline parser extracts RSS feed URLs, titles and deduplicates", () => {
  const sampleOpml = `<?xml version="1.0" encoding="utf-8"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="Tech Feeds">
      <outline type="rss" text="Hacker News" xmlUrl="https://news.ycombinator.com/rss" />
      <outline type="rss" text="The Verge" xmlurl="https://www.theverge.com/rss/index.xml" />
      <outline text="Nested Category">
        <outline text="BBC World" url="https://feeds.bbci.co.uk/news/world/rss.xml" />
        <outline text="Duplicate Verge" xmlUrl="https://www.theverge.com/rss/index.xml" />
      </outline>
    </outline>
  </body>
</opml>`;

  const parseOpmlFeeds = (xml) => {
    const extracted = [];
    const seen = new Set();
    const regex = /<outline\b([^>]+?)\/?>/gi;
    let match;

    while ((match = regex.exec(xml)) !== null) {
      const attrs = match[1];
      const urlMatch = attrs.match(/\b(?:xmlUrl|xmlurl|url)=["']([^"']+)["']/i);
      const titleMatch = attrs.match(/\b(?:title|text)=["']([^"']+)["']/i);

      if (urlMatch && urlMatch[1]) {
        const url = urlMatch[1].trim();
        if (url.startsWith("https://") && !seen.has(url.toLowerCase())) {
          seen.add(url.toLowerCase());
          extracted.push({
            url,
            title: titleMatch ? titleMatch[1].trim() : "Feed",
          });
        }
      }
    }
    return extracted;
  };

  const feeds = parseOpmlFeeds(sampleOpml);
  assert.equal(feeds.length, 3);
  assert.equal(feeds[0].url, "https://news.ycombinator.com/rss");
  assert.equal(feeds[1].url, "https://www.theverge.com/rss/index.xml");
  assert.equal(feeds[2].url, "https://feeds.bbci.co.uk/news/world/rss.xml");
});

test("Feed Diagnostics health evaluation classifies latency, redirects, and reachability", () => {
  const evaluateFeedHealth = ({ statusCode, latencyMs, isPermanentRedirect, redirectedUrl, isXmlValid }) => {
    if (statusCode === 0 || statusCode >= 400) {
      return { status: "Unreachable", message: `HTTP error ${statusCode || "timeout"}` };
    }
    if (isPermanentRedirect || (redirectedUrl && statusCode >= 300 && statusCode < 400)) {
      return { status: "Redirected", message: "Permanent redirect to canonical URL" };
    }
    if (!isXmlValid || latencyMs > 3000) {
      return { status: "Degraded", message: latencyMs > 3000 ? "High latency" : "Invalid XML" };
    }
    return { status: "Healthy", message: "Feed healthy" };
  };

  const healthy = evaluateFeedHealth({
    statusCode: 200,
    latencyMs: 145,
    isPermanentRedirect: false,
    redirectedUrl: null,
    isXmlValid: true,
  });
  assert.equal(healthy.status, "Healthy");

  const redirected = evaluateFeedHealth({
    statusCode: 301,
    latencyMs: 80,
    isPermanentRedirect: true,
    redirectedUrl: "https://example.com/rss.xml",
    isXmlValid: true,
  });
  assert.equal(redirected.status, "Redirected");

  const degraded = evaluateFeedHealth({
    statusCode: 200,
    latencyMs: 3500,
    isPermanentRedirect: false,
    redirectedUrl: null,
    isXmlValid: true,
  });
  assert.equal(degraded.status, "Degraded");

  const unreachable = evaluateFeedHealth({
    statusCode: 404,
    latencyMs: 200,
    isPermanentRedirect: false,
    redirectedUrl: null,
    isXmlValid: false,
  });
  assert.equal(unreachable.status, "Unreachable");
});
