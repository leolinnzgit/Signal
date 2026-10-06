type SpeechTarget = Pick<SpeechSynthesis, "cancel" | "speak" | "pause" | "resume" | "getVoices">;

export const HEADLINE_SPEECH_PREFERENCES_KEY = "signal-headline-speech-preferences";
export const DEFAULT_HEADLINE_SPEECH_RATE = 0.95;
export const HEADLINE_SPEECH_PAUSE_MS = 650;

export type HeadlineSpeechPreferences = { rate: number; voices: Record<string, string> };

export function normalizeHeadlineSpeechPreferences(value: unknown): HeadlineSpeechPreferences {
  const saved = value && typeof value === "object" ? value as Partial<HeadlineSpeechPreferences> : {};
  const rate = typeof saved.rate === "number" && Number.isFinite(saved.rate)
    ? Math.min(1.25, Math.max(0.7, saved.rate))
    : DEFAULT_HEADLINE_SPEECH_RATE;
  const voices = saved.voices && typeof saved.voices === "object" && !Array.isArray(saved.voices)
    ? Object.fromEntries(Object.entries(saved.voices).filter(([language, uri]) =>
        /^[a-z]{2,3}$/.test(language) && typeof uri === "string" && uri.length > 0))
    : {};
  return { rate, voices };
}

function normalizeVoiceLanguage(language: string) {
  return language.toLowerCase().replaceAll("_", "-");
}

export function rankHeadlineVoices(voices: SpeechSynthesisVoice[], language: string) {
  const desired = normalizeVoiceLanguage(language);
  const base = desired.split("-")[0];
  const relatedEnglish = /^(en-nz|en-au|en-gb)$/.test(desired) ? ["en-au", "en-gb", "en-us"] : ["en-us", "en-gb", "en-au"];
  function score(voice: SpeechSynthesisVoice) {
    const lang = normalizeVoiceLanguage(voice.lang);
    // Names are quality hints, not a guarantee about the underlying voice engine.
    const quality = /natural|neural|premium|enhanced/i.test(voice.name) ? 1_000
      : /google|microsoft.*online/i.test(voice.name) ? 500 : 0;
    const regional = lang === desired ? 40
      : base === "en" && relatedEnglish.includes(lang) ? 30 - relatedEnglish.indexOf(lang) * 5 : 0;
    return quality + regional + (voice.default ? 1 : 0);
  }
  return voices.filter((voice) => {
    const lang = normalizeVoiceLanguage(voice.lang);
    if (lang.split("-")[0] !== base) return false;
    // A Cantonese voice should not automatically read a Mandarin headline.
    return base !== "zh" || desired.startsWith("zh-hk") === lang.startsWith("zh-hk");
  }).sort((left, right) => score(right) - score(left) || left.name.localeCompare(right.name));
}

export function selectHeadlineVoice(voices: SpeechSynthesisVoice[], language: string, preferredVoiceURI = "") {
  const ranked = rankHeadlineVoices(voices, language);
  return ranked.find((voice) => voice.voiceURI === preferredVoiceURI) ?? ranked[0];
}

