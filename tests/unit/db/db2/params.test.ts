/**
 * What reaches db2-node 1.0.22, before it reaches it (#786).
 *
 * M3: a JS `bigint` bound as a parameter panics inside the driver's Rust code and aborts the
 * whole process, which no `try` can catch (K10). The check below is the only thing between a
 * caller and that abort, so every arm of it is pinned here.
 *
 * The leading-comment strip: db2-node 1.0.22 refuses a statement that STARTS with a comment
 * (SQLSTATE 42612, SQLCODE -84, measured on 12.1.0.0 for both `/* a *\/ SELECT 1 ...` and
 * `-- a\nSELECT 1 ...`), while a comment anywhere after the first keyword is accepted.
 */

import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { driverStatement, normaliseParams } from "@/lib/db/providers/sql/db2/params";

describe("normaliseParams (M3)", () => {
  test("no parameters stay no parameters, so the driver is handed undefined and not []", () => {
    expect(normaliseParams(undefined)).toBeUndefined();
  });

  test("a bigint inside the safe integer range becomes the same number", () => {
    expect(normaliseParams([BigInt(42), BigInt(-7), BigInt(0)])).toEqual([42, -7, 0]);
    expect(normaliseParams([BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MIN_SAFE_INTEGER)])).toEqual([
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ]);
  });

  test("a bigint above the safe range is refused by index and value, before the driver sees it", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    let caught: unknown;
    try {
      normaliseParams(["a", tooBig]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).provider).toBe("db2");
    expect((caught as Error).message).toContain("Parameter 2");
    expect((caught as Error).message).toContain(String(tooBig));
    expect((caught as Error).message).toContain("aborts the process");
  });

  test("a bigint below the safe range is refused the same way", () => {
    expect(() => normaliseParams([-(BigInt(2) ** BigInt(60))])).toThrow(
      /Parameter 1 is a bigint outside the safe integer range/,
    );
  });

  test("every scalar and binary value passes through untouched, by identity", () => {
    const buffer = Buffer.from([1, 2]);
    const bytes = new Uint8Array([3]);
    const values = ["text", 1.5, null, undefined, true, buffer, bytes];
    const normalised = normaliseParams(values);

    expect(normalised).toEqual(values);
    expect(normalised?.[5]).toBe(buffer);
    expect(normalised?.[6]).toBe(bytes);
  });

  // Measured on db2-node 1.0.22: `[[1n]]` and `[{ a: 1n }]` abort the process with a core dump,
  // exactly as a top-level bigint does, and a `Date` or a `Map` is bound as the text `{}`.
  test("an array or object parameter is refused by index, a nested bigint included", () => {
    for (const [value, kind] of [
      [[BigInt(1)], "an array"],
      [{ a: BigInt(1) }, "an object"],
      [[1], "an array"],
      [new Date(0), "an object"],
      [new Map(), "an object"],
    ] as const) {
      let caught: unknown;
      try {
        normaliseParams(["a", value]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(QueryError);
      expect((caught as QueryError).provider).toBe("db2");
      expect((caught as Error).message).toContain(`Parameter 2 is ${kind}`);
    }
  });

  test("a symbol or function parameter is refused too", () => {
    expect(() => normaliseParams([Symbol("x")])).toThrow(/Parameter 1 is a symbol/);
    expect(() => normaliseParams([() => 1])).toThrow(/Parameter 1 is a function/);
  });
});

describe("driverStatement", () => {
  test("a statement with no leading trivia is sent as written", () => {
    expect(driverStatement("SELECT 1 FROM SYSIBM.SYSDUMMY1 -- tail")).toBe("SELECT 1 FROM SYSIBM.SYSDUMMY1 -- tail");
  });

  test("leading block and line comments are dropped, with the whitespace around them", () => {
    expect(driverStatement("/* a */ SELECT 1 FROM SYSIBM.SYSDUMMY1")).toBe("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    expect(driverStatement("-- a\n  -- b\nSELECT 1")).toBe("SELECT 1");
    expect(driverStatement("\n /* x */\n-- y\n\tVALUES 1")).toBe("VALUES 1");
  });

  test("a nested block comment is read the way Db2 reads it, as one comment", () => {
    expect(driverStatement("/* a /* b */ still a comment */ SELECT 1")).toBe("SELECT 1");
  });

  test("a comment after the first keyword is kept", () => {
    expect(driverStatement("-- lead\nSELECT /* keep */ 1")).toBe("SELECT /* keep */ 1");
  });

  test("an unterminated leading comment is sent as written, so the server answers for it", () => {
    expect(driverStatement("/* never closed SELECT 1")).toBe("/* never closed SELECT 1");
  });

  test("a statement that is only comments is sent as written", () => {
    expect(driverStatement("-- nothing here")).toBe("-- nothing here");
  });

  test("a leading string literal is code, not trivia", () => {
    expect(driverStatement("'x'")).toBe("'x'");
  });
});
