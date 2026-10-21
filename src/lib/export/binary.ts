/**
 * Reading a binary cell, for every surface that shows one.
 *
 * A `bytea`/`BLOB` value used to reach the grid and the CSV as
 * `{"type":"Buffer","data":[1,2,…]}` — the shape `JSON.stringify` gives a Node
 * `Buffer` — so a megabyte of data became about four megabytes of digits and no
 * reader could turn it back.
 *
 * This module is the shared half of the fix rather than an export-side detail: the
 * grid, the row detail sheet and the CSV must agree on what a binary value looks
 * like, and fixing the writer alone would make the file disagree with the screen.
 * It lives here, next to `json.ts`, because `csv.ts` must stay free of any
 * `src/components` import — the renderer imports downwards, never the other way.
 *
 * `asBytes` and `binaryText` live in the engine-neutral export leaf
 * (`src/lib/db/sql-writing/export-shared.ts`), where an engine's export module can reach
 * them, and are re-exported here by name so no surface that reads a binary cell changes.
 */
import { binaryText } from "@/lib/db/sql-writing/export-shared";

export { asBytes, binaryText } from "@/lib/db/sql-writing/export-shared";

/**
 * Bytes past this many are dropped from the compact grid cell, which has one line to work with.
 *
 * 32 is enough to carry a value's identifying head — every file magic worth
 * recognising is inside the first 8 bytes — and short enough that 64 hex digits
 * plus the size still fit a column. The full hex would be 2 million characters
 * for a megabyte cell, which the cell would lay out before hiding.
 */
const PREVIEW_BYTES = 32;

/** A byte count as a reader can judge it. Capped at MB: a larger single cell cannot survive the JSON response that carries it. */
function byteCount(length: number): string {
  if (length >= 1024 * 1024) return `${(length / (1024 * 1024)).toFixed(1)} MB`;
  if (length >= 1024) return `${(length / 1024).toFixed(1)} KB`;
  return `${length} B`;
}

/** `bytes` for a single grid cell: whole when short, otherwise a head and the size it stands for. */
export function binaryPreview(bytes: Uint8Array): string {
  if (bytes.length <= PREVIEW_BYTES) return binaryText(bytes);
  return `${binaryText(bytes.subarray(0, PREVIEW_BYTES))}... (${byteCount(bytes.length)})`;
}
