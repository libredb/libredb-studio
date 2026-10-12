/**
 * Each statement kind as one request of the closed table (spec 5.4, S1): queries, aggregations with wire aliases,
 * vector queries, explain, document gets, listings and getAll, the explain button's rules (spec 5.7), and the
 * colon refusal with reserved characters elsewhere passing through exactly.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPILE_SENTENCES,
  COMPILE_WARNINGS,
  compileStatement,
} from "@/lib/db/providers/document/firestore/console/compile";
import { parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import { LIMITS } from "@/lib/db/providers/document/firestore/constants";
import { buildRequest } from "@/lib/db/providers/document/firestore/requests";
import { full, refusal, TARGET } from "../../../helpers/firestore-console";

const compile = (text: string, explainButton = false) =>
  compileStatement(parseStatement(text), text, { target: TARGET, explainButton });
const refused = (text: string, sentence: string, position: number, explainButton = false): void => {
  const error = refusal(() => compile(text, explainButton));
  expect(error.message.startsWith(sentence)).toBe(true);
  expect(error.position).toBe(position);
};
const NEAREST =
  'db.collection("docs").where("lang", "==", "en").findNearest({ vectorField: "embedding", queryVector: [1, 2], limit: 10, distanceMeasure: "COSINE", distanceResultField: "dist", distanceThreshold: 0 })';

describe("queries", () => {
  test("a collection query is one runQuery under its parent, with the documents shape", () => {
    expect(compile('db.collection("users")')).toEqual({
      request: {
        kind: "runQuery",
        parent: [],
        body: { structuredQuery: { from: [{ collectionId: "users" }], limit: 100 } },
      },
      shape: { kind: "documents" },
      warnings: [COMPILE_WARNINGS.defaultLimit],
    });
    expect(compile('db.collection("users/alice/orders").limit(1)').request).toMatchObject({
      parent: ["users", "alice"],
    });
    expect(compile('db.collection("users").select("a.b", "c").limit(5)').shape).toEqual({
      kind: "documents",
      select: [["a", "b"], ["c"]],
    });
  });
});

describe("aggregations", () => {
  test("count() answers under count, sent as aggregate_0, with no limit and the cost warning", () => {
    expect(compile('db.collection("users").count()')).toEqual({
      request: {
        kind: "runAggregationQuery",
        parent: [],
        body: {
          structuredAggregationQuery: {
            structuredQuery: { from: [{ collectionId: "users" }] },
            aggregations: [{ alias: "aggregate_0", count: {} }],
          },
        },
      },
      shape: { kind: "aggregation", keys: [{ wire: "aggregate_0", user: "count" }] },
      warnings: [COMPILE_WARNINGS.aggregationCost],
    });
  });

  test("aggregate() sends sum and avg under wire aliases and maps them back to any user key", () => {
    const compiled = compile(
      'db.collection("orders").where("paid", "==", true).aggregate({ total: AggregateField.sum("price"), "avg price": AggregateField.average("price"), n: AggregateField.count() })',
    );
    expect(compiled.request).toMatchObject({
      kind: "runAggregationQuery",
      body: {
        structuredAggregationQuery: {
          aggregations: [
            { alias: "aggregate_0", sum: { field: { fieldPath: "price" } } },
            { alias: "aggregate_1", avg: { field: { fieldPath: "price" } } },
            { alias: "aggregate_2", count: {} },
          ],
        },
      },
    });
    expect(compiled.shape).toEqual({
      kind: "aggregation",
      keys: [
        { wire: "aggregate_0", user: "total" },
        { wire: "aggregate_1", user: "avg price" },
        { wire: "aggregate_2", user: "n" },
      ],
    });
  });

  test("the inner query keeps the user's limit, offset and filters", () => {
    expect(compile('db.collection("users").limit(5000).count()').request).toMatchObject({
      body: { structuredAggregationQuery: { structuredQuery: { limit: 5000 } } },
    });
    expect(compile('db.collection("users").offset(5).count()').warnings).toEqual([
      COMPILE_WARNINGS.offsetBilling,
      COMPILE_WARNINGS.aggregationCost,
    ]);
  });

  test("a statement takes 1 to 5 aggregations", () => {
    refused('db.collection("orders").aggregate({})', COMPILE_SENTENCES.aggregations, 14);
    const six =
      'db.collection("o").aggregate({ a: AggregateField.count(), b: AggregateField.count(), c: AggregateField.count(), d: AggregateField.count(), e: AggregateField.count(), f: AggregateField.count() })';
    refused(six, COMPILE_SENTENCES.aggregations, six.indexOf("f:"));
  });
});

describe("vector queries", () => {
  test("findNearest sends every option, a threshold of 0 included, with double elements and no default limit", () => {
    const compiled = compile(NEAREST);
    expect(compiled.request).toMatchObject({ kind: "runQuery", parent: [] });
    const body =
      compiled.request.kind === "runQuery" ? (compiled.request.body.structuredQuery as Record<string, unknown>) : {};
    expect(body.findNearest).toEqual({
      vectorField: { fieldPath: "embedding" },
      queryVector: {
        mapValue: {
          fields: {
            __type__: { stringValue: "__vector__" },
            value: { arrayValue: { values: [{ doubleValue: 1 }, { doubleValue: 2 }] } },
          },
        },
      },
      distanceMeasure: "COSINE",
      limit: 10,
      distanceResultField: "dist",
      distanceThreshold: 0,
    });
    expect("limit" in body).toBe(false);
    expect(compiled.warnings).toEqual([]);
    expect(compiled.shape).toEqual({ kind: "documents" });
  });

  test("the nearest limit is 1 to 1,000 and the query vector 1 to 2,048 numbers", () => {
    const nearest = (options: string): string =>
      `db.collection("docs").findNearest({ vectorField: "e", distanceMeasure: "EUCLIDEAN", ${options} })`;
    refused(nearest("queryVector: [1], limit: 0"), COMPILE_SENTENCES.nearestLimit, 22);
    refused(nearest("queryVector: [1], limit: 1001"), COMPILE_SENTENCES.nearestLimit, 22);
    refused(nearest("queryVector: [], limit: 5"), COMPILE_SENTENCES.nearestVector, 22);
    refused(nearest("queryVector: FieldValue.vector([]), limit: 5"), COMPILE_SENTENCES.nearestVector, 22);
    expect(compile(nearest("queryVector: [1], limit: 1000")).warnings).toEqual([]);
  });
});

describe("explain", () => {
  test("explain() adds explainOptions beside the query and answers the explain shape", () => {
    expect(compile('db.collection("users").explain()')).toEqual({
      request: {
        kind: "runQuery",
        parent: [],
        body: {
          structuredQuery: { from: [{ collectionId: "users" }], limit: 100 },
          explainOptions: { analyze: false },
        },
      },
      shape: { kind: "explain", analyze: false },
      warnings: [COMPILE_WARNINGS.defaultLimit],
    });
    expect(compile('db.collection("users").explain({ analyze: true })').shape).toEqual({
      kind: "explain",
      analyze: true,
    });
    expect(compile('db.collection("users").count().explain()')).toMatchObject({
      request: { kind: "runAggregationQuery", body: { explainOptions: { analyze: false } } },
      shape: { kind: "explain", analyze: false },
    });
  });

  test("the Explain button plans a query, a vector query or an aggregation, plan-only", () => {
    expect(compile('db.collection("users").limit(5)', true)).toMatchObject({
      request: { kind: "runQuery", body: { explainOptions: { analyze: false } } },
      shape: { kind: "explain", analyze: false },
    });
    expect(compile('db.collection("users").count()', true).request).toMatchObject({
      kind: "runAggregationQuery",
      body: { explainOptions: { analyze: false } },
    });
    expect(compile(NEAREST, true).shape).toEqual({ kind: "explain", analyze: false });
  });

  test.each([
    ['db.doc("users/a")', "a document read"],
    ["db.listCollections()", "a collection listing"],
    ['db.collection("users").listDocuments()', "a document listing"],
    ['db.getAll(db.doc("users/a"))', "getAll()"],
  ])("the Explain button refuses %j", (text, noun) => {
    refused(text, COMPILE_SENTENCES.explainKind(noun), 0, true);
  });

  test("the Explain button refuses a statement that calls explain() itself", () => {
    refused('db.collection("users").explain()', COMPILE_SENTENCES.explainOwn, 23, true);
    refused('db.collection("users").count().explain()', COMPILE_SENTENCES.explainOwn, 31, true);
    refused(`${NEAREST}.explain()`, COMPILE_SENTENCES.explainOwn, NEAREST.length + 1, true);
  });
});

describe("documents and listings", () => {
  test("a document get is a one-name batchGet, so a missing document answers without an error", () => {
    expect(compile('db.doc("users/alice")')).toEqual({
      request: { kind: "batchGet", body: { documents: [full("users/alice")] } },
      shape: { kind: "document" },
      warnings: [],
    });
  });

  test("listCollections() lists ids at the root or under a document, one page of 1,000 at a time", () => {
    expect(compile("db.listCollections()")).toEqual({
      request: { kind: "listCollectionIds", parent: [], pageSize: LIMITS.idListingPageSize },
      shape: { kind: "collectionIds", parent: [] },
      warnings: [],
    });
    expect(compile('db.doc("users/alice").listCollections()').request).toMatchObject({ parent: ["users", "alice"] });
  });

  test("listDocuments() reads an unmasked page of 50 with missing parents, since no mask is names-only with showMissing", () => {
    expect(compile('db.collection("users/alice/orders").listDocuments()')).toEqual({
      request: {
        kind: "listDocuments",
        parent: ["users", "alice"],
        collectionId: "orders",
        pageSize: LIMITS.collectionPageSizeUnmasked,
        showMissing: true,
      },
      shape: { kind: "documentNames" },
      warnings: [],
    });
  });

  test("getAll() sends each document once and answers in request order", () => {
    expect(compile('db.getAll(db.doc("users/a"), db.doc("users/b"), db.doc("users/a"))')).toEqual({
      request: { kind: "batchGet", body: { documents: [full("users/a"), full("users/b")] } },
      shape: { kind: "getAll", order: ["users/a", "users/b", "users/a"] },
      warnings: [],
    });
  });
});

describe("the colon parent and reserved characters", () => {
  test("a verb under a document whose id holds a colon is refused with its sentence", () => {
    refused('db.collection("users/a:b/orders")', COMPILE_SENTENCES.colonQuery("a:b", "orders"), 14);
    refused('db.doc("users/a:b").collection("orders").count()', COMPILE_SENTENCES.colonQuery("a:b", "orders"), 31);
    refused('db.doc("users/a:b").listCollections()', COMPILE_SENTENCES.colonList("a:b"), 20);
  });

  test("a document whose id holds a colon or other reserved characters is still read, its name exact", () => {
    expect(compile('db.doc("users/a:b").get()').request).toEqual({
      kind: "batchGet",
      body: { documents: [full("users/a:b")] },
    });
    const id = "a b%#?`é𠀀";
    expect(compile(`db.doc("users/${id}")`).request).toEqual({
      kind: "batchGet",
      body: { documents: [full(`users/${id}`)] },
    });
    expect(
      compile(`db.collection("users").where(FieldPath.documentId(), "==", "${id}").limit(1)`).request,
    ).toMatchObject({
      body: { structuredQuery: { where: { fieldFilter: { value: { referenceValue: full(`users/${id}`) } } } } },
    });
  });
});

describe("the time-zone rule (spec 9)", () => {
  test("a date-only timestamp is encoded to the same instant under two server time zones", () => {
    const before = process.env.TZ;
    const text = 'db.collection("c").where("t", "==", Timestamp.fromDate(new Date("2026-10-12")))';
    const offsets: number[] = [];
    const values: unknown[] = [];
    try {
      for (const zone of ["America/Los_Angeles", "Asia/Kolkata"]) {
        process.env.TZ = zone;
        offsets.push(new Date(2026, 9, 12).getTimezoneOffset());
        values.push(compile(text).request);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
    expect(offsets[0]).not.toBe(offsets[1]);
    expect(values[0]).toMatchObject({
      body: { structuredQuery: { where: { fieldFilter: { value: { timestampValue: "2026-10-12T00:00:00Z" } } } } },
    });
    expect(values[1]).toEqual(values[0]);
  });
});

describe("the closed table", () => {
  test.each([
    'db.collection("users")',
    'db.collection("users/alice/orders").where("a", "==", 1).orderBy("a").startAt(1).limit(5)',
    'db.collectionGroup("orders").select()',
    'db.collection("users").count()',
    'db.collection("users").explain()',
    NEAREST,
    'db.doc("users/alice")',
    "db.listCollections()",
    'db.doc("users/alice").listCollections()',
    'db.collection("users").listDocuments()',
    'db.getAll(db.doc("users/a"), db.doc("users/a"))',
  ])("%j compiles to one request the closed table accepts", (text) => {
    expect(() => buildRequest(TARGET, compile(text).request)).not.toThrow();
  });
});
