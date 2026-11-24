/**
 * The host reads the session state a transaction call, or a statement sent inside the transaction, answers, and refuses
 * by name a state it cannot read (docs/providers/CONTRACT.md, clause C-57).
 *
 * Each case hands `checkTransactionAnswer` or `checkTransactionStatement` one answer and asserts the exact refusal list:
 * a pointer into the answer, the key where the answer has one it cannot have, and never a value of the answer. Every
 * planted value is generated at run time.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallRefusal,
  CallRefusalError,
  callRefusalSentence,
  checkTransactionAnswer,
  checkTransactionStatement,
  TRANSACTION_ACTIONS,
  type TransactionRequest,
} from "@libredb/provider-sdk/calls";
import { SESSION_STATES } from "@libredb/provider-sdk/errors";

const BEGIN: TransactionRequest = { action: "begin" };
const REQUESTS: readonly TransactionRequest[] = TRANSACTION_ACTIONS.map((action) => ({ action }));
const OTHER_ACTIONS: readonly TransactionRequest[] = REQUESTS.filter((request) => request.action !== "begin");

function unreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "transaction-answer-unreadable", pointer }
    : { rule: "transaction-answer-unreadable", pointer, name };
}

/** A record whose `key` is an accessor counting its calls in `reads`. */
function withAccessor(key: string, reads: { count: number }, base: object = {}): object {
  return Object.defineProperty({ ...base }, key, {
    enumerable: true,
    get() {
      reads.count += 1;
      return "in-transaction";
    },
  });
}

describe("checkTransactionAnswer", () => {
  test("a transaction answer is a session state, and stateReported only for begin", () => {
    for (const request of REQUESTS) {
      for (const sessionState of SESSION_STATES) {
        expect(checkTransactionAnswer(request, { sessionState })).toEqual([]);
      }
    }
    for (const stateReported of [true, false]) {
      expect(checkTransactionAnswer(BEGIN, { sessionState: "in-transaction", stateReported })).toEqual([]);
      expect(
        checkTransactionAnswer(
          { action: "begin", requireReportedState: true },
          { sessionState: "unknown", stateReported },
        ),
      ).toEqual([]);
    }
    expect(checkTransactionAnswer(BEGIN, Object.assign(Object.create(null), { sessionState: "unknown" }))).toEqual([]);
  });

  test("a missing or unknown session state is refused by name, and no getter is called", () => {
    const reads = { count: 0 };

    for (const request of REQUESTS) {
      expect(checkTransactionAnswer(request, {})).toEqual([unreadable("/sessionState")]);
      for (const value of ["aborted", "IN-TRANSACTION", null, true, 0, ["in-transaction"]]) {
        expect(checkTransactionAnswer(request, { sessionState: value })).toEqual([unreadable("/sessionState")]);
      }
      expect(checkTransactionAnswer(request, withAccessor("sessionState", reads))).toEqual([
        unreadable("/sessionState"),
      ]);
    }
    expect(checkTransactionAnswer(BEGIN, withAccessor("stateReported", reads, { sessionState: "unknown" }))).toEqual([
      unreadable("/stateReported"),
    ]);
    expect(reads.count).toBe(0);
  });

  test("stateReported on another action, a key a transaction answer cannot have, or no record at all is refused by name", () => {
    class Answer {
      sessionState = "in-transaction";
    }

    for (const request of OTHER_ACTIONS) {
      for (const stateReported of [true, false]) {
        expect(checkTransactionAnswer(request, { sessionState: "not-in-transaction", stateReported })).toEqual([
          unreadable("/stateReported"),
        ]);
      }
    }
    for (const stateReported of ["true", 1, null]) {
      expect(checkTransactionAnswer(BEGIN, { sessionState: "in-transaction", stateReported })).toEqual([
        unreadable("/stateReported"),
      ]);
    }
    expect(checkTransactionAnswer(BEGIN, { sessionState: "unknown", openTransaction: "none", "a/b": 1 })).toEqual([
      unreadable("/openTransaction", "openTransaction"),
      unreadable("/a~1b", "a/b"),
    ]);
    expect(
      checkTransactionAnswer(BEGIN, Object.defineProperty({ sessionState: "unknown" }, "hidden", { value: 1 })),
    ).toEqual([unreadable("/hidden", "hidden")]);
    expect(checkTransactionAnswer(BEGIN, { extra: 1 })).toEqual([
      unreadable("/extra", "extra"),
      unreadable("/sessionState"),
    ]);
    for (const value of [undefined, null, "in-transaction", [], new Answer()]) {
      expect(checkTransactionAnswer(BEGIN, value)).toEqual([unreadable("")]);
    }
    expect(callRefusalSentence(unreadable("/sessionState"))).toBe(
      'The transaction answer value at "/sessionState" is missing, an accessor, or not what the provider contract defines there for the call\'s action, so no session state was read from it.',
    );
    expect(callRefusalSentence(unreadable("/extra", "extra"))).toBe(
      'The transaction answer has the key "extra" at "/extra", which a transaction answer cannot have, so no session state was read from it.',
    );
  });

  test("no transaction answer refusal carries a value of the answer", () => {
    const planted = [randomUUID(), randomUUID(), randomUUID()];
    const refusals = [
      ...checkTransactionAnswer(OTHER_ACTIONS[0] as TransactionRequest, {
        sessionState: planted[0],
        stateReported: planted[1],
        other: planted[2],
      }),
      ...checkTransactionStatement({ sessionState: planted[0] }),
    ];
    const text = JSON.stringify(refusals) + new CallRefusalError(refusals).message;

    expect(refusals.length).toBe(4);
    for (const value of planted) expect(text).not.toContain(value);
  });
});

describe("checkTransactionStatement", () => {
  test("a statement answered inside a transaction carries its session state, and one without is refused by name", () => {
    const reads = { count: 0 };

    for (const sessionState of SESSION_STATES) {
      expect(checkTransactionStatement({ results: [], warnings: [], sessionState })).toEqual([]);
      expect(
        checkTransactionStatement(
          Object.defineProperty({ sessionState, warnings: [] }, "results", {
            enumerable: true,
            get() {
              reads.count += 1;
              return [];
            },
          }),
        ),
      ).toEqual([]);
    }
    for (const answer of [
      { results: [], warnings: [], executionTimeMs: 0, pageApplied: false },
      { sessionState: "open" },
      { sessionState: null },
      withAccessor("sessionState", reads),
      null,
      "in-transaction",
    ]) {
      expect(checkTransactionStatement(answer)).toEqual([unreadable("/sessionState")]);
    }
    expect(reads.count).toBe(0);
  });
});
