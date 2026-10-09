"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ArticleAudioPlayerProps } from "./ArticleAudioPlayer";
import { articleNarrationParts } from "./headline-audio";
import {
  createHeadlinePlayback, findPreferredHeadlineVoice, HEADLINE_SPEECH_PREFERENCES_KEY,
  headlineSpeechLanguage, headlineVoiceId, normalizeHeadlineSpeechPreferences,
  rankHeadlineVoices, selectHeadlineVoice,
} from "./headline-playback";

export default function BrowserArticleAudioPlayer({ title, paragraphs, autoPrepare = false, summaryOnly = false }: ArticleAudioPlayerProps) {
  const parts = useMemo(() => {
    try { return articleNarrationParts(summaryOnly && paragraphs.length === 1 && paragraphs[0] === title ? "" : title, paragraphs, 240); }
    catch { return []; }
  }, [title, paragraphs, summaryOnly]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(!autoPrepare);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [preferences, setPreferences] = useState(() => {
    try { return normalizeHeadlineSpeechPreferences(JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null")); }
    catch { return normalizeHeadlineSpeechPreferences(null); }
  });
  const [voices, setVoices] = useState(() => window.speechSynthesis.getVoices());
  const [voicesReady, setVoicesReady] = useState(voices.length > 0);
  const playback = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const completed = index >= parts.length;
  const text = parts[index] ?? title;
  const readingScope = summaryOnly ? paragraphs.length === 1 && paragraphs[0] === title ? "headline" : "headline and summary" : "article";
  const language = headlineSpeechLanguage(text, navigator.language);
  const languageKey = language.split("-")[0].toLowerCase();
  const preferredId = preferences.voices[languageKey] ?? "";
  const availableVoices = useMemo(() => rankHeadlineVoices(voices, language), [voices, language]);
  const preferredVoice = findPreferredHeadlineVoice(availableVoices, preferredId);
  const automaticVoice = selectHeadlineVoice(voices, language);

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

  useEffect(() => {
    if (completed || !voicesReady) return;
    const current = createHeadlinePlayback({
      title: parts[index], seconds: 0, readAloud: true,
      rate: preferences.rate, preferredVoiceId: preferredId,
      onAdvance: () => setIndex((part) => part + 1),
      onSpeechError: () => {
        current.setPaused(true);
        setPaused(true);
        setError("Browser reading could not continue. Press Play to try again or choose Recorded audio.");
      },
    }, {
      speech: window.speechSynthesis,
      createUtterance: (value) => new SpeechSynthesisUtterance(value),
      language: navigator.language,
      now: () => performance.now(),
      schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      clear: (id) => window.clearTimeout(id),
    });
    playback.current = current;
    return () => { current.dispose(); playback.current = null; };
  }, [parts, index, completed, preferences.rate, preferredId, voicesReady, attempt]);

  useEffect(() => {
    playback.current?.setPaused(paused || !voicesReady);
  }, [paused, parts, index, preferences.rate, preferredId, voicesReady, attempt]);

  function togglePlayback() {
    setError("");
    if (completed) { setIndex(0); setAttempt((value) => value + 1); setPaused(false); return; }
    if (error) { setAttempt((value) => value + 1); setPaused(false); return; }
    playback.current?.setPaused(!paused);
    setPaused(!paused);
  }

  function stop() {
    playback.current?.dispose();
    setPaused(true);
    setIndex(0);
    setAttempt((value) => value + 1);
    setError("");
  }

  return <section className="article-audio-player" aria-label={summaryOnly ? "Browser headline and summary narration" : "Browser article narration"}>
    <div className="article-browser-transport">
      <button type="button" onClick={togglePlayback} disabled={!parts.length}>{completed ? "Read again" : paused ? "Play" : "Pause"}</button>
      <button type="button" onClick={stop}>Stop</button>
      <button type="button" disabled={index === 0} onClick={() => { setError(""); setIndex((part) => part - 1); }}>Previous section</button>
      <button type="button" disabled={completed} onClick={() => { setError(""); setIndex((part) => part + 1); }}>Next section</button>
    </div>
    <label>Reading voice
      <select aria-label="Reading voice" value={preferredVoice ? headlineVoiceId(preferredVoice) : ""}
        onChange={(event) => setPreferences((saved) => ({ ...saved, voices: { ...saved.voices, [languageKey]: event.target.value } }))}>
        <option value="">Automatic{automaticVoice ? ` — ${automaticVoice.name}` : " — browser default"}</option>
        {availableVoices.map((voice) => <option key={headlineVoiceId(voice)} value={headlineVoiceId(voice)}>{voice.name} — {voice.lang}</option>)}
      </select>
    </label>
    <label>Speaking speed
      <select aria-label="Speaking speed" value={preferences.rate} onChange={(event) => setPreferences((saved) => ({ ...saved, rate: Number(event.target.value) }))}>
        {[0.8, 0.95, 1, 1.1, 1.2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        {![0.8, 0.95, 1, 1.1, 1.2].includes(preferences.rate) && <option value={preferences.rate}>{preferences.rate}×</option>}
      </select>
    </label>
    <div className="article-browser-progress">
      <progress aria-label="Reading progress" value={completed ? parts.length : index} max={Math.max(1, parts.length)} />
      <p role="status">{!parts.length ? "No text available to read aloud." : completed ? "Finished reading." : !voicesReady && !paused ? "Preparing browser voice…" : paused ? `Ready to read${summaryOnly ? ` the ${readingScope}` : ""}. Section ${index + 1} of ${parts.length}.` : `Reading ${readingScope}. Section ${index + 1} of ${parts.length}.`}</p>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
