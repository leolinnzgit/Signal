"use client";

import { useEffect, useState } from "react";
import {
  loadArticleImageCaption,
  loadArticleImageOcr,
  type ArticleImageCaptionResponse,
  type ArticleImageOcrResponse,
} from "./article-image-caption";
import { translateTextSnippets } from "./article-translation";
import { useSpokenBriefing } from "./useSpokenBriefing";
import "./article-image-caption.css";

export default function ArticleImageCaption({
  imageUrl,
  targetLanguage = "en",
}: {
  imageUrl?: string | null;
  targetLanguage?: string;
}) {
  const [caption, setCaption] = useState<ArticleImageCaptionResponse | null>(null);
  const [translatedCaption, setTranslatedCaption] = useState<string | null>(null);
  const [showOriginalCaption, setShowOriginalCaption] = useState(false);

  const [visionConfigured, setVisionConfigured] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState<ArticleImageOcrResponse | null>(null);
  const [translatedOcr, setTranslatedOcr] = useState<string | null>(null);
  const [showOriginalOcr, setShowOriginalOcr] = useState(false);

  const [copied, setCopied] = useState(false);
  const ocrSpeech = useSpokenBriefing();

  useEffect(() => {
    setCaption(null);
    setTranslatedCaption(null);
    setShowOriginalCaption(false);
    setVisionConfigured(false);
    setOcrOpen(false);
    setOcrLoading(false);
    setOcrResult(null);
    setTranslatedOcr(null);
    setShowOriginalOcr(false);
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
        if (res.available && res.caption) {
          setCaption(res);
          if (targetLanguage && targetLanguage !== "en") {
            void translateTextSnippets([res.caption], targetLanguage, abort.signal).then((t) => {
              if (!abort.signal.aborted && t.available && t.translations[0]) {
                setTranslatedCaption(t.translations[0]);
              }
            });
          }
        } else {
          setCaption(null);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setCaption(null);
          setVisionConfigured(false);
        }
      });

    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, targetLanguage]);

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
      if (res.available && res.text && targetLanguage && targetLanguage !== "en") {
        void translateTextSnippets([res.text], targetLanguage).then((t) => {
          if (t.available && t.translations[0]) {
            setTranslatedOcr(t.translations[0]);
          }
        });
      }
    } finally {
      setOcrLoading(false);
    }
  }

  async function copyExtractedText() {
    const textToCopy = (!showOriginalOcr && translatedOcr) || ocrResult?.text;
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }

  const hasCaption = Boolean(caption && caption.caption);
  if (!hasCaption && !visionConfigured) return null;

  const isTranslatedLanguage = Boolean(targetLanguage && targetLanguage !== "en");
  const displayCaptionText = !showOriginalCaption && translatedCaption ? translatedCaption : caption?.caption;
  const activeOcrText = (!showOriginalOcr && translatedOcr) || ocrResult?.text || "";

  return (
    <figcaption
      className={`article-ai-caption${!hasCaption ? " article-ai-caption-compact" : ""}`}
      aria-label="AI Image Description and Text Extraction"
    >
      <div className="article-ai-caption-row">
        {hasCaption ? (
          <div className="article-ai-caption-main">
            <span className="ai-caption-badge" aria-hidden="true">
              👁️ {translatedCaption && !showOriginalCaption ? `AI (${targetLanguage})` : "AI Description"}
            </span>
            <span className="ai-caption-text">{displayCaptionText}</span>
            {caption!.confidence > 0 && (
              <span
                className="ai-caption-confidence"
                title={`AI Confidence: ${Math.round(caption!.confidence * 100)}%`}
              >
                ({Math.round(caption!.confidence * 100)}%)
              </span>
            )}
            {translatedCaption && (
              <button
                type="button"
                className="ai-caption-toggle-lang-btn"
                onClick={() => setShowOriginalCaption((prev) => !prev)}
                title={showOriginalCaption ? "Show translated description" : "Show original English description"}
              >
                {showOriginalCaption ? `Show ${targetLanguage}` : "Show original"}
              </button>
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
                  {translatedOcr && !showOriginalOcr && ` (${targetLanguage})`}
                </span>
                <div className="article-ocr-actions">
                  {translatedOcr && (
                    <button
                      type="button"
                      className="article-ocr-action-btn"
                      onClick={() => setShowOriginalOcr((prev) => !prev)}
                    >
                      {showOriginalOcr ? `Translate (${targetLanguage})` : "Show original"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="article-ocr-action-btn"
                    onClick={() => {
                      if (ocrSpeech.isActive) ocrSpeech.stop();
                      else ocrSpeech.speak(activeOcrText, !showOriginalOcr && translatedOcr ? targetLanguage : "en");
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
              <pre className="article-ocr-pre">{activeOcrText}</pre>
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
