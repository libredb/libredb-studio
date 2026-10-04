import type { VectorColumn } from "@/lib/db/vector/types";

// Value-rendering contracts for the results area: values are classified into a
// kind by shape (never by connection type) and renderers are selected from the
// registry by kind. Adding a renderer is a new module plus a registry entry.
// A vector is the one kind a shape cannot tell from JSON, so it also needs its
// column's declaration, which reaches the classifier and the renderer as a
// `RenderContext`.

export type ValueKind = "null" | "scalar" | "json" | "binary" | "vector";

/** What a renderer may know about a cell's column beyond the value: its vector declaration, when the result made one. */
export interface RenderContext {
  readonly vector?: VectorColumn;
}

export interface CompactValue {
  display: string;
  className: string;
}

export interface DetailValue {
  text: string;
  className: string;
  /** When true the detail sheet renders a whitespace-preserving block so newlines and indentation survive. */
  preserveWhitespace: boolean;
}

export interface ValueRenderer {
  kind: ValueKind;
  /** Compact, single-line form for a grid cell (the cell handles truncation). */
  renderCompact(value: unknown, context?: RenderContext): CompactValue;
  /** Expanded form for the row detail sheet (may be multi-line). */
  renderDetail(value: unknown, context?: RenderContext): DetailValue;
  /**
   * What Copy Cell writes, where it is not the compact display: the whole value, in a form that can be pasted
   * back. Absent: Copy Cell copies `renderCompact`'s display.
   */
  renderCopy?(value: unknown, context?: RenderContext): string;
}
