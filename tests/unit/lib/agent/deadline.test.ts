import { describe, expect, spyOn, test } from "bun:test";
import type { AgentCallAdmission, AgentCallAdmissionRequest, AgentDeadlineDenyCode } from "@/lib/agent/deadline";
import { AgentDeadlineError, AgentRunDeadline } from "@/lib/agent/deadline";

/** A typical tool call: the policy budget's ceiling, and what the tool needs to be worth starting. */
const READ_CALL: AgentCallAdmissionRequest = { statementTimeoutMs: 5_000, minimumMs: 250 };

function refusalCodeOf(admission: AgentCallAdmission): AgentDeadlineDenyCode {
  if (admission.admitted) throw new Error("expected the call to be refused");
  return admission.reasonCode;
}

/**
 * A settable clock. Every test drives time explicitly — the module reads the
 * clock it is given and nothing else, which is the property that makes a
 * deadline testable at all (`budgets.ts` and `execution.ts` inject for the same
 * reason).
 */
function fakeClock(startAt = 1_000): { readonly read: () => number; set: (value: number) => void } {
  let current = startAt;
  return {
    read: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

function captureRefusal(fn: () => unknown): AgentDeadlineError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentDeadlineError);
    return error as AgentDeadlineError;
  }
  throw new Error("expected the deadline to refuse");
}

// ─── construction ───────────────────────────────────────────────────────────

describe("AgentRunDeadline — construction", () => {
  test("accepts a positive integer total and starts with the whole budget left", () => {
    const clock = fakeClock();
    expect(new AgentRunDeadline(30_000, clock.read).remainingMs()).toBe(30_000);
  });

  test.each([0, -1, -30_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "30000" as unknown as number])(
    "refuses the malformed total %p — a deadline that cannot be compared is not a deadline",
    (total) => {
      const error = captureRefusal(() => new AgentRunDeadline(total, fakeClock().read));
      expect(error.message).toContain("total run time");
    },
  );

  test("refuses a clock whose first reading is not finite", () => {
    const error = captureRefusal(() => new AgentRunDeadline(30_000, () => Number.NaN));
    expect(error.message).toContain("clock");
  });

  // Weak by construction and kept as a tripwire, not as the guarantee: the spy
  // is installed after the module's static import, so a module-scope
  // `const now = Date.now` capture would go unobserved. The real guarantee is
  // that the clock is injected and defaults to `performance.now`.
  test("defaults to a monotonic clock and never reads Date.now", () => {
    const dateNow = spyOn(Date, "now");
    try {
      const deadline = new AgentRunDeadline(30_000);
      deadline.remainingMs();
      deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 100 });
      expect(dateNow).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });

  test("the default clock actually advances, so a real run does consume its budget", async () => {
    const deadline = new AgentRunDeadline(30_000);
    const before = deadline.remainingMs();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deadline.remainingMs()).toBeLessThan(before);
  });
});

// ─── the remaining budget ───────────────────────────────────────────────────

describe("AgentRunDeadline — remainingMs", () => {
  test("shrinks by exactly the elapsed time", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 7_500);
    expect(deadline.remainingMs()).toBe(22_500);
  });

  test("floors at zero once the deadline passes, and never reports a negative budget", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 30_000);
    expect(deadline.remainingMs()).toBe(0);
    clock.set(1_000 + 900_000);
    expect(deadline.remainingMs()).toBe(0);
  });

  test("a clock that jumps backward hands no time back, and the climb back is charged to the run", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 20_000);
    expect(deadline.remainingMs()).toBe(10_000);
    // A wall clock stepped back 15s by NTP. The step itself costs nothing...
    clock.set(1_000 + 5_000);
    expect(deadline.remainingMs()).toBe(10_000);
    // ...and climbing back over the same span is charged again, so the 20s of
    // REAL time that elapsed while the clock re-climbed cannot pass uncounted.
    // High-watermarking the reading would have reported 5_000 left here, with
    // the run already 10s past its deadline.
    clock.set(1_000 + 25_000);
    expect(deadline.remainingMs()).toBe(0);
  });

  test("the budget never grows, whatever the clock does", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    let previous = deadline.remainingMs();
    for (const reading of [11_000, 3_000, 9_000, 2_000, 14_000, 1_000]) {
      clock.set(reading);
      const current = deadline.remainingMs();
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  test("a non-finite reading mid-run exhausts the run, and stays exhausted after the clock recovers", () => {
    let reading = 1_000;
    const deadline = new AgentRunDeadline(30_000, () => reading);
    expect(deadline.remainingMs()).toBe(30_000);
    reading = Number.NaN;
    expect(deadline.remainingMs()).toBe(0);
    reading = 1_500;
    expect(deadline.remainingMs()).toBe(0);
  });

  test("a clock that throws mid-run exhausts the run rather than propagating into the run loop", () => {
    let broken = false;
    const deadline = new AgentRunDeadline(30_000, () => {
      if (broken) throw new Error("clock source went away");
      return 1_000;
    });
    expect(deadline.remainingMs()).toBe(30_000);
    broken = true;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 1 })).toEqual({
      admitted: false,
      reasonCode: "RUN_DEADLINE_EXCEEDED",
      remainingMs: 0,
    });
  });
});

