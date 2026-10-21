type SpeechTarget = Pick<SpeechSynthesis, "cancel" | "speak" | "pause" | "resume" | "getVoices"> & Partial<Pick<SpeechSynthesis, "speaking" | "pending" | "paused">>;

export const HEADLINE_SPEECH_PREFERENCES_KEY = "signal-headline-speech-preferences";
export const DEFAULT_HEADLINE_SPEECH_RATE = 0.95;
export const HEADLINE_SPEECH_PAUSE_MS = 650;
export const DEVICE_DEFAULT_SPEECH_VOICE = "device-default";

export function browserSpeechErrorMessage(reason: string) {
  switch (reason) {
    case "synthesis-unavailable": return "Your device did not provide a speech engine. Enable a text-to-speech voice in your phone settings, or use Recorded audio.";
    case "language-unavailable": return "The device has no working voice for this language. Try Device default or another Reading voice.";
    case "voice-unavailable": return "The selected voice is unavailable on this device. Try Device default or another Reading voice.";
    case "network": return "The selected voice could not connect to its speech service. Try Device default or Recorded audio.";
    case "not-allowed": return "The app blocked browser speech. Tap Play again; if it still fails, open Signal in your browser or use Recorded audio.";
    case "audio-busy": return "The device could not access its audio output. Stop other audio or calls, then tap Play.";
    case "audio-hardware": return "The device could not find an audio output. Check the speaker or headphones, or try Recorded audio.";
    case "start-timeout": return "The device did not start its browser voice. Try Device default or Recorded audio.";
    case "speech-timeout": return "The browser voice stopped responding. Tap Play to retry, try Device default, or use Recorded audio.";
    case "canceled": case "interrupted": return "The device stopped browser reading. Tap Play to retry.";
    default: return "The device could not play its browser voice. Try Device default, another Reading voice, or Recorded audio.";
  }
}

