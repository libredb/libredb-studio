import { describe, test, expect } from "bun:test";
import {
  detailedObjects,
  machineColumns,
  sampledMark,
  objectAtPath,
  relationObjects,
  rowWritableObjects,
  schemaContextOf,
  type DetailedObject,
} from "@/lib/db/detailed-object";
import type { ColumnSchema } from "@/lib/types";
import { SAMPLED_MARKER, sampledSchema } from "../../fixtures/sampled-schema";
import type { DatabaseObject, ObjectDetail, ObjectReadRange, ProviderCapabilities } from "@/lib/db/types";

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

  /**
   * A group's readable ranges (etcd spec 3.4, 4.7). The two browser-side generators read them off
   * the schema entry this join builds, so the provider's own array is carried, and the key is left
   * out entirely where the provider set none, which is every object whose range the connection may
   * read whole.
   */
  test("a listed object's readable ranges are carried as the provider's own array, and absent where it set none", () => {
    const ranges: readonly ObjectReadRange[] = [
      { key: "/config/a" },
      { prefix: "/config/b/" },
      { start: "/config/c", end: "/config/d" },
    ];
    const [scoped, whole] = detailedObjects(
      [{ ...listed("prefix", "/config/*"), readRanges: ranges }, listed("prefix", "/app/*")],
      [],
    );
    expect(scoped.readRanges).toBe(ranges);
    expect(Object.hasOwn(whole, "readRanges")).toBe(false);
  });
});

/**
 * The schema as the AI panels are handed it (etcd spec 3.4, E13).
 *
 * `detailedObjects` carries a group's readable ranges for the two generators, and those ranges are
 * the connection's own grants, which can name a key. `schemaContext` is posted to the model by the
 * AI panels, so it is the schema with the ranges left out, and nothing else changed: every engine
 * that sets no range gets the bytes `JSON.stringify` always gave it.
 */
describe("schemaContextOf", () => {
  test("is the schema's JSON, byte for byte, where no object carries readable ranges", () => {
    const schema = detailedObjects(
      [{ name: "orders", kind: "table", path: ["app", "orders"], rowCount: 12, sizeBytes: 2048 }],
      [
        {
          path: ["app", "orders"],
          columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
          indexes: [{ name: "pk", columns: ["id"], unique: true }],
          foreignKeys: [],
        },
      ],
    );
    expect(schemaContextOf(schema)).toBe(JSON.stringify(schema));
  });

  test("leaves every readable range out, and keeps every other field of the object", () => {
    const schema = detailedObjects(
      [
        {
          name: "/config/*",
          kind: "prefix",
          path: ["/config/*"],
          readRanges: [
            { key: "grant-key-a" },
            { prefix: "grant-prefix-b/" },
            { start: "grant-start-c", end: "grant-end-d" },
          ],
        },
      ],
      [],
    );
    const context = schemaContextOf(schema);
    expect(context).not.toContain("grant-");
    expect(context).not.toContain("readRanges");
    expect(JSON.parse(context)).toEqual([
      { name: "/config/*", kind: "prefix", path: ["/config/*"], columns: [], indexes: [], foreignKeys: [] },
    ]);
  });
});

/**
 * The resolver that replaced `find((t) => t.name === label)` (#789, Task 35).
 *
 * The fixture is the DEFECT: two objects that share the label `customers` in two different
 * containers, which is what the live SQL Server holds and what a name lookup cannot tell
 * apart. Every assertion here asks for the SECOND and refuses the first, so a resolver that
 * answers the first match passes none of them.
 */
