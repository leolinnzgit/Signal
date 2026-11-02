export interface QuietHoursConfig {
  enabled: boolean;
  startTime: string;
  endTime: string;
  activeDays: string[];
  shockThresholdPercent: number;
  vipEntities: string[];
  pushCrisisOnly: boolean;
}

export interface TriageEvaluationResult {
  isQuietHoursActive: boolean;
  triageAction: "break_through_crisis_alert" | "suppress_to_morning_briefing" | "deliver_standard_notification" | string;
  crisisSeverity: "Crisis" | "Urgent" | "Normal" | string;
  reason: string;
  breakthroughAllowed: boolean;
  evaluatedAt: string;
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: true,
  startTime: "22:00",
  endTime: "06:30",
  activeDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  shockThresholdPercent: 2.5,
  vipEntities: ["RBNZ", "Treasury", "Fonterra", "Air New Zealand", "Reserve Bank"],
  pushCrisisOnly: true,
};

export async function loadQuietHoursConfig(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<QuietHoursConfig> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return loadLocalQuietHoursConfig();
  }

  try {
    const res = await fetcher("/api/quiet-hours/config", {
      credentials: "same-origin",
      signal,
    });
    if (res.ok) {
      const data = await res.json();
      saveLocalQuietHoursConfig(data);
      return data;
    }
    return loadLocalQuietHoursConfig();
  } catch {
    return loadLocalQuietHoursConfig();
  }
}

export async function saveQuietHoursConfig(
  config: QuietHoursConfig,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  saveLocalQuietHoursConfig(config);

  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) return true;

  try {
    let token = "";
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const res = await fetcher("/api/quiet-hours/config", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify(config),
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function evaluateQuietHoursTriage(
  article: { title: string; source: string; summary?: string; priceChangePercent?: number; symbol?: string },
  config?: QuietHoursConfig,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TriageEvaluationResult> {
  const activeConfig = config || loadLocalQuietHoursConfig();
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return evaluateTriageLocally(article, activeConfig);
  }

  try {
    let token = "";
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const res = await fetcher("/api/quiet-hours/evaluate", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        title: article.title,
        source: article.source,
        summary: article.summary,
        priceChangePercent: article.priceChangePercent,
        symbol: article.symbol,
        config: activeConfig,
      }),
      signal,
    });

    if (res.ok) {
      return await res.json();
    }
    return evaluateTriageLocally(article, activeConfig);
  } catch {
    return evaluateTriageLocally(article, activeConfig);
  }
}

export function evaluateTriageLocally(
  article: { title: string; source: string; summary?: string; priceChangePercent?: number; symbol?: string },
  config: QuietHoursConfig,
): TriageEvaluationResult {
  const now = new Date();
  const isQuietHoursActive = isTimeInQuietHours(now, config);

  if (!config.enabled || !isQuietHoursActive) {
    return {
      isQuietHoursActive: false,
      triageAction: "deliver_standard_notification",
      crisisSeverity: "Normal",
      reason: "Quiet hours currently inactive; standard notification rules apply.",
      breakthroughAllowed: true,
      evaluatedAt: now.toISOString(),
    };
  }

  const text = `${article.title} ${article.summary || ""}`.toLowerCase();
  const criticalTerms = [
    "fraud", "halt", "downgrade", "liquidation", "emergency", "fatal",
    "investigation", "probe", "collapse", "court injunction", "insolvent", "cyberattack",
  ];

  const hasCriticalKeyword = criticalTerms.some((term) => text.includes(term));
  const hasMarketShock =
    typeof article.priceChangePercent === "number" &&
    Math.abs(article.priceChangePercent) >= config.shockThresholdPercent;

  const isVip = config.vipEntities.some(
    (vip) =>
      vip &&
      (text.includes(vip.toLowerCase()) ||
        (article.symbol && article.symbol.toLowerCase() === vip.toLowerCase())),
  );

  if (hasMarketShock) {
    return {
      isQuietHoursActive: true,
      triageAction: "break_through_crisis_alert",
      crisisSeverity: "Crisis",
      reason: `Intraday shock of ${article.priceChangePercent}% exceeds VIP crisis threshold (±${config.shockThresholdPercent}%).`,
      breakthroughAllowed: true,
      evaluatedAt: now.toISOString(),
    };
  }

  if (hasCriticalKeyword && isVip) {
    return {
      isQuietHoursActive: true,
      triageAction: "break_through_crisis_alert",
      crisisSeverity: "Crisis",
      reason: "Critical event matches designated VIP watchlist entity.",
      breakthroughAllowed: true,
      evaluatedAt: now.toISOString(),
    };
  }

  if (hasCriticalKeyword) {
    return {
      isQuietHoursActive: true,
      triageAction: "break_through_crisis_alert",
      crisisSeverity: "Urgent",
      reason: "High-priority crisis indicator detected.",
      breakthroughAllowed: true,
      evaluatedAt: now.toISOString(),
    };
  }

  return {
    isQuietHoursActive: true,
    triageAction: "suppress_to_morning_briefing",
    crisisSeverity: "Normal",
    reason: "Non-critical development batched for tomorrow morning's Daily Briefing pack.",
    breakthroughAllowed: false,
    evaluatedAt: now.toISOString(),
  };
}

export function isTimeInQuietHours(now: Date, config: QuietHoursConfig): boolean {
  if (!config.enabled) return false;

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const currentDay = days[now.getDay()];
  if (!config.activeDays.includes(currentDay)) return false;

  const [startH, startM] = config.startTime.split(":").map(Number);
  const [endH, endM] = config.endTime.split(":").map(Number);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  // Overnight window
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

const STORAGE_KEY = "signal_quiet_hours_config";

export function loadLocalQuietHoursConfig(): QuietHoursConfig {
  if (typeof window === "undefined" || !window.localStorage) return DEFAULT_QUIET_HOURS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUIET_HOURS;
    return { ...DEFAULT_QUIET_HOURS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_QUIET_HOURS;
  }
}

export function saveLocalQuietHoursConfig(config: QuietHoursConfig): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}
