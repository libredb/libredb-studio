/**
 * The host reads what a console execute answered, once, before it pumps a row, and refuses by name a member it cannot
 * read (docs/providers/CONTRACT.md, clause C-112); it reads what a tree call answered against its action's form the
 * same way (clause C-62), what a source call answered against the SDK's closed source document (clause C-115), and
 * what a monitoring panel, pool statistics, health, maintenance run or maintenance preview call answered against its SDK
 * type (clause C-112).
 *
 * Each case hands one of the answer checks one answer and asserts the exact refusal list: a pointer
 * into the answer, the key where the answer has one it cannot have, and never a value of the answer. A getter is planted
 * where a member is read and counts its calls, so a case shows it was never called. Every planted value is generated at
 * run time.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ANSWER_LIST_MAX,
  type AnswerCheck,
  type CallRefusal,
  CallRefusalError,
  type CallRefusalRule,
  callRefusalSentence,
  checkExecuteAnswer,
  checkHealthAnswer,
  checkMaintenancePreviewAnswer,
  checkMaintenanceRunAnswer,
  checkPanelAnswer,
  checkPoolStatsAnswer,
  checkSourceAnswer,
  checkTreeAnswer,
  type MonitoringPanelRequest,
  SOURCE_CHARACTER_LIMIT,
  SOURCE_PART_LIMIT,
  type SourceRequest,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";

const marker = (): string => randomUUID();

/** A revoked Proxy: every reading of it throws. */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** Throws an error of its own. */
function thrower(): never {
  throw new Error(marker());
}

/**
 * A list that says it is `length` long and holds no item, counting in `reads` each reading of an item's descriptor; its
 * length is a Proxy's answer (`listOfLength`), so it holds no memory for it.
 */
function longList(length: number, reads: { count: number }): unknown[] {
  return listOfLength(length, reads);
}

/** `target` behind a trap whose reading of its length's descriptor runs `onLength`, which answers that descriptor. */
function onLengthRead<T extends object>(
  target: T,
  onLength: (descriptor: PropertyDescriptor | undefined) => PropertyDescriptor | undefined,
): T {
  return new Proxy(target, {
    getOwnPropertyDescriptor: (inner, key) =>
      key === "length"
        ? onLength(Reflect.getOwnPropertyDescriptor(inner, key))
        : Reflect.getOwnPropertyDescriptor(inner, key),
  });
}

/**
 * A list that holds no item and whose length is `length`, answered alike by its length's descriptor and by its `get`
 * trap, so a reader of either form meets it; each reading of an item's descriptor is counted in `reads`.
 */
