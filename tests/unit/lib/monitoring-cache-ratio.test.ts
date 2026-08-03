import { describe, test, expect } from "bun:test";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio } from "@/lib/monitoring-cache-ratio";

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
