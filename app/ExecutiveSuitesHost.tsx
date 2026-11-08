import React, { Suspense, lazy } from "react";
import type { DailyBriefingData, BriefingSchedulePrefs } from "./daily-briefing";
import type { MarketQuote } from "./market-quote";
import type { LocalWeather } from "./weather-briefing";

// Lazily code-split all heavy executive suites and optional overlays out of the core bundle
const ArticleInterrogationModal = lazy(() => import("./ArticleInterrogationModal"));
const BedsideClockRadioModal = lazy(() => import("./BedsideClockRadioModal"));
const MarketSentimentHeatmap = lazy(() => import("./MarketSentimentHeatmap"));
const AudiogramSnippetModal = lazy(() => import("./AudiogramSnippetModal"));
const ExecutiveDossierModal = lazy(() => import("./ExecutiveDossierModal"));
const CommutePlaylistModal = lazy(() => import("./CommutePlaylistModal"));
const ExecutiveRadarModal = lazy(() => import("./ExecutiveRadarModal"));
const CSuiteReportModal = lazy(() => import("./CSuiteReportModal"));
const MeetingPrepModal = lazy(() => import("./MeetingPrepModal"));
const ScenarioSimulatorModal = lazy(() => import("./ScenarioSimulatorModal"));
const QuoteExtractorModal = lazy(() => import("./QuoteExtractorModal"));
const QuietHoursModal = lazy(() => import("./QuietHoursModal"));
const CompetitorRadarModal = lazy(() => import("./CompetitorRadarModal"));
const CrisisWarRoomModal = lazy(() => import("./CrisisWarRoomModal"));
const RegulatoryRadarModal = lazy(() => import("./RegulatoryRadarModal"));
const ClaimsArbiterModal = lazy(() => import("./ClaimsArbiterModal"));
const SupplyChainModal = lazy(() => import("./SupplyChainModal"));
const CyberIncidentModal = lazy(() => import("./CyberIncidentModal"));
const SanctionsRadarModal = lazy(() => import("./SanctionsRadarModal"));
const KnowledgeGraphModal = lazy(() => import("./KnowledgeGraphModal"));
const HorizonScannerModal = lazy(() => import("./HorizonScannerModal"));
const VoiceDebriefModal = lazy(() => import("./VoiceDebriefModal.tsx"));

const GeopoliticalTransitModal = lazy(() =>
  import("./GeopoliticalTransitModal.tsx").then((m) => ({ default: m.GeopoliticalTransitModal }))
);
const BoardSparringModal = lazy(() =>
  import("./BoardSparringModal.tsx").then((m) => ({ default: m.BoardSparringModal }))
);
const TariffMatrixModal = lazy(() =>
  import("./TariffMatrixModal.tsx").then((m) => ({ default: m.TariffMatrixModal }))
);
const BriefingStudioModal = lazy(() =>
  import("./BriefingStudioModal.tsx").then((m) => ({ default: m.BriefingStudioModal }))
);
const SignalCortexModal = lazy(() =>
  import("./SignalCortexModal.tsx").then((m) => ({ default: m.SignalCortexModal }))
);
const DailyCastModal = lazy(() =>
  import("./DailyCastModal.tsx").then((m) => ({ default: m.DailyCastModal }))
);
const SovereignRiskModal = lazy(() =>
  import("./SovereignRiskModal.tsx").then((m) => ({ default: m.SovereignRiskModal }))
);
const PreMortemModal = lazy(() =>
  import("./PreMortemModal.tsx").then((m) => ({ default: m.PreMortemModal }))
);
const ExecutiveTripwiresModal = lazy(() =>
  import("./ExecutiveTripwiresModal.tsx").then((m) => ({ default: m.ExecutiveTripwiresModal }))
);

export type SuiteHostArticle = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
  imageUrl?: string;
  matchedTopics?: string[];
  topics: string[];
  providers: string[];
  isBookmarked?: boolean;
  isRead?: boolean;
};

