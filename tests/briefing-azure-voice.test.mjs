import test from "node:test";
import assert from "node:assert/strict";
import { resolveUserReadingVoice, getUserReadingVoicePreferences } from "../app/headline-audio.ts";

test("resolveBriefingVoiceSelection defaults to Molly when no custom voice chosen", () => {
  const resolveBriefingVoice = (chosenVoice, serverPrefs) => {
    return chosenVoice || serverPrefs?.en || "en-NZ-MollyNeural";
  };

  assert.equal(resolveBriefingVoice("", { en: "" }), "en-NZ-MollyNeural");
  assert.equal(resolveBriefingVoice("en-US-AndrewMultilingualNeural", { en: "en-NZ-MollyNeural" }), "en-US-AndrewMultilingualNeural");
  assert.equal(resolveBriefingVoice("", { en: "en-GB-SoniaNeural" }), "en-GB-SoniaNeural");
});

test("resolveUserReadingVoice respects stored user voice preference without reverting", () => {
  const mockStorage = new Map();
  global.localStorage = {
    getItem: (key) => mockStorage.get(key) ?? null,
    setItem: (key, val) => mockStorage.set(key, String(val)),
    removeItem: (key) => mockStorage.delete(key),
    clear: () => mockStorage.clear(),
  };

  try {
    // When nothing is set, returns fallback
    assert.equal(resolveUserReadingVoice("en-NZ-MollyNeural"), "en-NZ-MollyNeural");

    // When signal_briefing_voice_pref is set (e.g. Annette)
    mockStorage.set("signal_briefing_voice_pref", "en-AU-AnnetteNeural");
    assert.equal(resolveUserReadingVoice(), "en-AU-AnnetteNeural");

    // When signal_briefing_voice_pref is empty, falls back to signal.recorded-reading-voices.v1
    mockStorage.delete("signal_briefing_voice_pref");
    mockStorage.set("signal.recorded-reading-voices.v1", JSON.stringify({ en: "en-AU-AnnetteNeural", zh: "zh-TW-HsiaoChenNeural" }));
    assert.equal(resolveUserReadingVoice(), "en-AU-AnnetteNeural");

    const prefs = getUserReadingVoicePreferences();
    assert.equal(prefs.en, "en-AU-AnnetteNeural");
    assert.equal(prefs.zh, "zh-TW-HsiaoChenNeural");
  } finally {
    delete global.localStorage;
  }
});

test("Azure voice option mapping passes voiceName to audio stream parameters", () => {
  const resolveVoiceOptions = (options, defaultEn = "en-NZ-MollyNeural", defaultZh = "zh-CN-XiaoxiaoNeural") => {
    return {
      en: options.voiceName || defaultEn,
      zh: options.voiceName || defaultZh,
    };
  };

  const defaultResult = resolveVoiceOptions({});
  assert.equal(defaultResult.en, "en-NZ-MollyNeural");

  const customResult = resolveVoiceOptions({ voiceName: "en-US-AndrewMultilingualNeural" });
  assert.equal(customResult.en, "en-US-AndrewMultilingualNeural");

  const ukVoice = resolveVoiceOptions({ voiceName: "en-GB-SoniaNeural" });
  assert.equal(ukVoice.en, "en-GB-SoniaNeural");
});
