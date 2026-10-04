/**
 * The one JSON serializer the export path uses.
 *
 * `JSON.stringify` THROWS on two values an export can genuinely be handed, and it
 * throws out of the click handler that started the export: no file, no toast, and
 * nothing in the UI to say why. Both arrive through the embeddable shell
 * (`src/workspace/StudioWorkspace.tsx`), where the rows are live JavaScript objects
 * the host passed in rather than a parsed HTTP response:
 *
 * 1. A `BigInt` anywhere inside a value — what `mysql2` with `supportBigNumbers`, a
 *    `bun:sqlite` with safe integers, or a Mongo `Long` can hand back. Written as its
 *    decimal digits in a string, which is lossless as text; a JSON number would not
 *    be past 2^53.
 * 2. A cycle. A document that references itself has no JSON form at all, so the cycle
 *    is named rather than followed, and every acyclic part of the value survives.
 *
 * An export that writes SOMETHING for a value it cannot represent exactly is worth
 * more than one that writes nothing and reports nothing — and a value this rare is
 * better labelled in the file than left to a stack trace in the console.
 */

import { nonFiniteWord } from "@/lib/non-finite";
import { asBytes, binaryText } from "./binary";

/** What stands in for a value that contains itself. */
const CIRCULAR_PLACEHOLDER = "[Circular]";

/**
 * `value` rebuilt as something `JSON.stringify` cannot throw on.
 *
 * `ancestors` is the chain of containers this value sits INSIDE, not every container
 * already seen: the same object referenced twice under different keys is ordinary in
 * a result set, and reporting it as a cycle would corrupt the second copy.
 *
 * `toJSON` is honoured first and its result walked, which is how `JSON.stringify`
 * itself treats a `Date` or a BSON value — dropping it would turn a timestamp into
 * `{}`.
 */
function jsonSafe(value: unknown, ancestors: readonly object[]): unknown {
  if (typeof value === "bigint") return value.toString();
  // Not a throw but a silent change: `JSON.stringify` writes NaN and the infinities as
  // `null`, which the file's reader takes for SQL NULL. The word survives instead.
  if (typeof value === "number") return nonFiniteWord(value) ?? value;
  if (value === null || typeof value !== "object") return value;

  const custom = (value as { toJSON?: unknown }).toJSON;
  if (typeof custom === "function") return jsonSafe((custom as () => unknown).call(value), ancestors);

  if (ancestors.includes(value)) return CIRCULAR_PLACEHOLDER;
  const inside = [...ancestors, value];
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, inside));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, inside);
  return out;
}

/**
 * `value` as JSON text, for a value that may hold anything.
 *
 * `indent` is passed to `JSON.stringify`, so 0 (the default) is the compact form a
 * CSV cell or a SQL literal wants and 2 is the pretty form the JSON export writes.
 */
export function jsonText(value: unknown, indent = 0): string {
  return JSON.stringify(jsonSafe(value, []), null, indent);
}

/**
 * `row` with each binary cell written as the `\x` hex the grid and the CSV show.
 *
 * For the JSON a row leaves the product as: the JSON export (and its Copy as JSON),
 * the grid's Copy Row as JSON and the row detail's Copy JSON. Left alone, a
 * `bytea`/`BLOB` cell is written in the form a `Buffer` serializes to,
 * `{"type":"Buffer","data":[222,173,...]}`, so one result exported as CSV and as
 * JSON disagreed about the same cell (#1381). The hex is a plain string and the file
 * carries no column types, so what says it is binary is the source column's
 * declared type (the schema, or the DDL export), not the file.
 *
 * Only the cells are judged, the way `renderValue` in `csv.ts` judges them: bytes
 * nested inside a document stay as the document's own JSON spells them in both
 * files. Not done inside `jsonText`, whose other callers write history, audit and
 * profile files that hold no result rows. The `/api/db/query` response keeps the
 * Buffer form, because that is the shape the browser recognises a binary cell by.
 */
export function binaryCellsAsHex(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const bytes = asBytes(value);
    out[key] = bytes === undefined ? value : binaryText(bytes);
  }
  return out;
}
