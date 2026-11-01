"use client";

import { useEffect, useState } from "react";
import {
  loadArticleImageCaption,
  loadArticleImageOcr,
  type ArticleImageCaptionResponse,
  type ArticleImageOcrResponse,
} from "./article-image-caption";
import { useSpokenBriefing } from "./useSpokenBriefing";
import "./article-image-caption.css";

export default function ArticleImageCaption({
  imageUrl,
}: {
  imageUrl?: string | null;
}) {
  const [caption, setCaption] = useState<ArticleImageCaptionResponse | null>(null);
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState<ArticleImageOcrResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const ocrSpeech = useSpokenBriefing();

  useEffect(() => {
    setCaption(null);
    setVisionConfigured(false);
    setOcrOpen(false);
    setOcrLoading(false);
    setOcrResult(null);
    setCopied(false);
    ocrSpeech.stop();

    if (!imageUrl || !imageUrl.startsWith("https://")) {
      return;
    }

    const abort = new AbortController();

    loadArticleImageCaption(imageUrl, fetch, abort.signal)
      .then((res) => {
        if (abort.signal.aborted) return;
        const unconfigured = !res.available && (res.reason || "").toLowerCase().includes("not been configured");
        setVisionConfigured(!unconfigured);
        setCaption(res.available && res.caption ? res : null);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setCaption(null);
          setVisionConfigured(false);
        }
      });

    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  async function toggleExtractText() {
    if (!imageUrl || !imageUrl.startsWith("https://")) return;

    if (ocrOpen) {
      ocrSpeech.stop();
      setOcrOpen(false);
      return;
    }

    setOcrOpen(true);
    if (ocrResult) return;

    setOcrLoading(true);
    try {
      const res = await loadArticleImageOcr(imageUrl);
      setOcrResult(res);
    } finally {
      setOcrLoading(false);
    }
  }

  async function copyExtractedText() {
    if (!ocrResult?.text) return;
    try {
      await navigator.clipboard.writeText(ocrResult.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }

  const hasCaption = Boolean(caption && caption.caption);
  if (!hasCaption && !visionConfigured) return null;

  return (
    <figcaption
      className={`article-ai-caption${!hasCaption ? " article-ai-caption-compact" : ""}`}
      aria-label="AI Image Description and Text Extraction"
    >
      <div className="article-ai-caption-row">
        {hasCaption ? (
          <div className="article-ai-caption-main">
            <span className="ai-caption-badge" aria-hidden="true">
              👁️ AI Description
            </span>
            <span className="ai-caption-text">{caption!.caption}</span>
            {caption!.confidence > 0 && (
              <span
                className="ai-caption-confidence"
                title={`AI Confidence: ${Math.round(caption!.confidence * 100)}%`}
              >
                ({Math.round(caption!.confidence * 100)}%)
              </span>
            )}
          </div>
        ) : (
          <span className="ai-caption-tools-label">Image tools</span>
        )}

        <button
          type="button"
          className={`ai-ocr-toggle-btn${ocrOpen ? " active" : ""}`}
          onClick={() => void toggleExtractText()}
          disabled={ocrLoading}
          aria-expanded={ocrOpen}
          title="Extract readable text from charts, infographics, or screenshots"
        >
          {ocrLoading ? "Scanning…" : ocrOpen ? "Hide text" : "🔤 Extract text"}
        </button>
      </div>

      {ocrOpen && (
        <div className="article-ocr-panel" role="region" aria-label="Extracted image text">
          {ocrLoading ? (
            <p className="article-ocr-status">Scanning image for text…</p>
          ) : ocrResult?.available && ocrResult.text ? (
            <>
              <div className="article-ocr-toolbar">
                <span className="article-ocr-meta">
                  Extracted Text · {ocrResult.lineCount} {ocrResult.lineCount === 1 ? "line" : "lines"}
                </span>
                <div className="article-ocr-actions">
                  <button
                    type="button"
                    className="article-ocr-action-btn"
                    onClick={() => {
                      if (ocrSpeech.isActive) ocrSpeech.stop();
                      else ocrSpeech.speak(ocrResult.text);
                    }}
                  >
                    {ocrSpeech.status === "starting"
                      ? "⏳ Preparing…"
                      : ocrSpeech.status === "playing"
                        ? "⏹ Stop"
                        : "🔊 Read aloud"}
                  </button>
                  <button
                    type="button"
                    className="article-ocr-action-btn"
                    onClick={() => void copyExtractedText()}
                  >
                    {copied ? "✓ Copied" : "📋 Copy"}
                  </button>
                </div>
              </div>
              <pre className="article-ocr-pre">{ocrResult.text}</pre>
            </>
          ) : (
            <p className="article-ocr-status">
              {ocrResult?.reason || "No embedded text detected in this image."}
            </p>
          )}
        </div>
      )}
    </figcaption>
  );
}
