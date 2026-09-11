import { describe, test, expect } from "bun:test";
import { relationObjects, rowWritableObjects, type DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderCapabilities } from "@/lib/db/types";

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
