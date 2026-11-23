/**
 * The byte budgets of a result, the row measure, a batch holder for rows already in memory and the result pump
 * (docs/providers/CONTRACT.md, clauses C-13 to C-16 and C-27).
 *
 * A result crosses from a provider in batches: the host asks a `ResultSource` for at most so many rows and bytes, and
 * the source answers within that, never splitting a row, so a batch of one row may be larger. A row's size is the
 * UTF-8 length of its encoded JSON text, and a batch's and a page's size is the sum of their rows'.
 *
 * `rowsSource` is the provider's side, over rows a driver already materialised. `pumpPage` is the host's side, run in
 * the host's copy of the SDK so every package's batches are measured by one rule: it pulls one batch at a time, the
 * pull being the credit, measures and checks every batch, cuts the page by size, and closes the source once on every
 * path. The pump never keeps a source open across pages, and it starts no pull once the call's signal has aborted or
 * its deadline has passed.
 */
import { encodeValue } from "../values/codec";
import { refuseCallStart } from "./deadline";
import { isPlainRecord, pointerTo, readOwn } from "./records";
import { type CallRefusal, CallRefusalError } from "./refusals";
import type { BatchLimit, CallContext, Column, ResultSource, RowBatch } from "./types";

/** The most bytes of rows one batch may hold, unless it holds one row. */
export const BATCH_MAX_BYTES = 1048576;

/** The most bytes of rows one page may hold. */
export const PAGE_MAX_BYTES = 33554432;

/** Why a page ended: the source had no row left, the page held its rows, or it held its bytes. */
export const PAGE_ENDS = Object.freeze(["done", "row-limit", "byte-limit"] as const);

export type PageEnd = (typeof PAGE_ENDS)[number];

/** One page of a result, as the pump assembled it. */
export interface Page {
  readonly rows: readonly (readonly unknown[])[];
  /** The sum of the rows' sizes. */
  readonly bytes: number;
  readonly end: PageEnd;
}

/** What the pump may take into one page. The host passes `PAGE_MAX_BYTES` and `BATCH_MAX_BYTES`. */
export interface PumpLimits {
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly batchMaxBytes: number;
}

/** The UTF-8 length of `text`, counted over its UTF-16 code units, a lone surrogate as the three bytes of U+FFFD. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The size of `row`: the UTF-8 length of `JSON.stringify(encodeValue(row))`.
 *
 * @throws {ValueCodecError} For a cell outside the value codec's domain.
 */
export function encodedRowBytes(row: readonly unknown[]): number {
  return utf8Length(JSON.stringify(encodeValue(row)));
}

/**
 * A result source over `rows`, already in memory: each `next` answers the rows that follow, at most `limit.maxRows` of
 * them and at most `limit.maxBytes` of their size, except that a row larger than `limit.maxBytes` comes alone. The
 * rows are measured, never copied.
 */
export function rowsSource(
  columns: readonly Column[],
  rows: readonly (readonly unknown[])[],
  rowCount?: number,
): ResultSource {
  let at = 0;
  let closed = false;
  return Object.freeze({
    columns,
    ...(rowCount === undefined ? {} : { rowCount }),
    async next(limit: BatchLimit): Promise<RowBatch> {
      if (closed) throw new Error("The result source was closed, so it answers no more batches.");
      const batch: (readonly unknown[])[] = [];
      let bytes = 0;
      while (at < rows.length && batch.length < limit.maxRows) {
        const size = encodedRowBytes(rows[at]);
        if (batch.length > 0 && bytes + size > limit.maxBytes) break;
        batch.push(rows[at]);
        bytes += size;
        at += 1;
        if (bytes >= limit.maxBytes) break;
      }
      return { rows: batch, done: at >= rows.length };
    },
    async close(): Promise<void> {
      closed = true;
    },
  });
}

const LIMIT_NAMES = Object.freeze(["maxRows", "maxBytes", "batchMaxBytes"] as const);

/** A batch read as a plain record of exactly `rows`, an array, and `done`, a boolean, both data; or its refusals. */
type BatchRead =
  | { readonly kind: "read"; readonly rows: readonly unknown[]; readonly done: boolean }
  | { readonly kind: "refused"; readonly refusals: readonly CallRefusal[] };

function readBatch(batch: unknown): BatchRead {
  if (!isPlainRecord(batch)) return { kind: "refused", refusals: [{ rule: "batch-malformed", pointer: "" }] };
  const refusals: CallRefusal[] = [];
  for (const key of Object.getOwnPropertyNames(batch)) {
    if (key !== "rows" && key !== "done") refusals.push({ rule: "batch-malformed", pointer: pointerTo("", key) });
  }
  const rows = readOwn(batch, "rows");
  const done = readOwn(batch, "done");
  const rowsValue = rows.kind === "data" && Array.isArray(rows.value) ? (rows.value as readonly unknown[]) : undefined;
  const doneValue = done.kind === "data" && typeof done.value === "boolean" ? done.value : undefined;
  if (rowsValue === undefined) refusals.push({ rule: "batch-malformed", pointer: "/rows" });
  if (doneValue === undefined) refusals.push({ rule: "batch-malformed", pointer: "/done" });
  if (rowsValue === undefined || doneValue === undefined || refusals.length > 0) return { kind: "refused", refusals };
  return { kind: "read", rows: rowsValue, done: doneValue };
}

