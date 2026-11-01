"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FollowedArticle } from "./NewsDashboard";
import { translationLanguages } from "./article-translation";
import ContinueOnWatch from "./ContinueOnWatch";
import VoiceMicButton from "./VoiceMicButton";
import {
  buildDailyBriefing,
  formatScheduleTimeDisplay,
  loadBriefingSchedule,
  loadPriorityTopics,
  savePriorityTopics,
  togglePriorityTopic,
  updateBriefingSchedule,
  type BriefingSchedulePrefs,
  type DailyBriefingData,
  type DailyBriefingStory,
} from "./daily-briefing";
import {
  clearOfflineBriefingPack,
  computeBriefingPackId,
  formatAudioByteSize,
  loadAutoOfflineBriefingPref,
  loadOfflineBriefingAudio,
  loadOfflineBriefingPackMeta,
  saveAutoOfflineBriefingPref,
  saveOfflineBriefingPack,
  type OfflineBriefingPackMeta,
} from "./daily-briefing-offline";
import {
  briefingSpeechLocale,
  getBriefingLanguageLabel,
  loadBriefingLanguage,
  saveBriefingLanguage,
  translateDailyBriefing,
} from "./daily-briefing-translation";
import {
  buildBriefingWatchParts,
  copyTextToClipboard,
  createHostedDailyBriefingShare,
  resolveBriefingWatchHandoffUrl,
  shareOrCopyDailyBriefingDigest,
} from "./daily-briefing-share";
import {
  askDailyBriefing,
  buildSuggestedBriefingQuestions,
  type BriefingQaResult,
} from "./daily-briefing-qa";
import { getCachedOfflineArticle } from "./offline-prewarm";
import type {
  LocalWeather,
  WeatherForecastDay,
  ClientWeatherAlert,
  ClientWeatherConditions,
} from "./weather-briefing";
import type { MarketQuote } from "./market-quote";
import type { EntityPulseSummary } from "./entity-pulse";
import { useSpokenBriefing } from "./useSpokenBriefing";
import "./daily-briefing.css";

function getWeatherIcon(code: number): string {
  if (code === 0) return "☀️";
  if (code === 1 || code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95 && code <= 99) return "⛈️";
  return "🌤️";
}

function toFollowedArticle(story: DailyBriefingStory, existing?: FollowedArticle): FollowedArticle {
  if (existing) return existing;
  return {
    title: story.title,
    url: story.url,
    source: story.source,
    publishedAt: story.publishedAt || "",
    summary: story.summary || "",
    topics: story.topics ?? story.matchedTopics ?? [],
    providers: story.source ? [story.source] : [],
    isBookmarked: story.isBookmarked,
    isRead: story.isRead,
  };
}

export type OfflinePackDownloadStatus = {
  busy: boolean;
  progress: number;
  stage: string;
  error?: string | null;
};

