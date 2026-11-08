import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  CastPreset,
  DailyCastAudioStatus,
  DailyCastResponse,
  CastDialogTurn,
  fetchDailyCastAudioStatus,
  fetchDailyCastEpisodes,
  synthesizeDailyCast,
  synthesizeDailyCastAudio,
  resolveTurnIndexAtTime,
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
  const [selectedTopicId, setSelectedTopicId] = useState<string>(() =>
    articles.length > 0 ? "live-wire" : "macro-divergence"
  );
  const [cast, setCast] = useState<DailyCastResponse | null>(null);
  const [audioStatus, setAudioStatus] = useState<DailyCastAudioStatus | null>(null);
  const [currentTurnIdx, setCurrentTurnIdx] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [audioEngine, setAudioEngine] = useState<"idle" | "rendering" | "azure-neural" | "browser">("idle");
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [audioStarts, setAudioStarts] = useState<number[]>([]);
  const [copied, setCopied] = useState<boolean>(false);

  const turnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const activeBlobUrlRef = useRef<string | null>(null);

  const stopAllAudio = () => {
    synthRef.current?.cancel();
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
    }
    setIsPlaying(false);
  };

  const releaseBlobUrl = () => {
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }
    setAudioBlobUrl(null);
    setAudioStarts([]);
  };

  // Initialize presets & studio neural status when modal opens
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadMeta() {
      const [episodesRes, statusRes] = await Promise.allSettled([
        fetchDailyCastEpisodes(),
        fetchDailyCastAudioStatus(),
      ]);

      if (isCancelled) return;
      if (episodesRes.status === "fulfilled" && episodesRes.value.length > 0) {
        const list = episodesRes.value;
        setPresets(list);
        if (!list.some((p) => p.id === selectedTopicId)) {
          setSelectedTopicId(articles.length > 0 && list.some((p) => p.id === "live-wire") ? "live-wire" : list[0].id);
        }
      }
      if (statusRes.status === "fulfilled") {
        setAudioStatus(statusRes.value);
      }
    }

    void loadMeta();
    return () => {
      isCancelled = true;
    };
  }, [isOpen]);

  // Synthesize cast script on topic change or open
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadCast() {
      stopAllAudio();
      releaseBlobUrl();
      setAudioEngine("idle");
      try {
        const res = await synthesizeDailyCast(selectedTopicId, articles);
        if (!isCancelled) {
          setCast(res);
          setCurrentTurnIdx(0);
        }
      } catch (err) {
        console.error("Failed to synthesize daily cast:", err);
      }
    }

    void loadCast();
    return () => {
      isCancelled = true;
    };
  }, [isOpen, selectedTopicId, articles]);

  // Clean up speech & object URLs on unmount
  useEffect(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      synthRef.current = window.speechSynthesis;
    }
    return () => {
      synthRef.current?.cancel();
      if (activeBlobUrlRef.current) {
        URL.revokeObjectURL(activeBlobUrlRef.current);
        activeBlobUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stopAllAudio();
        releaseBlobUrl();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

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

  // Sequential browser SpeechSynthesis fallback
  const playBrowserTurn = (index: number) => {
    if (!cast || !cast.dialogTurns[index]) {
      setIsPlaying(false);
      return;
    }

    const turn = cast.dialogTurns[index];
    setCurrentTurnIdx(index);
    setAudioEngine("browser");

    if (synthRef.current) {
      synthRef.current.cancel();
      const utterance = new SpeechSynthesisUtterance(turn.text);
      const params = getHostVoiceParams(turn.speaker);
      utterance.pitch = params.pitch;
      utterance.rate = params.rate;

      utterance.onend = () => {
        if (index + 1 < cast.dialogTurns.length) {
          playBrowserTurn(index + 1);
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

  const handleTogglePlay = async () => {
    if (isPlaying) {
      if (audioEngine === "azure-neural" && audioElRef.current) {
        audioElRef.current.pause();
        setIsPlaying(false);
      } else {
        synthRef.current?.cancel();
        setIsPlaying(false);
      }
      return;
    }

    if (!cast || cast.dialogTurns.length === 0) return;

    // Resume existing synthesized Azure WAV buffer if already loaded
    if (audioBlobUrl && audioElRef.current) {
      try {
        setAudioEngine("azure-neural");
        await audioElRef.current.play();
        setIsPlaying(true);
        return;
      } catch {
        // Fall through to browser speech if play rejected
      }
    }

    const canTryNeural = Boolean(
      (audioStatus?.neuralAvailable || cast.neuralAudioAvailable) &&
      (audioStatus?.authenticated ?? true)
    );

    if (canTryNeural) {
      setAudioEngine("rendering");
      setIsPlaying(true);
      try {
        const audioRes = await synthesizeDailyCastAudio(cast.dialogTurns, 350);
        const objectUrl = URL.createObjectURL(audioRes.blob);
        activeBlobUrlRef.current = objectUrl;
        setAudioBlobUrl(objectUrl);
        setAudioStarts(audioRes.starts);
        setAudioEngine("azure-neural");

        requestAnimationFrame(() => {
          const el = audioElRef.current;
          if (!el) return;
          el.src = objectUrl;
          void el.play().catch(() => {
            playBrowserTurn(currentTurnIdx);
          });
        });
        return;
      } catch {
        // Expected cleanly for unauthenticated users (401) or offline/503; fall back silently
      }
    }

    setIsPlaying(true);
    playBrowserTurn(currentTurnIdx);
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
  const liveCount = cast?.liveArticleCount ?? articles.length;

  return (
    <div className="cast-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cast-title">
      <div className="cast-modal-container">
        {/* Hidden synchronized HTML audio element for studio WAV playback */}
        <audio
          ref={audioElRef}
          preload="auto"
          onTimeUpdate={(e) => {
            if (audioEngine !== "azure-neural") return;
            const idx = resolveTurnIndexAtTime(e.currentTarget.currentTime, audioStarts);
            if (idx !== currentTurnIdx) setCurrentTurnIdx(idx);
          }}
          onEnded={() => {
            setIsPlaying(false);
            setCurrentTurnIdx(0);
          }}
        />

        {/* Header */}
        <div className="cast-header">
          <div className="cast-title-group">
            <span className="cast-title-icon" aria-hidden="true">🎙️</span>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <h2 id="cast-title" className="cast-title">Signal Studio Daily Cast • 2-Host Executive Podcast</h2>
                {liveCount > 0 && (
                  <span
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: "999px",
                      background: "rgba(239, 68, 68, 0.16)",
                      color: "#fca5a5",
                      border: "1px solid rgba(239, 68, 68, 0.35)",
                    }}
                  >
                    🔴 Live Wire Grounded ({liveCount} articles)
                  </span>
                )}
              </div>
              <p className="cast-subtitle">Autonomous multi-host strategic conversation between David Vance and Sarah Chen</p>
            </div>
          </div>
          <button
            type="button"
            className="cast-close-btn"
            onClick={() => {
              stopAllAudio();
              releaseBlobUrl();
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
                stopAllAudio();
                releaseBlobUrl();
                setSelectedTopicId(p.id);
              }}
            >
              <span>{p.id === "live-wire" ? "⚡" : "📻"}</span>
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
              onClick={() => void handleTogglePlay()}
            >
              {audioEngine === "rendering"
                ? "⏳ Rendering Studio Voices..."
                : isPlaying
                  ? "⏸ Pause Cast"
                  : "▶ Play Daily Cast"}
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
          <div style={{ fontSize: "0.76rem", color: "#94a3b8", display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <span>
              {audioEngine === "azure-neural"
                ? "✨ Azure Neural Multi-Voice Studio Active"
                : audioStatus?.neuralAvailable && audioStatus.authenticated
                  ? "✨ Azure Neural Multi-Voice Ready"
                  : "🔊 Dual-host pitch/rate synth" + (audioStatus?.neuralAvailable && !audioStatus.authenticated ? " (Sign in for Studio WAV)" : "")}
            </span>
            {audioBlobUrl && (
              <a
                href={audioBlobUrl}
                download={`signal-daily-cast-${cast?.episodeId || "episode"}.wav`}
                style={{ color: "#38bdf8", textDecoration: "underline", fontWeight: 600 }}
              >
                ⬇ Download .wav
              </a>
            )}
            {copied && <span style={{ color: "#10b981", fontWeight: 700 }}>✓ Show Notes Copied</span>}
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
