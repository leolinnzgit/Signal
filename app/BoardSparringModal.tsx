import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  SparringPersona,
  DialogTurn,
  PostureTelemetry,
  SparringScorecard,
  fetchSparringPersonas,
  sendSparringTurn,
  fetchSparringScorecard,
  getGaugeColor,
  formatScorecardMemo,
} from "./board-sparring.ts";
import "./board-sparring.css";

interface BoardSparringModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function BoardSparringModal({ isOpen, onClose }: BoardSparringModalProps) {
  const [personas, setPersonas] = useState<SparringPersona[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>("carl-vance");
  const [dialogHistory, setDialogHistory] = useState<DialogTurn[]>([]);
  const [inputText, setInputText] = useState<string>("");
  const [posture, setPosture] = useState<PostureTelemetry>({
    leverage: 50,
    credibility: 65,
    defensiveness: 30,
    concessionVelocity: 20,
  });
  const [traps, setTraps] = useState<string[]>([]);
  const [recommendedPivot, setRecommendedPivot] = useState<string>("");
  const [isSending, setIsSending] = useState<boolean>(false);
  const [scorecard, setScorecard] = useState<SparringScorecard | null>(null);
  const [showScorecard, setShowScorecard] = useState<boolean>(false);
  const [copiedMemo, setCopiedMemo] = useState<boolean>(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load personas
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadData() {
      try {
        const data = await fetchSparringPersonas();
        if (!isCancelled && data.length > 0) {
          setPersonas(data);
          const initial = data.find((p) => p.id === selectedPersonaId) || data[0];
          setSelectedPersonaId(initial.id);
          setDialogHistory([{ sender: "adversary", text: initial.openingStatement }]);
        }
      } catch (err) {
        console.warn("Using default personas:", err);
      }
    }

    loadData();
    return () => {
      isCancelled = true;
    };
  }, [isOpen]);

  const activePersona = useMemo(() => {
    return personas.find((p) => p.id === selectedPersonaId) || personas[0];
  }, [personas, selectedPersonaId]);

  // Switch persona
  const handleSelectPersona = (pId: string) => {
    setSelectedPersonaId(pId);
    const target = personas.find((p) => p.id === pId);
    if (target) {
      setDialogHistory([{ sender: "adversary", text: target.openingStatement }]);
      setTraps([]);
      setRecommendedPivot("");
      setPosture({ leverage: 50, credibility: 65, defensiveness: 30, concessionVelocity: 20 });
      setShowScorecard(false);
      setScorecard(null);
    }
  };

  // Scroll to bottom on dialog update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [dialogHistory, isSending]);