export function prepareHeadlineSpeechText(title: string) {
  const text = title.replace(/\s+/g, " ").trim();
  if (!text || /[.!?。！？]["'”’]*$/.test(text)) return text;
  return `${text}${/\p{Script=Han}/u.test(text) ? "。" : "."}`;
}

export type HeadlinePlaybackRuntime = {
  speech?: SpeechTarget;
  createUtterance?: (text: string) => SpeechSynthesisUtterance;
  language: string;
  now: () => number;
  schedule: (callback: () => void, milliseconds: number) => number;
  clear: (id: number) => void;
};

export function headlineSpeechLanguage(title: string, preferredLanguage: string) {
  if (/\p{Script=Han}/u.test(title)) {
    return preferredLanguage.toLowerCase().startsWith("zh") ? preferredLanguage : "zh-CN";
  }
  return preferredLanguage.toLowerCase().startsWith("en") ? preferredLanguage : "en";
}

export function createHeadlinePlayback(
  options: { title: string; seconds: number; readAloud: boolean; preferredVoiceURI?: string; rate?: number; onAdvance: () => void; onSpeechError: () => void },
  runtime: HeadlinePlaybackRuntime,
) {
  let paused = true;
  let disposed = false;
  let advanced = false;
  let displayDuration = options.seconds * 1_000;
  const speechDuration = Math.max(30_000, options.title.length * 150);
  let playedMilliseconds = 0;
  let startedAt = 0;
  let displayTimer: number | undefined;
  let speechTimer: number | undefined;
  let utterance: SpeechSynthesisUtterance | undefined;
  let speechFinished = !options.readAloud || !runtime.speech || !runtime.createUtterance;
  let speechEndedAt: number | undefined;

  function elapsed() {
    return playedMilliseconds + (paused ? 0 : runtime.now() - startedAt);
  }

  function advanceIfReady() {
    if (disposed || paused || advanced || elapsed() < advanceAt() || !speechFinished) return;
    advanced = true;
    options.onAdvance();
  }

  function advanceAt() {
    return Math.max(displayDuration, speechEndedAt === undefined ? 0 : speechEndedAt + HEADLINE_SPEECH_PAUSE_MS);
  }

  function scheduleAdvance() {
    if (displayTimer !== undefined) runtime.clear(displayTimer);
    displayTimer = runtime.schedule(advanceIfReady, Math.max(0, advanceAt() - elapsed()));
  }

  function finishSpeech(failed = false) {
    if (disposed || speechFinished) return;
    speechFinished = true;
    if (!failed) speechEndedAt = elapsed();
    if (speechTimer !== undefined) runtime.clear(speechTimer);
    if (utterance) { utterance.onend = null; utterance.onerror = null; }
    if (failed) {
      runtime.speech?.cancel();
      options.onSpeechError();
    }
    if (!paused) scheduleAdvance();
    advanceIfReady();
  }

  function startTimers() {
    startedAt = runtime.now();
    scheduleAdvance();
    if (!speechFinished) {
      // A failed or silent voice service must not leave the briefing stuck.
      speechTimer = runtime.schedule(() => finishSpeech(true), Math.max(0, speechDuration - playedMilliseconds));
    }
  }

  return {
    setPaused(nextPaused: boolean) {
      if (disposed || advanced || nextPaused === paused) return;
      if (nextPaused) {
        playedMilliseconds = elapsed();
        paused = true;
        if (displayTimer !== undefined) runtime.clear(displayTimer);
        if (speechTimer !== undefined) runtime.clear(speechTimer);
        if (utterance && !speechFinished) runtime.speech?.pause();
        return;
      }
      paused = false;
      startTimers();
      if (!speechFinished && runtime.speech && runtime.createUtterance) {
        try {
          if (utterance) {
            runtime.speech.resume();
          } else {
            utterance = runtime.createUtterance(prepareHeadlineSpeechText(options.title));
            utterance.lang = headlineSpeechLanguage(options.title, runtime.language);
            utterance.rate = normalizeHeadlineSpeechPreferences({ rate: options.rate }).rate;
            utterance.pitch = 1;
            const voices = runtime.speech.getVoices();
            const voice = selectHeadlineVoice(voices, utterance.lang, options.preferredVoiceURI);
            if (voice) utterance.voice = voice;
            utterance.onend = () => finishSpeech();
            utterance.onerror = () => finishSpeech(true);
            runtime.speech.cancel();
            runtime.speech.resume();
            runtime.speech.speak(utterance);
          }
        } catch {
          finishSpeech(true);
        }
      }
      advanceIfReady();
    },
    setSeconds(seconds: number) {
      if (disposed || advanced || displayDuration === seconds * 1_000) return;
      displayDuration = seconds * 1_000;
      if (!paused) {
        scheduleAdvance();
        advanceIfReady();
      }
    },
    dispose() {
      disposed = true;
      if (displayTimer !== undefined) runtime.clear(displayTimer);
      if (speechTimer !== undefined) runtime.clear(speechTimer);
      if (utterance) {
        utterance.onend = null;
        utterance.onerror = null;
        runtime.speech?.cancel();
      }
    },
  };
}
