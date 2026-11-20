/**
 * What a `COPY ... TO STDOUT` sends, kept so the statement's result can show it (A06).
 *
 * PostgreSQL answers `COPY ... TO STDOUT` with CopyOutResponse, then one CopyData message per row,
 * then the command tag `COPY n`. `pg` reads the count from the tag and drops every CopyData
 * (`pg/lib/query.js` `handleCopyData` is a no-op), so the statement used to come back as no
 * columns, no rows and a count, which the results grid reads as a write: measured 2026-11-20 on
 * PostgreSQL 19.0 and 18.7, `COPY (SELECT id, status FROM t_a.orders ORDER BY id LIMIT 3) TO STDOUT
 * (FORMAT csv)` printed three lines in psql and "3 rows affected" over an empty grid in Studio.
 *
 * The messages are read off the client's wire connection, which emits every protocol message by
 * name, so the driver's own query path is not touched. Each row is one line of a single text
 * column, as psql prints it. A binary COPY is not decoded: its bytes are not text, and the result
 * says so instead. The output is bounded, by lines and by bytes, because a COPY of a whole table
 * streams all of it here and has no LIMIT the editor could inject; what is past the bound is only
 * counted, and the result says how much was left out.
 *
 * A COPY to a server file sends no CopyOutResponse, so its result is untouched and keeps its count.
 */
import type { EventEmitter } from "node:events";
import type { QueryWarning } from "@/lib/types";
import type { PgFieldMetadata } from "./column-types";

/** The one column a COPY's output is shown in. */
const COPY_OUTPUT_COLUMN = "copy_output";
/** At most this many lines of one statement's COPY output are kept. */
const COPY_KEEP_LINES = 1000;
/** And at most this many bytes of them, so a COPY of wide rows cannot fill the server's memory. */
const COPY_KEEP_BYTES = 4 * 1024 * 1024;
/** `text`'s pg_type OID, so the column's declared type reads `text`. */
const TEXT_OID = 25;

/** One COPY's output: which of the statement's results it belongs to, and the lines kept of it. */
interface CopyOutput {
  /** The index of the result `pg` builds for this COPY: the command tags that came before it. */
  answerIndex: number;
  binary: boolean;
  lines: string[];
  /** Every CopyData message the server sent for it, kept or not. */
  sent: number;
}

/** What one client received since the last take. */
interface CopyCapture {
  completes: number;
  copies: CopyOutput[];
  keptLines: number;
  keptBytes: number;
}

/** The shape of one `pg` answer this module rewrites. */
interface CopyAnswer {
  rows: unknown[][];
  fields?: PgFieldMetadata[];
}

const pendingCopies = new WeakMap<object, CopyCapture>();

function emptyCapture(): CopyCapture {
  return { completes: 0, copies: [], keptLines: 0, keptBytes: 0 };
}

/**
 * Start keeping what `client` receives of a COPY's output. `wire` is the client's protocol
 * connection; a CommandComplete is counted so a COPY in a text of several statements lands on its
 * own result, which `pg` builds one per command tag.
 */
export function keepCopyOutput(client: object, wire: EventEmitter): void {
  const capture = emptyCapture();
  pendingCopies.set(client, capture);
  wire.on("commandComplete", () => {
    capture.completes++;
  });
  wire.on("copyOutResponse", (message: { binary: boolean }) => {
    capture.copies.push({ answerIndex: capture.completes, binary: message.binary, lines: [], sent: 0 });
  });
  wire.on("copyData", (message: { chunk: Buffer }) => {
    const current = capture.copies.at(-1);
    if (current === undefined) return;
    current.sent++;
    if (current.binary) return;
    if (capture.keptLines >= COPY_KEEP_LINES || capture.keptBytes + message.chunk.length > COPY_KEEP_BYTES) return;
    capture.keptLines++;
    capture.keptBytes += message.chunk.length;
    const text = message.chunk.toString("utf8");
    current.lines.push(text.endsWith("\n") ? text.slice(0, -1) : text);
  });
}

/** Everything `client` has received of COPY output and not yet handed out, emptied as it is read. */
export function takeCopyOutput(client: object): CopyOutput[] {
  const capture = pendingCopies.get(client);
  if (capture === undefined) return [];
  const taken = capture.copies;
  Object.assign(capture, emptyCapture());
  return taken;
}

/**
 * The statement's answer with each COPY's output put on the result it belongs to, as rows of
 * `COPY_OUTPUT_COLUMN`, and the warnings that say what could not be shown. The count stays the
 * command tag's, which is the number of rows the COPY sent.
 */
export function withCopyOutput<T extends CopyAnswer>(
  answer: T | T[],
  copies: readonly CopyOutput[],
): { answer: T | T[]; warnings: QueryWarning[] } {
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  const warnings: QueryWarning[] = [];
  for (const copy of copies) {
    const index = Math.min(copy.answerIndex, answers.length - 1);
    answers[index] = {
      ...answers[index],
      fields: [{ name: COPY_OUTPUT_COLUMN, dataTypeID: TEXT_OID }],
      rows: copy.lines.map((line) => [line]),
    };
    if (copy.binary) {
      warnings.push({
        message:
          "COPY TO STDOUT sent its output in binary format, which cannot be shown here. Use FORMAT text or csv, or run the query as a SELECT.",
      });
    } else if (copy.lines.length < copy.sent) {
      warnings.push({
        message: `COPY TO STDOUT sent ${copy.sent} lines; only the first ${copy.lines.length} are shown here. Run the query as a SELECT to page through it, or use Export.`,
      });
    }
  }
  return { answer: Array.isArray(answer) ? answers : answers[0], warnings };
}
