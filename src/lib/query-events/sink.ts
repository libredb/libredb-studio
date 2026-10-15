/**
 * The query event sink (spec 7.9, 9.5): where the query events of this process wait until the governance source holds
 * them.
 *
 * A route calls `recordQueryEvent()` once a unit has ended. Under governance it builds the row with
 * `buildQueryEvent()` under the capture policy in force and queues it; outside governance it does nothing at all, so
 * a Studio without `GOVERNANCE_SOURCE` opens no pool and arms no timer. It never throws and never waits: a row that
 * cannot be built, which is the caller's defect, is logged and left out, because the request it describes must still
 * be answered.
 *
 * The queue holds at most 10000 events. One more is dropped and counted, the newest, so the events already queued keep
 * their order, and the first drop of each spell of a full queue is logged. The queue is flushed every second, or at
 * once when it holds 500 events, by `writeQueryEventBatch()` in `postgres-sink.ts`: one insert of at most 500 rows
 * from the head of the queue through the governance pool, which may take 10 s. An event leaves the queue once the
 * governance source holds it or refused it for good. After any other failure the rest of the batch stays at the head
 * with its event ids, so the retry is idempotent, and the sink backs off: the next insert waits 1 s, doubling to 30 s,
 * until one settles its whole batch.
 *
 * At shutdown the hook `query-events` (src/lib/shutdown.ts) inserts what is queued at once, batch after batch and
 * without waiting out the backoff, for at most 4 s, under the 5 s the shutdown gives every hook, and logs how many
 * events it could not send. It is registered with the events, so a process that records none has nothing to flush.
 *
 * `queryEventSinkState()` is the state the heartbeat reports in its `sink` column and the admin status shows, in the
 * manifest's `sink` shape. The queue, its counters and its timer live in a global under a registered symbol, one per
 * process, because the routes that record events and the heartbeat that reports them run in different bundles
 * (src/lib/governance/keyring.ts does the same).
 */
import { governanceEnabled } from "@/lib/governance/config";
import { governanceInstanceId } from "@/lib/governance/instance";
import { logger } from "@/lib/logger";
import { onShutdown } from "@/lib/shutdown";
import { buildQueryEvent, queryEventPolicy } from "./build";
import { type QueryEventBatchWrite, queryEventBackoffMs, writeQueryEventBatch } from "./postgres-sink";
import type { QueryEventInput, QueryEventRow } from "./types";

/** The most events the queue holds (spec 7.9). */
export const QUERY_EVENT_QUEUE_CAPACITY = 10_000;
/** The most events one insert carries, and the queue length that flushes at once (spec 7.9). */
export const QUERY_EVENT_BATCH_ROWS = 500;
/** The longest an event waits for its insert while the sink does not back off. */
const FLUSH_INTERVAL_MS = 1000;
/** The deadline of one insert, from asking the pool for a connection to the answer for its last row. */
const WRITE_DEADLINE_MS = 10_000;
/** The deadline of the shutdown flush: under the 5 s the shutdown gives every hook, so it ends on its own. */
const SHUTDOWN_FLUSH_DEADLINE_MS = 4000;

const SHUTDOWN_HOOK = "query-events";
const ROUTE = "query-events";

/** The sink's state as the heartbeat's `sink` column and the admin status report it: the manifest's `sink` shape. */
export interface QueryEventSinkState {
  /** Events waiting for their insert, those of an insert under way included. */
  readonly queued: number;
  /** Events dropped because the queue was full. */
  readonly dropped: number;
  /** Events the governance source refused for good, each logged as a `query_event_rejected` line. */
  readonly rejected: number;
  /** When an insert last settled its whole batch, as an ISO 8601 instant, or null before the first. */
  readonly lastFlushAt: string | null;
  /** Whether the sink waits out a failed insert before the next. */
  readonly backingOff: boolean;
  /** The SQLSTATE of the latest failed insert, or null before one and after one that carried none, such as a timeout. */
  readonly lastSqlstate: string | null;
}

interface Sink {
  /** The events the governance source neither holds nor refused yet, oldest first: an insert takes the head. */
  readonly queue: QueryEventRow[];
  dropped: number;
  rejected: number;
  /** When an insert last settled its whole batch, in epoch milliseconds. */
  lastFlushAt: number | null;
  lastSqlstate: string | null;
  /** Failed inserts in a row: the sink backs off while there is one. */
  failures: number;
  /** Whether an event was dropped since the queue last had room, so each spell of drops is logged once. */
  full: boolean;
  /** The next flush, while one is due. */
  timer?: ReturnType<typeof setTimeout>;
  /** The flush under way. */
  flushing?: Promise<void>;
  /** Set by the shutdown flush, after which no flush is armed. */
  closing: boolean;
}

const SINK_KEY = Symbol.for("libredb-studio.query-event-sink");

type SinkHolder = { [SINK_KEY]?: Sink };

const newSink = (): Sink => ({
  queue: [],
  dropped: 0,
  rejected: 0,
  lastFlushAt: null,
  lastSqlstate: null,
  failures: 0,
  full: false,
  closing: false,
});

function sink(): Sink {
  const holder = globalThis as SinkHolder;
  holder[SINK_KEY] ??= newSink();
  return holder[SINK_KEY];
}

