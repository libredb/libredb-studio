/**
 * The in-flight bounds every client call of a provider passes through, and the run registry a provider cancels by.
 *
 * Two bounds hold at once. A provider instance keeps at most `perProvider` calls in flight, and every provider of
 * one engine key in this process together at most `perEngine`; a call past either waits in one FIFO queue per
 * engine key, and a full queue refuses at once with a sentence that names the bound. The engine key is data the
 * provider passes, so this module names no engine, and it imports nothing but the error classes, so nothing in it
 * is Node-only.
 *
 * Admission takes the earliest waiting call whose provider is below its own bound while the engine is below its
 * bound: one provider's calls keep their order, and a provider at its own bound never holds back a later call of
 * another provider that could run. A call whose signal aborts while it waits leaves the queue having sent nothing.
 * The caller's signal already carries the call's deadline, so the wait counts inside it.
 *
 * A permit admits one wire call. A caller that holds a permit never asks for another, so no wait is nested and
 * admission cannot deadlock: a console request holds one across its metadata reads and its execution call, issued
 * one after the other, and every other caller takes one per call it has in flight.
 */
import { QueryCancelledError, QueryError } from "@/lib/db/errors";

export interface BoundedLimiterOptions {
  /** Calls in flight for one provider instance. */
  readonly perProvider: number;
  /** Calls in flight across every provider of one engine key in this process. */
  readonly perEngine: number;
  /** Waiting calls per engine key; a full queue refuses. */
  readonly queueDepth: number;
}

/** One admitted call's permit. Releasing it twice frees one slot, never two. */
export interface LimiterTicket {
  release(): void;
}

/** The refusal of a call that found its engine's queue full; nothing was sent. */
export class LimiterFullError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "LimiterFullError";
    Object.setPrototypeOf(this, LimiterFullError.prototype);
  }
}

/** One provider instance's way in: a permit for one call, the signal's reason, or a full-queue refusal. */
export interface ProviderLimiter {
  acquire(signal: AbortSignal): Promise<LimiterTicket>;
}

interface ProviderSlots {
  inFlight: number;
}

interface Waiter {
  readonly slots: ProviderSlots;
  readonly signal: AbortSignal;
  readonly admit: (ticket: LimiterTicket) => void;
  readonly leave: () => void;
}

interface EngineTable {
  readonly options: BoundedLimiterOptions;
  inFlight: number;
  readonly queue: Waiter[];
}

/** One table per engine key, for the whole process: the counters every provider of that engine shares. */
const ENGINES = new Map<string, EngineTable>();

const INVALID_OPTIONS =
  "BoundedLimiterOptions takes whole numbers: perProvider and perEngine at least 1, and queueDepth at least 0";

function assertOptions(options: BoundedLimiterOptions): void {
  const { perProvider, perEngine, queueDepth } = options;
  const valid =
    Number.isInteger(perProvider) &&
    perProvider >= 1 &&
    Number.isInteger(perEngine) &&
    perEngine >= 1 &&
    Number.isInteger(queueDepth) &&
    queueDepth >= 0;
  if (!valid) throw new Error(INVALID_OPTIONS);
}

function sameOptions(a: BoundedLimiterOptions, b: BoundedLimiterOptions): boolean {
  return a.perProvider === b.perProvider && a.perEngine === b.perEngine && a.queueDepth === b.queueDepth;
}

function fullQueueSentence(options: BoundedLimiterOptions): string {
  return (
    `This engine already has ${options.queueDepth} calls waiting for its ${options.perEngine} in-flight slots ` +
    "in this Studio process, so the call was refused before it was sent. Try again when the running calls finish."
  );
}

/** Takes one slot of the provider and one of the engine, and hands back the permit that gives both back once. */
function take(table: EngineTable, slots: ProviderSlots): LimiterTicket {
  table.inFlight += 1;
  slots.inFlight += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      table.inFlight -= 1;
      slots.inFlight -= 1;
      admitWaiting(table);
    },
  };
}

/** Admits, in queue order, every waiting call whose provider is below its bound while the engine is below its own. */
function admitWaiting(table: EngineTable): void {
  let index = 0;
  while (index < table.queue.length && table.inFlight < table.options.perEngine) {
    const waiter = table.queue[index];
    if (waiter.slots.inFlight < table.options.perProvider) {
      table.queue.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.leave);
      waiter.admit(take(table, waiter.slots));
    } else {
      index += 1;
    }
  }
}

