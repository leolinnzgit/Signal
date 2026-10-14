import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/article-share.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const sharing = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const data = {
  title: "Signal story",
  text: "Signal story — Publisher",
  url: "https://example.com/story",
};

test("uses the native share sheet when available", async () => {
  const shared = [];
  const result = await sharing.shareArticle(data, {
    async share(value) {
      shared.push(value);
    },
  });

  assert.equal(result, "shared");
  assert.deepEqual(shared, [data]);
});

test("copies the story URL when native sharing fails", async () => {
  const copied = [];
  const result = await sharing.shareArticle(data, {
    async share() {
      throw new Error("sharing unavailable");
    },
    clipboard: {
      async writeText(value) {
        copied.push(value);
      },
    },
  });

  assert.equal(result, "copied");
  assert.deepEqual(copied, [data.url]);
});

test("reports failure when neither sharing nor copying works", async () => {
  assert.equal(await sharing.shareArticle(data, {}), "failed");
});

test("resolves the publisher URL before sharing", async () => {
  const requested = [];
  const resolved = await sharing.resolveArticleShareUrl(
    "https://news.example.test/story-1",
    async (url, init) => {
      requested.push({ url, init });
      return {
        ok: true,
        async json() {
          return { url: "https://publisher.example.test/news/story-1" };
        },
      };
    },
  );

  assert.equal(resolved, "https://publisher.example.test/news/story-1");
  assert.match(requested[0].url, /^\/api\/article-reader\/resolve\?url=/);
  assert.equal(requested[0].init.credentials, "same-origin");
});

test("falls back to the stored URL when resolution fails", async () => {
  const storedUrl = "https://news.example.test/story-2";
  const resolved = await sharing.resolveArticleShareUrl(storedUrl, async () => {
    throw new Error("publisher unavailable");
  });

  assert.equal(resolved, storedUrl);
});

test("rejects a resolved URL that is not HTTPS", async () => {
  const storedUrl = "https://news.example.test/story-3";
  const resolved = await sharing.resolveArticleShareUrl(storedUrl, async () => ({
    ok: true,
    async json() {
      return { url: "http://publisher.example.test/story-3" };
    },
  }));

  assert.equal(resolved, storedUrl);
});

test("saves the exact translated text using the authenticated share endpoint", async () => {
  const calls = [];
  const snapshot = { title: "中文标题", paragraphs: ["第一段。", "第二段。"], language: "zh-Hans", byline: "Author" };
  const saved = { path: `/shared/${"a".repeat(48)}`, title: snapshot.title, language: snapshot.language, summaryOnly: false };
  const result = await sharing.createHostedArticleShare({ url: data.url, title: data.title, source: "Publisher", summary: "Summary" }, snapshot,
    async (input, init) => {
      calls.push({ input, init });
      return { ok: true, async json() { return calls.length === 1 ? { token: "test-csrf" } : saved; } };
    });
  assert.deepEqual(result, saved);
  assert.equal(calls[1].input, "/api/article-shares");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.credentials, "same-origin");
  assert.equal(calls[1].init.headers["X-XSRF-TOKEN"], "test-csrf");
  assert.deepEqual(JSON.parse(calls[1].init.body).snapshot, snapshot);
});

test("does not create a share without a CSRF token", async () => {
  let calls = 0;
  await assert.rejects(sharing.createHostedArticleShare({ ...data, source: "Publisher", summary: "" }, undefined,
    async () => { calls++; return { ok: true, async json() { return {}; } }; }), /Sign in again/);
  assert.equal(calls, 1);
});

test("does not silently fall back to the publisher link when saving fails", async () => {
  await assert.rejects(sharing.createHostedArticleShare({ ...data, source: "Publisher", summary: "" }, undefined,
    async (input) => ({ ok: input.includes("csrf"), async json() { return input.includes("csrf") ? { token: "test" } : { error: "Story could not be saved" }; } })),
    /Story could not be saved/);
});

test("rejects external and malformed hosted page paths", async () => {
  for (const path of ["https://other.example/story", "//other.example/story", "/shared/invalid", "/api/auth/logout"]) {
    await assert.rejects(sharing.createHostedArticleShare({ ...data, source: "Publisher", summary: "" }, undefined,
      async (input) => ({ ok: true, async json() { return input.includes("csrf") ? { token: "test" } : { path, title: data.title, language: "", summaryOnly: false }; } })),
      /incomplete story link/);
  }
});
