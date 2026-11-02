export interface AudiogramRenderOptions {
  title: string;
  quote: string;
  source: string;
  edition?: string;
  timestamp?: string;
  waveformFractions: number[]; // e.g. [0.2, 0.5, 0.8, 0.4, ...]
}

export function drawAudiogramCard(
  canvas: HTMLCanvasElement,
  options: AudiogramRenderOptions,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  // 1. Dark executive backdrop with radial spotlight
  ctx.fillStyle = "#090d14";
  ctx.fillRect(0, 0, width, height);

  const gradient = ctx.createRadialGradient(
    width * 0.5,
    height * 0.35,
    50,
    width * 0.5,
    height * 0.5,
    width * 0.7,
  );
  gradient.addColorStop(0, "#13233a");
  gradient.addColorStop(1, "#080c13");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Subtle border
  ctx.strokeStyle = "#1e3a5f";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, width - 4, height - 4);

  // 2. Kicker & Signal Branding
  ctx.font = "bold 20px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  ctx.fillStyle = "#38bdf8";
  ctx.fillText("SIGNAL INTELLIGENCE BRIEFING", 48, 56);

  if (options.source) {
    ctx.font = "600 18px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = "#94a3b8";
    const srcText = `Reported by ${options.source}`;
    const srcWidth = ctx.measureText(srcText).width;
    ctx.fillText(srcText, width - srcWidth - 48, 56);
  }

  // 3. Stylized Quote Mark
  ctx.font = "italic bold 90px Georgia, serif";
  ctx.fillStyle = "rgba(56, 189, 248, 0.18)";
  ctx.fillText("“", 40, 150);

  // 4. Headline / Quote Body Wrapping
  ctx.font = "bold 28px Georgia, serif";
  ctx.fillStyle = "#f8fafc";

  const maxLineWidth = width - 96;
  const words = (options.quote || options.title).split(" ");
  let line = "";
  let y = 180;
  const lineHeight = 40;

  for (const w of words) {
    const testLine = line + w + " ";
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxLineWidth && line.length > 0) {
      ctx.fillText(line.trim(), 48, y);
      line = w + " ";
      y += lineHeight;
      if (y > height - 160) {
        ctx.fillText(line.trim() + "...", 48, y);
        line = "";
        break;
      }
    } else {
      line = testLine;
    }
  }
  if (line.trim().length > 0) {
    ctx.fillText(line.trim(), 48, y);
  }

  // 5. Animated Waveform Bars at Bottom
  const barCount = 36;
  const barWidth = (width - 96 - (barCount - 1) * 6) / barCount;
  const bottomY = height - 64;

  ctx.fillStyle = "#38bdf8";
  const fractions = options.waveformFractions.length >= barCount
    ? options.waveformFractions
    : Array.from({ length: barCount }, (_, i) => 0.2 + 0.6 * Math.abs(Math.sin((i + 1) * 0.4)));

  for (let i = 0; i < barCount; i++) {
    const frac = Math.max(0.08, Math.min(1.0, fractions[i] || 0.2));
    const barHeight = frac * 54;
    const x = 48 + i * (barWidth + 6);
    const by = bottomY - barHeight * 0.5;

    ctx.beginPath();
    ctx.roundRect(x, by, barWidth, barHeight, 4);
    ctx.fill();
  }

  // Timestamp
  if (options.timestamp) {
    ctx.font = "500 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = "#64748b";
    ctx.fillText(options.timestamp, 48, height - 20);
  }
}

export async function copyAudiogramText(
  title: string,
  quote: string,
  source: string,
  url?: string,
  nav: { clipboard?: { writeText: (text: string) => Promise<void> } } = typeof navigator !== "undefined" ? navigator : {},
): Promise<boolean> {
  const content = `“${quote || title}”\n\n— Reporting by ${source}\n${url ? `${url}\n` : ""}Via Signal Executive Intelligence`;
  try {
    if (nav?.clipboard) {
      await nav.clipboard.writeText(content);
      return true;
    }
  } catch {}
  return false;
}
