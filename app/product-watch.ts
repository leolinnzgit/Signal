export type ProductWatchFrequency =
  | "6h"
  | "12h"
  | "daily"
  | "weekly"
  | "fortnightly"
  | "monthly"
  | "manual";

export interface ProductWatchFrequencyOption {
  id: ProductWatchFrequency;
  label: string;
  intervalHours: number | null;
}

export interface ProductWatchOffer {
  retailer: string;
  price: number;
  currency: string;
  availability: string;
  note: string;
  url: string;
}

export interface ProductPriceHistoryPoint {
  checkedAtUtc: string;
  bestPrice: number;
  retailer: string;
  currency: string;
}

export interface ProductPriceCheckResult {
  productName: string;
  modelOrSku: string;
  currency: string;
  bestPrice: number;
  regularPrice: number;
  savingsAmount: number;
  savingsPercent: number;
  bestRetailer: string;
  bestOfferUrl: string;
  priceVerdict: string;
  summary: string;
  buyingTip: string;
  offers: ProductWatchOffer[];
  model: string;
  checkedAtUtc: string;
}

export interface ProductWatchItem {
  id: string;
  productName: string;
  modelOrSku: string;
  frequency: ProductWatchFrequency;
  frequencyLabel: string;
  currency: string;
  targetPrice: number | null;
  enabled: boolean;
  notifyOnPriceDrop: boolean;
  bestPrice: number | null;
  regularPrice: number | null;
  lowestPriceEver: number | null;
  previousBestPrice: number | null;
  savingsAmount: number | null;
  savingsPercent: number | null;
  isTargetMet: boolean;
  isPriceDrop: boolean;
  bestRetailer: string;
  bestOfferUrl: string;
  priceVerdict: string;
  summary: string;
  buyingTip: string;
  offers: ProductWatchOffer[];
  priceHistory: ProductPriceHistoryPoint[];
  modelUsed: string;
  checkCount: number;
  lastCheckedAtUtc: string | null;
  nextCheckAtUtc: string | null;
  lastError: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface ProductWatchUpsertInput {
  id?: string;
  productName?: string;
  modelOrSku: string;
  frequency?: ProductWatchFrequency | string;
  currency?: string;
  targetPrice?: number | null;
  enabled?: boolean;
  notifyOnPriceDrop?: boolean;
  checkNow?: boolean;
}

export interface ProductWatchStateResponse {
  authenticated: boolean;
  aiAvailable: boolean;
  model: string;
  frequencies: ProductWatchFrequencyOption[];
  currencies: string[];
  items: ProductWatchItem[];
}

export interface ProductWatchPreset {
  id: string;
  productName: string;
  modelOrSku: string;
  defaultFrequency: ProductWatchFrequency;
  currency: string;
  targetPrice?: number;
}

export const PRODUCT_WATCH_MODEL = "gpt-6.1-sol";

export const PRODUCT_WATCH_FREQUENCIES: readonly ProductWatchFrequencyOption[] = [
  { id: "6h", label: "Every 6 hours", intervalHours: 6 },
  { id: "12h", label: "Every 12 hours", intervalHours: 12 },
  { id: "daily", label: "Daily", intervalHours: 24 },
  { id: "weekly", label: "Weekly", intervalHours: 24 * 7 },
  { id: "fortnightly", label: "Fortnightly (Every 2 weeks)", intervalHours: 24 * 14 },
  { id: "monthly", label: "Monthly", intervalHours: 24 * 30 },
  { id: "manual", label: "Manual only", intervalHours: null },
];

export const PRODUCT_WATCH_CURRENCIES: readonly string[] = [
  "NZD",
  "USD",
  "AUD",
  "GBP",
  "EUR",
  "CAD",
  "SGD",
  "JPY",
];

export const PRODUCT_WATCH_PRESETS: readonly ProductWatchPreset[] = [
  {
    id: "sony-xm5",
    productName: "Sony WH-1000XM5 Wireless Headphones",
    modelOrSku: "WH-1000XM5",
    defaultFrequency: "daily",
    currency: "NZD",
    targetPrice: 480,
  },
  {
    id: "macbook-air-m3",
    productName: "Apple MacBook Air 13\" M3 (16GB/256GB)",
    modelOrSku: "MC8K4X/A",
    defaultFrequency: "weekly",
    currency: "NZD",
    targetPrice: 1699,
  },
  {
    id: "lg-c4-65",
    productName: "LG C4 65\" 4K OLED Evo TV",
    modelOrSku: "OLED65C4PSA",
    defaultFrequency: "weekly",
    currency: "NZD",
    targetPrice: 2999,
  },
  {
    id: "samsung-s25-ultra",
    productName: "Samsung Galaxy S25 Ultra 256GB",
    modelOrSku: "SM-S938B",
    defaultFrequency: "daily",
    currency: "NZD",
    targetPrice: 1899,
  },
];

const LOCAL_STORAGE_KEY = "signal_product_watches_v1";

export function normalizeWatchFrequency(raw?: string | null): ProductWatchFrequency {
  const clean = (raw || "").trim().toLowerCase();
  switch (clean) {
    case "6h":
    case "6hr":
    case "hourly":
      return "6h";
    case "12h":
    case "12hr":
      return "12h";
    case "daily":
    case "day":
    case "1d":
    case "24h":
      return "daily";
    case "weekly":
    case "week":
    case "1w":
    case "7d":
      return "weekly";
    case "fortnightly":
    case "biweekly":
    case "2w":
    case "14d":
      return "fortnightly";
    case "monthly":
    case "month":
    case "1m":
    case "30d":
      return "monthly";
    case "manual":
    case "off":
    case "none":
      return "manual";
    default:
      return "daily";
  }
}

export function getFrequencyLabel(frequency?: string | null): string {
  const norm = normalizeWatchFrequency(frequency);
  return PRODUCT_WATCH_FREQUENCIES.find((f) => f.id === norm)?.label ?? "Daily";
}

export function computeNextCheckIso(frequency?: string | null, fromDate: Date = new Date()): string | null {
  const norm = normalizeWatchFrequency(frequency);
  const found = PRODUCT_WATCH_FREQUENCIES.find((f) => f.id === norm);
  if (!found || found.intervalHours === null) return null;
  return new Date(fromDate.getTime() + found.intervalHours * 3600_000).toISOString();
}

export function normalizeWatchCurrency(raw?: string | null): string {
  const clean = (raw || "").trim().toUpperCase();
  return PRODUCT_WATCH_CURRENCIES.includes(clean) ? clean : "NZD";
}

export function formatProductPrice(price: number | null | undefined, currency = "NZD"): string {
  if (price === null || price === undefined || !Number.isFinite(price)) {
    return "Not checked yet";
  }
  const code = normalizeWatchCurrency(currency);
  const decimals = code === "JPY" ? 0 : 2;
  return `${code} $${price.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function priceVerdictBadgeMeta(verdict?: string | null): {
  label: string;
  toneClass: string;
  icon: string;
} {
  switch ((verdict || "").trim().toLowerCase()) {
    case "great-deal":
      return { label: "Great Deal", toneClass: "verdict-great", icon: "🔥" };
    case "good-price":
      return { label: "Good Price", toneClass: "verdict-good", icon: "✅" };
    case "wait":
      return { label: "Hold / Wait", toneClass: "verdict-wait", icon: "⏳" };
    case "fair-price":
      return { label: "Fair Price", toneClass: "verdict-fair", icon: "⚖️" };
    default:
      return { label: "Awaiting Check", toneClass: "verdict-pending", icon: "🔎" };
  }
}

export function loadLocalProductWatches(
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): ProductWatchItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ProductWatchItem =>
        Boolean(item && typeof item.id === "string" && typeof item.modelOrSku === "string"),
    );
  } catch {
    return [];
  }
}

export function saveLocalProductWatches(
  items: ProductWatchItem[],
  storage: Pick<Storage, "setItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota errors
  }
}

async function getCsrfToken(fetcher: typeof fetch): Promise<string | null> {
  try {
    const res = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string };
    return data.token || null;
  } catch {
    return null;
  }
}

export async function fetchProductWatchState(
  fetcher: typeof fetch = fetch,
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): Promise<ProductWatchStateResponse> {
  try {
    const res = await fetcher("/api/product-watch", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = (await res.json()) as ProductWatchStateResponse;
    if (!payload.authenticated) {
      return {
        authenticated: false,
        aiAvailable: Boolean(payload.aiAvailable),
        model: payload.model || PRODUCT_WATCH_MODEL,
        frequencies: payload.frequencies?.length ? payload.frequencies : [...PRODUCT_WATCH_FREQUENCIES],
        currencies: payload.currencies?.length ? payload.currencies : [...PRODUCT_WATCH_CURRENCIES],
        items: loadLocalProductWatches(storage),
      };
    }
    return {
      ...payload,
      model: payload.model || PRODUCT_WATCH_MODEL,
      frequencies: payload.frequencies?.length ? payload.frequencies : [...PRODUCT_WATCH_FREQUENCIES],
      currencies: payload.currencies?.length ? payload.currencies : [...PRODUCT_WATCH_CURRENCIES],
      items: Array.isArray(payload.items) ? payload.items : [],
    };
  } catch {
    return {
      authenticated: false,
      aiAvailable: false,
      model: PRODUCT_WATCH_MODEL,
      frequencies: [...PRODUCT_WATCH_FREQUENCIES],
      currencies: [...PRODUCT_WATCH_CURRENCIES],
      items: loadLocalProductWatches(storage),
    };
  }
}

export async function saveProductWatchItem(
  input: ProductWatchUpsertInput,
  authenticated: boolean,
  fetcher: typeof fetch = fetch,
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null,
): Promise<ProductWatchItem> {
  const modelOrSku = (input.modelOrSku || "").trim();
  const productName = (input.productName || "").trim() || modelOrSku;
  if (modelOrSku.length < 2) {
    throw new Error("Enter a product model or SKU (at least 2 characters).");
  }

  const frequency = normalizeWatchFrequency(input.frequency);
  const currency = normalizeWatchCurrency(input.currency);
  const targetPrice =
    typeof input.targetPrice === "number" && Number.isFinite(input.targetPrice) && input.targetPrice > 0
      ? Math.round(input.targetPrice * 100) / 100
      : null;

  if (authenticated) {
    const token = await getCsrfToken(fetcher);
    const res = await fetcher("/api/product-watch", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        id: input.id,
        productName,
        modelOrSku,
        frequency,
        currency,
        targetPrice,
        enabled: input.enabled ?? true,
        notifyOnPriceDrop: input.notifyOnPriceDrop ?? true,
        checkNow: input.checkNow ?? false,
      }),
    });
    if (res.ok) {
      return (await res.json()) as ProductWatchItem;
    }
    if (res.status !== 401) {
      const errBody = await res.json().catch(() => ({} as { error?: string }));
      throw new Error(errBody.error || `Could not save product watch: HTTP ${res.status}`);
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const existing = loadLocalProductWatches(storage);
  const id = input.id && input.id.trim().length > 0 ? input.id.trim() : `pw-local-${Date.now()}`;
  const prev = existing.find((w) => w.id === id);
  const enabled = input.enabled ?? prev?.enabled ?? true;
  const saved: ProductWatchItem = {
    id,
    productName,
    modelOrSku,
    frequency,
    frequencyLabel: getFrequencyLabel(frequency),
    currency,
    targetPrice,
    enabled,
    notifyOnPriceDrop: input.notifyOnPriceDrop ?? prev?.notifyOnPriceDrop ?? true,
    bestPrice: prev?.bestPrice ?? null,
    regularPrice: prev?.regularPrice ?? null,
    lowestPriceEver: prev?.lowestPriceEver ?? null,
    previousBestPrice: prev?.previousBestPrice ?? null,
    savingsAmount: prev?.savingsAmount ?? null,
    savingsPercent: prev?.savingsPercent ?? null,
    isTargetMet:
      prev?.bestPrice !== null &&
      prev?.bestPrice !== undefined &&
      targetPrice !== null &&
      prev.bestPrice <= targetPrice,
    isPriceDrop: prev?.isPriceDrop ?? false,
    bestRetailer: prev?.bestRetailer ?? "",
    bestOfferUrl: prev?.bestOfferUrl ?? "",
    priceVerdict: prev?.priceVerdict ?? "",
    summary: prev?.summary ?? "",
    buyingTip: prev?.buyingTip ?? "",
    offers: prev?.offers ?? [],
    priceHistory: prev?.priceHistory ?? [],
    modelUsed: prev?.modelUsed ?? PRODUCT_WATCH_MODEL,
    checkCount: prev?.checkCount ?? 0,
    lastCheckedAtUtc: prev?.lastCheckedAtUtc ?? null,
    nextCheckAtUtc: enabled ? computeNextCheckIso(frequency, now) : null,
    lastError: "",
    createdAtUtc: prev?.createdAtUtc ?? nowIso,
    updatedAtUtc: nowIso,
  };

  const next = prev ? existing.map((w) => (w.id === id ? saved : w)) : [saved, ...existing];
  saveLocalProductWatches(next, storage);
  return saved;
}

export async function checkProductWatchPriceNow(
  id: string,
  authenticated: boolean,
  fetcher: typeof fetch = fetch,
): Promise<ProductWatchItem> {
  if (!authenticated) {
    throw new Error("Sign in to check live product prices with gpt-6.1-sol.");
  }

  const token = await getCsrfToken(fetcher);
  const res = await fetcher(`/api/product-watch/${encodeURIComponent(id)}/check`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { "X-XSRF-TOKEN": token } : {}),
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(errBody.error || `Could not check best price right now (HTTP ${res.status}).`);
  }

  return (await res.json()) as ProductWatchItem;
}

export async function checkProductInstantPrice(
  request: {
    modelOrSku: string;
    productName?: string;
    currency?: string;
    targetPrice?: number | null;
  },
  fetcher: typeof fetch = fetch,
): Promise<ProductPriceCheckResult> {
  const token = await getCsrfToken(fetcher);
  const res = await fetcher("/api/product-watch/check-instant", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(token ? { "X-XSRF-TOKEN": token } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(errBody.error || `Instant price check failed (HTTP ${res.status}).`);
  }

  return (await res.json()) as ProductPriceCheckResult;
}

export async function deleteProductWatchItem(
  id: string,
  authenticated: boolean,
  fetcher: typeof fetch = fetch,
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null,
): Promise<void> {
  if (authenticated) {
    const token = await getCsrfToken(fetcher);
    const res = await fetcher(`/api/product-watch/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: token ? { "X-XSRF-TOKEN": token } : undefined,
    });
    if (res.ok || res.status === 404) return;
    if (res.status !== 401) {
      throw new Error(`Could not remove product watch (HTTP ${res.status}).`);
    }
  }

  const existing = loadLocalProductWatches(storage);
  saveLocalProductWatches(
    existing.filter((w) => w.id !== id),
    storage,
  );
}

