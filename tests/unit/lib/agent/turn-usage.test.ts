import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage } from "ai";
import { normalizeUsage } from "@/lib/agent/investigation";

/**
 * One usage object in the shape the installed `ai` build hands back.
 *
 * Every field is written rather than left off, because the off case is what several
 * tests below are about: a partial object is the shape a provider sends when it reports
 * something incomplete, and the normalizer has to refuse it rather than round it.
 */
function usage(fields: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cached?: unknown;
  totalTokens?: unknown;
}): LanguageModelUsage {
  return {
    inputTokens: fields.inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: fields.cached,
      cacheWriteTokens: undefined,
    },
    outputTokens: fields.outputTokens,
    outputTokenDetails: { textTokens: fields.outputTokens, reasoningTokens: 0 },
    totalTokens: fields.totalTokens,
  } as unknown as LanguageModelUsage;
}

describe("normalizeUsage", () => {
  test("keeps a whole non-negative figure, with the cached share beside it", () => {
    expect(normalizeUsage(usage({ inputTokens: 1234, outputTokens: 56, cached: 1000 }))).toEqual({
      inputTokens: 1234,
      outputTokens: 56,
      cachedInputTokens: 1000,
    });
  });

  test("returns null when the provider reported nothing at all", () => {
    expect(normalizeUsage(undefined)).toBeNull();
  });

  test("rounds a fractional count, which some servers report for averaged usage", () => {
    expect(normalizeUsage(usage({ inputTokens: 1234.6, outputTokens: 0.4 }))).toEqual({
      inputTokens: 1235,
      outputTokens: 0,
    });
  });

  test("refuses NaN rather than recording a sum that can never bind", () => {
    expect(normalizeUsage(usage({ inputTokens: Number.NaN, outputTokens: 5 }))).toBeNull();
  });

  test("refuses a negative count", () => {
    expect(normalizeUsage(usage({ inputTokens: 5, outputTokens: -1 }))).toBeNull();
  });

  test("refuses a missing output count, so no partial turn is recorded", () => {
    expect(normalizeUsage(usage({ inputTokens: 5 }))).toBeNull();
  });

  test("drops a cached figure larger than the input it is supposed to be part of", () => {
    expect(normalizeUsage(usage({ inputTokens: 10, outputTokens: 1, cached: 11 }))).toEqual({
      inputTokens: 10,
      outputTokens: 1,
    });
  });

  test("omits the cached figure when the server reported no cache detail", () => {
    const normalized = normalizeUsage(usage({ inputTokens: 10, outputTokens: 1 }));
    expect(normalized).toEqual({ inputTokens: 10, outputTokens: 1 });
    expect(normalized && "cachedInputTokens" in normalized).toBe(false);
  });
});
