import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { openArticleAudioStream } from "./article-audio-stream";
import { translationLanguages } from "./article-translation";
import { briefingSpeechLocale } from "./daily-briefing-translation";
import {
  audioHeadlineIndex,
  getUserReadingVoicePreferences,
} from "./headline-audio";
import type { FollowedArticle } from "./NewsDashboard";
import {
  analyzeNewsTopicWithSignalBot,
  createHostedSignalBotShare,
  fetchSignalBotStatus,
  formatSignalBotMarkdown,
  getModelDisplayLabel,
  loadPreferredSignalBotModel,
  normalizeSignalBotArticles,
  resolveSelectedSignalBotModel,
  savePreferredSignalBotModel,
  sentimentBadgeMeta,
  SIGNAL_BOT_PRESETS,
  type SignalBotAnalyzeResponse,
  type SignalBotCitation,
  type SignalBotHistoryTurn,
  type SignalBotStatusResponse,
} from "./signal-bot";
import "./signal-bot.css";
import VoiceMicButton from "./VoiceMicButton";

export interface SignalBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles: FollowedArticle[];
  followedTopics: string[];
  initialTopic: string;
  autoRunPrompt?: string;
  onAutoRunConsumed?: () => void;
  tickerOverrides?: Record<string, string>;
  defaultLanguage?: string;
  onOpenArticle: (article: FollowedArticle, trigger: HTMLElement) => void;
  onListenArticle: (article: FollowedArticle, trigger: HTMLElement) => void;
}

interface ConversationTurn {
  id: string;
  topic: string;
  userPrompt: string;
  response?: SignalBotAnalyzeResponse;
  error?: string;
  sharePath?: string;
  shareUrl?: string;
  sharing?: boolean;
  shareError?: string;
}

function citationToFollowedArticle(citation: SignalBotCitation, topic: string): FollowedArticle {
  return {
    title: citation.title,
    url: citation.url,
    source: citation.source || "Publisher",
    publishedAt: citation.publishedAt || new Date().toISOString(),
    summary: citation.summary || "",
    topics: topic && topic !== "All followed topics" ? [topic] : [],
    providers: ["Signal Bot"],
  };
}

function renderInlineCitations(
  text: string,
  onClickCitation: (citationIndex: number) => void,
) {
  const parts = text.split(/(\[S\d+\])/g);
  return parts.map((part, idx) => {
    const match = /^\[S(\d+)\]$/.exec(part);
    if (!match) {
      return <React.Fragment key={idx}>{part}</React.Fragment>;
    }
    const index = Number(match[1]);
    return (
      <button
        key={idx}
        type="button"
        className="signal-bot-cite-tag"
        onClick={() => onClickCitation(index)}
        title={`Jump to source S${index}`}
      >
        {part}
      </button>
    );
  });
}

