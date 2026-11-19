"use client";

import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { interrogateArticle, type InterrogateArticleResponse } from "./article-interrogation";
import { openArticleAudioStream } from "./article-audio-stream";
import { articleNarrationParts, resolveUserReadingVoice } from "./headline-audio";
import VoiceMicButton from "./VoiceMicButton";
import "./daily-briefing.css";

export interface ArticleInterrogationModalProps {
  article: {
    url: string;
    title: string;
    source: string;
    paragraphs?: string[];
  };
  onClose: () => void;
  preferredVoice?: string;
}

const SUGGESTED_QUESTIONS = [
  "What counter-arguments are omitted by the publisher?",
  "What verifiable evidence supports the main claim?",
  "Who benefits financially or strategically?",
  "What downstream operational risks should executives anticipate?",
];

export default function ArticleInterrogationModal({
  article,
  onClose,
  preferredVoice,
}: ArticleInterrogationModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InterrogateArticleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const articleRef = useRef(article);
  articleRef.current = article;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const stopAudio = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      cancelListeningSpeech();
    }
    setIsSpeaking(false);
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
        cancelListeningSpeech();
        const ut = new SpeechSynthesisUtterance(text);
        ut.onend = () => setIsSpeaking(false);
        ut.onerror = () => setIsSpeaking(false);
        setIsSpeaking(true);
        speakListeningSpeech(ut, () => setIsSpeaking(false));
        return;
      } catch {}
    }
    setIsSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      stopAudio();
      abortRef.current?.abort();
    };
  }, [stopAudio]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleAsk = useCallback(async (qText: string) => {
    const cleanQ = qText.trim();
    if (cleanQ.length < 3) return;

    stopAudio();
    setQuestion(cleanQ);
    setLoading(true);
    setError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const currentArticle = articleRef.current;
    try {
      const res = await interrogateArticle(
        {
          url: currentArticle.url,
          title: currentArticle.title,
          source: currentArticle.source,
          paragraphs: currentArticle.paragraphs,
          question: cleanQ,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResult(res);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Interrogation failed.");
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }, [stopAudio]);

  useEffect(() => {
    setResult(null);
    setError(null);
    void handleAsk(SUGGESTED_QUESTIONS[0]);
  }, [article.url, article.title, handleAsk]);

  const handleSpeakAnswer = async () => {
    if (!result?.answer) return;
    if (isSpeaking) {
      stopAudio();
      return;
    }

    const cleanAnswer = result.answer.trim();
    if (!cleanAnswer) return;

    stopAudio();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    let fellBack = false;

    const triggerFallback = () => {
      if (controller.signal.aborted || fellBack) return;
      fellBack = true;
      fallbackToBrowserSpeech(cleanAnswer);
    };

    try {
      let parts: string[];
      try {
        parts = articleNarrationParts("", [cleanAnswer], 900);
      } catch {
        parts = [cleanAnswer.slice(0, 900)];
      }
      if (!parts.length) {
        parts = [cleanAnswer.slice(0, 900)];
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

      const audio = createListeningAudio(streamUrl, () => setIsSpeaking(false));
      audioRef.current = audio;
      audio.onended = () => {
        if (!fellBack && audioRef.current === audio) {
          audioRef.current = null;
          setIsSpeaking(false);
        }
      };
      audio.onerror = () => {
        triggerFallback();
      };
      setIsSpeaking(true);
      await audio.play();
    } catch {
      triggerFallback();
    }
  };

  return (
    <div
      className="interrogate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="interrogate-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="interrogate-modal-card">
        {/* Header */}
        <header className="interrogate-header">
          <div>
            <span className="interrogate-badge">⚖️ SOCRATIC ARTICLE INTERROGATION</span>
            <h3 id="interrogate-title" className="interrogate-title">
              {article.title}
            </h3>
            <p className="interrogate-source">Reporting by {article.source}</p>
          </div>
          <button
            type="button"
            className="interrogate-close-btn"
            onClick={onClose}
            aria-label="Close interrogation"
          >
            ✕
          </button>
        </header>

        {/* Suggestion Chips */}
        <div className="interrogate-chips-row">
          <span className="chips-label">Critical Inquiries:</span>
          <div className="chips-scroller">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className="interrogate-chip"
                onClick={() => void handleAsk(q)}
                disabled={loading}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* Query Input */}
        <form
          className="interrogate-form"
          onSubmit={(e) => {
            e.preventDefault();
            const targetQuestion = question.trim().length >= 3 ? question : SUGGESTED_QUESTIONS[0];
            void handleAsk(targetQuestion);
          }}
        >
          <input
            type="text"
            className="interrogate-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a critical question about assumptions, evidence, or biases..."
            disabled={loading}
          />
          <VoiceMicButton
            label="Speak question"
            disabled={loading}
            onVoiceCommand={(command) => {
              const spoken = command.raw || command.query;
              if (spoken) {
                setQuestion(spoken);
                void handleAsk(spoken);
              }
            }}
          />
          <button type="submit" className="interrogate-submit-btn" disabled={loading}>
            {loading ? "Analyzing..." : "Interrogate"}
          </button>
        </form>

        {error && (
          <p className="interrogate-error" role="alert">
            {error}
          </p>
        )}

        {/* Analysis Result */}
        {result && (
          <div className="interrogate-results-area" role="region" aria-label="Socratic Analysis Results">
            <div className="interrogate-answer-box">
              <div className="answer-header">
                <strong>Analytical Synthesis</strong>
                <button
                  type="button"
                  className="readout-btn"
                  onClick={() => void handleSpeakAnswer()}
                  title="Read answer aloud using Azure Neural Voice"
                >
                  {isSpeaking ? "⏹ Stop Azure Voice" : "🔊 Listen via Azure Neural"}
                </button>
              </div>
              <p className="answer-text">{result.answer}</p>
            </div>

            {/* Supporting Evidence */}
            {result.supportingEvidence && result.supportingEvidence.length > 0 && (
              <div className="interrogate-section">
                <span className="section-title">🔍 Verifiable Evidence &amp; Data:</span>
                <ul className="evidence-list">
                  {result.supportingEvidence.map((ev, i) => (
                    <li key={i}>{ev}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Omitted Perspectives */}
            {result.omittedPerspectives && result.omittedPerspectives.length > 0 && (
              <div className="interrogate-section">
                <span className="section-title">⚠️ Omitted Angles &amp; Critical Gaps:</span>
                <ul className="omitted-list">
                  {result.omittedPerspectives.map((om, i) => (
                    <li key={i}>{om}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Stakeholder Impact */}
            {result.stakeholderImpact && (
              <div className="interrogate-section">
                <span className="section-title">💼 Stakeholder Beneficiaries &amp; Exposure:</span>
                <p className="impact-text">{result.stakeholderImpact}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
