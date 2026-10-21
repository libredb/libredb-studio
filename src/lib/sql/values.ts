import { sqlWritingFor } from "@/lib/db/sql-writing";
import type { DatabaseType } from "@/lib/types";

/**
 * Literals and binds for a dialect, read from the engine's own module.
 *
 * Each engine declares how it escapes a string literal, which placeholder its driver binds
 * and how it spells a date, in the `SqlWritingSpec` beside its provider; the measurements
 * that justify each answer live there. `SQL_WRITING` in `src/lib/db/sql-writing/index.ts`
 * is the total record of those modules, so a new provider cannot be added without
 * TypeScript demanding an answer, because the silent wrong answer is exactly the defect
 * this file exists to close (issue #290). The functions below are the stable surface every
 * caller reads.
 */

/**
 * Quote a value as a string literal for a dialect.
 *
 * This is the weaker half of the fix and it is the fallback, not the default: use
 * `positionalPlaceholder` and bind the value wherever the dialect has a bind form,
 * so the value never becomes statement text at all. Quoting is what remains for a
 * dialect that has no positional form.
 *
 * Doubling the quote alone is not enough. In a dialect where a backslash escapes,
 * a value ending in `\` would escape the closing quote and everything after it
 * would be read as SQL — a `WHERE` clause pasted into a cell then becomes the
 * statement's real predicate (issue #290).
 *
 * An undefined dialect is the generator that has no connection to name one. It
 * gets the standard form, matching the standard identifier quoting such a
 * generator already emits: doubling the backslash there would corrupt the value on
 * every dialect that reads it as data, which is the larger group.
 *
 * The inverse is `unquoteLiteral` below, which reads these same rules backwards.
 */
export function quoteLiteral(value: string, dialect: DatabaseType | undefined): string {
  return sqlWritingFor(dialect).escapeLiteral(value);
}

/**
 * The literal for a date or a timestamp a generator writes as text: `YYYY-MM-DD` for a date
 * and `YYYY-MM-DD HH24:MI:SS` for a timestamp.
 *
 * An engine whose module declares a `temporalLiteral` writes the value its own way; today
 * that is Oracle, whose module carries the #1400 measurement. Where that function answers
 * `undefined`, or the engine declares none, the text is quoted as it is: that is the
 * measured status quo, not a claim that the text is right everywhere, and a dialect found to
 * refuse the text gets its own function in its module.
 */
export function temporalLiteral(text: string, kind: "date" | "timestamp", dialect: DatabaseType | undefined): string {
  return sqlWritingFor(dialect).temporalLiteral?.(text, kind) ?? quoteLiteral(text, dialect);
}

/**
 * The value inside a single-quoted literal, or `undefined` when `text` is not exactly one.
 *
 * The inverse of `quoteLiteral`, and it is here rather than beside its caller because the
 * escape rules it undoes are the ones each engine's module already declares. A second copy
 * elsewhere is how one of them ends up half right (#795).
 *
 * The `undefined` answer is half the contract, not an error path. A catalog that reports a
 * default as the expression AS WRITTEN hands this function string literals and bare
 * expressions through the same column, so "is this one literal" is the question the caller
 * needs answered, and the answer has to come from the grammar. A literal that CLOSES before
 * the end of the text is not one literal: `'a' = 'b'` is an expression, and stripping its
 * outer quotes would produce `a' = 'b`, a value nobody wrote.
 */
export function unquoteLiteral(text: string, dialect: DatabaseType | undefined): string | undefined {
  return sqlWritingFor(dialect).unescapeLiteral(text);
}

/**
 * The placeholder a dialect's driver binds for the 1-based `position`, or `null`
 * where this repo has not pinned a positional bind form.
 *
 * Each form is the one the provider's own `query(sql, params)` actually binds, so
 * changing one without changing the provider breaks the pair; each engine's module
 * says which form that is and, where it is `null`, why.
 *
 * `null` is the signal to quote the value with `quoteLiteral` instead, never to emit
 * a placeholder nothing will bind.
 */
export function positionalPlaceholder(dialect: DatabaseType, position: number): string | null {
  return sqlWritingFor(dialect).placeholder?.(position) ?? null;
}
