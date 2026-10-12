/**
 * The closed request table (spec S1): seven read requests, each with its method, path shape, query parameter names
 * and body keys; everything else, including every transaction and read-time field, is refused by a throw before a
 * request exists to send.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE, SENTENCES } from "@/lib/db/providers/document/firestore/constants";
import type { RequestKind } from "@/lib/db/providers/document/firestore/errors";
import { type FirestoreTarget, NAME_SENTENCES as N } from "@/lib/db/providers/document/firestore/names";
import {
  buildRequest,
  type FirestoreRequest,
  REQUEST_SENTENCES as R,
} from "@/lib/db/providers/document/firestore/requests";

const T: FirestoreTarget = { projectId: "demo-libredb", databaseId: "(default)" };
const BASE = "/v1/projects/demo-libredb/databases/%28default%29";
const ROOT = "projects/demo-libredb/databases/(default)/documents";

const G4_IDS: readonly (readonly [string, string])[] = [
  ["a:b", "a%3Ab"],
  ["a b", "a%20b"],
  ["a%b", "a%25b"],
  ["a%2Fb", "a%252Fb"],
  ["a#b", "a%23b"],
  ["a?b", "a%3Fb"],
  ["a`b", "a%60b"],
  ["\u00e7a\u011fr\u0131-\u65e5\u672c", "%C3%A7a%C4%9Fr%C4%B1-%E6%97%A5%E6%9C%AC"],
  ["e\u{1F600}", "e%F0%9F%98%80"],
];

function refusal(request: unknown, target: FirestoreTarget = T): string {
  let caught: unknown;
  try {
    buildRequest(target, request as FirestoreRequest);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QueryError);
  expect((caught as QueryError).provider).toBe(FIRESTORE_TYPE);
  return (caught as Error).message;
}

describe("the seven requests", () => {
  test("errors.ts spells the same seven kinds (a typecheck pin)", () => {
    const forward: readonly RequestKind[] = [] as readonly FirestoreRequest["kind"][];
    const back: readonly FirestoreRequest["kind"][] = [] as readonly RequestKind[];
    expect(forward.length + back.length).toBe(0);
  });

  test("the database resource, for the default, a named and a legacy-domain project", () => {
    expect(buildRequest(T, { kind: "database" })).toEqual({ method: "GET", path: BASE, query: [], cap: "small" });
    expect(buildRequest({ projectId: "demo-libredb", databaseId: "orders" }, { kind: "database" }).path).toBe(
      "/v1/projects/demo-libredb/databases/orders",
    );
    expect(
      buildRequest({ projectId: "example.com:my-project", databaseId: "(default)" }, { kind: "database" }).path,
    ).toBe("/v1/projects/example.com%3Amy-project/databases/%28default%29");
  });

  test("documents.get with a field mask", () => {
    expect(buildRequest(T, { kind: "get", path: ["users", "a b"], maskFieldPaths: ["name", "`a.b`"] })).toEqual({
      method: "GET",
      path: `${BASE}/documents/users/a%20b`,
      query: [
        ["mask.fieldPaths", "name"],
        ["mask.fieldPaths", "`a.b`"],
      ],
      cap: "small",
    });
  });

  test("every G4 id stays one segment in get, listDocuments and listCollectionIds paths", () => {
    for (const [id, encoded] of G4_IDS) {
      expect(buildRequest(T, { kind: "get", path: ["c", id] }).path).toBe(`${BASE}/documents/c/${encoded}`);
      expect(buildRequest(T, { kind: "get", path: ["c", id, "sub", "d"] }).path).toBe(
        `${BASE}/documents/c/${encoded}/sub/d`,
      );
      expect(
        buildRequest(T, { kind: "listDocuments", parent: ["c", id], collectionId: "sub", pageSize: 50 }).path,
      ).toBe(`${BASE}/documents/c/${encoded}/sub`);
      expect(buildRequest(T, { kind: "listDocuments", parent: [], collectionId: id, pageSize: 50 }).path).toBe(
        `${BASE}/documents/${encoded}`,
      );
      expect(
        buildRequest(T, { kind: "listDocuments", parent: ["c", "plain"], collectionId: id, pageSize: 50 }).path,
      ).toBe(`${BASE}/documents/c/plain/${encoded}`);
      if (!id.includes(":")) {
        expect(buildRequest(T, { kind: "listCollectionIds", parent: ["c", id] }).path).toBe(
          `${BASE}/documents/c/${encoded}:listCollectionIds`,
        );
        expect(buildRequest(T, { kind: "runQuery", parent: ["c", id], body: { structuredQuery: {} } }).path).toBe(
          `${BASE}/documents/c/${encoded}:runQuery`,
        );
      }
    }
  });

  test("listDocuments with every parameter, and showMissing false left out", () => {
    expect(
      buildRequest(T, {
        kind: "listDocuments",
        parent: [],
        collectionId: "users",
        pageSize: 500,
        pageToken: "tok",
        showMissing: true,
        maskFieldPaths: ["__name__"],
      }),
    ).toEqual({
      method: "GET",
      path: `${BASE}/documents/users`,
      query: [
        ["pageSize", "500"],
        ["pageToken", "tok"],
        ["showMissing", "true"],
        ["mask.fieldPaths", "__name__"],
      ],
      cap: "large",
    });
    expect(
      buildRequest(T, {
        kind: "listDocuments",
        parent: ["users", "alice"],
        collectionId: "orders",
        showMissing: false,
        pageSize: 50,
      }),
    ).toEqual({
      method: "GET",
      path: `${BASE}/documents/users/alice/orders`,
      query: [["pageSize", "50"]],
      cap: "large",
    });
  });

  test("listCollectionIds at the root and under a document whose earlier segment holds a colon", () => {
    expect(buildRequest(T, { kind: "listCollectionIds", parent: [], pageSize: 1_000 })).toEqual({
      method: "POST",
      path: `${BASE}/documents:listCollectionIds`,
      query: [],
      body: '{"pageSize":1000}',
      cap: "small",
    });
    expect(
      buildRequest(T, { kind: "listCollectionIds", parent: ["c", "a:b", "sub", "d"], pageSize: 1, pageToken: "t1" }),
    ).toEqual({
      method: "POST",
      path: `${BASE}/documents/c/a%3Ab/sub/d:listCollectionIds`,
      query: [],
      body: '{"pageSize":1,"pageToken":"t1"}',
      cap: "small",
    });
    expect(buildRequest(T, { kind: "listCollectionIds", parent: [] }).body).toBe("{}");
  });

  test("runQuery and runAggregationQuery carry their body as given, explain options included", () => {
    const structuredQuery = { from: [{ collectionId: "users" }], limit: 100 };
    expect(buildRequest(T, { kind: "runQuery", parent: [], body: { structuredQuery } })).toEqual({
      method: "POST",
      path: `${BASE}/documents:runQuery`,
      query: [],
      body: JSON.stringify({ structuredQuery }),
      cap: "large",
    });
    const explained = { structuredQuery, explainOptions: { analyze: false } };
    expect(buildRequest(T, { kind: "runQuery", parent: ["users", "alice"], body: explained })).toEqual({
      method: "POST",
      path: `${BASE}/documents/users/alice:runQuery`,
      query: [],
      body: JSON.stringify(explained),
      cap: "large",
    });
    const aggregation = {
      structuredAggregationQuery: { structuredQuery, aggregations: [{ alias: "aggregate_0", count: {} }] },
    };
    expect(buildRequest(T, { kind: "runAggregationQuery", parent: [], body: aggregation })).toEqual({
      method: "POST",
      path: `${BASE}/documents:runAggregationQuery`,
      query: [],
      body: JSON.stringify(aggregation),
      cap: "small",
    });
  });

  test("batchGet names full documents of this database", () => {
    const body = { documents: [`${ROOT}/users/alice`, `${ROOT}/users/a:b`], mask: { fieldPaths: ["name"] } };
    expect(buildRequest(T, { kind: "batchGet", body })).toEqual({
      method: "POST",
      path: `${BASE}/documents:batchGet`,
      query: [],
      body: JSON.stringify(body),
      cap: "large",
    });
    const most = Array.from({ length: 1_000 }, (_, index) => `${ROOT}/c/d${index}`);
    expect(buildRequest(T, { kind: "batchGet", body: { documents: most } }).cap).toBe("large");
  });
});

describe("the colon refusal (spec 5.3, S5)", () => {
  test("a listCollectionIds parent ending in a colon id", () => {
    expect(refusal({ kind: "listCollectionIds", parent: ["users", "a:b"] })).toBe(
      SENTENCES.colonSubcollections("users/a:b"),
    );
    expect(refusal({ kind: "listCollectionIds", parent: ["c", "x:runQuery"] })).toBe(
      SENTENCES.colonSubcollections("c/x:runQuery"),
    );
  });

  test("a runQuery or runAggregationQuery parent ending in a colon id", () => {
    expect(refusal({ kind: "runQuery", parent: ["users", "a:b"], body: { structuredQuery: {} } })).toBe(
      SENTENCES.colonVerbParent("users/a:b"),
    );
    expect(
      refusal({ kind: "runAggregationQuery", parent: ["users", "a:b"], body: { structuredAggregationQuery: {} } }),
    ).toBe(SENTENCES.colonVerbParent("users/a:b"));
  });
});

describe("everything outside the table is refused before a request exists", () => {
  const doc = `${ROOT}/c/d`;
  test.each([
    ["a write verb", { kind: "commit" }, R.notInTable],
    ["an inherited name as kind", { kind: "constructor" }, R.notInTable],
    ["no kind", {}, R.notInTable],
    ["not an object", null, R.notInTable],
    ["a transaction on get", { kind: "get", path: ["c", "d"], transaction: "dHg=" }, R.extraKey("get", "transaction")],
    [
      "readTime on get",
      { kind: "get", path: ["c", "d"], readTime: "2026-01-01T00:00:00Z" },
      R.extraKey("get", "readTime"),
    ],
    [
      "readTime on listDocuments",
      { kind: "listDocuments", parent: [], collectionId: "c", readTime: "2026-01-01T00:00:00Z" },
      R.extraKey("listDocuments", "readTime"),
    ],
    [
      "recursive on listDocuments",
      { kind: "listDocuments", parent: [], collectionId: "c", recursive: true },
      R.extraKey("listDocuments", "recursive"),
    ],
    [
      "readTime on listCollectionIds",
      { kind: "listCollectionIds", parent: [], readTime: "x" },
      R.extraKey("listCollectionIds", "readTime"),
    ],
    [
      "newTransaction in a runQuery body",
      { kind: "runQuery", parent: [], body: { structuredQuery: {}, newTransaction: { readOnly: {} } } },
      R.extraKey("runQuery", "newTransaction"),
    ],
    [
      "readTime in a runQuery body",
      { kind: "runQuery", parent: [], body: { structuredQuery: {}, readTime: "x" } },
      R.extraKey("runQuery", "readTime"),
    ],
    [
      "transaction in a runAggregationQuery body",
      { kind: "runAggregationQuery", parent: [], body: { structuredAggregationQuery: {}, transaction: "x" } },
      R.extraKey("runAggregationQuery", "transaction"),
    ],
    [
      "requestOptions on runQuery",
      { kind: "runQuery", parent: [], body: { structuredQuery: {} }, requestOptions: {} },
      R.extraKey("runQuery", "requestOptions"),
    ],
    [
      "transaction in a batchGet body",
      { kind: "batchGet", body: { documents: [doc], transaction: "x" } },
      R.extraKey("batchGet", "transaction"),
    ],
    ["a collection path for get", { kind: "get", path: ["c"] }, R.documentPath],
    ["an empty path for get", { kind: "get", path: [] }, R.documentPath],
    [
      "an invalid id in get",
      { kind: "get", path: ["c", "__x__"] },
      N.pathSegment(2, "document", N.idReserved("document")),
    ],
    ["a collection as parent", { kind: "listDocuments", parent: ["c"], collectionId: "d" }, R.parentPath],
    [
      "an invalid id in a parent",
      { kind: "listCollectionIds", parent: ["c", ".."] },
      N.pathSegment(2, "document", N.idDots("document")),
    ],
    ["a slash in a collection id", { kind: "listDocuments", parent: [], collectionId: "a/b" }, N.idSlash("collection")],
    ["listDocuments without pageSize", { kind: "listDocuments", parent: [], collectionId: "c" }, R.pageSize(50)],
    [
      "listDocuments with a mask and without pageSize",
      { kind: "listDocuments", parent: [], collectionId: "c", maskFieldPaths: ["__name__"] },
      R.pageSize(500),
    ],
    [
      "pageSize 0",
      { kind: "listDocuments", parent: [], collectionId: "c", pageSize: 0, maskFieldPaths: ["__name__"] },
      R.pageSize(500),
    ],
    [
      "pageSize 501 with a mask",
      { kind: "listDocuments", parent: [], collectionId: "c", pageSize: 501, maskFieldPaths: ["__name__"] },
      R.pageSize(500),
    ],
    [
      "pageSize 51 without a mask",
      { kind: "listDocuments", parent: [], collectionId: "c", pageSize: 51 },
      R.pageSize(50),
    ],
    ["a fractional pageSize", { kind: "listDocuments", parent: [], collectionId: "c", pageSize: 1.5 }, R.pageSize(50)],
    [
      "pageSize 1,001 on listCollectionIds",
      { kind: "listCollectionIds", parent: [], pageSize: 1_001 },
      R.pageSize(1_000),
    ],
    ["an empty page token", { kind: "listCollectionIds", parent: [], pageToken: "" }, R.pageToken],
    [
      "a page token that is not a string",
      { kind: "listDocuments", parent: [], collectionId: "c", pageSize: 50, pageToken: 7 },
      R.pageToken,
    ],
    [
      "a showMissing that is not boolean",
      { kind: "listDocuments", parent: [], collectionId: "c", pageSize: 50, showMissing: "true" },
      R.showMissing,
    ],
    ["an empty mask", { kind: "get", path: ["c", "d"], maskFieldPaths: [] }, R.maskFieldPaths],
    ["an empty mask path", { kind: "get", path: ["c", "d"], maskFieldPaths: [""] }, R.maskFieldPaths],
    ["a body that is not an object", { kind: "runQuery", parent: [], body: "x" }, R.bodyObject("body")],
    ["no structuredQuery", { kind: "runQuery", parent: [], body: {} }, R.bodyObject("structuredQuery")],
    [
      "a structuredAggregationQuery that is not an object",
      { kind: "runAggregationQuery", parent: [], body: { structuredAggregationQuery: [] } },
      R.bodyObject("structuredAggregationQuery"),
    ],
    [
      "explain analyze not boolean",
      { kind: "runQuery", parent: [], body: { structuredQuery: {}, explainOptions: { analyze: "yes" } } },
      R.explainOptions,
    ],
    [
      "explain with another key",
      { kind: "runQuery", parent: [], body: { structuredQuery: {}, explainOptions: { analyze: true, mode: "x" } } },
      R.explainOptions,
    ],
    [
      "a batchGet name in another project",
      { kind: "batchGet", body: { documents: ["projects/other-project/databases/(default)/documents/c/d"] } },
      R.batchGetDocuments,
    ],
    ["a batchGet collection name", { kind: "batchGet", body: { documents: [`${ROOT}/c`] } }, R.batchGetDocuments],
    [
      "a batchGet name with a reserved id",
      { kind: "batchGet", body: { documents: [`${ROOT}/c/__x__`] } },
      R.batchGetDocuments,
    ],
    ["a batchGet with no documents", { kind: "batchGet", body: { documents: [] } }, R.batchGetDocuments],
    [
      "a batchGet with 1,001 documents",
      { kind: "batchGet", body: { documents: Array.from({ length: 1_001 }, (_, i) => `${ROOT}/c/d${i}`) } },
      R.batchGetDocuments,
    ],
    ["a batchGet without documents", { kind: "batchGet", body: {} }, R.batchGetDocuments],
    [
      "a batchGet mask with no path",
      { kind: "batchGet", body: { documents: [doc], mask: { fieldPaths: [] } } },
      R.maskFieldPaths,
    ],
    [
      "a batchGet mask with another key",
      { kind: "batchGet", body: { documents: [doc], mask: { fieldPaths: ["a"], x: 1 } } },
      R.maskFieldPaths,
    ],
  ])("%s", (_name, request, sentence) => {
    expect(refusal(request)).toBe(sentence);
  });

  test("an invalid target is refused before any path is built", () => {
    expect(refusal({ kind: "database" }, { projectId: "Bad", databaseId: "(default)" })).toBe(R.target);
    expect(refusal({ kind: "database" }, { projectId: "demo-libredb", databaseId: "Orders" })).toBe(R.target);
  });

  test("every request in the table is a GET or a POST under the database path, never under /emulator/", () => {
    const requests: FirestoreRequest[] = [
      { kind: "database" },
      { kind: "get", path: ["c", "d"] },
      { kind: "listDocuments", parent: [], collectionId: "c", pageSize: 50 },
      { kind: "listCollectionIds", parent: [] },
      { kind: "runQuery", parent: [], body: { structuredQuery: {} } },
      { kind: "runAggregationQuery", parent: [], body: { structuredAggregationQuery: {} } },
      { kind: "batchGet", body: { documents: [`${ROOT}/c/d`] } },
    ];
    for (const request of requests) {
      const built = buildRequest(T, request);
      expect(["GET", "POST"]).toContain(built.method);
      expect(built.path.startsWith(BASE)).toBe(true);
      expect(built.path).not.toContain("/emulator/");
      expect(built.body === undefined).toBe(built.method === "GET");
    }
  });
});
