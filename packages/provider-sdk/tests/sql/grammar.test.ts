/**
 * The SQL grammar facts' type and compatibility default, and the one pure reading of them the SDK carries
 * (docs/providers/CONTRACT.md, clause S-1).
 */
import { describe, expect, test } from "bun:test";
import * as packageRoot from "@libredb/provider-sdk";
import { DEFAULT_SQL_GRAMMAR, hashRunIsAmbiguous, type SqlGrammar } from "@libredb/provider-sdk/sql";

describe("the SQL grammar surface", () => {
  test("DEFAULT_SQL_GRAMMAR is the compatibility reading", () => {
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

  test("hashRunIsAmbiguous is true only for the compatibility reading of #", () => {
    const reading = (hash: SqlGrammar["hash"]): SqlGrammar => ({ ...DEFAULT_SQL_GRAMMAR, hash });

    expect(hashRunIsAmbiguous(reading("comment-unless-operator"))).toBe(true);
    expect(hashRunIsAmbiguous(reading("comment"))).toBe(false);
    expect(hashRunIsAmbiguous(reading("code"))).toBe(false);
  });

  test("the package root exports the SQL grammar surface", () => {
    expect(packageRoot.DEFAULT_SQL_GRAMMAR).toBe(DEFAULT_SQL_GRAMMAR);
    expect(packageRoot.hashRunIsAmbiguous).toBe(hashRunIsAmbiguous);
  });
});
