/**
 * Executive Briefing Studio (Autonomous Broadcast Video Generator) Client Engine
 * Renders cinematic broadcast video frames onto HTML5 Canvas with kinetic graphics,
 * lower-thirds, telemetry bars, and records output via MediaRecorder / WebM.
 */

export interface BroadcastTemplate {
  id: string;
  title: string;
  targetDurationSeconds: number;
  aspectRatios: string[];
  themeColor: string;
  description: string;
}

export interface GraphicDataPoint {
  label: string;
  value: string;
  color?: string;
}

export interface StoryboardScene {
  sceneIndex: number;
  durationSeconds: number;
  headline: string;
  subheadline: string;
  narrationScript: string;
  graphicType: "bar-chart" | "threat-dial" | "ticker-alert" | "quote-focus";
  graphicData: GraphicDataPoint[];
}

export interface StoryboardResponse {
  title: string;
  templateId: string;
  aspectRatio: string;
  totalDurationSeconds: number;
  tickerHeadlines: string[];
  scenes: StoryboardScene[];
  generatedAt: string;
}

/**
 * Draws a broadcast scene onto an HTML5 Canvas context
 */
export function drawSceneToCanvas(
  ctx: CanvasRenderingContext2D,
  scene: StoryboardScene,
  progressRatio: number, // 0.0 to 1.0
  width: number,
  height: number,
  tickerText: string,
  tickerOffset: number
): void {
  // 1. Dark Broadcast Background
  ctx.fillStyle = "#070b14";
  ctx.fillRect(0, 0, width, height);

  // Gradient vignette
  const grad = ctx.createRadialGradient(width / 2, height / 2, width * 0.1, width / 2, height / 2, width * 0.7);
  grad.addColorStop(0, "rgba(30, 58, 138, 0.15)");
  grad.addColorStop(1, "rgba(3, 7, 18, 0.95)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Top header banner
  ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
  ctx.fillRect(0, 0, width, 40);
  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.fillText("SIGNAL INTELLIGENCE • EXECUTIVE BROADCAST STUDIO", 20, 25);

  const sceneProgressText = `SCENE ${scene.sceneIndex} • ${(progressRatio * scene.durationSeconds).toFixed(1)}s / ${scene.durationSeconds}s`;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px monospace";
  ctx.textAlign = "right";
  ctx.fillText(sceneProgressText, width - 20, 25);
  ctx.textAlign = "left";

  // Center Graphic Visualization
  const centerY = height * 0.45;
  const paddingX = 40;
  const availableWidth = width - paddingX * 2;

  if (scene.graphicType === "bar-chart" || scene.graphicType === "threat-dial") {
    const itemCount = scene.graphicData.length;
    const itemHeight = Math.min(42, (height * 0.32) / Math.max(1, itemCount));

    scene.graphicData.forEach((dp, idx) => {
      const y = centerY - 60 + idx * (itemHeight + 12);
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText(dp.label, paddingX, y + 14);

      // Value badge
      ctx.fillStyle = dp.color || "#38bdf8";
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(dp.value, width - paddingX, y + 14);
      ctx.textAlign = "left";

      // Animated meter bar
      const barY = y + 20;
      const barWidth = availableWidth;
      ctx.fillStyle = "rgba(51, 65, 85, 0.4)";
      ctx.fillRect(paddingX, barY, barWidth, 4);

      const animatedWidth = Math.min(1, progressRatio * 1.5) * barWidth * ((idx + 1) / (itemCount + 1));
      ctx.fillStyle = dp.color || "#38bdf8";
      ctx.fillRect(paddingX, barY, animatedWidth, 4);
    });
  } else {
    // Alert / Ticker list
    scene.graphicData.forEach((dp, idx) => {
      const y = centerY - 50 + idx * 36;
      ctx.fillStyle = "#f59e0b";
      ctx.font = "bold 12px monospace";
      ctx.fillText(`▸ ${dp.label.toUpperCase()}:`, paddingX, y);

      ctx.fillStyle = "#e2e8f0";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText(dp.value, paddingX + 130, y);
    });
  }

  // Lower Third Headline Card
  const lowerThirdY = height - 90;
  ctx.fillStyle = "rgba(15, 23, 42, 0.95)";
  ctx.fillRect(0, lowerThirdY, width, 55);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(0, lowerThirdY, 6, 55);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.fillText(scene.headline, 24, lowerThirdY + 24);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(scene.subheadline, 24, lowerThirdY + 44);

  // Bottom Ticker Crawl Tape
  const tickerY = height - 26;
  ctx.fillStyle = "#020617";
  ctx.fillRect(0, tickerY, width, 26);
  ctx.fillStyle = "rgba(148, 163, 184, 0.15)";
  ctx.fillRect(0, tickerY, width, 1);

  ctx.fillStyle = "#facc15";
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.fillText("LIVE WIRE", 12, tickerY + 17);

  // Scrolling ticker text
  ctx.save();
  ctx.rect(90, tickerY, width - 90, 26);
  ctx.clip();
  ctx.fillStyle = "#f1f5f9";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(tickerText, 90 + tickerOffset, tickerY + 17);
  ctx.restore();
}

/**
 * Client API fetchers
 */
export async function fetchBroadcastTemplates(): Promise<BroadcastTemplate[]> {
  const res = await fetch("/api/briefing-studio/templates", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load templates: HTTP ${res.status}`);
  return res.json();
}

export async function generateStoryboard(
  templateId: string,
  aspectRatio: string,
  articles?: Array<{ title: string; source: string; summary?: string }>
): Promise<StoryboardResponse> {
  const res = await fetch("/api/briefing-studio/storyboard", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      templateId,
      aspectRatio,
      articles: articles ?? [],
    }),
  });
  if (!res.ok) throw new Error(`Failed to generate storyboard: HTTP ${res.status}`);
  return res.json();
}
