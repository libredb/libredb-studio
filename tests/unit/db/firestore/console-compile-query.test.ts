/**
 * The structured query a console chain compiles to (spec 5.4): from, select, where, orderBy, cursors, offset and
 * limit with their bounds and warnings, and the parent the request is sent to.
 */
import { describe, expect, test } from "bun:test";
import {
  buildStructuredQuery,
  COMPILE_SENTENCES,
  COMPILE_WARNINGS,
  type CompileScope,
  type QueryMode,
  queryParent,
} from "@/lib/db/providers/document/firestore/console/compile";
import { parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import { encodeLiteral } from "@/lib/db/providers/document/firestore/values";
import { full, refusal, TARGET } from "../../../helpers/firestore-console";

function built(text: string, mode: QueryMode = "query") {
  const statement = parseStatement(text);
  if (statement.kind !== "query" && statement.kind !== "vector" && statement.kind !== "aggregate") {
    throw new Error(`expected a query, read ${statement.kind}`);
  }
  const scope: CompileScope = { text, target: TARGET, source: statement.source };
  const warnings: string[] = [];
  return { query: buildStructuredQuery(statement.ops, mode, scope, warnings), warnings, scope };
}
const refused = (text: string, mode: QueryMode, sentence: string, position: number): void => {
  const error = refusal(() => built(text, mode));
  expect(error.message.startsWith(sentence)).toBe(true);
  expect(error.position).toBe(position);
};
const int = (text: string) => encodeLiteral({ kind: "integer", text }, TARGET);
const ref = (path: string) => ({ referenceValue: full(path) });

describe("from and the default limit", () => {
  test("a collection query without limit gets limit 100 and the warning", () => {
    expect(built('db.collection("users")')).toMatchObject({
      query: { from: [{ collectionId: "users" }], limit: 100 },
      warnings: [COMPILE_WARNINGS.defaultLimit],
    });
    expect(COMPILE_WARNINGS.defaultLimit).toBe(
      "Studio added .limit(100); add your own .limit(n) up to 1,000, or page with .startAfter(<last __name__>)",
    );
  });

  test("a collection group reads from the root with allDescendants", () => {
    expect(built('db.collectionGroup("orders")').query.from).toEqual([
      { collectionId: "orders", allDescendants: true },
    ]);
  });

  test("a vector query and an aggregation get no default limit", () => {
    expect(built('db.collection("users")', "vector")).toEqual({
      query: { from: [{ collectionId: "users" }] },
      warnings: [],
      scope: expect.anything(),
    });
    const counted = built('db.collection("users").count()', "aggregate");
    expect("limit" in counted.query).toBe(false);
    expect(counted.warnings).toEqual([]);
  });
});

describe("limit and offset", () => {
  test("a runQuery limit is an integer from 0 to 1,000", () => {
    expect(built('db.collection("users").limit(5)')).toMatchObject({ query: { limit: 5 }, warnings: [] });
    expect(built('db.collection("users").limit(0)').query.limit).toBe(0);
    expect(built('db.collection("users").limit(1000)').query.limit).toBe(1000);
    refused('db.collection("users").limit(1001)', "query", COMPILE_SENTENCES.queryLimit, 29);
    refused('db.collection("users").limit(-1)', "query", COMPILE_SENTENCES.queryLimit, 29);
    refused('db.collection("users").limit(1001)', "vector", COMPILE_SENTENCES.queryLimit, 29);
  });

  test("an aggregation keeps the limit exactly as written, any non-negative 32-bit integer", () => {
    expect(built('db.collection("users").limit(5000).count()', "aggregate").query.limit).toBe(5000);
    expect(built('db.collection("users").limit(2147483647).count()', "aggregate").query.limit).toBe(2_147_483_647);
    refused('db.collection("users").limit(2147483648).count()', "aggregate", COMPILE_SENTENCES.aggregationLimit, 29);
    refused('db.collection("users").limit(-1).count()', "aggregate", COMPILE_SENTENCES.aggregationLimit, 29);
  });

  test("offset is 0 to 1,000 and a positive one carries the billing warning", () => {
    expect(built('db.collection("users").offset(10)')).toMatchObject({
      query: { offset: 10, limit: 100 },
      warnings: [COMPILE_WARNINGS.offsetBilling, COMPILE_WARNINGS.defaultLimit],
    });
    expect(built('db.collection("users").offset(0).limit(1)')).toMatchObject({ query: { offset: 0 }, warnings: [] });
    expect(built('db.collection("users").offset(1000)').query.offset).toBe(1000);
    refused('db.collection("users").offset(1001)', "query", COMPILE_SENTENCES.offsetRange, 30);
    refused('db.collection("users").offset(-1)', "query", COMPILE_SENTENCES.offsetRange, 30);
  });
});

describe("select, where and orderBy", () => {
  test("select() with no field asks for __name__ only; paths are quoted where they must be", () => {
    expect(built('db.collection("users").select()').query.select).toEqual({ fields: [{ fieldPath: "__name__" }] });
    expect(built('db.collection("users").select("a.b", new FieldPath("first name"))').query.select).toEqual({
      fields: [{ fieldPath: "a.b" }, { fieldPath: "`first name`" }],
    });
  });

  test("one where is the filter itself and repeated wheres combine with AND", () => {
    expect(built('db.collection("users").where("a", "==", null)').query.where).toEqual({
      unaryFilter: { op: "IS_NULL", field: { fieldPath: "a" } },
    });
    expect(built('db.collection("users").where("a", "==", null).where("b", "!=", null)').query.where).toEqual({
      compositeFilter: {
        op: "AND",
        filters: [
          { unaryFilter: { op: "IS_NULL", field: { fieldPath: "a" } } },
          { unaryFilter: { op: "IS_NOT_NULL", field: { fieldPath: "b" } } },
        ],
      },
    });
  });

  test("orderBy calls append with their directions", () => {
    expect(built('db.collection("users").orderBy("age", "desc").orderBy("first name")').query.orderBy).toEqual([
      { field: { fieldPath: "age" }, direction: "DESCENDING" },
      { field: { fieldPath: "`first name`" }, direction: "ASCENDING" },
    ]);
  });
});

describe("cursors", () => {
  test("startAt and endBefore are before: true; startAfter and endAt are before: false", () => {
    expect(built('db.collection("users").orderBy("age").startAt(30).endBefore(40)').query).toMatchObject({
      startAt: { values: [int("30")], before: true },
      endAt: { values: [int("40")], before: true },
    });
    expect(built('db.collection("users").orderBy("age").startAfter(30).endAt(40)').query).toMatchObject({
      startAt: { values: [int("30")], before: false },
      endAt: { values: [int("40")], before: false },
    });
  });

  test("a cursor holds at most one value per explicit orderBy", () => {
    refused('db.collection("users").orderBy("a").startAt(1, 2)', "query", COMPILE_SENTENCES.cursorArity(2, 1), 36);
    refused('db.collection("users").endAt(1)', "query", COMPILE_SENTENCES.cursorArity(1, 0), 23);
  });

  test("a position ordered by __name__ becomes a reference", () => {
    expect(built('db.collection("users").orderBy(FieldPath.documentId()).startAfter("alice")').query.startAt).toEqual({
      values: [ref("users/alice")],
      before: false,
    });
    expect(
      built('db.collection("users").orderBy("age").orderBy(FieldPath.documentId()).startAfter(30, "alice")').query
        .startAt,
    ).toEqual({ values: [int("30"), ref("users/alice")], before: false });
    expect(
      built('db.collectionGroup("orders").orderBy("__name__").startAt("users/a/orders/o1")').query.startAt,
    ).toEqual({
      values: [ref("users/a/orders/o1")],
      before: true,
    });
  });
});

describe("the request parent", () => {
  test("a collection's parent document or the root; a group's root", () => {
    expect(queryParent(built('db.collection("users")').scope)).toEqual([]);
    expect(queryParent(built('db.collection("users/alice/orders")').scope)).toEqual(["users", "alice"]);
    expect(queryParent(built('db.collectionGroup("orders")').scope)).toEqual([]);
  });

  test("a parent document whose id holds a colon is refused before any request", () => {
    const { scope } = built('db.collection("users/a:b/orders")');
    const error = refusal(() => queryParent(scope));
    expect(error.message.startsWith(COMPILE_SENTENCES.colonQuery("a:b", "orders"))).toBe(true);
    expect(error.position).toBe(14);
  });
});
