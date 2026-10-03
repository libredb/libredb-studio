import type { VectorColumn } from "@/lib/db/vector/types";
import type { QueryWarning } from "@/lib/types";
import { classifyValue } from "./renderers/classify";
import { getRenderer } from "./renderers/registry";
import type { RenderContext } from "./renderers/types";

const WARNING_FALLBACK_LABEL = "Warning";

/**
 * How one engine warning reads to the user - shared by the stats bar's badge and
 * by the empty-result state, which must both say the same thing.
 *
 * An engine may report a code and no text, so a blank message falls back to the
 * code rather than rendering an empty line, and an entry carrying neither still
 * says that something was reported. `0` is a legal code, so absence is tested as
 * absence rather than as falsiness.
 */
export function describeWarning(warning: QueryWarning): string {
  if (warning.message) return warning.message;
  return warning.code === undefined ? WARNING_FALLBACK_LABEL : `${WARNING_FALLBACK_LABEL} ${warning.code}`;
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
