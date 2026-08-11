/**
 * Run-level wall-clock deadline for an agent run (#329, epic #325).
 *
 * The M1 enforcement layer bounds how much DATABASE time a run consumes
 * (`maxTotalRunMs` in `budgets.ts`, summed from the elapsed times the execution
 * layer reports). Nothing there bounds how long the run may LIVE: time spent in
 * model latency, in a repair loop, or waiting on a caller is invisible to that
 * tracker, so a runaway agent could stay inside its database budget
 * indefinitely. This module is the missing control — the run loop owns one of
 * these per run, and it answers two questions before every tool call:
 *
 *  1. **May this call start at all?** A call whose minimum viable duration no
 *     longer fits in what is left is refused here, before the policy pipeline,
 *     rather than started and abandoned.
 *  2. **How long may it run?** The policy budget's `statementTimeoutMs` is a
 *     ceiling, not an entitlement: `admit` clamps it down to the time actually
 *     remaining, so the timeout the execution layer is handed can never be
 *     larger than what is left of the run.
 *
 * What that clamp is worth depends on the adapter, and this module does not
 * pretend otherwise. PostgreSQL preempts (`SET LOCAL statement_timeout`), so
 * there the clamp really does bound the overrun. SQLite's `statementTimeoutMs`
 * is checked AFTER the statement returns — there is no interrupt to preempt it
 * with (`docs/BACKLOG.md` A1, `docs/providers/sqlite.md`) — so clamping bounds
 * what is reported, not what runs. A budget meter built on this must say the
 * same thing rather than imply preemption.
 *
 * Three properties are load-bearing:
 *
 * - **The deadline is monotonic even if its clock is not.** Elapsed time
 *   accumulates from CLAMPED DELTAS (`max(0, reading - previous)`) rather than
 *   from the difference against the start, so a clock that steps backward (NTP
 *   correcting a wall clock, a caller passing `Date.now`) costs the run the time
 *   it lost instead of handing it back — a security bound a clock adjustment can
 *   extend is not a bound. A step forward and a sawtooth both over-count, which
 *   is the direction that is safe. The default clock is `performance.now`, which
 *   is monotonic by contract and is what the rest of this repository already
 *   measures durations with (`base-provider.ts`); `Date.now` is deliberately not
 *   used anywhere in this module.
 * - **The clock is injected**, exactly as `budgets.ts` and `execution.ts` inject
 *   theirs, so every branch below is reachable in a test without sleeping.
 * - **Every failure direction is "less time, never more".** A malformed
 *   construction or a malformed request throws loudly (a server-side
 *   programming error, the way `createTargetScope` and the budget tracker fail),
 *   while a clock that stops answering mid-run — by returning a non-finite
 *   reading or by throwing — exhausts the deadline instead of propagating:
 *   mid-run, a throw would hand the decision to whatever catch block the run
 *   loop happens to have, and "the run stops" is the safe answer.
 *
 * Admission reserves nothing. It answers for the instant it is asked, so the run
 * loop must call it immediately before the call it is about to make.
 */

/** Monotonic by contract, unlike `Date.now`. Wrapped so the receiver is right. */
const monotonicClock = (): number => performance.now();

/**
 * Why a call was not admitted. The two codes are not interchangeable: after
 * `INSUFFICIENT_TIME_REMAINING` a cheaper call may still be admitted, while
 * `RUN_DEADLINE_EXCEEDED` means the run is over and nothing else will be.
 */
export type AgentDeadlineDenyCode = "RUN_DEADLINE_EXCEEDED" | "INSUFFICIENT_TIME_REMAINING";

export interface AgentCallAdmissionRequest {
  /** The policy budget's per-statement timeout — the ceiling, never an entitlement. */
  readonly statementTimeoutMs: number;
  /** Least time this call could plausibly need; below it, starting it is waste. */
  readonly minimumMs: number;
}

/**
 * The outcome of asking to start one call. `statementTimeoutMs` is the only
 * budget-shaped field here: it is always a whole millisecond count of at least
 * one, so it satisfies `assertReadOnlyBudget` and `policy.ts`'s `isValidBudget`
 * wherever it is handed on. `remainingMs` is informational and MAY be
 * fractional — it is for a meter or a log line, never for a budget field.
 */
export type AgentCallAdmission =
  | { readonly admitted: true; readonly statementTimeoutMs: number; readonly remainingMs: number }
  | { readonly admitted: false; readonly reasonCode: AgentDeadlineDenyCode; readonly remainingMs: number };

/**
 * Raised when a deadline is built or asked with values it cannot compare
 * against. This is a server-side programming error — the numbers come from a
 * validated policy budget, never from a model — so it fails loud rather than
 * degrading into a permissive comparison.
 */
