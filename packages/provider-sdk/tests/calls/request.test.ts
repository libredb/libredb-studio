/**
 * The host refuses, before the call, a request field the session does not honour (docs/providers/CONTRACT.md, clause
 * C-9).
 *
 * Each case holds a request to the session's calls, the manifest's `calls` or the narrowed ones a refinement leaves,
 * and asserts the exact refusal list: a pointer into the request, the field's name, and never a value of the request.
 * A statement sent inside a transaction goes only to a session that offers `console.transaction`, and never with a
 * scope. A console facet call goes only to a session that offers the facet, and an object facet call only to one that
 * offers the object facet (clause C-17).
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CALL_REFUSAL_RULES,
  type CallRefusal,
  CallRefusalError,
  callRefusalSentence,
  checkConsoleFacet,
  checkExecuteRequest,
  checkObjectsFacet,
  type ExecuteRequest,
  sessionCalls,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";

/** The calls of a package that honours nothing and offers no facet. */
const NOTHING: Calls = {
  console: { execute: { honours: [] }, cancel: "not-offered", endScope: "not-offered", transaction: "not-offered" },
  objects: { tree: "not-offered" },
};

/** The calls of a package that honours every field and offers every facet. */
const EVERYTHING: Calls = {
  console: {
    execute: { honours: ["params", "offset"] },
    cancel: "offered",
    endScope: "offered",
    transaction: "offered",
  },
  objects: { tree: "offered" },
};

const statement = `select ${randomUUID()}`;
const firstPage: ExecuteRequest = { statement, page: { limit: 500, offset: 0 } };
const withParams: ExecuteRequest = { ...firstPage, params: [1] };
const withEmptyParams: ExecuteRequest = { ...firstPage, params: [] };
const laterPage: ExecuteRequest = { statement, page: { limit: 500, offset: 500 } };
const scoped: ExecuteRequest = { ...firstPage, scope: "s" };
const unlimited: ExecuteRequest = { statement, page: { unlimited: true } };
const allThree: ExecuteRequest = { statement, params: [1], page: { limit: 500, offset: 500 }, scope: "s" };

const PARAMS: CallRefusal = { rule: "request-field-not-honoured", pointer: "/params", name: "params" };
const OFFSET: CallRefusal = { rule: "request-field-not-honoured", pointer: "/page/offset", name: "offset" };
const SCOPE: CallRefusal = { rule: "request-scope-not-offered", pointer: "/scope" };
const TRANSACTION: CallRefusal = { rule: "request-transaction-not-offered", pointer: "/transaction" };
const SCOPE_IN_TRANSACTION: CallRefusal = { rule: "request-scope-in-transaction", pointer: "/scope" };
const inTransaction: ExecuteRequest = { ...firstPage, transaction: true };

describe("checkExecuteRequest", () => {
  test("a request field the session does not honour is refused before the call", () => {
    expect(checkExecuteRequest(NOTHING, firstPage)).toEqual([]);
    expect(checkExecuteRequest(NOTHING, withParams)).toEqual([PARAMS]);
    expect(checkExecuteRequest(NOTHING, withEmptyParams)).toEqual([PARAMS]);
    expect(checkExecuteRequest(NOTHING, laterPage)).toEqual([OFFSET]);
    expect(checkExecuteRequest(NOTHING, scoped)).toEqual([SCOPE]);
    expect(checkExecuteRequest(NOTHING, allThree)).toEqual([PARAMS, OFFSET, SCOPE]);
    expect(checkExecuteRequest(NOTHING, unlimited)).toEqual([]);
  });

  test("a session that honours every field and offers endScope takes each", () => {
    for (const request of [firstPage, withParams, withEmptyParams, laterPage, scoped, unlimited, allThree]) {
      expect(checkExecuteRequest(EVERYTHING, request)).toEqual([]);
    }
  });

  test("a request on a refined session is held to the narrowed calls", () => {
    const narrowed = sessionCalls(EVERYTHING, {
      calls: { console: { execute: { honours: ["params"] }, endScope: "not-offered" } },
    });

    expect(checkExecuteRequest(narrowed, withParams)).toEqual([]);
    expect(checkExecuteRequest(narrowed, laterPage)).toEqual([OFFSET]);
    expect(checkExecuteRequest(narrowed, scoped)).toEqual([SCOPE]);
    expect(checkExecuteRequest(sessionCalls(EVERYTHING, undefined), allThree)).toEqual([]);
  });

  test("a statement sent inside a transaction to a session without console.transaction is refused before the call", () => {
    const withdrawn = sessionCalls(EVERYTHING, { calls: { console: { transaction: "not-offered" } } });

    expect(checkExecuteRequest(NOTHING, inTransaction)).toEqual([TRANSACTION]);
    expect(checkExecuteRequest(withdrawn, inTransaction)).toEqual([TRANSACTION]);
    expect(checkExecuteRequest(NOTHING, { ...withParams, transaction: true })).toEqual([PARAMS, TRANSACTION]);
    expect(callRefusalSentence(TRANSACTION)).toBe(
      'The request is sent inside a transaction at "/transaction", and the session does not offer console.transaction, so the call was not made.',
    );
  });

  test("a statement sent inside a transaction never carries a scope", () => {
    const scopedInTransaction: ExecuteRequest = { ...inTransaction, scope: "s" };

    expect(checkExecuteRequest(EVERYTHING, scopedInTransaction)).toEqual([SCOPE_IN_TRANSACTION]);
    expect(checkExecuteRequest(NOTHING, scopedInTransaction)).toEqual([SCOPE, SCOPE_IN_TRANSACTION, TRANSACTION]);
    expect(callRefusalSentence(SCOPE_IN_TRANSACTION)).toBe(
      'The request carries a scope at "/scope" on a statement sent inside a transaction, which runs on the transaction\'s own session, so the call was not made.',
    );
  });

  test("a session that offers console.transaction takes a statement inside its transaction with its params and offset", () => {
    const narrowed = sessionCalls(EVERYTHING, {
      calls: { console: { endScope: "not-offered", cancel: "not-offered" } },
    });

    for (const calls of [EVERYTHING, narrowed]) {
      expect(checkExecuteRequest(calls, inTransaction)).toEqual([]);
      expect(checkExecuteRequest(calls, { ...withParams, transaction: true })).toEqual([]);
      expect(checkExecuteRequest(calls, { ...laterPage, params: [1], transaction: true })).toEqual([]);
    }
  });
});

