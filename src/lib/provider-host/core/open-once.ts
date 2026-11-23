/**
 * One open in flight per key (docs/providers/CONTRACT.md, clause C-44), part of the provider host core.
 *
 * An open table (`OpenFlights`) holds the opens in flight of one cache, by the key the cache holds what they open under.
 * `openOnce` hands a caller who finds an open in flight under its key that open, so concurrent callers share one promise
 * and one open; a caller who finds none starts `start(flight)` and records it. When the open settles its entry leaves
 * the table, so the next call after a failure starts a new open.
 *
 * Each caller may pass a signal of its own: its wait ends when that signal aborts, with the signal's reason by
 * reference, through the SDK's `awaitWithin`, and the open goes on for the others. A caller whose signal already
 * aborted starts nothing and joins nothing. The open admits its own result: `start` puts what it opened into its cache
 * itself, so an open that settles after every caller left is admitted exactly once and never orphaned. The table
 * attaches a handler to every open when it starts it, so an open that fails with no caller left is never a detached
 * rejection: that failure goes to the table's `unclaimed` hook, given by whoever creates the table.
 *
 * `discardFlights` aborts the signal of every open in flight a predicate matches, the flight's own signal that `start`
 * receives, and answers those flights. An open reads that signal once it has opened: an aborted one closes what it
 * opened, admits nothing and fails its callers. A discarded open stays in the table until it settles, so a caller
 * arriving meanwhile joins it and gets its answer rather than opening a second time beside it.
 *
 * Core answers plain data and passes errors through by reference; it constructs no class a caller in another bundle
 * would test with `instanceof`. It keeps no module state: each table is created by its owner and handed in
 * (tests/unit/lib/provider-host/core-boundary.test.ts).
 */
import { awaitWithin } from "@libredb/provider-sdk/calls";

/** One open in flight: the key it opens under, what its owner recorded about it, and the signal a discard aborts. */
export interface Flight<M> {
  readonly key: string;
  readonly meta: M;
  readonly signal: AbortSignal;
}

interface FlightEntry<T, M> {
  readonly flight: Flight<M>;
  readonly controller: AbortController;
  readonly open: Promise<T>;
  /** Resolves once the open settled, either way; never rejects. */
  readonly settled: Promise<void>;
  /** The callers still waiting on this open. */
  waiting: number;
}

/** The opens in flight of one cache, by key, and where a failure no caller waits for goes. */
export interface OpenFlights<T, M> {
  readonly entries: Map<string, FlightEntry<T, M>>;
  readonly unclaimed: (error: unknown, flight: Flight<M>) => void;
}

/** A caller's own wait: it ends when `signal` aborts. */
export interface OpenWait {
  readonly signal: AbortSignal;
}

/** A flight a discard aborted, and a promise that resolves once its open settled, either way. */
export interface DiscardedFlight<M> {
  readonly flight: Flight<M>;
  readonly settled: Promise<void>;
}

/** A new, empty open table whose failures with no caller left go to `unclaimed`. */
export function createOpenFlights<T, M>(unclaimed: (error: unknown, flight: Flight<M>) => void): OpenFlights<T, M> {
  return { entries: new Map(), unclaimed };
}

/** Runs `start`, with a throw before it answers a promise read as its rejection. */
function startOpen<T, M>(start: (flight: Flight<M>) => Promise<T>, flight: Flight<M>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(start(flight));
  });
}

/** Starts an open under `key` and records it in `flights` until it settles. */
function startFlight<T, M>(
  flights: OpenFlights<T, M>,
  key: string,
  meta: M,
  start: (flight: Flight<M>) => Promise<T>,
): FlightEntry<T, M> {
  const controller = new AbortController();
  const flight: Flight<M> = { key, meta, signal: controller.signal };
  const open = startOpen(start, flight);
  const settled = open.then(
    () => {
      flights.entries.delete(key);
    },
    (error: unknown) => {
      flights.entries.delete(key);
      // Attached when the open starts, so it runs before any caller's own handler: `waiting` still counts every caller
      // the failure reaches, and none is left exactly when the callers that were waiting all stopped.
      if (entry.waiting === 0) flights.unclaimed(error, flight);
    },
  );
  const entry: FlightEntry<T, M> = { flight, controller, open, settled, waiting: 0 };
  flights.entries.set(key, entry);
  return entry;
}

/**
 * The open under `key`: the one in flight when there is one, otherwise a new one `start` runs, recorded with `meta`.
 * With `wait`, the caller stops waiting when `wait.signal` aborts and rejects with its reason; a signal already aborted
 * rejects at once, before any open is started or joined.
 */
export function openOnce<T, M>(
  flights: OpenFlights<T, M>,
  key: string,
  meta: M,
  start: (flight: Flight<M>) => Promise<T>,
  wait?: OpenWait,
): Promise<T> {
  if (wait?.signal.aborted === true) return Promise.reject(wait.signal.reason);
  const entry = flights.entries.get(key) ?? startFlight(flights, key, meta, start);
  entry.waiting += 1;
  // The table's own handler, attached when the open started, owns what a caller stopped waiting for: the open admits
  // its own result, and a failure with no caller left goes to `unclaimed`. So the late handler has nothing to do.
  const answer = wait === undefined ? entry.open : awaitWithin(entry.open, wait.signal, () => {});
  return answer.finally(() => {
    entry.waiting -= 1;
  });
}

/**
 * Aborts the signal of every open in flight `matches` accepts, with `reason`, and answers those flights. Each stays in
 * the table until its open settles.
 */
export function discardFlights<T, M>(
  flights: OpenFlights<T, M>,
  matches: (flight: Flight<M>) => boolean,
  reason: unknown,
): DiscardedFlight<M>[] {
  return Array.from(flights.entries.values())
    .filter((entry) => matches(entry.flight))
    .map((entry) => {
      entry.controller.abort(reason);
      return { flight: entry.flight, settled: entry.settled };
    });
}
