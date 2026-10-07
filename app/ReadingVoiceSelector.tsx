"use client";

import { useEffect, useState } from "react";
import { normalizeReadingVoices, type ReadingVoicePreferences } from "./headline-audio";

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

type Props = ReturnType<typeof useReadingVoices> & { active?: boolean };

export default function ReadingVoiceSelector({ preferences, voices, loading, error, selectVoice, active = false }: Props) {
  return <fieldset className="reading-voice-selector">
    <legend>Reading voice</legend>
    {(["en", "zh"] as const).map((language) => <label key={language}>
      {language === "en" ? "English voice" : "Chinese voice"}
      <select value={preferences[language]} disabled={loading || !voices.some((voice) => voice.language.startsWith(language))}
        onChange={(event) => selectVoice(language, event.target.value)}>
        <option value="">Automatic — female preferred</option>
        {voices.filter((voice) => voice.language.startsWith(language)).map((voice) => <option key={voice.id} value={voice.id}>
          {voice.name.replace(/^Microsoft\s+/u, "")} · {voice.gender} · {voice.language}
        </option>)}
      </select>
    </label>)}
    <p>{loading ? "Loading voice choices…" : "Your choices are saved on this device."}{active && " Changing a voice prepares a new recording."}</p>
    {error && <p role="status">{error}</p>}
  </fieldset>;
}
