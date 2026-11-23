/**
 * Teardown under fixed deadlines (docs/providers/CONTRACT.md, clause C-45), part of the provider host core.
 *
 * A provider's teardown has two steps: a rollback of the transaction it holds open, when it holds one, and then its
 * close. The rollback comes first because a close may wait on the very session the transaction holds (`pg`'s
 * `pool.end()` waits for every checked-out client). `teardownWithin` waits for the rollback at most `rollbackMs` and
 * then for the close at most `closeMs`, and answers how each step ended: `done`, `timed-out`, `failed` with the error by
 * reference, or `none` for a rollback there was no need for. It never rejects, so a caller tearing many providers down
 * at once loses none of the others to one failure. A step it stopped waiting for keeps the handler the wait attached, so
 * its later rejection is never a detached one, and the timers end with the answer, so nothing holds the process open
 * past it.
 *
 * The deadlines are parameters, so a bounded child can run the same function with short ones; Studio tears its
 * providers down under `TEARDOWN_ROLLBACK_MS` and `TEARDOWN_CLOSE_MS`, defined here as the one source.
 *
 * Core imports only the SDK's public subpaths other than `testing`, Node built-ins and its own files, and keeps no
 * module state (tests/unit/lib/provider-host/core-boundary.test.ts).
 */

/** How long a teardown waits for the rollback of a provider's open transaction. */
export const TEARDOWN_ROLLBACK_MS = 5_000;
/** How long a teardown waits for a provider's close before it gives the provider up. */
export const TEARDOWN_CLOSE_MS = 10_000;

/** How a piece of work ended within a wait: settled, cut at the wait's end, or failed with its error by reference. */
export type Settled =
  | { readonly state: "done" }
  | { readonly state: "timed-out" }
  | { readonly state: "failed"; readonly error: unknown };

/**
 * Waits for `work` at most `ms` and answers how it ended; never rejects. A rejection after the cut is already handled by
 * the wait, and the timer is cleared once the answer is known and never holds the process open.
 */
export async function settleWithin(work: Promise<unknown>, ms: number): Promise<Settled> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ state: "timed-out" }), ms);
    timer.unref?.();
  });
  const settled = work.then(
    (): Settled => ({ state: "done" }),
    (error: unknown): Settled => ({ state: "failed", error }),
  );
  try {
    return await Promise.race([settled, cut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The two steps of a teardown; a step that throws before it answers a promise has failed. */
export interface TeardownSteps {
  /** Rolls back the transaction the provider holds open; absent when it holds none. */
  readonly rollback?: () => Promise<void>;
  /** Closes the provider. */
  readonly close: () => Promise<void>;
}

/** How long each step is waited for, in milliseconds. */
export interface TeardownDeadlines {
  readonly rollbackMs: number;
  readonly closeMs: number;
}

/** How each step of a teardown ended; an error field is present exactly when its step failed. */
export interface TeardownOutcome {
  readonly rollback: "none" | Settled["state"];
  readonly rollbackError?: unknown;
  readonly close: Settled["state"];
  readonly closeError?: unknown;
}

/** Runs `step`, with a throw before it answers a promise read as its rejection. */
function startStep(step: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    resolve(step());
  });
}

/**
 * Tears a provider down: the rollback, when there is one, waited for at most `deadlines.rollbackMs`, then the close,
 * started only once the rollback ended and waited for at most `deadlines.closeMs`. Answers how each step ended and
 * never rejects.
 */
export async function teardownWithin(steps: TeardownSteps, deadlines: TeardownDeadlines): Promise<TeardownOutcome> {
  const rollback: Settled | null =
    steps.rollback === undefined ? null : await settleWithin(startStep(steps.rollback), deadlines.rollbackMs);
  const close = await settleWithin(startStep(steps.close), deadlines.closeMs);
  return {
    rollback: rollback === null ? "none" : rollback.state,
    ...(rollback?.state === "failed" ? { rollbackError: rollback.error } : {}),
    close: close.state,
    ...(close.state === "failed" ? { closeError: close.error } : {}),
  };
}
