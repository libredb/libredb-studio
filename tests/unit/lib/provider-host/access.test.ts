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
  FacetNotOfferedError,
  QueryCancelledError,
  QueryError,
  StudioByteBudgetRefusal,
  StudioObjectModelRefusal,
  StudioOffsetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
  TimeoutError,
} from "@/lib/db/errors";
import {
  type BudgetView,
  budgetRefusalError,
  budgetStopError,
  HOST_DEFECT_PREFIX,
  HostDefectError,
  refusalError,
  stopError,
} from "@/lib/provider-host/access";
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

  test("a refused offset of a session that refuses it is Studio's own offset refusal, not-sent", () => {
    const refusal: CallRefusal = { rule: "request-field-not-honoured", pointer: "/page/offset", name: "offset" };
    const error = refusalError(refused([refusal], false), { caller: callerOf(), deadlineSentence });

    // Studio wrote the sentence, so the error is the class only core constructs, never a provider's plain one.
    expect(error).toBeInstanceOf(StudioOffsetRefusal);
    expect(errorKind(error)).toBe("studio-offset-refusal");
    expect(error.message).toBe(
      "This connection's provider package does not take an offset, so Studio asks for no page after the first.",
    );
    expect(errorOutcome(error)).toBe("not-sent");
  });

  test("a refusal of a level or a kind the session's object model does not state is Studio's own refusal, outcome not-sent, in Studio's words with no value of the request", () => {
    const level: CallRefusal = { rule: "request-level-not-stated", pointer: "/container" };
    const kind: CallRefusal = { rule: "request-kind-not-stated", pointer: "/kind" };
    const levelSentence =
      "The request names a container path whose levels this connection's object model does not state, so Studio did not call the provider.";
    const kindSentence =
      "The request names an object kind this connection's object model does not state, so Studio did not call the provider.";
    const view = { caller: callerOf(), deadlineSentence };
    const budget: BudgetView = { caller: callerOf(), timeRefusal: () => new StudioTimeBudgetRefusal(randomUUID()) };

    const cases: [readonly CallRefusal[], string][] = [
      [[level], levelSentence],
      [[kind], kindSentence],
      [[level, kind], `${levelSentence} ${kindSentence}`],
    ];
    for (const [refusals, message] of cases) {
      for (const error of [
        refusalError(refused(refusals, false), view),
        budgetRefusalError(refused(refusals, false), budget),
      ]) {
        expect(error).toBeInstanceOf(StudioObjectModelRefusal);
        expect(error).toBeInstanceOf(QueryError);
        expect(error.name).toBe("QueryError");
        expect(error.message).toBe(message);
        expect(errorKind(error)).toBe("studio-object-model-refusal");
        expect(errorOutcome(error)).toBe("not-sent");
      }
    }
  });

  test("a source request refused by the object model is Studio's model refusal, not-sent, in Studio's words", () => {
    const source: CallRefusal = { rule: "request-source-not-stated", pointer: "/kind" };
    const path: CallRefusal = { rule: "request-path-not-admitted", pointer: "/path" };
    const kind: CallRefusal = { rule: "request-kind-not-stated", pointer: "/kind" };
    const sourceSentence =
      "The request names an object kind whose source this connection's object model does not state, so Studio did not call the provider.";
    const pathSentence =
      "The request names an object path deeper than this connection's object model admits for its kind, so Studio did not call the provider.";
    const kindSentence =
      "The request names an object kind this connection's object model does not state, so Studio did not call the provider.";
    const view = { caller: callerOf(), deadlineSentence };

    const cases: [readonly CallRefusal[], string][] = [
      [[source], sourceSentence],
      [[path], pathSentence],
      [[path, source], `${pathSentence} ${sourceSentence}`],
      [[path, kind], `${pathSentence} ${kindSentence}`],
    ];
    for (const [refusals, message] of cases) {
      const error = refusalError(refused(refusals, false), view);
      expect(error).toBeInstanceOf(StudioObjectModelRefusal);
      expect(error.message).toBe(message);
      expect(errorKind(error)).toBe("studio-object-model-refusal");
      expect(errorOutcome(error)).toBe("not-sent");
    }

    // Beside a rule no row reads, the record is the host defect of every refusal it holds.
    const other: CallRefusal = { rule: "request-field-empty", pointer: "/path", name: "path" };
    const mixed = refusalError(refused([other, source], false), view);
    expect(mixed).toBeInstanceOf(HostDefectError);
    expect((mixed as HostDefectError).refusals).toEqual([other, source]);
  });

  test("a refused record holding an object model refusal beside a refusal no row reads is a host defect naming every refusal, none dropped", () => {
    const level: CallRefusal = { rule: "request-level-not-stated", pointer: "/container" };
    const kind: CallRefusal = { rule: "request-kind-not-stated", pointer: "/kind" };
    const view = { caller: callerOf(), deadlineSentence };
    const budget: BudgetView = { caller: callerOf(), timeRefusal: () => new StudioTimeBudgetRefusal(randomUUID()) };
    const handled = new Set([
      "call-signal-aborted",
      "call-deadline-passed",
      "row-over-page",
      "facet-not-offered",
      "request-transaction-not-offered",
      "request-level-not-stated",
      "request-kind-not-stated",
      "request-source-not-stated",
      "request-path-not-admitted",
    ]);
    const others = CALL_REFUSAL_RULES.filter((rule) => !handled.has(rule));

    for (const rule of others) {
      // A field the rows of a refusing session do not read: only offset and params are answered by name.
      const other: CallRefusal = { rule, pointer: "/x", name: "readOnly", limit: 1, size: 2 };
      for (const refusals of [
        [level, other],
        [other, kind],
        [level, other, kind],
      ]) {
        for (const error of [
          refusalError(refused(refusals, false), view),
          budgetRefusalError(refused(refusals, false), budget),
        ]) {
          expect(error).toBeInstanceOf(HostDefectError);
          expect((error as HostDefectError).refusals).toEqual(refusals);
          expect(error.message).toBe(
            `${HOST_DEFECT_PREFIX} ${refusals.map((refusal) => callRefusalSentence(refusal)).join(" ")}`,
          );
          expect(errorKind(error)).toBe("internal");
        }
      }
    }
    expect(others.length).toBeGreaterThan(0);
  });

  test("refused params of a session that refuses them are FacetNotOfferedError, not-sent", () => {
    const refusal: CallRefusal = { rule: "request-field-not-honoured", pointer: "/params", name: "params" };
    const error = refusalError(refused([refusal], false), { caller: callerOf(), deadlineSentence });

    expect(error).toBeInstanceOf(FacetNotOfferedError);
    expect([(error as FacetNotOfferedError).code, error.message, errorOutcome(error)]).toEqual([
      "FACET_NOT_OFFERED",
      "This connection's provider package takes no bound parameters, so Studio sent nothing.",
      "not-sent",
    ]);
    expect([(error as FacetNotOfferedError).facet, (error as FacetNotOfferedError).operation]).toEqual([
      "console",
      "params",
    ]);
  });

  test("a facet the session does not offer is FacetNotOfferedError naming the call, not-sent", () => {
    for (const [name, facet, operation] of [
      ["objects.tree", "objects", "tree"],
      ["console.cancel", "console", "cancel"],
      ["monitoring.poolStats", "monitoring", "poolStats"],
      ["maintenance.run", "maintenance", "run"],
    ] as const) {
      const refusal: CallRefusal = { rule: "facet-not-offered", pointer: `/${name.replace(".", "/")}`, name };
      const error = refusalError(refused([refusal], false), { caller: callerOf(), deadlineSentence });
      expect(error).toBeInstanceOf(FacetNotOfferedError);
      expect([error.message, errorOutcome(error)]).toEqual([
        `This connection's provider package does not offer ${name}, so Studio did not call it.`,
        "not-sent",
      ]);
      expect([(error as FacetNotOfferedError).facet, (error as FacetNotOfferedError).operation]).toEqual([
        facet,
        operation,
      ]);
    }
  });

  test("a statement sent inside a transaction to a session that does not offer console.transaction is FacetNotOfferedError naming console.transaction, not-sent", () => {
    const refusal: CallRefusal = { rule: "request-transaction-not-offered", pointer: "/transaction" };
    const error = refusalError(refused([refusal], false), { caller: callerOf(), deadlineSentence });

    expect(error).toBeInstanceOf(FacetNotOfferedError);
    expect([(error as FacetNotOfferedError).code, error.message, errorOutcome(error)]).toEqual([
      "FACET_NOT_OFFERED",
      "This connection's provider package does not offer console.transaction, so Studio did not call it.",
      "not-sent",
    ]);
    expect([(error as FacetNotOfferedError).facet, (error as FacetNotOfferedError).operation]).toEqual([
      "console",
      "transaction",
    ]);
  });

  test("any other refusal is a host defect named by its rule", () => {
    const view = { caller: callerOf(), deadlineSentence };
    const handled = new Set([
      "call-signal-aborted",
      "call-deadline-passed",
      "row-over-page",
      "facet-not-offered",
      "request-transaction-not-offered",
      "request-level-not-stated",
      "request-kind-not-stated",
      "request-source-not-stated",
      "request-path-not-admitted",
    ]);
    const others = CALL_REFUSAL_RULES.filter((rule) => !handled.has(rule));

    for (const rule of others) {
      // A field the rows of a refusing session do not read: only offset and params are answered by name.
      const refusal: CallRefusal = { rule, pointer: "/x", name: "readOnly", limit: 1, size: 2 };
      const error = refusalError(refused([refusal, refusal], false), view);
      expect(error).not.toBeInstanceOf(DatabaseError);
      expect(error.name).toBe("Error");
      expect(error.message).toBe(
        `${HOST_DEFECT_PREFIX} ${callRefusalSentence(refusal)} ${callRefusalSentence(refusal)}`,
      );
      expect(Object.hasOwn(error, "outcome")).toBe(false);
      expect(errorKind(error)).toBe("internal");
    }
    expect(others).toHaveLength(CALL_REFUSAL_RULES.length - 9);
  });

  test("a budget view's stop or refused start is QueryCancelledError when the caller left, and otherwise the caller's own time refusal", () => {
    const reason = new Error(randomUUID());
    const timeout = new DOMException(randomUUID(), "TimeoutError");
    const built: Error[] = [];
    const timeRefusal = () => {
      const error = new StudioTimeBudgetRefusal(`Read-only execution exceeded the time budget: ${randomUUID()}`);
      built.push(error);
      return error;
    };
    const left: BudgetView = { caller: callerOf(reason), timeRefusal };
    const still: BudgetView = { caller: callerOf(), timeRefusal };

    const cancelledStop = budgetStopError(reason, left);
    const timedStop = budgetStopError(timeout, still);
    const otherReason = budgetStopError(timeout, left);
    const cancelledStart = budgetRefusalError(refused([SIGNAL], false, reason), left);
    const passedStart = budgetRefusalError(refused([DEADLINE], false), still);
    const timedStart = budgetRefusalError(refused([DEADLINE, SIGNAL], false, timeout), left);

    for (const error of [cancelledStop, cancelledStart]) {
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(error.message).toBe("The query was cancelled.");
    }
    expect(errorOutcome(cancelledStop)).toBe("unknown");
    expect(errorOutcome(cancelledStart)).toBe("not-sent");
    expect([timedStop, otherReason, passedStart, timedStart]).toEqual(built);
    expect(timedStop).toBe(built[0] as Error);
    expect(otherReason).toBe(built[1] as Error);
    for (const error of [timedStop, otherReason, passedStart, timedStart]) {
      expect(error).toBeInstanceOf(StudioTimeBudgetRefusal);
    }
    expect([timedStop, otherReason].map(errorOutcome)).toEqual(["unknown", "unknown"]);
    expect([passedStart, timedStart].map(errorOutcome)).toEqual(["not-sent", "not-sent"]);

    const overPage = budgetRefusalError(
      refused([{ rule: "row-over-page", pointer: "/rows/0", limit: 33554432, size: 40000000 }], true),
      still,
    );
    expect(overPage).toBeInstanceOf(StudioByteBudgetRefusal);
    expect(overPage.message).toBe(
      "A row of the result is 40000000 bytes, over the 33554432 bytes one page of a result may hold, so Studio answers no page of it.",
    );
    expect(errorOutcome(overPage)).toBe("unknown");
    const missing: CallRefusal = { rule: "request-read-only-missing", pointer: "/readOnly" };
    const defect = budgetRefusalError(refused([missing], false), still);
    expect(defect.name).toBe("Error");
    expect(defect.message).toBe(`${HOST_DEFECT_PREFIX} ${callRefusalSentence(missing)}`);
    expect(built).toHaveLength(4);
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
