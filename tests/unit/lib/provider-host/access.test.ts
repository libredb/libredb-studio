/**
 * The accessor (src/lib/provider-host/access.ts; docs/providers/CONTRACT.md, clause C-51, and clause E-5): the records
 * the host core answers become this bundle's error classes, with Studio's sentence and the outcome the record proves,
 * `not-sent` for a call refused before it was made and `unknown` once the provider was called.
 *
 * Every reason and marker is generated at run time; no timer runs.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CALL_REFUSAL_RULES, type CallRefusal, callRefusalSentence } from "@libredb/provider-sdk/calls";
import { errorKind, errorOutcome } from "@/lib/db/error-record";
import {
  DatabaseError,
  QueryCancelledError,
  StudioByteBudgetRefusal,
  StudioTimeoutRefusal,
  TimeoutError,
} from "@/lib/db/errors";
import { HOST_DEFECT_PREFIX, refusalError, stopError } from "@/lib/provider-host/access";
import type { RefusedRecord } from "@/lib/provider-host/core/console";

const deadlineSentence = `The statement did not answer within ${randomUUID()}.`;

/** A caller whose signal aborted with `reason`, or one still waiting. */
function callerOf(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  if (reason !== undefined) controller.abort(reason);
  return controller.signal;
}

function refused(refusals: readonly CallRefusal[], called: boolean, cause?: unknown): RefusedRecord {
  return { kind: "refused", called, refusals, ...(cause === undefined ? {} : { cause }) };
}

const SIGNAL: CallRefusal = { rule: "call-signal-aborted", pointer: "/signal" };
const DEADLINE: CallRefusal = { rule: "call-deadline-passed", pointer: "/deadline" };

describe("the accessor", () => {
  test("a call the caller left is answered as QueryCancelledError, not-sent before the call and unknown after it", () => {
    const reason = new Error(randomUUID());
    const caller = callerOf(reason);
    const view = { caller, deadlineSentence };

    const before = refusalError(refused([DEADLINE, SIGNAL], false, reason), view);
    const during = refusalError(refused([SIGNAL], true, reason), view);
    const stopped = stopError(reason, view);

    for (const error of [before, during, stopped]) {
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(error.name).toBe("QueryCancelledError");
      expect(error.message).toBe("The query was cancelled.");
      expect(errorKind(error)).toBe("cancelled");
    }
    expect(errorOutcome(before)).toBe("not-sent");
    expect(errorOutcome(during)).toBe("unknown");
    expect(errorOutcome(stopped)).toBe("unknown");
  });

  test("a call past its deadline is answered as StudioTimeoutRefusal, not-sent before the call and unknown after it", () => {
    const timeout = new DOMException(randomUUID(), "TimeoutError");
    const still = { caller: callerOf(), deadlineSentence };
    const left = { caller: callerOf(new Error(randomUUID())), deadlineSentence };

    const passed = refusalError(refused([DEADLINE], false), still);
    const timedOut = refusalError(refused([DEADLINE, SIGNAL], false, timeout), left);
    const duringPull = refusalError(refused([SIGNAL], true, timeout), still);
    const stopped = stopError(timeout, left);
    const notYetLeft = stopError(timeout, still);

    for (const error of [passed, timedOut, duringPull, stopped, notYetLeft]) {
      expect(error).toBeInstanceOf(StudioTimeoutRefusal);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.name).toBe("TimeoutError");
      expect(error.message).toBe(deadlineSentence);
      expect(errorKind(error)).toBe("studio-timeout-refusal");
    }
    expect([passed, timedOut].map(errorOutcome)).toEqual(["not-sent", "not-sent"]);
    expect([duringPull, stopped, notYetLeft].map(errorOutcome)).toEqual(["unknown", "unknown", "unknown"]);
  });

  test("a row no page can hold is answered as StudioByteBudgetRefusal, outcome unknown", () => {
    const error = refusalError(
      refused([{ rule: "row-over-page", pointer: "/rows/0", limit: 33554432, size: 40000000 }], true),
      { caller: callerOf(), deadlineSentence },
    );

    expect(error).toBeInstanceOf(StudioByteBudgetRefusal);
    expect(error.name).toBe("QueryError");
    expect(error.message).toBe(
      "A row of the result is 40000000 bytes, over the 33554432 bytes one page of a result may hold, so Studio answers no page of it.",
    );
    expect(errorKind(error)).toBe("studio-byte-budget-refusal");
    expect(errorOutcome(error)).toBe("unknown");
  });

  test("any other refusal is a host defect named by its rule", () => {
    const view = { caller: callerOf(), deadlineSentence };
    const handled = new Set(["call-signal-aborted", "call-deadline-passed", "row-over-page"]);
    const others = CALL_REFUSAL_RULES.filter((rule) => !handled.has(rule));

    for (const rule of others) {
      const refusal: CallRefusal = { rule, pointer: "/x", name: "params", limit: 1, size: 2 };
      const error = refusalError(refused([refusal, refusal], false), view);
      expect(error).not.toBeInstanceOf(DatabaseError);
      expect(error.name).toBe("Error");
      expect(error.message).toBe(
        `${HOST_DEFECT_PREFIX} ${callRefusalSentence(refusal)} ${callRefusalSentence(refusal)}`,
      );
      expect(Object.hasOwn(error, "outcome")).toBe(false);
      expect(errorKind(error)).toBe("internal");
    }
    expect(others).toHaveLength(CALL_REFUSAL_RULES.length - 3);
  });

  test("every class the accessor builds is the calling bundle's own", () => {
    const reason = new Error(randomUUID());
    const view = { caller: callerOf(reason), deadlineSentence };
    const built = [
      refusalError(refused([SIGNAL], false, reason), view),
      refusalError(refused([DEADLINE], false), view),
      refusalError(refused([{ rule: "row-over-page", pointer: "/rows/0", limit: 1, size: 2 }], true), view),
      stopError(reason, view),
      stopError(new Error(randomUUID()), view),
    ];

    expect(built.map((error) => error.constructor)).toEqual([
      QueryCancelledError,
      StudioTimeoutRefusal,
      StudioByteBudgetRefusal,
      QueryCancelledError,
      StudioTimeoutRefusal,
    ]);
    for (const error of built) expect(error).toBeInstanceOf(DatabaseError);
  });
});
