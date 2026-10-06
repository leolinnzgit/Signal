import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/headline-playback.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createHeadlinePlayback, headlineSpeechLanguage } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function harness({ readAloud = true, supported = true, throwOnSpeak = false } = {}) {
  let now = 0;
  let sequence = 0;
  let advances = 0;
  let errors = 0;
  const timers = new Map();
  const calls = [];
  const utterances = [];
  const speech = {
    cancel() { calls.push("cancel"); },
    pause() { calls.push("pause"); },
    resume() { calls.push("resume"); },
    speak(utterance) {
      if (throwOnSpeak) throw new Error("Voice service unavailable");
      utterances.push(utterance);
    },
    getVoices: () => [{ lang: "en-NZ" }, { lang: "zh-CN" }],
  };
  const runtime = {
    language: "en-NZ",
    speech: supported ? speech : undefined,
    createUtterance: supported ? (text) => ({ text, lang: "", onend: null, onerror: null }) : undefined,
    now: () => now,
    schedule(callback, milliseconds) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + milliseconds });
      return id;
    },
    clear: (id) => timers.delete(id),
  };
  const playback = createHeadlinePlayback({
    title: "A new telescope reveals distant galaxies",
    seconds: 6,
    readAloud,
    onAdvance: () => { advances++; },
    onSpeechError: () => { errors++; },
  }, runtime);
  return {
    playback, runtime, calls, utterances, timers,
    get advances() { return advances; },
    get errors() { return errors; },
    tick(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

test("speaks only the current title and waits for long narration before advancing", () => {
  const player = harness();
  assert.equal(player.utterances.length, 0);
  player.playback.setPaused(false);
  assert.equal(player.utterances[0].text, "A new telescope reveals distant galaxies");
  assert.equal(player.utterances[0].lang, "en-NZ");
  player.tick(10_000);
  assert.equal(player.advances, 0);
  player.utterances[0].onend();
  assert.equal(player.advances, 1);
});

test("keeps short spoken titles visible for the selected minimum duration", () => {
  const player = harness();
  player.playback.setPaused(false);
  player.tick(1_000);
  player.utterances[0].onend();
  player.tick(4_999);
  assert.equal(player.advances, 0);
  player.tick(1);
  assert.equal(player.advances, 1);
});

test("pause stops voice and timing, and resume preserves progress without repeating the title", () => {
  const player = harness();
  player.playback.setPaused(false);
  player.tick(2_000);
  player.playback.setPaused(true);
  assert.equal(player.calls.at(-1), "pause");
  player.tick(60_000);
  assert.equal(player.advances, 0);
  player.playback.setPaused(false);
  assert.equal(player.calls.at(-1), "resume");
  assert.equal(player.utterances.length, 1);
  player.utterances[0].onend();
  player.tick(3_999);
  assert.equal(player.advances, 0);
  player.tick(1);
  assert.equal(player.advances, 1);
});

test("speech ending while paused cannot advance the briefing", () => {
  const player = harness();
  player.playback.setPaused(false);
  player.tick(7_000);
  player.playback.setPaused(true);
  player.utterances[0].onend();
  assert.equal(player.advances, 0);
  player.playback.setPaused(false);
  assert.equal(player.advances, 1);
});

test("changing the title interval preserves narration and updates its minimum display time", () => {
  const player = harness();
  player.playback.setPaused(false);
  player.tick(2_000);
  player.playback.setSeconds(10);
  assert.equal(player.utterances.length, 1);
  player.utterances[0].onend();
  player.tick(7_999);
  assert.equal(player.advances, 0);
  player.tick(1);
  assert.equal(player.advances, 1);
});

test("changing the interval after its timer expires accounts for elapsed narration time", () => {
  const player = harness();
  player.playback.setPaused(false);
  player.tick(8_000);
  player.playback.setSeconds(10);
  player.utterances[0].onend();
  player.tick(1_999);
  assert.equal(player.advances, 0);
  player.tick(1);
  assert.equal(player.advances, 1);
});

test("closing or skipping cancels speech, timers, and stale completion callbacks", () => {
  const player = harness();
  player.playback.setPaused(false);
  const end = player.utterances[0].onend;
  const error = player.utterances[0].onerror;
  player.playback.dispose();
  assert.equal(player.calls.at(-1), "cancel");
  assert.equal(player.timers.size, 0);
  end();
  error();
  player.tick(60_000);
  assert.equal(player.advances, 0);
  assert.equal(player.errors, 0);
});

for (const options of [{ readAloud: false }, { supported: false }]) {
  test(`silent playback uses the timer (${JSON.stringify(options)})`, () => {
    const player = harness(options);
    player.playback.setPaused(false);
    player.tick(6_000);
    assert.equal(player.utterances.length, 0);
    assert.equal(player.advances, 1);
    assert.equal(player.errors, 0);
  });
}

test("voice errors fall back to timing without advancing twice", () => {
  const player = harness();
  player.playback.setPaused(false);
  const error = player.utterances[0].onerror;
  error();
  error();
  player.tick(60_000);
  assert.equal(player.errors, 1);
  assert.equal(player.advances, 1);
});

test("an unavailable voice service cannot block the briefing", () => {
  const player = harness({ throwOnSpeak: true });
  player.playback.setPaused(false);
  player.tick(6_000);
  assert.equal(player.errors, 1);
  assert.equal(player.advances, 1);
});

test("a voice service that never signals completion times out safely", () => {
  const player = harness();
  player.playback.setPaused(false);
  player.tick(30_000);
  assert.equal(player.errors, 1);
  assert.equal(player.advances, 1);
  assert.equal(player.calls.at(-1), "cancel");
});

test("selects English or Chinese voices according to the headline", () => {
  assert.equal(headlineSpeechLanguage("Science news", "en-NZ"), "en-NZ");
  assert.equal(headlineSpeechLanguage("Science news", "zh-TW"), "en");
  assert.equal(headlineSpeechLanguage("科學新聞", "zh-TW"), "zh-TW");
  assert.equal(headlineSpeechLanguage("科學新聞", "en-NZ"), "zh-CN");
});