function listOfLength(length: unknown, reads: { count: number }): unknown[] {
  return new Proxy([] as unknown[], {
    get: (target, key) => (key === "length" ? length : Reflect.get(target, key)),
    getOwnPropertyDescriptor: (target, key) => {
      if (key === "length") return { ...Reflect.getOwnPropertyDescriptor(target, key), value: length };
      reads.count += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

/** A length that converts to 0 on its first conversion and to `after` on every later one. */
function shiftingLength(after: number): object {
  let conversions = 0;
  return { valueOf: () => (conversions++ === 0 ? 0 : after) };
}

/**
 * Each length that is no count, made fresh by its function so a shifting one starts unconverted: a length whose
 * conversion shifts, text, a fraction, a negative number and NaN.
 */
function nonCountLengths(): readonly (() => unknown)[] {
  return [() => shiftingLength(3), () => "1", () => 1.5, () => -1, () => Number.NaN];
}

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

  test("an execute answer whose reading throws is refused at the pointer being read, and the check never throws", () => {
    // A revoked Proxy throws on every reading: as the answer, its result list, its first result, the first result's
    // columns, a column, the warning list and a warning.
    expect(executeRefusals(revoked())).toEqual([
      unreadable("/results"),
      unreadable("/executionTimeMs"),
      unreadable("/warnings"),
    ]);
    expect(executeRefusals(answerOf({ results: revoked() }))).toEqual([unreadable("/results")]);
    expect(executeRefusals(answerOf({ results: [revoked()] }))).toEqual([
      unreadable("/results/0/columns"),
      unreadable("/results/0/rowCount"),
    ]);
    expect(executeRefusals(answerOf({ results: [sourceOf(revoked())] }))).toEqual([unreadable("/results/0/columns")]);
    expect(executeRefusals(answerOf({ results: [sourceOf([{ name: "a" }, revoked()])] }))).toEqual([
      unreadable("/results/0/columns/1/name"),
    ]);
    expect(executeRefusals(answerOf({ warnings: revoked() }))).toEqual([unreadable("/warnings")]);
    expect(executeRefusals(answerOf({ warnings: [{ message: "m" }, revoked()] }))).toEqual([unreadable("/warnings/1")]);

    // A trap that throws while one member is read is refused at that member, and the answer's other members are read.
    const answer = new Proxy(answerOf({ executionTimeMs: marker() }), {
      getOwnPropertyDescriptor: (target, key) =>
        key === "results" ? thrower() : Reflect.getOwnPropertyDescriptor(target, key),
    });
    expect(executeRefusals(answer)).toEqual([unreadable("/results"), unreadable("/executionTimeMs")]);
    const warning = new Proxy(
      { message: "m", code: 1 },
      {
        getOwnPropertyDescriptor: (target, key) =>
          key === "code" ? thrower() : Reflect.getOwnPropertyDescriptor(target, key),
      },
    );
    expect(executeRefusals(answerOf({ warnings: [warning, { message: 1 }] }))).toEqual([
      unreadable("/warnings/0/code"),
      unreadable("/warnings/1/message"),
    ]);
    const results = new Proxy([sourceOf()], {
      getOwnPropertyDescriptor: (target, key) =>
        key === "0" ? thrower() : Reflect.getOwnPropertyDescriptor(target, key),
    });
    expect(executeRefusals(answerOf({ results }))).toEqual([unreadable("/results/0")]);
    const warnings = onLengthRead([], thrower);
    expect(executeRefusals(answerOf({ warnings }))).toEqual([unreadable("/warnings")]);
  });

  test("an execute answer list longer than its bound is refused at the list before any item is read, and its first hole is refused once and ends it", () => {
    const reads = { count: 0 };

    expect(executeRefusals(answerOf({ results: longList(ANSWER_LIST_MAX.results + 1, reads) }))).toEqual([
      unreadable("/results"),
    ]);
    expect(executeRefusals(answerOf({ warnings: longList(ANSWER_LIST_MAX.warnings + 1, reads) }))).toEqual([
      unreadable("/warnings"),
    ]);
    expect(executeRefusals(answerOf({ results: [sourceOf(longList(ANSWER_LIST_MAX.columns + 1, reads))] }))).toEqual([
      unreadable("/results/0/columns"),
    ]);
    expect(reads.count).toBe(0);
    // A list as long as its bound is read.
    const columns = Array.from({ length: ANSWER_LIST_MAX.columns }, (_, index) => ({ name: `c${index}` }));
    expect(executeRefusals(answerOf({ results: [sourceOf(columns)] }))).toEqual([]);

    // The first hole is refused at its index, and nothing after it is read.
    const warningsHoled: unknown[] = [{ message: "m" }];
    warningsHoled[2] = null;
    warningsHoled.length = 1000;
    expect(executeRefusals(answerOf({ warnings: warningsHoled }))).toEqual([unreadable("/warnings/1")]);
    const columnsHoled: unknown[] = [{ name: "a" }];
    columnsHoled[2] = null;
    expect(executeRefusals(answerOf({ results: [sourceOf(columnsHoled)] }))).toEqual([
      unreadable("/results/0/columns/1"),
    ]);
  });

  test("an execute answer list whose length is no count is refused at the list before any item is read", () => {
    const reads = { count: 0 };
    for (const length of nonCountLengths()) {
      expect(executeRefusals(answerOf({ results: listOfLength(length(), reads) }))).toEqual([unreadable("/results")]);
      expect(executeRefusals(answerOf({ warnings: listOfLength(length(), reads) }))).toEqual([unreadable("/warnings")]);
      expect(executeRefusals(answerOf({ results: [sourceOf(listOfLength(length(), reads))] }))).toEqual([
        unreadable("/results/0/columns"),
      ]);
    }
    expect(reads.count).toBe(0);
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
    const list = onLengthRead([name], thrower);
    expect(treeRefusals(requests.list, { objects: [{ path: list, name, kind: "table" }] })).toEqual([
      treeUnreadable("/objects/0/path"),
    ]);

    // A list whose every reading of its length throws is refused at the list once, its form's refusal.
    const containers = onLengthRead([], thrower);
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

  test("each member of a tree answer is read once, so a trap that answers anew on a later reading never makes the check throw", () => {
    const requests = requestsOf();
    const name = marker();

    /**
     * `answer` behind a trap that answers each of its own members as it is on its first reading and as a revoked Proxy
     * on every later one, counting the readings of each member in `readings`.
     */
    const stateful = (answer: Record<string, unknown>, readings: Record<string, number>): object =>
      new Proxy(answer, {
        getOwnPropertyDescriptor: (target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (typeof key !== "string" || descriptor === undefined) return descriptor;
          readings[key] = (readings[key] ?? 0) + 1;
          return readings[key] === 1 ? descriptor : { ...descriptor, value: revoked() };
        },
      });

    const many: Record<string, number> = {};
    expect(treeRefusals(requests.describeMany, stateful({ details: [] }, many))).toEqual([]);
    expect(many).toEqual({ details: 1 });
    const containers: Record<string, number> = {};
    expect(
      treeRefusals(requests.containers, stateful({ containers: [], needsConfiguration: name }, containers)),
    ).toEqual([]);
    expect(containers).toEqual({ containers: 1, needsConfiguration: 1 });
    const beside: Record<string, number> = {};
    expect(
      treeRefusals(
        requests.containers,
        stateful({ containers: [{ path: [name], name, level: 0 }], needsConfiguration: name }, beside),
      ),
    ).toEqual([treeUnreadable("/needsConfiguration")]);
    expect(beside).toEqual({ containers: 1, needsConfiguration: 1 });

    // A list's length is read once: a length whose second reading throws is never read twice.
    let lengths = 0;
    const details = onLengthRead([detailOf()], (descriptor) => (++lengths > 1 ? thrower() : descriptor));
    expect(treeRefusals(requests.describeMany, { details })).toEqual([]);
    expect(lengths).toBe(1);
  });

  test("a tree answer list longer than its bound is refused at the list before any item is read, and its first hole is refused once and ends it", () => {
    const requests = requestsOf();
    const name = marker();
    const reads = { count: 0 };

    // A describeMany request's limit bounds its details; every other list takes its member's bound.
    expect(treeRefusals(requests.describeMany, { details: longList(3, reads) })).toEqual([treeUnreadable("/details")]);
    expect(
      treeRefusals(requests.containers, {
        containers: [{ path: longList(ANSWER_LIST_MAX.path + 1, reads), name, level: 0 }],
      }),
    ).toEqual([treeUnreadable("/containers/0/path")]);
    expect(
      treeRefusals(requests.containers, {
        containers: [{ path: [name], name, level: 0, kinds: longList(ANSWER_LIST_MAX.kinds + 1, reads) }],
      }),
    ).toEqual([treeUnreadable("/containers/0/kinds")]);
    expect(
      treeRefusals(requests.list, {
        objects: [{ path: [name], name, kind: "table", readRanges: longList(ANSWER_LIST_MAX.readRanges + 1, reads) }],
      }),
    ).toEqual([treeUnreadable("/objects/0/readRanges")]);
    expect(
      treeRefusals(requests.describe, {
        detail: detailOf({
          columns: longList(ANSWER_LIST_MAX.columns + 1, reads),
          indexes: longList(ANSWER_LIST_MAX.indexes + 1, reads),
          foreignKeys: longList(ANSWER_LIST_MAX.foreignKeys + 1, reads),
          exclusionConstraints: longList(ANSWER_LIST_MAX.exclusionConstraints + 1, reads),
        }),
      }),
    ).toEqual([
      treeUnreadable("/detail/columns"),
      treeUnreadable("/detail/indexes"),
      treeUnreadable("/detail/foreignKeys"),
      treeUnreadable("/detail/exclusionConstraints"),
    ]);
    expect(
      treeRefusals(requests.describe, {
        detail: detailOf({ indexes: [{ name, columns: longList(ANSWER_LIST_MAX.columns + 1, reads), unique: true }] }),
      }),
    ).toEqual([treeUnreadable("/detail/indexes/0/columns")]);
    expect(reads.count).toBe(0);
    // A list as long as its bound is read.
    const path = Array.from({ length: ANSWER_LIST_MAX.path }, () => name);
    expect(treeRefusals(requests.containers, { containers: [{ path, name, level: 0 }] })).toEqual([]);

    // The first hole is refused at its index, and nothing after it is read.
    const object = { path: [name], name, kind: "table" };
    const holed: unknown[] = [object];
    holed[2] = null;
    holed.length = 1000;
    expect(treeRefusals(requests.list, { objects: holed })).toEqual([treeUnreadable("/objects/1")]);
    const pathHoled: unknown[] = [name];
    pathHoled[2] = 1;
    expect(treeRefusals(requests.list, { objects: [{ ...object, path: pathHoled }] })).toEqual([
      treeUnreadable("/objects/0/path/1"),
    ]);
  });

  test("a tree answer list whose length is no count is refused at the list before any item is read", () => {
    const requests = requestsOf();
    const name = marker();
    const reads = { count: 0 };
    for (const length of nonCountLengths()) {
      expect(treeRefusals(requests.list, { objects: listOfLength(length(), reads) })).toEqual([
        treeUnreadable("/objects"),
      ]);
      // A describeMany request's limit bounds its details, and a length that is no count is refused before it.
      expect(treeRefusals(requests.describeMany, { details: listOfLength(length(), reads) })).toEqual([
        treeUnreadable("/details"),
      ]);
      expect(
        treeRefusals(requests.containers, { containers: [{ path: listOfLength(length(), reads), name, level: 0 }] }),
      ).toEqual([treeUnreadable("/containers/0/path")]);
    }
    expect(reads.count).toBe(0);
  });
});

function sourceUnreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "source-answer-unreadable", pointer }
    : { rule: "source-answer-unreadable", pointer, name };
}

/** The refusals `checkSourceAnswer` answers for `answer` to `request`, none where it reads the answer. */
function sourceRefusals(request: SourceRequest, answer: unknown): readonly CallRefusal[] {
  const check = checkSourceAnswer(request, answer);
  return check.kind === "read" ? [] : check.refusals;
}

/** A readable part, every optional member present, with `over` replacing its members. */
function readablePartOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: marker(),
    label: marker(),
    text: marker(),
    language: "sql",
    form: "complete",
    origin: "stored",
    truncated: { limit: 10, reason: marker() },
    edit: { offered: false, reason: marker() },
    ...over,
  };
}

