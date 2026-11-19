const listeningLimit = 60 * 60_000;
const breakDuration = 10 * 60_000;
const storageKey = "signal.listening-break.v1";

type ListeningTime = { listened: number; quietSince: number; breakUntil: number };
type Stop = () => void;
type Speech = {
  utterance: SpeechSynthesisUtterance;
  engine: SpeechSynthesis;
  detach: Stop;
};

function restoreListeningTime(): ListeningTime {
  const now = Date.now();
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (saved && Number.isFinite(saved.listened) && saved.listened >= 0
      && Number.isFinite(saved.quietSince) && saved.quietSince <= now
      && Number.isFinite(saved.breakUntil) && saved.breakUntil <= now + breakDuration) {
      return { listened: Math.min(saved.listened, listeningLimit), quietSince: saved.quietSince, breakUntil: saved.breakUntil };
    }
  } catch { /* Listening protection still works in memory. */ }
  return { listened: 0, quietSince: now, breakUntil: 0 };
}

let tracker: ReturnType<typeof createTracker> | undefined;

function createTracker() {
  const time = restoreListeningTime();
  const playing = new Map<object, Stop>();
  const listeners = new Set<(until: number) => void>();
  let measuredAt = Date.now();
  let timer: number | undefined;

  function check() {
    const now = Date.now();
    const previousBreak = time.breakUntil;
    if (previousBreak) {
      if (now >= previousBreak) {
        time.breakUntil = 0;
        time.listened = 0;
      }
    } else if (playing.size) {
      time.listened += Math.max(0, now - measuredAt);
      time.quietSince = now;
    } else if (now - time.quietSince >= breakDuration) {
      time.listened = 0;
    }
    measuredAt = now;

    if (!time.breakUntil && time.listened >= listeningLimit) {
      time.breakUntil = now + breakDuration;
      const stops = [...playing.values()];
      playing.clear();
      for (const stop of stops) stop();
    }

    try { sessionStorage.setItem(storageKey, JSON.stringify(time)); }
    catch { /* Listening protection still works in memory. */ }

    if (time.breakUntil !== previousBreak) {
      for (const listener of listeners) listener(time.breakUntil);
    }

    window.clearTimeout(timer);
    if (time.breakUntil) timer = window.setTimeout(check, Math.max(1, time.breakUntil - now));
    else if (playing.size) timer = window.setTimeout(check, Math.min(15_000, listeningLimit - time.listened));
  }

  return {
    check,
    update(source: object) {
      if (playing.has(source) && Date.now() - measuredAt >= Math.min(15_000, listeningLimit - time.listened)) check();
    },
    start(source: object, stop: Stop) {
      if (playing.has(source)) return;
      check();
      if (time.breakUntil) { stop(); return; }
      playing.set(source, stop);
      check();
    },
    stop(source: object) {
      if (!playing.has(source)) return;
      check();
      playing.delete(source);
      check();
    },
    canPlay() {
      check();
      return !time.breakUntil;
    },
    subscribe(listener: (until: number) => void) {
      listeners.add(listener);
      check();
      listener(time.breakUntil);
      return () => { listeners.delete(listener); };
    },
  };
}

function getTracker() { return tracker ??= createTracker(); }

export function canStartListening() { return getTracker().canPlay(); }

export function observeListeningBreak(listener: (until: number) => void) {
  return getTracker().subscribe(listener);
}

const audioEvents = ["play", "playing", "pause", "waiting", "seeking", "seeked", "ended", "emptied", "error", "volumechange", "timeupdate"];
const interruptedAudio = new WeakMap<HTMLAudioElement, Stop>();
const registeredAudio = new WeakSet<HTMLAudioElement>();

function guardAudio(event: Event) {
  const audio = event.target as HTMLAudioElement;
  const stop = () => {
    audio.pause();
    interruptedAudio.get(audio)?.();
  };
  if (event.type === "play") {
    if (!canStartListening()) stop();
    return;
  }
  if (event.type === "timeupdate") {
    getTracker().update(audio);
    return;
  }
  const listening = ["playing", "seeked", "volumechange"].includes(event.type)
    && !audio.paused && !audio.ended && !audio.seeking && !audio.muted && audio.volume > 0
    && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  if (listening) getTracker().start(audio, stop);
  else getTracker().stop(audio);
}

function registerAudio(audio: HTMLAudioElement) {
  registeredAudio.add(audio);
  for (const name of audioEvents) audio.addEventListener(name, guardAudio, true);
}

export function createListeningAudio(src?: string, onBreak?: Stop) {
  const audio = new Audio(src);
  if (onBreak) interruptedAudio.set(audio, onBreak);
  registerAudio(audio);
  return audio;
}

export function watchListeningAudio() {
  const onPlay = (event: Event) => {
    if (event.target instanceof HTMLAudioElement && !registeredAudio.has(event.target)) registerAudio(event.target);
  };
  const check = () => getTracker().check();
  document.addEventListener("play", onPlay, true);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("pagehide", check);
  return () => {
    document.removeEventListener("play", onPlay, true);
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("pagehide", check);
  };
}

let speech: Speech | undefined;

function releaseSpeech(current: Speech) {
  if (speech !== current) return;
  speech = undefined;
  current.detach();
  getTracker().stop(current.utterance);
}

export function cancelListeningSpeech(engine: SpeechSynthesis | null = window.speechSynthesis) {
  if (speech && speech.engine === engine) releaseSpeech(speech);
  engine?.cancel();
}

export function pauseListeningSpeech(engine = window.speechSynthesis) {
  engine.pause();
  if (speech?.engine === engine) getTracker().stop(speech.utterance);
}

export function speakListeningSpeech(utterance: SpeechSynthesisUtterance, onBreak: Stop, engine = window.speechSynthesis) {
  if (!canStartListening()) { onBreak(); return false; }
  const stop = () => {
    // Some speech engines report cancellation through the error handler, which
    // can otherwise advance a queue or show a voice failure during a break.
    utterance.onend = utterance.onerror = null;
    cancelListeningSpeech(engine);
    onBreak();
  };
  const start = () => getTracker().start(utterance, stop);
  const pause = () => getTracker().stop(utterance);
  const end = () => releaseSpeech(current);
  const boundary = () => {
    if (engine.paused) return;
    start();
    getTracker().update(utterance);
  };
  const events = { start, resume: start, boundary, pause, end, error: end };
  const current: Speech = { utterance, engine, detach: () => {
    for (const [name, callback] of Object.entries(events)) utterance.removeEventListener(name, callback, true);
  } };
  if (speech) releaseSpeech(speech);
  speech = current;
  for (const [name, callback] of Object.entries(events)) utterance.addEventListener(name, callback, true);
  try {
    engine.speak(utterance);
    if (engine.paused) engine.resume();
  }
  catch (error) { releaseSpeech(current); throw error; }
  return true;
}

export function listeningSpeech(onBreak: Stop) {
  const engine = window.speechSynthesis;
  return {
    get speaking() { return engine.speaking; },
    get pending() { return engine.pending; },
    get paused() { return engine.paused; },
    getVoices: () => engine.getVoices(),
    speak: (utterance: SpeechSynthesisUtterance) => { speakListeningSpeech(utterance, onBreak, engine); },
    cancel: () => cancelListeningSpeech(engine),
    pause: () => pauseListeningSpeech(engine),
    resume: () => { if (canStartListening()) engine.resume(); else onBreak(); },
  };
}
