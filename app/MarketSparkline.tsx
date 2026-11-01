import { useId } from "react";
import { buildSparklineGeometry } from "./market-quote.ts";

export interface MarketSparklineProps {
  points?: readonly number[] | null;
  isPositive?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

export function MarketSparkline({
  points,
  isPositive,
  width = 56,
  height = 18,
  className,
}: MarketSparklineProps) {
  const gradientId = useId();
  const geometry = buildSparklineGeometry(points, width, height);
  if (!geometry) return null;

  const up = typeof isPositive === "boolean" ? isPositive : geometry.isUp;
  const strokeColor = up ? "#22c55e" : "#ef4444";

  return (
    <svg
      className={className ? `market-sparkline-svg ${className}` : "market-sparkline-svg"}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.32" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={geometry.areaPath} fill={`url(#${gradientId})`} />
      <path
        d={geometry.linePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
