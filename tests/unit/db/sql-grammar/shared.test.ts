import { describe, expect, test } from "bun:test";
import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS, REDACTED_VALUE, SQLITE_GRAMMAR } from "@/lib/db/sql-grammar/shared";
import { DEFAULT_SQL_GRAMMAR as GRAMMAR_DEFAULT, resolveSqlGrammar } from "@/lib/sql/grammar";

describe("sql grammar shared building blocks", () => {
  test("DEFAULT_SQL_GRAMMAR is the one @/lib/sql/grammar exports, with today's facts", () => {
    expect(DEFAULT_SQL_GRAMMAR).toBe(GRAMMAR_DEFAULT);
    expect(DEFAULT_SQL_GRAMMAR).toEqual({
      hash: "comment-unless-operator",
      bracket: "quoted-identifier",
      blockComment: "flat",
      alternateQuoting: false,
      doubleSlashComment: false,
      backslashAlwaysEscapes: false,
      script: { blocks: "none", separatorLine: null, unit: "statement" },
      trailingLimitClauses: [],
    });
  });

  test("SQLITE_GRAMMAR is the one grammar sqlite and libsql share", () => {
    expect(SQLITE_GRAMMAR).toBe(resolveSqlGrammar("sqlite"));
    expect(SQLITE_GRAMMAR).toBe(resolveSqlGrammar("libsql"));
    expect(SQLITE_GRAMMAR.hash).toBe("code");
    expect(SQLITE_GRAMMAR.bracket).toBe("quoted-identifier");
    expect(SQLITE_GRAMMAR.script.blocks).toBe("trigger-body");
  });

  test("NO_EXTRA_WORDS is empty", () => {
    expect(NO_EXTRA_WORDS.size).toBe(0);
  });

  test("REDACTED_VALUE is the redaction placeholder", () => {
    expect(REDACTED_VALUE).toBe("?");
  });
});
