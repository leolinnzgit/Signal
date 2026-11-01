import test from "node:test";
import assert from "node:assert/strict";
import { interrogateArticle } from "../app/article-interrogation.ts";

test("interrogateArticle posts request and returns Socratic breakdown", async () => {
  const mockFetch = async (url, opts) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "fake-csrf-token" }) };
    }
    assert.equal(url, "/api/article-reader/interrogate");
    assert.equal(opts.method, "POST");
    assert.equal(opts.headers["X-XSRF-TOKEN"], "fake-csrf-token");
    const body = JSON.parse(opts.body);
    assert.equal(body.title, "Treasury Releases Fiscal Update");
    assert.equal(body.question, "What counter-arguments are omitted?");

    return {
      ok: true,
      json: async () => ({
        available: true,
        question: body.question,
        answer: "The reporting focuses on top-line surplus forecasts while omitting potential structural deficits.",
        supportingEvidence: ["Tax revenue jumped 6.4%", "Operating balance rose to $1.2B"],
        omittedPerspectives: ["Long-term healthcare liabilities were not quantified"],
        stakeholderImpact: "Public sector agencies may experience constrained capital allowances.",
        mode: "azure-openai",
      }),
    };
  };

  const res = await interrogateArticle(
    {
      url: "https://example.com/treasury",
      title: "Treasury Releases Fiscal Update",
      source: "RNZ",
      question: "What counter-arguments are omitted?",
    },
    undefined,
    mockFetch,
  );

  assert.equal(res.available, true);
  assert.ok(res.answer.includes("surplus forecasts"));
  assert.equal(res.supportingEvidence.length, 2);
  assert.equal(res.omittedPerspectives.length, 1);
  assert.ok(res.stakeholderImpact.includes("capital allowances"));
});

test("interrogateArticle throws on server error", async () => {
  const mockFetch = async () => ({
    ok: false,
    json: async () => ({ error: "Azure OpenAI quota exceeded" }),
  });

  await assert.rejects(
    interrogateArticle(
      {
        url: "https://example.com/error",
        title: "Test",
        source: "Test",
        question: "Why?",
      },
      undefined,
      mockFetch,
    ),
    /Azure OpenAI quota exceeded/,
  );
});
