type SpeechTarget = Pick<SpeechSynthesis, "cancel" | "speak" | "pause" | "resume" | "getVoices">;

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
  options: { title: string; seconds: number; readAloud: boolean; onAdvance: () => void; onSpeechError: () => void },
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

  function elapsed() {
    return playedMilliseconds + (paused ? 0 : runtime.now() - startedAt);
  }

  function advanceIfReady() {
    if (disposed || paused || advanced || elapsed() < displayDuration || !speechFinished) return;
    advanced = true;
    options.onAdvance();
  }

  function finishSpeech(failed = false) {
    if (disposed || speechFinished) return;
    speechFinished = true;
    if (speechTimer !== undefined) runtime.clear(speechTimer);
    if (utterance) { utterance.onend = null; utterance.onerror = null; }
    if (failed) {
      runtime.speech?.cancel();
      options.onSpeechError();
    }
    advanceIfReady();
  }

  function startTimers() {
    startedAt = runtime.now();
    displayTimer = runtime.schedule(advanceIfReady, Math.max(0, displayDuration - playedMilliseconds));
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
            utterance = runtime.createUtterance(options.title);
            utterance.lang = headlineSpeechLanguage(options.title, runtime.language);
            const voices = runtime.speech.getVoices();
            const voice = voices.find((candidate) => candidate.lang.toLowerCase() === utterance!.lang.toLowerCase())
              ?? voices.find((candidate) => candidate.lang.split("-")[0] === utterance!.lang.split("-")[0]);
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
        if (displayTimer !== undefined) runtime.clear(displayTimer);
        displayTimer = runtime.schedule(advanceIfReady, Math.max(0, displayDuration - elapsed()));
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
