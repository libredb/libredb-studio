/**
 * Firestore answers into grid rows (spec 5.6): the response array, documents, column order and the column cap,
 * column types, vector columns, aggregations, listings, document reads and the explain row, including wide, mixed
 * and vector-varying collections.
 */
import { describe, expect, test } from "bun:test";
import { RESULT_SENTENCES, readQueryStream, shapeResult } from "@/lib/db/providers/document/firestore/results";
import { decodeValue } from "@/lib/db/providers/document/firestore/values";
import { DOCUMENTS, full, refusal, TARGET } from "../../../helpers/firestore-console";

const TIME = "2026-10-12T00:00:00Z";
const doc = (path: string, fields: Record<string, unknown> = {}) => ({
  name: full(path),
  fields,
  createTime: TIME,
  updateTime: TIME,
});
const int = (value: number) => ({ integerValue: String(value) });
const str = (value: string) => ({ stringValue: value });
const vec = (...values: number[]) => ({
  mapValue: {
    fields: {
      __type__: { stringValue: "__vector__" },
      value: { arrayValue: { values: values.map((value) => ({ doubleValue: value })) } },
    },
  },
});
const documents = (json: unknown, select?: string[][]) =>
  shapeResult(json, select === undefined ? { kind: "documents" } : { kind: "documents", select }, TARGET);
const refusedWith = (run: () => unknown, sentence: string): void => {
  expect(refusal(run).message).toBe(sentence);
};

describe("the REST response array", () => {
  test("elements without a document carry readTime, skippedResults or explainMetrics only", () => {
    const empty = readQueryStream([{ readTime: TIME }]);
    expect(empty).toEqual({ documents: [], aggregates: [], skippedResults: 0 });
    expect("explainMetrics" in empty).toBe(false);
    const stream = readQueryStream([
      { skippedResults: 3, readTime: TIME },
      { document: doc("users/a"), readTime: TIME },
      { document: doc("users/b") },
      { explainMetrics: { planSummary: { indexesUsed: [] } }, done: true },
    ]);
    expect(stream.documents.map((document) => document.name)).toEqual([full("users/a"), full("users/b")]);
    expect(stream.skippedResults).toBe(3);
    expect(stream.explainMetrics).toEqual({ planSummary: { indexesUsed: [] } });
  });

  test("aggregation results are read from their aggregateFields", () => {
    expect(
      readQueryStream([{ result: { aggregateFields: { aggregate_0: int(3) } }, readTime: TIME }]).aggregates,
    ).toEqual([{ aggregate_0: int(3) }]);
    expect(readQueryStream([{ result: {} }]).aggregates).toEqual([{}]);
  });

  test("a malformed answer is an explicit error", () => {
    refusedWith(() => readQueryStream({}), RESULT_SENTENCES.notList);
    refusedWith(() => readQueryStream([5]), RESULT_SENTENCES.notList);
    refusedWith(() => readQueryStream([{ document: { fields: {} } }]), RESULT_SENTENCES.malformed("a document"));
    refusedWith(() => readQueryStream([{ result: 5 }]), RESULT_SENTENCES.malformed("an aggregation result"));
  });
});

describe("documents", () => {
  test("__name__ comes first, relative to the database, and cells are decoded", () => {
    const shaped = documents([{ document: doc("users/alice", { age: int(30), name: str("Alice") }), readTime: TIME }]);
    expect(shaped).toEqual({
      rows: [{ __name__: "users/alice", age: decodeValue(int(30), TARGET), name: "Alice" }],
      fields: ["__name__", "age", "name"],
      columnTypes: { __name__: "string", age: "integer", name: "string" },
      warnings: [],
    });
  });

  test("without select, the columns are every top-level field sorted by UTF-8 bytes", () => {
    const shaped = documents([
      { document: doc("c/1", { "\uff5e": str("x"), 𠀀: str("x"), b: str("x") }) },
      { document: doc("c/2", { a: str("x"), é: str("x"), z: str("x") }) },
    ]);
    expect(shaped.fields).toEqual(["__name__", "a", "b", "z", "é", "\uff5e", "𠀀"]);
    expect(shaped.rows[0]).not.toHaveProperty("a");
  });

  test("with select, the columns follow select() order and a dotted path is read from the nested map", () => {
    const shaped = documents(
      [
        { document: doc("c/1", { a: { mapValue: { fields: { c: int(1) } } }, b: str("x") }) },
        { document: doc("c/2", { a: str("not a map") }) },
      ],
      [["b"], ["a", "c"], ["__name__"], ["b"]],
    );
    expect(shaped.fields).toEqual(["__name__", "b", "a.c"]);
    expect(shaped.rows).toEqual([{ __name__: "c/1", b: "x", "a.c": decodeValue(int(1), TARGET) }, { __name__: "c/2" }]);
    expect(shaped.columnTypes).toEqual({ __name__: "string", b: "string", "a.c": "integer" });
    expect(documents([{ document: doc("c/1", { a: str("x") }) }], []).fields).toEqual(["__name__"]);
  });

  test("a column whose values disagree is typed mixed(a|b), its types sorted", () => {
    const shaped = documents([
      { document: doc("c/1", { x: int(1), y: int(1) }) },
      { document: doc("c/2", { x: str("a"), y: int(2) }) },
      { document: doc("c/3", { x: { nullValue: null }, y: int(3) }) },
    ]);
    expect(shaped.columnTypes).toEqual({ __name__: "string", x: "mixed(integer|null|string)", y: "integer" });
  });

  test("a column of one-dimension vectors is a dense float64 vector column", () => {
    const shaped = documents([
      { document: doc("c/1", { e: vec(1, 2, 3) }) },
      { document: doc("c/2", { e: vec(4, 5, 6) }) },
    ]);
    expect(shaped.vectorColumns).toEqual({ e: { kind: "dense", dtype: "float64", dimension: 3 } });
    expect(shaped.columnTypes?.e).toBe("vector");
  });

  test("a document named outside this connection's database is refused", () => {
    const foreign = "projects/other-project/databases/(default)/documents/users/a";
    refusedWith(() => documents([{ document: { name: foreign, fields: {} } }]), RESULT_SENTENCES.foreignName(foreign));
  });

  test("a name inside the database that is not a document is refused: the bare documents root and a collection", () => {
    for (const name of [DOCUMENTS, full("users"), full("users/a/orders")]) {
      refusedWith(() => documents([{ document: { name, fields: {} } }]), RESULT_SENTENCES.notDocument(name));
    }
    expect(RESULT_SENTENCES.notDocument(full("users"))).toBe(
      `Firestore answered with a name that is not a document: ${full("users")}`,
    );
  });
});

