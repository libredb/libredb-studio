import { jsonRenderer } from "./json";
import { nullRenderer } from "./null";
import { scalarRenderer } from "./scalar";
import type { ValueKind, ValueRenderer } from "./types";

const renderers: Partial<Record<ValueKind, ValueRenderer>> = {
  null: nullRenderer,
  scalar: scalarRenderer,
  json: jsonRenderer,
};

export function getRenderer(kind: ValueKind): ValueRenderer {
  return renderers[kind] ?? scalarRenderer;
}