export interface ExecutiveSuitesHostProps {
  articles: SuiteHostArticle[];
  marketWatchlist: MarketQuote[];
  dashboardBriefing: DailyBriefingData | null;
  weather: LocalWeather | null;
  briefingSchedule: BriefingSchedulePrefs;
  briefingLanguage: string;
  preferredVoice: string;
  suiteFocusEntityId: string;
  stagedDossierArticles: SuiteHostArticle[];
  setStagedDossierArticles: React.Dispatch<React.SetStateAction<SuiteHostArticle[]>>;
  onOpenArticle: (article: SuiteHostArticle, trigger: HTMLElement) => void;
  onUpdateSchedule: (next: BriefingSchedulePrefs) => void;
  onTriggerBriefing: () => void;
  onOpenSuite: (suiteId: string, focusEntityId?: string) => void;

  // Individual suite modal visibility states & close callbacks
  interrogateArticle: (SuiteHostArticle & { paragraphs?: string[] }) | null;
  onCloseInterrogate: () => void;
  clockRadioOpen: boolean;
  onCloseClockRadio: () => void;
  marketHeatmapOpen: boolean;
  onCloseMarketHeatmap: () => void;
  audiogramTarget: { title: string; excerpt?: string; source: string; url?: string } | null;
  onOpenAudiogram: (target: { title: string; excerpt?: string; source: string; url?: string }) => void;
  onCloseAudiogram: () => void;
  dossierOpen: boolean;
  onCloseDossier: () => void;
  commuteOpen: boolean;
  onCloseCommute: () => void;
  radarOpen: boolean;
  onCloseRadar: () => void;
  csuiteReportOpen: boolean;
  onCloseCSuiteReport: () => void;
  meetingPrepOpen: boolean;
  onCloseMeetingPrep: () => void;
  scenarioSimOpen: boolean;
  onCloseScenarioSim: () => void;
  quoteExtractorOpen: boolean;
  onCloseQuoteExtractor: () => void;
  quietHoursOpen: boolean;
  onCloseQuietHours: () => void;
  competitorRadarOpen: boolean;
  onCloseCompetitorRadar: () => void;
  crisisWarRoomOpen: boolean;
  onCloseCrisisWarRoom: () => void;
  regulatoryRadarOpen: boolean;
  onCloseRegulatoryRadar: () => void;
  claimsArbiterOpen: boolean;
  onCloseClaimsArbiter: () => void;
  supplyChainOpen: boolean;
  onCloseSupplyChain: () => void;
  cyberIncidentOpen: boolean;
  onCloseCyberIncident: () => void;
  sanctionsRadarOpen: boolean;
  onCloseSanctionsRadar: () => void;
  knowledgeGraphOpen: boolean;
  onCloseKnowledgeGraph: () => void;
  horizonScannerOpen: boolean;
  onCloseHorizonScanner: () => void;
  voiceDebriefOpen: boolean;
  onCloseVoiceDebrief: () => void;
  geopoliticalTransitOpen: boolean;
  onCloseGeopoliticalTransit: () => void;
  boardSparringOpen: boolean;
  onCloseBoardSparring: () => void;
  tariffMatrixOpen: boolean;
  onCloseTariffMatrix: () => void;
  briefingStudioOpen: boolean;
  onCloseBriefingStudio: () => void;
  signalCortexOpen: boolean;
  onCloseSignalCortex: () => void;
  dailyCastOpen: boolean;
  onCloseDailyCast: () => void;
  sovereignRiskOpen: boolean;
  onCloseSovereignRisk: () => void;
  preMortemOpen: boolean;
  onClosePreMortem: () => void;
  tripwiresOpen: boolean;
  onCloseTripwires: () => void;
}

