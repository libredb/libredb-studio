import { describe, test, expect } from "bun:test";
import {
  evaluateThreshold,
  getThresholdColor,
  getThresholdBadgeVariant,
  DEFAULT_THRESHOLDS,
  type ThresholdConfig,
} from "@/lib/monitoring-thresholds";

// ============================================================================
// evaluateThreshold — direction='above'
// ============================================================================

describe("evaluateThreshold (direction=above)", () => {
  const config: ThresholdConfig = {
    metric: "connectionPercent",
    warning: 70,
    critical: 90,
    direction: "above",
    label: "Connection Usage",
  };

  test("value below warning returns healthy", () => {
    expect(evaluateThreshold(50, config)).toBe("healthy");
  });

  test("value at warning returns warning", () => {
    expect(evaluateThreshold(70, config)).toBe("warning");
  });

  test("value between warning and critical returns warning", () => {
    expect(evaluateThreshold(80, config)).toBe("warning");
  });

  test("value at critical returns critical", () => {
    expect(evaluateThreshold(90, config)).toBe("critical");
  });

  test("value above critical returns critical", () => {
    expect(evaluateThreshold(99, config)).toBe("critical");
  });
});

// ============================================================================
// evaluateThreshold — direction='below'
// ============================================================================

describe("evaluateThreshold (direction=below)", () => {
  const config: ThresholdConfig = {
    metric: "cacheHitRatio",
    warning: 90,
    critical: 80,
    direction: "below",
    label: "Cache Hit Ratio",
  };

  test("value above warning returns healthy", () => {
    expect(evaluateThreshold(95, config)).toBe("healthy");
  });

  test("value at warning returns warning", () => {
    expect(evaluateThreshold(90, config)).toBe("warning");
  });

  test("value between warning and critical returns warning", () => {
    expect(evaluateThreshold(85, config)).toBe("warning");
  });

  test("value at critical returns critical", () => {
    expect(evaluateThreshold(80, config)).toBe("critical");
  });

  test("value below critical returns critical", () => {
    expect(evaluateThreshold(50, config)).toBe("critical");
  });
});

// ============================================================================
// getThresholdColor
// ============================================================================

describe("getThresholdColor", () => {
  /**
   * Green and yellow, not the emerald-based `success` and amber-based `warning`
   * roles. The monitoring surfaces have always drawn their threshold ring in
   * green/yellow/red, and routing them through the state roles would have changed
   * the hue in dark — so they take the identity hues that reproduce it exactly
   * (#402). The drift between the two vocabularies is real and is filed, but it is
   * not this migration's to resolve.
   */
  test("healthy returns the green identity ring", () => {
    const color = getThresholdColor("healthy");
    expect(color).toBe("border-hue-green-tint/30");
  });

  test("warning returns the yellow identity ring", () => {
    const color = getThresholdColor("warning");
    expect(color).toBe("border-hue-yellow-tint/50");
  });

  test("critical returns the danger border token", () => {
    const color = getThresholdColor("critical");
    expect(color).toBe("border-danger-tint/50");
  });
});

// ============================================================================
// getThresholdBadgeVariant
// ============================================================================

describe("getThresholdBadgeVariant", () => {
  test('healthy returns "secondary"', () => {
    expect(getThresholdBadgeVariant("healthy")).toBe("secondary");
  });

  test('warning returns "outline"', () => {
    expect(getThresholdBadgeVariant("warning")).toBe("outline");
  });

  test('critical returns "destructive"', () => {
    expect(getThresholdBadgeVariant("critical")).toBe("destructive");
  });
});

// ============================================================================
// DEFAULT_THRESHOLDS
// ============================================================================

describe("DEFAULT_THRESHOLDS", () => {
  test("contains expected metric names", () => {
    const metrics = DEFAULT_THRESHOLDS.map((t) => t.metric);
    expect(metrics).toContain("cacheHitRatio");
    expect(metrics).toContain("connectionPercent");
    expect(metrics).toContain("deadlocks");
    expect(metrics).toContain("bufferPoolUsage");
  });

  test("has 4 default thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toHaveLength(4);
  });
});
