"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FollowedArticle } from "./NewsDashboard";
import { translationLanguages } from "./article-translation";
import ContinueOnWatch from "./ContinueOnWatch";
import { useListeningQueueClient } from "./ListenLater";
import { MarketSparkline } from "./MarketSparkline";
import MinimizedAudioPlayer from "./MinimizedAudioPlayer";
import VoiceMicButton from "./VoiceMicButton";
import {
  buildDailyBriefing,
  formatScheduleTimeDisplay,
  loadBriefingSchedule,
  loadPriorityTopics,
  savePriorityTopics,
  sendServerBriefingNow,
  togglePriorityTopic,
  updateBriefingSchedule,
  type BriefingSchedulePrefs,
  type DailyBriefingData,
  type DailyBriefingStory,
} from "./daily-briefing";
import { queueBriefingLeadStories } from "./daily-briefing-queue";
import type { CatchUpDeltaSummary, SituationRadarSummary } from "./daily-briefing-radar";
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
import { type CoHostState } from "./daily-briefing-cohost";
import { getCachedOfflineArticle } from "./offline-prewarm";
import type {
  LocalWeather,
  WeatherForecastDay,
  ClientWeatherAlert,
  ClientWeatherConditions,
} from "./weather-briefing";
import type { MarketQuote, MarketPortfolioQuoteItem } from "./market-quote";
import type { EntityPulseSummary } from "./entity-pulse";
import { useSpokenBriefing } from "./useSpokenBriefing";
import CarModePlayer from "./CarModePlayer";
import DeepDivePodcastPlayer from "./DeepDivePodcastPlayer";
import { fetchBriefingDeepDive, type DeepDiveEpisode } from "./daily-briefing-deep-dive";
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
  language: controlledLanguage,
  onChangeLanguage,
  isMinimized: controlledMinimized,
  onMinimizeChange,
  situationRadar = null,
  catchUpDelta = null,
  accountSyncActive = false,
  initialCarMode = false,
  portfolioAlerts = [],
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
  language?: string;
  onChangeLanguage?: (language: string) => void;
  isMinimized?: boolean;
  onMinimizeChange?: (minimized: boolean) => void;
  situationRadar?: SituationRadarSummary | null;
  catchUpDelta?: CatchUpDeltaSummary | null;
  accountSyncActive?: boolean;
  initialCarMode?: boolean;
  portfolioAlerts?: readonly MarketPortfolioQuoteItem[];
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

  const queueClient = useListeningQueueClient();

  // Multilingual Executive Briefing state
  const [localBriefingLanguage, setLocalBriefingLanguage] = useState<string>(() => loadBriefingLanguage());
  const briefingLanguage = controlledLanguage ?? localBriefingLanguage;
  const [localMinimized, setLocalMinimized] = useState<boolean>(false);
  const isMinimized = controlledMinimized ?? localMinimized;
  const setMinimized = useCallback(
    (next: boolean) => {
      if (onMinimizeChange) onMinimizeChange(next);
      else setLocalMinimized(next);
    },
    [onMinimizeChange],
  );

  const [translationState, setTranslationState] = useState<{
    sourceKey: string;
    briefing: DailyBriefingData | null;
    busy: boolean;
  }>({ sourceKey: "", briefing: null, busy: false });

  // Export, Hosted Share, Queue & Server Delivery state
  const [shareFeedback, setShareFeedback] = useState<string>("");
  const [hostedShareBusy, setHostedShareBusy] = useState<boolean>(false);
  const [hostedShareUrl, setHostedShareUrl] = useState<string>("");
  const [queueBusy, setQueueBusy] = useState<boolean>(false);
  const [queueFeedback, setQueueFeedback] = useState<string>("");
  const [deliveryBusy, setDeliveryBusy] = useState<boolean>(false);
  const [deliveryFeedback, setDeliveryFeedback] = useState<string>("");

  // "Ask Today's Briefing" Q&A state
  const [qaInput, setQaInput] = useState<string>("");
  const [qaBusy, setQaBusy] = useState<boolean>(false);
  const [qaAskedQuestion, setQaAskedQuestion] = useState<string>("");
  const [qaResult, setQaResult] = useState<BriefingQaResult | null>(null);
  const [qaError, setQaError] = useState<string>("");
  const qaAbortRef = useRef<AbortController | null>(null);
  const [coHostState, setCoHostState] = useState<CoHostState | null>(null);
  const briefingWasPausedForCoHostRef = useRef<boolean>(false);

  const [schedulePanelOpen, setSchedulePanelOpen] = useState(false);
  const [carModeOpen, setCarModeOpen] = useState(Boolean(initialCarMode));
  const [deepDiveEpisode, setDeepDiveEpisode] = useState<DeepDiveEpisode | null>(null);
  const [deepDiveLoading, setDeepDiveLoading] = useState(false);
  const [deepDiveOpen, setDeepDiveOpen] = useState(false);
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
      situationRadar,
      catchUpDelta,
      portfolioAlerts,
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
    situationRadar,
    catchUpDelta,
    portfolioAlerts,
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

  const handleRadioAutoContinue = useCallback(async () => {
    if (!schedule.autoContinueStories || briefing.leadStories.length === 0) return;
    if (queueClient) {
      await queueBriefingLeadStories(briefing.leadStories, queueClient);
    }
    const firstLead = briefing.leadStories[0];
    if (firstLead && onListenArticle) {
      const matched = articles.find((a) => a.url === firstLead.url);
      setMinimized(false);
      onClose();
      onListenArticle(toFollowedArticle(firstLead, matched));
    }
  }, [articles, briefing.leadStories, onClose, onListenArticle, queueClient, schedule.autoContinueStories, setMinimized]);

  const playBriefingFromChapter = useCallback(
    async (startIndex = 0) => {
      stopQaSpeech();
      let cachedBlob: Blob | null = null;
      if (startIndex === 0 && offlineMeta?.hasNeuralAudio) {
        if (offlineMeta.id === currentPackId) {
          cachedBlob = await loadOfflineBriefingAudio(currentPackId);
        } else if (!isOnline) {
          cachedBlob = await loadOfflineBriefingAudio(offlineMeta.id);
        }
      }
      const targetBriefing =
        !isOnline && cachedBlob && offlineMeta ? offlineMeta.briefing : briefing;
      const chaptersToSpeak =
        targetBriefing.chapters && targetBriefing.chapters.length > 0
          ? targetBriefing.chapters
          : [{ text: targetBriefing.spokenScript }];

      speech.speakChapters(chaptersToSpeak, {
        startIndex,
        targetLanguage: speechLocale,
        offlineAudioBlob: cachedBlob,
        onComplete: () => {
          void handleRadioAutoContinue();
        },
      });
    },
    [
      briefing,
      currentPackId,
      handleRadioAutoContinue,
      isOnline,
      offlineMeta,
      speech,
      speechLocale,
      stopQaSpeech,
    ],
  );

  // Stop audio ONLY when the briefing is closed (not when minimized into floating bar)
  useEffect(() => {
    if (!isOpen) {
      stopBriefing();
      stopQaSpeech();
      qaAbortRef.current?.abort();
      return;
    }
    return () => {
      stopBriefing();
      stopQaSpeech();
      qaAbortRef.current?.abort();
    };
  }, [isOpen, stopBriefing, stopQaSpeech]);

  // Manage native <dialog> visibility so minimizing keeps audio alive while freeing the dashboard
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || isMinimized) {
      if (dialog && dialog.open) {
        dialog.close();
      }
      return;
    }

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
    };
  }, [isMinimized, isOpen, onClose]);

  // Auto-play support when launched from Wake-up Briefing "Play Briefing" button
  useEffect(() => {
    if (!isOpen || !autoPlayOnOpen) return;
    onAutoPlayConsumed?.();
    void playBriefingFromChapter(0);
  }, [autoPlayOnOpen, isOpen, onAutoPlayConsumed, playBriefingFromChapter]);

  if (!isOpen) return null;

  const isAudioActive = speech.status === "starting" || speech.status === "playing";
  const isQaAudioActive = qaSpeech.status === "starting" || qaSpeech.status === "playing";
  const chapters = briefing.chapters || [];
  const activeChapter =
    isAudioActive &&
    speech.activeChapterIndex !== null &&
    chapters[speech.activeChapterIndex]
      ? chapters[speech.activeChapterIndex]
      : null;

  if (isMinimized) {
    const chapterSuffix = activeChapter ? ` · ${activeChapter.icon} ${activeChapter.label}` : "";
    return (
      <MinimizedAudioPlayer
        title={`Executive Briefing (${briefing.edition})${chapterSuffix}`}
        onRestore={() => setMinimized(false)}
        onClose={() => {
          setMinimized(false);
          onClose();
        }}
      />
    );
  }

  const handleAudioToggle = () => {
    if (isAudioActive) {
      speech.stop();
    } else {
      void playBriefingFromChapter(0);
    }
  };

  const handleLanguageChange = (nextLang: string) => {
    speech.stop();
    qaSpeech.stop();
    const saved = saveBriefingLanguage(nextLang);
    setLocalBriefingLanguage(saved);
    onChangeLanguage?.(saved);
    setHostedShareUrl("");
  };

  const handleQueueStoriesClick = async () => {
    if (!queueClient || queueBusy || briefing.leadStories.length === 0) return;
    setQueueBusy(true);
    setQueueFeedback("");
    try {
      const res = await queueBriefingLeadStories(briefing.leadStories, queueClient);
      if (res.added > 0) {
        setQueueFeedback(`Queued ${res.added} ${res.added === 1 ? "story" : "stories"} to Listen Later`);
      } else if (res.alreadyQueued > 0) {
        setQueueFeedback("Lead stories already in Listen Later");
      } else {
        setQueueFeedback("Listen Later queue is full (10 max)");
      }
      window.setTimeout(() => setQueueFeedback(""), 4000);
    } finally {
      setQueueBusy(false);
    }
  };

  const handleSendServerDeliveryClick = async () => {
    if (deliveryBusy || !isOnline) return;
    setDeliveryBusy(true);
    setDeliveryFeedback("");
    try {
      const res = await sendServerBriefingNow({
        sendPush: schedule.notify,
        sendEmail: schedule.deliverEmail || !schedule.notify,
      });
      if (!res.ok) {
        setDeliveryFeedback(res.error || "Could not dispatch briefing.");
      } else {
        const channels: string[] = [];
        if (res.sentPush) channels.push("Push");
        if (res.sentEmail) channels.push("Email");
        setDeliveryFeedback(
          channels.length > 0
            ? `Delivered via ${channels.join(" + ")}${res.warning ? ` (${res.warning})` : ""}`
            : res.warning || "Dispatched (configure push device or SMTP email to receive).",
        );
      }
      window.setTimeout(() => setDeliveryFeedback(""), 5000);
    } finally {
      setDeliveryBusy(false);
    }
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

  const handleAskCoHost = useCallback(
    async (rawQuestion: string) => {
      const cleanQ = rawQuestion.replace(/\s+/g, " ").trim();
      if (!cleanQ) return;

      if (speech.isSpeaking && !speech.isPaused) {
        briefingWasPausedForCoHostRef.current = true;
        speech.pause();
      }

      setCoHostState({
        asking: true,
        question: cleanQ,
      });

      try {
        const res = await askDailyBriefing({
          question: cleanQ,
          briefing,
          articles,
          language: briefingLanguage,
          isOnline,
        });

        setCoHostState({
          asking: false,
          question: cleanQ,
          answer: res.answer,
          mode: res.mode,
          citations: res.citations,
        });

        // Narrate answer aloud and resume briefing playback when speech finishes
        qaSpeech.stop();
        qaSpeech.speak(res.answer, speechLocale, null, () => {
          if (briefingWasPausedForCoHostRef.current) {
            briefingWasPausedForCoHostRef.current = false;
            speech.resume();
          }
        });
      } catch (err) {
        setCoHostState({
          asking: false,
          question: cleanQ,
          error: err instanceof Error ? err.message : "Could not reach briefing co-host.",
        });
        if (briefingWasPausedForCoHostRef.current) {
          briefingWasPausedForCoHostRef.current = false;
          speech.resume();
        }
      }
    },
    [speech, qaSpeech, briefing, articles, briefingLanguage, isOnline, speechLocale],
  );

  const handleDismissCoHost = useCallback(() => {
    qaSpeech.stop();
    setCoHostState(null);
    if (briefingWasPausedForCoHostRef.current) {
      briefingWasPausedForCoHostRef.current = false;
      speech.resume();
    }
  }, [qaSpeech, speech]);

  const handleLaunchDeepDive = useCallback(async () => {
    if (speech.isSpeaking && !speech.isPaused) {
      speech.pause();
    }
    setDeepDiveLoading(true);
    setDeepDiveOpen(true);
    try {
      const episode = await fetchBriefingDeepDive({
        briefing,
        articles,
        language: briefingLanguage,
        isOnline,
      });
      setDeepDiveEpisode(episode);
    } catch {
      // Handled via local fallback in fetchBriefingDeepDive
    } finally {
      setDeepDiveLoading(false);
    }
  }, [speech, briefing, articles, briefingLanguage, isOnline]);

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
              {accountSyncActive && (
                <span className="daily-briefing-status-pill synced" title="Briefing priorities, language, and schedule sync across your devices">
                  ☁️ Synced
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
              className="daily-briefing-minimize-btn"
              onClick={() => setMinimized(true)}
              title="Minimize briefing to floating player bar (audio keeps playing)"
              aria-label="Minimize executive briefing"
            >
              &#8211;
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

        {/* Interactive Chapter Scrubber & Radio Queue Bar */}
        {chapters.length > 0 && (
          <section className="daily-briefing-chapters-bar" aria-label="Briefing chapters and radio queue">
            <div className="chapters-top-row">
              <div className="chapters-nav-controls">
                <button
                  type="button"
                  className="chapters-step-btn"
                  disabled={!isAudioActive || (speech.activeChapterIndex ?? 0) <= 0}
                  onClick={() =>
                    void playBriefingFromChapter(Math.max(0, (speech.activeChapterIndex ?? 0) - 1))
                  }
                  title="Previous chapter"
                >
                  &larr; Prev
                </button>
                <button
                  type="button"
                  className="chapters-step-btn"
                  disabled={
                    chapters.length <= 1 ||
                    (isAudioActive && (speech.activeChapterIndex ?? 0) >= chapters.length - 1)
                  }
                  onClick={() =>
                    void playBriefingFromChapter(
                      isAudioActive
                        ? Math.min(chapters.length - 1, (speech.activeChapterIndex ?? 0) + 1)
                        : 0,
                    )
                  }
                  title="Next chapter"
                >
                  Next &rarr;
                </button>
              </div>

              <div className="chapters-radio-actions">
                {queueClient && briefing.leadStories.length > 0 && (
                  <button
                    type="button"
                    className="briefing-toolbar-btn"
                    disabled={queueBusy}
                    onClick={() => void handleQueueStoriesClick()}
                    title="Push today's lead briefing stories into your Listen Later queue"
                  >
                    {queueBusy ? "⏳ Queueing…" : "➕ Queue Lead Stories"}
                  </button>
                )}

                <label
                  className="briefing-radio-continue-toggle"
                  title="Automatically transition into full-story narration when the briefing digest finishes"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(schedule.autoContinueStories)}
                    onChange={(e) =>
                      void handleSchedulePatch({ autoContinueStories: e.target.checked })
                    }
                  />
                  <span>📻 Continue into full stories</span>
                </label>

                {queueFeedback && (
                  <span className="briefing-queue-feedback" role="status" aria-live="polite">
                    {queueFeedback}
                  </span>
                )}
              </div>
            </div>

            <div className="chapters-pill-strip" role="tablist" aria-label="Jump to briefing chapter">
              {chapters.map((chapter, idx) => {
                const isCurrent = isAudioActive && speech.activeChapterIndex === idx;
                return (
                  <button
                    key={chapter.id}
                    type="button"
                    role="tab"
                    aria-selected={isCurrent}
                    className={`chapter-scrubber-pill ${isCurrent ? "active" : ""}`}
                    onClick={() => void playBriefingFromChapter(idx)}
                    title={`Play from ${chapter.label}`}
                  >
                    <span aria-hidden="true">{chapter.icon}</span>
                    <span>{chapter.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

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

            <button
              type="button"
              className="briefing-toolbar-btn car-mode-trigger-btn"
              onClick={() => setCarModeOpen(true)}
              title="Switch to Commute &amp; Smart Car Mode (large touch targets, driving voice controls)"
            >
              🚗 Car Mode
            </button>

            <button
              type="button"
              className="briefing-toolbar-btn cohost-trigger-btn"
              onClick={() => {
                const qaSection = document.getElementById("briefing-qa-section");
                if (qaSection) {
                  qaSection.scrollIntoView({ behavior: "smooth" });
                  const input = document.getElementById("briefing-qa-input");
                  input?.focus();
                } else {
                  void handleAskCoHost(suggestedQuestions[0] || "What are today's top takeaways?");
                }
              }}
              title="Talk to Your Briefing Executive Co-Host"
            >
              🎙️ Ask Co-Host
            </button>

            <button
              type="button"
              className="briefing-toolbar-btn deep-dive-trigger-btn"
              onClick={() => void handleLaunchDeepDive()}
              disabled={deepDiveLoading}
              title="Generate and listen to an investigative 2-host podcast deep dive on today's top story cluster"
            >
              {deepDiveLoading ? "⏳ Loading Podcast..." : "🎙️ Deep Dive Podcast"}
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
                  Deliver Wake-up Push Notification (even when Signal is closed)
                  {notificationPermission === "denied" ? " (Blocked in browser settings)" : ""}
                </span>
              </label>

              <label className="schedule-option-check">
                <input
                  type="checkbox"
                  checked={Boolean(schedule.deliverEmail)}
                  onChange={(e) => void handleSchedulePatch({ deliverEmail: e.target.checked })}
                />
                <span>
                  Deliver Morning Email Digest with one-tap hosted audio link
                </span>
              </label>
            </div>

            <div className="schedule-panel-footer">
              <span className="schedule-panel-hint">
                {schedule.enabled
                  ? `Scheduled daily at ${formatScheduleTimeDisplay(schedule.time)}. Server delivers Push/Email automatically and prewarms on launch.`
                  : "Turn on to schedule server-delivered wake-up alerts, morning email digests, and offline audio packs."}
              </span>
              <div className="schedule-delivery-actions">
                {onTestWakeUp && (
                  <button
                    type="button"
                    className="briefing-toolbar-btn"
                    onClick={() => onTestWakeUp(briefing)}
                  >
                    ▶ Test Local Wake-up
                  </button>
                )}
                <button
                  type="button"
                  className="briefing-toolbar-btn"
                  disabled={!isOnline || deliveryBusy}
                  onClick={() => void handleSendServerDeliveryClick()}
                  title="Dispatch an immediate server Push and/or Email Executive Briefing digest"
                >
                  {deliveryBusy ? "⏳ Sending…" : "📨 Send Push / Email Now"}
                </button>
              </div>
              {deliveryFeedback && (
                <span className="schedule-delivery-feedback" role="status" aria-live="polite">
                  {deliveryFeedback}
                </span>
              )}
            </div>
          </section>
        )}

        {/* Live Situation Radar (Earthquakes + GDACS Disasters — shown when advisory or elevated) */}
        {briefing.situationRadar && briefing.situationRadar.level !== "calm" && (
          <section
            className={`daily-briefing-situation-radar ${briefing.situationRadar.level} ${
              activeChapter?.kind === "situation" ? "is-speaking-chapter" : ""
            }`}
            aria-label="Live Situation Radar"
          >
            <div className="situation-radar-header">
              <span className="situation-radar-title">
                🚨 Live Situation Radar &bull;{" "}
                {briefing.situationRadar.level === "elevated" ? "Elevated Alert" : "Active Advisory"}
              </span>
              {briefing.situationRadar.source && (
                <span className="situation-radar-source">
                  {briefing.situationRadar.source} + GDACS
                </span>
              )}
            </div>
            <div className="situation-radar-list">
              {briefing.situationRadar.items.map((item) =>
                item.url ? (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`situation-radar-item ${item.severity}`}
                  >
                    <span className="situation-radar-badge">{item.badge}</span>
                    <strong>{item.title}</strong>
                    <span className="situation-radar-detail">{item.detail}</span>
                  </a>
                ) : (
                  <div key={item.id} className={`situation-radar-item ${item.severity}`}>
                    <span className="situation-radar-badge">{item.badge}</span>
                    <strong>{item.title}</strong>
                    <span className="situation-radar-detail">{item.detail}</span>
                  </div>
                ),
              )}
            </div>
          </section>
        )}

        {/* "Since Your Last Visit" Catch-Up Delta Card */}
        {briefing.catchUpDelta && briefing.catchUpDelta.hasChanges && (
          <section
            className={`daily-briefing-catchup-card ${
              activeChapter?.kind === "catchup" ? "is-speaking-chapter" : ""
            }`}
            aria-label="Since your last visit catch-up delta"
          >
            <div className="catchup-card-header">
              <span className="catchup-card-title">⏱️ Since Your Last Visit</span>
              <span className="catchup-card-elapsed">Checkpoint {briefing.catchUpDelta.elapsedLabel}</span>
            </div>
            <div className="catchup-metrics-row">
              {briefing.catchUpDelta.newStoriesCount > 0 && (
                <span className="catchup-metric-pill">
                  🗞️ +{briefing.catchUpDelta.newStoriesCount} new{" "}
                  {briefing.catchUpDelta.newStoriesCount === 1 ? "story" : "stories"}
                </span>
              )}
              {briefing.catchUpDelta.newlySurgingTopics.map((topic) => (
                <span key={topic} className="catchup-metric-pill">
                  ⚡ {topic} surging
                </span>
              ))}
              {briefing.catchUpDelta.marketSwings.map((swing) => (
                <span
                  key={swing.symbol}
                  className={`catchup-metric-pill ${swing.deltaPercent >= 0 ? "positive" : "negative"}`}
                >
                  {swing.deltaPercent >= 0 ? "▲" : "▼"} {swing.symbol}{" "}
                  {swing.deltaPercent >= 0 ? "+" : ""}
                  {swing.deltaPercent.toFixed(1)}%
                </span>
              ))}
            </div>
            {briefing.catchUpDelta.topNewStories.length > 0 && (
              <div className="catchup-headlines-row">
                {briefing.catchUpDelta.topNewStories.map((story) => {
                  const matched = articles.find((a) => a.url === story.url);
                  return onOpenArticle ? (
                    <button
                      key={story.url}
                      type="button"
                      className="catchup-headline-btn"
                      onClick={() => {
                        onClose();
                        onOpenArticle(toFollowedArticle(story, matched));
                      }}
                      title={story.title}
                    >
                      <strong>{story.source}:</strong> {story.title}
                    </button>
                  ) : (
                    <a
                      key={story.url}
                      href={story.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="catchup-headline-btn"
                      title={story.title}
                    >
                      <strong>{story.source}:</strong> {story.title}
                    </a>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Glance KPI Grid */}
        <section className="daily-briefing-glance-grid" aria-label="Executive briefing glance">
          {/* Weather Glance */}
          <article
            className={`glance-card weather-glance ${
              activeChapter?.kind === "weather" ? "is-speaking-chapter" : ""
            }`}
          >
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

                {portfolioAlerts && portfolioAlerts.some((a) => a.isAlertTriggered) && (
                  <div className="briefing-portfolio-alerts-group" role="status" aria-label="Triggered portfolio alerts">
                    {portfolioAlerts
                      .filter((a) => a.isAlertTriggered)
                      .map((alert) => (
                        <span
                          key={alert.symbol}
                          className={`portfolio-alert-badge ${alert.alertDirection ?? "up"}`}
                          title={`${alert.displayName || alert.symbol} moved ${alert.quote?.percentChange.toFixed(2)}%, exceeding threshold of ${alert.alertThresholdPercent}%`}
                        >
                          🚨 {alert.displayName || alert.symbol} {alert.quote ? `${alert.quote.percentChange >= 0 ? "+" : ""}${alert.quote.percentChange.toFixed(1)}%` : ""} (Threshold &plusmn;{alert.alertThresholdPercent}%)
                        </span>
                      ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="glance-card-empty">Local weather unavailable</div>
            )}
          </article>

          {/* Market Glance (Top Mover + Sparklines + "Why It's Moving" + Multi-Ticker Watchlist Pills) */}
          <article
            className={`glance-card market-glance ${
              activeChapter?.kind === "markets" ? "is-speaking-chapter" : ""
            }`}
          >
            <div className="glance-card-header">
              <span className="glance-card-icon" aria-hidden="true">📈</span>
              <span className="glance-card-label">
                {secondaryWatchlistQuotes.length > 0 ? "Market Watchlist" : "Financial Markets"}
              </span>
            </div>
            {briefing.marketGlance ? (
              <div className="glance-card-content">
                <div className="glance-main-stat glance-main-stat-with-spark">
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
                  <MarketSparkline
                    points={briefing.marketGlance.sparkline}
                    isPositive={briefing.marketGlance.isPositive}
                    width={64}
                    height={22}
                  />
                </div>
                <p className="glance-subtext">
                  <span>{briefing.marketGlance.name}</span>
                  <span> &bull; {briefing.marketGlance.formattedPrice}</span>
                </p>

                {briefing.marketGlance.catalystTitle && briefing.marketGlance.catalystUrl && (
                  onOpenArticle ? (
                    <button
                      type="button"
                      className="glance-catalyst-link"
                      onClick={() => {
                        const url = briefing.marketGlance!.catalystUrl!;
                        const matched = articles.find((a) => a.url === url);
                        onClose();
                        onOpenArticle(
                          toFollowedArticle(
                            {
                              title: briefing.marketGlance!.catalystTitle!,
                              url,
                              source: briefing.marketGlance!.catalystSource || "Signal",
                            },
                            matched,
                          ),
                        );
                      }}
                      title={`Why ${briefing.marketGlance.symbol} is moving: ${briefing.marketGlance.catalystTitle}`}
                    >
                      <span className="glance-catalyst-kicker">Why it&apos;s moving:</span>
                      {briefing.marketGlance.catalystTitle}
                    </button>
                  ) : (
                    <a
                      href={briefing.marketGlance.catalystUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="glance-catalyst-link"
                      title={briefing.marketGlance.catalystTitle}
                    >
                      <span className="glance-catalyst-kicker">Why it&apos;s moving:</span>
                      {briefing.marketGlance.catalystTitle}
                    </a>
                  )
                )}

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
                        title={
                          item.catalystTitle
                            ? `${item.name} (${item.formattedPrice}) — Why it's moving: ${item.catalystTitle}`
                            : `${item.name} (${item.topic}): ${item.formattedPrice}`
                        }
                      >
                        <strong>{item.symbol}</strong>
                        <MarketSparkline
                          points={item.sparkline}
                          isPositive={item.isPositive}
                          width={32}
                          height={12}
                        />
                        <span>
                          {item.percentChange > 0 ? "+" : ""}
                          {item.percentChange.toFixed(1)}%
                        </span>
                      </span>
                    ))}
                  </div>
                )}

                {portfolioAlerts && portfolioAlerts.some((a) => a.isAlertTriggered) && (
                  <div className="briefing-portfolio-alerts-group" role="status" aria-label="Triggered portfolio alerts">
                    {portfolioAlerts
                      .filter((a) => a.isAlertTriggered)
                      .map((alert) => (
                        <span
                          key={alert.symbol}
                          className={`portfolio-alert-badge ${alert.alertDirection ?? "up"}`}
                          title={`${alert.displayName || alert.symbol} moved ${alert.quote?.percentChange.toFixed(2)}%, exceeding threshold of ${alert.alertThresholdPercent}%`}
                        >
                          🚨 {alert.displayName || alert.symbol} {alert.quote ? `${alert.quote.percentChange >= 0 ? "+" : ""}${alert.quote.percentChange.toFixed(1)}%` : ""} (Threshold &plusmn;{alert.alertThresholdPercent}%)
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
          <article
            className={`glance-card pulse-glance ${
              activeChapter?.kind === "momentum" ? "is-speaking-chapter" : ""
            }`}
          >
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
              {briefing.leadStories.map((story, storyIdx) => {
                const matchedArticle = articles.find((a) => a.url === story.url);
                const articleRecord = toFollowedArticle(story, matchedArticle);
                const hasOfflineReader = Boolean(getCachedOfflineArticle(story.url)?.paragraphs?.length);
                const isSpeakingThisStory = activeChapter?.storyIndex === storyIdx;
                return (
                  <article
                    key={story.url}
                    className={`briefing-story-item ${story.priorityTopic ? "priority-highlighted" : ""} ${
                      isSpeakingThisStory ? "is-speaking-chapter" : ""
                    }`}
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

        {carModeOpen && (
          <CarModePlayer
            briefing={briefing}
            activeChapterIndex={speech.activeChapterIndex}
            isSpeaking={speech.isSpeaking}
            isPaused={speech.isPaused}
            onPlayPause={() => {
              if (speech.isSpeaking) speech.pause();
              else if (speech.isPaused) speech.resume();
              else void playBriefingFromChapter();
            }}
            onPreviousChapter={() => speech.previousChapter()}
            onNextChapter={() => speech.nextChapter()}
            onSeekRelative={(s) => speech.seekRelative(s)}
            onClose={() => setCarModeOpen(false)}
            onQueueStories={() => void handleQueueStoriesClick()}
            coHostState={coHostState}
            onAskCoHost={handleAskCoHost}
            onDismissCoHost={handleDismissCoHost}
            onSnooze={(mins) => {
              speech.pause();
              if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                window.setTimeout(() => {
                  try {
                    new Notification("⏰ Morning Briefing", {
                      body: "Your 10-minute briefing snooze is complete. Tap to resume listening.",
                      icon: "/icons/signal-medallion-192.png",
                    });
                  } catch {}
                }, mins * 60 * 1000);
              }
            }}
          />
        )}

        {deepDiveOpen && deepDiveEpisode && (
          <DeepDivePodcastPlayer
            episode={deepDiveEpisode}
            onClose={() => setDeepDiveOpen(false)}
            targetLanguage={briefingLanguage}
          />
        )}
      </div>
    </dialog>
  );
}
