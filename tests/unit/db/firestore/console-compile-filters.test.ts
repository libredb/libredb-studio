/**
 * Console filters on the wire (spec 5.4): every operator, = read as ==, null and NaN as unary filters, composite
 * filters, field paths quoted where they must be, and document-id values turned into full reference names.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPILE_SENTENCES,
  type CompileScope,
  compileFilter,
} from "@/lib/db/providers/document/firestore/console/compile";
import { type FilterNode, parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import { encodeLiteral, VALUE_SENTENCES } from "@/lib/db/providers/document/firestore/values";
import { full, refusal, TARGET } from "../../../helpers/firestore-console";

function firstWhere(text: string): { node: FilterNode; scope: CompileScope } {
  const statement = parseStatement(text);
  if (statement.kind !== "query") throw new Error(`expected a query, read ${statement.kind}`);
  return { node: statement.ops.where[0], scope: { text, target: TARGET, source: statement.source } };
}
const compiled = (text: string): Record<string, unknown> => {
  const { node, scope } = firstWhere(text);
  return compileFilter(node, scope);
};
const refused = (text: string, sentence: string, position: number): void => {
  const error = refusal(() => compiled(text));
  expect(error.message.startsWith(sentence)).toBe(true);
  expect(error.position).toBe(position);
};
const ref = (path: string) => ({ referenceValue: full(path) });
const users = (where: string): string => `db.collection("users").where(${where})`;

describe("field filters", () => {
  test.each([
    ["<", "LESS_THAN"],
    ["<=", "LESS_THAN_OR_EQUAL"],
    ["==", "EQUAL"],
    ["=", "EQUAL"],
    ["!=", "NOT_EQUAL"],
    [">=", "GREATER_THAN_OR_EQUAL"],
    [">", "GREATER_THAN"],
    ["array-contains", "ARRAY_CONTAINS"],
  ])("%s is sent as %s", (op, name) => {
    expect(compiled(users(`"age", "${op}", 21`))).toEqual({
      fieldFilter: {
        field: { fieldPath: "age" },
        op: name,
        value: encodeLiteral({ kind: "integer", text: "21" }, TARGET),
      },
    });
  });

  test("in, not-in and array-contains-any take an array", () => {
    const array = encodeLiteral(
      {
        kind: "array",
        items: [
          { kind: "string", value: "a" },
          { kind: "string", value: "b" },
        ],
      },
      TARGET,
    );
    expect(compiled(users('"tags", "in", ["a", "b"]'))).toMatchObject({ fieldFilter: { op: "IN", value: array } });
    expect(compiled(users('"tags", "not-in", ["a", "b"]'))).toMatchObject({
      fieldFilter: { op: "NOT_IN", value: array },
    });
    expect(compiled(users('"tags", "array-contains-any", ["a", "b"]'))).toMatchObject({
      fieldFilter: { op: "ARRAY_CONTAINS_ANY", value: array },
    });
    refused(users('"tags", "in", "a"'), COMPILE_SENTENCES.arrayOperand("in"), 23);
  });

  test("a field path goes bare when simple and backtick-quoted otherwise", () => {
    expect(compiled(users('"address.city", "==", 1'))).toMatchObject({
      fieldFilter: { field: { fieldPath: "address.city" } },
    });
    expect(compiled(users('"first name", "==", 1'))).toMatchObject({
      fieldFilter: { field: { fieldPath: "`first name`" } },
    });
    expect(compiled(users('new FieldPath("a.b"), "==", 1'))).toMatchObject({
      fieldFilter: { field: { fieldPath: "`a.b`" } },
    });
  });
});

describe("null and NaN", () => {
  test.each([
    ['"==", null', "IS_NULL"],
    ['"=", null', "IS_NULL"],
    ['"!=", null', "IS_NOT_NULL"],
    ['"==", NaN', "IS_NAN"],
    ['"!=", NaN', "IS_NOT_NAN"],
  ])("%s compiles to the unary filter %s", (rest, op) => {
    expect(compiled(users(`"a", ${rest}`))).toEqual({ unaryFilter: { op, field: { fieldPath: "a" } } });
  });

  test("any other operator with null or NaN is refused", () => {
    refused(users('"a", "<", null'), COMPILE_SENTENCES.nullOrNaN("null"), 23);
    refused(users('"a", "array-contains", null'), COMPILE_SENTENCES.nullOrNaN("null"), 23);
    refused(users('"a", ">", NaN'), COMPILE_SENTENCES.nullOrNaN("NaN"), 23);
  });
});

describe("composite filters", () => {
  test("Filter.or and Filter.and nest, and a one-filter composite is the filter itself", () => {
    expect(compiled(users('Filter.or(Filter.where("a", "==", 1), Filter.where("b", "==", null))'))).toEqual({
      compositeFilter: {
        op: "OR",
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: "a" },
              op: "EQUAL",
              value: encodeLiteral({ kind: "integer", text: "1" }, TARGET),
            },
          },
          { unaryFilter: { op: "IS_NULL", field: { fieldPath: "b" } } },
        ],
      },
    });
    expect(compiled(users('Filter.and(Filter.where("a", "==", null))'))).toEqual({
      unaryFilter: { op: "IS_NULL", field: { fieldPath: "a" } },
    });
    expect(
      compiled(
        users(
          'Filter.and(Filter.or(Filter.where("a", "==", null), Filter.where("b", "==", null)), Filter.where("c", "==", null))',
        ),
      ),
    ).toMatchObject({
      compositeFilter: { op: "AND", filters: [{ compositeFilter: { op: "OR" } }, { unaryFilter: { op: "IS_NULL" } }] },
    });
  });
});

describe("document-id values on a collection", () => {
  test("a plain id resolves under the queried collection, any collection depth", () => {
    expect(compiled(users('FieldPath.documentId(), "==", "alice"'))).toEqual({
      fieldFilter: { field: { fieldPath: "__name__" }, op: "EQUAL", value: ref("users/alice") },
    });
    expect(compiled(users('"__name__", ">=", "alice"'))).toMatchObject({ fieldFilter: { value: ref("users/alice") } });
    expect(compiled('db.collection("users/alice/orders").where(FieldPath.documentId(), "<", "o1")')).toMatchObject({
      fieldFilter: { value: ref("users/alice/orders/o1") },
    });
  });

  test("db.doc() must name a direct child of the collection", () => {
    expect(compiled(users('FieldPath.documentId(), "==", db.doc("users/bob")'))).toMatchObject({
      fieldFilter: { value: ref("users/bob") },
    });
    refused(users('FieldPath.documentId(), "==", db.doc("orders/x")'), COMPILE_SENTENCES.idChild("users"), 23);
    refused(users('FieldPath.documentId(), "==", db.doc("users/a/orders/b")'), COMPILE_SENTENCES.idChild("users"), 23);
  });

  test("in and not-in turn every element into a reference", () => {
    expect(compiled(users('FieldPath.documentId(), "in", ["a", db.doc("users/b")]'))).toEqual({
      fieldFilter: {
        field: { fieldPath: "__name__" },
        op: "IN",
        value: { arrayValue: { values: [ref("users/a"), ref("users/b")] } },
      },
    });
    expect(compiled(users('FieldPath.documentId(), "not-in", ["a"]'))).toMatchObject({ fieldFilter: { op: "NOT_IN" } });
    refused(users('FieldPath.documentId(), "in", "a"'), COMPILE_SENTENCES.arrayOperand("in"), 23);
  });

  test("a slash, an invalid id, a non-id value and the array operators are refused", () => {
    refused(users('FieldPath.documentId(), "==", "a/b"'), COMPILE_SENTENCES.idSlash, 23);
    expect(refusal(() => compiled(users('FieldPath.documentId(), "==", ".."'))).position).toBe(23);
    refused(users('FieldPath.documentId(), "==", 5'), COMPILE_SENTENCES.idValue, 23);
    refused(users('FieldPath.documentId(), "==", null'), COMPILE_SENTENCES.idValue, 23);
    refused(users('FieldPath.documentId(), "array-contains", "a"'), COMPILE_SENTENCES.idArrayOperator, 23);
    refused(users('FieldPath.documentId(), "array-contains-any", ["a"]'), COMPILE_SENTENCES.idArrayOperator, 23);
  });
});

describe("document-id values on a collection group", () => {
  const group = (where: string): string => `db.collectionGroup("orders").where(${where})`;

  test("a value is an even-segment path, and any db.doc() under the root is accepted", () => {
    expect(compiled(group('FieldPath.documentId(), ">=", "users/alice/orders/o1"'))).toMatchObject({
      fieldFilter: { value: ref("users/alice/orders/o1") },
    });
    expect(compiled(group('FieldPath.documentId(), "==", db.doc("users/a/orders/o1")'))).toMatchObject({
      fieldFilter: { value: ref("users/a/orders/o1") },
    });
    refused(group('FieldPath.documentId(), "==", "o1"'), COMPILE_SENTENCES.groupIdPath, 29);
    expect(refusal(() => compiled(group('FieldPath.documentId(), "==", "users//o1"'))).position).toBe(29);
  });
});

describe("a value values.ts refuses to encode", () => {
  test("a lone surrogate read from an escape is refused at its where, never without a position", () => {
    refused(users('"a", "==", "\\uD800"'), VALUE_SENTENCES.stringMalformed, 23);
    refused(users('"a", "==", { "\\uD800": 1 }'), VALUE_SENTENCES.stringMalformed, 23);
  });
});
