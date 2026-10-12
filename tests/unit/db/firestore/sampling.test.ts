/**
 * Field inference for one collection (spec 5.2): `__name__` first and never sampled, dotted paths to depth 3, at most
 * 200 fields, Firestore type names with `mixed(a|b)` where documents disagree, nullable where a document lacks the
 * field or holds null, every inferred column marked sampled, a segment holding "." named in the FieldPath form, and a
 * document name foreign to the connection, or to the collection read, refused.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";
import {
  collectionChildId,
  columnName,
  documentSegments,
  foreignDocumentSentence,
  inferColumns,
  nameColumn,
  outsideCollectionSentence,
} from "@/lib/db/providers/document/firestore/sampling";
import type { RestDocument, RestValue } from "@/lib/db/providers/document/firestore/values";
import type { ColumnSchema } from "@/lib/types";

const TARGET: FirestoreTarget = { projectId: "demo-studio", databaseId: "(default)" };
const DOCS = "projects/demo-studio/databases/(default)/documents";

const doc = (id: string, fields?: Record<string, RestValue>): RestDocument => ({
  name: `${DOCS}/users/${id}`,
  ...(fields === undefined ? {} : { fields }),
});
const int = (value: number): RestValue => ({ integerValue: String(value) });
const str = (value: string): RestValue => ({ stringValue: value });
const nul: RestValue = { nullValue: null };
const map = (fields: Record<string, RestValue>): RestValue => ({ mapValue: { fields } });
const vector = (...values: number[]): RestValue =>
  map({
    __type__: str("__vector__"),
    value: { arrayValue: { values: values.map((value) => ({ doubleValue: value })) } },
  });

const byName = (columns: readonly ColumnSchema[]): Record<string, ColumnSchema> =>
  Object.fromEntries(columns.map((column) => [column.name, column]));

function refusal(run: () => unknown): QueryError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).provider).toBe(FIRESTORE_TYPE);
    return error as QueryError;
  }
  throw new Error("nothing was refused");
}

describe("inferColumns", () => {
  test("__name__ leads, is the primary column and is not sampled", () => {
    const columns = inferColumns([doc("alice", { age: int(30) })], TARGET);
    expect(columns[0]).toEqual({ name: "__name__", type: "reference", nullable: false, isPrimary: true });
    expect(columns[0]).toEqual(nameColumn());
    expect(columns[0].provenance).toBeUndefined();
    expect(columns.slice(1).every((column) => column.provenance === "sampled" && !column.isPrimary)).toBe(true);
  });

  test("no document gives __name__ alone", () => {
    expect(inferColumns([], TARGET)).toEqual([nameColumn()]);
  });

  test("maps expand into dotted paths to depth 3 and a map is a column of its own", () => {
    const columns = byName(inferColumns([doc("a", { a: map({ b: map({ c: map({ d: int(1) }) }) }) })], TARGET));
    expect(Object.keys(columns)).toEqual(["__name__", "a", "a.b", "a.b.c"]);
    expect(columns["a.b.c"].type).toBe("map");
  });

  test("documents that disagree give mixed(a|b), in sorted type names", () => {
    const columns = byName(inferColumns([doc("a", { age: int(1) }), doc("b", { age: str("one") })], TARGET));
    expect(columns.age.type).toBe("mixed(integer|string)");
    expect(columns.age.nullable).toBe(false);
  });

  test("a field is nullable where a document lacks it or holds null, and typed by the rest", () => {
    const columns = byName(
      inferColumns(
        [doc("a", { nick: str("al"), age: int(1) }), doc("b", { age: nul }), doc("c", { age: int(3) })],
        TARGET,
      ),
    );
    expect(columns.nick).toMatchObject({ type: "string", nullable: true });
    expect(columns.age).toMatchObject({ type: "integer", nullable: true });
    expect(byName(inferColumns([doc("a", { gone: nul })], TARGET)).gone.type).toBe("null");
  });

  test("vectors of different dimensions are one vector column and are not expanded", () => {
    const columns = byName(
      inferColumns([doc("a", { embedding: vector(1, 2, 3) }), doc("b", { embedding: vector(1, 2, 3, 4, 5) })], TARGET),
    );
    expect(columns.embedding).toMatchObject({ type: "vector", nullable: false, provenance: "sampled" });
    expect(Object.keys(columns).some((name) => name.startsWith("embedding."))).toBe(false);
  });

  test("a wide document keeps the first 200 fields in UTF-8 order of their names", () => {
    const fields: Record<string, RestValue> = {};
    for (let index = 999; index >= 0; index -= 1) fields[`f${String(index).padStart(3, "0")}`] = int(index);
    const columns = inferColumns([doc("wide", fields)], TARGET);
    expect(columns).toHaveLength(201);
    expect(columns[1].name).toBe("f000");
    expect(columns[200].name).toBe("f199");
  });

  test("a segment holding a dot is named in the FieldPath form, so it never collides with a nested path (contract change 12)", () => {
    const columns = inferColumns(
      [doc("a", { "a.b": str("flat"), a: map({ b: int(1) }), m: map({ "k y": int(1), "x.y": int(2) }) })],
      TARGET,
    );
    const names = columns.map((column) => column.name);
    expect(new Set(names).size).toBe(names.length);
    const named = byName(columns);
    expect(named['new FieldPath("a.b")'].type).toBe("string");
    expect(named["a.b"].type).toBe("integer");
    expect(named["m.k y"].type).toBe("integer");
    expect(named['new FieldPath("m", "x.y")'].type).toBe("integer");
  });

  test("a document name outside the connection's database is refused", () => {
    const foreign: RestDocument = { name: "projects/other/databases/(default)/documents/users/x" };
    expect(refusal(() => inferColumns([foreign], TARGET)).message).toBe(foreignDocumentSentence(foreign.name));
  });
});

describe("columnName", () => {
  test("joins plain segments with a dot, and spells any segment holding a dot as a FieldPath the console reads", () => {
    expect(columnName(["a", "b c", "d"])).toBe("a.b c.d");
    expect(columnName(["first.last"])).toBe('new FieldPath("first.last")');
    expect(columnName(['q"x', "a.b"])).toBe('new FieldPath("q\\"x", "a.b")');
  });
});

describe("documentSegments", () => {
  test("answers the relative segments of a document of this database", () => {
    expect(documentSegments(TARGET, `${DOCS}/users/alice/orders/o1`)).toEqual(["users", "alice", "orders", "o1"]);
  });

  test("refuses a foreign name and a collection name", () => {
    expect(refusal(() => documentSegments(TARGET, "projects/p/databases/(default)/documents/users/a")).message).toBe(
      foreignDocumentSentence("projects/p/databases/(default)/documents/users/a"),
    );
    expect(refusal(() => documentSegments(TARGET, `${DOCS}/users`)).message).toBe(
      foreignDocumentSentence(`${DOCS}/users`),
    );
  });
});

describe("collectionChildId", () => {
  test("answers the id of a direct child of the collection read", () => {
    expect(collectionChildId(TARGET, ["users"], `${DOCS}/users/alice`)).toBe("alice");
    expect(collectionChildId(TARGET, ["users", "alice", "orders"], `${DOCS}/users/alice/orders/o 1`)).toBe("o 1");
  });

  test("refuses a document of another collection, a deeper document and a foreign name (S5)", () => {
    for (const name of [`${DOCS}/orders/x`, `${DOCS}/users/alice/orders/o1`, `${DOCS}/userz/alice`]) {
      expect(refusal(() => collectionChildId(TARGET, ["users"], name)).message).toBe(outsideCollectionSentence(name));
    }
    const foreign = "projects/other/databases/(default)/documents/users/x";
    expect(refusal(() => collectionChildId(TARGET, ["users"], foreign)).message).toBe(foreignDocumentSentence(foreign));
  });
});
