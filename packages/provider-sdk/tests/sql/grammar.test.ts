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

  test("DEFAULT_SQL_GRAMMAR is frozen to its leaves, so no importer changes it for another", () => {
    const mutable = DEFAULT_SQL_GRAMMAR as unknown as { hash: string; trailingLimitClauses: RegExp[] };

    expect(Object.isFrozen(DEFAULT_SQL_GRAMMAR)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SQL_GRAMMAR.script)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SQL_GRAMMAR.trailingLimitClauses)).toBe(true);
    expect(() => {
      mutable.hash = "code";
    }).toThrow(TypeError);
    expect(() => mutable.trailingLimitClauses.push(/\s+X\s*$/i)).toThrow(TypeError);
    expect(DEFAULT_SQL_GRAMMAR.hash).toBe("comment-unless-operator");
    expect(DEFAULT_SQL_GRAMMAR.trailingLimitClauses).toEqual([]);
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
