/**
 * A call's one deadline, the signal that aborts at it, the check that no call starts after either ended, and the
 * host's wait on a provider's answer, ended by that signal (docs/providers/CONTRACT.md, clauses C-26 to C-28).
 *
 * The host owns the deadline: one absolute time, in epoch milliseconds on the clock `Date.now()` reads, consumed by
 * every step of the call. `deadlineSignal` builds the signal the host passes in the call's context, from the standard
 * `AbortSignal.timeout` and `AbortSignal.any`. Node.js does not let that timer keep a process alive, so nothing may
 * rely on the signal to do so. A signal does not abort at once when its deadline has already passed, so
 * `checkCallStart` reads the deadline by time as well as the signal.
 *
 * `awaitWithin` is the host's wait: it ends when the signal aborts, and the answer the host stopped waiting for keeps
 * a handler for its value and for its error, which hands either to the host's `late` handler, so no abandoned
 * rejection goes unhandled and no late session or source goes unclosed.
 *
 * A cleanup call, a close or the cancel a stopped wait sends, ends work the call it follows started, so it never runs
 * under that call's context, which may have aborted: `cleanupContext` gives it one of its own, `CLEANUP_DEADLINE_MS`
 * ahead (docs/providers/CONTRACT.md, clause C-47).
 */
import type { EnvReader } from "./env";
import { type CallRefusal, CallRefusalError } from "./refusals";
import type { CallContext } from "./types";

/** The longest delay a timer waits on Node.js, which runs a longer one after one millisecond. */
const TIMER_MAX_MS = 2147483647;

/** How long a cleanup call may take: a close, or the cancel a stopped wait sends. */
export const CLEANUP_DEADLINE_MS = 10_000;

/**
 * @throws {RangeError} When `deadline` is not a finite number, a host defect.
 */
function checkDeadline(deadline: number): void {
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
    throw new RangeError("The call deadline must be a finite number of epoch milliseconds.");
  }
}

/**
 * The signal a host passes in a call's context: aborted at `deadline` with a DOMException named `TimeoutError`, or with
 * `caller`'s own reason when `caller` aborts first. A deadline already past answers a signal already aborted, and a
 * caller already aborted answers its reason.
 *
 * @throws {RangeError} For a deadline that is not a finite number, or one further ahead than a timer waits, both host
 * defects, before any signal is built.
 */
export function deadlineSignal(deadline: number, caller?: AbortSignal): AbortSignal {
  checkDeadline(deadline);
  const remaining = Math.ceil(deadline - Date.now());
  if (remaining > TIMER_MAX_MS) {
    throw new RangeError(
      `The call deadline must be at most ${TIMER_MAX_MS} milliseconds ahead, the longest a timer waits.`,
    );
  }
  const timeout =
    remaining <= 0
      ? AbortSignal.abort(new DOMException("The call's deadline has passed.", "TimeoutError"))
      : AbortSignal.timeout(remaining);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
}

/**
 * A cleanup call's own context: a deadline `CLEANUP_DEADLINE_MS` after now, a signal that aborts only at it, never one
 * that already aborted, and `env`, the reader of the call it cleans up after, by reference.
 */
export function cleanupContext(env: EnvReader): CallContext {
  const deadline = Date.now() + CLEANUP_DEADLINE_MS;
  return { deadline, signal: deadlineSignal(deadline), env };
}

/**
 * Why a call with the context `ctx` must not start: `call-deadline-passed` at `/deadline` when `Date.now()` has reached
 * the deadline, then `call-signal-aborted` at `/signal` when the signal has aborted; none when the call may start.
 *
 * @throws {RangeError} For a deadline that is not a finite number, a host defect.
 */
export function checkCallStart(ctx: Pick<CallContext, "deadline" | "signal">): readonly CallRefusal[] {
  checkDeadline(ctx.deadline);
  const refusals: CallRefusal[] = [];
  if (Date.now() >= ctx.deadline) refusals.push({ rule: "call-deadline-passed", pointer: "/deadline" });
  if (ctx.signal.aborted) refusals.push({ rule: "call-signal-aborted", pointer: "/signal" });
  return refusals;
}

/**
 * Throws when a call with the context `ctx` must not start, as `checkCallStart` answers, the signal's reason as the
 * error's cause when the signal has aborted.
 *
 * @throws {CallRefusalError} With every refusal `checkCallStart` answers.
 * @throws {RangeError} For a deadline that is not a finite number, a host defect.
 */
export function refuseCallStart(ctx: Pick<CallContext, "deadline" | "signal">): void {
  const refusals = checkCallStart(ctx);
  if (refusals.length === 0) return;
  throw new CallRefusalError(refusals, ctx.signal.aborted ? { cause: ctx.signal.reason } : undefined);
}

/** What an answer the host stopped waiting for came to: its value, or its error, each by reference. */
export type LateOutcome<T> =
  | { readonly kind: "answered"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * The host's wait on `answer`, a provider's answer, ended by `signal`.
 *
 * When `answer` settles first, the wait settles the same way, a rejection with the same error, and its listener on
 * `signal` is removed, so a long-lived signal gathers none. When `signal` aborts first, or had aborted already, the
 * wait rejects with the signal's reason at once, and `answer` keeps a handler for its value and for its error that
 * calls `late` once with its outcome, by reference. The host's `late` closes what a late answer handed over and logs a late
 * failure. A `late` that throws is a host defect, and its error is a detached rejection.
 */
export function awaitWithin<T>(
  answer: Promise<T>,
  signal: AbortSignal,
  late: (outcome: LateOutcome<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const stop = (): void => {
      abandoned = true;
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    answer.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        if (abandoned) late({ kind: "answered", value });
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        if (abandoned) late({ kind: "failed", error });
        else reject(error);
      },
    );
  });
}
