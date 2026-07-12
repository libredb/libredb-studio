import type { ValueKind } from "./types";

// Only JSON containers (object/array) count: strings holding bare JSON
// primitives ("true", "123") keep their scalar rendering, and the startsWith
// guard skips JSON.parse for the common non-JSON string cell.
function parsesToJsonContainer(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

// Classify a result value into a renderer kind by its shape, never by the
// connection type that produced it.
export function classifyValue(value: unknown): ValueKind {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "object") {
    return "json";
  }
  if (typeof value === "string" && parsesToJsonContainer(value)) {
    return "json";
  }
  return "scalar";
}
