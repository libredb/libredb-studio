import { describe, expect, test } from "bun:test";
import { NO_EXTRA_WORDS, REDACTED_VALUE, SQLITE_GRAMMAR } from "@/lib/db/sql-grammar/shared";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

describe("sql grammar shared building blocks", () => {
  test("the shared blocks are SQLITE_GRAMMAR, NO_EXTRA_WORDS and REDACTED_VALUE", async () => {
    expect(Object.keys(await import("@/lib/db/sql-grammar/shared")).sort()).toEqual([
      "NO_EXTRA_WORDS",
      "REDACTED_VALUE",
      "SQLITE_GRAMMAR",
    ]);
  });

  test("SQLITE_GRAMMAR is the one grammar sqlite and libsql share", () => {
    expect(SQLITE_GRAMMAR).toBe(resolveSqlGrammar("sqlite"));
    expect(SQLITE_GRAMMAR).toBe(resolveSqlGrammar("libsql"));
    expect(SQLITE_GRAMMAR.hash).toBe("code");
    expect(SQLITE_GRAMMAR.bracket).toBe("quoted-identifier");
    expect(SQLITE_GRAMMAR.script.blocks).toBe("trigger-body");
  });

  test("SQLITE_GRAMMAR declares the confirmation forms of the INSERTs that replace rows", () => {
    // OR REPLACE is the one conflict algorithm that deletes a row already there; OR ROLLBACK, OR ABORT, OR FAIL and OR
    // IGNORE leave it (SQLite reference, "The ON CONFLICT Clause").
    expect(SQLITE_GRAMMAR.confirmForms).toEqual([
      ["REPLACE", "INTO"],
      ["INSERT", "OR", "REPLACE"],
    ]);
    expect(SQLITE_GRAMMAR.confirmCodeForms).toBeUndefined();
  });

  test("NO_EXTRA_WORDS is empty", () => {
    expect(NO_EXTRA_WORDS.size).toBe(0);
  });

  test("REDACTED_VALUE is the redaction placeholder", () => {
    expect(REDACTED_VALUE).toBe("?");
  });
});