describe("a wide, mixed, vector-varying collection", () => {
  test("the columns stop at 500 with a warning, types read mixed, and only one-dimension vectors are declared", () => {
    const first: Record<string, unknown> = { e: vec(1, 2, 3), f: vec(1, 2), g: vec(1), m: int(1) };
    const second: Record<string, unknown> = { e: vec(4, 5, 6), f: vec(1, 2, 3), g: str("x"), m: { doubleValue: 1.5 } };
    for (let index = 0; index < 1_000; index++) {
      first[`w${String(index).padStart(4, "0")}`] = str("x");
      second[`w${String(index + 1_000).padStart(4, "0")}`] = int(index);
    }
    const shaped = documents([{ document: doc("c/1", first) }, { document: doc("c/2", second) }]);
    expect(shaped.fields).toHaveLength(500);
    expect(shaped.fields.slice(0, 6)).toEqual(["__name__", "e", "f", "g", "m", "w0000"]);
    expect(shaped.fields[499]).toBe("w0494");
    expect(shaped.warnings).toEqual([RESULT_SENTENCES.columnCap(2_005)]);
    expect(shaped.columnTypes).toMatchObject({
      e: "vector",
      f: "vector",
      g: "mixed(string|vector)",
      m: "mixed(double|integer)",
    });
    expect(shaped.vectorColumns).toEqual({ e: { kind: "dense", dtype: "float64", dimension: 3 } });
    expect(shaped.rows[1]).not.toHaveProperty("w0000");
  });
});

describe("aggregations", () => {
  test("one row keyed by the user's keys", () => {
    const shaped = shapeResult(
      [{ result: { aggregateFields: { aggregate_0: int(7), aggregate_1: { doubleValue: 2.5 } } }, readTime: TIME }],
      {
        kind: "aggregation",
        keys: [
          { wire: "aggregate_0", user: "count" },
          { wire: "aggregate_1", user: "avg price" },
        ],
      },
      TARGET,
    );
    expect(shaped).toEqual({
      rows: [{ count: decodeValue(int(7), TARGET), "avg price": 2.5 }],
      fields: ["count", "avg price"],
      columnTypes: { count: "integer", "avg price": "double" },
      warnings: [],
    });
  });

  test("an answer without exactly one result is refused", () => {
    refusedWith(
      () =>
        shapeResult(
          [{ readTime: TIME }],
          { kind: "aggregation", keys: [{ wire: "aggregate_0", user: "count" }] },
          TARGET,
        ),
      RESULT_SENTENCES.aggregationCount(0),
    );
  });
});

