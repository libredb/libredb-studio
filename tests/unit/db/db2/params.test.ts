/**
 * What reaches db2-node, before it reaches it (#786).
 *
 * M3. On 1.0.22 a JS `bigint` parameter aborted the whole process (K10), and a `Date` was bound
 * as the text `{}`. db2-node 1.0.24 binds both, measured on Db2 LUW 12.1.0.0 and 11.5.9.0: a
 * bigint of 2^63 - 1 matches the BIGINT it names, and a `Date` arrives as its UTC timestamp. What
 * it still does on its own is bind an array of small integers as BINARY, so an array or a plain
 * object is refused here, before the driver can read it as bytes.
 */

import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { normaliseParams } from "@/lib/db/providers/sql/db2/params";

describe("normaliseParams (M3)", () => {
  test("no parameters stay no parameters, so the driver is handed undefined and not []", () => {
    expect(normaliseParams(undefined)).toBeUndefined();
  });

  test("every scalar, bigint, date and binary value passes through untouched, by identity", () => {
    const buffer = Buffer.from([1, 2]);
    const bytes = new Uint8Array([3]);
    const when = new Date(0);
    const huge = BigInt(2) ** BigInt(63) - BigInt(1);
    const values = ["text", 1.5, null, undefined, true, buffer, bytes, huge, -huge, when];
    const normalised = normaliseParams(values);

    expect(normalised).toEqual(values);
    expect(normalised?.[5]).toBe(buffer);
    expect(normalised?.[6]).toBe(bytes);
    expect(normalised?.[7]).toBe(huge);
    expect(normalised?.[9]).toBe(when);
  });

  // Measured on db2-node 1.0.24: `[[1, 2]]` is bound as BINARY, which a VARCHAR refuses with
  // "expected string-compatible parameter, got Binary([1, 2])", so an array is not text to it.
  test("an array or object parameter is refused by index, a nested bigint included", () => {
    for (const [value, kind] of [
      [[BigInt(1)], "an array"],
      [{ a: BigInt(1) }, "an object"],
      [[1], "an array"],
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
