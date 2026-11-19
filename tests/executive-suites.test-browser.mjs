import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");

const SAMPLE_ARTICLES = [
  {
    title: "Suez Canal Red Sea transit disrupted as freight rates spike",
    url: "https://example.com/red-sea-transit",
    source: "Lloyd's List",
    publishedAt: new Date().toISOString(),
    summary: "Container ships divert around the Cape of Good Hope after Bab el-Mandeb security incidents.",
    topics: ["Logistics", "Global Markets"],
    providers: ["google"],
  },
  {
    title: "Egypt pound devaluation liquidity stress forces IMF repatriation review",
    url: "https://example.com/egypt-fx",
    source: "Financial Times",
    publishedAt: new Date().toISOString(),
    summary: "Multinationals face FX queue delays and capital control haircuts in Cairo.",
    topics: ["Global Markets"],
    providers: ["google"],
  },
  {
    title: "AI cloud vendor lock-in drives latency spike across APAC data centers",
    url: "https://example.com/ai-cloud-ewi",
    source: "Reuters",
    publishedAt: new Date().toISOString(),
    summary: "Inference cluster compute shortages trigger enterprise fallback plans.",
    topics: ["Technology"],
    providers: ["google"],
  },
];

const ARCHIVE_ARTICLE = {
  title: "Archived shipping routes reopen after port negotiations",
  url: "https://example.com/archived-shipping-routes",
  source: "Lloyd's List",
  publishedAt: "2024-11-03T12:00:00Z",
  summary: "Shipping schedules return to normal.",
  matchedTopics: ["Logistics"],
};