export class AgentDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDeadlineError";
    Object.setPrototypeOf(this, AgentDeadlineError.prototype);
  }
}

/** Mirrors `isValidBudget` in `policy.ts`: whole positive milliseconds only. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

// Messages are built on one line each: bun's line coverage under-counts the
// continuation lines of multi-line string concatenation.
const totalRunTimeMessage = (raw: number): string =>
  `agent run deadline: total run time must be a positive whole number of milliseconds, got ${String(raw)}`;

const brokenClockMessage = (raw: number): string =>
  `agent run deadline: the injected clock returned ${String(raw)}, which is not a finite reading`;

const malformedFieldMessage = (field: string, raw: number): string =>
  `agent run deadline: ${field} must be a positive whole number of milliseconds, got ${String(raw)}`;

const unadmittableRequestMessage = (minimumMs: number, ceilingMs: number): string =>
  `agent run deadline: a call needing ${minimumMs}ms under a ${ceilingMs}ms statement ceiling could never be admitted`;

/**
 * One run's wall-clock budget. Construct it when the run starts; ask `admit`
 * before every call the run makes.
 */
export class AgentRunDeadline {
  private readonly totalMs: number;
  private readonly clock: () => number;
  /** Previous reading; deltas are measured against it, never against the start. */
  private lastReadingMs: number;
  /** Sum of clamped deltas — only ever grows, so the budget only ever shrinks. */
  private elapsedMs = 0;
  /** Set once the clock stops answering; never cleared. */
  private clockFailed = false;

  constructor(totalMs: number, clock: () => number = monotonicClock) {
    if (!isPositiveInteger(totalMs)) throw new AgentDeadlineError(totalRunTimeMessage(totalMs));
    // Loud here on purpose: nothing is running yet, so refusing to start the run
    // costs an operator an error instead of costing a live run its decisions. A
    // clock that THROWS here propagates for the same reason.
    const startedAtMs = clock();
    if (!Number.isFinite(startedAtMs)) throw new AgentDeadlineError(brokenClockMessage(startedAtMs));
    this.totalMs = totalMs;
    this.clock = clock;
    this.lastReadingMs = startedAtMs;
  }

  /** Milliseconds left, floored at zero. Never negative, never larger than it was. */
  remainingMs(): number {
    if (this.clockFailed) return 0;

    let reading: number;
    try {
      reading = this.clock();
    } catch {
      this.clockFailed = true;
      return 0;
    }
    if (!Number.isFinite(reading)) {
      this.clockFailed = true;
      return 0;
    }

    // The delta is clamped, not the total: a backward step adds nothing and the
    // climb back adds its span again, so lost time is charged to the run rather
    // than credited to it. High-watermarking the READING would instead freeze
    // the budget until the clock passed its old peak — real time would pass
    // uncounted, which is the one direction this control may not fail in.
    this.elapsedMs += Math.max(0, reading - this.lastReadingMs);
    this.lastReadingMs = reading;
    return Math.max(0, this.totalMs - this.elapsedMs);
  }

  /**
   * Decides whether one call may start, and with how much time. The granted
   * timeout is floored to whole milliseconds so a fractional remainder rounds
   * toward the deadline rather than past it, and it is never above the policy
   * ceiling the caller passed in.
   */
  admit(request: AgentCallAdmissionRequest): AgentCallAdmission {
    const { statementTimeoutMs, minimumMs } = request;
    if (!isPositiveInteger(statementTimeoutMs)) {
      throw new AgentDeadlineError(malformedFieldMessage("statementTimeoutMs", statementTimeoutMs));
    }
    if (!isPositiveInteger(minimumMs)) throw new AgentDeadlineError(malformedFieldMessage("minimumMs", minimumMs));
    // A minimum above the ceiling is unsatisfiable at any remaining budget, so
    // it is a miswired call site rather than a run that ran out of time.
    if (minimumMs > statementTimeoutMs) {
      throw new AgentDeadlineError(unadmittableRequestMessage(minimumMs, statementTimeoutMs));
    }

    const remainingMs = this.remainingMs();
    if (remainingMs <= 0) return { admitted: false, reasonCode: "RUN_DEADLINE_EXCEEDED", remainingMs };

    const granted = Math.floor(Math.min(statementTimeoutMs, remainingMs));
    if (granted < minimumMs) return { admitted: false, reasonCode: "INSUFFICIENT_TIME_REMAINING", remainingMs };
    return { admitted: true, statementTimeoutMs: granted, remainingMs };
  }
}
