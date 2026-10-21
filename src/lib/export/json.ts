/**
 * The JSON a result row leaves the product as.
 *
 * `jsonText`, the one JSON serializer the export path uses, lives in the engine-neutral
 * export leaf (`src/lib/db/sql-writing/export-shared.ts`) and is re-exported here by name,
 * so none of its callers change.
 */

import { asBytes, binaryText } from "./binary";

export { jsonText } from "@/lib/db/sql-writing/export-shared";

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
