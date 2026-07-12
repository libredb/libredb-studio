// Value-rendering contracts for the results area: values are classified into a
// kind by shape (never by connection type) and renderers are selected from the
// registry by kind. Adding a renderer is a new module plus a registry entry.

export type ValueKind = "null" | "scalar" | "json";

export interface CompactValue {
  display: string;
  className: string;
}

export interface ValueRenderer {
  kind: ValueKind;
  /** Compact, single-line form for a grid cell (the cell handles truncation). */
  renderCompact(value: unknown): CompactValue;
}
