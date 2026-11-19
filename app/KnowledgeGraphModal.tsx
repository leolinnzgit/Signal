"use client";

import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  fetchKnowledgeGraph,
  formatKnowledgeGraphDigest,
  getCategoryColor,
  initializeSimulation,
  stepSimulation,
  type KnowledgeGraphResponse,
  type SimulatedNode,
  type GraphNode,
} from "./knowledge-graph";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./knowledge-graph.css";

export interface KnowledgeGraphModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  preferredVoice?: string;
}

const CATEGORIES = [
  "All Entities",
  "Organization",
  "Person",
  "Regulator",
  "Geopolitical",
  "Commodity",
];

export default function KnowledgeGraphModal({
  isOpen,
  onClose,
  articles = [],
  preferredVoice,
}: KnowledgeGraphModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [data, setData] = useState<KnowledgeGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("All Entities");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simNodesRef = useRef<SimulatedNode[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Pan & Zoom
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const isDraggingCanvas = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const draggedNode = useRef<SimulatedNode | null>(null);

  const stopAudio = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      cancelListeningSpeech();
    }
    setIsPlayingAudio(false);
  };

  useEffect(() => {
    if (!isOpen) {
      stopAudio();
      return;
    }

    void loadGraph();

    return () => {
      stopAudio();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const loadGraph = async () => {
    setLoading(true);
    try {
      const res = await fetchKnowledgeGraph({ articles });
      setData(res);

      // Initialize simulation positions
      const w = window.innerWidth * 0.8;
      const h = window.innerHeight * 0.7;
      simNodesRef.current = initializeSimulation(res.nodes, w, h);
    } catch {
      // Degrade gracefully
    } finally {
      setLoading(false);
    }
  };

  // Canvas render loop
  useEffect(() => {
    if (!isOpen || !canvasRef.current || !data) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animActive = true;

    const render = () => {
      if (!animActive) return;

      const width = canvas.width;
      const height = canvas.height;

      // Physics step
      stepSimulation(simNodesRef.current, data.edges, width, height, 0.08);

      // Clear background
      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);

      const nodeMap = new Map(simNodesRef.current.map((n) => [n.id, n]));

      // 1. Draw Edges
      for (const edge of data.edges) {
        const s = nodeMap.get(edge.source);
        const t = nodeMap.get(edge.target);
        if (!s || !t) continue;

        const isHighlighted =
          selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId);

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.strokeStyle = isHighlighted
          ? "#38bdf8"
          : `rgba(148, 163, 184, ${0.15 + edge.weight * 0.25})`;
        ctx.lineWidth = isHighlighted ? 2.5 : Math.max(1, edge.weight * 2);
        ctx.stroke();

        // Edge label if highlighted
        if (isHighlighted) {
          const midX = (s.x + t.x) / 2;
          const midY = (s.y + t.y) / 2;
          ctx.fillStyle = "#38bdf8";
          ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
          ctx.textAlign = "center";
          ctx.fillText(edge.relationshipType, midX, midY - 6);
        }
      }

      // 2. Draw Nodes
      for (const node of simNodesRef.current) {
        const isSelected = selectedNodeId === node.id;
        const isDimmed =
          (selectedCategory !== "All Entities" && node.category !== selectedCategory) ||
          (searchQuery && !node.label.toLowerCase().includes(searchQuery.toLowerCase()));

        ctx.save();
        ctx.globalAlpha = isDimmed ? 0.25 : 1.0;

        // Outer glow on selected
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 8, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(56, 189, 248, 0.25)";
          ctx.fill();
        }

        // Main node body
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = getCategoryColor(node.category);
        ctx.fill();
        ctx.lineWidth = isSelected ? 3 : 1.5;
        ctx.strokeStyle = isSelected ? "#ffffff" : "rgba(255, 255, 255, 0.4)";
        ctx.stroke();

        // Label
        ctx.fillStyle = isSelected ? "#38bdf8" : "#f8fafc";
        ctx.font = isSelected
          ? "bold 13px -apple-system, sans-serif"
          : "11px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(node.label, node.x, node.y + node.radius + 15);

        ctx.restore();
      }

      ctx.restore();

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      animActive = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isOpen, data, pan, zoom, selectedNodeId, selectedCategory, searchQuery]);

  // Canvas resize handler
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }, [isOpen]);

  // Pointer interactions
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left - pan.x) / zoom;
    const mouseY = (e.clientY - rect.top - pan.y) / zoom;

    // Check hit on node
    const hit = simNodesRef.current.find((n) => {
      const dx = n.x - mouseX;
      const dy = n.y - mouseY;
      return Math.sqrt(dx * dx + dy * dy) <= n.radius + 6;
    });

    if (hit) {
      draggedNode.current = hit;
      setSelectedNodeId(hit.id);
    } else {
      isDraggingCanvas.current = true;
      dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      setSelectedNodeId(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggedNode.current && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      draggedNode.current.x = (e.clientX - rect.left - pan.x) / zoom;
      draggedNode.current.y = (e.clientY - rect.top - pan.y) / zoom;
      draggedNode.current.vx = 0;
      draggedNode.current.vy = 0;
    } else if (isDraggingCanvas.current) {
      setPan({
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      });
    }
  };

  const handleMouseUp = () => {
    draggedNode.current = null;
    isDraggingCanvas.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom((z) => Math.max(0.4, Math.min(2.5, z * delta)));
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatKnowledgeGraphDigest(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Knowledge graph intelligence copied to clipboard!");
        setTimeout(() => setCopyFeedback(""), 3500);
      }
    } catch {}
  };

  const fallbackSpeech = (script: string) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      cancelListeningSpeech();
      const utterance = new SpeechSynthesisUtterance(script);
      utterance.rate = 1.15;
      utterance.onend = () => setIsPlayingAudio(false);
      utterance.onerror = () => setIsPlayingAudio(false);
      setIsPlayingAudio(true);
      speakListeningSpeech(utterance, () => setIsPlayingAudio(false));
    } else {
      setIsPlayingAudio(false);
    }
  };

  const handleToggleAudio = async () => {
    if (isPlayingAudio) {
      stopAudio();
      return;
    }

    if (!data?.spokenAudioScript) return;

    stopAudio();

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const streamUrl = await openArticleAudioStream(
        [data.spokenAudioScript],
        "en-NZ",
        { en: activeVoice, zh: "zh-CN-XiaoxiaoNeural" },
        controller.signal,
        () => {},
      );

      if (controller.signal.aborted) return;

      if (streamUrl) {
        const audio = createListeningAudio(streamUrl, () => setIsPlayingAudio(false));
        audioRef.current = audio;
        audio.onended = () => {
          setIsPlayingAudio(false);
          audioRef.current = null;
        };
        audio.onerror = () => {
          fallbackSpeech(data.spokenAudioScript);
        };
        await audio.play();
        setIsPlayingAudio(true);
        return;
      }

      fallbackSpeech(data.spokenAudioScript);
    } catch {
      fallbackSpeech(data.spokenAudioScript);
    }
  };

  const selectedNode = useMemo(() => {
    if (!selectedNodeId || !data) return null;
    return data.nodes.find((n) => n.id === selectedNodeId) || null;
  }, [selectedNodeId, data]);

  const selectedNodeEdges = useMemo(() => {
    if (!selectedNodeId || !data) return [];
    return data.edges.filter(
      (e) => e.source === selectedNodeId || e.target === selectedNodeId
    );
  }, [selectedNodeId, data]);

  if (!isOpen) return null;

  return (
    <div
      className="kg-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="kg-hud-title"
    >
      <div className="kg-hud-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="kg-hud-header">
          <div className="kg-hud-title-wrap">
            <span className="kg-hud-icon" aria-hidden="true">🌐</span>
            <div>
              <h2 id="kg-hud-title" className="kg-hud-title">
                Interactive Intelligence Knowledge Graph
              </h2>
              <div className="kg-hud-subtitle">
                Systemic Entity Network • Co-Occurrence Vectors • Strategic Clusters
              </div>
            </div>
          </div>
          <div className="kg-hud-controls">
            <button
              type="button"
              className={`kg-btn kg-btn-audio ${isPlayingAudio ? "active" : ""}`}
              onClick={handleToggleAudio}
              disabled={!data || loading}
              title="Spoken Network Analysis Briefing (Azure Neural Voice)"
              aria-label={isPlayingAudio ? "Stop Audio Dispatch" : "Play Network Audio Dispatch"}
            >
              <span aria-hidden="true">{isPlayingAudio ? "⏹️" : "🔊"}</span>
              <span>{isPlayingAudio ? "Stop Dispatch" : "Audio Dispatch"}</span>
            </button>
            <button
              type="button"
              className="kg-btn kg-btn-copy"
              onClick={handleCopy}
              disabled={!data || loading}
              title="Copy Knowledge Graph Digest to Clipboard"
            >
              📋 Copy Digest
            </button>
            <button
              type="button"
              className="kg-btn-close"
              onClick={onClose}
              aria-label="Close Knowledge Graph"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="kg-toolbar">
          <div className="kg-filter-bar">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`kg-filter-chip ${selectedCategory === cat ? "active" : ""}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="kg-search-box">
            <span style={{ marginRight: "0.4rem", color: "#64748b" }}>🔍</span>
            <input
              type="text"
              className="kg-search-input"
              placeholder="Filter entity..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Viewport & Canvas */}
        <div className="kg-viewport">
          <canvas
            ref={canvasRef}
            className="kg-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
          />

          {/* Node Inspector Drawer */}
          {selectedNode && (
            <div className="kg-inspector">
              <div className="kg-inspector-top">
                <div>
                  <h3 className="kg-inspector-title">{selectedNode.label}</h3>
                  <span
                    className="kg-inspector-category"
                    style={{
                      background: `${getCategoryColor(selectedNode.category)}22`,
                      color: getCategoryColor(selectedNode.category),
                      border: `1px solid ${getCategoryColor(selectedNode.category)}55`,
                    }}
                  >
                    {selectedNode.category}
                  </span>
                </div>
                <button
                  type="button"
                  className="kg-btn-close"
                  onClick={() => setSelectedNodeId(null)}
                  title="Close Inspector"
                >
                  ✕
                </button>
              </div>

              <div className="kg-metrics-row">
                <div className="kg-metric-card">
                  <div className="kg-metric-val">{selectedNode.mentionCount}</div>
                  <div className="kg-metric-label">Mentions</div>
                </div>
                <div className="kg-metric-card">
                  <div className="kg-metric-val">
                    {selectedNode.sentimentScore > 0 ? `+${selectedNode.sentimentScore}` : selectedNode.sentimentScore}
                  </div>
                  <div className="kg-metric-label">Sentiment</div>
                </div>
              </div>

              <div className="kg-inspector-context">
                {selectedNode.primaryContext}
              </div>

              <div className="kg-links-heading">
                Systemic Linkages ({selectedNodeEdges.length})
              </div>
              <div className="kg-links-list">
                {selectedNodeEdges.map((e, idx) => {
                  const targetId = e.source === selectedNode.id ? e.target : e.source;
                  return (
                    <div
                      key={idx}
                      className="kg-link-item"
                      onClick={() => setSelectedNodeId(targetId)}
                    >
                      <div className="kg-link-target">{targetId}</div>
                      <div className="kg-link-rel">
                        {e.relationshipType} ({Math.round(e.weight * 100)}%)
                      </div>
                      <div className="kg-link-desc">{e.summary}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Strategic Clusters Bar */}
        <div className="kg-clusters-bar">
          {(data?.clusters || []).map((cluster, i) => (
            <div key={i} className="kg-cluster-card">
              <div className="kg-cluster-title">{cluster.clusterName}</div>
              <div className="kg-cluster-theme">{cluster.dominantTheme}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