/** A source answer to `request` holding `parts`, with `over` replacing its members. */
function sourceAnswerOf(
  request: SourceRequest,
  parts: readonly unknown[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { path: [...request.path], kind: request.kind, parts: [...parts], ...over };
}

describe("checkSourceAnswer", () => {
  const request: SourceRequest = { path: [marker(), "", marker()], kind: "routine" };

  test("a source answer outside the SDK's closed form is refused as source-answer-unreadable at its pointer, a key it cannot have named and no value carried", () => {
    const planted = marker();
    const extra = `k${marker()}`;

    // An answer that is no plain record is refused once, at the top level.
    for (const answer of [undefined, null, planted, 1, [], new (class Answer {})()]) {
      expect(sourceRefusals(request, answer)).toEqual([sourceUnreadable("")]);
    }
    // Every member missing, and a key the document cannot have named, an inherited name included.
    expect(sourceRefusals(request, {})).toEqual([
      sourceUnreadable("/path"),
      sourceUnreadable("/kind"),
      sourceUnreadable("/parts"),
    ]);
    const inherited = Object.assign(sourceAnswerOf(request, [readablePartOf()]), { constructor: planted });
    expect(sourceRefusals(request, { ...sourceAnswerOf(request, [readablePartOf()]), [extra]: planted })).toEqual([
      sourceUnreadable(`/${extra}`, extra),
    ]);
    expect(sourceRefusals(request, inherited)).toEqual([sourceUnreadable("/constructor", "constructor")]);

    // A readable part: each member of the wrong type or outside its vocabulary, and a key it cannot have, named.
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [
          readablePartOf({
            id: 1,
            label: null,
            text: [],
            language: 2,
            form: "whole",
            origin: "guessed",
            truncated: { limit: -1, reason: planted, [extra]: planted },
            edit: { offered: "yes" },
            [extra]: planted,
          }),
        ]),
      ),
    ).toEqual([
      sourceUnreadable("/parts/0/id"),
      sourceUnreadable("/parts/0/label"),
      sourceUnreadable("/parts/0/text"),
      sourceUnreadable("/parts/0/language"),
      sourceUnreadable("/parts/0/form"),
      sourceUnreadable("/parts/0/origin"),
      sourceUnreadable("/parts/0/truncated/limit"),
      sourceUnreadable(`/parts/0/truncated/${extra}`, extra),
      sourceUnreadable("/parts/0/edit/offered"),
      sourceUnreadable(`/parts/0/${extra}`, extra),
    ]);
    for (const limit of [1.5, Number.NaN, 2 ** 53, "1", null]) {
      expect(
        sourceRefusals(request, sourceAnswerOf(request, [readablePartOf({ truncated: { limit, reason: planted } })])),
      ).toEqual([sourceUnreadable("/parts/0/truncated/limit")]);
    }
    // An edit refused with no reason, and one offered with a reason, are neither form of an edit.
    expect(sourceRefusals(request, sourceAnswerOf(request, [readablePartOf({ edit: { offered: false } })]))).toEqual([
      sourceUnreadable("/parts/0/edit/offered"),
    ]);
    expect(
      sourceRefusals(request, sourceAnswerOf(request, [readablePartOf({ edit: { offered: true, reason: planted } })])),
    ).toEqual([sourceUnreadable("/parts/0/edit/offered")]);
    // A readable part missing its members.
    expect(sourceRefusals(request, sourceAnswerOf(request, [{ id: planted, label: planted }]))).toEqual([
      sourceUnreadable("/parts/0/text"),
      sourceUnreadable("/parts/0/language"),
      sourceUnreadable("/parts/0/form"),
      sourceUnreadable("/parts/0/origin"),
    ]);

    // A hybrid: a text beside the engine's sentence is read as the refused form, and its text is named.
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [
          { ...readablePartOf({ truncated: undefined, edit: undefined }), unavailable: planted },
        ]),
      ),
    ).toEqual([
      sourceUnreadable("/parts/0/text", "text"),
      sourceUnreadable("/parts/0/language", "language"),
      sourceUnreadable("/parts/0/form", "form"),
      sourceUnreadable("/parts/0/origin", "origin"),
    ]);
    // A statement is true only, and only beside the engine's sentence.
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [{ id: planted, label: planted, unavailable: planted, statement: "true" }]),
      ),
    ).toEqual([sourceUnreadable("/parts/0/statement")]);
    expect(
      sourceRefusals(request, sourceAnswerOf(request, [readablePartOf({ statement: true, truncated: undefined })])),
    ).toEqual([sourceUnreadable("/parts/0/statement", "statement")]);
    // A part that is no plain record, and a part list that is no list.
    expect(sourceRefusals(request, sourceAnswerOf(request, [null, planted]))).toEqual([
      sourceUnreadable("/parts/0"),
      sourceUnreadable("/parts/1"),
    ]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [], { parts: { 0: readablePartOf() } }))).toEqual([
      sourceUnreadable("/parts"),
    ]);

    // No refusal carries a value of the answer.
    const refusals = [
      ...sourceRefusals(request, { path: [planted], kind: planted, parts: [{ id: planted, label: planted }] }),
      ...sourceRefusals(request, sourceAnswerOf(request, [readablePartOf({ form: planted, [extra]: planted })])),
    ];
    const text = JSON.stringify(refusals) + new CallRefusalError(refusals).message;
    expect(text).not.toContain(planted);
    expect(callRefusalSentence(sourceUnreadable("/parts/0/text"))).toBe(
      'The source answer value at "/parts/0/text" is missing, an accessor, empty, longer than the SDK\'s bound, or not what the provider contract allows there for the request, so Studio did not read it.',
    );
    expect(callRefusalSentence(sourceUnreadable("/parts/0/text", "text"))).toBe(
      'The source answer has the key "text" at "/parts/0/text", which the provider contract does not define there, so Studio did not read it.',
    );
  });

  test("a source answer naming another path or kind than its request, no part, more parts than the SDK's bound, an empty text or a sentence past the character bound is refused, and a text past the bound is not", () => {
    const part = (): Record<string, unknown> => readablePartOf();
    const [first, , third] = request.path;

    // Another object than the request names: a segment, a shorter or longer path, or another kind.
    expect(sourceRefusals(request, sourceAnswerOf(request, [part()], { path: [first, "", marker()] }))).toEqual([
      sourceUnreadable("/path/2"),
    ]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [part()], { path: [first, ""] }))).toEqual([
      sourceUnreadable("/path"),
    ]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [part()], { path: [first, "", third, ""] }))).toEqual([
      sourceUnreadable("/path"),
    ]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [part()], { path: [first, 1, third] }))).toEqual([
      sourceUnreadable("/path/1"),
    ]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [part()], { kind: "view" }))).toEqual([
      sourceUnreadable("/kind"),
    ]);

    // No part, and one more part than the SDK's bound, refused at the list before any part is read.
    const reads = { count: 0 };
    expect(sourceRefusals(request, sourceAnswerOf(request, []))).toEqual([sourceUnreadable("/parts")]);
    expect(
      sourceRefusals(request, sourceAnswerOf(request, [], { parts: longList(SOURCE_PART_LIMIT + 1, reads) })),
    ).toEqual([sourceUnreadable("/parts")]);
    expect(reads.count).toBe(0);
    const most = Array.from({ length: SOURCE_PART_LIMIT }, () => part());
    expect(sourceRefusals(request, sourceAnswerOf(request, most))).toEqual([]);

    // An empty or whitespace text, an empty id, label or language, and an empty sentence of the engine's.
    for (const empty of ["", " \n\t "]) {
      expect(
        sourceRefusals(
          request,
          sourceAnswerOf(request, [
            readablePartOf({ id: empty, label: empty, text: empty, language: empty }),
            { id: marker(), label: marker(), unavailable: empty },
            readablePartOf({ truncated: { limit: 1, reason: empty }, edit: { offered: false, reason: empty } }),
          ]),
        ),
      ).toEqual([
        sourceUnreadable("/parts/0/id"),
        sourceUnreadable("/parts/0/label"),
        sourceUnreadable("/parts/0/text"),
        sourceUnreadable("/parts/0/language"),
        sourceUnreadable("/parts/1/unavailable"),
        sourceUnreadable("/parts/2/truncated/reason"),
        sourceUnreadable("/parts/2/edit/reason"),
      ]);
    }

    // A sentence past the character bound is refused, since no mark can state its cut; a text past it is not.
    const over = "x".repeat(SOURCE_CHARACTER_LIMIT + 1);
    const longest = "x".repeat(SOURCE_CHARACTER_LIMIT);
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [
          readablePartOf({ id: over, label: over, language: over, text: over }),
          { id: marker(), label: marker(), unavailable: over, statement: true },
          readablePartOf({ truncated: { limit: 1, reason: over }, edit: { offered: false, reason: over } }),
        ]),
      ),
    ).toEqual([
      sourceUnreadable("/parts/0/id"),
      sourceUnreadable("/parts/0/label"),
      sourceUnreadable("/parts/0/language"),
      sourceUnreadable("/parts/1/unavailable"),
      sourceUnreadable("/parts/2/truncated/reason"),
      sourceUnreadable("/parts/2/edit/reason"),
    ]);
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [readablePartOf({ id: longest, label: longest, text: over, truncated: undefined })]),
      ),
    ).toEqual([]);

    // A part id an earlier part holds is refused at the later id, whatever the parts' forms.
    const id = marker();
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [
          readablePartOf({ id }),
          { id: marker(), label: marker(), unavailable: marker() },
          { id, label: marker(), unavailable: marker(), statement: true },
          readablePartOf({ id }),
        ]),
      ),
    ).toEqual([sourceUnreadable("/parts/2/id"), sourceUnreadable("/parts/3/id")]);
  });

  test("a getter in a source answer is refused and never called, an optional member present with no value reads as absent, and a well-formed answer of each part form passes", () => {
    const reads = { count: 0 };
    const parts = [
      readablePartOf(),
      readablePartOf({ form: "partial", origin: "regenerated", truncated: undefined, edit: { offered: true } }),
      readablePartOf({ origin: "rendered", truncated: undefined, edit: undefined }),
      { id: marker(), label: marker(), unavailable: marker() },
      { id: marker(), label: marker(), unavailable: marker(), statement: true },
    ];
    const answer = sourceAnswerOf(request, parts);
    const check: AnswerCheck<unknown> = checkSourceAnswer(request, answer);
    expect(check).toEqual({ kind: "read", answer });
    expect(check.kind === "read" && check.answer).toBe(answer);
    const refused = checkSourceAnswer(request, sourceAnswerOf(request, []));
    expect(refused).toEqual({ kind: "refused", refusals: [sourceUnreadable("/parts")] });

    // A getter is refused at its pointer, never called: on the document, in its path, on a part, in a part's member.
    expect(sourceRefusals(request, withAccessor(sourceAnswerOf(request, [readablePartOf()]), "kind", reads))).toEqual([
      sourceUnreadable("/kind"),
    ]);
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [readablePartOf()], { path: withAccessor([...request.path], "1", reads, "") }),
      ),
    ).toEqual([sourceUnreadable("/path/1")]);
    expect(
      sourceRefusals(request, sourceAnswerOf(request, [], { parts: withAccessor([readablePartOf()], "0", reads, {}) })),
    ).toEqual([sourceUnreadable("/parts/0")]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [withAccessor(readablePartOf(), "text", reads)]))).toEqual([
      sourceUnreadable("/parts/0/text"),
    ]);
    // A getter for the sentence chooses the refused form, which then holds no text.
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [withAccessor({ id: marker(), label: marker() }, "unavailable", reads)]),
      ),
    ).toEqual([sourceUnreadable("/parts/0/unavailable")]);
    expect(reads.count).toBe(0);

    // A hole in the part list is refused once and ends the list.
    const holed: unknown[] = [readablePartOf()];
    holed[2] = readablePartOf();
    expect(sourceRefusals(request, sourceAnswerOf(request, [], { parts: holed }))).toEqual([
      sourceUnreadable("/parts/1"),
    ]);

    // An optional member present with no value reads as absent, a member of another form's included.
    expect(
      sourceRefusals(
        request,
        sourceAnswerOf(request, [
          readablePartOf({ truncated: undefined, edit: undefined, unavailable: undefined, statement: undefined }),
          { id: marker(), label: marker(), unavailable: marker(), statement: undefined, text: undefined },
        ]),
      ),
    ).toEqual([]);
    // A required member present with no value is still missing.
    expect(sourceRefusals(request, sourceAnswerOf(request, [readablePartOf({ text: undefined })]))).toEqual([
      sourceUnreadable("/parts/0/text"),
    ]);

    // A reading that throws is refused at the pointer being read, and the check never throws.
    expect(sourceRefusals(request, revoked())).toEqual([sourceUnreadable("")]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [revoked()]))).toEqual([sourceUnreadable("/parts/0")]);
    expect(sourceRefusals(request, sourceAnswerOf(request, [], { parts: onLengthRead([], thrower) }))).toEqual([
      sourceUnreadable("/parts"),
    ]);
    for (const length of nonCountLengths()) {
      expect(sourceRefusals(request, sourceAnswerOf(request, [], { parts: listOfLength(length(), reads) }))).toEqual([
        sourceUnreadable("/parts"),
      ]);
    }
    expect(reads.count).toBe(0);
  });
});

