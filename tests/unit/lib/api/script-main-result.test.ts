import { describe, expect, test } from "bun:test";
import { mainResultRowCount, pickScriptMainResult, type ScriptStatementOutcome } from "@/lib/api/script-main-result";

type Outcome = ScriptStatementOutcome & { label?: string };

const success = (over: Partial<Outcome> = {}): Outcome => ({ status: "success", ...over });
const error = (over: Partial<Outcome> = {}): Outcome => ({ status: "error", ...over });

describe("pickScriptMainResult", () => {
  test("returns undefined for an empty script", () => {
    expect(pickScriptMainResult([])).toBeUndefined();
  });

  test("shows the last statement when it returns rows, even if an earlier one did too", () => {
    const results = [success({ rows: [{ a: 1 }], fields: ["a"] }), success({ rows: [{ b: 2 }], fields: ["b"] })];
    expect(pickScriptMainResult(results)?.fields).toEqual(["b"]);
  });

  test("shows a final empty SELECT with columns instead of an earlier nonempty SELECT (#2271)", () => {
    const results = [
      success({ rows: [{ status: "Before", count: 100 }], fields: ["status", "count"] }),
      success({ rows: [], fields: ["status", "count"] }),
    ];
    const picked = pickScriptMainResult(results);
    expect(picked?.rows).toEqual([]);
    expect(picked?.fields).toEqual(["status", "count"]);
  });

  test("shows a final DML with zero affected rows instead of an earlier SELECT (#2271)", () => {
    const results = [
      success({ rows: [{ n: 1 }], fields: ["n"], rowCount: 1 }),
      success({ rows: [], fields: [], rowCount: 0 }),
    ];
    const picked = pickScriptMainResult(results);
    expect(picked?.rows).toEqual([]);
    expect(picked?.fields).toEqual([]);
    expect(picked?.rowCount).toBe(0);
  });

  test("keeps an earlier SELECT when the final INSERT changed rows but has no grid (documented UX)", () => {
    const results = [
      success({ rows: [{ id: 1 }], fields: ["id"], rowCount: 1 }),
      success({ rows: [], fields: [], rowCount: 1 }),
    ];
    expect(pickScriptMainResult(results)?.rows).toEqual([{ id: 1 }]);
  });

  test("keeps the last successful statement before a failure (#1385)", () => {
    const results = [success({ rows: [{ id: 1 }], fields: ["id"] }), error()];
    expect(pickScriptMainResult(results)?.rows).toEqual([{ id: 1 }]);
  });

  test("falls back to the last entry when every statement failed", () => {
    const results = [error({ error: "boom" })];
    expect(pickScriptMainResult(results)?.status).toBe("error");
  });

  test("uses a lone DML statement when the script has no rowset anywhere", () => {
    const results = [success({ rows: [], fields: [], rowCount: 3 })];
    expect(pickScriptMainResult(results)?.rowCount).toBe(3);
  });
});

describe("mainResultRowCount", () => {
  test("prefers rowCount when it is present", () => {
    expect(mainResultRowCount(success({ rows: [{ a: 1 }], fields: ["a"], rowCount: 99 }))).toBe(99);
  });

  test("uses row length when rowCount is absent", () => {
    expect(mainResultRowCount(success({ rows: [{ a: 1 }, { a: 2 }], fields: ["a"] }))).toBe(2);
  });

  test("returns zero when there is no main result", () => {
    expect(mainResultRowCount(undefined)).toBe(0);
  });
});
