/**
 * The host reads what a console execute answered, once, before it pumps a row, and refuses by name a member it cannot
 * read (docs/providers/CONTRACT.md, clause C-112); it reads what a tree call answered against its action's form the
 * same way (clause C-62).
 *
 * Each case hands `checkExecuteAnswer` or `checkTreeAnswer` one answer and asserts the exact refusal list: a pointer
 * into the answer, the key where the answer has one it cannot have, and never a value of the answer. A getter is planted
 * where a member is read and counts its calls, so a case shows it was never called. Every planted value is generated at
 * run time.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AnswerCheck,
  type CallRefusal,
  CallRefusalError,
  callRefusalSentence,
  checkExecuteAnswer,
  checkTreeAnswer,
  type TreeRequest,
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

/** The refusals `checkExecuteAnswer` answers for `answer`, none where it reads the answer. */
function executeRefusals(answer: unknown): readonly CallRefusal[] {
  const check = checkExecuteAnswer(answer);
  return check.kind === "read" ? [] : check.refusals;
}

/** The refusals `checkTreeAnswer` answers for `answer` to `request`, none where it reads the answer. */
function treeRefusals(request: TreeRequest, answer: unknown): readonly CallRefusal[] {
  const check = checkTreeAnswer(request, answer);
  return check.kind === "read" ? [] : check.refusals;
}

