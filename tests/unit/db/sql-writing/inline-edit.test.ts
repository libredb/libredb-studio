import { describe, expect, test } from "bun:test";
import { MSSQL_SQL_WRITING } from "@/lib/db/providers/sql/mssql-sql-writing";
import { ORACLE_SQL_WRITING } from "@/lib/db/providers/sql/oracle-sql-writing";
import type { InlineEditSpec } from "@/lib/db/sql-writing/types";

/**
 * The two engines that bind an inline edit through a form of their own: Oracle wraps a date
 * or timestamp edit around its `:n` placeholder (#1807), and SQL Server binds the `T` form of
 * a `datetime` or `smalldatetime` text so the session's DATEFORMAT reads nothing (#1452).
 *
 * `bind` records what it was handed and answers the engine's own placeholder, so each case
 * states both the SET right-hand side and the value bound into it.
 */
function boundEditOf(spec: { readonly inlineEdit: InlineEditSpec }) {
  const boundEdit = spec.inlineEdit.boundEdit;
  if (boundEdit === undefined) throw new Error("expected a boundEdit");
  return boundEdit;
}

function run(
  spec: { readonly inlineEdit: InlineEditSpec },
  placeholder: (position: number) => string,
  text: string,
  declaredType: string | undefined,
) {
  const bound: string[] = [];
  const rhs = boundEditOf(spec)(text, declaredType, (value) => {
    bound.push(value);
    return placeholder(bound.length);
  });
  return { rhs, bound };
}

describe("oracle boundEdit", () => {
  const oracle = (text: string, declaredType: string | undefined) =>
    run(ORACLE_SQL_WRITING, (position) => `:${position}`, text, declaredType);

  test.each(["DATE", "date"])("a wall clock in a %s column goes through TO_DATE", (declaredType) => {
    expect(oracle("2026-10-04 12:34:56", declaredType)).toEqual({
      rhs: "TO_DATE(:1, 'YYYY-MM-DD HH24:MI:SS')",
      bound: ["2026-10-04 12:34:56"],
    });
  });

  test("a BC date takes the signed mask", () => {
    expect(oracle("-0044-03-15 12:00:00", "DATE")).toEqual({
      rhs: "TO_DATE(:1, 'SYYYY-MM-DD HH24:MI:SS')",
      bound: ["-0044-03-15 12:00:00"],
    });
  });

  test("a TIMESTAMP with no fraction goes through TO_TIMESTAMP", () => {
    expect(oracle("2026-10-04 12:34:56", "TIMESTAMP")).toEqual({
      rhs: "TO_TIMESTAMP(:1, 'YYYY-MM-DD HH24:MI:SS')",
      bound: ["2026-10-04 12:34:56"],
    });
  });

  test("a TIMESTAMP with a fraction reads it through FF", () => {
    expect(oracle("2026-10-04 12:34:56.123456", "TIMESTAMP(6)")).toEqual({
      rhs: "TO_TIMESTAMP(:1, 'YYYY-MM-DD HH24:MI:SS.FF')",
      bound: ["2026-10-04 12:34:56.123456"],
    });
  });

  test.each(["TIMESTAMP(6) WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE"])(
    "an ISO instant in a %s column is bound as its UTC wall clock",
    (declaredType) => {
      expect(oracle("2026-10-04T09:34:56.123Z", declaredType)).toEqual({
        rhs: "FROM_TZ(TO_TIMESTAMP(:1, 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC')",
        bound: ["2026-10-04 09:34:56.123"],
      });
    },
  );

  test.each([
    ["2026-10-04 12:34:56.5", "DATE"],
    ["2026-10-04T09:34:56.123Z", "TIMESTAMP"],
    ["2026-02-30T00:00:00.000Z", "TIMESTAMP WITH TIME ZONE"],
    ["2026-10-04 12:34:56", "VARCHAR2(30)"],
    ["2026-10-04 12:34:56", undefined],
  ] as const)("%p in %p binds nothing of its own", (text, declaredType) => {
    expect(oracle(text, declaredType)).toEqual({ rhs: undefined, bound: [] });
  });
});

describe("mssql boundEdit", () => {
  const mssql = (text: string, declaredType: string | undefined) =>
    run(MSSQL_SQL_WRITING, (position) => `@p${position}`, text, declaredType);

  test("a datetime text is bound in its T form", () => {
    expect(mssql("2026-10-04 12:34:57.123", "datetime")).toEqual({
      rhs: "@p1",
      bound: ["2026-10-04T12:34:57.123"],
    });
  });

  test.each([
    ["2026-10-04 12:34:00", "smalldatetime", "2026-10-04T12:34:00"],
    ["2026-10-04 12:34:57", "DATETIME", "2026-10-04T12:34:57"],
    ["2026-10-04 12:34:57", "Nullable(datetime)", "2026-10-04T12:34:57"],
  ] as const)("%p in %p is bound as %p", (text, declaredType, expected) => {
    expect(mssql(text, declaredType)).toEqual({ rhs: "@p1", bound: [expected] });
  });

  test.each([
    ["2026-10-04 12:34:57.123", "datetime2"],
    ["2026-10-04 12:34:57.1234", "datetime"],
    ["2026-10-04", "datetime"],
    ["2026-10-04 12:34:57", undefined],
  ] as const)("%p in %p binds nothing of its own", (text, declaredType) => {
    expect(mssql(text, declaredType)).toEqual({ rhs: undefined, bound: [] });
  });
});
