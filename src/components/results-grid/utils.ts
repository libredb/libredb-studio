import { numberedRepeatBase, UNNAMED_FIELD } from "@/lib/db/utils/result-fields";
import type { VectorColumn } from "@/lib/db/vector/types";
import type { QueryWarning } from "@/lib/types";
import { classifyValue } from "./renderers/classify";
import { getRenderer } from "./renderers/registry";
import type { RenderContext } from "./renderers/types";

const WARNING_FALLBACK_LABEL = "Warning";

/**
 * The columns of a result that carry a name the result made up rather than one the statement
 * gave: `UNNAMED_FIELD` for a column with no name, and `name (N)` for a repeat of `name`
 * (`uniqueFieldNames`). Neither is a column of any table, so nothing may write to one by name.
 *
 * A numbered name counts only when its base is in the result too. That cannot tell a repeat
 * from a column the statement itself aliased `id (2)` beside an `id`, and it does not need to:
 * the alias is not a table column either, and a refusal costs a click where a guess costs a
 * write to the wrong column.
 */
export function generatedFieldNames(fields: readonly string[]): ReadonlySet<string> {
  const present = new Set(fields);
  return new Set(
    fields.filter((field) => {
      if (field === UNNAMED_FIELD) return true;
      const base = numberedRepeatBase(field);
      return base !== null && present.has(base);
    }),
  );
}

/**
 * How one engine warning reads to the user - shared by the stats bar's badge and
 * by the empty-result state, which must both say the same thing.
 *
 * An engine may report a code and no text, so a blank message falls back to the
 * code rather than rendering an empty line, and an entry carrying neither still
 * says that something was reported. `0` is a legal code, so absence is tested as
 * absence rather than as falsiness.
 *
 * A reported severity leads the line the way `psql` prints it (`NOTICE: ...`), because a
 * PostgreSQL-wire server sends notices and warnings through the same channel (#1401).
 */
export function describeWarning(warning: QueryWarning): string {
  const text = warning.message
    ? warning.message
    : warning.code === undefined
      ? WARNING_FALLBACK_LABEL
      : `${WARNING_FALLBACK_LABEL} ${warning.code}`;
  return warning.severity ? `${warning.severity}: ${text}` : text;
}

/**
 * The render context of one result column: its vector declaration, when the result made one.
 *
 * Own-key check rather than a direct lookup, for the reason `declaredTypeOf` in `ResultsGrid.tsx` gives: a column
 * name is arbitrary query output, and `SELECT 1 AS constructor` would otherwise find `Object.prototype`'s member.
 */
export function renderContextFor(
  vectorColumns: Readonly<Record<string, VectorColumn>> | undefined,
  field: string,
): RenderContext | undefined {
  return vectorColumns !== undefined && Object.hasOwn(vectorColumns, field)
    ? { vector: vectorColumns[field] }
    : undefined;
}

// Format cell value for display — thin adapter over the renderer registry,
// kept name-stable for the existing grid call sites; the context is the cell's
// column declaration (`renderContextFor`), absent for every undeclared column.
export function formatCellValue(value: unknown, context?: RenderContext): { display: string; className: string } {
  return getRenderer(classifyValue(value, context)).renderCompact(value, context);
}

/**
 * What Copy Cell writes for a cell: the renderer's copy form where it has one, its compact display otherwise.
 *
 * A separate reading from the display because the two differ wherever the display is a preview: a binary cell
 * shows its first 32 bytes and its size, and a vector cell its first 8 elements, while Copy Cell copies the whole
 * value. `value` is the DISPLAYED value, so a masked cell copies its mask.
 */
export function formatCellCopy(value: unknown, context?: RenderContext): string {
  const renderer = getRenderer(classifyValue(value, context));
  return renderer.renderCopy?.(value, context) ?? renderer.renderCompact(value, context).display;
}

/**
 * Case folding for the column filter (#1409).
 *
 * `"İ".toLowerCase()` is "i" plus U+0307 (combining dot above), so the filter `izmir` never found
 * the dotted capital spelling; and under a Turkish locale `toLocaleLowerCase` turns a plain "I" into the
 * dotless "ı", which would break the same match the other way. So the combining dot is dropped after
 * lowercasing and the dotless "ı" is read as "i". Nothing else is normalised: no NFD, which would make
 * `e` match `é` and a Hangul syllable match its first jamo.
 */
export function foldFilterCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0307/g, "")
    .replace(/\u0131/g, "i");
}
