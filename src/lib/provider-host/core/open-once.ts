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
 * A table may be created with a deadline, its owner's (docs/providers/CONTRACT.md, clause C-55): when a flight starts,
 * the table reads `deadline.signal(meta)` once, and when that signal aborts before the open settled, the open is over.
 * Every caller still waiting rejects with `deadline.expired(flight)`, by reference; the flight leaves the table, so the
 * next caller of its key starts a new open; and the flight's own signal aborts with the same error, so the open, once
 * it settles, closes what it opened and admits nothing, and a failure it settles with goes to `unclaimed`. Unlike a
 * discard, which keeps the open in the table, a deadline is the owner's statement that the open will not be waited for
 * any more. A flight leaves the table only as its own entry, so a late settle of an expired open never removes the open
 * that replaced it. Until it settles, an expired open is kept in the table's `expired` set, where no caller can join
 * it but a discard still answers it, so an owner that closes everything still waits for an open its deadline ended
 * and can name it when it is still connecting. A deadline already passed when a flight would start expires it at once, and `start` is not run.
 * Core keeps no timer: the owner's signal carries the time. A table created without a deadline waits for each open
 * until it settles.
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
  /** What a caller waits on: the open's answer, or the owner's expired error once its deadline aborted first. */
  readonly answer: Promise<T>;
  /** Resolves once the open settled, either way; never rejects. */
  readonly settled: Promise<void>;
  /** The callers still waiting on this open. */
  waiting: number;
  /** Whether the open's deadline ended it before it settled. */
  expired: boolean;
}

/**
 * An open table's deadline, its owner's: `signal` answers, from a flight's meta, the signal that aborts when that open
 * is over, read once when the flight starts; `expired` answers the error every caller still waiting then rejects with.
 */
export interface OpenDeadline<M> {
  readonly signal: (meta: M) => AbortSignal;
  readonly expired: (flight: Flight<M>) => unknown;
}

/**
 * The opens in flight of one cache, by key, the opens their deadline ended that are still pending, where a failure no
 * caller waits for goes, and the opens' deadline.
 */
export interface OpenFlights<T, M> {
  readonly entries: Map<string, FlightEntry<T, M>>;
  /** Opens whose deadline ended them before they settled: no caller joins one, a discard still answers it. */
  readonly expired: Set<FlightEntry<T, M>>;
  readonly unclaimed: (error: unknown, flight: Flight<M>) => void;
  readonly deadline: OpenDeadline<M> | undefined;
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

/**
 * A new, empty open table whose failures with no caller left go to `unclaimed`, and whose opens end at `deadline` when
 * one is given.
 */
export function createOpenFlights<T, M>(
  unclaimed: (error: unknown, flight: Flight<M>) => void,
  deadline?: OpenDeadline<M>,
): OpenFlights<T, M> {
  return { entries: new Map(), expired: new Set(), unclaimed, deadline };
}

/** Runs `start`, with a throw before it answers a promise read as its rejection. */
function startOpen<T, M>(start: (flight: Flight<M>) => Promise<T>, flight: Flight<M>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(start(flight));
  });
}

/**
 * What a caller of `entry` waits on: the open itself, or, with a deadline, the open until `deadlineSignal` aborts,
 * when `expire` ends the entry and answers the error the wait rejects with.
 */
function answerWithin<T>(open: Promise<T>, deadlineSignal: AbortSignal, expire: () => unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => {
      reject(expire());
    };
    deadlineSignal.addEventListener("abort", stop, { once: true });
    open.then(
      (value) => {
        deadlineSignal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        deadlineSignal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/**
 * Starts an open under `key` and records it in `flights` until it settles or its deadline ends it, or, when the
 * deadline has already passed, answers the owner's expired error without starting it.
 */
function startFlight<T, M>(
  flights: OpenFlights<T, M>,
  key: string,
  meta: M,
  start: (flight: Flight<M>) => Promise<T>,
): FlightEntry<T, M> | { readonly passed: unknown } {
  const controller = new AbortController();
  const flight: Flight<M> = { key, meta, signal: controller.signal };
  const deadlineSignal = flights.deadline?.signal(meta);
  if (deadlineSignal?.aborted === true) {
    const error = (flights.deadline as OpenDeadline<M>).expired(flight);
    controller.abort(error);
    return { passed: error };
  }
  const open = startOpen(start, flight);
  const settled = open.then(
    () => {
      leave();
    },
    (error: unknown) => {
      leave();
      // Attached when the open starts, so it runs before any caller's own handler: `waiting` still counts every caller
      // the failure reaches, and none is left exactly when the callers that were waiting all stopped. Once the
      // deadline ended the open, every caller was answered its expired error, so the failure reaches none of them.
      if (entry.expired || entry.waiting === 0) flights.unclaimed(error, flight);
    },
  );
  const answer =
    deadlineSignal === undefined
      ? open
      : answerWithin(open, deadlineSignal, () => {
          entry.expired = true;
          leave();
          flights.expired.add(entry);
          const error = (flights.deadline as OpenDeadline<M>).expired(flight);
          controller.abort(error);
          return error;
        });
  const entry: FlightEntry<T, M> = { flight, controller, answer, settled, waiting: 0, expired: false };
  /**
   * Removes this entry from the table, and never an entry that replaced it under the same key, and from the expired
   * set, where only a settle finds it.
   */
  function leave(): void {
    if (flights.entries.get(key) === entry) flights.entries.delete(key);
    flights.expired.delete(entry);
  }
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
  if ("passed" in entry) return Promise.reject(entry.passed);
  entry.waiting += 1;
  // The table's own handler, attached when the open started, owns what a caller stopped waiting for: the open admits
  // its own result, and a failure with no caller left goes to `unclaimed`. So the late handler has nothing to do.
  const answer = wait === undefined ? entry.answer : awaitWithin(entry.answer, wait.signal, () => {});
  return answer.finally(() => {
    entry.waiting -= 1;
  });
}

/**
 * Aborts the signal of every open in flight `matches` accepts, with `reason`, and answers those flights. Each stays in
 * the table until its open settles. An open its deadline ended that is still pending is answered too; its signal
 * already aborted with the expired error, so it keeps that reason.
 */
export function discardFlights<T, M>(
  flights: OpenFlights<T, M>,
  matches: (flight: Flight<M>) => boolean,
  reason: unknown,
): DiscardedFlight<M>[] {
  return [...flights.entries.values(), ...flights.expired]
    .filter((entry) => matches(entry.flight))
    .map((entry) => {
      entry.controller.abort(reason);
      return { flight: entry.flight, settled: entry.settled };
    });
}
