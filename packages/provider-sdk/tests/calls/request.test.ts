/**
 * The host refuses, before the call, a request field the session does not honour (docs/providers/CONTRACT.md, clause
 * C-9).
 *
 * Each case holds a request to the session's calls, the manifest's `calls` or the narrowed ones a refinement leaves,
 * and asserts the exact refusal list: a pointer into the request, the field's name, and never a value of the request.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CALL_REFUSAL_RULES,
  type CallRefusal,
  CallRefusalError,
  callRefusalSentence,
  checkExecuteRequest,
  type ExecuteRequest,
  sessionCalls,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";

/** The calls of a package that honours nothing and offers no facet. */
const NOTHING: Calls = {
  console: { execute: { honours: [] }, cancel: "not-offered", endScope: "not-offered" },
};

/** The calls of a package that honours every field and offers every facet. */
const EVERYTHING: Calls = {
  console: { execute: { honours: ["params", "offset"] }, cancel: "offered", endScope: "offered" },
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
        { rule, pointer: "/a\nb", name: 'a"\nb' },
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