describe("checkConsoleFacet", () => {
  test("a console facet the session does not offer is refused before the call", () => {
    const declaredOnly = sessionCalls(NOTHING, undefined);
    const narrowed = sessionCalls(EVERYTHING, { calls: { console: { endScope: "not-offered" } } });
    const cancel: CallRefusal = { rule: "facet-not-offered", pointer: "/console/cancel", name: "console.cancel" };
    const endScope: CallRefusal = { rule: "facet-not-offered", pointer: "/console/endScope", name: "console.endScope" };

    expect(checkConsoleFacet(declaredOnly, "cancel")).toEqual([cancel]);
    expect(checkConsoleFacet(declaredOnly, "endScope")).toEqual([endScope]);
    expect(checkConsoleFacet(narrowed, "endScope")).toEqual([endScope]);
    expect(callRefusalSentence(cancel)).toBe(
      'The session does not offer the facet "console.cancel" at "/console/cancel", so the call was not made.',
    );
  });

  test("the transaction facet is refused by name to a session that does not offer it", () => {
    const withdrawn = sessionCalls(EVERYTHING, { calls: { console: { transaction: "not-offered" } } });
    const transaction: CallRefusal = {
      rule: "facet-not-offered",
      pointer: "/console/transaction",
      name: "console.transaction",
    };

    expect(checkConsoleFacet(NOTHING, "transaction")).toEqual([transaction]);
    expect(checkConsoleFacet(withdrawn, "transaction")).toEqual([transaction]);
    expect(checkConsoleFacet(EVERYTHING, "transaction")).toEqual([]);
    expect(callRefusalSentence(transaction)).toBe(
      'The session does not offer the facet "console.transaction" at "/console/transaction", so the call was not made.',
    );
  });

  test("a console facet the session offers is called", () => {
    const narrowed = sessionCalls(EVERYTHING, { calls: { console: { endScope: "not-offered" } } });

    expect(checkConsoleFacet(EVERYTHING, "cancel")).toEqual([]);
    expect(checkConsoleFacet(EVERYTHING, "endScope")).toEqual([]);
    expect(checkConsoleFacet(narrowed, "cancel")).toEqual([]);
  });
});

describe("checkObjectsFacet", () => {
  test("the objects tree facet is refused by name to a session that does not offer it", () => {
    const withdrawn = sessionCalls(EVERYTHING, { calls: { objects: { tree: "not-offered" } } });
    const tree: CallRefusal = { rule: "facet-not-offered", pointer: "/objects/tree", name: "objects.tree" };

    expect(checkObjectsFacet(NOTHING, "tree")).toEqual([tree]);
    expect(checkObjectsFacet(sessionCalls(NOTHING, undefined), "tree")).toEqual([tree]);
    expect(checkObjectsFacet(withdrawn, "tree")).toEqual([tree]);
    expect(callRefusalSentence(tree)).toBe(
      'The session does not offer the facet "objects.tree" at "/objects/tree", so the call was not made.',
    );
  });

  test("a session that offers objects.tree is called", () => {
    const consoleNarrowed = sessionCalls(EVERYTHING, { calls: { console: { cancel: "not-offered" } } });

    expect(checkObjectsFacet(EVERYTHING, "tree")).toEqual([]);
    expect(checkObjectsFacet(sessionCalls(EVERYTHING, undefined), "tree")).toEqual([]);
    expect(checkObjectsFacet(consoleNarrowed, "tree")).toEqual([]);
  });
});

describe("CallRefusalError", () => {
  test("a CallRefusalError carries every refusal and words each", () => {
    const refusals = checkExecuteRequest(NOTHING, allThree);
    const error = new CallRefusalError(refusals);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CallRefusalError");
    expect(error.refusals).toEqual([PARAMS, OFFSET, SCOPE]);
    expect(error.refusals).not.toBe(refusals);
    expect(Object.isFrozen(error.refusals)).toBe(true);
    expect(error.message).toBe(refusals.map(callRefusalSentence).join(" "));
    expect(callRefusalSentence(PARAMS)).toBe(
      'The request carries the field "params" at "/params", which the session\'s execute does not honour, so the call was not made.',
    );
    expect(callRefusalSentence(SCOPE)).toBe(
      'The request carries a scope at "/scope", and the session does not offer console.endScope, so the call was not made.',
    );
    expect(error.message).not.toContain(statement);
  });

  test("every call refusal rule is worded in one sentence", () => {
    for (const rule of CALL_REFUSAL_RULES) {
      const forms: CallRefusal[] = [
        { rule, pointer: "" },
        { rule, pointer: "/a\nb", name: 'a"\nb', limit: 1048576, size: 1048577 },
      ];
      for (const item of forms) {
        const sentence = callRefusalSentence(item);

        expect(sentence).toMatch(/^[A-Z][^\n]*\.$/);
        expect(sentence).not.toMatch(/\. [A-Z]/);
      }
      expect(callRefusalSentence(forms[0])).toContain("the top level");
      expect(callRefusalSentence(forms[1])).toContain('"/a\\nb"');
    }
  });
});
