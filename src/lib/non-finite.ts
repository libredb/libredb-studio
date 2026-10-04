/**
 * NaN, Infinity and -Infinity in a result, written as words.
 *
 * `JSON.stringify` has no form for the three: it writes each as `null`, with no error,
 * so a value the engine stored arrived in the grid, the exports and the agent's view as
 * SQL NULL. Measured on PostgreSQL 18.6, `SELECT 'NaN'::float8, 'Infinity'::real,
 * '-infinity'::timestamptz` answered `null` in all three cells of `/api/db/query`, while
 * psql showed `NaN | Infinity | -infinity`. The drivers are not at fault: `pg-types`
 * reads `float8` with `parseFloat` and an infinite `timestamptz` as the number, and
 * every other driver that hands back a JavaScript number does the same.
 *
 * So every surface that serialises rows writes such a number as its word, the way a
 * 64-bit integer already travels as its digits in a string. The words are the ones
 * `String(n)` gives, which is also how PostgreSQL, DuckDB and Milvus spell them, and
 * which PostgreSQL reads back from a quoted literal into a float or a timestamp column.
 */

export type NonFiniteWord = "NaN" | "Infinity" | "-Infinity";

/** The word for a number JSON cannot carry, or `undefined` for a finite one. */
export function nonFiniteWord(value: number): NonFiniteWord | undefined {
  if (Number.isFinite(value)) return undefined;
  if (Number.isNaN(value)) return "NaN";
  return value > 0 ? "Infinity" : "-Infinity";
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `value` with every non-finite number replaced by its word, inside arrays and plain
 * objects at any depth (a `float8[]`, a Mongo sub-document).
 *
 * Nothing is written to `value`, and the same reference comes back when there was
 * nothing to replace, so the common result is not copied at all; when a number is
 * replaced, only the containers on its path are. A Date, a Buffer or a driver's class
 * instance is left whole, because it serialises through its own `toJSON` and a plain
 * copy would lose that.
 */
export function withNonFiniteWords(value: unknown): unknown {
  if (typeof value === "number") return nonFiniteWord(value) ?? value;
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    value.forEach((item, index) => {
      const next = withNonFiniteWords(item);
      if (next === item) return;
      copy ??= value.slice();
      copy[index] = next;
    });
    return copy ?? value;
  }
  if (typeof value !== "object" || value === null || !isPlainObject(value)) return value;
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const item = value[key];
    const next = withNonFiniteWords(item);
    if (next === item) continue;
    copy ??= { ...value };
    // Defined, not assigned: a column named `__proto__` would otherwise replace the
    // copy's prototype and leave the cell out.
    Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return copy ?? value;
}

/** The rows of a result, ready for `JSON.stringify`. */
export function rowsWithNonFiniteWords(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return withNonFiniteWords(rows) as Record<string, unknown>[];
}
