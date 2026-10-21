"use client";

import { useEffect, useRef, useState } from "react";
import { loadArticleTranslation, translationLanguages, type ArticleTranslation } from "./article-translation";

export default function ArticleTranslationControls({ url, title, translated, onChange }: {
  url: string; title: string; translated: boolean; onChange: (translation: ArticleTranslation | null) => void;
}) {
  const [language, setLanguage] = useState("en");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [url]);

  async function translate() {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    setMessage("");
    try {
      const result = await loadArticleTranslation(url, title, language, abort.signal);
      if (abort.signal.aborted) return;
      if (result.available) { onChange(result); setMessage("Translated with Azure Translator."); }
      else setMessage(result.reason);
    } catch (reason: unknown) {
      if (!abort.signal.aborted) setMessage(reason instanceof Error ? reason.message : "Translation could not be prepared.");
    } finally { if (!abort.signal.aborted) setLoading(false); }
  }

  return <section className="article-translation" aria-label="Translate article">
    <div className="article-translation-controls">
      <label>Translate to <select value={language} onChange={(event) => {
        request.current?.abort(); setLoading(false); setMessage(""); onChange(null); setLanguage(event.target.value);
      }}>{translationLanguages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      <button type="button" disabled={loading} onClick={() => void translate()}>{loading ? "Translating…" : "Translate"}</button>
      {translated && <button type="button" onClick={() => {
        request.current?.abort(); setLoading(false); setMessage(""); onChange(null);
      }}>Show original</button>}
    </div>
    <p role="status">{message || (loading ? "Translating the article text…" : "Translate the title and full article text with Azure Translator.")}</p>
  </section>;
}
