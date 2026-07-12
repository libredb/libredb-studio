import { classifyValue } from "./renderers/classify";
import { getRenderer } from "./renderers/registry";

// Format cell value for display — thin adapter over the renderer registry,
// kept name- and signature-stable for the existing grid call sites.
export function formatCellValue(value: unknown): { display: string; className: string } {
  return getRenderer(classifyValue(value)).renderCompact(value);
}
