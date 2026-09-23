/**
 * The per-connection limit on PromQL queries in flight (#1085 section 3.6 and #1085 S6)
 *
 * Rule evaluation and API queries share one engine and one active-query tracker on the monitored
 * server, whose `--query.max-concurrency` defaults to 20. Every Studio user of a connection, and
 * every query a tree click runs on its own, would otherwise compete with the server's own alerting
 * rules for those slots without any bound. So a connection runs at most QUERY_CONCURRENCY_LIMIT
 * queries at once and queues the rest, first in first out.
 *
 * A query cancelled while it waits leaves the queue without running, so it never reaches the
 * server. One cancelled while it runs is its own business: it holds the same signal, and the
 * request it is making stops on it.
 */

/** Set by the live pass: tests/fixtures/prometheus/README.md, section "Measurements", entry M11, records how. */
export const QUERY_CONCURRENCY_LIMIT = 4;

export interface QueryLimiter {
  /**
   * Runs task when a slot is free, first in first out. A signal that aborts while the task waits
   * rejects with signal.reason and frees nothing, because nothing was taken.
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  readonly inFlight: number;
  readonly waiting: number;
}

export function createQueryLimiter(limit: number): QueryLimiter {
  // Below one slot every query would wait forever; a fraction admits one query more than it says.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`A query limit is a whole number of at least 1, not ${limit}`);
  }
  let inFlight = 0;
  /** Each waiting query's wake-up, oldest first. */
  const queue: (() => void)[] = [];

  /** A slot for the caller: a free one at once, or the next one released, in arrival order. */
  const acquire = (signal: AbortSignal | undefined): Promise<void> => {
    if (inFlight < limit) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal?.removeEventListener("abort", leave);
        resolve();
      };
      // Waiting took nothing, so leaving gives nothing back: the waiter only steps out of the queue.
      const leave = (): void => {
        queue.splice(queue.indexOf(wake), 1);
        reject(signal?.reason);
      };
      queue.push(wake);
      signal?.addEventListener("abort", leave, { once: true });
    });
  };

  /**
   * Hands a finished query's slot straight to the oldest waiter, so inFlight never dips and a
   * query arriving at that moment cannot take the slot ahead of the queue. With nobody waiting,
   * the slot is given back.
   */
  const release = (): void => {
    const next = queue.shift();
    if (next === undefined) inFlight -= 1;
    else next();
  };

  return {
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      // A signal that has already fired never fires again, so it is answered here.
      if (signal?.aborted) throw signal.reason;
      await acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    },
    get inFlight() {
      return inFlight;
    },
    get waiting() {
      return queue.length;
    },
  };
}