describe("checkExecuteAnswer", () => {
  test("an execute answer's result list, first row count, execution time, warning list or warning outside the SDK's types is refused as execute-answer-unreadable at its pointer, a getter never called", () => {
    const reads = { count: 0 };

    // Vacuity: well-formed answers pass, with any execution time a finite non-negative number and warnings of the SDK.
    for (const executionTimeMs of [0, 1.5, 1e9]) expect(executeRefusals(answerOf({ executionTimeMs }))).toEqual([]);
    expect(
      executeRefusals(
        answerOf({
          results: [sourceOf([{ name: "a" }, { name: "b", type: "text" }], 0), sourceOf(marker(), -1)],
          warnings: [{ message: marker() }, { message: marker(), code: 7, severity: "W" }, { message: "", code: "c" }],
        }),
      ),
    ).toEqual([]);
    expect(executeRefusals(answerOf({ results: [] }))).toEqual([]);
    expect(executeRefusals(answerOf({ results: [sourceOf(undefined, 2 ** 53 - 1)] }))).toEqual([]);

    // The execution time.
    for (const executionTimeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect(executeRefusals(answerOf({ executionTimeMs }))).toEqual([unreadable("/executionTimeMs")]);
    }
    const { executionTimeMs: _, ...timeless } = answerOf();
    expect(executeRefusals(timeless)).toEqual([unreadable("/executionTimeMs")]);
    expect(executeRefusals(withAccessor(answerOf(), "executionTimeMs", reads, 1))).toEqual([
      unreadable("/executionTimeMs"),
    ]);

    // The result list and the first result's row count; a later result is not read.
    for (const results of [marker(), null, { 0: sourceOf() }]) {
      expect(executeRefusals(answerOf({ results }))).toEqual([unreadable("/results")]);
    }
    expect(executeRefusals(withAccessor(answerOf(), "results", reads, []))).toEqual([unreadable("/results")]);
    for (const rowCount of [-1, 1.5, 2 ** 53, null, "1", Number.NaN]) {
      expect(executeRefusals(answerOf({ results: [sourceOf(undefined, rowCount)] }))).toEqual([
        unreadable("/results/0/rowCount"),
      ]);
    }
    expect(executeRefusals(answerOf({ results: [withAccessor(sourceOf(), "rowCount", reads, 1)] }))).toEqual([
      unreadable("/results/0/rowCount"),
    ]);

    // The first result's columns: a list of named columns, each name text, not empty and not repeated.
    const { columns: _columns, ...columnless } = sourceOf();
    for (const source of [sourceOf(marker()), sourceOf(null), sourceOf({ 0: { name: "a" } }), columnless]) {
      expect(executeRefusals(answerOf({ results: [source] }))).toEqual([unreadable("/results/0/columns")]);
    }
    expect(
      executeRefusals(
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
    expect(executeRefusals(answerOf({ results: [withAccessor(sourceOf(), "columns", reads, [])] }))).toEqual([
      unreadable("/results/0/columns"),
    ]);
    expect(executeRefusals(answerOf({ results: [null] }))).toEqual([unreadable("/results/0/columns")]);

    // The warning list and each warning.
    for (const warnings of [marker(), null, undefined, { 0: { message: "m" } }]) {
      expect(executeRefusals(answerOf({ warnings }))).toEqual([unreadable("/warnings")]);
    }
    expect(executeRefusals(withAccessor(answerOf(), "warnings", reads, []))).toEqual([unreadable("/warnings")]);
    const extra = marker();
    expect(
      executeRefusals(
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
    expect(executeRefusals(answerOf({ warnings: holed }))).toEqual([unreadable("/warnings/1")]);

    // An answer that is no object has none of its members; an inherited name is a key like any other.
    for (const answer of [undefined, null, marker(), 1]) {
      expect(executeRefusals(answer)).toEqual([
        unreadable("/results"),
        unreadable("/executionTimeMs"),
        unreadable("/warnings"),
      ]);
    }
    expect(executeRefusals(answerOf({ warnings: [{ message: "m", constructor: 1 }] }))).toEqual([
      unreadable("/warnings/0/constructor", "constructor"),
    ]);

    expect(reads.count).toBe(0);
  });

  test("an optional execute answer member present with no value reads as absent, as it does in a tree answer", () => {
    const source = { ...sourceOf(), rowCount: undefined };

    expect(
      executeRefusals(
        answerOf({ results: [source], warnings: [{ message: marker(), code: undefined, severity: undefined }] }),
      ),
    ).toEqual([]);
    // A required member present with no value is still missing.
    expect(executeRefusals(answerOf({ warnings: [{ message: undefined }] }))).toEqual([
      unreadable("/warnings/0/message"),
    ]);
  });

  test("an execute answer's refusal sentence names the pointer and the key, never a value", () => {
    const planted = marker();
    const refusals = [
      ...executeRefusals(answerOf({ executionTimeMs: planted })),
      ...executeRefusals(answerOf({ warnings: [{ message: planted, [planted]: planted }] })),
    ];

    expect(refusals.map(callRefusalSentence)).toEqual([
      'The execute answer value at "/executionTimeMs" is missing, an accessor, or not of the type the provider contract defines there, so Studio did not read it.',
      `The execute answer has the key ${JSON.stringify(planted)} at ${JSON.stringify(`/warnings/0/${planted}`)}, which a warning cannot have, so Studio did not read it.`,
    ]);
    expect(new CallRefusalError(refusals.slice(0, 1)).message).not.toContain(planted);
  });

  test("an execute answer the check reads is answered as itself, by reference, and a refused one as its refusals alone", () => {
    const answer = answerOf();
    const read: AnswerCheck<unknown> = checkExecuteAnswer(answer);
    expect(read).toEqual({ kind: "read", answer });
    expect(read.kind === "read" && read.answer).toBe(answer);

    const refused = checkExecuteAnswer(answerOf({ executionTimeMs: marker() }));
    expect(refused).toEqual({ kind: "refused", refusals: [unreadable("/executionTimeMs")] });
    expect(Object.keys(refused)).toEqual(["kind", "refusals"]);
  });
});

function treeUnreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "tree-answer-unreadable", pointer }
    : { rule: "tree-answer-unreadable", pointer, name };
}

/** One request of each action, its container and path fresh for each call. */
function requestsOf(): Readonly<Record<TreeRequest["action"], TreeRequest>> {
  const container = [marker()];
  return {
    containers: { action: "containers" },
    count: { action: "count", container },
    list: { action: "list", container, kind: "table" },
    describe: { action: "describe", path: [...container, marker()], kind: "table" },
    describeMany: { action: "describeMany", container, kind: "table", limit: 2 },
  };
}

/** A well-formed object detail, every optional member present, with `over` replacing its members. */
function detailOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: [marker(), marker()],
    columns: [
      {
        name: marker(),
        type: marker(),
        baseType: marker(),
        declaredType: marker(),
        nullable: true,
        isPrimary: false,
        defaultValue: marker(),
        defaultExpression: marker(),
        provenance: "sampled",
        projectable: true,
      },
      { name: marker(), type: marker(), nullable: false, isPrimary: true },
    ],
    indexes: [{ name: marker(), columns: [marker()], unique: true }],
    foreignKeys: [{ columnName: marker(), referencedTable: marker(), referencedColumn: marker() }],
    exclusionConstraints: [{ name: marker(), definition: marker() }],
    ...over,
  };
}

