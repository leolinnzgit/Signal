"use client";

import React, { useState, useRef, useEffect } from "react";
import { interrogateArticle, type InterrogateArticleResponse } from "./article-interrogation";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import VoiceMicButton from "./VoiceMicButton";

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

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsSpeaking(false);
  };

  useEffect(() => {
    return () => {
      stopAudio();
      abortRef.current?.abort();
    };
  }, []);

  const handleAsk = async (qText: string) => {
    const cleanQ = qText.trim();
    if (cleanQ.length < 3) return;

    stopAudio();
    setQuestion(cleanQ);
    setLoading(true);
    setError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await interrogateArticle(
        {
          url: article.url,
          title: article.title,
          source: article.source,
          paragraphs: article.paragraphs,
          question: cleanQ,
        },
        controller.signal,
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Interrogation failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleSpeakAnswer = async () => {
    if (!result?.answer) return;
    if (isSpeaking) {
      stopAudio();
      return;
    }

    try {
      const controller = new AbortController();
      const streamUrl = await openArticleAudioStream(
        [result.answer],
        "en-NZ",
        { en: activeVoice, zh: "zh-CN-XiaoxiaoNeural" },
        controller.signal,
        () => {},
      );

      if (streamUrl) {
        const audio = new Audio(streamUrl);
        audioRef.current = audio;
        audio.onended = () => setIsSpeaking(false);
        audio.onerror = () => setIsSpeaking(false);
        await audio.play();
        setIsSpeaking(true);
      }
    } catch {
      // Fallback
      if (typeof window !== "undefined" && window.speechSynthesis) {
        const ut = new SpeechSynthesisUtterance(result.answer);
        ut.onend = () => setIsSpeaking(false);
        window.speechSynthesis.speak(ut);
        setIsSpeaking(true);
      }
    }
  };

  return (
    <div
      className="interrogate-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="interrogate-title"
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
            void handleAsk(question);
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
          <button type="submit" className="interrogate-submit-btn" disabled={loading || question.trim().length < 3}>
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
