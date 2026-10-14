/**
 * Reading one ExecutePlan stream: the response kinds, the reassembly of chunked Arrow batches,
 * and the three budgets: 100,000 rows and 16 MiB of decoded cost kept per statement, and 32 MiB received per
 * stream, whose end only stream.truncated tells apart from the server's end. Responses are told apart by the fields
 * they set, never by the oneof name; the descriptor decodes `schema` and `metrics`, which lie outside the oneof, as null
 * when unset. Every batch passes the IPC stream check before apache-arrow reads it, and a row's cost is known from its
 * offsets before any value is built. A misbehaving or untrusted server's answer is refused as unreadable: a chunk gap,
 * a repeat, a count field that is not a whole number, a row count that disagrees. Interrupt on a cut is execute.ts's
 * rule.
 */
import { type ArrowColumns, readIpcColumns, rowCost } from "./arrow";
import { SPARK_ARROW_CHUNK_BYTES, SPARK_BATCH_OVERHEAD_BYTES, SPARK_STREAM_MAX_RECEIVED_BYTES } from "./constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";
import type { SparkPlanStream } from "./grpc-client";
import { checkIpcStream, SPARK_IPC_FAILURES } from "./ipc-guard";

export interface SparkBudget {
  readonly rows: number;
  readonly bytes: number;
}

/** What the statement has kept so far, which keepRows advances. */
export interface SparkBudgetUse {
  rows: number;
  bytes: number;
}

/** A decoded batch whose first `rows` rows are kept. */
export interface SparkKeptBatch {
  readonly columns: ArrowColumns;
  readonly rows: number;
}

/** The warning each cut is shown with. */
export const SPARK_CUT_WARNINGS = Object.freeze({
  rows: "The result reached Studio's statement budget of 100,000 rows, so only the rows before it are shown.",
  bytes: "The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown.",
  stream:
    "The result reached Studio's limit of 32 MiB received from Spark for one statement, so only the rows before it are shown.",
});

const MIB = 1_048_576;
/** An int64 as SPARK_LOADER_OPTIONS (`longs: String`) hands it over. */
const DECIMAL = /^\d+$/;
const ENDED = "a chunked batch that ended before its last chunk";

/** The fields of an ArrowBatch the reader reads, as the descriptor decodes them. */
interface ArrowBatchLike {
  readonly row_count?: unknown;
  readonly data?: unknown;
  readonly chunk_index?: unknown;
  readonly num_chunks_in_batch?: unknown;
}

/** The fields of an ExecutePlanResponse that tell its kind. */
interface ResponseLike {
  readonly schema?: object | null;
  readonly arrow_batch?: ArrowBatchLike | null;
  readonly metrics?: object | null;
  readonly sql_command_result?: { readonly relation?: object | null } | null;
}

const unreadable = (what: string) => new SparkError("unreadable", SPARK_ERROR_SENTENCES.unreadable(what));
const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

/**
 * A count field of the answer: the decimal string of a safe integer of at least `least`, or `fallback` when the field
 * is unset; anything else is refused, naming `what`.
 */
function count(value: unknown, what: string, fallback?: number, least = 0): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw unreadable(what);
    return fallback;
  }
  const number = typeof value === "string" && DECIMAL.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < least) throw unreadable(what);
  return number;
}

/**
 * How many leading rows of `columns` fit what the budget leaves after `used`, advancing `used` by them: a
 * row is refused by the row budget once `used.rows` has reached it, and by the byte budget when its cost would pass
 * what is left. The first row's cost includes the batch's SPARK_BATCH_OVERHEAD_BYTES, so every kept batch pays it once
 * and a batch that keeps no row pays nothing. The cut is declared only when such a row exists, so a result that ends
 * exactly on a budget is whole. The one budget rule of the relation path here and of the inline command answer in
 * execute.ts.
 */
export function keepRows(
  columns: ArrowColumns,
  budget: SparkBudget,
  used: SparkBudgetUse,
): { readonly rows: number; readonly cut: "rows" | "bytes" | null } {
  for (let row = 0; row < columns.rowCount; row += 1) {
    if (used.rows >= budget.rows) return { rows: row, cut: "rows" };
    const cost = rowCost(columns, row) + (row === 0 ? SPARK_BATCH_OVERHEAD_BYTES : 0);
    if (used.bytes + cost > budget.bytes) return { rows: row, cut: "bytes" };
    used.rows += 1;
    used.bytes += cost;
  }
  return { rows: columns.rowCount, cut: null };
}

/**
 * ExecutePlan 1: the relation of the first command result, an inline local_relation or a lazy query.
 * The stream is read to its end, past progress and metrics; one that ends without a command result, or that the
 * 32 MiB bound truncated, is refused as unreadable.
 */