export function browserSpeechRequiresTap(userAgent: string, maxTouchPoints = 0) {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

export type HeadlineSpeechPreferences = { rate: number; voices: Record<string, string> };

export function shouldPauseHeadlinePlayback({ paused, pageVisible, readAloud, voicesReady }: {
  paused: boolean;
  pageVisible: boolean;
  readAloud: boolean;
  voicesReady: boolean;
}) {
  // Spoken briefings can continue out of view; silent ones should not consume unseen stories.
  return paused || !voicesReady || (!pageVisible && !readAloud);
}

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

export function headlineVoiceId(voice: SpeechSynthesisVoice) {
  // Some engines expose several named voices through the same service URI.
  return JSON.stringify([voice.voiceURI, voice.name, normalizeVoiceLanguage(voice.lang)]);
}

export function findPreferredHeadlineVoice(voices: SpeechSynthesisVoice[], preferredVoiceId: string) {
  if (!preferredVoiceId) return undefined;
  return voices.find((voice) => headlineVoiceId(voice) === preferredVoiceId)
    // Keep previously saved URI-only preferences usable.
    ?? voices.find((voice) => voice.voiceURI === preferredVoiceId);
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

export function selectHeadlineVoice(voices: SpeechSynthesisVoice[], language: string, preferredVoiceId = "", preferDeviceVoice = false) {
  if (preferredVoiceId === DEVICE_DEFAULT_SPEECH_VOICE) return undefined;
  const ranked = rankHeadlineVoices(voices, language);
  return findPreferredHeadlineVoice(ranked, preferredVoiceId)
    ?? (preferDeviceVoice ? ranked.find((voice) => voice.default) ?? ranked.find((voice) => voice.localService) : undefined)
    ?? ranked[0];
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
  preferDeviceVoice?: boolean;
  restartOnResume?: boolean;
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
  options: { title: string; seconds: number; readAloud: boolean; preferredVoiceId?: string; rate?: number; onAdvance: () => void; onSpeechError: (reason: string) => void; onSpeechStart?: () => void },
  runtime: HeadlinePlaybackRuntime,
) {
  let paused = true;
  let disposed = false;
  let advanced = false;
  let displayDuration = options.seconds * 1_000;
  const speechDuration = Math.max(30_000, options.title.length * 150);
  let playedMilliseconds = 0;
  let speechBudget = speechDuration;
  let speechAttemptAt = 0;
  let startedAt = 0;
  let displayTimer: number | undefined;
  let speechTimer: number | undefined;
  let speechPollTimer: number | undefined;
  let utterance: SpeechSynthesisUtterance | undefined;
  let speechFinished = !options.readAloud || !runtime.speech || !runtime.createUtterance;
  let speechEndedAt: number | undefined;
  let speechObserved = false;
  let idleChecks = 0;

  function elapsed() {
    return playedMilliseconds + (paused ? 0 : runtime.now() - startedAt);
  }

  function advanceIfReady() {
    if (disposed || paused || advanced || elapsed() < advanceAt() || !speechFinished) return;
    advanced = true;
    clearTimers();
    options.onAdvance();
  }

  function advanceAt() {
    return Math.max(displayDuration, speechEndedAt === undefined ? 0 : speechEndedAt + HEADLINE_SPEECH_PAUSE_MS);
  }

  function scheduleAdvance() {
    if (displayTimer !== undefined) runtime.clear(displayTimer);
    displayTimer = runtime.schedule(() => {
      displayTimer = undefined;
      if (disposed || paused || advanced) return;
      // Browser timeouts round fractional delays and may fire before the deadline.
      if (elapsed() < advanceAt()) scheduleAdvance();
      else advanceIfReady();
    }, Math.max(1, Math.ceil(advanceAt() - elapsed())));
  }

  function clearTimers() {
    for (const timer of [displayTimer, speechTimer, speechPollTimer]) {
      if (timer !== undefined) runtime.clear(timer);
    }
    displayTimer = speechTimer = speechPollTimer = undefined;
  }

  function observeSpeech() {
    if (disposed || speechFinished) return;
    if (!speechObserved) options.onSpeechStart?.();
    speechObserved = true;
    idleChecks = 0;
  }

  function pollSpeech() {
    speechPollTimer = undefined;
    if (disposed || paused || speechFinished) return;
    const speech = runtime.speech;
    if (typeof speech?.speaking !== "boolean" || typeof speech.pending !== "boolean") return;
    if (!speechObserved && !speech.speaking && runtime.now() - speechAttemptAt >= 10_000) {
      finishSpeech("start-timeout");
      return;
    }
    if (speech.speaking) observeSpeech();
    else if (speech.pending) idleChecks = 0;
    else if (speechObserved && ++idleChecks >= 2) {
      // Recover when the engine finishes audio but loses its utterance end event.
      finishSpeech();
      return;
    }
    speechPollTimer = runtime.schedule(pollSpeech, 250);
  }

  function finishSpeech(reason?: string) {
    if (disposed || speechFinished) return;
    speechFinished = true;
    if (!reason) speechEndedAt = elapsed();
    if (speechTimer !== undefined) runtime.clear(speechTimer);
    if (speechPollTimer !== undefined) runtime.clear(speechPollTimer);
    if (utterance) { utterance.onend = null; utterance.onerror = null; utterance.onstart = null; utterance.onboundary = null; }
    if (reason) {
      runtime.speech?.cancel();
      options.onSpeechError(reason);
    }
    if (!paused) scheduleAdvance();
    advanceIfReady();
  }

  function startTimers() {
    startedAt = runtime.now();
    scheduleAdvance();
    if (!speechFinished) {
      // A failed or silent voice service must not leave the briefing stuck.
      speechTimer = runtime.schedule(() => finishSpeech("speech-timeout"), Math.max(0, speechBudget - playedMilliseconds));
      speechPollTimer = runtime.schedule(pollSpeech, 250);
    }
  }

  return {
    setPaused(nextPaused: boolean) {
      if (disposed || advanced || nextPaused === paused) return;
      if (nextPaused) {
        playedMilliseconds = elapsed();
        paused = true;
        clearTimers();
        idleChecks = 0;
        if (utterance && !speechFinished) {
          if (runtime.restartOnResume) {
            // Android's native pause stops speech; its resume implementation does nothing.
            utterance.onend = utterance.onerror = utterance.onstart = utterance.onboundary = null;
            runtime.speech?.cancel();
            utterance = undefined;
            speechObserved = false;
            speechBudget = playedMilliseconds + speechDuration;
          } else runtime.speech?.pause();
        }
        return;
      }
      paused = false;
      speechAttemptAt = runtime.now();
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
            const voice = selectHeadlineVoice(voices, utterance.lang, options.preferredVoiceId, runtime.preferDeviceVoice);
            if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
            if (options.preferredVoiceId === DEVICE_DEFAULT_SPEECH_VOICE) utterance.lang = "";
            utterance.volume = 1;
            utterance.onstart = observeSpeech;
            utterance.onboundary = observeSpeech;
            utterance.onend = () => finishSpeech();
            utterance.onerror = (event) => finishSpeech(event?.error || "unknown");
            // Avoid cancelling an idle engine immediately before speech: older WebKit
            // versions can apply the asynchronous cancellation to the new utterance.
            if ((runtime.speech.speaking ?? true) || runtime.speech.pending || runtime.speech.paused) runtime.speech.cancel();
            runtime.speech.speak(utterance);
            // A paused native engine may have no current utterance until speak queues one.
            // Resume afterwards, while still inside the user's tap.
            if (!disposed && !speechFinished) runtime.speech.resume();
          }
        } catch {
          finishSpeech("speech-exception");
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
      clearTimers();
      if (utterance) {
        utterance.onend = null;
        utterance.onerror = null;
        utterance.onstart = null;
        utterance.onboundary = null;
        if (!speechFinished) runtime.speech?.cancel();
      }
    },
  };
}
