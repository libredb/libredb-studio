/**
 * The PostgreSQL side of the query event sink (spec 7.9): one batch of query event rows into the governance source's
 * `query_events_v1`, and what became of each row.
 *
 * `writeQueryEventBatch()` sends the batch as the manifest's multi-row `INSERT ... ON CONFLICT DO NOTHING`
 * (`buildQueryEventInsert()`) through the governance pool (`src/lib/governance/db.ts`), as Studio's own role, which
 * may only insert. Every row keeps the `event_id` it was built with across retries, so a batch sent again after an
 * insert that did land adds nothing.
 *
 * - A refusal for good, SQLSTATE class 22 (data exception) or 23 (integrity constraint violation), does not say which
 *   row it is about, so the batch is split: its rows go in one by one, in order, on the same connection, and only the
 *   rows refused again are dropped, each logged as one stdout line `{type: "query_event_rejected", event_id, sqlstate,
 *   constraint}`, which carries no statement text and not the server's message either, because that can quote the
 *   row.
 * - Any other failure keeps every row not yet settled for a retry: a connection lost or refused (class 08, 57P01 to
 *   57P03), too many connections (53300), a serialization failure or a deadlock (40001, 40P01), a timeout, and any
 *   other SQLSTATE, which the sink state then shows. The sink waits `queryEventBackoffMs()` before the retry, from 1 s
 *   doubling to 30 s.
 *
 * A SQLSTATE is the code of an error the server sent, which `pg` hands over with the server's severity. A Node socket
 * error has none, so a five-letter Node code such as EPIPE is never read as one (src/lib/governance/freshness.ts reads
 * it the same way). Once the signal aborts, nothing a statement answers is counted: a row it inserted goes again with
 * the retry, which adds nothing, and a row it refused is refused, logged and counted then.
 */
import type { PoolClient } from "pg";
import { governancePostgresSchema } from "@/lib/governance/config";
import { buildQueryEventInsert, QUERY_EVENT_COLUMNS } from "@/lib/governance/contract";
import { withGovernanceClient } from "@/lib/governance/db";
import type { QueryEventRow } from "./types";