/** A refusal of `rule` at `pointer`, naming `name` where the answer has a key it cannot have. */
function refusalOf(rule: CallRefusalRule): (pointer: string, name?: string) => CallRefusal {
  return (pointer, name) => (name === undefined ? { rule, pointer } : { rule, pointer, name });
}

const panelUnreadable = refusalOf("panel-answer-unreadable");
const poolUnreadable = refusalOf("pool-stats-answer-unreadable");
const healthUnreadable = refusalOf("health-answer-unreadable");
const runUnreadable = refusalOf("maintenance-run-answer-unreadable");
const previewUnreadable = refusalOf("maintenance-preview-answer-unreadable");

/** The refusals of `check`, none where it read the answer. */
function refusalsOf(check: AnswerCheck<unknown>): readonly CallRefusal[] {
  return check.kind === "read" ? [] : check.refusals;
}

/** One request of each panel, the two lists bounded at `limit`. */
function panelRequestsOf(limit = 2): Readonly<Record<MonitoringPanelRequest["panel"], MonitoringPanelRequest>> {
  return {
    overview: { panel: "overview" },
    performance: { panel: "performance" },
    slowQueries: { panel: "slowQueries", limit },
    activeSessions: { panel: "activeSessions", limit },
    tables: { panel: "tables" },
    indexes: { panel: "indexes", schema: marker() },
    storage: { panel: "storage" },
  };
}

const overviewOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: marker(),
  uptime: marker(),
  startTime: new Date(1_700_000_000_000),
  activeConnections: 2,
  maxConnections: 100,
  databaseSize: marker(),
  databaseSizeBytes: 8_388_608,
  tableCount: 3,
  tableCountSampledFrom: marker(),
  indexCount: 4,
  ...over,
});
const slowQueryOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  queryId: marker(),
  query: marker(),
  calls: 7,
  totalTime: 12.5,
  avgTime: 1.75,
  minTime: 0,
  maxTime: 4.2,
  rows: 70,
  sharedBlksHit: 9,
  sharedBlksRead: 1,
  ...over,
});
const sessionOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pid: 4242,
  user: marker(),
  database: marker(),
  applicationName: marker(),
  clientAddr: marker(),
  state: marker(),
  activity: "idle-in-transaction",
  query: marker(),
  queryStart: new Date(1_700_000_000_000),
  duration: marker(),
  durationMs: 1500,
  waitEventType: marker(),
  waitEvent: marker(),
  blocked: false,
  terminable: true,
  ...over,
});
const tableOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaName: marker(),
  tableName: marker(),
  rowCount: 10,
  liveRowCount: 9,
  deadRowCount: 1,
  tableSize: marker(),
  tableSizeBytes: 8192,
  indexSize: marker(),
  indexSizeBytes: 16_384,
  totalSize: marker(),
  totalSizeBytes: 24_576,
  lastVacuum: new Date(1_700_000_000_000),
  lastAnalyze: new Date(1_700_000_000_000),
  bloatRatio: 0.25,
  ...over,
});
const indexOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaName: marker(),
  tableName: marker(),
  indexName: marker(),
  indexType: marker(),
  columns: [marker()],
  isUnique: true,
  isPrimary: false,
  indexSize: marker(),
  indexSizeBytes: 8192,
  scans: 3,
  usageRatio: 0.5,
  ...over,
});
const storageOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: marker(),
  location: marker(),
  size: marker(),
  sizeBytes: 8192,
  usagePercent: 12.5,
  walSize: marker(),
  walSizeBytes: 4096,
  ...over,
});

