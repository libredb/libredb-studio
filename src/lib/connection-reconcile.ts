import type { DatabaseConnection } from "@/lib/types";

/** Whether two values are equal, reading arrays and plain objects field by field. */
const valueEquals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => valueEquals(item, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !(a instanceof Date) &&
    !(b instanceof Date) &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((key) => valueEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    );
  }
  return false;
};

/**
 * The server stamps every seed with a fresh createdAt on each projection, including
 * editable seeds (managed: false). Only rows with a seedId ignore that timestamp.
 */
const rowEquals = (a: DatabaseConnection, b: DatabaseConnection): boolean => {
  const ka = Object.keys(a) as (keyof DatabaseConnection)[];
  const kb = Object.keys(b) as (keyof DatabaseConnection)[];
  if (ka.length !== kb.length) return false;
  return ka.every((key) => {
    if (key === "createdAt" && b.seedId) return true;
    return valueEquals(a[key], b[key]);
  });
};

/**
 * Reuse unchanged rows by id so consumers keyed on connection objects keep their work.
 * Reuse the array only when every position holds the same object, so reorders still land.
 */
export function reconcileConnections(previous: DatabaseConnection[], next: DatabaseConnection[]): DatabaseConnection[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  const shared = next.map((row) => {
    const prev = byId.get(row.id);
    return prev !== undefined && rowEquals(prev, row) ? prev : row;
  });
  return shared.length === previous.length && shared.every((row, i) => row === previous[i]) ? previous : shared;
}