// ─── admission and the clamp ────────────────────────────────────────────────

describe("AgentRunDeadline — admit", () => {
  test("admits a call with time to spare and leaves the policy timeout untouched", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    const admission = deadline.admit(READ_CALL);
    expect(admission).toEqual({ admitted: true, statementTimeoutMs: 5_000, remainingMs: 30_000 });
  });

  test("clamps the granted timeout strictly below the policy budget's once less time is left", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 27_000);
    const admission = deadline.admit(READ_CALL);
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error("unreachable");
    expect(admission.statementTimeoutMs).toBe(3_000);
    expect(admission.statementTimeoutMs).toBeLessThan(5_000);
  });

  test("floors a fractional remainder rather than rounding up past the deadline", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 26_999.6);
    const admission = deadline.admit(READ_CALL);
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error("unreachable");
    expect(admission.statementTimeoutMs).toBe(3_000);
  });

  test("refuses a call whose minimum is larger than the time left", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 29_800);
    const admission = deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 1_000 });
    expect(admission).toEqual({ admitted: false, reasonCode: "INSUFFICIENT_TIME_REMAINING", remainingMs: 200 });
  });

  test("still admits a cheaper call after refusing an expensive one — the two refusals differ", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 29_800);
    const refused = deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 1_000 });
    // Not RUN_DEADLINE_EXCEEDED: the run is alive, this one call was too expensive.
    expect(refusalCodeOf(refused)).toBe("INSUFFICIENT_TIME_REMAINING");
    expect(deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 100 })).toEqual({
      admitted: true,
      statementTimeoutMs: 200,
      remainingMs: 200,
    });
  });

  test("refuses everything once the deadline has passed", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 30_000);
    expect(deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 1 })).toEqual({
      admitted: false,
      reasonCode: "RUN_DEADLINE_EXCEEDED",
      remainingMs: 0,
    });
  });

  test("never grants more than the policy ceiling, however much of the run is left", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(3_600_000, clock.read);
    const admission = deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 1 });
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error("unreachable");
    expect(admission.statementTimeoutMs).toBe(5_000);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5000" as unknown as number])(
    "refuses the malformed statement timeout %p rather than comparing against it",
    (statementTimeoutMs) => {
      const deadline = new AgentRunDeadline(30_000, fakeClock().read);
      const error = captureRefusal(() => deadline.admit({ statementTimeoutMs, minimumMs: 1 }));
      expect(error.message).toContain("statementTimeoutMs");
    },
  );

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100" as unknown as number])(
    "refuses the malformed call minimum %p",
    (minimumMs) => {
      const deadline = new AgentRunDeadline(30_000, fakeClock().read);
      const error = captureRefusal(() => deadline.admit({ statementTimeoutMs: 5_000, minimumMs }));
      expect(error.message).toContain("minimumMs");
    },
  );

  test("refuses a request whose minimum exceeds its own policy ceiling — it could never be admitted", () => {
    const deadline = new AgentRunDeadline(30_000, fakeClock().read);
    const error = captureRefusal(() => deadline.admit({ statementTimeoutMs: 1_000, minimumMs: 2_000 }));
    expect(error.message).toContain("never be admitted");
  });

  test("admits a call whose minimum equals the whole remaining budget, and refuses one millisecond later", () => {
    const clock = fakeClock();
    const deadline = new AgentRunDeadline(30_000, clock.read);
    clock.set(1_000 + 29_000);
    expect(deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 1_000 }).admitted).toBe(true);
    clock.set(1_000 + 29_001);
    expect(deadline.admit({ statementTimeoutMs: 5_000, minimumMs: 1_000 }).admitted).toBe(false);
  });
});
