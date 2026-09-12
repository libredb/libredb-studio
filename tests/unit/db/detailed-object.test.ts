import { describe, test, expect } from "bun:test";
import { detailedObjects, relationObjects, rowWritableObjects, type DetailedObject } from "@/lib/db/detailed-object";
import type { DatabaseObject, ObjectDetail, ProviderCapabilities } from "@/lib/db/types";

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

function object(name: string, kind: string): DetailedObject {
  return { name, kind, path: ["app", name], columns: [], indexes: [] };
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

  test("capabilities that have not loaded yet hide nothing", () => {
    expect(rowWritableObjects(inventory, undefined)).toBe(inventory);
  });
});

/**
 * The join that replaced the flat reading's (#789).
 *
 * One inventory read now answers both halves: `listObjects` names the objects and
 * `describeObjects` describes the same folder, so the two sides spell the address the same
 * way and the key is the PATH rather than a guess at how a display name was qualified.
 */
describe("detailedObjects", () => {
  const listed = (kind: string, ...path: string[]): DatabaseObject => ({
    name: path[path.length - 1],
    kind,
    path,
  });
  const detail = (...path: string[]): ObjectDetail => ({
    path,
    columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
    indexes: [{ name: "pk", columns: ["id"], unique: true }],
    foreignKeys: [{ columnName: "id", referencedTable: "other", referencedColumn: "id" }],
  });

  test("an object takes the detail answered for its own path", () => {
    const joined = detailedObjects([listed("table", "app", "orders")], [detail("app", "orders")]);
    expect(joined).toEqual([
      {
        name: "orders",
        kind: "table",
        path: ["app", "orders"],
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
        indexes: [{ name: "pk", columns: ["id"], unique: true }],
        foreignKeys: [{ columnName: "id", referencedTable: "other", referencedColumn: "id" }],
      },
    ]);
  });

  test("a name containing a dot still finds its detail, because the key is the path", () => {
    // The defect the old join had: `a.b` in `public` was indistinguishable from `b` in `a`
    // once either side had been reduced to one string. Neither side is reduced here.
    const joined = detailedObjects([listed("table", "public", "a.b")], [detail("public", "a.b")]);
    expect(joined[0].columns).toHaveLength(1);
  });

  test("two objects whose segments concatenate alike do not take each other's detail", () => {
    // `["a", "b.c"]` and `["a.b", "c"]` join to one string identically under any separator
    // an identifier may contain. They must not collide.
    const joined = detailedObjects([listed("table", "a", "b.c"), listed("table", "a.b", "c")], [detail("a", "b.c")]);
    expect(joined[0].columns).toHaveLength(1);
    expect(joined[1].columns).toEqual([]);
  });

  test("an object the read described nothing for keeps empty columns rather than being dropped", () => {
    const joined = detailedObjects([listed("procedure", "app", "order_total")], []);
    expect(joined).toHaveLength(1);
    expect(joined[0].columns).toEqual([]);
    expect(joined[0].indexes).toEqual([]);
    expect(joined[0].foreignKeys).toEqual([]);
  });

  test("a row count and a size are carried where the engine published them, and absent where it did not", () => {
    const [counted, silent] = detailedObjects(
      [{ ...listed("table", "app", "orders"), rowCount: 12, sizeBytes: 2048 }, listed("table", "app", "audit")],
      [],
    );
    expect(counted.rowCount).toBe(12);
    expect(counted.size).toBe("2 KB");
    expect("rowCount" in silent).toBe(false);
    expect("size" in silent).toBe(false);
  });
});
