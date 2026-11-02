import test from "node:test";
import assert from "node:assert/strict";
import {
  extractQuotes,
  extractQuotesLocally,
} from "../app/quote-extractor.ts";

test("extractQuotesLocally extracts quoted statements and classifies stances", () => {
  const articles = [
    {
      title: "RBNZ Holds Official Cash Rate at 4.25%",
      source: "RNZ News",
      url: "https://rnz.co.nz/story/rbnz-rate",
      summary: "Governor Adrian Orr said: \"We remain cautious regarding underlying service sector inflation risks.\"",
    },
    {
      title: "Treasury Quarterly Fiscal Review",
      source: "NZ Herald",
      url: "https://nzherald.co.nz/story/treasury",
      summary: "Officials declared: \"We will ensure fiscal balance sheets remain aligned with statutory targets.\"",
    },
  ];

  const result = extractQuotesLocally(articles);

  assert.equal(result.available, true);
  assert.ok(result.totalExtracted >= 2);

  const cautiousQuote = result.quotes.find((q) => q.stance === "Cautious");
  assert.ok(cautiousQuote);
  assert.ok(cautiousQuote.quoteText.includes("cautious regarding underlying"));
  assert.equal(cautiousQuote.speaker, "Adrian Orr");

  const assertiveQuote = result.quotes.find((q) => q.stance === "Assertive");
  assert.ok(assertiveQuote);
  assert.ok(assertiveQuote.quoteText.includes("ensure fiscal balance sheets"));
});

test("extractQuotes calls server endpoint and parses response", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/quote-extractor/extract") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          totalExtracted: 1,
          quotes: [
            {
              id: "server-q-1",
              speaker: "Nicola Willis",
              role: "Minister of Finance",
              organization: "NZ Government",
              stance: "Assertive",
              quoteText: "Fiscal discipline remains our core priority.",
              sourceArticleTitle: "Budget Update",
              sourceArticleUrl: "https://example.com/budget",
              publisher: "RNZ",
            },
          ],
          discoveredSpeakers: ["Nicola Willis"],
          extractedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await extractQuotes([], undefined, undefined, mockFetcher);

  assert.equal(res.available, true);
  assert.equal(res.totalExtracted, 1);
  assert.equal(res.quotes[0].speaker, "Nicola Willis");
  assert.equal(res.quotes[0].stance, "Assertive");
});
