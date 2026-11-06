import React, { useEffect, useState, useRef, useMemo, useCallback } from "react";
import {
  BroadcastTemplate,
  StoryboardResponse,
  StoryboardScene,
  fetchBroadcastTemplates,
  generateStoryboard,
  drawSceneToCanvas,
} from "./briefing-studio.ts";
import "./briefing-studio.css";

interface BriefingStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; summary?: string }>;
}

export function BriefingStudioModal({
  isOpen,
  onClose,
  articles = [],
}: BriefingStudioModalProps) {
  const [templates, setTemplates] = useState<BroadcastTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("threat-matrix");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [storyboard, setStoryboard] = useState<StoryboardResponse | null>(null);
  const [currentSceneIdx, setCurrentSceneIdx] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [sceneProgress, setSceneProgress] = useState<number>(0);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tickerOffsetRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Load templates on open
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadTemplates() {
      try {
        const data = await fetchBroadcastTemplates();
        if (!isCancelled && data.length > 0) {
          setTemplates(data);
          if (!data.some((t) => t.id === selectedTemplateId)) {
            setSelectedTemplateId(data[0].id);
          }
        }
      } catch (err) {
        console.warn("Using default templates:", err);
      }
    }

    loadTemplates();
    return () => {
      isCancelled = true;
    };
  }, [isOpen]);

  // Generate storyboard whenever template, aspect ratio, or articles change
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadStoryboard() {
      try {
        const res = await generateStoryboard(selectedTemplateId, aspectRatio, articles);
        if (!isCancelled) {
          setStoryboard(res);
          setCurrentSceneIdx(0);
          setSceneProgress(0);
        }
      } catch (err) {
        console.error("Failed to generate storyboard:", err);
      }
    }

    loadStoryboard();
    return () => {
      isCancelled = true;
    };
  }, [isOpen, selectedTemplateId, aspectRatio, articles]);

  const activeScene: StoryboardScene | undefined = useMemo(() => {
    return storyboard?.scenes[currentSceneIdx] || storyboard?.scenes[0];
  }, [storyboard, currentSceneIdx]);

  const fullTickerText = useMemo(() => {
    return (storyboard?.tickerHeadlines || [
      "SIGNAL WIRE: Live geopolitical risk and market pulse.",
    ]).join("   •   ");
  }, [storyboard]);

  // Main rendering & animation loop
  const renderFrame = useCallback((timestamp: number) => {
    if (!lastTimeRef.current) lastTimeRef.current = timestamp;
    const delta = (timestamp - lastTimeRef.current) / 1000;
    lastTimeRef.current = timestamp;

    const canvas = canvasRef.current;
    if (canvas && activeScene) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        // Update ticker offset
        tickerOffsetRef.current -= delta * 60; // 60px/sec
        if (tickerOffsetRef.current < -1200) {
          tickerOffsetRef.current = canvas.width;
        }

        // Update progress if playing
        let nextProg = sceneProgress;
        if (isPlaying && activeScene.durationSeconds > 0) {
          nextProg = sceneProgress + delta / activeScene.durationSeconds;
          if (nextProg >= 1.0) {
            // Next scene
            if (storyboard && currentSceneIdx < storyboard.scenes.length - 1) {
              setCurrentSceneIdx((curr) => curr + 1);
              setSceneProgress(0);
              nextProg = 0;
            } else {
              // Loop back to start
              setCurrentSceneIdx(0);
              setSceneProgress(0);
              nextProg = 0;
            }
          } else {
            setSceneProgress(nextProg);
          }
        }

        drawSceneToCanvas(
          ctx,
          activeScene,
          nextProg,
          canvas.width,
          canvas.height,
          fullTickerText,
          tickerOffsetRef.current
        );
      }
    }

    animFrameRef.current = requestAnimationFrame(renderFrame);
  }, [activeScene, fullTickerText, isPlaying, sceneProgress, storyboard, currentSceneIdx]);

  useEffect(() => {
    if (isOpen) {
      animFrameRef.current = requestAnimationFrame(renderFrame);
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isOpen, renderFrame]);

  // Export & record video using MediaRecorder
  const handleRecordVideo = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !storyboard || typeof MediaRecorder === "undefined") {
      alert("MediaRecorder is not supported in this browser. You can export the transcript script.");
      return;
    }

    try {
      setIsRecording(true);
      setCurrentSceneIdx(0);
      setSceneProgress(0);
      setIsPlaying(true);

      const stream = canvas.captureStream(30);
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3000000 });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setRecordedVideoUrl(url);
        setIsRecording(false);

        // Auto-download
        const a = document.createElement("a");
        a.href = url;
        a.download = `Signal_Executive_Brief_${Date.now()}.webm`;
        a.click();
      };

      recorder.start();

      // Record for the total storyboard duration or 15 seconds max demo
      const recordDuration = Math.min(18, storyboard.totalDurationSeconds) * 1000;
      setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, recordDuration);
    } catch (err) {
      console.error("Recording error:", err);
      setIsRecording(false);
    }
  };

  const handleDownloadScript = () => {
    if (!storyboard) return;
    const content = `# SIGNAL EXECUTIVE BROADCAST STORYBOARD
Template: ${storyboard.title}
Aspect Ratio: ${storyboard.aspectRatio}
Total Duration: ${storyboard.totalDurationSeconds}s

${storyboard.scenes
  .map(
    (s) => `## SCENE ${s.sceneIndex}: ${s.headline} (${s.durationSeconds}s)
Subheadline: ${s.subheadline}
Graphic Type: ${s.graphicType}
Narration Voiceover:
"${s.narrationScript}"
`
  )
  .join("\n")}

CONFIDENTIAL - SIGNAL BROADCAST STUDIO`;

    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Signal_Broadcast_Script_${Date.now()}.md`;
    a.click();
  };

  if (!isOpen) return null;

  const canvasWidth = aspectRatio === "16:9" ? 720 : 405;
  const canvasHeight = aspectRatio === "16:9" ? 405 : 720;

  return (
    <div className="studio-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="studio-title">
      <div className="studio-modal-container">
        {/* Header */}
        <div className="studio-header">
          <div className="studio-title-group">
            <span className="studio-title-icon" aria-hidden="true">🎬</span>
            <div>
              <h2 id="studio-title" className="studio-title">Executive Briefing Studio • Autonomous Broadcast Video</h2>
              <p className="studio-subtitle">Generates broadcast TV video digests with animated telemetry, kinetic typography & neural narration</p>
            </div>
          </div>
          <button
            type="button"
            className="studio-close-btn"
            onClick={onClose}
            aria-label="Close Briefing Studio"
          >
            ✕
          </button>
        </div>

        {/* Template & Aspect Ratio Selector Bar */}
        <div className="studio-template-bar">
          <div className="studio-templates-list">
            {templates.map((tmpl) => (
              <button
                key={tmpl.id}
                type="button"
                className={`studio-template-tab ${tmpl.id === selectedTemplateId ? "active" : ""}`}
                onClick={() => setSelectedTemplateId(tmpl.id)}
              >
                <span>📺 {tmpl.title}</span>
                <span style={{ fontSize: "0.7rem", opacity: 0.7 }}>({tmpl.targetDurationSeconds}s)</span>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: "0.35rem" }}>
            <button
              type="button"
              className={`studio-aspect-btn ${aspectRatio === "16:9" ? "active" : ""}`}
              onClick={() => setAspectRatio("16:9")}
              title="16:9 Landscape (Desktop / Board Presentations)"
            >
              16:9 Desktop
            </button>
            <button
              type="button"
              className={`studio-aspect-btn ${aspectRatio === "9:16" ? "active" : ""}`}
              onClick={() => setAspectRatio("9:16")}
              title="9:16 Vertical (Mobile Reel / Teams / Slack)"
            >
              9:16 Mobile
            </button>
          </div>
        </div>

        {/* Studio Body */}
        <div className="studio-body">
          {/* Monitor Canvas Section */}
          <div className="studio-monitor-wrapper">
            <canvas
              ref={canvasRef}
              width={canvasWidth}
              height={canvasHeight}
              className="studio-canvas"
              style={{
                maxHeight: aspectRatio === "16:9" ? "340px" : "460px",
                aspectRatio: aspectRatio === "16:9" ? "16/9" : "9/16",
              }}
            />

            {/* Playback bar */}
            <div className="studio-playback-bar">
              <button
                type="button"
                className="studio-play-btn"
                onClick={() => setIsPlaying(!isPlaying)}
              >
                {isPlaying ? "⏸ Pause" : "▶ Play Preview"}
              </button>

              <div className="studio-scenes-selector">
                {(storyboard?.scenes || []).map((sc, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={`scene-pill ${idx === currentSceneIdx ? "active" : ""}`}
                    onClick={() => {
                      setCurrentSceneIdx(idx);
                      setSceneProgress(0);
                    }}
                  >
                    Scene {idx + 1}
                  </button>
                ))}
              </div>

              <span style={{ fontSize: "0.75rem", color: "#94a3b8", fontFamily: "monospace" }}>
                Total: {storyboard?.totalDurationSeconds || 30}s
              </span>
            </div>
          </div>

          {/* Sidebar: Script & Studio Directives */}
          <div className="studio-sidebar">
            <div>
              <div className="studio-section-title">Current Scene Narration Script</div>
              <div className="studio-narration-box">
                {activeScene ? (
                  <>
                    <strong style={{ color: "#c084fc" }}>Scene {activeScene.sceneIndex}: {activeScene.headline}</strong>
                    <p style={{ margin: "0.4rem 0 0 0" }}>"{activeScene.narrationScript}"</p>
                  </>
                ) : (
                  "Loading narration script..."
                )}
              </div>
            </div>

            <div>
              <div className="studio-section-title">Broadcast Lower-Third Headlines</div>
              <div style={{ fontSize: "0.8rem", color: "#cbd5e1" }}>
                {activeScene?.subheadline}
              </div>
            </div>

            <div className="studio-render-status">
              {isRecording ? (
                <>
                  <span className="recording-indicator" />
                  <span style={{ color: "#ef4444", fontWeight: 700 }}>
                    RECORDING BROADCAST VIDEO (WebM)...
                  </span>
                </>
              ) : recordedVideoUrl ? (
                <span style={{ color: "#10b981", fontWeight: 600 }}>
                  ✓ Video Rendered & Saved
                </span>
              ) : (
                <span>Ready for WebM video rendering & export</span>
              )}
            </div>

            <button
              type="button"
              style={{
                background: "rgba(148, 163, 184, 0.15)",
                color: "#cbd5e1",
                border: "1px solid rgba(148, 163, 184, 0.2)",
                padding: "0.5rem",
                borderRadius: "6px",
                fontSize: "0.78rem",
                cursor: "pointer",
              }}
              onClick={handleDownloadScript}
            >
              📄 Download Storyboard Script (.md)
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="studio-footer">
          <div style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
            Client-side WebM frame synthesizer with hardware acceleration.
          </div>

          <button
            type="button"
            className="studio-record-btn"
            onClick={handleRecordVideo}
            disabled={isRecording}
          >
            {isRecording ? "Rendering..." : "🎥 Render & Export Broadcast Video"}
          </button>
        </div>
      </div>
    </div>
  );
}
