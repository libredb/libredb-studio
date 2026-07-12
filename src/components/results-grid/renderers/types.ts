// Value-rendering contracts for the results area: values are classified into a
// kind by shape (never by connection type) and renderers are selected from the
// registry by kind. Adding a renderer is a new module plus a registry entry.

export type ValueKind = "null" | "scalar" | "json";

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
  renderCompact(value: unknown): CompactValue;
  /** Expanded form for the row detail sheet (may be multi-line). */
  renderDetail(value: unknown): DetailValue;
}