/** A well-formed answer of each panel, every optional member present. */
function panelAnswersOf(): Readonly<Record<MonitoringPanelRequest["panel"], Record<string, unknown>>> {
  return {
    overview: { overview: overviewOf() },
    performance: {
      performance: {
        cacheHitRatio: 99.5,
        cacheHitAdvice: marker(),
        transactionsPerSecond: 12.5,
        queriesPerSecond: 40,
        bufferPoolUsage: 80,
        deadlocks: 0,
        checkpointWriteTime: marker(),
      },
    },
    slowQueries: { slowQueries: [slowQueryOf(), slowQueryOf({ queryId: undefined })] },
    activeSessions: { activeSessions: [sessionOf(), sessionOf({ pid: marker() })] },
    tables: { tables: [tableOf()] },
    indexes: { indexes: [indexOf()] },
    storage: { storage: [storageOf()] },
  };
}

const poolOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  total: 4,
  idle: 2,
  active: 2,
  waiting: 0,
  max: 10,
  ...over,
});
const healthSessionOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pid: 4242,
  user: marker(),
  database: marker(),
  state: marker(),
  query: marker(),
  duration: marker(),
  ...over,
});
const healthOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  activeConnections: 3,
  databaseSize: marker(),
  cacheHitRatio: marker(),
  slowQueries: [{ query: marker(), calls: 2, avgTime: marker() }],
  activeSessions: [healthSessionOf()],
  ...over,
});
const runOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  success: true,
  executionTime: 12.5,
  message: marker(),
  rows: [{ a: 1, b: marker() }],
  fields: ["a", "b"],
  ...over,
});
const previewOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  summary: marker(),
  facts: [{ label: marker(), value: marker() }],
  refusal: marker(),
  note: marker(),
  ...over,
});

/** Each value that is no count: negative, a fraction, NaN, text and past the safe integers. */
const NON_COUNTS: readonly unknown[] = [-1, 1.5, Number.NaN, "3", 2 ** 53];

/** Each value that is no measure: negative, infinite, NaN and text. */
const NON_MEASURES: readonly unknown[] = [-1, Number.POSITIVE_INFINITY, Number.NaN, "1.5"];

