"use client";

import React, { useState, useEffect } from "react";
import {
  simulateScenario,
  formatScenarioClipboard,
  type ScenarioSimulationResult,
} from "./scenario-simulator";
import "./scenario-simulator.css";

export interface ScenarioSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialScenario?: string;
  baselineAssets?: Array<{ symbol: string; name: string; price: number; percentChange?: number; changePercent?: number }>;
}

const PRESET_SCENARIOS = [
  "RBNZ accelerates cash rate cuts by 50bps amid cooling inflation",
  "Port logistics industrial action halts container freight for 10 days",
  "Major trading partner imposes 15% reciprocal agricultural tariffs",
  "Severe grid transmission failure impacts Auckland commercial hubs",
];

export default function ScenarioSimulatorModal({
  isOpen,
  onClose,
  initialScenario = PRESET_SCENARIOS[0],
  baselineAssets = [],
}: ScenarioSimulatorModalProps) {
  const [scenarioInput, setScenarioInput] = useState(initialScenario);
  const [data, setData] = useState<ScenarioSimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setScenarioInput(initialScenario || PRESET_SCENARIOS[0]);
    void runSimulation(initialScenario || PRESET_SCENARIOS[0]);
  }, [initialScenario, isOpen]);

  const runSimulation = async (scenario: string) => {
    if (!scenario.trim()) return;
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await simulateScenario(scenario, baselineAssets);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runSimulation(scenarioInput);
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatScenarioClipboard(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Scenario Playbook copied!");
        setTimeout(() => setCopyFeedback(""), 3500);
      }
    } catch {}
  };

  if (!isOpen) return null;

  return (
    <div className="scenario-sim-backdrop" role="dialog" aria-modal="true" aria-labelledby="scenario-sim-title">
      <div className="scenario-sim-modal">
        <header className="scenario-sim-header">
          <h2 id="scenario-sim-title" className="scenario-sim-title">
            🎲 Boardroom Scenario Simulator
          </h2>
          <button
            type="button"
            className="scenario-sim-close-btn"
            onClick={onClose}
            aria-label="Close scenario simulator"
          >
            &times;
          </button>
        </header>

        <div className="scenario-sim-body">
          <div className="scenario-sim-presets-row">
            {PRESET_SCENARIOS.map((preset, idx) => (
              <button
                key={idx}
                type="button"
                className={`scenario-sim-preset-btn${scenarioInput === preset ? " active" : ""}`}
                onClick={() => {
                  setScenarioInput(preset);
                  void runSimulation(preset);
                }}
              >
                {preset.length > 40 ? preset.slice(0, 38) + "..." : preset}
              </button>
            ))}
          </div>

          <form className="scenario-sim-input-row" onSubmit={handleSubmit}>
            <input
              type="text"
              className="scenario-sim-input"
              value={scenarioInput}
              onChange={(e) => setScenarioInput(e.target.value)}
              placeholder="Describe a macro or operational shock to stress-test..."
              aria-label="Hypothetical scenario"
            />
            <button type="submit" className="scenario-sim-run-btn" disabled={loading}>
              {loading ? "Simulating..." : "Stress Test"}
            </button>
          </form>

          {data && (
            <>
              <div className="scenario-sim-score-banner">
                <div>
                  <div className="scenario-sim-score-val">{data.resilienceScore}/100</div>
                  <div className="scenario-sim-score-label">Corporate Resilience Index</div>
                </div>
                <div className={`scenario-sim-risk-badge${data.resilienceScore < 50 ? " critical" : ""}`}>
                  {data.riskLevel}
                </div>
              </div>

              <div>
                <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", color: "#94a3b8", marginBottom: "0.5rem" }}>
                  Multi-Order Cascading Impacts
                </h3>
                <div className="scenario-sim-order-flow">
                  {data.impacts.map((imp, idx) => (
                    <div key={idx} className="scenario-sim-order-card">
                      <div className="scenario-sim-order-header">
                        <span className={`scenario-sim-order-pill order-${imp.orderLevel}`}>
                          {imp.orderLevel === 1 ? "1st Order (Immediate)" : imp.orderLevel === 2 ? "2nd Order (Operational)" : "3rd Order (Structural)"}
                        </span>
                        <span style={{ fontSize: "0.75rem", color: imp.severity === "High" ? "#f87171" : "#fbbf24", fontWeight: 700 }}>
                          [{imp.severity}]
                        </span>
                      </div>
                      <div className="scenario-sim-order-domain">{imp.domain}</div>
                      <p className="scenario-sim-order-summary">{imp.impactSummary}</p>
                      <div className="scenario-sim-order-channel">
                        <span>⚡ Transmission:</span> {imp.transmissionChannel}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", color: "#94a3b8", marginBottom: "0.5rem" }}>
                  Mitigation Playbook
                </h3>
                {data.mitigationPlan.map((m, idx) => (
                  <div key={idx} className="scenario-sim-mitigation-card">
                    <div className="scenario-sim-mitigation-priority">{m.priority}</div>
                    <div className="scenario-sim-mitigation-action">{m.action}</div>
                    <div className="scenario-sim-mitigation-owner">Responsible: {m.ownerRole}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <footer className="scenario-sim-footer">
          {copyFeedback ? (
            <span style={{ color: "#34d399", fontSize: "0.85rem", fontWeight: 600 }}>{copyFeedback}</span>
          ) : (
            <span style={{ color: "#64748b", fontSize: "0.8rem" }}>
              Actionable what-if modeling across liquidity, supply chain & governance
            </span>
          )}
          <button
            type="button"
            className="scenario-sim-export-btn"
            onClick={handleCopy}
            disabled={!data}
          >
            📑 Export Playbook
          </button>
        </footer>
      </div>
    </div>
  );
}
