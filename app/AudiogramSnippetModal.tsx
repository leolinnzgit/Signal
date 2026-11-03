"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { drawAudiogramCard, copyAudiogramText } from "./audiogram-generator";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./audiogram.css";

export interface AudiogramSnippetModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  excerpt?: string;
  source: string;
  url?: string;
  preferredVoice?: string;
}

export default function AudiogramSnippetModal({
  isOpen,
  onClose,
  title,
  excerpt = "",
  source,
  url,
  preferredVoice,
}: AudiogramSnippetModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const animFrameRef = useRef<number | null>(null);
  const wavePhaseRef = useRef<number>(0);

  const quoteText = excerpt && excerpt.length > 20 ? excerpt : title;

  // Animation loop updating waveform
  const updateCanvas = useCallback(() => {
    if (!canvasRef.current) return;
    const barCount = 36;
    const phase = wavePhaseRef.current;
    const waveFractions = Array.from({ length: barCount }, (_, i) => {
      if (!isPlaying) {
        return 0.15 + 0.25 * Math.abs(Math.sin((i + 1) * 0.3));
      }
      return 0.2 + 0.7 * Math.abs(Math.sin((i + 1) * 0.35 + phase));
    });

    drawAudiogramCard(canvasRef.current, {
      title,
      quote: quoteText,
      source,
      timestamp: new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      waveformFractions: waveFractions,
    });
  }, [isPlaying, quoteText, source, title]);

  useEffect(() => {
    if (!isOpen) return;

    const loop = () => {
      wavePhaseRef.current += 0.08;
      updateCanvas();
      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [isOpen, updateCanvas]);

  const toggleAudio = async () => {
    if (isPlaying) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setIsPlaying(false);
      return;
    }

    try {
      const controller = new AbortController();
      const streamUrl = await openArticleAudioStream(
        [quoteText],
        "en-NZ",
        { en: activeVoice, zh: "zh-CN-XiaoxiaoNeural" },
        controller.signal,
        () => {},
      );

      if (streamUrl) {
        const audio = new Audio(streamUrl);
        audioRef.current = audio;
        audio.onended = () => setIsPlaying(false);
        audio.onerror = () => setIsPlaying(false);
        await audio.play();
        setIsPlaying(true);
      }
    } catch {
      // SpeechSynthesis fallback
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const ut = new SpeechSynthesisUtterance(quoteText);
        ut.onend = () => setIsPlaying(false);
        window.speechSynthesis.speak(ut);
        setIsPlaying(true);
      }
    }
  };

  const handleDownloadImage = () => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `signal-soundbite-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  };

  const handleCopyQuote = async () => {
    const ok = await copyAudiogramText(title, quoteText, source, url);
    setCopyFeedback(ok ? "Soundbite text copied!" : "Failed to copy text.");
    setTimeout(() => setCopyFeedback(""), 3500);
  };

  const handleShare = async () => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title,
          text: `“${quoteText}” — ${source}`,
          url: url || window.location.href,
        });
      } catch {}
    } else {
      await handleCopyQuote();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="audiogram-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="audiogram-title"
    >
      <div className="audiogram-modal-card">
        {/* Header */}
        <header className="audiogram-header">
          <div>
            <span className="audiogram-badge">🎙️ EXECUTIVE SOUNDBITE CLIPPER</span>
            <h3 id="audiogram-title" className="audiogram-title">
              Generate Audiogram &amp; Quote Card
            </h3>
          </div>
          <button
            type="button"
            className="audiogram-close-btn"
            onClick={onClose}
            aria-label="Close Audiogram Clipper"
          >
            ✕
          </button>
        </header>

        {/* Canvas Audiogram Preview */}
        <div className="audiogram-canvas-wrapper">
          <canvas
            ref={canvasRef}
            width={800}
            height={450}
            className="audiogram-canvas"
          />
        </div>

        {/* Controls Bar */}
        <div className="audiogram-controls">
          <button
            type="button"
            className={`audiogram-btn primary ${isPlaying ? "playing" : ""}`}
            onClick={() => void toggleAudio()}
            title="Preview clip voice readout"
          >
            {isPlaying ? "⏹ Stop Voice" : "🔊 Listen to Clip"}
          </button>

          <button
            type="button"
            className="audiogram-btn secondary"
            onClick={handleDownloadImage}
            title="Download high-resolution quote card PNG"
          >
            🖼️ Download Card PNG
          </button>

          <button
            type="button"
            className="audiogram-btn secondary"
            onClick={() => void handleCopyQuote()}
            title="Copy formatted quotation and link to clipboard"
          >
            📋 Copy Text
          </button>

          <button
            type="button"
            className="audiogram-btn secondary"
            onClick={() => void handleShare()}
            title="Share via device share sheet (Slack, WhatsApp, etc.)"
          >
            🔗 Share Snippet
          </button>
        </div>

        {copyFeedback && (
          <p className="audiogram-feedback" role="status" aria-live="polite">
            {copyFeedback}
          </p>
        )}
      </div>
    </div>
  );
}