export default function DailyBriefingModal({
  isOpen,
  onClose,
  weather,
  forecast = [],
  alerts = [],
  conditions,
  marketQuote,
  marketWatchlist = [],
  pulse,
  articles = [],
  followedTopics = [],
  priorityTopics: controlledPriorityTopics,
  onChangePriorityTopics,
  schedule: controlledSchedule,
  onChangeSchedule,
  offlinePackMeta: controlledOfflineMeta,
  offlineDownloadState: controlledDownloadState,
  onSaveOfflinePack,
  onClearOfflinePack,
  autoOfflineEnabled: controlledAutoOffline,
  onChangeAutoOffline,
  onTestWakeUp,
  autoPlayOnOpen = false,
  onAutoPlayConsumed,
  onOpenArticle,
  onListenArticle,
  userTime,
}: {
  isOpen: boolean;
  onClose: () => void;
  weather?: LocalWeather | null;
  forecast?: WeatherForecastDay[];
  alerts?: ClientWeatherAlert[];
  conditions?: ClientWeatherConditions | null;
  marketQuote?: MarketQuote | null;
  marketWatchlist?: MarketQuote[];
  pulse?: EntityPulseSummary | null;
  articles?: FollowedArticle[];
  followedTopics?: string[];
  priorityTopics?: string[];
  onChangePriorityTopics?: (topics: string[]) => void;
  schedule?: BriefingSchedulePrefs;
  onChangeSchedule?: (prefs: BriefingSchedulePrefs) => void;
  offlinePackMeta?: OfflineBriefingPackMeta | null;
  offlineDownloadState?: OfflinePackDownloadStatus;
  onSaveOfflinePack?: (briefing: DailyBriefingData, language?: string) => void;
  onClearOfflinePack?: () => void;
  autoOfflineEnabled?: boolean;
  onChangeAutoOffline?: (enabled: boolean) => void;
  onTestWakeUp?: (briefing: DailyBriefingData) => void;
  autoPlayOnOpen?: boolean;
  onAutoPlayConsumed?: () => void;
  onOpenArticle?: (article: FollowedArticle) => void;
  onListenArticle?: (article: FollowedArticle) => void;
  userTime?: Date;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const speech = useSpokenBriefing();
  const qaSpeech = useSpokenBriefing();
  const stopBriefing = speech.stop;
  const stopQaSpeech = qaSpeech.stop;

  // Fallback internal states if parent doesn't control them
  const [localPriorityTopics, setLocalPriorityTopics] = useState<string[]>(() => loadPriorityTopics());
  const [localSchedule, setLocalSchedule] = useState<BriefingSchedulePrefs>(() => loadBriefingSchedule());
  const [localOfflineMeta, setLocalOfflineMeta] = useState<OfflineBriefingPackMeta | null>(() =>
    loadOfflineBriefingPackMeta(),
  );
  const [localAutoOffline, setLocalAutoOffline] = useState<boolean>(() => loadAutoOfflineBriefingPref());
  const [localDownloadState, setLocalDownloadState] = useState<OfflinePackDownloadStatus>({
    busy: false,
    progress: 0,
    stage: "",
    error: null,
  });

  // Multilingual Executive Briefing state
  const [briefingLanguage, setBriefingLanguage] = useState<string>(() => loadBriefingLanguage());
  const [translationState, setTranslationState] = useState<{
    sourceKey: string;
    briefing: DailyBriefingData | null;
    busy: boolean;
  }>({ sourceKey: "", briefing: null, busy: false });

  // Export, Hosted Share & Watch Handoff state
  const [shareFeedback, setShareFeedback] = useState<string>("");
  const [hostedShareBusy, setHostedShareBusy] = useState<boolean>(false);
  const [hostedShareUrl, setHostedShareUrl] = useState<string>("");

  // "Ask Today's Briefing" Q&A state
  const [qaInput, setQaInput] = useState<string>("");
  const [qaBusy, setQaBusy] = useState<boolean>(false);
  const [qaAskedQuestion, setQaAskedQuestion] = useState<string>("");
  const [qaResult, setQaResult] = useState<BriefingQaResult | null>(null);
  const [qaError, setQaError] = useState<string>("");
  const qaAbortRef = useRef<AbortController | null>(null);

  const [schedulePanelOpen, setSchedulePanelOpen] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [notificationPermission, setNotificationPermission] = useState<string>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  const priorityTopics = controlledPriorityTopics ?? localPriorityTopics;
  const schedule = controlledSchedule ?? localSchedule;
  const offlineMeta = controlledOfflineMeta !== undefined ? controlledOfflineMeta : localOfflineMeta;
  const downloadState = controlledDownloadState ?? localDownloadState;
  const autoOfflineEnabled = controlledAutoOffline ?? localAutoOffline;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const liveBriefing: DailyBriefingData = useMemo(() => {
    return buildDailyBriefing({
      weather,
      forecast,
      alerts,
      conditions,
      marketQuote,
      marketWatchlist,
      pulse,
      articles,
      priorityTopics,
      userTime,
      maxLeadStories: 4,
    });
  }, [
    weather,
    forecast,
    alerts,
    conditions,
    marketQuote,
    marketWatchlist,
    pulse,
    articles,
    priorityTopics,
    userTime,
  ]);

  // When offline and live feed has no stories yet, restore the saved Offline Briefing Pack snapshot
  const usingOfflineSnapshot = Boolean(
    !isOnline && offlineMeta && liveBriefing.leadStories.length === 0,
  );
  const baseBriefing: DailyBriefingData =
    usingOfflineSnapshot && offlineMeta ? offlineMeta.briefing : liveBriefing;

  const translationSourceKey = `${briefingLanguage}::${baseBriefing.spokenScript}`;

  useEffect(() => {
    if (!isOpen || briefingLanguage === "en" || !isOnline) {
      setTranslationState((prev) => (prev.busy ? { ...prev, busy: false } : prev));
      return;
    }

    const controller = new AbortController();
    setTranslationState((prev) =>
      prev.sourceKey === translationSourceKey && prev.briefing
        ? prev
        : { sourceKey: translationSourceKey, briefing: null, busy: true },
    );

    void translateDailyBriefing(baseBriefing, briefingLanguage, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setTranslationState({
          sourceKey: translationSourceKey,
          briefing: res.translated ? res.briefing : baseBriefing,
          busy: false,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setTranslationState({
          sourceKey: translationSourceKey,
          briefing: baseBriefing,
          busy: false,
        });
      });

    return () => controller.abort();
  }, [baseBriefing, briefingLanguage, isOnline, isOpen, translationSourceKey]);

  const briefing: DailyBriefingData =
    briefingLanguage !== "en" &&
    translationState.sourceKey === translationSourceKey &&
    translationState.briefing
      ? translationState.briefing
      : baseBriefing;

  const speechLocale = useMemo(() => briefingSpeechLocale(briefingLanguage), [briefingLanguage]);
  const currentPackId = useMemo(
    () => computeBriefingPackId(briefing, speechLocale),
    [briefing, speechLocale],
  );
  const isCurrentPackCached = Boolean(offlineMeta && offlineMeta.id === currentPackId);

  const watchHandoffUrl = useMemo(() => resolveBriefingWatchHandoffUrl(briefing), [briefing]);
  const watchParts = useMemo(() => buildBriefingWatchParts(briefing), [briefing]);
  const watchTitle = useMemo(() => {
    const editionLabel = briefing.edition.charAt(0).toUpperCase() + briefing.edition.slice(1);
    return `Signal ${editionLabel} Briefing — ${briefing.formattedDate}`;
  }, [briefing.edition, briefing.formattedDate]);

  const suggestedQuestions = useMemo(
    () => buildSuggestedBriefingQuestions(baseBriefing),
    [baseBriefing],
  );

  const playBriefingAudio = useCallback(async () => {
    stopQaSpeech();
    let cachedBlob: Blob | null = null;
    if (offlineMeta?.hasNeuralAudio) {
      if (offlineMeta.id === currentPackId) {
        cachedBlob = await loadOfflineBriefingAudio(currentPackId);
      } else if (!isOnline) {
        cachedBlob = await loadOfflineBriefingAudio(offlineMeta.id);
      }
    }
    const scriptToSpeak =
      !isOnline && cachedBlob && offlineMeta ? offlineMeta.briefing.spokenScript : briefing.spokenScript;
    speech.speak(scriptToSpeak, speechLocale, cachedBlob);
  }, [briefing.spokenScript, currentPackId, isOnline, offlineMeta, speech, speechLocale, stopQaSpeech]);

  // Manage native dialog open/close lifecycle
  useEffect(() => {
    if (!isOpen) {
      stopBriefing();
      stopQaSpeech();
      qaAbortRef.current?.abort();
      return;
    }

    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      stopBriefing();
      stopQaSpeech();
      qaAbortRef.current?.abort();
      if (dialog && dialog.open) {
        dialog.close();
      }
    };
  }, [isOpen, onClose, stopBriefing, stopQaSpeech]);

  // Auto-play support when launched from Wake-up Briefing "Play Briefing" button
  useEffect(() => {
    if (!isOpen || !autoPlayOnOpen) return;
    onAutoPlayConsumed?.();
    void playBriefingAudio();
  }, [autoPlayOnOpen, isOpen, onAutoPlayConsumed, playBriefingAudio]);

  if (!isOpen) return null;

  const isAudioActive = speech.status === "starting" || speech.status === "playing";
  const isQaAudioActive = qaSpeech.status === "starting" || qaSpeech.status === "playing";

  const handleAudioToggle = () => {
    if (isAudioActive) {
      speech.stop();
    } else {
      void playBriefingAudio();
    }
  };

  const handleLanguageChange = (nextLang: string) => {
    speech.stop();
    qaSpeech.stop();
    const saved = saveBriefingLanguage(nextLang);
    setBriefingLanguage(saved);
    setHostedShareUrl("");
  };

  const handleShareDigestClick = async () => {
    const outcome = await shareOrCopyDailyBriefingDigest(briefing);
    if (outcome === "shared") {
      setShareFeedback("Digest shared");
    } else if (outcome === "copied") {
      setShareFeedback("Digest copied to clipboard");
    } else if (outcome === "failed") {
      setShareFeedback("Could not copy digest");
    }
    if (outcome !== "cancelled") {
      window.setTimeout(() => setShareFeedback(""), 3500);
    }
  };

  const handleCreateHostedShareClick = async () => {
    if (hostedShareBusy || !isOnline) return;
    setHostedShareBusy(true);
    setShareFeedback("");
    try {
      const created = await createHostedDailyBriefingShare({
        briefing,
        packId: currentPackId,
        language: briefingLanguage,
      });
      setHostedShareUrl(created.url);
      const copied = await copyTextToClipboard(created.url);
      setShareFeedback(copied ? "Hosted audio link copied" : "Hosted audio link ready");
    } catch (err) {
      setShareFeedback(err instanceof Error ? err.message : "Could not create hosted link");
    } finally {
      setHostedShareBusy(false);
    }
  };

  const submitBriefingQuestion = async (rawQuestion: string) => {
    const cleanQ = rawQuestion.replace(/\s+/g, " ").trim();
    if (cleanQ.length < 2) return;

    qaAbortRef.current?.abort();
    const controller = new AbortController();
    qaAbortRef.current = controller;

    qaSpeech.stop();
    setQaBusy(true);
    setQaError("");
    setQaAskedQuestion(cleanQ);

    try {
      const res = await askDailyBriefing(
        {
          question: cleanQ,
          briefing,
          articles,
          language: briefingLanguage,
          isOnline,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setQaResult(res);
    } catch (err) {
      if (controller.signal.aborted) return;
      setQaError(err instanceof Error ? err.message : "Could not answer that question right now.");
    } finally {
      if (!controller.signal.aborted) {
        setQaBusy(false);
      }
    }
  };

  const handleQaAudioToggle = () => {
    if (!qaResult?.answer) return;
    if (isQaAudioActive) {
      qaSpeech.stop();
    } else {
      speech.stop();
      qaSpeech.speak(qaResult.answer, speechLocale);
    }
  };

  const handleTogglePriorityTopic = (topic: string) => {
    const next = savePriorityTopics(togglePriorityTopic(priorityTopics, topic));
    if (onChangePriorityTopics) {
      onChangePriorityTopics(next);
    } else {
      setLocalPriorityTopics(next);
    }
  };

  const handleSchedulePatch = async (patch: Partial<BriefingSchedulePrefs>) => {
    if (patch.notify === true && typeof Notification !== "undefined" && Notification.permission === "default") {
      try {
        const perm = await Notification.requestPermission();
        setNotificationPermission(perm);
      } catch {
        // Ignore permission request failure
      }
    }
    const updated = updateBriefingSchedule(schedule, patch);
    if (onChangeSchedule) {
      onChangeSchedule(updated);
    } else {
      setLocalSchedule(updated);
    }
  };

  const handleSaveOfflinePackClick = async () => {
    if (downloadState.busy) return;
    if (onSaveOfflinePack) {
      onSaveOfflinePack(briefing, speechLocale);
      return;
    }
    setLocalDownloadState({ busy: true, progress: 5, stage: "Preparing offline pack...", error: null });
    try {
      const meta = await saveOfflineBriefingPack({
        briefing,
        language: speechLocale,
        onProgress: (progress, stage) => {
          setLocalDownloadState({ busy: true, progress, stage, error: null });
        },
      });
      setLocalOfflineMeta(meta);
      setLocalDownloadState({ busy: false, progress: 100, stage: "Ready", error: null });
    } catch (err) {
      setLocalDownloadState({
        busy: false,
        progress: 0,
        stage: "",
        error: err instanceof Error ? err.message : "Could not save offline pack.",
      });
    }
  };

  const handleClearOfflinePackClick = async () => {
    if (onClearOfflinePack) {
      onClearOfflinePack();
      return;
    }
    await clearOfflineBriefingPack();
    setLocalOfflineMeta(null);
  };

  const handleAutoOfflineToggle = (enabled: boolean) => {
    saveAutoOfflineBriefingPref(enabled);
    if (onChangeAutoOffline) {
      onChangeAutoOffline(enabled);
    } else {
      setLocalAutoOffline(enabled);
    }
    if (enabled && isOnline && !isCurrentPackCached && !downloadState.busy) {
      void handleSaveOfflinePackClick();
    }
  };

  // Combine followed topics + any already-pinned priority topics for chip display
  const availableTopicChips = Array.from(
    new Map(
      [...priorityTopics, ...followedTopics]
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => [t.toLowerCase(), t]),
    ).values(),
  );

  const savedAtLabel = offlineMeta?.savedAt
    ? new Date(offlineMeta.savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";

  const secondaryWatchlistQuotes =
    briefing.marketWatchlistGlance && briefing.marketWatchlistGlance.length > 1
      ? briefing.marketWatchlistGlance.slice(1, 5)
      : [];

  return (
    <dialog
      ref={dialogRef}
      className="daily-briefing-dialog"
      aria-labelledby="daily-briefing-title"
      onMouseDown={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="daily-briefing-card">
        {/* Header */}
        <header className="daily-briefing-header">
          <div className="daily-briefing-title-group">
            <div className="daily-briefing-kicker-row">
              <span className="daily-briefing-edition-badge">
                🗞️ {briefing.edition.toUpperCase()} DIGEST
              </span>
              {briefingLanguage !== "en" && (
                <span className="daily-briefing-status-pill language" title="Translated executive digest & native neural voice">
                  🌐 {getBriefingLanguageLabel(briefingLanguage)}
                  {translationState.busy ? " (Translating…)" : ""}
                </span>
              )}
              {usingOfflineSnapshot && (
                <span className="daily-briefing-status-pill offline" title="Showing saved offline commute pack">
                  📡 Offline Snapshot
                </span>
              )}
              {isCurrentPackCached && offlineMeta?.hasNeuralAudio && (
                <span className="daily-briefing-status-pill ready" title="Neural audio prewarmed in Cache Storage">
                  ⚡ Instant Audio Ready
                </span>
              )}
            </div>
            <h2 id="daily-briefing-title" className="daily-briefing-title">
              Executive Daily Briefing
            </h2>
            <p className="daily-briefing-subtitle">
              {briefing.greeting} &bull; {briefing.formattedDate}
            </p>
          </div>
          <div className="daily-briefing-header-actions">
            <label className="briefing-language-picker" title="Translate briefing text & switch native neural voice">
              <span className="sr-only">Briefing language</span>
              <span aria-hidden="true">🌐</span>
              <select
                className="briefing-language-select"
                aria-label="Briefing language"
                value={briefingLanguage}
                onChange={(e) => handleLanguageChange(e.target.value)}
              >
                {translationLanguages.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={`daily-briefing-audio-btn ${isAudioActive ? "active" : ""}`}
              onClick={handleAudioToggle}
              title={isAudioActive ? "Stop voice briefing" : "Listen to neural spoken briefing"}
              aria-label={isAudioActive ? "Stop voice briefing" : "Listen to neural spoken briefing"}
            >
              {speech.status === "starting" ? (
                <>⏳ Starting...</>
              ) : speech.status === "playing" ? (
                <>
                  <span className="audio-wave-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  ⏹ Stop Audio
                </>
              ) : (
                <>🔊 Listen to Briefing</>
              )}
            </button>
            <button
              type="button"
              className="daily-briefing-close-btn"
              onClick={onClose}
              title="Close briefing"
              aria-label="Close executive briefing"
            >
              &times;
            </button>
          </div>
        </header>

        {/* Commute Offline Pack, Share/Export, Watch Handoff & Wake-up Schedule Toolbar */}
        <section className="daily-briefing-toolbar" aria-label="Briefing automation, sharing, and offline pack controls">
          <div className="briefing-offline-bar">
            {downloadState.busy ? (
              <span className="briefing-offline-progress" role="status" aria-live="polite">
                ⏳ {downloadState.stage || "Saving Offline Pack..."} ({downloadState.progress}%)
              </span>
            ) : isCurrentPackCached && offlineMeta ? (
              <div className="briefing-offline-ready-group">
                <span className="briefing-offline-ready-text">
                  ⚡ Offline Pack ({offlineMeta.hasNeuralAudio ? formatAudioByteSize(offlineMeta.audioBytes) : "Text + Stories"} &bull; {offlineMeta.prewarmedStoryCount} stories &bull; {savedAtLabel})
                </span>
                {isOnline && (
                  <button
                    type="button"
                    className="briefing-toolbar-btn subtle"
                    onClick={() => void handleSaveOfflinePackClick()}
                    title="Re-download offline pack"
                  >
                    🔄 Refresh
                  </button>
                )}
                <button
                  type="button"
                  className="briefing-toolbar-btn subtle"
                  onClick={() => void handleClearOfflinePackClick()}
                  title="Remove saved offline briefing pack"
                  aria-label="Remove saved offline briefing pack"
                >
                  ✕
                </button>
              </div>
            ) : (
              <div className="briefing-offline-ready-group">
                <button
                  type="button"
                  className="briefing-toolbar-btn"
                  disabled={!isOnline}
                  onClick={() => void handleSaveOfflinePackClick()}
                  title="Prewarm neural audio and full story texts into Cache Storage for offline commute"
                >
                  📥 {offlineMeta ? "Update Offline Pack" : "Save Offline Pack"}
                </button>
                {offlineMeta && (
                  <span className="briefing-offline-stale-hint">
                    Saved pack from {savedAtLabel}
                  </span>
                )}
              </div>
            )}

            <label className="briefing-auto-pack-toggle" title="Automatically prewarm today's briefing pack when online">
              <input
                type="checkbox"
                checked={autoOfflineEnabled}
                onChange={(e) => handleAutoOfflineToggle(e.target.checked)}
              />
              <span>Auto-pack</span>
            </label>
          </div>

          <div className="briefing-actions-cluster">
            <button
              type="button"
              className="briefing-toolbar-btn"
              onClick={() => void handleShareDigestClick()}
              title="Share or copy formatted executive digest with story links"
            >
              📋 Share Digest
            </button>

            <button
              type="button"
              className="briefing-toolbar-btn"
              disabled={!isOnline || hostedShareBusy}
              onClick={() => void handleCreateHostedShareClick()}
              title="Publish a hosted Signal share page with public neural audio playback"
            >
              {hostedShareBusy ? "⏳ Publishing…" : "🔗 Hosted Link"}
            </button>

            <div className="briefing-watch-handoff-wrap">
              <ContinueOnWatch
                url={watchHandoffUrl}
                title={watchTitle}
                source="Signal Executive Briefing"
                snapshot={() => ({
                  parts: watchParts,
                  partIndex: 0,
                  session: currentPackId,
                })}
                pause={() => speech.stop()}
                onLockChange={() => {}}
              />
            </div>

            <button
              type="button"
              className={`briefing-toolbar-btn schedule-toggle ${schedule.enabled ? "enabled" : ""}`}
              aria-expanded={schedulePanelOpen}
              onClick={() => setSchedulePanelOpen((prev) => !prev)}
              title="Configure daily Wake-up Briefing schedule and notification"
            >
              ⏰ {schedule.enabled ? `Wake-up: ${formatScheduleTimeDisplay(schedule.time)}` : "Schedule Wake-up"}
            </button>
          </div>

          {(shareFeedback || hostedShareUrl) && (
            <div className="briefing-share-status-row" role="status" aria-live="polite">
              {shareFeedback && <span className="briefing-share-feedback">{shareFeedback}</span>}
              {hostedShareUrl && (
                <a
                  href={hostedShareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="briefing-hosted-share-link"
                >
                  Open shared briefing &rarr;
                </a>
              )}
            </div>
          )}

          {downloadState.error && (
            <p className="briefing-toolbar-error" role="alert">
              {downloadState.error}
            </p>
          )}
        </section>

        {/* Expandable Wake-up Briefing Schedule Configuration */}
        {schedulePanelOpen && (
          <section className="daily-briefing-schedule-panel" aria-label="Wake-up briefing schedule settings">
            <div className="schedule-panel-row">
              <label className="schedule-switch-label">
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  onChange={(e) => void handleSchedulePatch({ enabled: e.target.checked })}
                />
                <strong>Enable Daily Wake-up Briefing</strong>
              </label>

              <label className="schedule-time-label">
                <span>Briefing time</span>
                <input
                  type="time"
                  value={schedule.time}
                  onChange={(e) => void handleSchedulePatch({ time: e.target.value })}
                  aria-label="Wake-up briefing time"
                />
              </label>
            </div>

            <div className="schedule-panel-options">
              <label className="schedule-option-check">
                <input
                  type="checkbox"
                  checked={schedule.prewarmOfflinePack}
                  onChange={(e) => void handleSchedulePatch({ prewarmOfflinePack: e.target.checked })}
                />
                <span>Pre-warm neural audio &amp; offline lead stories at wake-up time</span>
              </label>

              <label className="schedule-option-check">
                <input
                  type="checkbox"
                  checked={schedule.notify}
                  onChange={(e) => void handleSchedulePatch({ notify: e.target.checked })}
                />
                <span>
                  Show Wake-up Notification when ready
                  {notificationPermission === "denied" ? " (Blocked in browser settings)" : ""}
                </span>
              </label>
            </div>

            {onTestWakeUp && (
              <div className="schedule-panel-footer">
                <span className="schedule-panel-hint">
                  {schedule.enabled
                    ? `Scheduled daily at ${formatScheduleTimeDisplay(schedule.time)}. Prewarms automatically when Signal is open or launched in the morning.`
                    : "Turn on to automatically prewarm your morning audio digest."}
                </span>
                <button
                  type="button"
                  className="briefing-toolbar-btn"
                  onClick={() => onTestWakeUp(briefing)}
                >
                  ▶ Test Wake-up Now
                </button>
              </div>
            )}
          </section>
        )}

        {/* Glance KPI Grid */}
        <section className="daily-briefing-glance-grid" aria-label="Executive briefing glance">
          {/* Weather Glance */}
          <article className="glance-card weather-glance">
            <div className="glance-card-header">
              <span className="glance-card-icon" aria-hidden="true">
                {briefing.weatherGlance ? getWeatherIcon(briefing.weatherGlance.weatherCode) : "⛅"}
              </span>
              <span className="glance-card-label">Local Weather</span>
            </div>
            {briefing.weatherGlance ? (
              <div className="glance-card-content">
                <div className="glance-main-stat">
                  <strong>{briefing.weatherGlance.temperature}&deg;C</strong>
                  <span className="glance-stat-condition">{briefing.weatherGlance.condition}</span>
                </div>
                <p className="glance-subtext">
                  <span>{briefing.weatherGlance.location}</span>
                  {briefing.weatherGlance.high !== undefined && (
                    <span> &bull; H: {briefing.weatherGlance.high}&deg; / L: {briefing.weatherGlance.low}&deg;</span>
                  )}
                </p>
                {briefing.weatherGlance.alertsCount > 0 && (
                  <div className="glance-alert-pill" title={briefing.weatherGlance.topAlertHeadline}>
                    ⚠️ {briefing.weatherGlance.alertsCount} weather alert active
                  </div>
                )}
              </div>
            ) : (
              <div className="glance-card-empty">Local weather unavailable</div>
            )}
          </article>

          {/* Market Glance (Top Mover + Multi-Ticker Watchlist Pills) */}
          <article className="glance-card market-glance">
            <div className="glance-card-header">
              <span className="glance-card-icon" aria-hidden="true">📈</span>
              <span className="glance-card-label">
                {secondaryWatchlistQuotes.length > 0 ? "Market Watchlist" : "Financial Markets"}
              </span>
            </div>
            {briefing.marketGlance ? (
              <div className="glance-card-content">
                <div className="glance-main-stat">
                  <strong>{briefing.marketGlance.symbol}</strong>
                  <span
                    className={`glance-stat-pill ${
                      briefing.marketGlance.change > 0
                        ? "positive"
                        : briefing.marketGlance.change < 0
                          ? "negative"
                          : "neutral"
                    }`}
                  >
                    {briefing.marketGlance.change > 0 ? "+" : ""}
                    {briefing.marketGlance.percentChange.toFixed(2)}%
                  </span>
                </div>
                <p className="glance-subtext">
                  <span>{briefing.marketGlance.name}</span>
                  <span> &bull; {briefing.marketGlance.formattedPrice}</span>
                </p>

                {secondaryWatchlistQuotes.length > 0 && (
                  <div className="glance-watchlist-strip" aria-label="Additional watched market movers">
                    {secondaryWatchlistQuotes.map((item) => (
                      <span
                        key={item.symbol}
                        className={`glance-watchlist-pill ${
                          item.percentChange > 0
                            ? "positive"
                            : item.percentChange < 0
                              ? "negative"
                              : "neutral"
                        }`}
                        title={`${item.name} (${item.topic}): ${item.formattedPrice}`}
                      >
                        <strong>{item.symbol}</strong>
                        <span>
                          {item.percentChange > 0 ? "+" : ""}
                          {item.percentChange.toFixed(1)}%
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="glance-card-empty">
                Follow a stock or index topic to see live quotes
              </div>
            )}
          </article>

          {/* Pulse Momentum Glance */}
          <article className="glance-card pulse-glance">
            <div className="glance-card-header">
              <span className="glance-card-icon" aria-hidden="true">⚡</span>
              <span className="glance-card-label">Topic Momentum</span>
            </div>
            {briefing.pulseGlance && briefing.pulseGlance.totalTracked > 0 ? (
              <div className="glance-card-content">
                <div className="glance-main-stat">
                  <strong>
                    {briefing.pulseGlance.topSurgingTopic || `${briefing.pulseGlance.totalTracked} Topics`}
                  </strong>
                  <span className="glance-sentiment-badge">
                    {briefing.pulseGlance.sentimentToneLabel}
                  </span>
                </div>
                <p className="glance-subtext">
                  <span>{briefing.pulseGlance.totalMentions} mentions this week</span>
                  {briefing.pulseGlance.surgingCount > 0 && (
                    <span> &bull; {briefing.pulseGlance.surgingCount} surging</span>
                  )}
                </p>
              </div>
            ) : (
              <div className="glance-card-empty">Follow topics to monitor momentum</div>
            )}
          </article>
        </section>

        {/* "Ask Today's Briefing" Interactive Voice & Text Q&A */}
        <section className="daily-briefing-qa-card" aria-label="Ask Today's Briefing">
          <div className="briefing-qa-header">
            <span className="briefing-qa-title">💬 Ask Today&apos;s Briefing</span>
            <span className="briefing-qa-hint">
              Ask a follow-up question by text or voice across today&apos;s stories, markets &amp; weather
            </span>
          </div>

          {suggestedQuestions.length > 0 && (
            <div className="briefing-qa-suggestions" role="group" aria-label="Suggested briefing questions">
              {suggestedQuestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="briefing-qa-chip"
                  disabled={qaBusy}
                  onClick={() => {
                    setQaInput(suggestion);
                    void submitBriefingQuestion(suggestion);
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          <form
            className="briefing-qa-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitBriefingQuestion(qaInput);
            }}
          >
            <input
              type="text"
              className="briefing-qa-input"
              value={qaInput}
              onChange={(e) => setQaInput(e.target.value)}
              placeholder="Ask about any story, watched stock, or forecast…"
              aria-label="Ask a question about today's briefing"
              maxLength={300}
            />
            <VoiceMicButton
              label="Ask briefing by voice"
              language={speechLocale}
              disabled={qaBusy}
              className="briefing-qa-mic"
              onVoiceCommand={(command) => {
                const spoken = command.raw || command.query;
                if (spoken) {
                  setQaInput(spoken);
                  void submitBriefingQuestion(spoken);
                }
              }}
              onError={(msg) => setQaError(msg)}
            />
            <button
              type="submit"
              className="briefing-qa-submit"
              disabled={qaBusy || qaInput.trim().length < 2}
            >
              {qaBusy ? "Thinking…" : "Ask"}
            </button>
          </form>

          {qaError && (
            <p className="briefing-qa-error" role="alert">
              {qaError}
            </p>
          )}

          {qaResult && (
            <div className="briefing-qa-answer-box" role="region" aria-label="Briefing answer">
              <div className="briefing-qa-answer-header">
                <div className="briefing-qa-answer-badges">
                  <span className="briefing-qa-mode-badge">
                    {qaResult.mode === "azure-ai"
                      ? "✨ AI Synthesis"
                      : qaResult.mode === "offline-local"
                        ? "📡 Offline Pack Answer"
                        : "📑 Cited Answer"}
                  </span>
                  {qaAskedQuestion && (
                    <span className="briefing-qa-question-echo">&ldquo;{qaAskedQuestion}&rdquo;</span>
                  )}
                </div>
                <div className="briefing-qa-answer-controls">
                  {qaResult.answer && (
                    <button
                      type="button"
                      className={`briefing-qa-listen-btn ${isQaAudioActive ? "active" : ""}`}
                      onClick={handleQaAudioToggle}
                    >
                      {isQaAudioActive ? "⏹ Stop" : "🔊 Read Answer"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="briefing-qa-clear-btn"
                    onClick={() => {
                      qaSpeech.stop();
                      setQaResult(null);
                      setQaAskedQuestion("");
                    }}
                    title="Clear answer"
                    aria-label="Clear briefing answer"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <p className="briefing-qa-answer-text">{qaResult.answer}</p>

              {qaResult.citations.length > 0 && (
                <div className="briefing-qa-citations" aria-label="Cited sources">
                  <span className="briefing-qa-citations-label">Sources:</span>
                  {qaResult.citations.map((cite) => {
                    const matchedArt = articles.find((a) => a.url === cite.url);
                    return onOpenArticle ? (
                      <button
                        key={cite.url}
                        type="button"
                        className="briefing-qa-citation-pill"
                        onClick={() => {
                          onClose();
                          onOpenArticle(
                            toFollowedArticle(
                              { title: cite.title, url: cite.url, source: cite.source },
                              matchedArt,
                            ),
                          );
                        }}
                        title={cite.title}
                      >
                        <strong>{cite.source}</strong>: {cite.title}
                      </button>
                    ) : (
                      <a
                        key={cite.url}
                        href={cite.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="briefing-qa-citation-pill"
                        title={cite.title}
                      >
                        <strong>{cite.source}</strong>: {cite.title}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Personalized Priority Topic Highlights Selector */}
        {availableTopicChips.length > 0 && (
          <section className="daily-briefing-priority-bar" aria-label="Personalized priority topic highlights">
            <div className="priority-bar-heading">
              <span className="priority-bar-label">★ Priority Highlights</span>
              <span className="priority-bar-hint">
                Pin favorite topics so they headline your daily digest first
              </span>
            </div>
            <div className="priority-chip-list" role="group" aria-label="Pin priority topics">
              {availableTopicChips.map((topic) => {
                const isPinned = priorityTopics.some((p) => p.toLowerCase() === topic.toLowerCase());
                return (
                  <button
                    key={topic}
                    type="button"
                    className={`priority-topic-chip ${isPinned ? "pinned" : ""}`}
                    aria-pressed={isPinned}
                    onClick={() => handleTogglePriorityTopic(topic)}
                    title={isPinned ? `Unpin ${topic} from priority highlights` : `Pin ${topic} as a priority briefing topic`}
                  >
                    <span aria-hidden="true">{isPinned ? "★" : "☆"}</span> {topic}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Lead Stories */}
        <section className="daily-briefing-lead-stories" aria-label="Lead news stories">
          <div className="daily-briefing-section-heading">
            <h3>Lead Stories</h3>
            {briefing.unreadCount > 0 && (
              <span className="unread-counter-badge">
                {briefing.unreadCount} unread
              </span>
            )}
            {briefing.priorityMatchesCount > 0 && (
              <span className="priority-counter-badge">
                ★ {briefing.priorityMatchesCount} priority
              </span>
            )}
          </div>

          {briefing.leadStories.length === 0 ? (
            <div className="daily-briefing-empty-stories">
              No recent news stories found for your followed topics.
            </div>
          ) : (
            <div className="daily-briefing-story-list">
              {briefing.leadStories.map((story) => {
                const matchedArticle = articles.find((a) => a.url === story.url);
                const articleRecord = toFollowedArticle(story, matchedArticle);
                const hasOfflineReader = Boolean(getCachedOfflineArticle(story.url)?.paragraphs?.length);
                return (
                  <article
                    key={story.url}
                    className={`briefing-story-item ${story.priorityTopic ? "priority-highlighted" : ""}`}
                  >
                    <div className="briefing-story-meta">
                      <span className="briefing-story-source">{story.source}</span>
                      {story.priorityTopic && (
                        <span className="briefing-story-priority-badge">
                          ★ {story.priorityTopic}
                        </span>
                      )}
                      {story.isRead ? (
                        <span className="briefing-story-read-indicator">Read</span>
                      ) : (
                        <span className="briefing-story-unread-indicator">New</span>
                      )}
                      {hasOfflineReader && (
                        <span className="briefing-story-offline-indicator" title="Full article text saved for offline reading">
                          ⚡ Offline ready
                        </span>
                      )}
                    </div>
                    <h4 className="briefing-story-title">
                      {onOpenArticle ? (
                        <button
                          type="button"
                          className="briefing-story-title-link"
                          onClick={() => {
                            onClose();
                            onOpenArticle(articleRecord);
                          }}
                        >
                          {story.title}
                        </button>
                      ) : (
                        <a href={story.url} target="_blank" rel="noopener noreferrer">
                          {story.title}
                        </a>
                      )}
                    </h4>
                    {story.summary && (
                      <p className="briefing-story-summary">{story.summary}</p>
                    )}
                    <div className="briefing-story-actions">
                      {onOpenArticle && (
                        <button
                          type="button"
                          className="briefing-story-action-btn"
                          onClick={() => {
                            onClose();
                            onOpenArticle(articleRecord);
                          }}
                        >
                          Read in Signal &rarr;
                        </button>
                      )}
                      {onListenArticle && (
                        <button
                          type="button"
                          className="briefing-story-action-btn secondary"
                          onClick={() => onListenArticle(articleRecord)}
                          title="Listen to story headline"
                        >
                          🔊 Listen
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Spoken Script Transcript Accordion */}
        <details className="daily-briefing-transcript-section">
          <summary className="daily-briefing-transcript-summary">
            📜 View Full Narration Transcript
          </summary>
          <div className="daily-briefing-transcript-body">
            <p>{briefing.spokenScript}</p>
          </div>
        </details>
      </div>
    </dialog>
  );
}