/** One step of the pump: the rows a batch adds to the page and their size, and whether the page ends with it. */
interface Step {
  readonly rows: readonly (readonly unknown[])[];
  readonly bytes: number;
  readonly end?: PageEnd;
}

/**
 * What `batch`, answered to `limit`, adds to a page that has `bytesLeft` of `maxBytes` left and holds `width`-cell rows.
 *
 * @throws {CallRefusalError} For a batch a source should not have answered.
 * @throws {ValueCodecError} For a cell outside the value codec's domain.
 */
function step(batch: unknown, limit: BatchLimit, width: number, bytesLeft: number, maxBytes: number): Step {
  const read = readBatch(batch);
  if (read.kind === "refused") throw new CallRefusalError(read.refusals);
  const { rows, done } = read;
  if (rows.length > limit.maxRows) {
    throw new CallRefusalError([
      { rule: "batch-over-rows", pointer: "/rows", limit: limit.maxRows, size: rows.length },
    ]);
  }
  const positional: (readonly unknown[])[] = [];
  const refusals: CallRefusal[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = readOwn(rows, String(index));
    if (row.kind === "data" && Array.isArray(row.value) && row.value.length === width) positional.push(row.value);
    else refusals.push({ rule: "row-not-positional", pointer: pointerTo("/rows", index) });
  }
  if (refusals.length > 0) throw new CallRefusalError(refusals);
  if (positional.length === 0 && !done) throw new CallRefusalError([{ rule: "batch-empty-not-done", pointer: "" }]);
  const bytes = positional.reduce((sum, row) => sum + encodedRowBytes(row), 0);
  if (bytes > limit.maxBytes && positional.length > 1) {
    throw new CallRefusalError([{ rule: "batch-over-bytes", pointer: "/rows", limit: limit.maxBytes, size: bytes }]);
  }
  if (bytes > maxBytes) {
    throw new CallRefusalError([{ rule: "row-over-page", pointer: "/rows/0", limit: maxBytes, size: bytes }]);
  }
  if (bytes > bytesLeft) return { rows: [], bytes: 0, end: "byte-limit" };
  return done ? { rows: positional, bytes, end: "done" } : { rows: positional, bytes };
}

/**
 * One page of `source`, pulled one batch at a time and cut by size: each pull asks for no more than the page has left,
 * `limits.batchMaxBytes` at most, and the limit object it passes is frozen. Every batch is read defensively and
 * measured; one a source should not have answered is refused by name, as is a row larger than the whole page. The
 * page ends when the source is done, when it holds `limits.maxRows` rows, or when it holds `limits.maxBytes` bytes or
 * the next row would not fit.
 *
 * `ctx` is the context of the execute call that answered the source, whose deadline and signal every pull runs under:
 * before each pull the pump refuses, as `checkCallStart` does, a call whose deadline has passed or whose signal has
 * aborted, so no batch is pulled after either. A pull already in flight is not raced here: the host bounds its wait on
 * the whole call with `awaitWithin`.
 *
 * The source is closed exactly once, on every path. A step's failure is thrown after the close; when the close fails
 * too, an `AggregateError` holds both, the step's first, with the close's as its cause, and a close that fails after a
 * good page throws its error.
 *
 * @throws {RangeError} For a limit that is not a positive safe integer, or a deadline that is not a finite number, a
 * host defect, before any pull.
 * @throws {CallRefusalError} For a batch a source should not have answered, or a pull that would start after the
 * call's deadline passed or its signal aborted, the signal's reason as its cause.
 */
export async function pumpPage(
  source: ResultSource,
  limits: PumpLimits,
  ctx: Pick<CallContext, "deadline" | "signal">,
): Promise<Page> {
  const rows: (readonly unknown[])[] = [];
  let bytes = 0;
  let end: PageEnd | undefined;
  let failure: { readonly error: unknown } | undefined;
  try {
    for (const name of LIMIT_NAMES) {
      if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0) {
        throw new RangeError(`The pump limit ${name} must be a positive safe integer.`);
      }
    }
    const { maxRows, maxBytes, batchMaxBytes } = limits;
    const width = source.columns.length;
    while (end === undefined) {
      const limit = Object.freeze({
        maxRows: maxRows - rows.length,
        maxBytes: Math.min(batchMaxBytes, maxBytes - bytes),
      });
      refuseCallStart(ctx);
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time: the pull is the credit, so a source holds one batch in flight.
      const added = step(await source.next(limit), limit, width, maxBytes - bytes, maxBytes);
      for (const row of added.rows) rows.push(row);
      bytes += added.bytes;
      if (added.end !== undefined) end = added.end;
      else if (rows.length >= maxRows) end = "row-limit";
      else if (bytes >= maxBytes) end = "byte-limit";
    }
  } catch (error) {
    failure = { error };
  }
  try {
    await source.close();
  } catch (closeError) {
    if (failure === undefined) throw closeError;
    throw new AggregateError(
      [failure.error, closeError],
      "Pumping a page failed, and closing its result source failed too.",
      { cause: closeError },
    );
  }
  if (failure !== undefined) throw failure.error;
  return Object.freeze({ rows, bytes, end: end as PageEnd });
}
