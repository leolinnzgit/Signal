"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { drawAudiogramCard, copyAudiogramText } from "./audiogram-generator";
import { openArticleAudioStream } from "./article-audio-stream";
import { articleNarrationParts, resolveUserReadingVoice } from "./headline-audio";
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
  const abortRef = useRef<AbortController | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const isPlayingRef = useRef<boolean>(false);
  isPlayingRef.current = isPlaying;
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const animFrameRef = useRef<number | null>(null);
  const wavePhaseRef = useRef<number>(0);

  const quoteText = excerpt && excerpt.length > 20 ? excerpt : title;

  const stopAudio = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setIsPlaying(false);
  }, []);

  const fallbackToBrowserSpeech = useCallback((text: string) => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis && typeof SpeechSynthesisUtterance === "function") {
      try {
        window.speechSynthesis.cancel();
        const ut = new SpeechSynthesisUtterance(text);
        ut.onend = () => setIsPlaying(false);
        ut.onerror = () => setIsPlaying(false);
        setIsPlaying(true);
        window.speechSynthesis.speak(ut);
        return;
      } catch {}
    }
    setIsPlaying(false);
  }, []);

  // Animation loop updating waveform
  const updateCanvas = useCallback(() => {
    if (!canvasRef.current) return;
    const barCount = 36;
    const phase = wavePhaseRef.current;
    const activePlaying = isPlayingRef.current;
    const waveFractions = Array.from({ length: barCount }, (_, i) => {
      if (!activePlaying) {
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
  }, [quoteText, source, title]);

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
        animFrameRef.current = null;
      }
    };
  }, [isOpen, updateCanvas]);

  useEffect(() => {
    if (!isOpen) {
      stopAudio();
      return;
    }
    return () => {
      stopAudio();
    };
  }, [isOpen, stopAudio]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, onClose]);

  const toggleAudio = async () => {
    if (isPlaying) {
      stopAudio();
      return;
    }

    const cleanQuote = quoteText.trim();
    if (!cleanQuote) return;

    stopAudio();
    const controller = new AbortController();
    abortRef.current = controller;
    let fellBack = false;

    const triggerFallback = () => {
      if (controller.signal.aborted || fellBack) return;
      fellBack = true;
      fallbackToBrowserSpeech(cleanQuote);
    };

    try {
      let parts: string[];
      try {
        parts = articleNarrationParts("", [cleanQuote], 900);
      } catch {
        parts = [cleanQuote.slice(0, 900)];
      }
      if (!parts.length) {
        parts = [cleanQuote.slice(0, 900)];
      }

      const streamUrl = await openArticleAudioStream(
        parts,
        "en-NZ",
        { en: activeVoice, zh: "zh-CN-XiaoxiaoNeural" },
        controller.signal,
        (status) => {
          if (status.error) {
            triggerFallback();
          }
        },
      );

      if (controller.signal.aborted || fellBack) return;

      if (!streamUrl) {
        triggerFallback();
        return;
      }

      const audio = new Audio(streamUrl);
      audioRef.current = audio;
      audio.onended = () => {
        if (!fellBack && audioRef.current === audio) {
          audioRef.current = null;
          setIsPlaying(false);
        }
      };
      audio.onerror = () => {
        triggerFallback();
      };
      setIsPlaying(true);
      await audio.play();
    } catch {
      triggerFallback();
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
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
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
