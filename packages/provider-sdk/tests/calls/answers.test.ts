/**
 * The host reads what a console execute answered, once, before it pumps a row, and refuses by name a member it cannot
 * read (docs/providers/CONTRACT.md, clause C-112).
 *
 * Each case hands `checkExecuteAnswer` one answer and asserts the exact refusal list: a pointer into the answer, the key
 * where a warning has one it cannot have, and never a value of the answer. A getter is planted where a member is read
 * and counts its calls, so a case shows it was never called. Every planted value is generated at run time.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallRefusal,
  CallRefusalError,
  callRefusalSentence,
  checkExecuteAnswer,
} from "@libredb/provider-sdk/calls";

const marker = (): string => randomUUID();

function unreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "execute-answer-unreadable", pointer }
    : { rule: "execute-answer-unreadable", pointer, name };
}

/** A result source over `columns`, with `rowCount` when given; its functions are never called by the check. */
function sourceOf(columns: unknown = [{ name: "id" }], rowCount?: unknown): Record<string, unknown> {
  return {
    columns,
    ...(rowCount === undefined ? {} : { rowCount }),
    next: () => Promise.reject(new Error("the check pulled a source")),
    close: () => Promise.reject(new Error("the check closed a source")),
  };
}

/** A well-formed answer, with `over` replacing its members. */
function answerOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { results: [sourceOf()], warnings: [], executionTimeMs: 3, pageApplied: false, ...over };
}

/** `base` with `key` an accessor counting its calls in `reads`. */
function withAccessor(base: object, key: string, reads: { count: number }, value: unknown = marker()): object {
  return Object.defineProperty(base, key, {
    enumerable: true,
    get() {
      reads.count += 1;
      return value;
    },
  });
}

