import { binaryRenderer } from "./binary";
import { jsonRenderer } from "./json";
import { nullRenderer } from "./null";
import { scalarRenderer } from "./scalar";
import type { ValueKind, ValueRenderer } from "./types";
import { vectorRenderer } from "./vector";

const renderers: Partial<Record<ValueKind, ValueRenderer>> = {
  null: nullRenderer,
  scalar: scalarRenderer,
  json: jsonRenderer,
  binary: binaryRenderer,
  vector: vectorRenderer,
};

export function getRenderer(kind: ValueKind): ValueRenderer {
  return renderers[kind] ?? scalarRenderer;
}