describe("objectAtPath", () => {
  const first: DetailedObject = {
    name: "customers",
    kind: "table",
    path: ["libredb_objects", "app", "customers"],
    columns: [{ name: "customer_id", type: "int", nullable: false, isPrimary: true }],
    indexes: [],
  };
  const second: DetailedObject = {
    name: "customers",
    kind: "table",
    path: ["shop", "dbo", "customers"],
    columns: [{ name: "shop_customer_id", type: "int", nullable: false, isPrimary: true }],
    indexes: [],
  };
  const collision: readonly DetailedObject[] = [first, second];

  test("resolves the object whose ADDRESS was asked for, not the first with that label", () => {
    const resolved = objectAtPath(collision, ["shop", "dbo", "customers"]);
    expect(resolved).toBe(second);
    expect(resolved).not.toBe(first);
    // The columns are what every consumer of this reads, and they are the other object's.
    expect(resolved?.columns.map((c) => c.name)).toEqual(["shop_customer_id"]);
  });

  test("the first is still reachable, so the test above is about the address and not the order", () => {
    expect(objectAtPath(collision, ["libredb_objects", "app", "customers"])).toBe(first);
  });

  test("a path no object holds is null rather than the nearest label match", () => {
    expect(objectAtPath(collision, ["warehouse", "dbo", "customers"])).toBeNull();
    // A prefix is not a match: `pathKey` compares whole segments.
    expect(objectAtPath(collision, ["shop", "dbo"])).toBeNull();
  });

  test("no target at all is null, which is the closed modal's state", () => {
    expect(objectAtPath(collision, null)).toBeNull();
  });

  test("a segment containing a dot does not collide with the two-segment path spelling it", () => {
    const dotted: DetailedObject = { name: "a.b", kind: "table", path: ["demo", "a.b"], columns: [], indexes: [] };
    const nested: DetailedObject = { name: "b", kind: "table", path: ["demo", "a", "b"], columns: [], indexes: [] };
    expect(objectAtPath([dotted, nested], ["demo", "a", "b"])).toBe(nested);
    expect(objectAtPath([dotted, nested], ["demo", "a.b"])).toBe(dotted);
  });
});

/**
 * The machine-facing projection (vector family, PR 1v): a column a provider only inferred from sampled data is named
 * by the data, so no model and no MCP client receives it. Human views read the unprojected schema.
 */
describe("machineColumns", () => {
  test("answers the same array when no column is marked", () => {
    const columns: ColumnSchema[] = [{ name: "id", type: "integer", nullable: false, isPrimary: true }];
    expect(machineColumns(columns)).toBe(columns);
    const none: ColumnSchema[] = [];
    expect(machineColumns(none)).toBe(none);
  });

  test("drops every sampled column and keeps the declared ones in order", () => {
    const columns: ColumnSchema[] = [
      { name: "a", type: "keyword", nullable: true, isPrimary: false },
      { name: "b", type: "text", nullable: true, isPrimary: false, provenance: "sampled" },
      { name: "c", type: "integer", nullable: true, isPrimary: false },
    ];
    expect(machineColumns(columns).map((column) => column.name)).toEqual(["a", "c"]);
  });
});

describe("schemaContextOf over a sampled column", () => {
  test("drops the sampled column, marker and all, and keeps the declared one", () => {
    const context = schemaContextOf(sampledSchema);
    expect(context).not.toContain(SAMPLED_MARKER);
    expect(context).not.toContain("provenance");
    expect(JSON.parse(context)[0].columns).toEqual([
      { name: "category", type: "keyword", nullable: true, isPrimary: false },
    ]);
    expect(JSON.parse(context)[0].indexes).toEqual([{ name: "category_idx", columns: ["category"], unique: false }]);
  });

  test("leaves the schema it was handed unchanged for the human views", () => {
    schemaContextOf(sampledSchema);
    expect(sampledSchema[0].columns.map((column) => column.name)).toEqual(["category", SAMPLED_MARKER]);
  });
});

describe("sampledMark", () => {
  test("is the suffix the human views add to a sampled column's type, and nothing for a declared one", () => {
    expect(sampledMark({ provenance: "sampled" })).toBe(" (sampled)");
    expect(sampledMark({})).toBe("");
  });
});
