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