export default function ExecutiveSuitesHost(props: ExecutiveSuitesHostProps) {
  const {
    articles,
    marketWatchlist,
    dashboardBriefing,
    weather,
    briefingSchedule,
    briefingLanguage,
    preferredVoice,
    suiteFocusEntityId,
    stagedDossierArticles,
    setStagedDossierArticles,
    onOpenArticle,
    onUpdateSchedule,
    onTriggerBriefing,
    onOpenSuite,
  } = props;

  return (
    <Suspense fallback={null}>
      {props.interrogateArticle && (
        <ArticleInterrogationModal
          article={{
            url: props.interrogateArticle.url,
            title: props.interrogateArticle.title,
            source: props.interrogateArticle.source || props.interrogateArticle.providers?.[0] || "Publisher",
            paragraphs:
              props.interrogateArticle.paragraphs ||
              (props.interrogateArticle.summary ? [props.interrogateArticle.summary] : undefined),
          }}
          onClose={props.onCloseInterrogate}
          preferredVoice={preferredVoice}
        />
      )}

      {props.clockRadioOpen && (
        <BedsideClockRadioModal
          isOpen={props.clockRadioOpen}
          onClose={props.onCloseClockRadio}
          weather={weather}
          alarmTime={briefingSchedule.time}
          alarmEnabled={briefingSchedule.enabled}
          onChangeAlarmTime={(time) => onUpdateSchedule({ ...briefingSchedule, time })}
          onToggleAlarm={(enabled) => onUpdateSchedule({ ...briefingSchedule, enabled })}
          briefingData={dashboardBriefing}
          briefingLanguage={briefingLanguage}
          onTriggerBriefing={onTriggerBriefing}
        />
      )}

      {props.marketHeatmapOpen && (
        <MarketSentimentHeatmap
          isOpen={props.marketHeatmapOpen}
          onClose={props.onCloseMarketHeatmap}
          watchlistItems={marketWatchlist.map((w) => ({ topic: w.symbol, symbol: w.symbol }))}
          headlines={articles.slice(0, 10).map((a) => a.title)}
          onOpenArticleUrl={(url) => {
            const matched = articles.find((a) => a.url === url);
            if (matched) {
              props.onCloseMarketHeatmap();
              onOpenArticle(matched, document.body);
            }
          }}
        />
      )}

      {props.audiogramTarget && (
        <AudiogramSnippetModal
          isOpen={props.audiogramTarget !== null}
          onClose={props.onCloseAudiogram}
          title={props.audiogramTarget.title}
          excerpt={props.audiogramTarget.excerpt}
          source={props.audiogramTarget.source}
          url={props.audiogramTarget.url}
          preferredVoice={preferredVoice}
        />
      )}

      {props.dossierOpen && stagedDossierArticles.length > 0 && (
        <ExecutiveDossierModal
          isOpen={props.dossierOpen}
          onClose={props.onCloseDossier}
          topic={stagedDossierArticles[0]?.topics?.[0] || "Executive Intelligence Dossier"}
          articles={stagedDossierArticles.map((a) => ({
            url: a.url,
            title: a.title,
            source: a.source,
            summary: a.summary,
          }))}
        />
      )}

      {props.commuteOpen && (
        <CommutePlaylistModal
          isOpen={props.commuteOpen}
          onClose={props.onCloseCommute}
          preferredVoice={preferredVoice}
          briefing={dashboardBriefing}
          marketSentiment={{
            macroHeadline: dashboardBriefing?.marketGlance
              ? `${dashboardBriefing.marketGlance.name} (${dashboardBriefing.marketGlance.symbol}) ${dashboardBriefing.marketGlance.percentChange >= 0 ? "+" : ""}${dashboardBriefing.marketGlance.percentChange}%`
              : "Consolidation across primary regional market benchmarks",
            assets: marketWatchlist.map((m) => ({
              symbol: m.symbol,
              name: m.name || m.symbol,
              price: m.price,
              percentChange: m.percentChange,
              changePercent: m.percentChange,
              sentimentTone: m.percentChange >= 0 ? "bullish" : "bearish",
            })),
          }}
          stagedArticles={stagedDossierArticles}
        />
      )}

      {props.radarOpen && (
        <ExecutiveRadarModal
          isOpen={props.radarOpen}
          onClose={props.onCloseRadar}
          articles={articles}
          markets={marketWatchlist}
          onStageDossierArticle={(art) => {
            setStagedDossierArticles((prev) => {
              if (prev.some((p) => p.url === art.url)) return prev;
              return [
                ...prev,
                {
                  title: art.title,
                  source: art.source,
                  url: art.url,
                  publishedAt: new Date().toISOString(),
                  summary: "",
                  topics: [],
                  providers: [art.source],
                },
              ];
            });
          }}
        />
      )}

      {props.csuiteReportOpen && (
        <CSuiteReportModal
          isOpen={props.csuiteReportOpen}
          onClose={props.onCloseCSuiteReport}
          briefing={dashboardBriefing}
          marketSentiment={{
            macroHeadline: dashboardBriefing?.marketGlance
              ? `${dashboardBriefing.marketGlance.name} (${dashboardBriefing.marketGlance.symbol}) ${dashboardBriefing.marketGlance.percentChange >= 0 ? "+" : ""}${dashboardBriefing.marketGlance.percentChange}%`
              : "Consolidation across primary regional market benchmarks",
            assets: marketWatchlist.map((m) => ({
              symbol: m.symbol,
              name: m.name || m.symbol,
              price: m.price,
              percentChange: m.percentChange,
              changePercent: m.percentChange,
              sector: "Global Markets",
            })),
          }}
        />
      )}

      {props.meetingPrepOpen && (
        <MeetingPrepModal
          isOpen={props.meetingPrepOpen}
          onClose={props.onCloseMeetingPrep}
          initialEntity={articles[0]?.topics?.[0] || "Fonterra"}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.scenarioSimOpen && (
        <ScenarioSimulatorModal
          isOpen={props.scenarioSimOpen}
          onClose={props.onCloseScenarioSim}
          baselineAssets={marketWatchlist}
        />
      )}

      {props.quoteExtractorOpen && (
        <QuoteExtractorModal
          isOpen={props.quoteExtractorOpen}
          onClose={props.onCloseQuoteExtractor}
          articles={articles}
          onOpenAudiogram={(q) => {
            props.onCloseQuoteExtractor();
            props.onOpenAudiogram({
              title: `${q.speaker} (${q.organization})`,
              excerpt: q.quoteText,
              source: q.publisher,
              url: q.sourceArticleUrl,
            });
          }}
        />
      )}

      {props.quietHoursOpen && (
        <QuietHoursModal
          isOpen={props.quietHoursOpen}
          onClose={props.onCloseQuietHours}
        />
      )}

      {props.competitorRadarOpen && (
        <CompetitorRadarModal
          isOpen={props.competitorRadarOpen}
          onClose={props.onCloseCompetitorRadar}
          initialPeerGroup="Dairy & Agri-Export"
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.crisisWarRoomOpen && (
        <CrisisWarRoomModal
          isOpen={props.crisisWarRoomOpen}
          onClose={props.onCloseCrisisWarRoom}
          initialIncidentTitle="Critical Supply Chain & Operational Disruption"
          affectedEntity={articles[0]?.topics?.[0] || "Primary Regional Operations"}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.regulatoryRadarOpen && (
        <RegulatoryRadarModal
          isOpen={props.regulatoryRadarOpen}
          onClose={props.onCloseRegulatoryRadar}
          initialSector="All NZ/APAC Sectors"
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.claimsArbiterOpen && (
        <ClaimsArbiterModal
          isOpen={props.claimsArbiterOpen}
          onClose={props.onCloseClaimsArbiter}
          initialTopic={articles[0]?.title || "Reserve Bank Monetary Policy & Dairy Payout Forecasts"}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.supplyChainOpen && (
        <SupplyChainModal
          isOpen={props.supplyChainOpen}
          onClose={props.onCloseSupplyChain}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.cyberIncidentOpen && (
        <CyberIncidentModal
          isOpen={props.cyberIncidentOpen}
          onClose={props.onCloseCyberIncident}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.sanctionsRadarOpen && (
        <SanctionsRadarModal
          isOpen={props.sanctionsRadarOpen}
          onClose={props.onCloseSanctionsRadar}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.knowledgeGraphOpen && (
        <KnowledgeGraphModal
          isOpen={props.knowledgeGraphOpen}
          onClose={props.onCloseKnowledgeGraph}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.horizonScannerOpen && (
        <HorizonScannerModal
          isOpen={props.horizonScannerOpen}
          onClose={props.onCloseHorizonScanner}
          articles={articles}
          preferredVoice={preferredVoice}
        />
      )}

      {props.voiceDebriefOpen && (
        <VoiceDebriefModal
          isOpen={props.voiceDebriefOpen}
          onClose={props.onCloseVoiceDebrief}
          articles={articles}
          marketContext={
            dashboardBriefing?.marketGlance
              ? `${dashboardBriefing.marketGlance.name} (${dashboardBriefing.marketGlance.symbol}) ${dashboardBriefing.marketGlance.percentChange >= 0 ? "+" : ""}${dashboardBriefing.marketGlance.percentChange}%`
              : ""
          }
          preferredVoice={preferredVoice}
        />
      )}

      {props.geopoliticalTransitOpen && (
        <GeopoliticalTransitModal
          isOpen={props.geopoliticalTransitOpen}
          onClose={props.onCloseGeopoliticalTransit}
          articles={articles}
          initialChokepointId={suiteFocusEntityId || undefined}
        />
      )}

      {props.boardSparringOpen && (
        <BoardSparringModal
          isOpen={props.boardSparringOpen}
          onClose={props.onCloseBoardSparring}
        />
      )}

      {props.tariffMatrixOpen && (
        <TariffMatrixModal
          isOpen={props.tariffMatrixOpen}
          onClose={props.onCloseTariffMatrix}
        />
      )}

      {props.briefingStudioOpen && (
        <BriefingStudioModal
          isOpen={props.briefingStudioOpen}
          onClose={props.onCloseBriefingStudio}
          articles={articles}
        />
      )}

      {props.signalCortexOpen && (
        <SignalCortexModal
          isOpen={props.signalCortexOpen}
          onClose={props.onCloseSignalCortex}
          articles={articles}
          onOpenSuite={(suiteId, focusId) => {
            props.onCloseSignalCortex();
            onOpenSuite(suiteId, focusId);
          }}
        />
      )}

      {props.dailyCastOpen && (
        <DailyCastModal
          isOpen={props.dailyCastOpen}
          onClose={props.onCloseDailyCast}
          articles={articles}
        />
      )}

      {props.sovereignRiskOpen && (
        <SovereignRiskModal
          isOpen={props.sovereignRiskOpen}
          onClose={props.onCloseSovereignRisk}
          initialEconomyId={suiteFocusEntityId || undefined}
        />
      )}

      {props.preMortemOpen && (
        <PreMortemModal
          isOpen={props.preMortemOpen}
          onClose={props.onClosePreMortem}
          initialInitiativeId={suiteFocusEntityId || undefined}
        />
      )}

      {props.tripwiresOpen && (
        <ExecutiveTripwiresModal
          isOpen={props.tripwiresOpen}
          onClose={props.onCloseTripwires}
          articles={articles}
          onOpenSuite={(suiteId, focusId) => {
            props.onCloseTripwires();
            onOpenSuite(suiteId, focusId);
          }}
        />
      )}
    </Suspense>
  );
}
