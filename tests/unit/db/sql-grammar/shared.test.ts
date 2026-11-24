import { describe, expect, test } from "bun:test";
import { NO_EXTRA_WORDS, REDACTED_VALUE } from "@/lib/db/sql-grammar/shared";

describe("sql grammar shared building blocks", () => {
  test("the shared blocks are NO_EXTRA_WORDS and REDACTED_VALUE", async () => {
    expect(Object.keys(await import("@/lib/db/sql-grammar/shared")).sort()).toEqual([
      "NO_EXTRA_WORDS",
      "REDACTED_VALUE",
    ]);
  });

  test("NO_EXTRA_WORDS is empty", () => {
    expect(NO_EXTRA_WORDS.size).toBe(0);
  });

  test("REDACTED_VALUE is the redaction placeholder", () => {
    expect(REDACTED_VALUE).toBe("?");
  });
});