/** The wait after the first failed insert, doubled after each further one, up to the longest (spec 7.9). */
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** The SQLSTATE classes of a refusal for good: data exception and integrity constraint violation. */
const PERMANENT_CLASSES: ReadonlySet<string> = new Set(["22", "23"]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** A row the governance source refused for good. */
export interface QueryEventRejection {
  readonly eventId: string;
  readonly sqlstate: string;
  /** The constraint the row broke, or null when the server named none. */
  readonly constraint: string | null;
}

/** Why an insert stopped before its whole batch settled. */
export interface QueryEventWriteFailure {
  /** The SQLSTATE of an error the server sent, or null for a timeout, a socket error or a deadline. */
  readonly sqlstate: string | null;
  /**
   * What a log line may say of it: the SQLSTATE of an error the server sent, whose message can quote a value of the
   * row, and the message of any other error, which is the driver's or Studio's own.
   */
  readonly reason: string;
}

/** What became of a batch. */
export interface QueryEventBatchWrite {
  /** How many rows, from the head of the batch, the governance source now holds or refused for good. */
  readonly settled: number;
  /** The settled rows it refused for good, in batch order. */
  readonly rejections: readonly QueryEventRejection[];
  /** Why the rows after the settled ones stay queued, or null when the whole batch settled. */
  readonly failure: QueryEventWriteFailure | null;
}

/** The wait before the next insert after `failures` failed inserts in a row: 1 s, 2 s, 4 s and on, at most 30 s. */
export function queryEventBackoffMs(failures: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/** The SQLSTATE of an error the server sent, or null for any other error. */
function sqlstateOf(error: unknown): string | null {
  const { code, severity } = (error ?? {}) as { readonly code?: unknown; readonly severity?: unknown };
  return typeof severity === "string" && typeof code === "string" && SQLSTATE.test(code) ? code : null;
}

/** Whether the governance source refused a row for good, read from the SQLSTATE class of its error. */
const refusedForGood = (error: unknown): boolean => PERMANENT_CLASSES.has(sqlstateOf(error)?.slice(0, 2) ?? "");

/** The parameters of one row, in the order of the insert's column list. */
const parametersOf = (row: QueryEventRow): unknown[] =>
  QUERY_EVENT_COLUMNS.map((column) => row[column as keyof QueryEventRow]);

function failureOf(error: unknown): QueryEventWriteFailure {
  const sqlstate = sqlstateOf(error);
  if (sqlstate !== null) return { sqlstate, reason: `SQLSTATE ${sqlstate}` };
  return { sqlstate, reason: error instanceof Error ? error.message : String(error) };
}

/** Drops a row the governance source refused for good, with its one stdout line. */
function reject(row: QueryEventRow, error: unknown): QueryEventRejection {
  const named = (error as { readonly constraint?: unknown }).constraint;
  const rejection: QueryEventRejection = {
    eventId: row.event_id,
    sqlstate: sqlstateOf(error) as string,
    constraint: typeof named === "string" ? named : null,
  };
  console.log(
    JSON.stringify({
      type: "query_event_rejected",
      event_id: rejection.eventId,
      sqlstate: rejection.sqlstate,
      constraint: rejection.constraint,
    }),
  );
  return rejection;
}

type Attempt = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/**
 * Runs one insert and answers how it went. It throws the signal's reason once the signal has aborted, before the
 * statement or after it, so what a statement answers past the deadline is never counted.
 */
async function attempt(
  client: PoolClient,
  sql: string,
  parameters: readonly unknown[],
  signal: AbortSignal,
): Promise<Attempt> {
  signal.throwIfAborted();
  let outcome: Attempt = { ok: true };
  try {
    await client.query(sql, [...parameters]);
  } catch (error) {
    outcome = { ok: false, error };
  }
  signal.throwIfAborted();
  return outcome;
}

/** What a write has settled so far, which it keeps when a failure ends it early. */
interface Progress {
  settled: number;
  readonly rejections: QueryEventRejection[];
}

async function insertBatch(
  client: PoolClient,
  schema: string,
  rows: readonly QueryEventRow[],
  signal: AbortSignal,
  progress: Progress,
): Promise<void> {
  const whole = await attempt(client, buildQueryEventInsert(schema, rows.length), rows.flatMap(parametersOf), signal);
  if (whole.ok) {
    progress.settled = rows.length;
    return;
  }
  if (!refusedForGood(whole.error)) throw whole.error;
  for (const [index, row] of rows.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- the rows go in one at a time, in order, on one connection.
    const one = await attempt(client, buildQueryEventInsert(schema, 1), parametersOf(row), signal);
    if (!one.ok) {
      if (!refusedForGood(one.error)) throw one.error;
      progress.rejections.push(reject(row, one.error));
    }
    progress.settled = index + 1;
  }
}

/**
 * Inserts `rows`, at least one and at most `QUERY_EVENT_INSERT_MAX_ROWS`, and settles with what became of them: how
 * many from the head the governance source holds or refused for good, which of them it refused, and why the rest
 * stays queued, if it does. It gives up when `signal` aborts, and it never rejects.
 */
export async function writeQueryEventBatch(
  rows: readonly QueryEventRow[],
  signal: AbortSignal,
): Promise<QueryEventBatchWrite> {
  const progress: Progress = { settled: 0, rejections: [] };
  try {
    const schema = governancePostgresSchema();
    await withGovernanceClient(signal, (client) => insertBatch(client, schema, rows, signal, progress));
    return { settled: progress.settled, rejections: progress.rejections, failure: null };
  } catch (error) {
    return { settled: progress.settled, rejections: progress.rejections, failure: failureOf(error) };
  }
}
