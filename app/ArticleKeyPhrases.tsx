"use client";

import { useEffect, useState } from "react";
import { loadArticleKeyPhrases } from "./article-keyphrases";
import "./article-keyphrases.css";

export default function ArticleKeyPhrases({
  url,
  title,
  paragraphs,
}: {
  url: string;
  title: string;
  paragraphs: string[];
}) {
  const [phrases, setPhrases] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url && (!paragraphs || paragraphs.length === 0)) return;
    const abort = new AbortController();
    setLoading(true);

    loadArticleKeyPhrases(url, title, paragraphs, abort.signal)
      .then((res) => {
        if (!abort.signal.aborted && res.available && res.keyPhrases?.length > 0) {
          setPhrases(res.keyPhrases);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setPhrases([]);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });

    return () => abort.abort();
  }, [url, title, paragraphs]);

  if (!loading && phrases.length === 0) return null;

  return (
    <div className="article-keyphrases-container" aria-label="Key article takeaways">
      <div className="article-keyphrases-heading">
        <span className="keyphrases-icon" aria-hidden="true">💡</span>
        <span className="keyphrases-label">At a Glance</span>
        {loading && <span className="article-entities-spinner" aria-hidden="true" />}
      </div>
      {phrases.length > 0 && (
        <ul className="article-keyphrases-list">
          {phrases.map((phrase, index) => (
            <li key={`${phrase}-${index}`} className="article-keyphrase-item">
              <span className="keyphrase-bullet" aria-hidden="true">•</span>
              <span>{phrase}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
