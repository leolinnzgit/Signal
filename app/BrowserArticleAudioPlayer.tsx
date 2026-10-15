"use client";
import { useHandGestureTarget } from "./hand-gesture-actions";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ArticleAudioPlayerProps } from "./ArticleAudioPlayer";
import { articleNarrationSections, type ArticleNarrationSection } from "./headline-audio";
import {
  createHeadlinePlayback, findPreferredHeadlineVoice, HEADLINE_SPEECH_PREFERENCES_KEY,
  headlineSpeechLanguage, headlineVoiceId, normalizeHeadlineSpeechPreferences,
  rankHeadlineVoices, selectHeadlineVoice, browserSpeechRequiresTap, browserSpeechErrorMessage, DEVICE_DEFAULT_SPEECH_VOICE,
} from "./headline-playback";

export default function BrowserArticleAudioPlayer({ title, paragraphs, autoPrepare = false, summaryOnly = false, onRecordedAudio, onReadingSectionChange }: ArticleAudioPlayerProps & { onRecordedAudio?: () => void }) {
  const sections = useMemo(() => {
    try { return articleNarrationSections(summaryOnly && paragraphs.length === 1 && paragraphs[0] === title ? "" : title, paragraphs, 240); }
    catch { return []; }
  }, [title, paragraphs, summaryOnly]);
  const parts = useMemo(() => sections.map((section) => section.text), [sections]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(() => !autoPrepare || browserSpeechRequiresTap(navigator.userAgent, navigator.maxTouchPoints));
  const [started, setStarted] = useState(false);
  const [readingSection, setReadingSection] = useState<ArticleNarrationSection | null>(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [copiedDetails, setCopiedDetails] = useState(false);
  const mobileSpeech = browserSpeechRequiresTap(navigator.userAgent, navigator.maxTouchPoints);
  const [preferences, setPreferences] = useState(() => {
    try { return normalizeHeadlineSpeechPreferences(JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null")); }
    catch { return normalizeHeadlineSpeechPreferences(null); }
  });
  const [voices, setVoices] = useState(() => window.speechSynthesis.getVoices());
  const [voicesReady, setVoicesReady] = useState(voices.length > 0);
  const playback = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const playbackKey = useRef<{ parts: string[]; index: number; rate: number; voice: string } | null>(null);
  const completed = index >= parts.length;
  const text = parts[index] ?? title;
  const readingScope = summaryOnly ? paragraphs.length === 1 && paragraphs[0] === title ? "headline" : "headline and summary" : "article";
  const language = headlineSpeechLanguage(text, navigator.language);
  const languageKey = language.split("-")[0].toLowerCase();
  const preferredId = preferences.voices[languageKey] ?? "";
  const availableVoices = useMemo(() => rankHeadlineVoices(voices, language), [voices, language]);
  const preferredVoice = findPreferredHeadlineVoice(availableVoices, preferredId);
  const automaticVoice = selectHeadlineVoice(voices, language, "", mobileSpeech);

  useEffect(() => {
    const synth = window.speechSynthesis;
    const update = () => {
      const next = synth.getVoices();
      setVoices(next);
      if (next.length) setVoicesReady(true);
    };
    synth.addEventListener("voiceschanged", update);
    const timer = window.setTimeout(() => { update(); setVoicesReady(true); }, 500);
    return () => { window.clearTimeout(timer); synth.removeEventListener("voiceschanged", update); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(HEADLINE_SPEECH_PREFERENCES_KEY, JSON.stringify(preferences)); }
    catch { /* Reading stays available when device storage is disabled. */ }
  }, [preferences]);

  function ensurePlayback(part = index, settings = preferences) {
    if (!parts[part]) { disposePlayback(); return null; }
    const voice = settings.voices[headlineSpeechLanguage(parts[part], navigator.language).split("-")[0].toLowerCase()] ?? "";
    const key = playbackKey.current;
    if (playback.current && key?.parts === parts && key.index === part && key.rate === settings.rate && key.voice === voice) return playback.current;
    disposePlayback();
    setStarted(false);
    const current = createHeadlinePlayback({
      title: parts[part], seconds: 0, readAloud: true,
      rate: settings.rate, preferredVoiceId: voice,
      onAdvance: () => setIndex(part + 1),
      onSpeechStart: () => { setStarted(true); setReadingSection(sections[part]); },
      onSpeechError: (reason) => {
        current.setPaused(true);
        disposePlayback();
        setPaused(true);
        setStarted(false);
        setReadingSection(null);
        setErrorCode(reason);
        setError(browserSpeechErrorMessage(reason));
      },
    }, {
      speech: window.speechSynthesis,
      createUtterance: (value) => new SpeechSynthesisUtterance(value),
      language: navigator.language,
      preferDeviceVoice: mobileSpeech,
      restartOnResume: /Android/i.test(navigator.userAgent),
      now: () => performance.now(),
      schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      clear: (id) => window.clearTimeout(id),
    });
    playback.current = current;
    playbackKey.current = { parts, index: part, rate: settings.rate, voice };
    return current;
  }

  function disposePlayback() {
    playback.current?.dispose();
    playback.current = null;
    playbackKey.current = null;
  }

  // Reconcile automatic section changes without replacing a controller started by a tap.
  useEffect(() => {
    if (completed) { disposePlayback(); return; }
    if (voicesReady) ensurePlayback()?.setPaused(paused);
  }, [parts, index, completed, preferences.rate, preferredId, voicesReady, paused]);

  useEffect(() => () => disposePlayback(), []);

  useEffect(() => {
    onReadingSectionChange?.(completed ? null : readingSection,
      !completed && !paused && started && readingSection === sections[index]);
  }, [completed, readingSection, paused, started, sections, index, onReadingSectionChange]);

  function togglePlayback() {
    if (!paused && !completed) {
      playback.current?.setPaused(true);
      if (/Android/i.test(navigator.userAgent)) setStarted(false);
      setPaused(true);
      return;
    }
    const part = completed ? 0 : index;
    if (error || completed) { disposePlayback(); setReadingSection(null); }
    setError("");
    setErrorCode("");
    setCopiedDetails(false);
    setIndex(part);
    setPaused(false);
    // Do not wait for voiceschanged or a React effect: phones require speak in the tap handler.
    setVoicesReady(true);
    ensurePlayback(part)?.setPaused(false);
  }

  useHandGestureTarget(30, true, (action) => {
    if (action !== "pause" && action !== "resume") return undefined;
    if (action === "pause") {
      if (!paused && !completed) togglePlayback();
      return "Article narration paused.";
    }
    if (paused || completed) togglePlayback();
    return "Article narration resumed. Tap Play if your browser requires it.";
  });

  function moveTo(part: number) {
    setError("");
    setErrorCode("");
    setCopiedDetails(false);
    setIndex(part);
    ensurePlayback(part)?.setPaused(paused);
  }

  function changePreferences(settings: typeof preferences) {
    setError("");
    setErrorCode("");
    setCopiedDetails(false);
    setPreferences(settings);
    ensurePlayback(index, settings)?.setPaused(paused);
  }

  function stop() {
    disposePlayback();
    setPaused(true);
    setStarted(false);
    setReadingSection(null);
    setIndex(0);
    setError("");
    setErrorCode("");
    setCopiedDetails(false);
  }

  function tryDeviceDefault() {
    const part = completed ? 0 : index;
    const key = headlineSpeechLanguage(parts[part] ?? title, navigator.language).split("-")[0].toLowerCase();
    const settings = { ...preferences, voices: { ...preferences.voices, [key]: DEVICE_DEFAULT_SPEECH_VOICE } };
    disposePlayback();
    setPreferences(settings);
    setError("");
    setErrorCode("");
    setCopiedDetails(false);
    setPaused(false);
    setVoicesReady(true);
    ensurePlayback(part, settings)?.setPaused(false);
    if (completed) setIndex(0);
  }

  async function copyVoiceDetails() {
    const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const selected = preferredId === DEVICE_DEFAULT_SPEECH_VOICE ? "Device default" : preferredVoice?.name ?? automaticVoice?.name ?? "Browser default";
    const details = JSON.stringify({ error: errorCode, mode: installed ? "installed app" : "browser", language,
      voice: selected, voices: window.speechSynthesis.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang, local: voice.localService, default: voice.default })),
      browser: navigator.userAgent }, null, 2);
    try { await navigator.clipboard.writeText(details); setCopiedDetails(true); }
    catch { setCopiedDetails(false); }
  }

  return <section className="article-audio-player" aria-label={summaryOnly ? "Browser headline and summary narration" : "Browser article narration"}>
    <div className="article-browser-transport">
      <button type="button" onClick={togglePlayback} disabled={!parts.length}>{completed ? "Read again" : paused ? "Play" : "Pause"}</button>
      <button type="button" onClick={stop}>Stop</button>
      <button type="button" disabled={index === 0} onClick={() => moveTo(index - 1)}>Previous section</button>
      <button type="button" disabled={completed} onClick={() => moveTo(index + 1)}>Next section</button>
    </div>
    <details className="reading-voice-disclosure">
      <summary>Reading voice <span className="reading-voice-show">Show</span><span className="reading-voice-hide">Hide</span></summary>
      <div className="reading-voice-content">
        <label>Reading voice
          <select aria-label="Reading voice" value={preferredId === DEVICE_DEFAULT_SPEECH_VOICE ? DEVICE_DEFAULT_SPEECH_VOICE : preferredVoice ? headlineVoiceId(preferredVoice) : ""}
            onChange={(event) => changePreferences({ ...preferences, voices: { ...preferences.voices, [languageKey]: event.target.value } })}>
            <option value="">Automatic{automaticVoice ? ` — ${automaticVoice.name}` : " — browser default"}</option>
            <option value={DEVICE_DEFAULT_SPEECH_VOICE}>Device default — compatibility</option>
            {availableVoices.map((voice) => <option key={headlineVoiceId(voice)} value={headlineVoiceId(voice)}>{voice.name} — {voice.lang}</option>)}
          </select>
        </label>
      </div>
    </details>
    <label>Speaking speed
      <select aria-label="Speaking speed" value={preferences.rate} onChange={(event) => changePreferences({ ...preferences, rate: Number(event.target.value) })}>
        {[0.8, 0.95, 1, 1.1, 1.2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        {![0.8, 0.95, 1, 1.1, 1.2].includes(preferences.rate) && <option value={preferences.rate}>{preferences.rate}×</option>}
      </select>
    </label>
    <div className="article-browser-progress">
      <progress aria-label="Reading progress" value={completed ? parts.length : index} max={Math.max(1, parts.length)} />
      <p role="status">{!parts.length ? "No text available to read aloud." : completed ? "Finished reading." : !voicesReady && !paused ? "Preparing browser voice…" : paused ? `Tap Play to read${summaryOnly ? ` the ${readingScope}` : ""}. Section ${index + 1} of ${parts.length}.` : !started ? "Starting browser voice…" : `Reading ${readingScope}. Section ${index + 1} of ${parts.length}.`}</p>
    </div>
    {error && <>
      <p role="alert">{error}</p>
      <div className="article-browser-transport">
        <button type="button" onClick={tryDeviceDefault}>Try Device default</button>
        {onRecordedAudio && <button type="button" onClick={onRecordedAudio}>Use Recorded audio</button>}
      </div>
      <details><summary>Voice details</summary>
        <p>Speech error: {errorCode}. Voices available: {voices.length}. Language: {language}.</p>
        <button type="button" onClick={() => { void copyVoiceDetails(); }}>{copiedDetails ? "Voice details copied" : "Copy voice details"}</button>
      </details>
    </>}
  </section>;
}