function createTinyWavBuffer(seconds = 1) {
  const wav = Buffer.alloc(44 + 16000 * 2 * seconds);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

const server = await createServer({
  configFile: false,
  root: path.resolve(process.cwd(), "iis-client"),
  publicDir: path.resolve(process.cwd(), "public"),
  plugins: [react()],
  optimizeDeps: {
    noDiscovery: true,
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  server: {
    host: "127.0.0.1",
    port: 3018,
    strictPort: true,
    fs: { allow: [process.cwd()] },
    watch: {
      ignored: ["**/work/**", "**/Signal.Server/wwwroot/**", "**/iis-publish/**"],
    },
  },
});

await server.listen();
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}),
  });

  const telemetry = {
    dateSearches: [],
    createdApiKeys: [],
    revokedApiKeys: [],
    cortexRequests: [],
    dailyCastRequests: [],
    dailyCastAudioRequested: false,
    interrogateRequests: [],
    audioStreamCreates: [],
    audioStreamFetches: 0,
    sovereignAssessRequests: [],
    preMortemRequests: [],
    tripwireEvaluateRequests: [],
    tripwireSavedHeaders: [],
    tripwires: [],
  };

  async function installApiRoutes(context) {
    let apiKey = null;
    await context.route("http://127.0.0.1:3018/api/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const pathname = url.pathname;
      const method = req.method();
      if (!pathname.startsWith("/api/")) {
        return route.continue();
      }

      if (pathname === "/api/auth/me") {
        return route.fulfill({
          json: {
            email: "exec@signal.local",
            displayName: "Executive Brief",
            profilePhotoUrl: null,
            googleConnected: false,
            hasPassword: true,
          },
        });
      }
      if (pathname === "/api/auth/csrf") {
        return route.fulfill({ json: { token: "csrf-e2e-token" } });
      }
      if (pathname === "/api/auth/providers") {
        return route.fulfill({ json: { google: false } });
      }
      if (pathname === "/api/app-version") {
        return route.fulfill({ json: { version: "e2e" } });
      }
      if (pathname === "/api/preferences") {
        return route.fulfill({
          json: {
            exists: true,
            preferences: {
              topics: ["Logistics", "Global Markets", "Technology"],
              limit: 15,
              storyTitleSize: "medium",
              topicHeaderSize: "medium",
              showTopicFiltersWhenPinned: true,
              showSourceFiltersWhenPinned: true,
              refreshMinutes: 15,
              emailSummaryEnabled: false,
              pushNewsTitlesEnabled: false,
              articleRetentionDays: 30,
              tickerOverrides: {},
              weatherLocation: null,
              secondaryTimeZone: null,
              trendRegions: [],
              trendsPerRegion: 5,
              sources: { google: true, gdelt: false, rssFeeds: [] },
            },
          },
        });
      }
      if (pathname === "/api/news") {
        if (url.searchParams.has("from") && url.searchParams.has("to")) {
          const search = Object.fromEntries(url.searchParams);
          telemetry.dateSearches.push(search);
          const covered = Date.parse(search.from) <= Date.parse(ARCHIVE_ARTICLE.publishedAt)
            && Date.parse(search.to) >= Date.parse(ARCHIVE_ARTICLE.publishedAt);
          return route.fulfill({ json: {
            articles: covered && search.topic === "Logistics" ? [ARCHIVE_ARTICLE] : [],
            topic: search.topic,
            provider: search.provider,
            fetchedAt: new Date().toISOString(),
          } });
        }
        return route.fulfill({
          json: {
            articles: SAMPLE_ARTICLES,
            provider: "google",
            fetchedAt: new Date().toISOString(),
          },
        });
      }
      if (pathname === "/api/api-keys") {
        if (method === "POST") {
          const request = req.postDataJSON();
          telemetry.createdApiKeys.push({ ...request, csrf: req.headers()["x-xsrf-token"] });
          apiKey = {
            id: "test-key", name: request.name, keyPrefix: "signal_fixture", scopes: request.scopes,
            createdAt: new Date().toISOString(), expiresAt: null, isExpired: false,
          };
          return route.fulfill({ status: 201, json: { apiKey, key: "signal_fixture_for_browser_test" } });
        }
        return route.fulfill({ json: { keys: apiKey ? [apiKey] : [], maxActiveKeys: 10 } });
      }
      if (pathname === "/api/api-keys/test-key" && method === "DELETE") {
        telemetry.revokedApiKeys.push(req.headers()["x-xsrf-token"]);
        apiKey = null;
        return route.fulfill({ status: 204 });
      }
      if (pathname === "/api/social") {
        return route.fulfill({
          json: { friends: [], incomingRequests: [], outgoingRequests: [], unreadMessages: 0 },
        });
      }
      if (pathname === "/api/comments/latest") {
        return route.fulfill({ json: { comments: [], newCount: 0 } });
      }
      if (pathname === "/api/articles" || pathname === "/api/articles/sync") {
        return route.fulfill({
          json: {
            articles: [],
            historyTotal: 0,
            bookmarkTotal: 0,
            matchingTotal: 0,
            filterTotal: 0,
            hasMore: false,
            bookmarkedUrls: [],
            readUrls: [],
            topicFacets: [],
            providerFacets: [],
          },
        });
      }
      if (pathname === "/api/topic-refresh") {
        const nowIso = new Date().toISOString();
        return route.fulfill({
          json: {
            articles: SAMPLE_ARTICLES,
            topics: ["Logistics", "Global Markets", "Technology"].map((topic) => ({
              topic,
              lastAttemptedAt: nowIso,
              lastSuccessfulAt: nowIso,
              nextRefreshAt: nowIso,
              lastViewedAt: null,
              hasUnread: true,
              lastError: "",
            })),
            refreshedAt: nowIso,
            historyTotal: SAMPLE_ARTICLES.length,
            bookmarkTotal: 0,
          },
        });
      }
      if (pathname === "/api/earthquakes") {
        return route.fulfill({ json: { earthquakes: [] } });
      }
      if (pathname === "/api/market-quotes") {
        return route.fulfill({
          json: { quotes: [{ symbol: "EGPT", name: "MSCI Egypt Proxy", price: 24.15, percentChange: -3.2 }] },
        });
      }

      if (pathname === "/api/cortex/search" && method === "POST") {
        const body = req.postDataJSON() || {};
        telemetry.cortexRequests.push(body);
        const q = (body.query || "").toString().trim().toLowerCase();
        return route.fulfill({
          json: {
            query: body.query || "",
            synthesizedAnswer: q.includes("suez") || q.includes("egypt")
              ? "Live wire corroborates Red Sea / Bab el-Mandeb diversions alongside Egypt FX liquidity pressure."
              : "Cross-suite intelligence initialized across live wires and 28 executive suites.",
            confidence: 0.95,
            suggestedQueries: ["egypt", "suez", "ai cloud"],
            crossDomainHits: [
              {
                id: "hit-live-1",
                domain: "live-wire",
                title: SAMPLE_ARTICLES[0].title,
                snippet: SAMPLE_ARTICLES[0].summary,
                url: SAMPLE_ARTICLES[0].url,
                relevanceScore: 0.97,
                targetSuiteId: "geopolitical-transit",
              },
              {
                id: "hit-sovereign-1",
                domain: "sovereign",
                title: "Egypt Sovereign Risk & Repatriation Queue",
                snippet: "Elevated FX depreciation velocity & capital repatriation haircut modeling.",
                relevanceScore: 0.94,
                targetSuiteId: "sovereign-risk",
              },
            ],
          },
        });
      }

      if (pathname === "/api/daily-cast/episodes") {
        return route.fulfill({
          json: [
            { id: "live-wire", title: "Live Wire Synthesis", category: "Live Feed", description: "Grounded in live feed" },
            { id: "macro-divergence", title: "Macro & Rates Divergence", category: "Macro", description: "Central banks & FX" },
          ],
        });
      }
      if (pathname === "/api/daily-cast/audio-status") {
        return route.fulfill({ json: { neuralAvailable: true, requiresAuth: false, authenticated: true } });
      }
      if (pathname === "/api/daily-cast/synthesize" && method === "POST") {
        const body = req.postDataJSON() || {};
        telemetry.dailyCastRequests.push(body);
        const topicId = body.episodeTopic || body.topicId || "live-wire";
        const isLive = topicId === "live-wire";
        return route.fulfill({
          json: {
            episodeId: topicId,
            episodeTitle: isLive ? "Live Wire Executive Cast" : "Macro & Rates Divergence",
            showNotes: "Grounded executive audio cast across active global wire signals.",
            totalDurationSeconds: 180,
            chapters: [
              { timestampSeconds: 0, title: "Live Wire & Suez Rerouting" },
              { timestampSeconds: 90, title: "Egypt FX Liquidity Review" },
            ],
            dialogTurns: [
              {
                turnIndex: 0,
                speaker: "david",
                speakerName: "David Vance",
                speakerRole: "Chief Macro Strategist",
                avatarEmoji: "🎙️",
                text: isLive
                  ? "Starting with today's live wire: Red Sea diversions and Egypt FX liquidity squeeze are moving landed margin assumptions."
                  : "Rates divergence across global central banks continues to pressure import-heavy sovereigns.",
                durationSeconds: 14,
              },
              {
                turnIndex: 1,
                speaker: "sarah",
                speakerName: "Sarah Chen",
                speakerRole: "Geopolitical & Deep Tech Lead",
                avatarEmoji: "🎧",
                text: isLive
                  ? "And across APAC cloud infrastructure, latency spikes show why secondary inference capacity matters."
                  : "Supply chains near maritime chokepoints mirror those capital flight stresses.",
                durationSeconds: 14,
              },
            ],
            synthesizedAt: new Date().toISOString(),
            liveArticleCount: Array.isArray(body.articles) ? body.articles.length : 0,
            neuralAudioAvailable: true,
          },
        });
      }
      if (pathname === "/api/daily-cast/audio" && method === "POST") {
        telemetry.dailyCastAudioRequested = true;
        return route.fulfill({
          status: 200,
          contentType: "audio/wav",
          headers: { "X-Signal-Cast-Starts": "0,0.4" },
          body: createTinyWavBuffer(),
        });
      }

      if (pathname === "/api/sovereign-risk/economies") {
        return route.fulfill({
          json: [
            {
              id: "argentina",
              name: "Argentina",
              currencyCode: "ARS",
              sovereignRiskScore: 86,
              cdsSpreadBps: 1450,
              fx30dDepreciationVelocityPercent: -12.4,
              foreignReservesCoverMonths: 1.8,
              capitalControlStatus: "Strict (FX Rationing & SIRA Controls)",
              repatriationHaircutPercent: 32,
              macroBrief: "Parallel FX gap and import payment rationing.",
            },
            {
              id: "egypt",
              name: "Egypt",
              currencyCode: "EGP",
              sovereignRiskScore: 76,
              cdsSpreadBps: 685,
              fx30dDepreciationVelocityPercent: -8.5,
              foreignReservesCoverMonths: 3.1,
              capitalControlStatus: "Controlled (FX Queue & repatriation scrutiny)",
              repatriationHaircutPercent: 19,
              macroBrief: "Suez FX inflows compressed while IMF review tracks hard-currency liquidity.",
            },
          ],
        });
      }
      if (pathname === "/api/sovereign-risk/assess" && method === "POST") {
        const body = req.postDataJSON() || {};
        telemetry.sovereignAssessRequests.push(body);
        const id = (body.economyId || "argentina").toLowerCase();
        const exposure = Number(body.corporateExposureUsd || 10000000);
        const haircut = id === "egypt" ? 19 : 32;
        const lossM = ((exposure * (haircut / 100)) / 1_000_000).toFixed(2);
        return route.fulfill({
          json: {
            economyId: id,
            economyName: id === "egypt" ? "Egypt" : "Argentina",
            currencyCode: id === "egypt" ? "EGP" : "ARS",
            sovereignRiskScore: id === "egypt" ? 76 : 86,
            cdsSpreadBps: id === "egypt" ? 685 : 1450,
            fx30dDepreciationVelocityPercent: id === "egypt" ? -8.5 : -12.4,
            foreignReservesCoverMonths: id === "egypt" ? 3.1 : 1.8,
            capitalControlStatus: id === "egypt" ? "Controlled (FX Queue)" : "Strict (FX Rationing)",
            repatriationHaircutPercent: haircut,
            estimatedExposureLossUsd: `$${lossM}M`,
            treasuryActionPlaybooks: [
              "Sweep excess onshore cash weekly into hard-currency trade payables.",
            ],
            correlatedSignals: [
              {
                signalType: "Market Proxy",
                title: "EGPT equity ETF down -3.2% across session",
                source: "Market Data",
              },
              {
                signalType: "Live Feed",
                title: SAMPLE_ARTICLES[1].title,
                source: SAMPLE_ARTICLES[1].source,
                url: SAMPLE_ARTICLES[1].url,
              },
            ],
            dataSource: "Signal Live Intelligence + Market Data",
          },
        });
      }

      if (pathname === "/api/pre-mortem/initiatives") {
        return route.fulfill({
          json: [
            {
              id: "ai-cloud-migration",
              title: "Enterprise AI Cloud & Inference Consolidation",
              category: "Digital Infrastructure",
              capitalAtStakeUsd: "$42M",
              baselineRiskScore: 68,
            },
            {
              id: "global-erp-rollout",
              title: "Multi-Region Treasury & ERP Cutover",
              category: "Operations",
              capitalAtStakeUsd: "$28M",
              baselineRiskScore: 54,
            },
          ],
        });
      }
      if (pathname === "/api/pre-mortem/simulate" && method === "POST") {
        const body = req.postDataJSON() || {};
        telemetry.preMortemRequests.push(body);
        const months = Number(body.horizonMonths || 18);
        const isErp = body.initiativeId === "global-erp-rollout";
        const prob = Math.min(95, (isErp ? 48 : 62) + Math.round(months / 3));
        return route.fulfill({
          json: {
            initiativeId: body.initiativeId || "ai-cloud-migration",
            initiativeTitle: isErp ? "Multi-Region Treasury & ERP Cutover" : "Enterprise AI Cloud & Inference Consolidation",
            horizonMonths: months,
            overallFatalityProbabilityPercent: prob,
            executiveSummaryAutopsy: `Over +${months} months, cascading dependency concentration triggered critical SLA failure.`,
            boardRecommendation: "Establish dual-region cold standby before capital tranche two.",
            liveRiskSignals: [
              {
                title: SAMPLE_ARTICLES[2].title,
                source: SAMPLE_ARTICLES[2].source,
                matchedVector: "Vendor Concentration",
              },
            ],
            collapseVectors: [
              {
                vectorId: "vec-1",
                name: "Single-Region Latency Cascade",
                severity: "Critical",
                failureMechanism: "Regional GPU capacity exhaustion degrades inference SLAs beyond contractual caps.",
                earlyWarningIndicators: ["latency spike", "capacity rationing"],
                preemptiveHedgingDirective: "Provision secondary sovereign-compliant inference region.",
              },
            ],
          },
        });
      }

      if (pathname === "/api/tripwires" && method === "GET") {
        return route.fulfill({
          json: {
            authenticated: true,
            tripwires: telemetry.tripwires,
            presets: [
              {
                id: "preset-red-sea-chokepoint",
                name: "Red Sea & Suez Diversion Alert",
                keywords: ["red sea", "suez", "bab el-mandeb"],
                targetSuiteId: "geopolitical-transit",
                targetEntityId: "red-sea",
                severity: "Critical",
                enabled: true,
                pushOnMatch: true,
                triggerCount: 0,
                deepLinkUrl: "/?suite=geopolitical-transit&focus=red-sea",
              },
            ],
          },
        });
      }
      if (pathname === "/api/tripwires" && method === "POST") {
        const xsrf = req.headers()["x-xsrf-token"] || "";
        telemetry.tripwireSavedHeaders.push(xsrf);
        assert.equal(xsrf, "csrf-e2e-token", "POST /api/tripwires must include X-XSRF-TOKEN header");
        const body = req.postDataJSON() || {};
        const created = {
          id: `tw-${telemetry.tripwires.length + 1}`,
          name: body.name,
          keywords: body.keywords || [],
          targetSuiteId: body.targetSuiteId || "sovereign-risk",
          targetEntityId: body.targetEntityId || "",
          severity: body.severity || "Critical",
          enabled: body.enabled ?? true,
          pushOnMatch: body.pushOnMatch ?? true,
          triggerCount: 1,
          deepLinkUrl: `/?suite=${encodeURIComponent(body.targetSuiteId || "sovereign-risk")}${body.targetEntityId ? `&focus=${encodeURIComponent(body.targetEntityId)}` : ""}`,
        };
        telemetry.tripwires.unshift(created);
        return route.fulfill({ json: created });
      }
      if (pathname.startsWith("/api/tripwires/") && method === "DELETE") {
        const id = pathname.split("/").pop();
        telemetry.tripwires = telemetry.tripwires.filter((t) => t.id !== id);
        return route.fulfill({ json: { deleted: true } });
      }
      if (pathname === "/api/tripwires/evaluate" && method === "POST") {
        const body = req.postDataJSON() || {};
        telemetry.tripwireEvaluateRequests.push(body);
        const rules = telemetry.tripwires.length > 0 ? telemetry.tripwires : (body.rules || []);
        const articles = Array.isArray(body.articles) && body.articles.length > 0 ? body.articles : SAMPLE_ARTICLES;
        const matches = [];
        for (const rule of rules) {
          for (const art of articles) {
            const hay = `${art.title} ${art.summary || ""}`.toLowerCase();
            const hitKws = (rule.keywords || []).filter((kw) => hay.includes(kw.toLowerCase()));
            if (hitKws.length > 0) {
              matches.push({
                tripwireId: rule.id || "preset",
                tripwireName: rule.name,
                severity: rule.severity || "Critical",
                targetSuiteId: rule.targetSuiteId,
                targetEntityId: rule.targetEntityId || "",
                deepLinkUrl: rule.deepLinkUrl || `/?suite=${rule.targetSuiteId}`,
                matchedTitle: art.title,
                matchedSource: art.source || "Signal",
                matchedUrl: art.url || "",
                matchedKeywords: hitKws,
              });
              break;
            }
          }
        }
        return route.fulfill({
          json: {
            evaluatedRules: rules.length,
            evaluatedArticles: articles.length,
            matches,
          },
        });
      }

      if (pathname === "/api/article-reader/interrogate" && method === "POST") {
        const body = req.postDataJSON() || {};
        telemetry.interrogateRequests.push(body);
        return route.fulfill({
          json: {
            available: true,
            question: body.question || "",
            answer: `Socratic analysis for ${body.title || "story"}: Red Sea diversions shift carrier routing costs without independent freight rate audits.`,
            supportingEvidence: ["Container ships divert around the Cape of Good Hope."],
            omittedPerspectives: ["Independent insurer war-risk premium quotes were omitted."],
            stakeholderImpact: "Exporters face extended transit buffers and working capital strain.",
            mode: "socratic-analytical",
          },
        });
      }

      if (pathname === "/api/article-audio-stream" && method === "POST") {
        const body = req.postDataJSON() || {};
        telemetry.audioStreamCreates.push(body);
        const streamId = "0123456789abcdef0123456789abcdef";
        return route.fulfill({
          json: {
            url: `/api/article-audio-stream/${streamId}`,
            statusUrl: `/api/article-audio-stream/${streamId}/status`,
            status: { starts: [0], complete: true, duration: 5, error: null },
          },
        });
      }

      if (pathname === "/api/article-audio-stream/0123456789abcdef0123456789abcdef/status" && method === "GET") {
        return route.fulfill({
          json: { starts: [0], complete: true, duration: 5, error: null },
        });
      }

      if (pathname === "/api/article-audio-stream/0123456789abcdef0123456789abcdef" && method === "GET") {
        telemetry.audioStreamFetches += 1;
        return route.fulfill({
          status: 200,
          contentType: "audio/wav",
          body: createTinyWavBuffer(5),
        });
      }

      return route.fulfill({ json: {} });
    });
  }

  // =========================================================================
  // 1. Desktop E2E Flow (1280x800)
  // =========================================================================
  const desktopContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: "block",
  });
  await desktopContext.addInitScript(() => {
    localStorage.setItem("signal.weather-audio-on-open.v1", "false");
  });
  await installApiRoutes(desktopContext);

  const page = await desktopContext.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(25_000);
  const desktopErrors = [];
  page.on("pageerror", (err) => {
    console.error("PAGEERROR:", err.message);
    desktopErrors.push(err.message);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("BROWSER CONSOLE ERROR:", msg.text());
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("/api/")) {
      console.error(`HTTP ${res.status()} on ${res.url()}`);
    }
  });

  const baseUrl = "http://127.0.0.1:3018";
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  try {
    await page.getByText(SAMPLE_ARTICLES[0].title).waitFor();
  } catch (err) {
    console.error("DOM SNAPSHOT:", await page.evaluate(() => document.body.innerText.slice(0, 600)));
    throw err;
  }

  // News Page Story Interrogate modal: opens styled fixed overlay without opening Daily Briefing, auto-loads Socratic analysis, plays Azure Neural readout
  await page.getByRole("button", { name: `Interrogate story: ${SAMPLE_ARTICLES[0].title}`, exact: true }).click();
  const interrogateDialog = page.getByRole("dialog", { name: SAMPLE_ARTICLES[0].title });
  await interrogateDialog.waitFor();
  const interrogatePosition = await interrogateDialog.evaluate((el) => getComputedStyle(el).position);
  assert.equal(interrogatePosition, "fixed", "Interrogate modal overlay must render as fixed dialog without DailyBriefingModal mounted");
  await interrogateDialog.getByText(/Socratic analysis for/i).waitFor();
  assert.ok(telemetry.interrogateRequests.length >= 1, "Opening Interrogate modal must immediately submit initial Socratic query");
  await interrogateDialog.getByRole("button", { name: /Listen via Azure Neural/i }).click();
  await interrogateDialog.getByRole("button", { name: /Stop Azure Voice/i }).waitFor();
  await page.waitForTimeout(150);
  assert.equal(
    await interrogateDialog.getByRole("button", { name: /Stop Azure Voice/i }).isVisible(),
    true,
    "Interrogate audio playback must stay active across renders"
  );
  await interrogateDialog.getByRole("button", { name: "Close interrogation", exact: true }).click();
  await interrogateDialog.waitFor({ state: "detached" });

  // News Page Soundbite Audiogram modal: opens and streams audio continuously without useEffect cleanup pausing it
  await page.getByRole("button", { name: `Clip soundbite audiogram for ${SAMPLE_ARTICLES[0].title}`, exact: true }).click();
  const audiogramDialog = page.getByRole("dialog", { name: /Generate Audiogram & Quote Card/i });
  await audiogramDialog.waitFor();
  await audiogramDialog.getByRole("button", { name: /Listen to Clip/i }).click();
  await audiogramDialog.getByRole("button", { name: /Stop Voice/i }).waitFor();
  await page.waitForTimeout(150);
  assert.equal(
    await audiogramDialog.getByRole("button", { name: /Stop Voice/i }).isVisible(),
    true,
    "Soundbite audio playback must stay active and not be immediately paused by canvas animation cleanup"
  );
  assert.ok(telemetry.audioStreamCreates.length >= 2, "Interrogate and Soundbite must both request /api/article-audio-stream");
  assert.ok(telemetry.audioStreamFetches >= 2, "Audio elements must actually fetch streamed WAV audio");
  await audiogramDialog.getByRole("button", { name: "Close Audiogram Clipper", exact: true }).click();
  await audiogramDialog.waitFor({ state: "detached" });

  await page.locator(".topic-filters-toggle").click();
  const topicFilters = page.getByRole("navigation", { name: "Filter stories by followed topic" });
  await topicFilters.getByRole("button", { name: /^Logistics\b/ }).click();
  await page.getByRole("button", { name: "Date range", exact: true }).click();
  const dates = page.getByRole("form", { name: "Search topic by date" });
  await dates.getByLabel("From date").fill("2024-11-04");
  await dates.getByLabel("To date").fill("2024-11-02");
  await dates.getByRole("button", { name: "Search dates" }).click();
  await dates.getByRole("alert").getByText("Choose an end date on or after the start date.").waitFor();
  assert.equal(telemetry.dateSearches.length, 0);
  await dates.getByLabel("From date").fill("2024-11-03");
  await dates.getByLabel("To date").fill("2024-11-04");
  await dates.getByRole("button", { name: "Search dates" }).click();
  await page.getByText(ARCHIVE_ARTICLE.title).waitFor();
  const firstSearch = telemetry.dateSearches[0];
  assert.equal(firstSearch.topic, "Logistics");
  assert.equal(firstSearch.provider, "google");
  const localBounds = await page.evaluate(() => [
    new Date("2024-11-03T00:00:00").toISOString(), new Date("2024-11-04T23:59:59.999").toISOString(),
  ]);
  assert.deepEqual([firstSearch.from, firstSearch.to], localBounds);
  assert.equal(await page.getByText(SAMPLE_ARTICLES[0].title).isVisible(), false);
  await dates.getByLabel("From date").fill("2024-11-10");
  await dates.getByLabel("To date").fill("2024-11-11");
  await dates.getByRole("button", { name: "Search dates" }).click();
  await page.getByRole("heading", { name: "No stories found in this date range." }).waitFor();
  await dates.getByRole("button", { name: "Clear dates" }).click();
  await page.getByText(SAMPLE_ARTICLES[0].title).waitFor();
  await topicFilters.getByRole("button", { name: /^All \d/ }).click();

  await page.getByRole("button", { name: "Account", exact: true }).click();
  const apiAccess = page.getByRole("region", { name: "API access" });
  await apiAccess.getByLabel("API key name").fill("Browser smoke test");
  await apiAccess.getByLabel("API key expiration").selectOption("30");
  await apiAccess.getByRole("button", { name: "Create key" }).click();
  const secret = apiAccess.getByLabel("Newly created API key");
  await secret.waitFor();
  assert.equal(await secret.inputValue(), "signal_fixture_for_browser_test");
  assert.deepEqual(telemetry.createdApiKeys, [{
    name: "Browser smoke test", expiresInDays: 30, scopes: ["news:read"], csrf: "csrf-e2e-token",
  }]);
  await apiAccess.getByRole("button", { name: "Revoke", exact: true }).click();
  await secret.waitFor({ state: "detached" });
  await apiAccess.getByText("No API keys created yet.").waitFor();
  assert.deepEqual(telemetry.revokedApiKeys, ["csrf-e2e-token"]);
  await page.getByRole("button", { name: "Close account settings" }).click();

  // Command Center -> 28 badge -> Search "tripwires" -> Open Executive Tripwires
  const hubBtn = page.getByRole("button", { name: "Open Executive Command Center", exact: true });
  await hubBtn.waitFor();
  assert.equal((await hubBtn.locator(".command-center-trigger-badge").textContent())?.trim(), "28");
  await hubBtn.click();

  await page.getByRole("dialog", { name: "Executive Intelligence Command Center" }).waitFor();
  await page.getByText("28 Executive Intelligence Suites Active").waitFor();
  await page.getByLabel("Search intelligence suites").fill("tripwires");
  await page.getByText("Executive Tripwires & Alerts").click();

  // Executive Tripwires: scan live articles, arm a custom rule, verify CSRF header & deep link jump
  await page.getByRole("dialog", { name: /Executive Tripwires/i }).waitFor();
  await page.locator("#tw-name").fill("Egypt Liquidity Watch");
  await page.locator("#tw-keywords").fill("egypt, devaluation");
  await page.locator("#tw-suite").selectOption("sovereign-risk");
  await page.locator("#tw-focus").fill("egypt");
  await page.getByRole("button", { name: "+ Arm Executive Tripwire", exact: true }).click();
  await page.getByText("Egypt Liquidity Watch").first().waitFor();
  assert.ok(
    telemetry.tripwireEvaluateRequests.some((r) => Array.isArray(r.articles) && r.articles.length >= 3),
    "Tripwire evaluator must submit loaded live articles"
  );

  // Close Tripwires via Esc
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: /Executive Tripwires/i }).waitFor({ state: "detached" });

  // Ctrl+J opens Signal Cortex, submits live articles on search, jumps to Straits Watch
  await page.locator(".site-header").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+j");
  await page.getByLabel("Query Signal Cortex").waitFor();
  await page.getByLabel("Query Signal Cortex").fill("suez red sea");
  await page.getByText("Red Sea / Bab el-Mandeb", { exact: false }).first().waitFor();
  assert.ok(
    telemetry.cortexRequests.some((req) => Array.isArray(req.articles) && req.articles.length >= 3),
    "Signal Cortex must send client articles array to /api/cortex/search"
  );
  await page.getByRole("button", { name: /Open in geopolitical-transit/i }).click();
  await page.getByRole("dialog", { name: /Signal Sky & Sea|Geopolitical Transit/i }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: /Signal Sky & Sea|Geopolitical Transit/i }).waitFor({ state: "detached" });

  // Daily Cast -> opens Live Wire with client articles -> plays Azure Neural WAV -> Download .wav appears -> switch tab
  await hubBtn.click();
  await page.getByLabel("Search intelligence suites").fill("daily cast");
  await page.getByText("Signal Studio Daily Cast").click();
  await page.getByRole("dialog", { name: /Signal Studio Daily Cast/i }).waitFor();
  await page.getByText(/Live Wire Grounded/i).waitFor();
  assert.ok(
    telemetry.dailyCastRequests.some((req) => req.episodeTopic === "live-wire" && Array.isArray(req.articles) && req.articles.length >= 3),
    "Daily Cast must synthesize live-wire grounded in live articles"
  );
  await page.getByRole("button", { name: /Play Daily Cast/i }).click();
  await page.getByRole("button", { name: /Pause Cast/i }).waitFor();
  await page.getByRole("link", { name: /Download \.wav/i }).waitFor();
  assert.equal(telemetry.dailyCastAudioRequested, true, "Daily Cast must request POST /api/daily-cast/audio");
  await page.getByRole("button", { name: /Macro & Rates Divergence/i }).click();
  await page.getByText(/central banks continues/i).waitFor();
  await page.getByRole("button", { name: "Close Daily Cast", exact: true }).click();

  // Direct Deep-Link Navigation: /?suite=sovereign-risk&focus=egypt
  await page.goto(`${baseUrl}/?suite=sovereign-risk&focus=egypt`, { waitUntil: "domcontentloaded" });
  const sovereignDialog = page.getByRole("dialog", { name: "Sovereign Risk & Currency Crisis Radar" });
  await sovereignDialog.waitFor();
  const egyptTab = sovereignDialog.getByRole("tab", { name: /Egypt/i });
  assert.equal(await egyptTab.getAttribute("aria-selected"), "true", "Deep-link focus=egypt must select Egypt tab");
  await page.getByText(/EGPT equity ETF down/i).waitFor();
  await sovereignDialog.getByLabel("Corporate Exposure in USD").fill("50000000");
  await sovereignDialog.getByLabel("Corporate Exposure in USD").dispatchEvent("change");
  await page.getByText("Est. Capital Loss: $9.50M (19%)").waitFor();
  await page.getByRole("button", { name: "Close Sovereign Risk Radar", exact: true }).click();

  // Pre-Mortem -> switch initiative + adjust horizon slider
  await hubBtn.click();
  await page.getByLabel("Search intelligence suites").fill("pre-mortem");
  await page.getByText("Corporate Pre-Mortem Simulator").click();
  const preMortemDialog = page.getByRole("dialog", { name: "Corporate Pre-Mortem Simulator" });
  await preMortemDialog.waitFor();
  await page.getByText(/Live EWI Wire Matches/i).waitFor();
  await preMortemDialog.getByRole("button", { name: /Multi-Region Treasury & ERP Cutover/i }).click();
  await preMortemDialog.getByLabel("Failure Horizon in Months").fill("36");
  await preMortemDialog.getByLabel("Failure Horizon in Months").dispatchEvent("change");
  await page.getByText("+36 Months", { exact: true }).waitFor();
  assert.ok(
    telemetry.preMortemRequests.some((req) => req.initiativeId === "global-erp-rollout" && Number(req.horizonMonths) === 36),
    "Pre-Mortem must trigger updated simulation request"
  );
  await page.getByRole("button", { name: "Close Pre-Mortem Simulator", exact: true }).click();

  assert.deepEqual(desktopErrors, [], `Desktop uncaught page errors: ${desktopErrors.join("; ")}`);
  await desktopContext.close();
  console.log("PASS desktop E2E: Command Center (28), Tripwires, Cortex Ctrl+J + articles, Daily Cast Live Wire + WAV, ?suite=sovereign-risk&focus=egypt, Pre-Mortem");

  // =========================================================================
  // 2. Mobile Regression Flow (390x844, hasTouch: true, Zero Horizontal Overflow)
  // =========================================================================
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36",
  });
  await mobileContext.addInitScript(() => {
    localStorage.setItem("signal.weather-audio-on-open.v1", "false");
  });
  await installApiRoutes(mobileContext);

  const mobilePage = await mobileContext.newPage();
  mobilePage.setDefaultNavigationTimeout(120_000);
  mobilePage.setDefaultTimeout(60_000);
  const mobileErrors = [];
  mobilePage.on("pageerror", (err) => mobileErrors.push(err.message));

  async function assertNoHorizontalOverflow(label) {
    const metrics = await mobilePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(
      metrics.scrollWidth <= metrics.innerWidth,
      `${label}: horizontal overflow detected on mobile (${metrics.scrollWidth}px > ${metrics.innerWidth}px)`
    );
  }

  await mobilePage.goto(`${baseUrl}/?suite=sovereign-risk&focus=egypt`, { waitUntil: "domcontentloaded" });
  await mobilePage.getByRole("dialog", { name: "Sovereign Risk & Currency Crisis Radar" }).waitFor();
  await assertNoHorizontalOverflow("Sovereign Risk Modal (Mobile)");
  await mobilePage.getByRole("button", { name: "Close Sovereign Risk Radar", exact: true }).click();

  const mobileHubBtn = mobilePage.getByRole("button", { name: "Open Executive Command Center", exact: true });
  await mobileHubBtn.click();
  await mobilePage.getByRole("dialog", { name: "Executive Intelligence Command Center" }).waitFor();
  await assertNoHorizontalOverflow("Executive Command Center (Mobile)");

  await mobilePage.getByLabel("Search intelligence suites").fill("tripwires");
  await mobilePage.getByText("Executive Tripwires & Alerts").click();
  await mobilePage.getByRole("dialog", { name: /Executive Tripwires/i }).waitFor();
  await assertNoHorizontalOverflow("Executive Tripwires Modal (Mobile)");
  await mobilePage.getByRole("button", { name: "Close Executive Tripwires", exact: true }).click();

  await mobileHubBtn.click();
  await mobilePage.getByLabel("Search intelligence suites").fill("signal cortex");
  await mobilePage.getByText("Signal Cortex (Executive Second Brain)").click();
  await mobilePage.getByLabel("Query Signal Cortex").waitFor();
  await assertNoHorizontalOverflow("Signal Cortex Modal (Mobile)");
  await mobilePage.getByRole("button", { name: "Close Signal Cortex", exact: true }).click();

  await mobileHubBtn.click();
  await mobilePage.getByLabel("Search intelligence suites").fill("daily cast");
  await mobilePage.getByText("Signal Studio Daily Cast").click();
  await mobilePage.getByRole("dialog", { name: /Signal Studio Daily Cast/i }).waitFor();
  await assertNoHorizontalOverflow("Daily Cast Modal (Mobile)");
  await mobilePage.getByRole("button", { name: "Close Daily Cast", exact: true }).click();

  await mobileHubBtn.click();
  await mobilePage.getByLabel("Search intelligence suites").fill("pre-mortem");
  await mobilePage.getByText("Corporate Pre-Mortem Simulator").click();
  await mobilePage.getByRole("dialog", { name: "Corporate Pre-Mortem Simulator" }).waitFor();
  await assertNoHorizontalOverflow("Pre-Mortem Modal (Mobile)");

  assert.deepEqual(mobileErrors, [], `Mobile uncaught page errors: ${mobileErrors.join("; ")}`);
  await mobileContext.close();
  console.log("PASS mobile (390x844) E2E: zero horizontal overflow and zero errors across Sovereign Risk, Command Center, Tripwires, Signal Cortex, Daily Cast, and Pre-Mortem");
} finally {
  await browser?.close();
  await server.close();
}
