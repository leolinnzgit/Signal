"use client";

import { useEffect, useRef, useState } from "react";
import { normalizeReadingVoices, prepareReadingVoicePreview, type ReadingVoicePreferences } from "./headline-audio";

type ReadingVoice = { id: string; name: string; language: string; gender: string };
const storageKey = "signal.recorded-reading-voices.v1";

export function useReadingVoices() {
  const [preferences, setPreferences] = useState<ReadingVoicePreferences>(() => {
    try { return normalizeReadingVoices(JSON.parse(localStorage.getItem(storageKey) ?? "null")); }
    catch { return normalizeReadingVoices(null); }
  });
  const [voices, setVoices] = useState<ReadingVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/headline-audio/voices", { credentials: "same-origin", cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Voice choices could not be loaded. Automatic narration is still available.");
        const data: unknown = await response.json();
        if (!Array.isArray(data) || data.some((voice) => !voice || typeof voice.id !== "string" || typeof voice.name !== "string" || typeof voice.language !== "string" || typeof voice.gender !== "string")) {
          throw new Error("Voice choices could not be loaded. Automatic narration is still available.");
        }
        if (abort.signal.aborted) return;
        setVoices(data);
        setPreferences((saved) => ({
          en: data.some((voice) => voice.id === saved.en && voice.language.startsWith("en")) ? saved.en : "",
          zh: data.some((voice) => voice.id === saved.zh && voice.language.startsWith("zh")) ? saved.zh : "",
        }));
      })
      .catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Voice choices are unavailable."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); }
    catch { /* Choices still work when device storage is unavailable. */ }
  }, [preferences]);
  function selectVoice(language: keyof ReadingVoicePreferences, id: string) {
    setPreferences((saved) => ({ ...saved, [language]: id }));
  }
  return { preferences, voices, loading, error, selectVoice };
}

type Props = ReturnType<typeof useReadingVoices> & { active?: boolean; playbackActive?: boolean; onPreviewStart: () => void };

export default function ReadingVoiceSelector({ preferences, voices, loading, error, selectVoice, active = false, playbackActive = false, onPreviewStart }: Props) {
  const [preview, setPreview] = useState<{ language: keyof ReadingVoicePreferences; url: string; preparing: boolean; playing: boolean; message: string } | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const preparation = useRef<AbortController | null>(null);
  const recordingUrl = useRef("");

  function stopPreview() {
    preparation.current?.abort();
    audio.current?.pause();
    if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
    recordingUrl.current = "";
    setPreview(null);
  }

  useEffect(() => {
    stopPreview();
    return () => {
      preparation.current?.abort();
      audio.current?.pause();
      if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
      recordingUrl.current = "";
    };
  }, [preferences.en, preferences.zh]);

  useEffect(() => { if (playbackActive) stopPreview(); }, [playbackActive]);

  useEffect(() => {
    if (!preview?.url) return;
    const url = preview.url;
    void audio.current?.play().catch(() => setPreview((current) => current?.url === url ? { ...current, message: "Tap Play to hear the sample." } : current));
  }, [preview?.url]);

  async function previewVoice(language: keyof ReadingVoicePreferences) {
    if (preview?.language === language && (preview.preparing || preview.playing)) { stopPreview(); return; }
    stopPreview();
    onPreviewStart();
    const abort = new AbortController();
    preparation.current = abort;
    setPreview({ language, url: "", preparing: true, playing: false, message: "Preparing voice sample…" });
    try {
      const recording = await prepareReadingVoicePreview(language, preferences, abort.signal);
      if (abort.signal.aborted) return;
      recordingUrl.current = URL.createObjectURL(recording.blob);
      setPreview({ language, url: recordingUrl.current, preparing: false, playing: false, message: "Tap Play to hear the sample." });
    } catch (reason: unknown) {
      if (!abort.signal.aborted) setPreview({ language, url: "", preparing: false, playing: false,
        message: reason instanceof Error ? `Voice preview unavailable. ${reason.message}` : "Voice preview unavailable. Please try again." });
    }
  }

  return <fieldset className="reading-voice-selector">
    <legend>Reading voice</legend>
    {(["en", "zh"] as const).map((language) => <div className="reading-voice-choice" key={language}><label>
      {language === "en" ? "English voice" : "Chinese voice"}
      <select value={preferences[language]} disabled={loading || !voices.some((voice) => voice.language.startsWith(language))}
        onChange={(event) => selectVoice(language, event.target.value)}>
        <option value="">Automatic — female preferred</option>
        {voices.filter((voice) => voice.language.startsWith(language)).map((voice) => <option key={voice.id} value={voice.id}>
          {voice.name.replace(/^Microsoft\s+/u, "")} · {voice.gender} · {voice.language}
        </option>)}
      </select>
    </label><button type="button" disabled={loading}
      onClick={() => { void previewVoice(language); }}
      aria-label={`${preview?.language === language && (preview.preparing || preview.playing) ? "Stop" : "Preview"} ${language === "en" ? "English" : "Chinese"} voice`}>
      {preview?.language === language && (preview.preparing || preview.playing) ? "Stop preview" : "Preview voice"}
    </button></div>)}
    {preview && <div className="reading-voice-preview">
      <p role="status">{preview.message}</p>
      {preview.url && <audio ref={audio} src={preview.url} controls preload="auto"
        aria-label={`${preview.language === "en" ? "English" : "Chinese"} voice sample`}
        onPlay={() => { onPreviewStart(); setPreview((current) => current && { ...current, playing: true, message: "Playing voice sample." }); }}
        onPause={() => setPreview((current) => current && { ...current, playing: false })}
        onEnded={() => setPreview((current) => current && { ...current, playing: false, message: "Voice preview finished." })}
        onError={() => setPreview((current) => current && { ...current, playing: false, message: "The voice sample could not be played. Try previewing again." })} />}
    </div>}
    <p>{loading ? "Loading voice choices…" : "Your choices are saved on this device."}{active && " Changing a voice prepares a new recording."}</p>
    {error && <p role="status">{error}</p>}
  </fieldset>;
}