describe("checkPanelAnswer, checkPoolStatsAnswer, checkHealthAnswer, checkMaintenanceRunAnswer and checkMaintenancePreviewAnswer", () => {
  test("a monitoring panel answer outside its panel's form, or a list past the request's limit, is refused as panel-answer-unreadable at its pointer, a key it cannot have named and no value carried", () => {
    const requests = panelRequestsOf();
    const panel = (request: MonitoringPanelRequest, answer: unknown) => refusalsOf(checkPanelAnswer(request, answer));

    // The answer holds exactly one key, its request's panel.
    for (const answer of [null, [], new Map(), marker(), 3]) {
      expect(panel(requests.overview, answer)).toEqual([panelUnreadable("")]);
    }
    expect(panel(requests.overview, { overview: overviewOf(), performance: {} })).toEqual([
      panelUnreadable("/performance", "performance"),
    ]);
    expect(panel(requests.overview, { performance: {} })).toEqual([
      panelUnreadable("/performance", "performance"),
      panelUnreadable("/overview"),
    ]);

    // Each member of its type: a required one missing, a key the form cannot have, and each value kind.
    const { maxConnections: _, ...noCeiling } = overviewOf();
    expect(panel(requests.overview, { overview: noCeiling })).toEqual([panelUnreadable("/overview/maxConnections")]);
    const planted = marker();
    expect(panel(requests.overview, { overview: overviewOf({ [planted]: marker() }) })).toEqual([
      panelUnreadable(`/overview/${planted}`, planted),
    ]);
    for (const value of NON_COUNTS) {
      expect(panel(requests.overview, { overview: overviewOf({ tableCount: value }) })).toEqual([
        panelUnreadable("/overview/tableCount"),
      ]);
      expect(panel(requests.performance, { performance: { deadlocks: value } })).toEqual([
        panelUnreadable("/performance/deadlocks"),
      ]);
    }
    for (const value of NON_MEASURES) {
      expect(panel(requests.performance, { performance: { cacheHitRatio: value } })).toEqual([
        panelUnreadable("/performance/cacheHitRatio"),
      ]);
      expect(panel(requests.tables, { tables: [tableOf({ bloatRatio: value })] })).toEqual([
        panelUnreadable("/tables/0/bloatRatio"),
      ]);
    }
    for (const value of [new Date(Number.NaN), new Date(0).toISOString(), 0]) {
      expect(panel(requests.overview, { overview: overviewOf({ startTime: value }) })).toEqual([
        panelUnreadable("/overview/startTime"),
      ]);
    }
    expect(panel(requests.activeSessions, { activeSessions: [sessionOf({ pid: true })] })).toEqual([
      panelUnreadable("/activeSessions/0/pid"),
    ]);
    expect(panel(requests.activeSessions, { activeSessions: [sessionOf({ activity: marker() })] })).toEqual([
      panelUnreadable("/activeSessions/0/activity"),
    ]);
    expect(panel(requests.indexes, { indexes: [indexOf({ columns: marker() })] })).toEqual([
      panelUnreadable("/indexes/0/columns"),
    ]);
    expect(panel(requests.storage, { storage: [storageOf({ sizeBytes: "8192" })] })).toEqual([
      panelUnreadable("/storage/0/sizeBytes"),
    ]);

    // A record that is not plain, and a list's hole, accessor and own key that is no index.
    expect(panel(requests.tables, { tables: [new Map()] })).toEqual([panelUnreadable("/tables/0")]);
    const sparse: unknown[] = new Array(2);
    sparse[1] = storageOf();
    expect(panel(requests.storage, { storage: sparse })).toEqual([panelUnreadable("/storage/0")]);
    const reads = { count: 0 };
    expect(panel(requests.tables, { tables: withAccessor([tableOf()], "0", reads, tableOf()) })).toEqual([
      panelUnreadable("/tables/0"),
    ]);
    expect(reads.count).toBe(0);
    expect(panel(requests.tables, { tables: Object.assign([tableOf()], { [planted]: 1 }) })).toEqual([
      panelUnreadable(`/tables/${planted}`, planted),
    ]);

    // The slow queries and the sessions are at most the request's limit long, refused at the list past it.
    expect(panel(requests.slowQueries, { slowQueries: [slowQueryOf(), slowQueryOf()] })).toEqual([]);
    expect(panel(requests.slowQueries, { slowQueries: [slowQueryOf(), slowQueryOf(), slowQueryOf()] })).toEqual([
      panelUnreadable("/slowQueries"),
    ]);
    expect(panel(requests.activeSessions, { activeSessions: [sessionOf(), sessionOf(), sessionOf()] })).toEqual([
      panelUnreadable("/activeSessions"),
    ]);

    // No refusal, and no sentence of one, carries a value of the answer.
    const value = marker();
    const refusals = panel(requests.overview, { overview: overviewOf({ version: 3, uptime: value, [value]: value }) });
    expect(JSON.stringify(refusals.filter((refusal) => refusal.name === undefined))).not.toContain(value);
    expect(refusals.map(callRefusalSentence)).toEqual([
      'The monitoring panel answer value at "/overview/version" is missing, an accessor, or not what the provider contract allows there for the request, so Studio did not read it.',
      `The monitoring panel answer has the key ${JSON.stringify(value)} at ${JSON.stringify(`/overview/${value}`)}, which the provider contract does not define there, so Studio did not read it.`,
    ]);
  });

  test("a pool statistics or health answer outside the SDK's types is refused by its rule at its pointer, a count held to a safe integer", () => {
    const pool = (answer: unknown) => refusalsOf(checkPoolStatsAnswer(answer));
    const health = (answer: unknown) => refusalsOf(checkHealthAnswer(answer));

    expect(pool(poolOf())).toEqual([]);
    const { waiting: _, ...noWaiting } = poolOf();
    expect(pool(noWaiting)).toEqual([poolUnreadable("/waiting")]);
    for (const value of NON_COUNTS) {
      expect(pool(poolOf({ total: value, max: value }))).toEqual([poolUnreadable("/total"), poolUnreadable("/max")]);
    }
    const planted = marker();
    expect(pool(poolOf({ [planted]: 1 }))).toEqual([poolUnreadable(`/${planted}`, planted)]);
    expect(pool([])).toEqual([poolUnreadable("")]);

    expect(health(healthOf())).toEqual([]);
    // Three keys beside the shared shape, each named.
    expect(health(healthOf({ uptime: marker(), description: marker(), roundTripMs: 3 }))).toEqual([
      healthUnreadable("/uptime", "uptime"),
      healthUnreadable("/description", "description"),
      healthUnreadable("/roundTripMs", "roundTripMs"),
    ]);
    const { slowQueries: __, ...noSlowQueries } = healthOf();
    expect(health(noSlowQueries)).toEqual([healthUnreadable("/slowQueries")]);
    for (const value of NON_COUNTS) {
      expect(health(healthOf({ activeConnections: value }))).toEqual([healthUnreadable("/activeConnections")]);
      expect(health(healthOf({ slowQueries: [{ query: marker(), calls: value, avgTime: marker() }] }))).toEqual([
        healthUnreadable("/slowQueries/0/calls"),
      ]);
    }
    const { user: ___, ...noUser } = healthSessionOf();
    expect(health(healthOf({ activeSessions: [noUser], databaseSize: 8 }))).toEqual([
      healthUnreadable("/databaseSize"),
      healthUnreadable("/activeSessions/0/user"),
    ]);
    expect(health(healthOf({ activeSessions: [healthSessionOf({ pid: null, durationMs: 3 })] }))).toEqual([
      healthUnreadable("/activeSessions/0/pid"),
      healthUnreadable("/activeSessions/0/durationMs", "durationMs"),
    ]);
  });

  test("a maintenance run answer whose rows have no fields, a key outside them or a value outside the value codec, and a preview outside its form, are refused by their rules", () => {
    const run = (answer: unknown) => refusalsOf(checkMaintenanceRunAnswer(answer));
    const preview = (answer: unknown) => refusalsOf(checkMaintenancePreviewAnswer(answer));

    expect(run(runOf())).toEqual([]);
    expect(run(runOf({ rows: undefined, fields: undefined }))).toEqual([]);
    const { rows: _, fields: __, ...bare } = runOf();
    expect(run(bare)).toEqual([]);
    // Every value of the codec's domain passes: a bigint, bytes, a valid date, a nested record, a non-finite number.
    const cells = {
      a: BigInt("9223372036854775808"),
      b: Uint8Array.of(1, 2),
      c: new Date(0),
      d: { $: marker(), v: [1, null] },
    };
    expect(run(runOf({ rows: [cells, { a: Number.NaN }], fields: ["a", "b", "c", "d"] }))).toEqual([]);

    // Rows need their fields, and every row key is one of them.
    expect(run(runOf({ fields: undefined }))).toEqual([runUnreadable("/fields")]);
    const planted = marker();
    expect(run(runOf({ rows: [{ a: 1, [planted]: 2 }] }))).toEqual([runUnreadable(`/rows/0/${planted}`, planted)]);
    // A cell outside the value codec's domain.
    expect(run(runOf({ rows: [{ a: () => 1, b: new Map() }, { a: Symbol(planted) }] }))).toEqual([
      runUnreadable("/rows/0/a"),
      runUnreadable("/rows/0/b"),
      runUnreadable("/rows/1/a"),
    ]);
    expect(run(runOf({ rows: [new Map()], fields: [3] }))).toEqual([
      runUnreadable("/fields/0"),
      runUnreadable("/rows/0"),
    ]);
    for (const value of NON_MEASURES) {
      expect(run(runOf({ executionTime: value, success: "true" }))).toEqual([
        runUnreadable("/success"),
        runUnreadable("/executionTime"),
      ]);
    }
    expect(run(runOf({ [planted]: 1 }))).toEqual([runUnreadable(`/${planted}`, planted)]);

    expect(preview(previewOf())).toEqual([]);
    expect(preview(previewOf({ facts: [] }))).toEqual([]);
    expect(preview(previewOf({ facts: [{ label: marker() }], refusal: 3 }))).toEqual([
      previewUnreadable("/facts/0/value"),
      previewUnreadable("/refusal"),
    ]);
    expect(preview(previewOf({ facts: { label: marker(), value: marker() } }))).toEqual([previewUnreadable("/facts")]);
    expect(preview(previewOf({ facts: [{ label: marker(), value: marker(), [planted]: 1 }] }))).toEqual([
      previewUnreadable(`/facts/0/${planted}`, planted),
    ]);
    const sentences = [...run(runOf({ fields: undefined })), ...preview(previewOf({ [planted]: 1 }))].map(
      callRefusalSentence,
    );
    expect(sentences).toEqual([
      'The maintenance run answer value at "/fields" is missing, an accessor, or not what the provider contract allows there for the request, so Studio did not read it.',
      `The maintenance preview answer has the key ${JSON.stringify(planted)} at ${JSON.stringify(`/${planted}`)}, which the provider contract does not define there, so Studio did not read it.`,
    ]);
  });

  test("a getter in any of the five answers is refused and never called, an optional member present with no value reads as absent, and an inherited key name does not throw", () => {
    const reads = { count: 0 };
    const requests = panelRequestsOf();
    const panel = (request: MonitoringPanelRequest, answer: unknown) => refusalsOf(checkPanelAnswer(request, answer));

    expect(panel(requests.overview, { overview: withAccessor(overviewOf(), "version", reads) })).toEqual([
      panelUnreadable("/overview/version"),
    ]);
    expect(panel(requests.overview, withAccessor({}, "overview", reads, overviewOf()))).toEqual([
      panelUnreadable("/overview"),
    ]);
    expect(refusalsOf(checkPoolStatsAnswer(withAccessor(poolOf(), "total", reads, 1)))).toEqual([
      poolUnreadable("/total"),
    ]);
    expect(refusalsOf(checkHealthAnswer(healthOf({ slowQueries: withAccessor([], "0", reads) })))).toEqual([
      healthUnreadable("/slowQueries/0"),
    ]);
    expect(refusalsOf(checkMaintenanceRunAnswer(runOf({ rows: [withAccessor({}, "a", reads, 1)] })))).toEqual([
      runUnreadable("/rows/0/a"),
    ]);
    expect(refusalsOf(checkMaintenancePreviewAnswer(withAccessor(previewOf(), "summary", reads)))).toEqual([
      previewUnreadable("/summary"),
    ]);
    expect(reads.count).toBe(0);

    // An optional member present with no value reads as absent in each answer.
    const answers = panelAnswersOf();
    for (const [name, request] of Object.entries(requests)) {
      expect(panel(request, answers[name as MonitoringPanelRequest["panel"]])).toEqual([]);
    }
    expect(
      panel(requests.overview, { overview: overviewOf({ startTime: undefined, activeConnections: undefined }) }),
    ).toEqual([]);
    expect(panel(requests.performance, { performance: { cacheHitRatio: undefined } })).toEqual([]);
    expect(
      panel(requests.activeSessions, {
        activeSessions: [sessionOf({ queryStart: undefined, applicationName: undefined, activity: undefined })],
      }),
    ).toEqual([]);
    expect(panel(requests.tables, { tables: [tableOf({ lastVacuum: undefined, rowCount: undefined })] })).toEqual([]);
    expect(refusalsOf(checkPoolStatsAnswer(poolOf({ max: undefined })))).toEqual([]);
    expect(refusalsOf(checkHealthAnswer(healthOf({ activeConnections: undefined })))).toEqual([]);
    expect(refusalsOf(checkMaintenancePreviewAnswer(previewOf({ refusal: undefined, note: undefined })))).toEqual([]);
    // A required member present with no value is missing.
    expect(refusalsOf(checkPoolStatsAnswer(poolOf({ total: undefined })))).toEqual([poolUnreadable("/total")]);

    // An inherited key name is a key like any other, named, and a record with no prototype is plain.
    const inherited: object = Object.assign(JSON.parse('{"__proto__": 1}'), { constructor: 1, toString: 1 });
    expect(refusalsOf(checkPoolStatsAnswer(Object.assign(inherited, poolOf())))).toEqual([
      poolUnreadable("/__proto__", "__proto__"),
      poolUnreadable("/constructor", "constructor"),
      poolUnreadable("/toString", "toString"),
    ]);
    expect(refusalsOf(checkHealthAnswer(Object.assign(Object.create(null), healthOf())))).toEqual([]);

    // A reading that throws is refused at the pointer being read, and no check throws.
    expect(refusalsOf(checkHealthAnswer(revoked()))).toEqual([healthUnreadable("")]);
    expect(refusalsOf(checkMaintenanceRunAnswer(runOf({ rows: [revoked()] })))).toEqual([runUnreadable("/rows/0")]);
    expect(panel(requests.overview, { overview: overviewOf({ startTime: revoked() }) })).toEqual([
      panelUnreadable("/overview/startTime"),
    ]);
    const well = poolOf();
    const read: AnswerCheck<unknown> = checkPoolStatsAnswer(well);
    expect(read.kind === "read" && read.answer).toBe(well);
    expect(Object.keys(checkPoolStatsAnswer(noThrow()))).toEqual(["kind", "refusals"]);
  });
});

/** A record whose own keys answer a trap that throws: the check refuses it rather than throwing. */
function noThrow(): object {
  return new Proxy({}, { ownKeys: thrower });
}