export default function SignalBotModal({
  isOpen,
  onClose,
  articles,
  followedTopics,
  initialTopic,
  autoRunPrompt = "",
  onAutoRunConsumed,
  tickerOverrides = {},
  defaultLanguage = "en",
  onOpenArticle,
  onListenArticle,
}: SignalBotModalProps) {
  const [status, setStatus] = useState<SignalBotStatusResponse>({
    available: true,
    provider: "Microsoft Foundry",
    model: "",
    availableModels: [],
  });
  const [statusLoading, setStatusLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(() => loadPreferredSignalBotModel());
  const [selectedTopic, setSelectedTopic] = useState<string>(initialTopic || followedTopics[0] || "All Topics");
  const [customTopicInput, setCustomTopicInput] = useState<string>("");
  const [customTopicOpen, setCustomTopicOpen] = useState<boolean>(false);
  const [includeLiveSearch, setIncludeLiveSearch] = useState<boolean>(true);
  const [language, setLanguage] = useState<string>(defaultLanguage || "en");
  const [promptInput, setPromptInput] = useState<string>("");
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [shareCopiedTurnId, setShareCopiedTurnId] = useState<string | null>(null);
  const [speakingTurnId, setSpeakingTurnId] = useState<string | null>(null);
  const [speakingSectionIndex, setSpeakingSectionIndex] = useState<number | null>(null);
  const [speakingLoading, setSpeakingLoading] = useState<boolean>(false);
  const [highlightedCitationKey, setHighlightedCitationKey] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioAbortRef = useRef<AbortController | null>(null);
  const startsRef = useRef<number[]>([]);
  const browserSpeakingRef = useRef<{ runId: number; speaking: boolean }>({
    runId: 0,
    speaking: false,
  });

  const selectableModels = useMemo(() => {
    if (!status.available) return [];
    if (status.availableModels.length > 0) return status.availableModels;
    return status.model ? [status.model] : [];
  }, [status]);

  const activeModel = useMemo(
    () => resolveSelectedSignalBotModel(status, selectedModel),
    [status, selectedModel],
  );

  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const customTopicInputRef = useRef<HTMLInputElement | null>(null);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  const lastAutoRunRef = useRef<string>("");

  const effectiveTopic = (customTopicInput.trim() || selectedTopic || "All Topics").trim();

  const localMatchingCount = useMemo(() => {
    const normalized = effectiveTopic.toLowerCase();
    if (!normalized || normalized === "all" || normalized === "all topics" || normalized === "all followed topics") {
      return articles.length;
    }
    return articles.filter((a) =>
      a.topics.some((t) => t.toLowerCase() === normalized)
      || `${a.title} ${a.summary}`.toLowerCase().includes(normalized),
    ).length;
  }, [articles, effectiveTopic]);

  const stopSpeech = () => {
    audioAbortRef.current?.abort();
    audioAbortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }
    browserSpeakingRef.current.speaking = false;
    browserSpeakingRef.current.runId++;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      cancelListeningSpeech();
    }
    setSpeakingTurnId(null);
    setSpeakingSectionIndex(null);
    setSpeakingLoading(false);
  };

  useEffect(() => {
    if (!speakingTurnId || speakingSectionIndex === null) return;
    const highlight = document.querySelector<HTMLElement>(
      ".signal-bot-turn-assistant .signal-bot-reading-highlight",
    );
    if (highlight) {
      highlight.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "nearest",
      });
    }
  }, [speakingTurnId, speakingSectionIndex]);

  useEffect(() => {
    if (!isOpen) {
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = null;
      stopSpeech();
      lastAutoRunRef.current = "";
      return;
    }

    setLanguage(defaultLanguage || "en");
    if (initialTopic) {
      const matchesFollowed = followedTopics.some((t) => t.toLowerCase() === initialTopic.toLowerCase())
        || initialTopic.toLowerCase() === "all topics";
      if (matchesFollowed) {
        setSelectedTopic(initialTopic);
        setCustomTopicInput("");
        setCustomTopicOpen(false);
      } else {
        setCustomTopicInput(initialTopic);
        setCustomTopicOpen(true);
      }
    }

    const controller = new AbortController();
    setStatusLoading(true);
    void fetchSignalBotStatus(controller.signal)
      .then((nextStatus) => {
        setStatus(nextStatus);
        const resolved = resolveSelectedSignalBotModel(nextStatus, loadPreferredSignalBotModel());
        if (resolved) {
          setSelectedModel(resolved);
        }
      })
      .catch(() => {
        // Keep modal usable if status check was aborted or transient; analyze endpoint reports exact errors.
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setStatusLoading(false);
        }
      });

    setTimeout(() => inputRef.current?.focus(), 60);
    return () => controller.abort();
  }, [isOpen, initialTopic, defaultLanguage, followedTopics]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, isAnalyzing]);

  async function runAnalysis(topicOverride?: string, promptOverride?: string) {
    if (isAnalyzing) return;

    const topicToAnalyze = (topicOverride ?? effectiveTopic).trim() || "All Topics";
    const questionText = (promptOverride ?? promptInput).trim();
    const displayPrompt = questionText || `Analyze ${topicToAnalyze}`;

    activeRequestAbortRef.current?.abort();
    const controller = new AbortController();
    activeRequestAbortRef.current = controller;

    const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const priorHistory: SignalBotHistoryTurn[] = turns
      .filter((t) => t.response)
      .slice(-4)
      .flatMap((t) => [
        { role: "user" as const, content: `Topic: ${t.topic}\nRequest: ${t.userPrompt}` },
        { role: "assistant" as const, content: `${t.response!.headline}\n\n${t.response!.analysis}` },
      ]);

    setTurns((prev) => [...prev, { id: turnId, topic: topicToAnalyze, userPrompt: displayPrompt }]);
    if (!promptOverride) {
      setPromptInput("");
    }
    setIsAnalyzing(true);
    stopSpeech();

    try {
      const normalizedArticles = normalizeSignalBotArticles(articles, topicToAnalyze, 40);
      const tickerOverride = tickerOverrides[topicToAnalyze] || "";
      const response = await analyzeNewsTopicWithSignalBot(
        {
          topic: topicToAnalyze,
          prompt: questionText || undefined,
          articles: normalizedArticles,
          history: priorHistory,
          tickerOverride: tickerOverride || undefined,
          language,
          includeLiveSearch,
          model: activeModel || undefined,
        },
        controller.signal,
      );

      setTurns((prev) =>
        prev.map((item) => (item.id === turnId ? { ...item, response } : item)),
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Signal Bot could not analyze that topic.";
      setTurns((prev) =>
        prev.map((item) => (item.id === turnId ? { ...item, error: message } : item)),
      );
    } finally {
      if (!controller.signal.aborted) {
        setIsAnalyzing(false);
      }
    }
  }

  useEffect(() => {
    if (!isOpen || !autoRunPrompt.trim()) return;
    const signature = `${initialTopic}::${autoRunPrompt}`;
    if (lastAutoRunRef.current === signature) return;
    lastAutoRunRef.current = signature;
    onAutoRunConsumed?.();
    void runAnalysis(initialTopic || "All Topics", autoRunPrompt);
  }, [isOpen, autoRunPrompt, initialTopic]);

  if (!isOpen) return null;

  const cleanSpeechText = (raw: string) =>
    (raw || "")
      .replace(/\s*\[S\d+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const buildSpeechParts = (response: SignalBotAnalyzeResponse) => {
    const cleanHeadline = cleanSpeechText(response.headline);
    const cleanParagraphs = response.analysis
      .split(/\n{2,}/)
      .map((p) => cleanSpeechText(p))
      .filter((p) => p.length > 0);
    const cleanDrivers = response.keyDrivers
      .map((d) => cleanSpeechText(d))
      .filter((d) => d.length > 0)
      .map((d) => `Key driver: ${d}`);
    const cleanPerspectives = response.perspectives
      .map((p) => cleanSpeechText(p))
      .filter((p) => p.length > 0)
      .map((p) => `Perspective: ${p}`);
    const cleanWatchNext = response.watchNext
      .map((w) => cleanSpeechText(w))
      .filter((w) => w.length > 0)
      .map((w) => `Watch next: ${w}`);

    return [
      cleanHeadline || "Signal AI Analysis",
      ...cleanParagraphs,
      ...cleanDrivers,
      ...cleanPerspectives,
      ...cleanWatchNext,
    ];
  };

  const fallbackToBrowserSpeech = (
    turnId: string,
    parts: string[],
    locale: string,
  ) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      stopSpeech();
      return;
    }

    setSpeakingLoading(false);
    setSpeakingTurnId(turnId);
    const runId = ++browserSpeakingRef.current.runId;
    browserSpeakingRef.current.speaking = true;

    let index = 0;
    const speakNext = () => {
      if (!browserSpeakingRef.current.speaking || browserSpeakingRef.current.runId !== runId) {
        return;
      }
      if (index >= parts.length) {
        stopSpeech();
        return;
      }

      const activeIdx = index++;
      setSpeakingSectionIndex(activeIdx);

      const utterance = new SpeechSynthesisUtterance(parts[activeIdx]);
      utterance.lang = locale;
      utterance.onend = () => {
        if (browserSpeakingRef.current.speaking && browserSpeakingRef.current.runId === runId) {
          speakNext();
        }
      };
      utterance.onerror = () => {
        stopSpeech();
      };
      speakListeningSpeech(utterance, stopSpeech);
    };

    cancelListeningSpeech();
    speakNext();
  };

  const toggleSpeakTurn = async (turnId: string, response: SignalBotAnalyzeResponse) => {
    if (speakingTurnId === turnId) {
      stopSpeech();
      return;
    }

    stopSpeech();
    setSpeakingTurnId(turnId);
    setSpeakingLoading(true);
    setSpeakingSectionIndex(0);

    const controller = new AbortController();
    audioAbortRef.current = controller;

    const parts = buildSpeechParts(response);
    const locale = briefingSpeechLocale(language);
    const voicePrefs = getUserReadingVoicePreferences();

    try {
      startsRef.current = [];
      const streamUrl = await openArticleAudioStream(
        parts,
        locale,
        voicePrefs,
        controller.signal,
        (status) => {
          if (Array.isArray(status.starts) && status.starts.length > 0) {
            startsRef.current = status.starts;
          }
        },
      );

      if (controller.signal.aborted) return;

      const audio = createListeningAudio(streamUrl, stopSpeech);
      audioRef.current = audio;

      const updateSectionHighlight = () => {
        const starts = startsRef.current;
        if (!starts || starts.length === 0) {
          setSpeakingSectionIndex(0);
          return;
        }
        const activeIdx = audioHeadlineIndex(starts, audio.currentTime);
        setSpeakingSectionIndex(activeIdx);
      };

      audio.addEventListener("playing", () => {
        setSpeakingLoading(false);
        updateSectionHighlight();
      });

      audio.addEventListener("timeupdate", updateSectionHighlight);

      audio.addEventListener("ended", () => {
        stopSpeech();
      });

      audio.addEventListener("error", () => {
        fallbackToBrowserSpeech(turnId, parts, locale);
      });

      await audio.play().catch(() => {
        if (!controller.signal.aborted) {
          fallbackToBrowserSpeech(turnId, parts, locale);
        }
      });
    } catch {
      if (!controller.signal.aborted) {
        fallbackToBrowserSpeech(turnId, parts, locale);
      }
    }
  };

  const copyTurnMarkdown = async (turnId: string, response: SignalBotAnalyzeResponse) => {
    try {
      await navigator.clipboard.writeText(formatSignalBotMarkdown(response));
      setCopiedTurnId(turnId);
      setTimeout(() => setCopiedTurnId((current) => (current === turnId ? null : current)), 1800);
    } catch {
      // Clipboard may be unavailable cleanly.
    }
  };

  const copyShareUrl = async (turnId: string, shareUrl: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopiedTurnId(turnId);
      setTimeout(() => setShareCopiedTurnId((current) => (current === turnId ? null : current)), 2200);
    } catch {
      // Clipboard may be unavailable cleanly.
    }
  };

  const shareTurnHosted = async (turn: ConversationTurn) => {
    if (!turn.response || turn.sharing) return;
    if (turn.shareUrl) {
      await copyShareUrl(turn.id, turn.shareUrl);
      return;
    }

    setTurns((prev) =>
      prev.map((item) => (item.id === turn.id ? { ...item, sharing: true, shareError: undefined } : item)),
    );

    try {
      const created = await createHostedSignalBotShare({
        topic: turn.response.topic || turn.topic,
        userPrompt: turn.userPrompt,
        headline: turn.response.headline,
        analysis: turn.response.analysis,
        keyDrivers: turn.response.keyDrivers,
        perspectives: turn.response.perspectives,
        watchNext: turn.response.watchNext,
        sentiment: turn.response.sentiment,
        citations: turn.response.citations,
        marketQuote: turn.response.marketQuote,
        model: turn.response.model,
        language: turn.response.language || language,
        coverageNote: turn.response.coverageNote,
      });

      const shareUrl = typeof window !== "undefined"
        ? new URL(created.path, window.location.origin).href
        : created.path;

      setTurns((prev) =>
        prev.map((item) =>
          item.id === turn.id
            ? { ...item, sharing: false, sharePath: created.path, shareUrl, shareError: undefined }
            : item,
        ),
      );

      await copyShareUrl(turn.id, shareUrl);
    } catch (err) {
      const shareError = err instanceof Error ? err.message : "Could not share analysis right now.";
      setTurns((prev) =>
        prev.map((item) => (item.id === turn.id ? { ...item, sharing: false, shareError } : item)),
      );
    }
  };

  const jumpToCitation = (turnId: string, citationIndex: number) => {
    const key = `${turnId}-cite-${citationIndex}`;
    setHighlightedCitationKey(key);
    const el = document.getElementById(key);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => {
      setHighlightedCitationKey((current) => (current === key ? null : current));
    }, 2200);
  };

  const statusText = statusLoading
    ? "Checking…"
    : status.available
      ? status.model || "Foundry ready"
      : "Offline";

  return (
    <div
      className="signal-bot-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Signal Bot Topic Analyst"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="signal-bot-modal">
        <header className="signal-bot-header">
          <div className="signal-bot-header-top">
            <div className="signal-bot-title-group">
              <span className="signal-bot-avatar" aria-hidden="true">🤖</span>
              <h2>Signal Bot</h2>
              {status.available && !statusLoading && selectableModels.length > 0 ? (
                <select
                  className="signal-bot-model-select"
                  value={activeModel}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSelectedModel(next);
                    savePreferredSignalBotModel(next);
                  }}
                  aria-label="Microsoft Foundry AI model"
                  title="Choose Microsoft Foundry GPT model"
                >
                  {selectableModels.map((modelName) => (
                    <option key={modelName} value={modelName}>
                      {getModelDisplayLabel(modelName)}
                    </option>
                  ))}
                </select>
              ) : (
                <span
                  className={`signal-bot-status-pill ${status.available ? "ready" : "offline"}`}
                  title={status.available ? `Microsoft Foundry (${status.model || "configured"})` : "Microsoft Foundry not configured"}
                >
                  <span className="signal-bot-status-dot" aria-hidden="true" />
                  {statusText}
                </span>
              )}
            </div>

            <div className="signal-bot-header-controls">
              <select
                className="signal-bot-lang-select"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                aria-label="Analysis response language"
              >
                {translationLanguages.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="signal-bot-close-btn"
                onClick={onClose}
                aria-label="Close Signal Bot"
                title="Close Signal Bot (Esc)"
              >
                ×
              </button>
            </div>
          </div>

          <p className="signal-bot-subtitle">
            On-demand Microsoft Foundry analysis grounded in your Signal feed &amp; live news
          </p>
        </header>

        <section className="signal-bot-topic-bar" aria-label="Topic selection and analysis presets">
          <div className="signal-bot-topic-chips">
            <button
              type="button"
              className={`signal-bot-topic-chip ${!customTopicInput.trim() && selectedTopic === "All Topics" ? "active" : ""}`}
              onClick={() => {
                setSelectedTopic("All Topics");
                setCustomTopicInput("");
              }}
            >
              All Topics
            </button>
            {followedTopics.map((topic) => (
              <button
                key={topic}
                type="button"
                className={`signal-bot-topic-chip ${!customTopicInput.trim() && selectedTopic.toLowerCase() === topic.toLowerCase() ? "active" : ""}`}
                onClick={() => {
                  setSelectedTopic(topic);
                  setCustomTopicInput("");
                }}
              >
                {topic}
              </button>
            ))}
            <button
              type="button"
              className={`signal-bot-topic-chip utility ${customTopicOpen || customTopicInput.trim() ? "active" : ""}`}
              onClick={() => {
                const nextOpen = !customTopicOpen;
                setCustomTopicOpen(nextOpen);
                if (nextOpen) {
                  setTimeout(() => customTopicInputRef.current?.focus(), 40);
                }
              }}
              aria-expanded={customTopicOpen}
            >
              {customTopicInput.trim() ? `Custom: ${customTopicInput.trim()}` : "+ Custom topic"}
            </button>
            <button
              type="button"
              className={`signal-bot-live-pill ${includeLiveSearch ? "active" : ""}`}
              onClick={() => setIncludeLiveSearch((prev) => !prev)}
              aria-pressed={includeLiveSearch}
              title="Supplement sparse local stories with live Google News results"
            >
              🌐 {includeLiveSearch ? "Live search on" : "Feed only"}
            </button>
          </div>

          {customTopicOpen && (
            <div className="signal-bot-custom-topic-row">
              <input
                ref={customTopicInputRef}
                type="text"
                className="signal-bot-custom-topic-input"
                value={customTopicInput}
                onChange={(event) => setCustomTopicInput(event.target.value)}
                placeholder="Any topic (e.g. RBNZ rates, AI regulation, TSMC)…"
                aria-label="Custom news topic"
                maxLength={100}
              />
              {customTopicInput.trim() && (
                <button
                  type="button"
                  className="signal-bot-mini-btn"
                  onClick={() => setCustomTopicInput("")}
                >
                  Clear
                </button>
              )}
            </div>
          )}

          <div className="signal-bot-presets">
            {SIGNAL_BOT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="signal-bot-preset-btn"
                disabled={isAnalyzing || !status.available}
                onClick={() => void runAnalysis(effectiveTopic, preset.prompt)}
              >
                <span aria-hidden="true">{preset.icon}</span>
                {preset.label}
              </button>
            ))}
          </div>
        </section>

        <div className="signal-bot-thread">
          {turns.length === 0 && !isAnalyzing && (
            <div className="signal-bot-welcome">
              <h3>Ready to analyze “{effectiveTopic}”</h3>
              <p>
                {localMatchingCount > 0
                  ? `${localMatchingCount} Signal ${localMatchingCount === 1 ? "story matches" : "stories match"} locally${includeLiveSearch ? ", with live Google News fallback if needed" : ""}.`
                  : `No locally cached stories match “${effectiveTopic}” right now${includeLiveSearch ? " — live Google News fallback is enabled" : ""}.`}
              </p>
              <button
                type="button"
                className="signal-bot-primary-cta"
                disabled={isAnalyzing || !status.available}
                onClick={() => void runAnalysis(effectiveTopic, SIGNAL_BOT_PRESETS[0].prompt)}
              >
                🤖 Analyze {effectiveTopic} now
              </button>
            </div>
          )}

          {turns.map((turn) => {
            const sentimentMeta = turn.response ? sentimentBadgeMeta(turn.response.sentiment) : null;
            return (
              <React.Fragment key={turn.id}>
                <div className="signal-bot-turn-user">
                  <span className="signal-bot-turn-topic-tag">Topic: {turn.topic}</span>
                  {turn.userPrompt}
                </div>

                {turn.error && (
                  <div className="signal-bot-error" role="alert">
                    <span>⚠️ {turn.error}</span>
                  </div>
                )}

                {turn.response && (
                  <article className="signal-bot-turn-assistant">
                    <div className="signal-bot-card-top">
                      <div className="signal-bot-card-badges">
                        {sentimentMeta && (
                          <span className={`signal-bot-sentiment ${sentimentMeta.toneClass}`}>
                            {sentimentMeta.label}
                          </span>
                        )}
                        <span className="signal-bot-meta-note">
                          {turn.response.coverageNote} • {getModelDisplayLabel(turn.response.model)}
                        </span>
                      </div>

                      <div className="signal-bot-card-actions">
                        <button
                          type="button"
                          className={`signal-bot-mini-btn ${speakingTurnId === turn.id ? "speaking" : ""}`}
                          onClick={() => void toggleSpeakTurn(turn.id, turn.response!)}
                          title={speakingTurnId === turn.id ? "Stop reading" : "Read aloud with Azure speech voice"}
                        >
                          {speakingTurnId === turn.id
                            ? speakingLoading
                              ? "⏳ Preparing…"
                              : "⏹ Stop"
                            : "🔊 Read"}
                        </button>
                        <button
                          type="button"
                          className="signal-bot-mini-btn"
                          onClick={() => void copyTurnMarkdown(turn.id, turn.response!)}
                        >
                          {copiedTurnId === turn.id ? "✓ Copied" : "📋 Copy"}
                        </button>
                        <button
                          type="button"
                          className="signal-bot-mini-btn"
                          disabled={Boolean(turn.sharing)}
                          onClick={() => void shareTurnHosted(turn)}
                          title="Host a public read & audio page for this Signal analysis"
                        >
                          {turn.sharing
                            ? "Sharing…"
                            : shareCopiedTurnId === turn.id
                              ? "✓ Link copied"
                              : turn.shareUrl
                                ? "🔗 Copy link"
                                : "🔗 Share"}
                        </button>
                      </div>
                    </div>

                    {turn.shareError && (
                      <div className="signal-bot-share-error" role="alert">
                        {turn.shareError}
                      </div>
                    )}

                    {turn.shareUrl && (
                      <div className="signal-bot-share-banner">
                        <span className="signal-bot-share-label">
                          Public page with Read Aloud ready
                        </span>
                        <div className="signal-bot-share-actions">
                          <button
                            type="button"
                            className="signal-bot-mini-btn"
                            onClick={() => void copyShareUrl(turn.id, turn.shareUrl!)}
                          >
                            {shareCopiedTurnId === turn.id ? "✓ Copied" : "Copy link"}
                          </button>
                          <a
                            href={turn.shareUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="signal-bot-mini-btn signal-bot-share-open"
                          >
                            Open ↗
                          </a>
                        </div>
                      </div>
                    )}

                    {(() => {
                      const paragraphs = turn.response.analysis
                        .split(/\n{2,}/)
                        .map((p) => p.trim())
                        .filter((p) => p.length > 0);
                      const driverBase = 1 + paragraphs.length;
                      const perspectiveBase = driverBase + turn.response.keyDrivers.length;
                      const watchNextBase = perspectiveBase + turn.response.perspectives.length;

                      return (
                        <>
                          <h4
                            className={`signal-bot-headline ${
                              speakingTurnId === turn.id && speakingSectionIndex === 0
                                ? "signal-bot-reading-highlight"
                                : ""
                            }`}
                          >
                            {turn.response.headline}
                          </h4>

                          {turn.response.marketQuote && (
                            <div className="signal-bot-market-strip">
                              <span>
                                <strong>{turn.response.marketQuote.name}</strong> ({turn.response.marketQuote.symbol}
                                {turn.response.marketQuote.exchange ? `:${turn.response.marketQuote.exchange}` : ""})
                              </span>
                              <span>
                                <strong>
                                  {turn.response.marketQuote.currency} {turn.response.marketQuote.price.toFixed(2)}
                                </strong>{" "}
                                <span
                                  className={`signal-bot-market-delta ${turn.response.marketQuote.change >= 0 ? "up" : "down"}`}
                                >
                                  {turn.response.marketQuote.change >= 0 ? "+" : ""}
                                  {turn.response.marketQuote.change.toFixed(2)} (
                                  {turn.response.marketQuote.change >= 0 ? "+" : ""}
                                  {turn.response.marketQuote.percentChange.toFixed(2)}%)
                                </span>
                              </span>
                            </div>
                          )}

                          <div className="signal-bot-analysis-paragraphs">
                            {paragraphs.map((paragraph, pIdx) => {
                              const isHighlighted =
                                speakingTurnId === turn.id &&
                                speakingSectionIndex === 1 + pIdx;
                              return (
                                <p
                                  key={pIdx}
                                  className={isHighlighted ? "signal-bot-reading-highlight" : ""}
                                >
                                  {renderInlineCitations(paragraph, (citeIdx) => jumpToCitation(turn.id, citeIdx))}
                                </p>
                              );
                            })}
                          </div>

                          {(turn.response.keyDrivers.length > 0
                            || turn.response.perspectives.length > 0
                            || turn.response.watchNext.length > 0) && (
                            <div className="signal-bot-pillars">
                              {turn.response.keyDrivers.length > 0 && (
                                <div className="signal-bot-pillar">
                                  <h5>Key Drivers</h5>
                                  <ul>
                                    {turn.response.keyDrivers.map((item, idx) => {
                                      const isHighlighted =
                                        speakingTurnId === turn.id &&
                                        speakingSectionIndex === driverBase + idx;
                                      return (
                                        <li
                                          key={idx}
                                          className={isHighlighted ? "signal-bot-reading-highlight" : ""}
                                        >
                                          {item}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                              {turn.response.perspectives.length > 0 && (
                                <div className="signal-bot-pillar">
                                  <h5>Perspectives &amp; Risks</h5>
                                  <ul>
                                    {turn.response.perspectives.map((item, idx) => {
                                      const isHighlighted =
                                        speakingTurnId === turn.id &&
                                        speakingSectionIndex === perspectiveBase + idx;
                                      return (
                                        <li
                                          key={idx}
                                          className={isHighlighted ? "signal-bot-reading-highlight" : ""}
                                        >
                                          {item}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                              {turn.response.watchNext.length > 0 && (
                                <div className="signal-bot-pillar">
                                  <h5>Watch Next</h5>
                                  <ul>
                                    {turn.response.watchNext.map((item, idx) => {
                                      const isHighlighted =
                                        speakingTurnId === turn.id &&
                                        speakingSectionIndex === watchNextBase + idx;
                                      return (
                                        <li
                                          key={idx}
                                          className={isHighlighted ? "signal-bot-reading-highlight" : ""}
                                        >
                                          {item}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}

                    {turn.response.suggestedFollowUps.length > 0 && (
                      <div className="signal-bot-followups">
                        {turn.response.suggestedFollowUps.map((followUp, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className="signal-bot-followup-btn"
                            disabled={isAnalyzing}
                            onClick={() => void runAnalysis(turn.topic, followUp)}
                          >
                            ↪ {followUp}
                          </button>
                        ))}
                      </div>
                    )}

                    {turn.response.citations.length > 0 && (
                      <div className="signal-bot-citations">
                        <h5>Grounded Sources ({turn.response.citations.length})</h5>
                        <div className="signal-bot-citation-list">
                          {turn.response.citations.map((cite) => {
                            const citeElementId = `${turn.id}-cite-${cite.index}`;
                            return (
                              <div
                                key={cite.index}
                                id={citeElementId}
                                className={`signal-bot-citation-item ${highlightedCitationKey === citeElementId ? "highlighted" : ""}`}
                              >
                                <div className="signal-bot-citation-info">
                                  <span className="signal-bot-citation-title">
                                    <strong>[S{cite.index}]</strong> {cite.title}
                                  </span>
                                  <span className="signal-bot-citation-source">
                                    {cite.source || "Publisher"}
                                    {cite.publishedAt ? ` • ${new Date(cite.publishedAt).toLocaleString()}` : ""}
                                  </span>
                                </div>
                                <div className="signal-bot-citation-actions">
                                  <button
                                    type="button"
                                    className="signal-bot-mini-btn"
                                    onClick={(event) =>
                                      onOpenArticle(citationToFollowedArticle(cite, turn.topic), event.currentTarget)}
                                  >
                                    Read
                                  </button>
                                  <button
                                    type="button"
                                    className="signal-bot-mini-btn"
                                    onClick={(event) =>
                                      onListenArticle(citationToFollowedArticle(cite, turn.topic), event.currentTarget)}
                                  >
                                    Listen
                                  </button>
                                  <a
                                    href={cite.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="signal-bot-citation-link"
                                  >
                                    Open ↗
                                  </a>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </article>
                )}
              </React.Fragment>
            );
          })}

          {isAnalyzing && (
            <div className="signal-bot-loading" role="status" aria-live="polite">
              <span className="signal-bot-spinner" aria-hidden="true" />
              <span>
                Analyzing “{effectiveTopic}” via {activeModel ? getModelDisplayLabel(activeModel) : "Microsoft Foundry"}…
              </span>
            </div>
          )}

          <div ref={threadEndRef} />
        </div>

        <form
          className="signal-bot-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void runAnalysis();
          }}
        >
          <div className="signal-bot-composer-row">
            <textarea
              ref={inputRef}
              className="signal-bot-input"
              value={promptInput}
              onChange={(event) => setPromptInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void runAnalysis();
                }
              }}
              placeholder={`Ask about ${effectiveTopic}…`}
              rows={1}
              maxLength={1200}
              disabled={isAnalyzing}
            />
            <VoiceMicButton
              label="Voice question for Signal Bot"
              onVoiceCommand={(command) => {
                const spoken = (command.raw || command.query || "").trim();
                if (!spoken) return;
                void runAnalysis(effectiveTopic, spoken);
              }}
            />
            <button
              type="submit"
              className="signal-bot-send-btn"
              disabled={isAnalyzing || !status.available}
            >
              {isAnalyzing ? "Analyzing…" : "Analyze"}
            </button>
          </div>
          <div className="signal-bot-composer-footer">
            <span className="signal-bot-keyboard-hint">Enter to analyze • Shift+Enter for newline</span>
            {turns.length > 0 && (
              <button
                type="button"
                className="signal-bot-mini-btn signal-bot-clear-btn"
                onClick={() => {
                  stopSpeech();
                  setTurns([]);
                }}
              >
                Clear chat
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