export async function readCommandAnswer(stream: SparkPlanStream): Promise<{ relation: object }> {
  let relation: object | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one reader takes the stream's responses one after another.
    const response = (await stream.read()) as ResponseLike | undefined;
    if (response === undefined) break;
    if (relation !== undefined || !present(response.sql_command_result)) continue;
    if (!present(response.sql_command_result.relation)) throw unreadable("the command result held no relation");
    relation = response.sql_command_result.relation;
  }
  if (stream.truncated) throw unreadable("the command answer passed 32 MiB");
  if (relation === undefined) throw unreadable("the command answered no result");
  return { relation };
}

/** The chunks of a batch received so far, held to its first chunk's count and row count. */
interface Pending {
  readonly chunks: Uint8Array[];
  readonly expected: number;
  readonly rowCount: number;
  next: number;
}

/**
 * ExecutePlan 2: the schema's DataType and the kept batches, under the three budgets. A batch
 * without `num_chunks_in_batch` is one chunk; chunks are reassembled in order, and a batch is decoded only whole. A
 * batch of one chunk is whole once the reader holds it, so it is read even when its bytes reached the stream bound. At
 * the first chunk of a batch with chunks still to come, a batch whose other chunks could reach the bound is not read:
 * the cut `stream` is declared before it, or, with no batch kept, the statement fails as batch-too-large. After every
 * undefined, `stream.truncated` tells the bound from the server's end, unless a metrics response, which Spark sends
 * after the last batch, came after every batch. On a cut the stream is cancelled; a refusal leaves it to the caller,
 * which ends the call on every exit (execute.ts).
 */
export async function readRelationAnswer(
  stream: SparkPlanStream,
  budget: SparkBudget,
): Promise<{
  schema: object | undefined;
  batches: readonly SparkKeptBatch[];
  cut: "rows" | "bytes" | "stream" | null;
}> {
  let schema: object | undefined;
  const batches: SparkKeptBatch[] = [];
  const used: SparkBudgetUse = { rows: 0, bytes: 0 };
  // Metrics mark the answer whole only while no batch has come after them.
  let metricsLast = false;
  let pending: Pending | undefined;
  const streamCut = (mib: number) => {
    stream.cancel();
    if (batches.length === 0) throw new SparkError("batch-too-large", SPARK_ERROR_SENTENCES.batchTooLarge(mib));
    return { schema, batches, cut: "stream" as const };
  };
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one reader takes the stream's responses one after another.
    const response = (await stream.read()) as ResponseLike | undefined;
    if (response === undefined) {
      // The bound reached before the answer was whole: the cut stream, an incomplete chunk sequence dropped.
      if (stream.truncated && !metricsLast) return streamCut(Math.max(1, Math.round(stream.receivedBytes / MIB)));
      if (pending !== undefined) throw unreadable(ENDED);
      return { schema, batches, cut: null };
    }
    if (present(response.schema)) schema = response.schema;
    const batch = response.arrow_batch;
    if (present(batch)) metricsLast = false;
    if (present(response.metrics)) metricsLast = true;
    if (!present(batch)) continue;
    const rowCount = count(batch.row_count, "a batch whose row count is not a whole number");
    const index = count(batch.chunk_index, "a chunk whose index is not a whole number", 0);
    const total = count(
      batch.num_chunks_in_batch,
      "a batch whose chunk count is not a whole number of at least 1",
      1,
      1,
    );
    if (index === 0) {
      if (pending !== undefined) throw unreadable(ENDED);
      // Each chunk still to come may be a whole preferred chunk; a batch of one chunk has none and is
      // read. receivedBytes also counts the responses the channel has read ahead, so the check errs toward the cut.
      if (
        total > 1 &&
        stream.receivedBytes + (total - 1) * SPARK_ARROW_CHUNK_BYTES >= SPARK_STREAM_MAX_RECEIVED_BYTES
      ) {
        return streamCut(total * (SPARK_ARROW_CHUNK_BYTES / MIB));
      }
      pending = { chunks: [], expected: total, rowCount, next: 0 };
    }
    if (pending === undefined || index !== pending.next) throw unreadable("a chunk out of order or repeated");
    if (total !== pending.expected || rowCount !== pending.rowCount) {
      throw unreadable("a chunk whose chunk count or row count differs from its batch's first chunk");
    }
    if (!(batch.data instanceof Uint8Array)) throw unreadable("a batch without data");
    pending.chunks.push(batch.data);
    pending.next += 1;
    if (pending.next < pending.expected) continue;
    // One contiguous stream, as apache-arrow reads it.
    const bytes = pending.chunks.length === 1 ? pending.chunks[0] : Buffer.concat(pending.chunks);
    const declared = pending.rowCount;
    pending = undefined;
    // The declared count is held before apache-arrow reads the batch, and again against what it decoded.
    checkIpcStream(bytes, declared);
    const columns = readIpcColumns(bytes);
    if (columns.rowCount !== declared) throw unreadable(SPARK_IPC_FAILURES.rowCount);
    const kept = keepRows(columns, budget, used);
    if (kept.rows > 0) batches.push({ columns, rows: kept.rows });
    if (kept.cut !== null) {
      stream.cancel();
      return { schema, batches, cut: kept.cut };
    }
  }
}
