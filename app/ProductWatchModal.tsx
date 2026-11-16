import React, { useEffect, useState } from "react";
import {
  PRODUCT_WATCH_CURRENCIES,
  PRODUCT_WATCH_FREQUENCIES,
  PRODUCT_WATCH_MODEL,
  PRODUCT_WATCH_PRESETS,
  type ProductWatchFrequency,
  type ProductWatchFrequencyOption,
  type ProductWatchItem,
  type ProductWatchPreset,
  checkProductInstantPrice,
  checkProductWatchPriceNow,
  deleteProductWatchItem,
  fetchProductWatchState,
  formatProductPrice,
  formatProductWatchMarkdown,
  normalizeWatchFrequency,
  priceVerdictBadgeMeta,
  saveLocalProductWatches,
  saveProductWatchItem,
} from "./product-watch";
import "./product-watch.css";

export interface ProductWatchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onWatchCountChange?: (count: number) => void;
}

function formatShortTimestamp(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Never";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ProductWatchModal({
  isOpen,
  onClose,
  onWatchCountChange,
}: ProductWatchModalProps) {
  const [authenticated, setAuthenticated] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [activeModel, setActiveModel] = useState(PRODUCT_WATCH_MODEL);
  const [frequencies, setFrequencies] = useState<ProductWatchFrequencyOption[]>([
    ...PRODUCT_WATCH_FREQUENCIES,
  ]);
  const [currencies, setCurrencies] = useState<string[]>([...PRODUCT_WATCH_CURRENCIES]);
  const [items, setItems] = useState<ProductWatchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);

  // Add form state
  const [modelOrSku, setModelOrSku] = useState("");
  const [productName, setProductName] = useState("");
  const [frequency, setFrequency] = useState<ProductWatchFrequency>("daily");
  const [currency, setCurrency] = useState("NZD");
  const [targetPriceText, setTargetPriceText] = useState("");
  const [checkImmediately, setCheckImmediately] = useState(true);
  const [notifyOnPriceDrop, setNotifyOnPriceDrop] = useState(true);

  useEffect(() => {
    onWatchCountChange?.(items.filter((i) => i.enabled).length);
  }, [items, onWatchCountChange]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    setLoading(true);
    setErrorMsg("");
    void fetchProductWatchState()
      .then((state) => {
        if (cancelled) return;
        setAuthenticated(state.authenticated);
        setAiAvailable(state.aiAvailable);
        setActiveModel(state.model || PRODUCT_WATCH_MODEL);
        if (state.frequencies?.length) setFrequencies(state.frequencies);
        if (state.currencies?.length) setCurrencies(state.currencies);
        setItems(state.items);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const markChecking = (id: string, busy: boolean) => {
    setCheckingIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleCheckSingle = async (item: ProductWatchItem) => {
    markChecking(item.id, true);
    setErrorMsg("");
    try {
      if (authenticated) {
        const updated = await checkProductWatchPriceNow(item.id, true);
        setItems((prev) => prev.map((w) => (w.id === item.id ? updated : w)));
      } else {
        const instant = await checkProductInstantPrice({
          modelOrSku: item.modelOrSku,
          productName: item.productName,
          currency: item.currency,
          targetPrice: item.targetPrice,
        });
        const nowIso = new Date().toISOString();
        const updated: ProductWatchItem = {
          ...item,
          productName: instant.productName || item.productName,
          previousBestPrice: item.bestPrice,
          bestPrice: instant.bestPrice,
          regularPrice: instant.regularPrice,
          lowestPriceEver:
            item.lowestPriceEver !== null
              ? Math.min(item.lowestPriceEver, instant.bestPrice)
              : instant.bestPrice,
          savingsAmount: instant.savingsAmount,
          savingsPercent: instant.savingsPercent,
          isTargetMet:
            item.targetPrice !== null && instant.bestPrice <= item.targetPrice,
          isPriceDrop:
            item.bestPrice !== null && instant.bestPrice < item.bestPrice,
          bestRetailer: instant.bestRetailer,
          bestOfferUrl: instant.bestOfferUrl,
          priceVerdict: instant.priceVerdict,
          summary: instant.summary,
          buyingTip: instant.buyingTip,
          offers: instant.offers,
          modelUsed: instant.model || PRODUCT_WATCH_MODEL,
          checkCount: item.checkCount + 1,
          lastCheckedAtUtc: nowIso,
          priceHistory: [
            ...item.priceHistory,
            {
              checkedAtUtc: nowIso,
              bestPrice: instant.bestPrice,
              retailer: instant.bestRetailer,
              currency: instant.currency,
            },
          ].slice(-30),
        };
        setItems((prev) => {
          const next = prev.map((w) => (w.id === item.id ? updated : w));
          saveLocalProductWatches(next);
          return next;
        });
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Could not check the best price right now.",
      );
    } finally {
      markChecking(item.id, false);
    }
  };

  const handleCheckAll = async () => {
    const enabledItems = items.filter((i) => i.enabled);
    if (enabledItems.length === 0 || checkingAll) return;
    setCheckingAll(true);
    setErrorMsg("");
    try {
      for (const item of enabledItems) {
        await handleCheckSingle(item);
      }
    } finally {
      setCheckingAll(false);
    }
  };

  const handleAddSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMsg("");

    const cleanSku = modelOrSku.trim();
    const cleanName = productName.trim() || cleanSku;
    if (cleanSku.length < 2) {
      setErrorMsg("Enter a product model or SKU (at least 2 characters).");
      return;
    }

    let parsedTarget: number | null = null;
    if (targetPriceText.trim().length > 0) {
      const num = Number(targetPriceText.trim());
      if (!Number.isFinite(num) || num <= 0) {
        setErrorMsg("Enter a valid positive target price, or leave it blank.");
        return;
      }
      parsedTarget = Math.round(num * 100) / 100;
    }

    setSaving(true);
    try {
      const saved = await saveProductWatchItem(
        {
          modelOrSku: cleanSku,
          productName: cleanName,
          frequency,
          currency,
          targetPrice: parsedTarget,
          enabled: true,
          notifyOnPriceDrop,
          checkNow: false,
        },
        authenticated,
      );

      setItems((prev) => [saved, ...prev.filter((w) => w.id !== saved.id)]);
      setModelOrSku("");
      setProductName("");
      setTargetPriceText("");

      if (checkImmediately) {
        await handleCheckSingle(saved);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not add product watch.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleApplyPreset = (preset: ProductWatchPreset) => {
    setModelOrSku(preset.modelOrSku);
    setProductName(preset.productName);
    setFrequency(preset.defaultFrequency);
    setCurrency(preset.currency);
    setTargetPriceText(preset.targetPrice ? String(preset.targetPrice) : "");
  };

  const handleUpdateFrequency = async (
    item: ProductWatchItem,
    nextFrequency: string,
  ) => {
    setErrorMsg("");
    const normalized = normalizeWatchFrequency(nextFrequency);
    try {
      const updated = await saveProductWatchItem(
        {
          id: item.id,
          productName: item.productName,
          modelOrSku: item.modelOrSku,
          frequency: normalized,
          currency: item.currency,
          targetPrice: item.targetPrice,
          enabled: item.enabled,
          notifyOnPriceDrop: item.notifyOnPriceDrop,
          checkNow: false,
        },
        authenticated,
      );
      setItems((prev) => prev.map((w) => (w.id === item.id ? updated : w)));
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not update check frequency.",
      );
    }
  };

  const handleToggleEnabled = async (item: ProductWatchItem) => {
    setErrorMsg("");
    try {
      const updated = await saveProductWatchItem(
        {
          id: item.id,
          productName: item.productName,
          modelOrSku: item.modelOrSku,
          frequency: item.frequency,
          currency: item.currency,
          targetPrice: item.targetPrice,
          enabled: !item.enabled,
          notifyOnPriceDrop: item.notifyOnPriceDrop,
          checkNow: false,
        },
        authenticated,
      );
      setItems((prev) => prev.map((w) => (w.id === item.id ? updated : w)));
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not update product watch.",
      );
    }
  };

  const handleDelete = async (id: string) => {
    setErrorMsg("");
    try {
      await deleteProductWatchItem(id, authenticated);
      setItems((prev) => prev.filter((w) => w.id !== id));
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not remove watched product.",
      );
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(formatProductWatchMarkdown(items));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Ignore clipboard failures
    }
  };

  return (
    <div
      className="product-watch-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-watch-modal-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="product-watch-modal">
        <header className="product-watch-header">
          <div className="product-watch-header-title">
            <span className="product-watch-avatar" aria-hidden="true">
              🏷️
            </span>
            <div>
              <h2 id="product-watch-modal-title">
                Product Watch — Best Price Monitor
              </h2>
              <p>
                Track any product model or SKU on your chosen schedule (daily,
                weekly, monthly) and check the best price at the moment using{" "}
                <strong>{activeModel}</strong>
              </p>
            </div>
          </div>
          <div className="product-watch-header-actions">
            <span
              className="product-watch-model-pill"
              title="Powered by Microsoft Foundry gpt-6.1-sol"
            >
              ⚡ {activeModel}
            </span>
            <button
              type="button"
              className="product-watch-close-btn"
              onClick={onClose}
              aria-label="Close Product Watch"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="product-watch-body">
          <div className="product-watch-status-bar">
            <span>
              {authenticated
                ? `🟢 Account SQLite Scheduler Armed • ${items.filter((i) => i.enabled).length} active product ${items.filter((i) => i.enabled).length === 1 ? "watch" : "watches"}${aiAvailable ? "" : " (Foundry key not detected)"}`
                : "🟡 Browser Mode — Sign in to run unattended background price checks and receive Web Push price-drop alerts"}
            </span>
            <div className="product-watch-status-actions">
              <button
                type="button"
                className="product-watch-btn"
                disabled={items.length === 0}
                onClick={() => void handleCopyMarkdown()}
              >
                {copied ? "✓ Copied Report" : "📋 Copy Report"}
              </button>
              <button
                type="button"
                className="product-watch-btn primary"
                disabled={
                  checkingAll ||
                  items.filter((i) => i.enabled).length === 0 ||
                  checkingIds.size > 0
                }
                onClick={() => void handleCheckAll()}
              >
                {checkingAll
                  ? "Checking Prices…"
                  : `🔄 Check All Now (${items.filter((i) => i.enabled).length})`}
              </button>
            </div>
          </div>

          <form className="product-watch-form-card" onSubmit={handleAddSubmit}>
            <div className="product-watch-form-header">
              <h3>Add Product Model / SKU to Watch</h3>
              <div className="product-watch-presets" aria-label="Sample products">
                <small style={{ opacity: 0.7 }}>Quick fill:</small>
                {PRODUCT_WATCH_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="product-watch-preset-chip"
                    onClick={() => handleApplyPreset(preset)}
                  >
                    + {preset.modelOrSku}
                  </button>
                ))}
              </div>
            </div>

            <div className="product-watch-form-grid">
              <div className="product-watch-field">
                <label htmlFor="pw-model-sku">Product Model / SKU *</label>
                <input
                  id="pw-model-sku"
                  type="text"
                  maxLength={120}
                  placeholder="e.g. WH-1000XM5, MC8K4X/A, OLED65C4PSA"
                  value={modelOrSku}
                  onChange={(e) => setModelOrSku(e.target.value)}
                  required
                />
              </div>

              <div className="product-watch-field">
                <label htmlFor="pw-product-name">
                  Product Name <small>(optional)</small>
                </label>
                <input
                  id="pw-product-name"
                  type="text"
                  maxLength={200}
                  placeholder="e.g. Sony WH-1000XM5 Headphones"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                />
              </div>

              <div className="product-watch-field">
                <label htmlFor="pw-frequency">Check Frequency</label>
                <select
                  id="pw-frequency"
                  value={frequency}
                  onChange={(e) =>
                    setFrequency(normalizeWatchFrequency(e.target.value))
                  }
                >
                  {frequencies.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="product-watch-field">
                <label htmlFor="pw-currency">Currency</label>
                <select
                  id="pw-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {currencies.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>

              <div className="product-watch-field">
                <label htmlFor="pw-target-price">
                  Target Alert Price <small>(optional)</small>
                </label>
                <input
                  id="pw-target-price"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="e.g. 480.00"
                  value={targetPriceText}
                  onChange={(e) => setTargetPriceText(e.target.value)}
                />
              </div>
            </div>

            <div className="product-watch-form-footer">
              <div className="product-watch-toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={checkImmediately}
                    onChange={(e) => setCheckImmediately(e.target.checked)}
                  />
                  <span>
                    Check best price immediately with{" "}
                    <strong>{activeModel}</strong>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={notifyOnPriceDrop}
                    onChange={(e) => setNotifyOnPriceDrop(e.target.checked)}
                  />
                  <span>Notify via Web Push on price drop or target hit</span>
                </label>
              </div>

              <button
                type="submit"
                className="product-watch-btn primary"
                disabled={saving || modelOrSku.trim().length < 2}
              >
                {saving
                  ? "Adding Watch…"
                  : checkImmediately
                    ? "➕ Add & Check Best Price"
                    : "➕ Add to Product Watch"}
              </button>
            </div>
          </form>

          {errorMsg && (
            <div className="product-watch-error" role="alert">
              {errorMsg}
            </div>
          )}

          {loading ? (
            <div className="product-watch-empty">
              Loading your watched products…
            </div>
          ) : items.length === 0 ? (
            <div className="product-watch-empty">
              <strong>No products watched yet.</strong>
              <p style={{ margin: "0.35rem 0 0" }}>
                Enter a product model or SKU above (or click a quick-fill chip)
                and choose a check frequency (daily, weekly, monthly, etc.) to
                monitor the best price at the moment with{" "}
                <strong>{activeModel}</strong>.
              </p>
            </div>
          ) : (
            <div className="product-watch-list" role="list">
              {items.map((item) => {
                const isChecking = checkingIds.has(item.id);
                const verdictMeta = priceVerdictBadgeMeta(item.priceVerdict);
                return (
                  <article
                    key={item.id}
                    role="listitem"
                    className={`product-watch-card${item.enabled ? "" : " paused"}`}
                  >
                    <div className="product-watch-card-top">
                      <div className="product-watch-card-title">
                        <h4>
                          <span>{item.productName}</span>
                          <span className="product-watch-sku-badge">
                            SKU / Model: {item.modelOrSku}
                          </span>
                          {item.isTargetMet && (
                            <span className="product-watch-savings-pill">
                              🎯 Target Reached!
                            </span>
                          )}
                          {item.isPriceDrop && (
                            <span className="product-watch-savings-pill">
                              📉 Price Dropped!
                            </span>
                          )}
                        </h4>
                      </div>

                      <div className="product-watch-card-controls">
                        <label
                          style={{
                            fontSize: "0.74rem",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                          }}
                        >
                          <span>Frequency:</span>
                          <select
                            className="product-watch-inline-select"
                            aria-label={`Check frequency for ${item.productName}`}
                            value={item.frequency}
                            onChange={(e) =>
                              void handleUpdateFrequency(item, e.target.value)
                            }
                          >
                            {frequencies.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </label>

                        <button
                          type="button"
                          className="product-watch-btn primary"
                          disabled={isChecking}
                          onClick={() => void handleCheckSingle(item)}
                        >
                          {isChecking
                            ? `Checking with ${activeModel}…`
                            : "🔍 Check Best Price Now"}
                        </button>

                        <button
                          type="button"
                          className="product-watch-btn"
                          onClick={() => void handleToggleEnabled(item)}
                        >
                          {item.enabled ? "⏸ Pause" : "▶ Resume"}
                        </button>

                        <button
                          type="button"
                          className="product-watch-btn"
                          onClick={() => void handleDelete(item.id)}
                          aria-label={`Remove ${item.productName}`}
                        >
                          🗑 Remove
                        </button>
                      </div>
                    </div>

                    <div className="product-watch-price-banner">
                      <div className="product-watch-best-price-main">
                        <span className="product-watch-best-price-value">
                          {isChecking && item.bestPrice === null
                            ? "Checking best price…"
                            : formatProductPrice(item.bestPrice, item.currency)}
                        </span>
                        {item.bestRetailer && (
                          <span>
                            at{" "}
                            {item.bestOfferUrl ? (
                              <a
                                href={item.bestOfferUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <strong>{item.bestRetailer} ↗</strong>
                              </a>
                            ) : (
                              <strong>{item.bestRetailer}</strong>
                            )}
                          </span>
                        )}
                        {item.regularPrice !== null &&
                          item.bestPrice !== null &&
                          item.regularPrice > item.bestPrice && (
                            <>
                              <span className="product-watch-regular-price">
                                Regular{" "}
                                {formatProductPrice(
                                  item.regularPrice,
                                  item.currency,
                                )}
                              </span>
                              {item.savingsPercent !== null &&
                                item.savingsPercent > 0 && (
                                  <span className="product-watch-savings-pill">
                                    Save{" "}
                                    {formatProductPrice(
                                      item.savingsAmount,
                                      item.currency,
                                    )}{" "}
                                    ({item.savingsPercent.toFixed(1)}% off)
                                  </span>
                                )}
                            </>
                          )}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                        }}
                      >
                        {item.targetPrice !== null && (
                          <span style={{ fontSize: "0.76rem", fontWeight: 600 }}>
                            Target:{" "}
                            {formatProductPrice(item.targetPrice, item.currency)}
                          </span>
                        )}
                        {item.lowestPriceEver !== null && (
                          <span style={{ fontSize: "0.75rem", opacity: 0.8 }}>
                            Low:{" "}
                            {formatProductPrice(
                              item.lowestPriceEver,
                              item.currency,
                            )}
                          </span>
                        )}
                        <span
                          className={`product-watch-verdict-badge ${verdictMeta.toneClass}`}
                        >
                          <span aria-hidden="true">{verdictMeta.icon}</span>
                          <span>{verdictMeta.label}</span>
                        </span>
                      </div>
                    </div>

                    {item.summary && (
                      <p className="product-watch-summary">{item.summary}</p>
                    )}

                    {item.buyingTip && (
                      <p className="product-watch-tip">
                        <strong>💡 Buying Tip:</strong> {item.buyingTip}
                      </p>
                    )}

                    {item.offers && item.offers.length > 0 && (
                      <div
                        className="product-watch-offers-grid"
                        aria-label={`Retailer offers for ${item.productName}`}
                      >
                        {item.offers.map((offer, idx) => (
                          <div
                            key={`${offer.retailer}-${idx}`}
                            className="product-watch-offer-item"
                          >
                            <div className="product-watch-offer-top">
                              <span>
                                {offer.url ? (
                                  <a
                                    href={offer.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {offer.retailer} ↗
                                  </a>
                                ) : (
                                  offer.retailer
                                )}
                              </span>
                              <span>
                                {formatProductPrice(
                                  offer.price,
                                  offer.currency || item.currency,
                                )}
                              </span>
                            </div>
                            <div className="product-watch-offer-note">
                              <strong>{offer.availability}</strong>
                              {offer.note ? ` · ${offer.note}` : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {item.priceHistory && item.priceHistory.length > 1 && (
                      <div className="product-watch-history-strip">
                        <strong>Recent Price History:</strong>
                        {item.priceHistory.slice(-5).map((pt, idx) => (
                          <span
                            key={`${pt.checkedAtUtc}-${idx}`}
                            className="product-watch-history-pill"
                          >
                            {formatProductPrice(pt.bestPrice, pt.currency)} (
                            {pt.retailer || "Retail"}, {" "}
                            {formatShortTimestamp(pt.checkedAtUtc)})
                          </span>
                        ))}
                      </div>
                    )}

                    {item.lastError && (
                      <div className="product-watch-error">{item.lastError}</div>
                    )}

                    <div className="product-watch-meta-row">
                      <span>
                        Schedule: <strong>{item.frequencyLabel}</strong> (
                        {item.enabled ? "Active" : "Paused"}) • Checks:{" "}
                        {item.checkCount}
                      </span>
                      <span>
                        Last checked:{" "}
                        <strong>
                          {formatShortTimestamp(item.lastCheckedAtUtc)}
                        </strong>{" "}
                        • Next scheduled check:{" "}
                        <strong>
                          {item.enabled && item.nextCheckAtUtc
                            ? formatShortTimestamp(item.nextCheckAtUtc)
                            : "Manual"}
                        </strong>{" "}
                        • Model: <strong>{item.modelUsed || activeModel}</strong>
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
