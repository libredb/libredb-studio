import { describe, expect, test } from "bun:test";

// Ensure `typeof window !== 'undefined'` passes in data-masking.ts SSR guards
if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — minimal window stub for SSR guard
  globalThis.window = globalThis;
}

import { DEFAULT_MASKING_CONFIG, maskAiSummaryValue, type MaskingConfig } from "@/lib/data-masking";

describe("maskAiSummaryValue", () => {
  test("masks a column a built-in pattern matches", () => {
    expect(maskAiSummaryValue("email", "alice@example.com", DEFAULT_MASKING_CONFIG)).toBe("a****@e**********");
  });

  test("leaves a column no pattern matches unchanged", () => {
    expect(maskAiSummaryValue("name", "Alice", DEFAULT_MASKING_CONFIG)).toBe("Alice");
  });

  test("masks by default even while the global masking switch is off", () => {
    const disabled: MaskingConfig = { ...DEFAULT_MASKING_CONFIG, enabled: false };
    // The built-in Password pattern stays enabled; only the global switch is off.
    expect(maskAiSummaryValue("password", "hunter2", disabled)).toBe("********");
  });

  test("masks a repeated column name through its base", () => {
    expect(maskAiSummaryValue("email (2)", "bob@example.com", DEFAULT_MASKING_CONFIG)).toBe("b**@e**********");
  });

  test("reads a missing value as N/A, the summary's prose spelling", () => {
    expect(maskAiSummaryValue("email", null, DEFAULT_MASKING_CONFIG)).toBe("N/A");
    expect(maskAiSummaryValue("email", undefined, DEFAULT_MASKING_CONFIG)).toBe("N/A");
  });

  test('"revealed" passes the value through unmasked', () => {
    expect(maskAiSummaryValue("email", "alice@example.com", DEFAULT_MASKING_CONFIG, "revealed")).toBe(
      "alice@example.com",
    );
    expect(maskAiSummaryValue("name", "Alice", DEFAULT_MASKING_CONFIG, "revealed")).toBe("Alice");
  });

  test('"revealed" still reads a missing value as N/A', () => {
    expect(maskAiSummaryValue("email", null, DEFAULT_MASKING_CONFIG, "revealed")).toBe("N/A");
  });

  test("a disabled pattern masks nothing, matching the grid's own detection", () => {
    const withDisabled: MaskingConfig = {
      ...DEFAULT_MASKING_CONFIG,
      patterns: DEFAULT_MASKING_CONFIG.patterns.map((p) =>
        p.id === "builtin-email" ? Object.assign({}, p, { enabled: false }) : p,
      ),
    };
    expect(maskAiSummaryValue("email", "alice@example.com", withDisabled)).toBe("alice@example.com");
  });
});
