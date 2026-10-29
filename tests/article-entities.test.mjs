import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/article-entities.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { getEntityIcon, loadArticleEntities } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("getEntityIcon maps known categories to distinctive emojis and unknown to generic tag", () => {
  assert.equal(getEntityIcon("Person"), "👤");
  assert.equal(getEntityIcon("ORGANIZATION"), "🏢");
  assert.equal(getEntityIcon("Location"), "📍");
  assert.equal(getEntityIcon("Product"), "📦");
  assert.equal(getEntityIcon("Event"), "📅");
  assert.equal(getEntityIcon("Skill"), "💡");
  assert.equal(getEntityIcon("Quantity"), "🏷️");
  assert.equal(getEntityIcon("UnknownCategory"), "🏷️");
});

test("loadArticleEntities requests CSRF token and POSTs article details", async () => {
  const calls = [];
  const fakeFetcher = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input) === "/api/auth/csrf") {
      return {
        ok: true,
        json: async () => ({ token: "csrf-token-123" }),
      };
    }
    if (String(input) === "/api/article-entities") {
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers?.["X-XSRF-TOKEN"], "csrf-token-123");
      const parsedBody = JSON.parse(init?.body);
      assert.equal(parsedBody.url, "https://example.com/story");
      assert.equal(parsedBody.title, "Satya Nadella talks Azure");
      assert.deepEqual(parsedBody.paragraphs, ["Microsoft announced new cloud AI advancements."]);
      return {
        ok: true,
        json: async () => ({
          available: true,
          reason: "",
          entities: [
            { text: "Satya Nadella", category: "Person", confidenceScore: 0.98 },
            { text: "Microsoft", category: "Organization", confidenceScore: 0.99 },
          ],
        }),
      };
    }
    throw new Error(`Unexpected url: ${input}`);
  };

  const result = await loadArticleEntities(
    "https://example.com/story",
    "Satya Nadella talks Azure",
    ["Microsoft announced new cloud AI advancements."],
    undefined,
    fakeFetcher
  );

  assert.equal(result.available, true);
  assert.equal(result.entities.length, 2);
  assert.equal(result.entities[0].text, "Satya Nadella");
  assert.equal(result.entities[1].text, "Microsoft");
  assert.equal(calls.length, 2);
});

test("loadArticleEntities handles 429 rate limit gracefully", async () => {
  const fakeFetcher = async (input) => {
    if (String(input) === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "csrf-token-123" }) };
    }
    return { ok: false, status: 429 };
  };

  await assert.rejects(
    async () => {
      await loadArticleEntities("https://example.com/story", "Title", [], undefined, fakeFetcher);
    },
    /Too many entity extraction requests/
  );
});

test("loadArticleEntities handles CSRF failure", async () => {
  const fakeFetcher = async () => ({ ok: false, status: 401 });

  await assert.rejects(
    async () => {
      await loadArticleEntities("https://example.com/story", "Title", [], undefined, fakeFetcher);
    },
    /Sign in again/
  );
});
