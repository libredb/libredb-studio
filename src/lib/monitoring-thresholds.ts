export type ThresholdLevel = "healthy" | "warning" | "critical";

export interface ThresholdConfig {
  metric: string;
  warning: number;
  critical: number;
  direction: "above" | "below";
  label: string;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig[] = [
  { metric: "cacheHitRatio", warning: 90, critical: 80, direction: "below", label: "Cache Hit Ratio" },
  { metric: "connectionPercent", warning: 70, critical: 90, direction: "above", label: "Connection Usage" },
  { metric: "deadlocks", warning: 1, critical: 5, direction: "above", label: "Deadlocks" },
  { metric: "bufferPoolUsage", warning: 85, critical: 95, direction: "above", label: "Buffer Pool Usage" },
];

export function thresholdFor(thresholds: ThresholdConfig[], metric: string): ThresholdConfig {
  const config =
    thresholds.find((threshold) => threshold.metric === metric) ??
    DEFAULT_THRESHOLDS.find((threshold) => threshold.metric === metric);
  if (!config) throw new Error(`Unknown monitoring metric: ${metric}`);
  return config;
}

export function evaluateThreshold(value: number, config: ThresholdConfig): ThresholdLevel {
  if (config.direction === "above") {
    if (value >= config.critical) return "critical";
    if (value >= config.warning) return "warning";
    return "healthy";
  } else {
    if (value <= config.critical) return "critical";
    if (value <= config.warning) return "warning";
    return "healthy";
  }
}

export function getThresholdColor(level: ThresholdLevel): string {
  switch (level) {
    case "critical":
      return "border-hue-red-tint/50";
    case "warning":
      return "border-hue-yellow-tint/50";
    case "healthy":
      return "border-hue-green-tint/30";
  }
}

export function getThresholdBadgeVariant(level: ThresholdLevel): "destructive" | "outline" | "secondary" {
  switch (level) {
    case "critical":
      return "destructive";
    case "warning":
      return "outline";
    case "healthy":
      return "secondary";
  }
}