/** A well-formed answer of each action, every optional member present. */
function answersOf(): Readonly<Record<TreeRequest["action"], Record<string, unknown>>> {
  return {
    containers: {
      containers: [
        { path: [marker()], name: marker(), level: 0, isSessionDefault: true, kinds: ["table"] },
        { path: [marker()], name: marker(), level: 0 },
      ],
    },
    count: {
      counts: { table: { count: 2 }, view: { count: 0, sampledFrom: marker() }, index: { unavailable: marker() } },
    },
    list: {
      objects: [
        {
          path: [marker(), marker()],
          name: marker(),
          kind: "table",
          status: marker(),
          rowCount: 3,
          sizeBytes: 2 ** 53 - 1,
          readRanges: [{ key: marker() }, { prefix: marker() }, { start: marker(), end: marker() }],
        },
        { path: [marker(), marker()], name: marker(), kind: "view" },
      ],
    },
    describe: { detail: detailOf() },
    describeMany: {
      details: [detailOf(), detailOf({ indexes: { unavailable: marker() }, exclusionConstraints: [] })],
      truncated: { limit: 2, reason: marker() },
    },
  };
}

describe("checkTreeAnswer", () => {
  test("a tree answer outside its action's form is refused as tree-answer-unreadable at its pointer, a key it cannot have named and no value carried", () => {
    const requests = requestsOf();
    const planted = marker();
    const extra = `k${marker()}`;

    // An answer that is no plain record is refused once, at the top level, whatever the action.
    for (const action of Object.keys(requests) as TreeRequest["action"][]) {
      for (const answer of [undefined, null, planted, 1, [], new (class Answer {})()]) {
        expect(treeRefusals(requests[action], answer)).toEqual([treeUnreadable("")]);
      }
    }

    // The member its action answers, missing, and a key no form of it has, named in the answer's key order.
    expect(treeRefusals(requests.containers, {})).toEqual([treeUnreadable("/containers")]);
    expect(treeRefusals(requests.count, {})).toEqual([treeUnreadable("/counts")]);
    expect(treeRefusals(requests.list, {})).toEqual([treeUnreadable("/objects")]);
    expect(treeRefusals(requests.describe, {})).toEqual([treeUnreadable("/detail")]);
    expect(treeRefusals(requests.describeMany, {})).toEqual([treeUnreadable("/details")]);
    expect(treeRefusals(requests.list, { [extra]: planted, objects: [], containers: [] })).toEqual([
      treeUnreadable(`/${extra}`, extra),
      treeUnreadable("/containers", "containers"),
    ]);
    expect(treeRefusals(requests.describe, { detail: null })).toEqual([treeUnreadable("/detail")]);

    // A container.
    expect(treeRefusals(requests.containers, { containers: { 0: {} } })).toEqual([treeUnreadable("/containers")]);
    expect(
      treeRefusals(requests.containers, {
        containers: [
          { path: planted, name: 1, level: -1, isSessionDefault: planted, kinds: [1], [extra]: planted },
          { path: [1], name: planted },
          null,
        ],
      }),
    ).toEqual([
      treeUnreadable("/containers/0/path"),
      treeUnreadable("/containers/0/name"),
      treeUnreadable("/containers/0/level"),
      treeUnreadable("/containers/0/isSessionDefault"),
      treeUnreadable("/containers/0/kinds/0"),
      treeUnreadable(`/containers/0/${extra}`, extra),
      treeUnreadable("/containers/1/path/0"),
      treeUnreadable("/containers/1/level"),
      treeUnreadable("/containers/2"),
    ]);
    for (const level of [1.5, Number.NaN, 2 ** 53, "0", null]) {
      expect(treeRefusals(requests.containers, { containers: [{ path: [planted], name: planted, level }] })).toEqual([
        treeUnreadable("/containers/0/level"),
      ]);
    }

    // A count of each kind: its form read by whether it has an own `unavailable`.
    expect(treeRefusals(requests.count, { counts: [] })).toEqual([treeUnreadable("/counts")]);
    expect(
      treeRefusals(requests.count, {
        counts: {
          table: { count: -1 },
          view: null,
          index: { unavailable: 1 },
          sequence: { count: 1, sampledFrom: 2 },
          trigger: { count: 1, [extra]: planted },
          type: { unavailable: planted, count: 1 },
          domain: {},
        },
      }),
    ).toEqual([
      treeUnreadable("/counts/table/count"),
      treeUnreadable("/counts/view"),
      treeUnreadable("/counts/index/unavailable"),
      treeUnreadable("/counts/sequence/sampledFrom"),
      treeUnreadable(`/counts/trigger/${extra}`, extra),
      treeUnreadable("/counts/type/count", "count"),
      treeUnreadable("/counts/domain/count"),
    ]);

    // An object, and the pieces of its range it may read.
    expect(
      treeRefusals(requests.list, {
        objects: [
          {
            path: [planted],
            name: planted,
            kind: 1,
            status: 2,
            rowCount: 1.5,
            sizeBytes: -1,
            readRanges: [{ key: 1 }, { start: planted }, {}, null, { prefix: planted, [extra]: planted }],
          },
          { name: planted, kind: planted, readRanges: planted },
        ],
      }),
    ).toEqual([
      treeUnreadable("/objects/0/kind"),
      treeUnreadable("/objects/0/status"),
      treeUnreadable("/objects/0/rowCount"),
      treeUnreadable("/objects/0/sizeBytes"),
      treeUnreadable("/objects/0/readRanges/0/key"),
      treeUnreadable("/objects/0/readRanges/1/end"),
      treeUnreadable("/objects/0/readRanges/2/start"),
      treeUnreadable("/objects/0/readRanges/2/end"),
      treeUnreadable("/objects/0/readRanges/3"),
      treeUnreadable(`/objects/0/readRanges/4/${extra}`, extra),
      treeUnreadable("/objects/1/readRanges"),
      treeUnreadable("/objects/1/path"),
    ]);

    // An object's detail: its columns, indexes, foreign keys and exclusion constraints.
    expect(
      treeRefusals(requests.describe, {
        detail: {
          path: [planted],
          columns: [
            { name: planted, nullable: "no", isPrimary: false, provenance: "inferred", projectable: 1, [extra]: 1 },
          ],
          indexes: [{ name: planted, columns: planted, unique: true }],
          foreignKeys: [{ columnName: planted, referencedTable: planted }],
          exclusionConstraints: [{ name: planted }],
          comment: planted,
        },
      }),
    ).toEqual([
      treeUnreadable("/detail/columns/0/nullable"),
      treeUnreadable("/detail/columns/0/provenance"),
      treeUnreadable("/detail/columns/0/projectable"),
      treeUnreadable(`/detail/columns/0/${extra}`, extra),
      treeUnreadable("/detail/columns/0/type"),
      treeUnreadable("/detail/indexes/0/columns"),
      treeUnreadable("/detail/foreignKeys/0/referencedColumn"),
      treeUnreadable("/detail/exclusionConstraints/0/definition"),
      treeUnreadable("/detail/comment", "comment"),
    ]);
    for (const indexes of [{ unavailable: 1 }, planted, null]) {
      expect(treeRefusals(requests.describe, { detail: detailOf({ indexes }) })).toEqual([
        treeUnreadable(
          indexes === null || typeof indexes === "string" ? "/detail/indexes" : "/detail/indexes/unavailable",
        ),
      ]);
    }

    // A batch of details, and the bound that stopped it short.
    expect(treeRefusals(requests.describeMany, { details: planted, truncated: { limit: -1, reason: 1 } })).toEqual([
      treeUnreadable("/details"),
      treeUnreadable("/truncated/limit"),
      treeUnreadable("/truncated/reason"),
    ]);
    expect(treeRefusals(requests.describeMany, { details: [detailOf({ path: undefined })], truncated: 1 })).toEqual([
      treeUnreadable("/details/0/path"),
      treeUnreadable("/truncated"),
    ]);

    // No refusal carries a value of the answer, and the sentence names the pointer and the key alone.
    const refusals = [
      ...treeRefusals(requests.list, { objects: [{ path: [planted], name: planted, kind: planted, status: 1 }] }),
      ...treeRefusals(requests.list, { objects: [], [extra]: planted }),
    ];
    expect(JSON.stringify(refusals)).not.toContain(planted);
    expect(refusals.map(callRefusalSentence)).toEqual([
      'The tree answer value at "/objects/0/status" is missing, an accessor, or not what the provider contract allows there for the request, so Studio did not read it.',
      `The tree answer has the key ${JSON.stringify(extra)} at ${JSON.stringify(`/${extra}`)}, which the provider contract does not define there, so Studio did not read it.`,
    ]);
  });

  test("needsConfiguration under a parent or beside a container, and more details than the request's limit, are refused as tree-answer-unreadable", () => {
    const requests = requestsOf();
    const container = { path: [marker()], name: marker(), level: 0 };
    const reason = marker();

    // Only a top-level listing that answers no container may say its inventory needs configuration (clause C-61).
    expect(treeRefusals(requests.containers, { containers: [], needsConfiguration: reason })).toEqual([]);
    expect(
      treeRefusals({ action: "containers", parent: [marker()] }, { containers: [], needsConfiguration: reason }),
    ).toEqual([treeUnreadable("/needsConfiguration")]);
    expect(treeRefusals(requests.containers, { containers: [container], needsConfiguration: reason })).toEqual([
      treeUnreadable("/needsConfiguration"),
    ]);
    expect(
      treeRefusals(
        { action: "containers", parent: [marker()] },
        { containers: [container], needsConfiguration: reason },
      ),
    ).toEqual([treeUnreadable("/needsConfiguration")]);
    // A sentence that is not text is refused once, for its type.
    expect(treeRefusals(requests.containers, { containers: [container], needsConfiguration: 1 })).toEqual([
      treeUnreadable("/needsConfiguration"),
    ]);

    // At most the request's limit of details; none is counted where the request sends no limit.
    const batch = { details: [detailOf(), detailOf(), detailOf()] };
    expect(treeRefusals({ action: "describeMany", container: [marker()], kind: "table", limit: 2 }, batch)).toEqual([
      treeUnreadable("/details"),
    ]);
    expect(treeRefusals({ action: "describeMany", container: [marker()], kind: "table", limit: 3 }, batch)).toEqual([]);
    expect(treeRefusals({ action: "describeMany", container: [marker()], kind: "table" }, batch)).toEqual([]);
  });

  test("a getter in a tree answer is refused and never called, and an optional member present with no value reads as absent", () => {
    const requests = requestsOf();
    const reads = { count: 0 };
    const name = marker();

    expect(treeRefusals(requests.containers, withAccessor({}, "containers", reads, []))).toEqual([
      treeUnreadable("/containers"),
    ]);
    expect(
      treeRefusals(requests.containers, withAccessor({ containers: [] }, "needsConfiguration", reads, marker())),
    ).toEqual([treeUnreadable("/needsConfiguration")]);
    expect(treeRefusals(requests.count, { counts: withAccessor({}, "table", reads, { count: 1 }) })).toEqual([
      treeUnreadable("/counts/table"),
    ]);
    expect(
      treeRefusals(requests.list, { objects: withAccessor([], "0", reads, { path: [], name, kind: "table" }) }),
    ).toEqual([treeUnreadable("/objects/0")]);
    expect(
      treeRefusals(requests.describe, {
        detail: detailOf({
          columns: [withAccessor({ name, type: name, nullable: true, isPrimary: false }, "defaultValue", reads)],
        }),
      }),
    ).toEqual([treeUnreadable("/detail/columns/0/defaultValue")]);
    expect(reads.count).toBe(0);

    // A hole in a list is no element.
    const holed: unknown[] = [{ path: [name], name, kind: "table" }];
    holed.length = 2;
    expect(treeRefusals(requests.list, { objects: holed })).toEqual([treeUnreadable("/objects/1")]);

    // An optional member present with no value reads as absent: in a column, an object, a container, a detail, a
    // batch, and a containers answer, where it says nothing about the inventory beside a container.
    expect(
      treeRefusals(requests.describe, {
        detail: detailOf({
          columns: [
            {
              name,
              type: name,
              baseType: undefined,
              declaredType: undefined,
              nullable: true,
              isPrimary: false,
              defaultValue: undefined,
              defaultExpression: undefined,
              provenance: undefined,
              projectable: undefined,
            },
          ],
          exclusionConstraints: undefined,
        }),
      }),
    ).toEqual([]);
    expect(
      treeRefusals(requests.list, {
        objects: [
          {
            path: [name],
            name,
            kind: "table",
            status: undefined,
            rowCount: undefined,
            sizeBytes: undefined,
            readRanges: undefined,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      treeRefusals(requests.containers, {
        containers: [{ path: [name], name, level: 0, isSessionDefault: undefined, kinds: undefined }],
        needsConfiguration: undefined,
      }),
    ).toEqual([]);
    expect(treeRefusals(requests.describeMany, { details: [], truncated: undefined })).toEqual([]);
    expect(treeRefusals(requests.count, { counts: { table: { count: 1, sampledFrom: undefined } } })).toEqual([]);
    // A required member present with no value is still missing.
    expect(treeRefusals(requests.list, { objects: [{ path: [name], name: undefined, kind: "table" }] })).toEqual([
      treeUnreadable("/objects/0/name"),
    ]);
  });

  test("a well-formed answer of each action passes, an inherited key name included, without throwing", () => {
    const requests = requestsOf();
    const answers = answersOf();

    for (const action of Object.keys(requests) as TreeRequest["action"][]) {
      expect(treeRefusals(requests[action], answers[action])).toEqual([]);
    }
    expect(treeRefusals(requests.containers, { containers: [] })).toEqual([]);
    expect(treeRefusals(requests.list, { objects: [] })).toEqual([]);
    expect(treeRefusals(requests.describeMany, { details: [] })).toEqual([]);

    // A kind is any text, an inherited name included, and a record with no prototype is a plain record.
    // Object.assign sets each key as an own data property, as a plain assignment would over an inherited method.
    const counts: object = Object.assign(JSON.parse('{"__proto__": {"count": 1}}'), {
      constructor: { count: 2 },
      toString: { unavailable: marker() },
    });
    expect(Object.getOwnPropertyNames(counts)).toEqual(["__proto__", "constructor", "toString"]);
    expect(treeRefusals(requests.count, { counts })).toEqual([]);
    expect(treeRefusals(requests.count, Object.assign(Object.create(null), { counts: {} }))).toEqual([]);

    // An action no form exists for is not this check's: the request check refuses it first.
    expect(treeRefusals({ action: "search" } as unknown as TreeRequest, { containers: [] })).toEqual([]);
  });

  test("a tree answer the check reads is answered as itself, by reference, and a refused one as its refusals alone", () => {
    const requests = requestsOf();
    const answers = answersOf();
    for (const action of Object.keys(requests) as TreeRequest["action"][]) {
      const check: AnswerCheck<unknown> = checkTreeAnswer(requests[action], answers[action]);
      expect(check).toEqual({ kind: "read", answer: answers[action] });
      expect(check.kind === "read" && check.answer).toBe(answers[action]);
    }

    const refused = checkTreeAnswer(requests.list, { objects: null });
    expect(refused).toEqual({ kind: "refused", refusals: [treeUnreadable("/objects")] });
    expect(Object.keys(refused)).toEqual(["kind", "refusals"]);
  });

  test("a member of another arm of a union present with no value reads as absent, so the arm its defined keys name is read", () => {
    const requests = requestsOf();
    const name = marker();

    // KindCount: a count beside an unavailable with no value is a count; an unavailable beside a count with no value
    // and a sampledFrom with no value is the engine's sentence.
    expect(
      treeRefusals(requests.count, {
        counts: {
          table: { count: 1, unavailable: undefined },
          view: { count: 2, sampledFrom: name, unavailable: undefined },
          index: { unavailable: name, count: undefined, sampledFrom: undefined },
        },
      }),
    ).toEqual([]);

    // ObjectReadRange: a prefix beside a key with no value is a prefix; a range beside a key and a prefix with no value
    // is a range; a key beside the range's members with no value is a key.
    const readRanges = [
      { key: undefined, prefix: name },
      { key: undefined, prefix: undefined, start: name, end: name },
      { key: name, prefix: undefined, start: undefined, end: undefined },
    ];
    expect(treeRefusals(requests.list, { objects: [{ path: [name], name, kind: "table", readRanges }] })).toEqual([]);

    // A defined member of another arm is still a key the chosen arm cannot have, and an arm's own required member
    // present with no value is still missing.
    expect(treeRefusals(requests.count, { counts: { table: { count: 1, unavailable: name } } })).toEqual([
      treeUnreadable("/counts/table/count", "count"),
    ]);
    expect(treeRefusals(requests.count, { counts: { table: { count: undefined, unavailable: undefined } } })).toEqual([
      treeUnreadable("/counts/table/count"),
    ]);
  });

  test("a tree answer whose reading throws is refused at the pointer being read, and the check never throws", () => {
    const requests = requestsOf();
    const name = marker();
    const revoked = (): object => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    const thrower = (): never => {
      throw new Error(marker());
    };

    // A revoked Proxy throws on every reading: as the answer, a record in it and a list in it.
    for (const action of Object.keys(requests) as TreeRequest["action"][]) {
      expect(treeRefusals(requests[action], revoked())).toEqual([treeUnreadable("")]);
    }
    expect(treeRefusals(requests.list, { objects: [revoked()] })).toEqual([treeUnreadable("/objects/0")]);
    expect(treeRefusals(requests.list, { objects: revoked() })).toEqual([treeUnreadable("/objects")]);
    expect(treeRefusals(requests.count, { counts: revoked() })).toEqual([treeUnreadable("/counts")]);
    expect(treeRefusals(requests.count, { counts: { table: revoked() } })).toEqual([treeUnreadable("/counts/table")]);
    expect(treeRefusals(requests.describe, { detail: detailOf({ indexes: revoked() }) })).toEqual([
      treeUnreadable("/detail/indexes"),
    ]);
    expect(
      treeRefusals(requests.list, { objects: [{ path: [name], name, kind: "table", readRanges: [revoked()] }] }),
    ).toEqual([treeUnreadable("/objects/0/readRanges/0")]);

    // A trap that throws while one member is read is refused at that member, and the record's other members are read.
    const object = new Proxy(
      { path: [name], name, kind: "table" },
      {
        getOwnPropertyDescriptor: (target, key) =>
          key === "name" ? thrower() : Reflect.getOwnPropertyDescriptor(target, key),
      },
    );
    expect(treeRefusals(requests.list, { objects: [object] })).toEqual([treeUnreadable("/objects/0/name")]);
    const list = new Proxy([name], { get: (target, key) => (key === "length" ? thrower() : Reflect.get(target, key)) });
    expect(treeRefusals(requests.list, { objects: [{ path: list, name, kind: "table" }] })).toEqual([
      treeUnreadable("/objects/0/path"),
    ]);

    // A top-level member read again past its form, a second reading that throws, is refused at its own pointer.
    let readings = 0;
    const answer = new Proxy(
      { containers: [], needsConfiguration: name },
      {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === "needsConfiguration" && ++readings > 1) thrower();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(treeRefusals(requests.containers, answer)).toEqual([treeUnreadable("/needsConfiguration")]);
    // A list's length read again past its form, a second reading that throws, is refused at the list once.
    let lengths = 0;
    const details = new Proxy([detailOf()], {
      get: (target, key) => (key === "length" && ++lengths > 1 ? thrower() : Reflect.get(target, key)),
    });
    expect(treeRefusals(requests.describeMany, { details })).toEqual([treeUnreadable("/details")]);
    // A list whose every reading of its length throws is refused at the list once, its form's refusal.
    const containers = new Proxy([], {
      get: (target, key) => (key === "length" ? thrower() : Reflect.get(target, key)),
    });
    expect(treeRefusals(requests.containers, { containers, needsConfiguration: name })).toEqual([
      treeUnreadable("/containers"),
    ]);
    expect(treeRefusals(requests.describeMany, { details: containers })).toEqual([treeUnreadable("/details")]);
  });

  test("an answer list with an own key that is neither an index nor its length is refused at that key, by name", () => {
    const requests = requestsOf();
    const name = marker();
    const extra = `k${marker()}`;
    const tagged = <T extends unknown[]>(list: T, value: unknown = marker()): T =>
      Object.assign(list, { [extra]: value });

    expect(treeRefusals(requests.list, { objects: tagged([]) })).toEqual([treeUnreadable(`/objects/${extra}`, extra)]);
    expect(treeRefusals(requests.containers, { containers: [{ path: tagged([name]), name, level: 0 }] })).toEqual([
      treeUnreadable(`/containers/0/path/${extra}`, extra),
    ]);
    expect(treeRefusals(requests.describeMany, { details: tagged([detailOf()], undefined) })).toEqual([
      treeUnreadable(`/details/${extra}`, extra),
    ]);
    // A key that reads as a number but is no array index of the list is no index of it, and leaves its length alone.
    const numeric = Object.assign([], { "01": 1, "-1": 1, "4294967295": 1 });
    expect(numeric.length).toBe(0);
    expect(treeRefusals(requests.list, { objects: numeric })).toEqual([
      treeUnreadable("/objects/01", "01"),
      treeUnreadable("/objects/-1", "-1"),
      treeUnreadable("/objects/4294967295", "4294967295"),
    ]);
    // An accessor under such a key is refused by name and never called.
    const reads = { count: 0 };
    expect(treeRefusals(requests.list, { objects: withAccessor([], extra, reads) })).toEqual([
      treeUnreadable(`/objects/${extra}`, extra),
    ]);
    expect(reads.count).toBe(0);
  });
});