/** Inserts the batch at the head of the queue under `signal`, and records what became of it. It never rejects. */
async function writeHead(state: Sink, signal: AbortSignal): Promise<QueryEventBatchWrite> {
  const write = await writeQueryEventBatch(state.queue.slice(0, QUERY_EVENT_BATCH_ROWS), signal);
  state.queue.splice(0, write.settled);
  if (state.queue.length < QUERY_EVENT_QUEUE_CAPACITY) state.full = false;
  state.rejected += write.rejections.length;
  const lastRejection = write.rejections.at(-1);
  if (lastRejection !== undefined) state.lastSqlstate = lastRejection.sqlstate;
  if (write.failure === null) {
    state.failures = 0;
    state.lastFlushAt = Date.now();
    return write;
  }
  state.failures += 1;
  state.lastSqlstate = write.failure.sqlstate;
  logger.warn("Query event insert failed", { route: ROUTE, reason: write.failure.reason, queued: state.queue.length });
  return write;
}

/** Inserts the batch at the head of the queue under its deadline, then arms the next flush. It never rejects. */
function flush(state: Sink): void {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`The query event insert did not finish within ${WRITE_DEADLINE_MS} ms`)),
    WRITE_DEADLINE_MS,
  );
  deadline.unref?.();
  state.flushing = writeHead(state, controller.signal).then(() => {
    clearTimeout(deadline);
    state.flushing = undefined;
    schedule(state);
  });
}

/**
 * Arms the next flush: at once when the queue holds a batch, else a second after the event that armed it, or after
 * the backoff while inserts fail. Nothing is armed while a flush is under way, which arms the next when it ends.
 */
function schedule(state: Sink): void {
  if (state.closing || state.flushing !== undefined || state.queue.length === 0) return;
  if (state.failures === 0 && state.queue.length >= QUERY_EVENT_BATCH_ROWS) {
    clearTimeout(state.timer);
    state.timer = undefined;
    flush(state);
    return;
  }
  if (state.timer !== undefined) return;
  const delayMs = state.failures === 0 ? FLUSH_INTERVAL_MS : queryEventBackoffMs(state.failures);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    flush(state);
  }, delayMs);
  // The sink must never hold the process open on its own.
  state.timer.unref?.();
}

function enqueue(state: Sink, row: QueryEventRow): void {
  if (state.queue.length >= QUERY_EVENT_QUEUE_CAPACITY) {
    state.dropped += 1;
    if (!state.full) {
      state.full = true;
      logger.warn("Query event queue full: new events are dropped until it has room", {
        route: ROUTE,
        capacity: QUERY_EVENT_QUEUE_CAPACITY,
      });
    }
    return;
  }
  state.queue.push(row);
  // The registry keeps one hook per name, so registering it with every event registers it once.
  onShutdown(SHUTDOWN_HOOK, flushQueryEvents);
  schedule(state);
}

/**
 * Records one executed unit, or one refused request, under governance, and does nothing outside it. Call it once the
 * unit has ended. It never throws and never waits: the row is built now and inserted later.
 */
export function recordQueryEvent(input: QueryEventInput): void {
  if (!governanceEnabled()) return;
  let row: QueryEventRow;
  try {
    row = buildQueryEvent(input, queryEventPolicy(), { studioInstance: governanceInstanceId() });
  } catch (error) {
    logger.error("Query event not recorded: no row can be made of it", error, { route: ROUTE, source: input.source });
    return;
  }
  enqueue(sink(), row);
}

/**
 * The shutdown hook `query-events`: inserts every queued event at once, batch after batch, without waiting out the
 * backoff, for at most 4 s, and logs how many it could not send. An insert under way ends first. No flush is armed
 * after it.
 */
export async function flushQueryEvents(): Promise<void> {
  const state = (globalThis as SinkHolder)[SINK_KEY];
  if (state === undefined) return;
  state.closing = true;
  clearTimeout(state.timer);
  state.timer = undefined;
  const controller = new AbortController();
  const deadline = setTimeout(
    () =>
      controller.abort(
        new Error(`The shutdown flush of query events did not finish within ${SHUTDOWN_FLUSH_DEADLINE_MS} ms`),
      ),
    SHUTDOWN_FLUSH_DEADLINE_MS,
  );
  const expired = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  if (state.flushing !== undefined) await Promise.race([state.flushing, expired]);
  let settledAll = true;
  while (settledAll && state.queue.length > 0 && !controller.signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- one insert at a time, each from the head of the queue.
    settledAll = (await writeHead(state, controller.signal)).failure === null;
  }
  clearTimeout(deadline);
  if (state.queue.length > 0) {
    logger.warn("Query events not flushed at shutdown", { route: ROUTE, unsent: state.queue.length });
  }
}

/** The state of the sink of this process: idle while it has recorded no event, and always outside governance. */
export function queryEventSinkState(): QueryEventSinkState {
  const state = (globalThis as SinkHolder)[SINK_KEY] ?? newSink();
  return {
    queued: state.queue.length,
    dropped: state.dropped,
    rejected: state.rejected,
    lastFlushAt: state.lastFlushAt === null ? null : new Date(state.lastFlushAt).toISOString(),
    backingOff: state.failures > 0,
    lastSqlstate: state.lastSqlstate,
  };
}

/** Test seam: forgets the queue, its counters and its timer, as a new process would. */
export function resetQueryEventSink(): void {
  const holder = globalThis as SinkHolder;
  clearTimeout(holder[SINK_KEY]?.timer);
  delete holder[SINK_KEY];
}
