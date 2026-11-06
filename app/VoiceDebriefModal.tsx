import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  DebriefPreset,
  VoiceDebriefResponse,
  fetchDebriefPresets,
  sendVoiceDebriefQuery,
  fetchDebriefAudioBlob,
  getIntentBadgeColor,
  getIntentIcon,
  splitIntoSentences,
  formatDebriefDigest,
} from "./voice-debrief.ts";
import "./voice-debrief.css";

export interface VoiceDebriefArticle {
  title: string;
  source: string;
  url: string;
  summary?: string;
  topics?: string[];
}

export interface VoiceDebriefModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: VoiceDebriefArticle[];
  marketContext?: string;
  preferredVoice?: string;
}

type InteractionState = "idle" | "listening" | "processing" | "speaking" | "error";

export default function VoiceDebriefModal({
  isOpen,
  onClose,
  articles = [],
  marketContext = "",
  preferredVoice,
}: VoiceDebriefModalProps) {
  const [state, setState] = useState<InteractionState>("idle");
  const [queryText, setQueryText] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [presets, setPresets] = useState<DebriefPreset[]>([]);
  const [response, setResponse] = useState<VoiceDebriefResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeSentenceIndex, setActiveSentenceIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isCopied, setIsCopied] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const sentencesRef = useRef<string[]>([]);
  const timerRef = useRef<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load presets on mount
  useEffect(() => {
    if (isOpen) {
      fetchDebriefPresets().then(setPresets).catch(() => {});
    }
  }, [isOpen]);

  // Clean up audio and recognition on close/unmount
  useEffect(() => {
    return () => {
      stopAudio();
      stopListening();
    };
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }
  }, []);

  // Submit query for debrief synthesis
  const handleSubmitQuery = useCallback(
    async (textToSubmit: string) => {
      const q = textToSubmit.trim();
      if (!q) return;

      stopAudio();
      stopListening();
      setState("processing");
      setErrorMessage("");
      setQueryText(q);

      try {
        const result = await sendVoiceDebriefQuery({
          query: q,
          articles: articles.slice(0, 20).map((a) => ({
            title: a.title,
            source: a.source,
            url: a.url,
            summary: a.summary,
            topics: a.topics,
          })),
          marketContext,
          voice: preferredVoice,
        });

        setResponse(result);
        sentencesRef.current = splitIntoSentences(result.spokenScript);
        setActiveSentenceIndex(0);

        // Attempt neural speech playback or Web Speech synthesis fallback
        playSpokenResponse(result.spokenScript);
      } catch (err: any) {
        setState("error");
        setErrorMessage(err?.message || "Failed to generate voice debrief.");
      }
    },
    [articles, marketContext, preferredVoice, stopAudio, stopListening],
  );

  // Spoken response playback engine
  const playSpokenResponse = useCallback(
    async (scriptText: string) => {
      setState("speaking");

      // Try fetching neural audio from server
      try {
        const blob = await fetchDebriefAudioBlob(scriptText, preferredVoice);
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.playbackRate = playbackSpeed;
        audioRef.current = audio;

        // Pacing sentence highlights
        const sentences = sentencesRef.current;
        const totalDurationEstimate = Math.max(4, scriptText.split(" ").length * 0.38);
        const sentenceIntervalMs = Math.max(1200, (totalDurationEstimate * 1000) / Math.max(1, sentences.length));

        let currentIdx = 0;
        timerRef.current = setInterval(() => {
          if (currentIdx < sentences.length - 1) {
            currentIdx++;
            setActiveSentenceIndex(currentIdx);
          }
        }, sentenceIntervalMs / playbackSpeed);

        audio.onended = () => {
          if (timerRef.current) clearInterval(timerRef.current);
          setActiveSentenceIndex(sentences.length - 1);
          setState("idle");
          URL.revokeObjectURL(url);
        };

        audio.onerror = () => {
          fallbackBrowserSpeech(scriptText);
        };

        await audio.play();
      } catch {
        // Fallback to browser SpeechSynthesis
        fallbackBrowserSpeech(scriptText);
      }
    },
    [playbackSpeed, preferredVoice],
  );

  const fallbackBrowserSpeech = useCallback(
    (scriptText: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) {
        setState("idle");
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(scriptText);
      utterance.rate = playbackSpeed;

      const sentences = sentencesRef.current;
      const totalWords = scriptText.split(" ").length;
      const approxDurationMs = (totalWords / 2.8) * 1000;
      const intervalMs = approxDurationMs / Math.max(1, sentences.length);

      let currentIdx = 0;
      timerRef.current = setInterval(() => {
        if (currentIdx < sentences.length - 1) {
          currentIdx++;
          setActiveSentenceIndex(currentIdx);
        }
      }, intervalMs / playbackSpeed);

      utterance.onend = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        setActiveSentenceIndex(sentences.length - 1);
        setState("idle");
      };

      utterance.onerror = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        setState("idle");
      };

      window.speechSynthesis.speak(utterance);
    },
    [playbackSpeed],
  );

  // Toggle voice recognition
  const toggleListening = useCallback(() => {
    if (state === "listening") {
      stopListening();
      setState("idle");
      return;
    }

    stopAudio();
    setLiveTranscript("");
    setErrorMessage("");

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setErrorMessage("Speech recognition is not supported in this browser. Please type your query.");
      setState("error");
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = "en-US";
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => {
        setState("listening");
      };

      recognition.onresult = (event: any) => {
        let interim = "";
        let final = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }

        const currentText = final || interim;
        setLiveTranscript(currentText);

        if (final) {
          handleSubmitQuery(final);
        }
      };

      recognition.onerror = (e: any) => {
        if (e.error !== "no-speech") {
          setErrorMessage(`Microphone error: ${e.error}`);
          setState("error");
        } else {
          setState("idle");
        }
      };

      recognition.onend = () => {
        setState((current) => (current === "listening" ? "idle" : current));
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (e: any) {
      setErrorMessage(`Microphone initialization failed: ${e?.message || e}`);
      setState("error");
    }
  }, [handleSubmitQuery, liveTranscript, state, stopAudio, stopListening]);

  // Handle speed change
  const handleSpeedToggle = () => {
    const nextSpeed = playbackSpeed === 1 ? 1.25 : playbackSpeed === 1.25 ? 1.5 : 1;
    setPlaybackSpeed(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
  };

  // Replay spoken debrief
  const handleReplay = () => {
    if (response) {
      stopAudio();
      playSpokenResponse(response.spokenScript);
    }
  };

  // Copy memo to clipboard
  const handleCopyMemo = () => {
    if (!response) return;
    const memo = formatDebriefDigest(response);
    navigator.clipboard.writeText(memo);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Keyboard accessibility
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const intentColor = response ? getIntentBadgeColor(response.intentCategory) : null;
  const intentIcon = response ? getIntentIcon(response.intentCategory) : "🎙️";

  return (
    <div className="voice-debrief-overlay" role="dialog" aria-modal="true" aria-label="Talk to Signal Voice Debrief">
      <div className="voice-debrief-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="voice-debrief-modal">
        {/* Header */}
        <div className="voice-debrief-header">
          <div className="voice-debrief-header-title">
            <span className="voice-debrief-header-icon" aria-hidden="true">🎙️</span>
            <div>
              <h2>Talk to Signal</h2>
              <p>Conversational Executive Voice Debrief & Strategic Intelligence</p>
            </div>
          </div>
          <button
            type="button"
            className="voice-debrief-close-btn"
            onClick={onClose}
            aria-label="Close Voice Debrief"
          >
            &times;
          </button>
        </div>

        {/* Central Audio Orb Stage */}
        <div className={`voice-debrief-stage state-${state}`}>
          <div className="voice-orb-container">
            <div className="voice-orb-wave wave-3" />
            <div className="voice-orb-wave wave-2" />
            <div className="voice-orb-wave wave-1" />
            <button
              type="button"
              className={`voice-orb-core state-${state}`}
              onClick={toggleListening}
              title={state === "listening" ? "Listening... click to stop" : "Click to speak"}
              aria-label={state === "listening" ? "Listening to your question" : "Activate microphone"}
            >
              <span className="voice-orb-icon" aria-hidden="true">
                {state === "listening" ? "⏹️" : state === "speaking" ? "🔊" : state === "processing" ? "⏳" : "🎙️"}
              </span>
            </button>
          </div>

          <div className="voice-status-text">
            {state === "listening" && (
              <span className="voice-listening-pulse">
                Listening... {liveTranscript ? `"${liveTranscript}"` : "speak your question now"}
              </span>
            )}
            {state === "processing" && (
              <span className="voice-processing-text">
                Synthesizing executive intelligence brief...
              </span>
            )}
            {state === "speaking" && (
              <span className="voice-speaking-text">
                Broadcasting neural executive debrief
              </span>
            )}
            {state === "idle" && (
              <span className="voice-idle-text">
                Tap microphone to speak or select a strategic prompt below
              </span>
            )}
            {state === "error" && (
              <span className="voice-error-text">
                {errorMessage || "An error occurred."}
              </span>
            )}
          </div>

          {/* Equalizer Wave Bars (active during speaking) */}
          {state === "speaking" && (
            <div className="voice-equalizer-bars" aria-hidden="true">
              {Array.from({ length: 16 }).map((_, i) => (
                <span key={i} className={`eq-bar bar-${(i % 5) + 1}`} />
              ))}
            </div>
          )}
        </div>

        {/* Input Bar */}
        <div className="voice-debrief-input-row">
          <input
            ref={inputRef}
            type="text"
            className="voice-debrief-text-input"
            placeholder="Or type a strategic question... (e.g. 'What are the main risks facing NVIDIA?')"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSubmitQuery(queryText);
              }
            }}
          />
          <button
            type="button"
            className="voice-debrief-send-btn"
            onClick={() => handleSubmitQuery(queryText)}
            disabled={!queryText.trim() || state === "processing"}
          >
            Ask Signal &rarr;
          </button>
        </div>

        {/* Scrollable Content: Presets or Response */}
        <div className="voice-debrief-content">
          {/* Quick Strategic Presets */}
          {!response && (
            <div className="voice-debrief-presets-panel">
              <span className="voice-presets-title">⚡ Quick Executive Inquiries:</span>
              <div className="voice-presets-grid">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="voice-preset-card"
                    onClick={() => {
                      setQueryText(preset.query);
                      handleSubmitQuery(preset.query);
                    }}
                  >
                    <span className="preset-card-icon">{preset.icon}</span>
                    <div className="preset-card-body">
                      <strong>{preset.title}</strong>
                      <p>{preset.query}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Generated Debrief Response */}
          {response && (
            <div className="voice-response-card">
              {/* Query & Intent Header */}
              <div className="voice-response-top">
                <div className="voice-response-meta">
                  <span
                    className="voice-intent-badge"
                    style={{
                      background: intentColor?.bg,
                      borderColor: intentColor?.border,
                      color: intentColor?.text,
                    }}
                  >
                    {intentIcon} {response.intentCategory}
                  </span>
                  <span className="voice-response-query">&ldquo;{response.query}&rdquo;</span>
                </div>
                <div className="voice-response-actions">
                  <button
                    type="button"
                    className="voice-action-pill"
                    onClick={handleSpeedToggle}
                    title="Toggle audio playback rate"
                  >
                    ⚡ {playbackSpeed}x Speed
                  </button>
                  <button
                    type="button"
                    className="voice-action-pill"
                    onClick={handleReplay}
                    title="Replay spoken audio"
                  >
                    🔁 Replay
                  </button>
                  <button
                    type="button"
                    className="voice-action-pill"
                    onClick={handleCopyMemo}
                    title="Copy executive briefing memo"
                  >
                    {isCopied ? "✓ Copied" : "📋 Copy Memo"}
                  </button>
                </div>
              </div>

              {/* Spoken Script with Karaoke Sentences */}
              <div className="voice-script-container">
                <span className="voice-section-label">📢 Spoken Briefing Transcript:</span>
                <p className="voice-script-p">
                  {sentencesRef.current.map((sentence, idx) => (
                    <span
                      key={idx}
                      className={`voice-sentence${idx === activeSentenceIndex && state === "speaking" ? " is-active-sentence" : ""}`}
                    >
                      {sentence}{" "}
                    </span>
                  ))}
                </p>
              </div>

              {/* Key Takeaways */}
              {response.keyTakeaways && response.keyTakeaways.length > 0 && (
                <div className="voice-takeaways-block">
                  <span className="voice-section-label">🎯 Key Strategic Takeaways:</span>
                  <div className="voice-takeaways-list">
                    {response.keyTakeaways.map((takeaway, i) => (
                      <div key={i} className="voice-takeaway-item">
                        <span className="takeaway-num">{i + 1}</span>
                        <p>{takeaway}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Verified Citations */}
              {response.citations && response.citations.length > 0 && (
                <div className="voice-citations-block">
                  <span className="voice-section-label">📚 Verified Evidence Citations:</span>
                  <div className="voice-citations-grid">
                    {response.citations.map((cite, i) => (
                      <a
                        key={i}
                        href={cite.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="voice-citation-chip"
                      >
                        <span className="citation-source">{cite.source}</span>
                        <span className="citation-title">{cite.title}</span>
                        <span className="citation-arrow">&nearr;</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Suggested Follow-Ups */}
              {response.suggestedFollowUps && response.suggestedFollowUps.length > 0 && (
                <div className="voice-followups-block">
                  <span className="voice-section-label">💡 Recommended Follow-Up Questions:</span>
                  <div className="voice-followups-chips">
                    {response.suggestedFollowUps.map((prompt, i) => (
                      <button
                        key={i}
                        type="button"
                        className="voice-followup-btn"
                        onClick={() => {
                          setQueryText(prompt);
                          handleSubmitQuery(prompt);
                        }}
                      >
                        <span>?</span> {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="voice-debrief-footer">
          <div className="voice-footer-info">
            <span className="voice-footer-dot" aria-hidden="true" />
            Neural Voice Synthesis & Natural Speech Recognition Active
          </div>
          <span className="voice-footer-hint">Press <kbd>Space</kbd> to talk, <kbd>Esc</kbd> to exit</span>
        </div>
      </div>
    </div>
  );
}