export function formatProductWatchMarkdown(items: ReadonlyArray<ProductWatchItem>): string {
  const lines: string[] = [
    "# Signal Product Watch — Best Price Report",
    `*Model: ${PRODUCT_WATCH_MODEL} • Exported: ${new Date().toUTCString()}*`,
    "",
  ];

  if (items.length === 0) {
    lines.push("No products are currently being watched.");
    return lines.join("\n");
  }

  for (const item of items) {
    const badge = priceVerdictBadgeMeta(item.priceVerdict);
    lines.push(`## ${item.productName} (\`${item.modelOrSku}\`)`);
    lines.push(
      `- **Schedule:** ${item.frequencyLabel} (${item.enabled ? "Active" : "Paused"})`,
    );
    if (item.bestPrice !== null) {
      const reg =
        item.regularPrice && item.regularPrice > item.bestPrice
          ? ` (Regular: ${formatProductPrice(item.regularPrice, item.currency)}, Save ${item.savingsPercent?.toFixed(1) ?? "0"}%)`
          : "";
      lines.push(
        `- **Best Price Now:** ${formatProductPrice(item.bestPrice, item.currency)} at **${item.bestRetailer || "Retailer"}**${reg} — *${badge.icon} ${badge.label}*`,
      );
    } else {
      lines.push("- **Best Price Now:** Awaiting check");
    }
    if (item.targetPrice !== null) {
      lines.push(
        `- **Target Alert Price:** ${formatProductPrice(item.targetPrice, item.currency)}${item.isTargetMet ? " ✅ Target Reached!" : ""}`,
      );
    }
    if (item.summary) {
      lines.push(`- **Analysis:** ${item.summary}`);
    }
    if (item.buyingTip) {
      lines.push(`- **Buying Tip:** ${item.buyingTip}`);
    }
    if (item.offers && item.offers.length > 0) {
      lines.push("- **Top Offers:**");
      for (const offer of item.offers) {
        const linkPart = offer.url ? ` ([View](${offer.url}))` : "";
        const notePart = offer.note ? ` — ${offer.note}` : "";
        lines.push(
          `  - **${offer.retailer}**: ${formatProductPrice(offer.price, offer.currency)} (${offer.availability})${notePart}${linkPart}`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
