import { describe, test, expect } from "bun:test";
import { relationObjects, rowWritableObjects, tagObjectKinds, type DetailedObject } from "@/lib/db/detailed-object";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";

/**
 * A provider that declares the three shapes the filters have to tell apart: a table that
 * takes row writes, a view that is a relation and does NOT, and a routine that is neither.
 * `sequence` is declared and is deliberately absent from every fixture below: an object
 * carrying a kind nobody declared is a separate case from a kind declared as not a
 * relation, and the two are asserted separately.
 */
const capabilities = {
  queryLanguage: "sql",
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
    { id: "view", role: "relation", label: "View", labelPlural: "Views" },
    { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
  ],
} as unknown as ProviderCapabilities;

function object(name: string, kind?: string): DetailedObject {
  return { name, kind, path: kind === undefined ? undefined : ["app", name], columns: [], indexes: [] };
}

const inventory: readonly DetailedObject[] = [
  object("orders", "table"),
  object("order_summary", "view"),
  object("order_total", "procedure"),
  object("order_seq", "sequence"),
];

describe("relationObjects", () => {
  test("a routine is refused, and it is refused by its declared role", () => {
    expect(relationObjects(inventory, capabilities).map((o) => o.name)).toEqual(["orders", "order_summary"]);
  });

  test("an object whose kind the provider never declared is refused", () => {
    // `sequence` is in no `objectKinds` entry, so nothing declares what it is. The tree
    // draws no folder for such a kind; a consumer draws no row for it either.
    expect(relationObjects([object("order_seq", "sequence")], capabilities)).toEqual([]);
  });

  test("an object with no kind is kept, because the flat surface declares none", () => {
    const flat = [object("orders"), object("order_summary")];
    expect(relationObjects(flat, capabilities).map((o) => o.name)).toEqual(["orders", "order_summary"]);
  });

  test("capabilities that have not loaded yet hide nothing", () => {
    expect(relationObjects(inventory, undefined)).toBe(inventory);
  });
});

describe("rowWritableObjects", () => {
  test("a view has columns and is a relation, and is still not a write target", () => {
    expect(rowWritableObjects(inventory, capabilities).map((o) => o.name)).toEqual(["orders"]);
  });

  test("the engine-wide inline-row-edit flag is NOT conjoined", () => {
    // Standing ruling 4: MongoDB, Couchbase and Cassandra declare `supportsInlineRowEdit`
    // false while declaring a kind that takes row writes, so a conjunction here would
    // refuse an import all three engines support.
    const noInlineEdit = { ...capabilities, supportsInlineRowEdit: false } as ProviderCapabilities;
    expect(rowWritableObjects(inventory, noInlineEdit).map((o) => o.name)).toEqual(["orders"]);
  });

  test("an object with no kind is kept, and unloaded capabilities hide nothing", () => {
    expect(rowWritableObjects([object("orders")], capabilities).map((o) => o.name)).toEqual(["orders"]);
    expect(rowWritableObjects(inventory, undefined)).toBe(inventory);
  });
});

/**
 * The join that makes every filter above do work in production (#789, Task 25c).
 *
 * The flat surface answers one string per entry and no kind; the object surface answers
 * segments and a kind and no columns. Neither alone is what a consumer needs, so the hook
 * asks for both and joins them here.
 */
describe("tagObjectKinds", () => {
  const flat = (name: string): DetailedObject => ({ name, columns: [], indexes: [] });
  const listed = (kind: string, ...path: string[]): DatabaseObject => ({
    name: path[path.length - 1],
    kind,
    path,
  });

  test("a qualified flat name joins its object, and carries the kind and the segments", () => {
    const tagged = tagObjectKinds([flat("sales.orders")], [listed("table", "sales", "orders")]);
    expect(tagged).toEqual([
      { name: "sales.orders", columns: [], indexes: [], kind: "table", path: ["sales", "orders"] },
    ]);
  });

  test("a BARE flat name joins the only object whose last segment it is", () => {
    // This is the case the whole join exists for: PostgreSQL's flat reading drops the
    // schema for `public`, so `users` on the left has to meet `["public", "users"]` on the
    // right or every table on the most common engine reaches a consumer with no kind.
    const tagged = tagObjectKinds([flat("users")], [listed("table", "public", "users")]);
    expect(tagged[0].kind).toBe("table");
    expect(tagged[0].path).toEqual(["public", "users"]);
  });

  test("a bare name two containers both hold is left UNTAGGED rather than guessed", () => {
    // Nothing in the flat reading records which container built the name, so picking one
    // would file a `sales` view under `public` as a table. An untagged entry is kept by
    // every filter, which is the safe direction; a wrongly tagged one is not.
    const tagged = tagObjectKinds(
      [flat("orders")],
      [listed("table", "public", "orders"), listed("view", "sales", "orders")],
    );
    expect(tagged[0].kind).toBeUndefined();
    expect(tagged[0].path).toBeUndefined();
  });

  test("the qualified match wins over a bare one, and the view does not take the table's row", () => {
    const tagged = tagObjectKinds(
      [flat("sales.orders")],
      [listed("view", "sales", "orders"), listed("table", "public", "sales.orders")],
    );
    expect(tagged[0].kind).toBe("view");
  });

  test("an entry the object surface never named keeps NO kind and is not dropped", () => {
    const tagged = tagObjectKinds([flat("orders"), flat("legacy")], [listed("table", "public", "orders")]);
    expect(tagged.map((o) => o.name)).toEqual(["orders", "legacy"]);
    expect(tagged[1].kind).toBeUndefined();
  });

  test("an object with no segments at all joins nothing", () => {
    const tagged = tagObjectKinds([flat("")], [{ name: "", kind: "table", path: [] }]);
    expect(tagged[0].kind).toBeUndefined();
  });

  test("the columns, indexes and figures of the flat entry survive the join untouched", () => {
    const entry: DetailedObject = {
      name: "orders",
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
      rowCount: 500,
      size: "128 kB",
    };
    const [tagged] = tagObjectKinds([entry], [listed("table", "public", "orders")]);
    expect(tagged.columns).toEqual(entry.columns);
    expect(tagged.indexes).toEqual(entry.indexes);
    expect(tagged.foreignKeys).toEqual(entry.foreignKeys);
    expect(tagged.rowCount).toBe(500);
    expect(tagged.size).toBe("128 kB");
  });

  test("an empty object reading changes nothing", () => {
    const entries = [flat("orders")];
    expect(tagObjectKinds(entries, [])).toEqual(entries);
  });
});

