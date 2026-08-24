import { describe, test, expect } from "bun:test";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

describe("formatCacheHitRatio", () => {
  test("formats a measured ratio to one decimal place", () => {
    expect(formatCacheHitRatio(95.74)).toBe("95.7");
  });

  test("keeps a trailing zero so the string always carries one decimal", () => {
    expect(formatCacheHitRatio(100)).toBe("100.0");
  });

  test("formats a measured zero as a real measurement, not as unavailable", () => {
    expect(formatCacheHitRatio(0)).toBe("0.0");
    expect(formatCacheHitRatio(0)).not.toBe(CACHE_HIT_RATIO_UNAVAILABLE);
  });

  test("reports an unmeasured ratio as unavailable rather than inventing a number", () => {
    expect(formatCacheHitRatio(undefined)).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
  });
});

describe("CACHE_HIT_RATIO_UNAVAILABLE", () => {
  test('uses the spelling the repo already uses for an unavailable ratio ("N/A")', () => {
    expect(CACHE_HIT_RATIO_UNAVAILABLE).toBe("N/A");
  });
});

describe("measuredNumber", () => {
  test("passes a real reading through unchanged", () => {
    expect(measuredNumber(99.5)).toBe(99.5);
  });

  test("keeps a measured zero, which is a reading and not an absence", () => {
    expect(measuredNumber(0)).toBe(0);
  });

  test("accepts the numeric strings the SQL drivers hand back", () => {
    // pg returns NUMERIC as a string to preserve precision, and oracledb/mssql
    // hand back DECIMAL the same way when the value overflows a JS number.
    expect(measuredNumber("98.75")).toBe(98.75);
    expect(measuredNumber("0")).toBe(0);
  });

  test("reports a SQL NULL as absent rather than as zero", () => {
    // The whole point: every one of these providers reaches a one-row-of-NULLs
    // answer (NULLIF guards a division by zero), and 0 is a red critical rating.
    expect(measuredNumber(null)).toBeUndefined();
  });

  test("reports a missing column as absent", () => {
    expect(measuredNumber(undefined)).toBeUndefined();
  });

  test("reports an unparseable value as absent rather than as NaN", () => {
    expect(measuredNumber("N/A")).toBeUndefined();
    expect(measuredNumber({})).toBeUndefined();
    expect(measuredNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
