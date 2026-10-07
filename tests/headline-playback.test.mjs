import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/headline-playback.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createHeadlinePlayback, headlineSpeechLanguage, headlineVoiceId, selectHeadlineVoice, rankHeadlineVoices, normalizeHeadlineSpeechPreferences, prepareHeadlineSpeechText, shouldPauseHeadlinePlayback } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const voice = (name, lang, extra = {}) => ({ name, lang, voiceURI: name, default: false, ...extra });

function harness({ readAloud = true, supported = true, throwOnSpeak = false, voices = [voice("English", "en-NZ"), voice("Chinese", "zh-CN")], rate, preferredVoiceId, timerEarlyBy = 0, speechState = false } = {}) {
  let now = 0;
  let sequence = 0;
  let advances = 0;
  let errors = 0;
  const timers = new Map();
  const calls = [];
  const utterances = [];
  const speech = {
    ...(speechState ? { speaking: false, pending: false } : {}),
    cancel() { calls.push("cancel"); if (speechState) speech.speaking = false; },
    pause() { calls.push("pause"); },
    resume() { calls.push("resume"); },
    speak(utterance) {
      if (throwOnSpeak) throw new Error("Voice service unavailable");
      utterances.push(utterance);
      if (speechState) speech.speaking = true;
    },
    getVoices: () => voices,
  };
  const runtime = {
    language: "en-NZ",
    speech: supported ? speech : undefined,
    createUtterance: supported ? (text) => ({ text, lang: "", onend: null, onerror: null }) : undefined,
    now: () => now,
    schedule(callback, milliseconds) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + Math.max(0, milliseconds - timerEarlyBy) });
      return id;
    },
    clear: (id) => timers.delete(id),
  };
  const playback = createHeadlinePlayback({
    title: "A new telescope reveals distant galaxies",
    seconds: 6,
    readAloud,
    rate,
    preferredVoiceId,
    onAdvance: () => { advances++; },
    onSpeechError: () => { errors++; },
  }, runtime);
  return {
    playback, runtime, calls, utterances, timers, speech,
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

test("a narrated briefing keeps playing when the page becomes hidden", () => {
  const player = harness();
  const state = { paused: false, pageVisible: true, readAloud: true, voicesReady: true };
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  player.tick(2_000);
  state.pageVisible = false;
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  assert.equal(player.calls.includes("pause"), false);
  assert.equal(player.utterances.length, 1, "switching away must not restart the narration");
  player.utterances[0].onend();
  player.tick(4_000);
  assert.equal(player.advances, 1);
  const next = harness();
  next.playback.setPaused(shouldPauseHeadlinePlayback(state));
  assert.equal(next.utterances.length, 1, "the next headline starts even while hidden");
  next.playback.dispose();
});

test("manual pause still stops background narration until resumed", () => {
  const player = harness();
  const state = { paused: false, pageVisible: false, readAloud: true, voicesReady: true };
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  player.tick(2_000);
  state.paused = true;
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  assert.equal(player.calls.at(-1), "pause");
  player.tick(60_000);
  assert.equal(player.advances, 0);
  state.pageVisible = true;
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  assert.equal(player.calls.at(-1), "pause", "returning to the page must respect manual pause");
  state.paused = false;
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  assert.equal(player.calls.at(-1), "resume");
  assert.equal(player.utterances.length, 1);
  player.playback.dispose();
});

test("muted background playback preserves unseen headlines until the page is visible", () => {
  const player = harness({ readAloud: false });
  const state = { paused: false, pageVisible: true, readAloud: false, voicesReady: true };
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  player.tick(2_000);
  state.pageVisible = false;
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  player.tick(60_000);
  assert.equal(player.advances, 0);
  state.pageVisible = true;
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  player.tick(4_000);
  assert.equal(player.advances, 1);
});

test("background narration waits until voices are ready", () => {
  const player = harness();
  const state = { paused: false, pageVisible: false, readAloud: true, voicesReady: false };
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  player.tick(60_000);
  assert.equal(player.utterances.length, 0);
  assert.equal(player.advances, 0);
  state.voicesReady = true;
  player.playback.setPaused(shouldPauseHeadlinePlayback(state));
  assert.equal(player.utterances.length, 1);
  player.playback.dispose();
});

test("speaks only the current title and waits for long narration before advancing", () => {
  const player = harness();
  assert.equal(player.utterances.length, 0);
  player.playback.setPaused(false);
  assert.equal(player.utterances[0].text, "A new telescope reveals distant galaxies.");
  assert.equal(player.utterances[0].lang, "en-NZ");
  assert.equal(player.utterances[0].rate, 0.95);
  player.tick(10_000);
  assert.equal(player.advances, 0);
  player.utterances[0].onend();
  player.tick(649);
  assert.equal(player.advances, 0);
  player.tick(1);
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
  player.tick(649);
  assert.equal(player.advances, 0);
  player.tick(1);
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

test("prefers enhanced voices over the first matching basic system voice", () => {
  const voices = [voice("Basic", "en-NZ", { default: true }), voice("Google UK English", "en-GB"), voice("Microsoft Jenny Online (Natural)", "en-US"), voice("Chinese Natural", "zh-CN")];
  assert.equal(selectHeadlineVoice(voices, "en-NZ").name, "Microsoft Jenny Online (Natural)");
  assert.equal(selectHeadlineVoice(voices.slice(0, 2), "en-NZ").name, "Google UK English");
  assert.equal(selectHeadlineVoice(voices, "en-NZ", "Basic").name, "Basic");
  assert.equal(selectHeadlineVoice(voices, "en-NZ", "Removed voice").name, "Microsoft Jenny Online (Natural)");
  assert.equal(voices[0].name, "Basic", "ranking must not mutate the browser voice list");
});

test("uses regional matches between equal-quality voices and respects language", () => {
  const voices = [voice("Natural US", "en-US"), voice("Natural UK", "en-GB"), voice("Natural NZ", "en-NZ"), voice("Natural AU", "en-AU"), voice("Mandarin", "zh-CN"), voice("Cantonese Natural", "zh-HK")];
  assert.equal(selectHeadlineVoice(voices, "en-NZ").name, "Natural NZ");
  assert.equal(selectHeadlineVoice(voices, "en_NZ").name, "Natural NZ");
  assert.equal(selectHeadlineVoice(voices, "en-NZ", "Mandarin").name, "Natural NZ");
  assert.deepEqual(rankHeadlineVoices(voices, "zh-CN").map((item) => item.name), ["Mandarin"]);
  assert.deepEqual(rankHeadlineVoices(voices, "zh-HK").map((item) => item.name), ["Cantonese Natural"]);
  assert.equal(selectHeadlineVoice(voices, "fr-FR"), undefined);
  assert.equal(selectHeadlineVoice([], "en-NZ"), undefined);
});

test("passes a saved voice and speaking speed to the speech engine", () => {
  const voices = [voice("Basic", "en-NZ"), voice("Natural", "en-US")];
  const player = harness({ voices, preferredVoiceId: "Basic", rate: 1.1 });
  player.playback.setPaused(false);
  assert.equal(player.utterances[0].voice, voices[0]);
  assert.equal(player.utterances[0].rate, 1.1);
  assert.equal(player.utterances[0].pitch, 1);
  const fallback = harness({ voices: [] });
  fallback.playback.setPaused(false);
  assert.equal(fallback.utterances.length, 1);
  assert.equal(fallback.utterances[0].voice, undefined);
});

test("handles invalid saved settings and limits speaking speeds", () => {
  assert.deepEqual(normalizeHeadlineSpeechPreferences(null), { rate: 0.95, voices: {} });
  assert.deepEqual(normalizeHeadlineSpeechPreferences({ rate: "fast", voices: ["bad"] }), { rate: 0.95, voices: {} });
  assert.equal(normalizeHeadlineSpeechPreferences({ rate: Infinity }).rate, 0.95);
  assert.equal(normalizeHeadlineSpeechPreferences({ rate: 5 }).rate, 1.25);
  assert.equal(normalizeHeadlineSpeechPreferences({ rate: 0 }).rate, 0.7);
  assert.deepEqual(normalizeHeadlineSpeechPreferences({ rate: 1.1, voices: { en: "English", zh: "Chinese", "en-US": "bad key", fr: 42, de: "" } }), { rate: 1.1, voices: { en: "English", zh: "Chinese" } });
});

test("adds sentence endings for smoother delivery without changing existing punctuation", () => {
  assert.equal(prepareHeadlineSpeechText("  A   science headline\n"), "A science headline.");
  assert.equal(prepareHeadlineSpeechText("What comes next?"), "What comes next?");
  assert.equal(prepareHeadlineSpeechText('He said “Welcome!”'), 'He said “Welcome!”');
  assert.equal(prepareHeadlineSpeechText("科學新聞"), "科學新聞。");
  assert.equal(prepareHeadlineSpeechText("科學新聞！"), "科學新聞！");
  assert.equal(prepareHeadlineSpeechText(" "), "");
});

test("pausing during the gap between spoken headlines preserves the remaining gap", () => {
  const player = harness();
  player.playback.setPaused(false);
  player.tick(8_000);
  player.utterances[0].onend();
  player.tick(300);
  player.playback.setPaused(true);
  player.tick(60_000);
  player.playback.setPaused(false);
  player.tick(349);
  assert.equal(player.advances, 0);
  player.tick(1);
  assert.equal(player.advances, 1);
});

test("a timer firing slightly early cannot strand a finished headline", () => {
  const player = harness({ timerEarlyBy: 0.5 });
  player.playback.setPaused(false);
  player.tick(8_000.2);
  player.utterances[0].onend();
  player.tick(651);
  assert.equal(player.advances, 1);
  player.tick(60_000);
  assert.equal(player.advances, 1);
});

test("an early minimum-display timer is rearmed after a short narration", () => {
  const player = harness({ timerEarlyBy: 0.5 });
  player.playback.setPaused(false);
  player.tick(1_000);
  player.utterances[0].onend();
  player.tick(5_001);
  assert.equal(player.advances, 1);
});

test("voices sharing a service URI can each be selected by name and language", () => {
  const voices = [voice("First voice", "en-US", { voiceURI: "shared-service" }), voice("Second voice", "en-GB", { voiceURI: "shared-service" })];
  assert.notEqual(headlineVoiceId(voices[0]), headlineVoiceId(voices[1]));
  for (const selected of voices) {
    assert.equal(selectHeadlineVoice(voices, "en-NZ", headlineVoiceId(selected)), selected);
    const player = harness({ voices, preferredVoiceId: headlineVoiceId(selected) });
    player.playback.setPaused(false);
    assert.equal(player.utterances[0].voice, selected);
    assert.equal(player.utterances[0].lang, selected.lang);
  }
  assert.equal(selectHeadlineVoice(voices, "en-NZ", "shared-service"), voices[1], "legacy saved service URIs remain readable");
});

test("an engine going idle without an end event still advances the briefing", () => {
  const player = harness({ speechState: true });
  player.playback.setPaused(false);
  player.tick(8_000);
  player.speech.speaking = false;
  player.tick(1_149);
  assert.equal(player.advances, 0);
  player.tick(1);
  assert.equal(player.advances, 1);
  assert.equal(player.errors, 0);
  assert.equal(player.timers.size, 0);
});

test("idle checks cannot complete a voice that is still waiting to start", () => {
  const player = harness({ speechState: true });
  player.playback.setPaused(false);
  player.speech.speaking = false;
  player.speech.pending = true;
  player.tick(8_000);
  assert.equal(player.advances, 0);
  player.speech.pending = false;
  player.tick(1_000);
  assert.equal(player.advances, 0);
  player.utterances[0].onstart();
  player.speech.speaking = true;
  player.tick(1_000);
  assert.equal(player.advances, 0);
});

test("missing end-event recovery remains paused until the user resumes", () => {
  const player = harness({ speechState: true });
  player.playback.setPaused(false);
  player.tick(8_000);
  player.playback.setPaused(true);
  player.speech.speaking = false;
  player.tick(60_000);
  assert.equal(player.advances, 0);
  player.playback.setPaused(false);
  player.tick(1_150);
  assert.equal(player.advances, 1);
});

test("short audio finishing between polls is detected through its start event", () => {
  const player = harness({ speechState: true });
  player.playback.setPaused(false);
  player.utterances[0].onstart();
  player.speech.speaking = false;
  player.tick(6_000);
  assert.equal(player.advances, 1);
});
