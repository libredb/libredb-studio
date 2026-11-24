/**
 * A cached expiring value for one connection, such as an access token or a temporary database password: served until
 * earlyMs before it expires; concurrent callers share one refresh, which runs on its own 30-second deadline combined
 * with close(), so no caller's abort fails the others; a failed refresh caches nothing.
 *
 * The closed state and the deadline reach a refresh separately: RefreshRun.signal aborts on either, while
 * throwIfClosed() reads close() alone, so a deadline that fires during a step that takes no signal, such as signing,
 * is reported as the timeout its next request meets, never as closed.
 *
 * The clock and the deadline come in as options; there is no module-level state, and one instance belongs to one
 * connection.
 */
import { TransportError } from "@/lib/db/http/node-transport";

/** A value and the instant, in the options' clock, at which it stops being valid. */
export interface Expiring<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/** What one refresh is given. */
export interface RefreshRun {
  /** Aborts on close() or after the 30-second deadline; every request of the refresh takes it. */
  readonly signal: AbortSignal;
  /** Throws TransportError("aborted", sentences.closed) once close() was called: for a step that takes no signal, such as signing. */
  throwIfClosed(): void;
}

export interface RefreshingValueOptions<T> {
  refresh(run: RefreshRun): Promise<Expiring<T>>;
  /** A cached value is served until expiresAt - earlyMs. */
  readonly earlyMs: number;
  now(): number;
  timeoutSignal(ms: number): AbortSignal;
  readonly sentences: { readonly closed: string };
}

export interface RefreshingValue<T> {
  /** The cached value, or the one shared refresh; this caller's own abort rejects only this caller, with today's two TransportError sentences. */
  get(signal: AbortSignal): Promise<T>;
  /** Aborts the refresh, drops the value, and makes every later get() reject with TransportError("aborted", sentences.closed). */
  close(): void;
}

/** The shared refresh runs on its own deadline, so no single caller's abort fails the others waiting on it. */
const REFRESH_TIMEOUT_MS = 30_000;

/** The shared work, or this caller's own abort as the node transport reports one, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
          ? new TransportError("timeout", "The request did not finish within its time limit")
          : new TransportError("aborted", "The request was cancelled"),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const release = () => signal.removeEventListener("abort", onAbort);
    work.then(
      (value) => {
        release();
        resolve(value);
      },
      (error: unknown) => {
        release();
        reject(error);
      },
    );
  });
}

export function createRefreshingValue<T>(options: RefreshingValueOptions<T>): RefreshingValue<T> {
  const closer = new AbortController();
  let cached: Expiring<T> | null = null;
  let pending: Promise<T> | null = null;

  const throwIfClosed = () => {
    if (closer.signal.aborted) throw new TransportError("aborted", options.sentences.closed);
  };

  const refresh = async (signal: AbortSignal): Promise<T> => {
    const fresh = await options.refresh({ signal, throwIfClosed });
    cached = fresh;
    return fresh.value;
  };

  return {
    get(signal) {
      if (closer.signal.aborted) return Promise.reject(new TransportError("aborted", options.sentences.closed));
      if (cached !== null && options.now() < cached.expiresAt - options.earlyMs) return Promise.resolve(cached.value);
      pending ??= refresh(AbortSignal.any([closer.signal, options.timeoutSignal(REFRESH_TIMEOUT_MS)])).finally(() => {
        pending = null;
      });
      return untilAborted(pending, signal);
    },
    close() {
      closer.abort();
      cached = null;
    },
  };
}
