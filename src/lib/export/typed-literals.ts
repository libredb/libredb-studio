import type { DatabaseType } from "@/lib/types";
import { sqlWritingFor } from "@/lib/db/sql-writing";
import { UnwritableValue } from "@/lib/db/sql-writing/export-shared";
import type { ScalarLiteral } from "@/lib/db/sql-writing/types";

/**
 * The cells of an exported INSERT that need their column's DECLARED type to be written
 * back as something the engine takes (#1386).
 *
 * The plain value writer in `result-export.ts` has one form per JavaScript type, and a
 * result reaches the export after a trip through JSON: a Postgres `integer[]` is a JS
 * array, an `interval` is an object of named parts and a ClickHouse `Map` is an object.
 * Written in that generic form, each was refused on replay (measured 2026-10-03/04):
 * PostgreSQL 18.6 `malformed array literal` for `'[1,2,3]'`, ClickHouse `Cannot parse
 * quoted string` for `'{"k":1}'` into a `Map`, and SQL Server `Msg 207 Invalid column name
 * 'true'` for a BIT, which takes the whole batch with it.
 *
 * The SAME value is legitimately something else under another declaration, which is why
 * nothing here looks at the value alone: a JS array in a `jsonb` column is JSON and stays
 * the quoted JSON text, and only an array in a column declared `integer[]` is a Postgres
 * array. A dialect whose `export` field declares no `typedLiteral`, or a cell its writer
 * has no form for, answers `undefined` and is written by the generic writer exactly as
 * before.
 *
 * Each engine's writer lives beside its provider under `src/lib/db/providers/sql/`, and
 * its `SqlWritingSpec` names it as `export.typedLiteral`.
 */

// The two names the tests and `result-export.ts` read from here, now declared in the
// engine-neutral export leaf and the contract's types.
export { UnwritableValue };
export type { ScalarLiteral };

/**
 * `value` as the literal `dialect` reads back into a column declared `declared`, or
 * `undefined` when the generic writer's form is already the right one. Throws
 * `UnwritableValue` for a cell the dialect has no literal for.
 */
export function typedLiteral(
  value: unknown,
  declared: unknown,
  dialect: DatabaseType | undefined,
  scalar: ScalarLiteral,
): string | undefined {
  if (value === null || value === undefined || dialect === undefined) return undefined;
  // `columnTypes` is the host's data until checked, so only a string is a declaration.
  return sqlWritingFor(dialect).export.typedLiteral?.(
    value,
    typeof declared === "string" ? declared : undefined,
    scalar,
  );
}
