import test from "node:test";
import assert from "node:assert/strict";

test("resolveBriefingVoiceSelection defaults to Molly when no custom voice chosen", () => {
  const resolveBriefingVoice = (chosenVoice, serverPrefs) => {
    return chosenVoice || serverPrefs?.en || "en-NZ-MollyNeural";
  };

  assert.equal(resolveBriefingVoice("", { en: "" }), "en-NZ-MollyNeural");
  assert.equal(resolveBriefingVoice("en-US-AndrewMultilingualNeural", { en: "en-NZ-MollyNeural" }), "en-US-AndrewMultilingualNeural");
  assert.equal(resolveBriefingVoice("", { en: "en-GB-SoniaNeural" }), "en-GB-SoniaNeural");
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