function providerLimiter(table: EngineTable): ProviderLimiter {
  const slots: ProviderSlots = { inFlight: 0 };
  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      // Every call already waiting is held back by a full engine or by its own provider's bound, because each
      // release admits whatever can run, so a call that can run now overtakes nobody it should follow.
      if (table.inFlight < table.options.perEngine && slots.inFlight < table.options.perProvider) {
        return Promise.resolve(take(table, slots));
      }
      if (table.queue.length >= table.options.queueDepth) {
        return Promise.reject(new LimiterFullError(fullQueueSentence(table.options)));
      }
      return new Promise<LimiterTicket>((resolve, reject) => {
        const waiter: Waiter = {
          slots,
          signal,
          admit: resolve,
          leave: () => {
            table.queue.splice(table.queue.indexOf(waiter), 1);
            reject(signal.reason);
          },
        };
        signal.addEventListener("abort", waiter.leave, { once: true });
        table.queue.push(waiter);
      });
    },
  };
}

/**
 * The limiter of one engine key: call the answer once per provider instance for that instance's own limiter.
 *
 * A second call for the same key with the same bounds shares the first one's table, so two modules of one engine
 * cannot split its bound in two; a second call with other bounds throws, because one engine has one bound.
 */
export function engineLimiter(engineKey: string, options: BoundedLimiterOptions): () => ProviderLimiter {
  assertOptions(options);
  const existing = ENGINES.get(engineKey);
  if (existing !== undefined && !sameOptions(existing.options, options)) {
    throw new Error(
      `engineLimiter("${engineKey}") was already created with other bounds: one engine key has one set of bounds in a process`,
    );
  }
  const table: EngineTable = existing ?? { options: { ...options }, inFlight: 0, queue: [] };
  ENGINES.set(engineKey, table);
  return () => providerLimiter(table);
}

/** The refusal of a `queryId` already running or waiting on this provider; nothing was sent. */
export class DuplicateRunError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateRunError";
    Object.setPrototypeOf(this, DuplicateRunError.prototype);
  }
}

/** One run's view of the registry: the signal its calls take, and the end it reports when it settles. */
export interface RunHandle {
  readonly signal: AbortSignal;
  end(): void;
}

/** A provider instance's runs by `queryId`, which `POST /api/db/cancel` reaches through the provider's `cancelQuery`. */
export interface RunRegistry {
  /** Throws `DuplicateRunError` for a `queryId` already running or queued. */
  begin(queryId: string | undefined, deadline: AbortSignal): RunHandle;
  /** Aborts a running or queued run; false for an unknown id. */
  cancel(queryId: string): boolean;
}

/** The browser's `q-<epoch ms>-<id>` fits, and nothing a client could use to make the registry hold a large key. */
const QUERY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const QUERY_ID_SENTENCE = 'queryId must be 1 to 128 characters of letters, digits, "_" and "-"';
const DUPLICATE_RUN_SENTENCE =
  "A run with this queryId is already running or waiting on this connection. Start the next run with a new queryId.";
const CANCELLED_SENTENCE = "The query was cancelled.";

/**
 * The runs of one provider instance, so every user of a shared seed shares them: a cancel names a run by its id
 * alone, with no owner check, as `POST /api/db/cancel` does for every cancel-capable provider, and only a client
 * that reuses its own id meets `DuplicateRunError`.
 *
 * A run's signal aborts at its deadline or at its cancel, whichever comes first. Nothing bridges a dropped HTTP
 * request to a cancel, so a run abandoned without Stop ends at its deadline.
 */
export function createRunRegistry(): RunRegistry {
  const runs = new Map<string, AbortController>();
  return {
    begin(queryId, deadline) {
      if (queryId === undefined) return { signal: deadline, end: () => {} };
      if (typeof queryId !== "string" || !QUERY_ID.test(queryId)) throw new QueryError(QUERY_ID_SENTENCE);
      if (runs.has(queryId)) throw new DuplicateRunError(DUPLICATE_RUN_SENTENCE);
      const controller = new AbortController();
      runs.set(queryId, controller);
      return {
        signal: AbortSignal.any([deadline, controller.signal]),
        end() {
          // Only this run's own entry: once it ended, the same id may name a newer run, which must stay cancellable.
          if (runs.get(queryId) === controller) runs.delete(queryId);
        },
      };
    },
    cancel(queryId) {
      const controller = runs.get(queryId);
      if (controller === undefined) return false;
      controller.abort(new QueryCancelledError(CANCELLED_SENTENCE));
      return true;
    },
  };
}
