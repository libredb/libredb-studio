import type { QueryWarning } from "@/lib/types";
import { classifyValue } from "./renderers/classify";
import { getRenderer } from "./renderers/registry";

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

// Format cell value for display — thin adapter over the renderer registry,
// kept name- and signature-stable for the existing grid call sites.
export function formatCellValue(value: unknown): { display: string; className: string } {
  return getRenderer(classifyValue(value)).renderCompact(value);
}
