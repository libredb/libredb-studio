/**
 * The error record's vocabularies, and the kinds a provider may raise (docs/providers/CONTRACT.md, Errors).
 *
 * `ERROR_KINDS` is every kind a record can hold. `PROVIDER_ERROR_KINDS` are the kinds a provider raises, and
 * `CORE_ERROR_KINDS` the kinds only Studio's core raises, each with its reason beside the constant; the two partition
 * the record's kinds, so a kind added to the record is placed in exactly one of them or this file fails.
 */
import { describe, expect, test } from "bun:test";
import {
  CORE_ERROR_KINDS,
  ENGINE_CODE_PATTERN,
  ERROR_KINDS,
  EXECUTE_OUTCOMES,
  PROVIDER_ERROR_KINDS,
  SESSION_STATES,
  SQLSTATE_PATTERN,
} from "@libredb/provider-sdk/errors";

describe("the error kinds", () => {
  test("the kinds a provider raises and the kinds only core raises partition the record's kinds", () => {
    const provider: readonly string[] = PROVIDER_ERROR_KINDS;
    const core: readonly string[] = CORE_ERROR_KINDS;

    expect(provider.filter((kind) => core.includes(kind))).toEqual([]);
    expect([...provider, ...core].sort()).toEqual([...ERROR_KINDS].sort());
    expect(ERROR_KINDS.filter((kind) => provider.includes(kind))).toEqual([...PROVIDER_ERROR_KINDS]);
    expect(ERROR_KINDS.filter((kind) => core.includes(kind))).toEqual([...CORE_ERROR_KINDS]);
    expect(core).toContain("internal");
  });

  test("the record's vocabularies are exported from the errors entry", () => {
    expect(new Set(ERROR_KINDS).size).toBe(ERROR_KINDS.length);
    expect(ERROR_KINDS.length).toBeGreaterThan(0);
    expect([...EXECUTE_OUTCOMES]).toEqual(["not-sent", "unknown"]);
    expect([...SESSION_STATES]).toEqual(["in-transaction", "not-in-transaction", "unknown"]);
    for (const state of ["42P01", "08006", "HY000", "28000"])
      expect({ state, ok: SQLSTATE_PATTERN.test(state) }).toEqual({ state, ok: true });
    for (const state of ["EPIPE", "42p01", "4200", "ABCDE"])
      expect({ state, ok: SQLSTATE_PATTERN.test(state) }).toEqual({ state, ok: false });
    for (const code of ["1146", "ORA-00942", "-204", "SQLITE_ERROR", "NamespaceNotFound"]) {
      expect({ code, ok: ENGINE_CODE_PATTERN.test(code) }).toEqual({ code, ok: true });
    }
    for (const code of ["", "a b", "x".repeat(65)])
      expect({ code, ok: ENGINE_CODE_PATTERN.test(code) }).toEqual({ code, ok: false });
  });
});
