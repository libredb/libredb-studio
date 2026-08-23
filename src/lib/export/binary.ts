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
 * The text is lowercase hex behind `\x`: the escape form a `bytea` column's own
 * output uses, so it is recognisable on sight and can be pasted back into a
 * statement. Base64 is shorter and neither.
 */

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

function isByte(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * `value` as its bytes, or `undefined` when it is not a binary value.
 *
 * Two shapes, because two paths reach the grid: the HTTP path hands the JSON that
 * a `Buffer` serialized to, and the embeddable shell
 * (`src/workspace/StudioWorkspace.tsx`) hands the live object the host passed in.
 * A real `Buffer` IS a `Uint8Array`, so one check covers both live forms.
 *
 * Every element is checked rather than the first, because the whole point of the
 * shape test is that a user's own document may carry a `type` field: a row of
 * `{type: "Buffer", data: [1, "two"]}` is a document, and turning it into bytes
 * would lose it as surely as the defect this fixes.
 */
export function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { type?: unknown; data?: unknown };
  if (candidate.type !== "Buffer" || !Array.isArray(candidate.data)) return undefined;
  if (!candidate.data.every(isByte)) return undefined;
  return Uint8Array.from(candidate.data as number[]);
}

/** Every byte of `bytes` as hex. What the detail sheet and the exported file write. */
export function binaryText(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `\\x${hex}`;
}

/** `bytes` for a single grid cell: whole when short, otherwise a head and the size it stands for. */
export function binaryPreview(bytes: Uint8Array): string {
  if (bytes.length <= PREVIEW_BYTES) return binaryText(bytes);
  return `${binaryText(bytes.subarray(0, PREVIEW_BYTES))}... (${byteCount(bytes.length)})`;
}
