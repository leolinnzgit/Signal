import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpiled = ts.transpileModule(
  await readFile(new URL("../app/word-lookup.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

const {
  extractLookupSelection,
  extractSelectionContext,
  computePopoverPosition,
  fetchWordLookup,
  clearWordLookupCache,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

test("extractLookupSelection cleans punctuation and rejects invalid highlights", () => {
  assert.equal(extractLookupSelection('  "sovereignty,"  '), "sovereignty");
  assert.equal(extractLookupSelection("co-operation's"), "co-operation's");
  assert.equal(extractLookupSelection("central bank rate"), "central bank rate");
  assert.equal(extractLookupSelection("通貨膨脹。"), "通貨膨脹");
  assert.equal(extractLookupSelection(""), null);
  assert.equal(extractLookupSelection("   ...   "), null);
  assert.equal(extractLookupSelection("12,345"), null);
  assert.equal(extractLookupSelection("line one\nline two"), null);
  assert.equal(extractLookupSelection("one two three four five six seven"), null);
  assert.equal(extractLookupSelection("a".repeat(81)), null);
});

test("extractSelectionContext isolates the enclosing sentence or bounded window", () => {
  const paragraph =
    "Markets opened flat today. Economists warned that persistent stagflation could complicate rate cuts later this year. Energy stocks gained slightly.";
  assert.equal(
    extractSelectionContext(paragraph, "stagflation"),
    "Economists warned that persistent stagflation could complicate rate cuts later this year.",
  );

  const longSentence = `${"alpha ".repeat(35)}targetword ${"omega ".repeat(35)}`;
  const windowSnippet = extractSelectionContext(longSentence, "targetword", 120);
  assert.ok(windowSnippet.length <= 120);
  assert.ok(windowSnippet.includes("targetword"));
});

test("computePopoverPosition places above by default, flips below near top, and clamps inside viewport", () => {
  const viewport = { width: 1000, height: 700 };
  const size = { width: 280, height: 44 };

  const above = computePopoverPosition(
    { left: 450, top: 200, right: 550, bottom: 220, width: 100, height: 20 },
    viewport,
    size,
  );
  assert.equal(above.placement, "above");
  assert.equal(above.top, 146);
  assert.equal(above.left, 360);

  const flipped = computePopoverPosition(
    { left: 10, top: 20, right: 90, bottom: 40, width: 80, height: 20 },
    viewport,
    size,
  );
  assert.equal(flipped.placement, "below");
  assert.equal(flipped.left, 12);
  assert.equal(flipped.top, 50);

  const rightClamped = computePopoverPosition(
    { left: 950, top: 300, right: 995, bottom: 320, width: 45, height: 20 },
    viewport,
    size,
  );
  assert.equal(rightClamped.left, 708);
});

test("fetchWordLookup sends CSRF + payload, caches successful results, and maps HTTP errors", async () => {
  clearWordLookupCache();
  const calls = [];
  const signal = new AbortController().signal;

  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/auth/csrf") {
      return new Response(JSON.stringify({ token: "csrf-lookup-token" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        available: true,
        reason: "",
        word: "resilience",
        mode: "english",
        phonetic: "/ɹɪˈzɪliəns/",
        meanings: [{ partOfSpeech: "noun", definitions: ["Capacity to recover quickly."] }],
        contextNote: null,
        chineseSimplified: null,
        chineseTraditional: null,
        pinyin: null,
        chineseSenses: [],
        source: "Dictionary",
      }),
      { status: 200 },
    );
  };

  const result = await fetchWordLookup("resilience", "english", "Economic resilience grew.", signal, fetcher);
  assert.equal(result.available, true);
  assert.equal(result.meanings[0].definitions[0], "Capacity to recover quickly.");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/api/word-lookup");
  assert.equal(calls[1].options.headers["X-XSRF-TOKEN"], "csrf-lookup-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    word: "resilience",
    mode: "english",
    context: "Economic resilience grew.",
  });

  // Cached second call should not hit network
  const cached = await fetchWordLookup("Resilience", "english", "Economic resilience grew.", signal, fetcher);
  assert.equal(cached.word, "resilience");
  assert.equal(calls.length, 2);

  // Error mappings
  const errorFetcher = (status) => async (url) =>
    new Response(JSON.stringify(url.endsWith("csrf") ? { token: "t" } : {}), {
      status: url.endsWith("csrf") ? 200 : status,
    });

  await assert.rejects(
    fetchWordLookup("tariff", "chinese", undefined, signal, errorFetcher(401)),
    /Sign in/,
  );
  await assert.rejects(
    fetchWordLookup("tariff", "chinese", undefined, signal, errorFetcher(429)),
    /Too many/,
  );
});
