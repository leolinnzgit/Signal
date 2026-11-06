import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  CastPreset,
  DailyCastResponse,
  CastDialogTurn,
  fetchDailyCastEpisodes,
  synthesizeDailyCast,
  getHostVoiceParams,
  formatPodcastShowNotes,
} from "./daily-cast.ts";
import "./daily-cast.css";

interface DailyCastModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; summary?: string }>;
}

export function DailyCastModal({
  isOpen,
  onClose,
  articles = [],
}: DailyCastModalProps) {
  const [presets, setPresets] = useState<CastPreset[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string>("macro-divergence");
  const [cast, setCast] = useState<DailyCastResponse | null>(null);
  const [currentTurnIdx, setCurrentTurnIdx] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const turnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const synthRef = useRef<SpeechSynthesis | null>(null);

  // Initialize presets
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadPresets() {
      try {
        const data = await fetchDailyCastEpisodes();
        if (!isCancelled && data.length > 0) {
          setPresets(data);
          if (!data.some((p) => p.id === selectedTopicId)) {
            setSelectedTopicId(data[0].id);
          }
        }
      } catch (err) {
        console.warn("Using default cast presets:", err);
      }
    }

    loadPresets();
    return () => {
      isCancelled = true;
    };
  }, [isOpen]);

  // Synthesize cast on topic change
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadCast() {
      try {
        const res = await synthesizeDailyCast(selectedTopicId, articles);
        if (!isCancelled) {
          setCast(res);
          setCurrentTurnIdx(0);
          setIsPlaying(false);
          if (synthRef.current) synthRef.current.cancel();
        }
      } catch (err) {
        console.error("Failed to synthesize daily cast:", err);
      }
    }

    loadCast();
    return () => {
      isCancelled = true;
    };
  }, [isOpen, selectedTopicId, articles]);

  // Clean up speech on unmount or close
  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      synthRef.current = window.speechSynthesis;
    }
    return () => {
      synthRef.current?.cancel();
    };
  }, []);

  const activeTurn: CastDialogTurn | undefined = useMemo(() => {
    return cast?.dialogTurns[currentTurnIdx];
  }, [cast, currentTurnIdx]);

  // Auto scroll active turn into view
  useEffect(() => {
    if (turnRefs.current[currentTurnIdx]) {
      turnRefs.current[currentTurnIdx]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [currentTurnIdx]);

  // Sequential speech synthesizer
  const playTurn = (index: number) => {
    if (!cast || !cast.dialogTurns[index]) {
      setIsPlaying(false);
      return;
    }

    const turn = cast.dialogTurns[index];
    setCurrentTurnIdx(index);

    if (synthRef.current) {
      synthRef.current.cancel();
      const utterance = new SpeechSynthesisUtterance(turn.text);
      const params = getHostVoiceParams(turn.speaker);
      utterance.pitch = params.pitch;
      utterance.rate = params.rate;

      utterance.onend = () => {
        if (index + 1 < cast.dialogTurns.length) {
          playTurn(index + 1);
        } else {
          setIsPlaying(false);
          setCurrentTurnIdx(0);
        }
      };

      utterance.onerror = () => {
        setIsPlaying(false);
      };

      synthRef.current.speak(utterance);
    }
  };

  const handleTogglePlay = () => {
    if (isPlaying) {
      synthRef.current?.cancel();
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      playTurn(currentTurnIdx);
    }
  };

  const handleCopyShowNotes = async () => {
    if (!cast) return;
    const memo = formatPodcastShowNotes(cast);
    try {
      await navigator.clipboard.writeText(memo);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  if (!isOpen) return null;

  const activeSpeaker = activeTurn?.speaker || "david";

  return (
    <div className="cast-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cast-title">
      <div className="cast-modal-container">
        {/* Header */}
        <div className="cast-header">
          <div className="cast-title-group">
            <span className="cast-title-icon" aria-hidden="true">🎙️</span>
            <div>
              <h2 id="cast-title" className="cast-title">Signal Studio Daily Cast • 2-Host Executive Podcast</h2>
              <p className="cast-subtitle">Autonomous multi-host strategic conversation between David Vance and Sarah Chen</p>
            </div>
          </div>
          <button
            type="button"
            className="cast-close-btn"
            onClick={() => {
              synthRef.current?.cancel();
              onClose();
            }}
            aria-label="Close Daily Cast"
          >
            ✕
          </button>
        </div>

        {/* Episode Topics Bar */}
        <div className="cast-episodes-bar">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`cast-episode-tab ${p.id === selectedTopicId ? "active" : ""}`}
              onClick={() => {
                synthRef.current?.cancel();
                setSelectedTopicId(p.id);
              }}
            >
              <span>📻</span>
              <span>{p.title}</span>
            </button>
          ))}
        </div>

        {/* Studio Hosts Stage */}
        <div className="cast-stage">
          <div className="cast-hosts-row">
            {/* David Vance Card */}
            <div className={`cast-host-card ${isPlaying && activeSpeaker === "david" ? "speaking-david" : ""}`}>
              <div className="cast-host-avatar">🎙️</div>
              <div className="cast-host-meta">
                <span className="cast-host-name">David Vance</span>
                <span className="cast-host-role">Chief Macro Strategist</span>
              </div>
            </div>

            {/* Waveform Visualizer */}
            <div className="cast-waveform-wrapper">
              {Array.from({ length: 16 }).map((_, i) => (
                <div
                  key={i}
                  className={`cast-wave-bar ${activeSpeaker === "sarah" ? "sarah" : ""} ${isPlaying ? "active" : ""}`}
                  style={{ animationDelay: `${(i % 5) * 0.12}s` }}
                />
              ))}
            </div>

            {/* Sarah Chen Card */}
            <div className={`cast-host-card ${isPlaying && activeSpeaker === "sarah" ? "speaking-sarah" : ""}`}>
              <div className="cast-host-avatar">🎧</div>
              <div className="cast-host-meta">
                <span className="cast-host-name">Sarah Chen</span>
                <span className="cast-host-role">Geopolitical & Deep Tech Lead</span>
              </div>
            </div>
          </div>

          {/* Player controls */}
          <div className="cast-player-controls">
            <button
              type="button"
              className="cast-play-btn"
              onClick={handleTogglePlay}
            >
              {isPlaying ? "⏸ Pause Cast" : "▶ Play Daily Cast"}
            </button>

            <div className="cast-progress-bar">
              <div
                className="cast-progress-fill"
                style={{
                  width: `${cast?.dialogTurns.length ? ((currentTurnIdx + 1) / cast.dialogTurns.length) * 100 : 0}%`,
                }}
              />
            </div>

            <span style={{ fontSize: "0.75rem", color: "#94a3b8", fontFamily: "monospace" }}>
              Turn {currentTurnIdx + 1} of {cast?.dialogTurns.length || 6}
            </span>
          </div>
        </div>

        {/* Verbatim Transcript */}
        <div className="cast-transcript-body">
          {(cast?.dialogTurns || []).map((turn, idx) => (
            <div
              key={idx}
              ref={(el) => {
                turnRefs.current[idx] = el;
              }}
              className={`cast-turn-item ${idx === currentTurnIdx ? "active" : ""}`}
            >
              <div style={{ fontSize: "1.4rem" }}>{turn.avatarEmoji}</div>
              <div style={{ flex: 1 }}>
                <div className={`cast-turn-speaker speaker-${turn.speaker}`}>
                  {turn.speakerName} • {turn.speakerRole}
                </div>
                <div className="cast-turn-text">"{turn.text}"</div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="cast-footer">
          <div style={{ fontSize: "0.76rem", color: "#94a3b8" }}>
            Dual-host speech synthesizer • Pitch & rate modulated.
            {copied && <span style={{ marginLeft: "1rem", color: "#10b981", fontWeight: 700 }}>✓ Show Notes Copied</span>}
          </div>

          <button
            type="button"
            className="cast-export-btn"
            onClick={handleCopyShowNotes}
          >
            📋 Export Show Notes & Transcript (.md)
          </button>
        </div>
      </div>
    </div>
  );
}