/**
 * The middle segments, which the first join could not see (#789, fix round 2).
 *
 * The join's first spelling was written as two passes, the whole path joined by `.` and the
 * LAST segment alone, and on a one-level engine those are the only two spellings there are.
 * On a two-level engine they are not: a flat name qualified to the schema sits BETWEEN them
 * and matches neither pass. The engines below are read from their own code rather than
 * invented here, and each one is a population the filters above were inert over.
 */
describe("tagObjectKinds joins on every suffix, not only the first and the last", () => {
  const flat = (name: string): DetailedObject => ({ name, columns: [], indexes: [] });
  const listed = (kind: string, ...path: string[]): DatabaseObject => ({
    name: path[path.length - 1],
    kind,
    path,
  });

  test("Trino: a schema-qualified flat name joins its catalog-qualified object", () => {
    // `trino/introspect.ts` spells EVERY flat name `schema.table`, with no default-schema
    // case, against the `[catalog, schema, table]` path `trino/objects.ts` builds. So the
    // qualified pass missed `hive.sales.orders` and the last-segment pass missed `orders`,
    // and not one object on this engine ever joined.
    const tagged = tagObjectKinds([flat("sales.orders")], [listed("table", "hive", "sales", "orders")]);
    expect(tagged[0].kind).toBe("table");
    expect(tagged[0].path).toEqual(["hive", "sales", "orders"]);
  });

  test("SQL Server: a non-dbo schema qualifies the flat name and the path carries the catalog", () => {
    // `mssql.ts` strips `dbo.` only, so everything outside the default schema arrives as
    // `schema.table` against `[catalog, schema, table]`.
    const tagged = tagObjectKinds([flat("sales.orders")], [listed("table", "shop", "sales", "orders")]);
    expect(tagged[0].kind).toBe("table");
  });

  test("DuckDB: a non-main schema does the same", () => {
    // `duckdb/introspect.ts` strips `main.` only.
    const tagged = tagObjectKinds([flat("analytics.events")], [listed("table", "memory", "analytics", "events")]);
    expect(tagged[0].kind).toBe("table");
  });

  test("Couchbase: a non-default scope qualifies the keyspace name", () => {
    // `couchbase/keyspace.ts` strips `_default.` only, against a bucket-qualified path.
    const tagged = tagObjectKinds([flat("inventory.items")], [listed("collection", "travel", "inventory", "items")]);
    expect(tagged[0].kind).toBe("collection");
  });

  test("a middle spelling two objects answer to is still left untagged rather than guessed", () => {
    // The refusal is the half that must survive generalising the match: more spellings mean
    // more ways for two objects to claim one name, and choosing between them files a row
    // under a container nobody named.
    const tagged = tagObjectKinds(
      [flat("sales.orders")],
      [listed("table", "hive", "sales", "orders"), listed("view", "iceberg", "sales", "orders")],
    );
    expect(tagged[0].kind).toBeUndefined();
    expect(tagged[0].path).toBeUndefined();
  });

  test("an exact spelling is taken over one that merely ends the same way", () => {
    // Most qualified wins OUTRIGHT: a deeper object ending in the same two segments is not
    // a rival, or every two-level engine holding a three-level namesake would go untagged.
    const tagged = tagObjectKinds(
      [flat("sales.orders")],
      [listed("table", "sales", "orders"), listed("view", "warehouse", "sales", "orders")],
    );
    expect(tagged[0].kind).toBe("table");
  });
});
