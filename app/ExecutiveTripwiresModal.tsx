import React, { useEffect, useState } from "react";
import {
  DEFAULT_TRIPWIRE_PRESETS,
  ExecutiveTripwire,
  TRIPWIRE_SUITE_DESTINATIONS,
  TripwireMatchResult,
  deleteTripwireRule,
  evaluateTripwires,
  fetchTripwiresState,
  formatTripwiresDigest,
  saveTripwireRule,
} from "./executive-tripwires";
import "./executive-tripwires.css";

export interface ExecutiveTripwiresModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; url: string; source: string; summary?: string; topics?: string[] }>;
  onOpenSuite: (suiteId: string, focusEntityId?: string) => void;
}

function severityClass(severity: string): string {
  switch ((severity || "").toLowerCase()) {
    case "critical":
      return "tripwire-severity-critical";
    case "elevated":
      return "tripwire-severity-elevated";
    default:
      return "tripwire-severity-high";
  }
}

export function ExecutiveTripwiresModal({
  isOpen,
  onClose,
  articles = [],
  onOpenSuite,
}: ExecutiveTripwiresModalProps) {
  const [authenticated, setAuthenticated] = useState(false);
  const [tripwires, setTripwires] = useState<ExecutiveTripwire[]>([]);
  const [presets, setPresets] = useState<ExecutiveTripwire[]>(DEFAULT_TRIPWIRE_PRESETS);
  const [matches, setMatches] = useState<TripwireMatchResult[]>([]);
  const [evaluatedInfo, setEvaluatedInfo] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);

  // Builder form state
  const [name, setName] = useState("");
  const [keywordsText, setKeywordsText] = useState("");
  const [severity, setSeverity] = useState("Critical");
  const [targetSuiteId, setTargetSuiteId] = useState("sovereign-risk");
  const [targetEntityId, setTargetEntityId] = useState("");
  const [pushOnMatch, setPushOnMatch] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);

    fetchTripwiresState().then((state) => {
      if (cancelled) return;
      setAuthenticated(state.authenticated);
      setTripwires(state.tripwires);
      setPresets(state.presets);
      if (articles.length > 0) {
        const rulesToScan = state.tripwires.length > 0 ? state.tripwires : state.presets;
        void evaluateTripwires(articles, rulesToScan).then((evalRes) => {
          if (!cancelled) {
            setMatches(evalRes.matches);
            setEvaluatedInfo(`Scanned ${evalRes.evaluatedArticles} headlines across ${evalRes.evaluatedRules} rules`);
          }
        });
      }
    });

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, onClose, articles]);

  if (!isOpen) return null;

  const handleScanNow = async (overrideRules?: ExecutiveTripwire[]) => {
    setScanning(true);
    setErrorMsg("");
    try {
      const targetRules = overrideRules ?? (tripwires.length > 0 ? tripwires : presets);
      const res = await evaluateTripwires(articles, targetRules);
      setMatches(res.matches);
      setEvaluatedInfo(`Scanned ${res.evaluatedArticles} headlines across ${res.evaluatedRules} active rules`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to scan tripwires.");
    } finally {
      setScanning(false);
    }
  };

  const handleActivatePreset = async (preset: ExecutiveTripwire) => {
    setSaving(true);
    setErrorMsg("");
    try {
      const saved = await saveTripwireRule(
        {
          name: preset.name,
          keywords: preset.keywords,
          targetSuiteId: preset.targetSuiteId,
          targetEntityId: preset.targetEntityId,
          severity: preset.severity,
          enabled: true,
          pushOnMatch: true,
        },
        authenticated,
      );
      const nextList = [saved, ...tripwires.filter((t) => t.id !== saved.id)];
      setTripwires(nextList);
      await handleScanNow(nextList);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to activate preset.");
    } finally {
      setSaving(false);
    }
  };

  const handleCreateCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    const parsedKeywords = keywordsText
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length >= 2);
    if (name.trim().length < 2) {
      setErrorMsg("Enter a tripwire monitor name (at least 2 characters).");
      return;
    }
    if (parsedKeywords.length === 0) {
      setErrorMsg("Enter at least one comma-separated monitoring keyword (2+ chars).");
      return;
    }

    setSaving(true);
    try {
      const saved = await saveTripwireRule(
        {
          name: name.trim(),
          keywords: parsedKeywords,
          targetSuiteId,
          targetEntityId: targetEntityId.trim(),
          severity,
          enabled: true,
          pushOnMatch,
        },
        authenticated,
      );
      const nextList = [saved, ...tripwires];
      setTripwires(nextList);
      setName("");
      setKeywordsText("");
      setTargetEntityId("");
      await handleScanNow(nextList);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not save tripwire rule.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleRule = async (rule: ExecutiveTripwire) => {
    try {
      const updated = await saveTripwireRule(
        {
          id: rule.id,
          name: rule.name,
          keywords: rule.keywords,
          targetSuiteId: rule.targetSuiteId,
          targetEntityId: rule.targetEntityId,
          severity: rule.severity,
          enabled: !rule.enabled,
          pushOnMatch: rule.pushOnMatch,
        },
        authenticated,
      );
      setTripwires((prev) => prev.map((t) => (t.id === rule.id ? updated : t)));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not update tripwire.");
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await deleteTripwireRule(id, authenticated);
      setTripwires((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Could not delete tripwire.");
    }
  };

  const handleCopyDigest = async () => {
    try {
      await navigator.clipboard.writeText(formatTripwiresDigest(tripwires, matches));
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard fallback ignored
    }
  };

  return (
    <div
      className="tripwires-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tripwires-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tripwires-modal">
        <div className="tripwires-header">
          <div className="tripwires-header-title">
            <div className="tripwires-icon-pill" aria-hidden="true">🚨</div>
            <div>
              <h2 id="tripwires-title">Executive Tripwires &amp; Deep-Linked Push Alerts</h2>
              <p>Always-on background keyword triggers with 4-hour anti-spam cooldown and direct suite deep links</p>
            </div>
          </div>
          <button
            type="button"
            className="tripwires-close-btn"
            onClick={onClose}
            aria-label="Close Executive Tripwires"
          >
            ✕
          </button>
        </div>

        <div className="tripwires-body">
          <div className="tripwires-status-bar">
            <span className="tripwires-sync-badge">
              {authenticated
                ? "🟢 Account SQLite Persistence + Web Push Armed"
                : "🟡 Guest Mode (Browser Storage) — Sign in for background server Web Push alerts"}
            </span>
            <button
              type="button"
              className="tripwires-scan-btn"
              onClick={() => void handleScanNow()}
              disabled={scanning}
            >
              {scanning ? "Scanning Wires..." : "⚡ Scan Live Feed Now"}
            </button>
          </div>

          {errorMsg && (
            <div style={{ color: "#fca5a5", fontSize: "0.84rem", padding: "8px 12px", borderRadius: "8px", background: "rgba(239,68,68,0.12)" }}>
              {errorMsg}
            </div>
          )}

          {/* One-Click Presets */}
          <div>
            <h3 className="tripwires-section-heading">1-Click Executive Watch Templates</h3>
            <div className="tripwires-presets-row">
              {presets.map((preset) => (
                <div key={preset.id} className="tripwire-preset-card">
                  <div className="tripwire-preset-title">{preset.name}</div>
                  <div className="tripwire-preset-meta">
                    Suite: <strong>{preset.targetSuiteId}</strong> • {preset.severity}
                  </div>
                  <div className="tripwire-preset-meta">{preset.keywords.slice(0, 4).join(", ")}</div>
                  <button
                    type="button"
                    className="tripwire-preset-add-btn"
                    disabled={saving}
                    onClick={() => void handleActivatePreset(preset)}
                  >
                    + Activate Tripwire
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Live Feed Matches */}
          <div className="tripwires-matches-box">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h3 className="tripwires-section-heading" style={{ margin: 0, color: "#7dd3fc" }}>
                Live Wire Detections ({matches.length})
              </h3>
              <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{evaluatedInfo}</span>
            </div>

            {matches.length === 0 ? (
              <div style={{ fontSize: "0.82rem", color: "#94a3b8" }}>
                No live headlines tripped active rules on this scan. Click &ldquo;Scan Live Feed Now&rdquo; after refreshing your wires or adjust rule keywords.
              </div>
            ) : (
              matches.map((m, idx) => (
                <div key={`${m.tripwireId}-${idx}`} className="tripwire-match-row">
                  <div className="tripwire-rule-top">
                    <span className="tripwire-rule-name">{m.tripwireName}</span>
                    <span className={`tripwire-severity-pill ${severityClass(m.severity)}`}>{m.severity}</span>
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#e2e8f0" }}>
                    <strong>{m.matchedSource}:</strong> {m.matchedTitle}
                  </div>
                  <div className="tripwire-rule-actions">
                    <div className="tripwire-keywords-row">
                      {m.matchedKeywords.map((kw) => (
                        <span key={kw} className="tripwire-kw-pill">#{kw}</span>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="tripwire-action-btn primary"
                      onClick={() => {
                        onClose();
                        onOpenSuite(m.targetSuiteId, m.targetEntityId || undefined);
                      }}
                    >
                      Open {m.targetSuiteId} {m.targetEntityId ? `(${m.targetEntityId})` : ""} ↗
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Main Grid: Active Monitors & Custom Rule Form */}
          <div className="tripwires-grid">
            <div className="tripwires-card">
              <h3 className="tripwires-section-heading">Your Armed Tripwires ({tripwires.length})</h3>
              {tripwires.length === 0 ? (
                <div style={{ fontSize: "0.82rem", color: "#94a3b8", lineHeight: 1.5 }}>
                  No custom tripwires armed yet. Activate any template above or create a targeted executive monitor on the right.
                </div>
              ) : (
                tripwires.map((rule) => (
                  <div key={rule.id} className="tripwire-rule-item">
                    <div className="tripwire-rule-top">
                      <span className="tripwire-rule-name">
                        {rule.enabled ? "🟢" : "⏸️"} {rule.name}
                      </span>
                      <span className={`tripwire-severity-pill ${severityClass(rule.severity)}`}>
                        {rule.severity}
                      </span>
                    </div>
                    <div className="tripwire-keywords-row">
                      {rule.keywords.map((kw) => (
                        <span key={kw} className="tripwire-kw-pill">{kw}</span>
                      ))}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                      Route: <code>{rule.deepLinkUrl}</code> • Hits: {rule.triggerCount}
                    </div>
                    <div className="tripwire-rule-actions">
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="tripwire-action-btn"
                          onClick={() => void handleToggleRule(rule)}
                        >
                          {rule.enabled ? "Pause" : "Resume"}
                        </button>
                        <button
                          type="button"
                          className="tripwire-action-btn primary"
                          onClick={() => {
                            onClose();
                            onOpenSuite(rule.targetSuiteId, rule.targetEntityId || undefined);
                          }}
                        >
                          Open Suite ↗
                        </button>
                      </div>
                      <button
                        type="button"
                        className="tripwire-action-btn danger"
                        onClick={() => void handleDeleteRule(rule.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <form className="tripwires-card" onSubmit={(e) => void handleCreateCustom(e)}>
              <h3 className="tripwires-section-heading">Arm Custom Executive Tripwire</h3>

              <div className="tripwires-form-group">
                <label htmlFor="tw-name">Tripwire Name</label>
                <input
                  id="tw-name"
                  className="tripwires-input"
                  type="text"
                  placeholder="e.g. Egypt FX Liquidity Alert"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="tripwires-form-group">
                <label htmlFor="tw-keywords">Keywords (comma-separated)</label>
                <input
                  id="tw-keywords"
                  className="tripwires-input"
                  type="text"
                  placeholder="e.g. egypt, suez, devaluation, imf"
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                />
              </div>

              <div className="tripwires-form-group">
                <label htmlFor="tw-suite">Deep-Link Destination Suite</label>
                <select
                  id="tw-suite"
                  className="tripwires-select"
                  value={targetSuiteId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setTargetSuiteId(nextId);
                    const matchedDest = TRIPWIRE_SUITE_DESTINATIONS.find((d) => d.id === nextId);
                    if (matchedDest?.hintFocus && !targetEntityId) {
                      setTargetEntityId(matchedDest.hintFocus);
                    }
                  }}
                >
                  {TRIPWIRE_SUITE_DESTINATIONS.map((dest) => (
                    <option key={dest.id} value={dest.id}>
                      {dest.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="tripwires-form-group">
                <label htmlFor="tw-focus">Optional Focus Entity ID (e.g. egypt, red-sea)</label>
                <input
                  id="tw-focus"
                  className="tripwires-input"
                  type="text"
                  placeholder="Optional focus key"
                  value={targetEntityId}
                  onChange={(e) => setTargetEntityId(e.target.value)}
                />
              </div>

              <div className="tripwires-form-group">
                <label htmlFor="tw-severity">Alert Severity</label>
                <select
                  id="tw-severity"
                  className="tripwires-select"
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  <option value="Critical">Critical</option>
                  <option value="High">High</option>
                  <option value="Elevated">Elevated</option>
                </select>
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.82rem", color: "#cbd5e1", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={pushOnMatch}
                  onChange={(e) => setPushOnMatch(e.target.checked)}
                />
                Send Web Push notification on breaking match (4h cooldown)
              </label>

              <button type="submit" className="tripwires-save-btn" disabled={saving}>
                {saving ? "Saving Tripwire..." : "+ Arm Executive Tripwire"}
              </button>
            </form>
          </div>
        </div>

        <div className="tripwires-footer">
          <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
            Suite #28 • Background refresh evaluates rules automatically when signed in.
            {copied && <strong style={{ color: "#10b981", marginLeft: "0.75rem" }}>✓ Digest Copied</strong>}
          </span>
          <button type="button" className="tripwires-export-btn" onClick={() => void handleCopyDigest()}>
            📋 Copy Tripwires Log (.md)
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExecutiveTripwiresModal;