describe("checkExecuteAnswer", () => {
  test("an execute answer's result list, first row count, execution time, warning list or warning outside the SDK's types is refused as execute-answer-unreadable at its pointer, a getter never called", () => {
    const reads = { count: 0 };

    // Vacuity: well-formed answers pass, with any execution time a finite non-negative number and warnings of the SDK.
    for (const executionTimeMs of [0, 1.5, 1e9]) expect(checkExecuteAnswer(answerOf({ executionTimeMs }))).toEqual([]);
    expect(
      checkExecuteAnswer(
        answerOf({
          results: [sourceOf([{ name: "a" }, { name: "b", type: "text" }], 0), sourceOf(marker(), -1)],
          warnings: [{ message: marker() }, { message: marker(), code: 7, severity: "W" }, { message: "", code: "c" }],
        }),
      ),
    ).toEqual([]);
    expect(checkExecuteAnswer(answerOf({ results: [] }))).toEqual([]);
    expect(checkExecuteAnswer(answerOf({ results: [sourceOf(undefined, 2 ** 53 - 1)] }))).toEqual([]);

    // The execution time.
    for (const executionTimeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect(checkExecuteAnswer(answerOf({ executionTimeMs }))).toEqual([unreadable("/executionTimeMs")]);
    }
    const { executionTimeMs: _, ...timeless } = answerOf();
    expect(checkExecuteAnswer(timeless)).toEqual([unreadable("/executionTimeMs")]);
    expect(checkExecuteAnswer(withAccessor(answerOf(), "executionTimeMs", reads, 1))).toEqual([
      unreadable("/executionTimeMs"),
    ]);

    // The result list and the first result's row count; a later result is not read.
    for (const results of [marker(), null, { 0: sourceOf() }]) {
      expect(checkExecuteAnswer(answerOf({ results }))).toEqual([unreadable("/results")]);
    }
    expect(checkExecuteAnswer(withAccessor(answerOf(), "results", reads, []))).toEqual([unreadable("/results")]);
    for (const rowCount of [-1, 1.5, 2 ** 53, null, "1", Number.NaN]) {
      expect(checkExecuteAnswer(answerOf({ results: [sourceOf(undefined, rowCount)] }))).toEqual([
        unreadable("/results/0/rowCount"),
      ]);
    }
    expect(checkExecuteAnswer(answerOf({ results: [withAccessor(sourceOf(), "rowCount", reads, 1)] }))).toEqual([
      unreadable("/results/0/rowCount"),
    ]);

    // The first result's columns: a list of named columns, each name text, not empty and not repeated.
    const { columns: _columns, ...columnless } = sourceOf();
    for (const source of [sourceOf(marker()), sourceOf(null), sourceOf({ 0: { name: "a" } }), columnless]) {
      expect(checkExecuteAnswer(answerOf({ results: [source] }))).toEqual([unreadable("/results/0/columns")]);
    }
    expect(
      checkExecuteAnswer(
        answerOf({
          results: [
            sourceOf([
              { name: "a" },
              { name: "" },
              { name: 7 },
              null,
              withAccessor({}, "name", reads, "z"),
              { name: "a" },
            ]),
          ],
        }),
      ),
    ).toEqual([
      unreadable("/results/0/columns/1/name"),
      unreadable("/results/0/columns/2/name"),
      unreadable("/results/0/columns/3/name"),
      unreadable("/results/0/columns/4/name"),
      unreadable("/results/0/columns/5/name"),
    ]);
    expect(checkExecuteAnswer(answerOf({ results: [withAccessor(sourceOf(), "columns", reads, [])] }))).toEqual([
      unreadable("/results/0/columns"),
    ]);
    expect(checkExecuteAnswer(answerOf({ results: [null] }))).toEqual([unreadable("/results/0/columns")]);

    // The warning list and each warning.
    for (const warnings of [marker(), null, undefined, { 0: { message: "m" } }]) {
      expect(checkExecuteAnswer(answerOf({ warnings }))).toEqual([unreadable("/warnings")]);
    }
    expect(checkExecuteAnswer(withAccessor(answerOf(), "warnings", reads, []))).toEqual([unreadable("/warnings")]);
    const extra = marker();
    expect(
      checkExecuteAnswer(
        answerOf({
          warnings: [
            null,
            marker(),
            { message: 1 },
            { message: "m", code: {} },
            { message: "m", [extra]: 1 },
            withAccessor({}, "message", reads),
            { message: "m", severity: 1 },
            { code: 1 },
            new (class Warning {
              message = "m";
            })(),
          ],
        }),
      ),
    ).toEqual([
      unreadable("/warnings/0"),
      unreadable("/warnings/1"),
      unreadable("/warnings/2/message"),
      unreadable("/warnings/3/code"),
      unreadable(`/warnings/4/${extra}`, extra),
      unreadable("/warnings/5/message"),
      unreadable("/warnings/6/severity"),
      unreadable("/warnings/7/message"),
      unreadable("/warnings/8"),
    ]);
    const holed: unknown[] = [{ message: "m" }];
    holed.length = 2;
    expect(checkExecuteAnswer(answerOf({ warnings: holed }))).toEqual([unreadable("/warnings/1")]);

    // An answer that is no object has none of its members; an inherited name is a key like any other.
    for (const answer of [undefined, null, marker(), 1]) {
      expect(checkExecuteAnswer(answer)).toEqual([
        unreadable("/results"),
        unreadable("/executionTimeMs"),
        unreadable("/warnings"),
      ]);
    }
    expect(checkExecuteAnswer(answerOf({ warnings: [{ message: "m", constructor: 1 }] }))).toEqual([
      unreadable("/warnings/0/constructor", "constructor"),
    ]);

    expect(reads.count).toBe(0);
  });

  test("an execute answer's refusal sentence names the pointer and the key, never a value", () => {
    const planted = marker();
    const refusals = [
      ...checkExecuteAnswer(answerOf({ executionTimeMs: planted })),
      ...checkExecuteAnswer(answerOf({ warnings: [{ message: planted, [planted]: planted }] })),
    ];

    expect(refusals.map(callRefusalSentence)).toEqual([
      'The execute answer value at "/executionTimeMs" is missing, an accessor, or not of the type the provider contract defines there, so Studio did not read it.',
      `The execute answer has the key ${JSON.stringify(planted)} at ${JSON.stringify(`/warnings/0/${planted}`)}, which a warning cannot have, so Studio did not read it.`,
    ]);
    expect(new CallRefusalError(refusals.slice(0, 1)).message).not.toContain(planted);
  });
});