describe("listings", () => {
  test("collection ids are filtered by the id rules, sorted by UTF-8 bytes and given their paths", () => {
    const shaped = shapeResult(
      { collectionIds: ["b", "a", "é", "z", "a/b", ""] },
      { kind: "collectionIds", parent: ["users", "alice"] },
      TARGET,
    );
    expect(shaped).toEqual({
      rows: [
        { id: "a", path: "users/alice/a" },
        { id: "b", path: "users/alice/b" },
        { id: "z", path: "users/alice/z" },
        { id: "é", path: "users/alice/é" },
      ],
      fields: ["id", "path"],
      columnTypes: { id: "string", path: "string" },
      warnings: [RESULT_SENTENCES.droppedIds(2)],
    });
    expect(
      shapeResult({ collectionIds: ["a"], nextPageToken: "t" }, { kind: "collectionIds", parent: [] }, TARGET),
    ).toMatchObject({
      rows: [{ id: "a", path: "a" }],
      warnings: [RESULT_SENTENCES.idCap],
    });
    expect(
      shapeResult({ collectionIds: ["b", "a", "b", "a/b", "a/b"] }, { kind: "collectionIds", parent: [] }, TARGET),
    ).toMatchObject({
      rows: [
        { id: "a", path: "a" },
        { id: "b", path: "b" },
      ],
      warnings: [RESULT_SENTENCES.droppedIds(1)],
    });
    expect(shapeResult({}, { kind: "collectionIds", parent: [] }, TARGET).rows).toEqual([]);
    refusedWith(
      () => shapeResult(5, { kind: "collectionIds", parent: [] }, TARGET),
      RESULT_SENTENCES.malformed("a collection listing"),
    );
    refusedWith(
      () => shapeResult({ collectionIds: [1] }, { kind: "collectionIds", parent: [] }, TARGET),
      RESULT_SENTENCES.malformed("a collection listing"),
    );
  });

  test("document names carry exists from createTime, and more pages add a warning", () => {
    const shaped = shapeResult(
      { documents: [doc("users/a"), { name: full("users/b") }], nextPageToken: "x" },
      { kind: "documentNames" },
      TARGET,
    );
    expect(shaped).toEqual({
      rows: [
        { __name__: "users/a", exists: true },
        { __name__: "users/b", exists: false },
      ],
      fields: ["__name__", "exists"],
      columnTypes: { __name__: "string", exists: "boolean" },
      warnings: [RESULT_SENTENCES.moreDocuments],
    });
    expect(shapeResult({}, { kind: "documentNames" }, TARGET)).toMatchObject({ rows: [], warnings: [] });
    refusedWith(
      () => shapeResult({ documents: 5 }, { kind: "documentNames" }, TARGET),
      RESULT_SENTENCES.malformed("a document listing"),
    );
    refusedWith(
      () => shapeResult(5, { kind: "documentNames" }, TARGET),
      RESULT_SENTENCES.malformed("a document listing"),
    );
  });
});

describe("document reads", () => {
  test("a found document is one row; a missing one is no rows and a warning", () => {
    expect(
      shapeResult([{ found: doc("users/a", { n: int(1) }), readTime: TIME }], { kind: "document" }, TARGET),
    ).toMatchObject({
      rows: [{ __name__: "users/a", n: decodeValue(int(1), TARGET) }],
      fields: ["__name__", "n"],
    });
    expect(shapeResult([{ missing: full("users/x"), readTime: TIME }], { kind: "document" }, TARGET)).toEqual({
      rows: [],
      fields: ["__name__"],
      columnTypes: { __name__: "string" },
      warnings: [RESULT_SENTENCES.missingDocument("users/x")],
    });
    for (const answer of [[], [{ other: 1 }], {}]) {
      refusedWith(
        () => shapeResult(answer, { kind: "document" }, TARGET),
        RESULT_SENTENCES.malformed("a document read"),
      );
    }
  });

  test("getAll answers the found documents in request order, duplicates included, and names the missing ones", () => {
    const shaped = shapeResult(
      [
        { found: doc("users/a", { n: int(1) }) },
        { found: doc("users/b", { n: int(2) }) },
        { missing: full("users/x") },
      ],
      { kind: "getAll", order: ["users/b", "users/a", "users/x", "users/b"] },
      TARGET,
    );
    expect(shaped.rows.map((row) => row.__name__)).toEqual(["users/b", "users/a", "users/b"]);
    expect(shaped.warnings).toEqual([RESULT_SENTENCES.missingDocuments(["users/x"])]);
    const many = Array.from({ length: 25 }, (_, index) => `users/m${index}`);
    expect(RESULT_SENTENCES.missingDocuments(many)).toBe(`Not found: ${many.slice(0, 20).join(", ")}, and 5 more`);
    expect(shapeResult([{ found: doc("users/a") }], { kind: "getAll", order: ["users/a"] }, TARGET).warnings).toEqual(
      [],
    );
  });
});

describe("explain", () => {
  test("one row of indexesUsed and executionStats, with the returned count in a warning", () => {
    const metrics = {
      planSummary: { indexesUsed: [{ query_scope: "Collection", properties: "(__name__ ASC)" }] },
      executionStats: { resultsReturned: "1", executionDuration: "0.01s" },
    };
    expect(
      shapeResult(
        [{ document: doc("users/a") }, { explainMetrics: metrics }],
        { kind: "explain", analyze: true },
        TARGET,
      ),
    ).toEqual({
      rows: [{ indexesUsed: metrics.planSummary.indexesUsed, executionStats: metrics.executionStats }],
      fields: ["indexesUsed", "executionStats"],
      warnings: [RESULT_SENTENCES.explainReturned(1)],
    });
    expect(shapeResult([{ explainMetrics: {} }], { kind: "explain", analyze: false }, TARGET)).toMatchObject({
      rows: [{ indexesUsed: [], executionStats: null }],
      warnings: [RESULT_SENTENCES.explainReturned(0)],
    });
    refusedWith(
      () => shapeResult([{ readTime: TIME }], { kind: "explain", analyze: false }, TARGET),
      RESULT_SENTENCES.noPlan,
    );
  });
});
