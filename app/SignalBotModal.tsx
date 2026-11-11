import React, { useEffect, useMemo, useRef, useState } from "react";
import { translationLanguages } from "./article-translation";
import { briefingSpeechLocale } from "./daily-briefing-translation";
import type { FollowedArticle } from "./NewsDashboard";
import {
  analyzeNewsTopicWithSignalBot,
  fetchSignalBotStatus,
  formatSignalBotMarkdown,
  normalizeSignalBotArticles,
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
  });
  const [statusLoading, setStatusLoading] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<string>(initialTopic || followedTopics[0] || "All Topics");
  const [customTopicInput, setCustomTopicInput] = useState<string>("");
  const [includeLiveSearch, setIncludeLiveSearch] = useState<boolean>(true);
  const [language, setLanguage] = useState<string>(defaultLanguage || "en");
  const [promptInput, setPromptInput] = useState<string>("");
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [speakingTurnId, setSpeakingTurnId] = useState<string | null>(null);
  const [highlightedCitationKey, setHighlightedCitationKey] = useState<string | null>(null);

  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeakingTurnId(null);
  };

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
      } else {
        setCustomTopicInput(initialTopic);
      }
    }

    const controller = new AbortController();
    setStatusLoading(true);
    void fetchSignalBotStatus(controller.signal)
      .then((nextStatus) => {
        setStatus(nextStatus);
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

  const toggleSpeakTurn = (turnId: string, response: SignalBotAnalyzeResponse) => {
    if (speakingTurnId === turnId) {
      stopSpeech();
      return;
    }
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    window.speechSynthesis.cancel();
    const spokenText = [
      response.headline,
      response.analysis.replace(/\[S\d+\]/g, ""),
      response.watchNext.length > 0 ? `What to watch next: ${response.watchNext.join(". ")}` : "",
    ].filter(Boolean).join(". ");

    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = briefingSpeechLocale(language);
    utterance.onend = () => setSpeakingTurnId(null);
    utterance.onerror = () => setSpeakingTurnId(null);
    setSpeakingTurnId(turnId);
    window.speechSynthesis.speak(utterance);
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

  const jumpToCitation = (turnId: string, citationIndex: number) => {
    const key = `${turnId}-cite-${citationIndex}`;
    setHighlightedCitationKey(key);
    const el = document.getElementById(key);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => {
      setHighlightedCitationKey((current) => (current === key ? null : current));
    }, 2200);
  };

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
          <div className="signal-bot-title-group">
            <span className="signal-bot-avatar" aria-hidden="true">🤖</span>
            <div className="signal-bot-title-text">
              <h2>
                Signal Bot
                <span className={`signal-bot-status-pill ${status.available ? "ready" : "offline"}`}>
                  {statusLoading
                    ? "Checking Foundry…"
                    : status.available
                      ? `Microsoft Foundry${status.model ? ` • ${status.model}` : ""}`
                      : "Foundry Not Configured"}
                </span>
              </h2>
              <p className="signal-bot-subtitle">
                On-demand news topic intelligence grounded in your Signal feed &amp; live sources
              </p>
            </div>
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
          </div>

          <div className="signal-bot-custom-topic-row">
            <input
              type="text"
              className="signal-bot-custom-topic-input"
              value={customTopicInput}
              onChange={(event) => setCustomTopicInput(event.target.value)}
              placeholder="Or type any custom news topic (e.g. RBNZ rates, AI regulation, NVIDIA)…"
              aria-label="Custom news topic"
              maxLength={100}
            />
            <label className="signal-bot-toggle">
              <input
                type="checkbox"
                checked={includeLiveSearch}
                onChange={(event) => setIncludeLiveSearch(event.target.checked)}
              />
              Live web supplement
            </label>
          </div>

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
                  ? `${localMatchingCount} Signal ${localMatchingCount === 1 ? "story" : "stories"} match this topic locally${includeLiveSearch ? ", plus optional live Google News lookup if needed" : ""}.`
                  : `No locally cached stories match “${effectiveTopic}” right now${includeLiveSearch ? " — Signal Bot can fetch fresh coverage from Google News when you ask" : ""}.`}
                {" "}Signal Bot only calls Microsoft Foundry when you click an analysis preset or ask a question below.
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
                          {turn.response.coverageNote} • {turn.response.model}
                        </span>
                      </div>

                      <div className="signal-bot-card-actions">
                        <button
                          type="button"
                          className="signal-bot-mini-btn"
                          onClick={() => toggleSpeakTurn(turn.id, turn.response!)}
                        >
                          {speakingTurnId === turn.id ? "⏹ Stop" : "🔊 Read aloud"}
                        </button>
                        <button
                          type="button"
                          className="signal-bot-mini-btn"
                          onClick={() => void copyTurnMarkdown(turn.id, turn.response!)}
                        >
                          {copiedTurnId === turn.id ? "✓ Copied" : "📋 Copy"}
                        </button>
                      </div>
                    </div>

                    <h4 className="signal-bot-headline">{turn.response.headline}</h4>

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
                      {turn.response.analysis
                        .split(/\n{2,}/)
                        .map((paragraph, pIdx) => (
                          <p key={pIdx}>
                            {renderInlineCitations(paragraph, (citeIdx) => jumpToCitation(turn.id, citeIdx))}
                          </p>
                        ))}
                    </div>

                    {(turn.response.keyDrivers.length > 0
                      || turn.response.perspectives.length > 0
                      || turn.response.watchNext.length > 0) && (
                      <div className="signal-bot-pillars">
                        {turn.response.keyDrivers.length > 0 && (
                          <div className="signal-bot-pillar">
                            <h5>Key Drivers</h5>
                            <ul>
                              {turn.response.keyDrivers.map((item, idx) => (
                                <li key={idx}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {turn.response.perspectives.length > 0 && (
                          <div className="signal-bot-pillar">
                            <h5>Perspectives &amp; Risks</h5>
                            <ul>
                              {turn.response.perspectives.map((item, idx) => (
                                <li key={idx}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {turn.response.watchNext.length > 0 && (
                          <div className="signal-bot-pillar">
                            <h5>Watch Next</h5>
                            <ul>
                              {turn.response.watchNext.map((item, idx) => (
                                <li key={idx}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

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
                    )}
                  </article>
                )}
              </React.Fragment>
            );
          })}

          {isAnalyzing && (
            <div className="signal-bot-loading" role="status" aria-live="polite">
              <span className="signal-bot-spinner" aria-hidden="true" />
              <span>Signal Bot is analyzing “{effectiveTopic}” via Microsoft Foundry…</span>
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
              placeholder={`Ask Signal Bot to analyze ${effectiveTopic} (or press Enter for an instant deep dive)…`}
              rows={2}
              maxLength={1200}
              disabled={isAnalyzing}
            />
            <VoiceMicButton
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
            <span>Enter to analyze • Shift+Enter for newline</span>
            {turns.length > 0 && (
              <button
                type="button"
                className="signal-bot-mini-btn"
                onClick={() => {
                  stopSpeech();
                  setTurns([]);
                }}
              >
                Clear conversation
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
