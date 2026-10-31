"use client";

import { useEffect, useState } from "react";
import { loadArticleImageCaption, type ArticleImageCaptionResponse } from "./article-image-caption";
import "./article-image-caption.css";

export default function ArticleImageCaption({
  imageUrl,
}: {
  imageUrl?: string | null;
}) {
  const [caption, setCaption] = useState<ArticleImageCaptionResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!imageUrl || !imageUrl.startsWith("https://")) {
      setCaption(null);
      return;
    }

    const abort = new AbortController();
    setLoading(true);

    loadArticleImageCaption(imageUrl, fetch, abort.signal)
      .then((res) => {
        if (!abort.signal.aborted) {
          setCaption(res.available && res.caption ? res : null);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setCaption(null);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });

    return () => abort.abort();
  }, [imageUrl]);

  if (!caption || !caption.caption) return null;

  return (
    <figcaption className="article-ai-caption" aria-label="AI Image Description">
      <span className="ai-caption-badge" aria-hidden="true">
        👁️ AI Description
      </span>
      <span className="ai-caption-text">{caption.caption}</span>
      {caption.confidence > 0 && (
        <span className="ai-caption-confidence" title={`AI Confidence: ${Math.round(caption.confidence * 100)}%`}>
          ({Math.round(caption.confidence * 100)}%)
        </span>
      )}
    </figcaption>
  );
}