  const handleSend = async (overrideText?: string) => {
    const textToSend = overrideText || inputText.trim();
    if (!textToSend || isSending || !activePersona) return;

    setInputText("");
    const updatedHistory: DialogTurn[] = [...dialogHistory, { sender: "user", text: textToSend }];
    setDialogHistory(updatedHistory);
    setIsSending(true);

    try {
      const res = await sendSparringTurn(activePersona.id, textToSend, updatedHistory);
      setDialogHistory((prev) => [...prev, { sender: "adversary", text: res.adversaryReply }]);
      setPosture(res.posture);
      setTraps(res.trapsDetected);
      setRecommendedPivot(res.recommendedPivot);
    } catch (err) {
      console.error("Sparring error:", err);
      setDialogHistory((prev) => [
        ...prev,
        {
          sender: "adversary",
          text: "Let's stick strictly to audited facts. What specific metrics substantiate that posture?",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const handleGenerateScorecard = async () => {
    if (!activePersona) return;
    try {
      const sc = await fetchSparringScorecard(activePersona.id, dialogHistory);
      setScorecard(sc);
      setShowScorecard(true);
    } catch (err) {
      console.error("Scorecard error:", err);
    }
  };

  const handleCopyScorecard = async () => {
    if (!activePersona || !scorecard) return;
    const memo = formatScorecardMemo(activePersona, scorecard, dialogHistory);
    try {
      await navigator.clipboard.writeText(memo);
      setCopiedMemo(true);
      setTimeout(() => setCopiedMemo(false), 2500);
    } catch {
      // Fallback
    }
  };

  if (!isOpen) return null;

  return (
    <div className="sparring-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="sparring-title">
      <div className="sparring-modal-container">
        {/* Header */}
        <div className="sparring-header">
          <div className="sparring-title-group">
            <span className="sparring-title-icon" aria-hidden="true">🤺</span>
            <div>
              <h2 id="sparring-title" className="sparring-title">Boardroom Sparring & Negotiation Arena</h2>
              <p className="sparring-subtitle">Tactical executive sparring against adversarial activist, regulatory & short-seller personas</p>
            </div>
          </div>
          <button
            type="button"
            className="sparring-close-btn"
            onClick={onClose}
            aria-label="Close Sparring Arena"
          >
            ✕
          </button>
        </div>

        {/* Persona Switcher Bar */}
        <div className="sparring-persona-bar">
          {personas.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`persona-tab ${p.id === selectedPersonaId ? "active" : ""}`}
              onClick={() => handleSelectPersona(p.id)}
            >
              <span>{p.avatarEmoji}</span>
              <span>{p.name} ({p.archetype})</span>
            </button>
          ))}
        </div>

        {/* Body Split */}
        <div className="sparring-body">
          {/* Main Chat Pane or Scorecard */}
          {showScorecard && scorecard ? (
            <div className="sparring-scorecard-modal">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, color: "#f8fafc", fontSize: "1.1rem" }}>
                    Executive Sparring Evaluation
                  </h3>
                  <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                    Adversary: {activePersona?.name} • {activePersona?.organization}
                  </span>
                </div>
                <div className="scorecard-grade-badge">{scorecard.overallGrade}</div>
              </div>

              <div style={{ background: "rgba(30, 41, 59, 0.5)", padding: "0.75rem", borderRadius: "6px" }}>
                <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.25rem" }}>
                  BOARDROOM READINESS SCORE
                </div>
                <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "#38bdf8" }}>
                  {scorecard.executiveReadinessScore} / 100
                </div>
              </div>

              <div>
                <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#10b981", marginBottom: "0.35rem" }}>
                  DEMONSTRATED STRENGTHS
                </div>
                <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.8rem", color: "#cbd5e1" }}>
                  {scorecard.strengths.map((s, idx) => (
                    <li key={idx} style={{ marginBottom: "0.25rem" }}>{s}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#f87171", marginBottom: "0.35rem" }}>
                  EXPOSURE POINTS & VULNERABILITIES
                </div>
                <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.8rem", color: "#cbd5e1" }}>
                  {scorecard.vulnerabilities.map((v, idx) => (
                    <li key={idx} style={{ marginBottom: "0.25rem" }}>{v}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#f59e0b", marginBottom: "0.35rem" }}>
                  TACTICAL BOARDROOM RECOMMENDATIONS
                </div>
                <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.8rem", color: "#cbd5e1" }}>
                  {scorecard.tacticalRecommendations.map((r, idx) => (
                    <li key={idx} style={{ marginBottom: "0.25rem" }}>{r}</li>
                  ))}
                </ul>
              </div>

              <div style={{ display: "flex", gap: "0.75rem", marginTop: "auto" }}>
                <button
                  type="button"
                  style={{
                    background: "#0284c7",
                    color: "#fff",
                    border: "none",
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "0.8rem",
                    fontWeight: 600,
                  }}
                  onClick={handleCopyScorecard}
                >
                  {copiedMemo ? "✓ Debrief Copied" : "📋 Copy Executive Debrief"}
                </button>
                <button
                  type="button"
                  style={{
                    background: "rgba(148, 163, 184, 0.2)",
                    color: "#cbd5e1",
                    border: "none",
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "0.8rem",
                  }}
                  onClick={() => setShowScorecard(false)}
                >
                  Resume Sparring
                </button>
              </div>
            </div>
          ) : (
            <div className="sparring-chat-pane">
              <div className="sparring-chat-messages">
                {dialogHistory.map((turn, idx) => {
                  const isAdversary = turn.sender === "adversary";
                  return (
                    <div key={idx} className={`sparring-msg ${turn.sender}`}>
                      <div className="sparring-avatar">
                        {isAdversary ? activePersona?.avatarEmoji : "👔"}
                      </div>
                      <div className="sparring-bubble">{turn.text}</div>
                    </div>
                  );
                })}
                {isSending && (
                  <div className="sparring-msg adversary">
                    <div className="sparring-avatar">{activePersona?.avatarEmoji}</div>
                    <div className="sparring-bubble" style={{ color: "#94a3b8", fontStyle: "italic" }}>
                      Analyzing counter-position and leverage...
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Detected Traps Alert */}
              {traps.length > 0 && (
                <div className="sparring-traps-container">
                  {traps.map((trap, idx) => (
                    <div key={idx} className="sparring-trap-item">
                      <span>⚠️</span>
                      <span>{trap}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Recommended Pivot Chip */}
              {recommendedPivot && (
                <div
                  className="sparring-pivot-chip"
                  onClick={() => handleSend(recommendedPivot.replace(/^Pivot:\s*['"]?/, "").replace(/['"]?$/, ""))}
                  role="button"
                  tabIndex={0}
                  title="Click to execute this recommended pivot"
                >
                  <strong>💡 Recommended Pivot:</strong> {recommendedPivot}
                </div>
              )}

              {/* Input bar */}
              <div className="sparring-input-bar">
                <input
                  type="text"
                  className="sparring-input-field"
                  placeholder={`Respond to ${activePersona?.name}...`}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  disabled={isSending}
                />
                <button
                  type="button"
                  className="sparring-send-btn"
                  onClick={() => handleSend()}
                  disabled={isSending || !inputText.trim()}
                >
                  Spar 🥊
                </button>
              </div>
            </div>
          )}

          {/* Telemetry HUD Sidebar */}
          <div className="sparring-telemetry-hud">
            <div className="hud-section-title">Tactical Posture Telemetry</div>

            {/* Leverage Meter */}
            <div className="posture-meter-row">
              <div className="meter-header">
                <span>Bargaining Leverage</span>
                <span style={{ fontWeight: 700, color: getGaugeColor(posture.leverage) }}>
                  {posture.leverage}%
                </span>
              </div>
              <div className="meter-bar-track">
                <div
                  className="meter-bar-fill"
                  style={{ width: `${posture.leverage}%`, background: getGaugeColor(posture.leverage) }}
                />
              </div>
            </div>

            {/* Credibility Meter */}
            <div className="posture-meter-row">
              <div className="meter-header">
                <span>Evidentiary Credibility</span>
                <span style={{ fontWeight: 700, color: getGaugeColor(posture.credibility) }}>
                  {posture.credibility}%
                </span>
              </div>
              <div className="meter-bar-track">
                <div
                  className="meter-bar-fill"
                  style={{ width: `${posture.credibility}%`, background: getGaugeColor(posture.credibility) }}
                />
              </div>
            </div>

            {/* Defensiveness Meter (Inverted) */}
            <div className="posture-meter-row">
              <div className="meter-header">
                <span>Emotional Defensiveness</span>
                <span style={{ fontWeight: 700, color: getGaugeColor(posture.defensiveness, true) }}>
                  {posture.defensiveness}%
                </span>
              </div>
              <div className="meter-bar-track">
                <div
                  className="meter-bar-fill"
                  style={{
                    width: `${posture.defensiveness}%`,
                    background: getGaugeColor(posture.defensiveness, true),
                  }}
                />
              </div>
            </div>

            {/* Concession Velocity (Inverted) */}
            <div className="posture-meter-row">
              <div className="meter-header">
                <span>Concession Velocity</span>
                <span style={{ fontWeight: 700, color: getGaugeColor(posture.concessionVelocity, true) }}>
                  {posture.concessionVelocity}%
                </span>
              </div>
              <div className="meter-bar-track">
                <div
                  className="meter-bar-fill"
                  style={{
                    width: `${posture.concessionVelocity}%`,
                    background: getGaugeColor(posture.concessionVelocity, true),
                  }}
                />
              </div>
            </div>

            {/* Active Pressure Points */}
            <div style={{ marginTop: "0.5rem" }}>
              <div className="hud-section-title">Adversary Pressure Points</div>
              <div className="sparring-pressure-box">
                {activePersona?.pressurePoints.map((point, idx) => (
                  <span key={idx} className="pressure-tag">
                    • {point}
                  </span>
                ))}
              </div>
            </div>

            {/* Conclude & Scorecard button */}
            <button
              type="button"
              style={{
                marginTop: "auto",
                background: "linear-gradient(90deg, #b91c1c, #991b1b)",
                color: "#ffffff",
                border: "none",
                padding: "0.6rem 1rem",
                borderRadius: "6px",
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: "pointer",
                transition: "all 0.15s ease",
              }}
              onClick={handleGenerateScorecard}
            >
              🏁 Conclude & Score Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
