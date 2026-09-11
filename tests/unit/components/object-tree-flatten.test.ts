import { describe, test, expect } from "bun:test";
import { flattenTree } from "@/components/object-tree/flatten";
import { containerDepth } from "@/lib/db/object-kinds";
import type { ProviderCapabilities } from "@/lib/db/types";

const kinds = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
] as const;

describe("flattenTree", () => {
  test("a collapsed container yields one row and no children", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set<string>(),
      counts: {},
      objects: {},
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "container", depth: 0, setSize: 1, posInSet: 1, expanded: false });
  });

  test("aria positions are per sibling group, not per visible row", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [
        { path: ["app"], name: "app", level: 0 },
        { path: ["sales"], name: "sales", level: 0 },
      ],
      expanded: new Set(["app"]),
      counts: { app: { table: { count: 2 }, view: { count: 0 }, procedure: { count: 1 } } },
      objects: {},
    });
    // app, its three folders, then sales.
    expect(rows.map((r) => `${r.depth}:${r.posInSet}/${r.setSize}`)).toEqual([
      "0:1/2",
      "1:1/3",
      "1:2/3",
      "1:3/3",
      "0:2/2",
    ]);
  });

  test("a declared kind with zero objects still renders a folder with a zero badge", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app"]),
      counts: { app: { table: { count: 2 }, view: { count: 0 }, procedure: { count: 1 } } },
      objects: {},
    });
    expect(rows.find((r) => r.kindId === "view")).toMatchObject({ kind: "folder", badge: "0" });
  });

  test("a refused count carries the engine's sentence and no number", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["sales"], name: "sales", level: 0 }],
      expanded: new Set(["sales"]),
      counts: { sales: { table: { unavailable: "permission denied for schema sales" } } },
      objects: {},
    });
    const table = rows.find((r) => r.kindId === "table");
    expect(table?.badge).toBeUndefined();
    expect(table?.unavailable).toBe("permission denied for schema sales");
  });

  test("a kind the engine never declared produces no row at all", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app"]),
      counts: { app: { table: { count: 1 }, view: { count: 0 }, procedure: { count: 0 } } },
      objects: {},
    });
    expect(rows.some((r) => r.kindId === "package")).toBe(false);
  });

  test("a folder badge never comes from the loaded object list", () => {
    // The list is capped by the route; the count is a real COUNT. Reading the length back
    // as a count is how a saturated list passes every gate while being wrong.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { count: 43512 }, view: { count: 0 }, procedure: { count: 0 } } },
      objects: { "app/table": [{ path: ["app", "a"], name: "a", kind: "table" }] },
    });
    expect(rows.find((r) => r.kindId === "table" && r.kind === "folder")?.badge).toBe("43,512");
  });
});

describe("flattenTree row identity", () => {
  test("a row id is its path segments escaped and joined with a slash, plus the kind id on folders and objects", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { count: 1 } } },
      objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
    });
    // Depth first: an expanded folder's objects come before the next sibling folder.
    expect(rows.map((r) => r.id)).toEqual(["app", "app/table", "app/orders/table", "app/view", "app/procedure"]);
  });

  test("two objects sharing a path but not a kind get two ids", () => {
    // Standing ruling 3: paths are unique WITHIN a kind and deliberately not across kinds,
    // and this is the property that permission rests on. MySQL allows a table and a routine
    // to share a name in one schema.
    const rows = flattenTree({
      kinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
        { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
      ],
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table", "app/procedure"]),
      counts: {},
      objects: {
        "app/table": [{ path: ["app", "audit"], name: "audit", kind: "table" }],
        "app/procedure": [{ path: ["app", "audit"], name: "audit", kind: "procedure" }],
      },
    });
    const objectIds = rows.filter((r) => r.kind === "object").map((r) => r.id);
    expect(objectIds).toEqual(["app/audit/table", "app/audit/procedure"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test("a container whose name holds the separator does not take the id of a folder under its prefix", () => {
    // U23. `a/b` is a legal quoted identifier on PostgreSQL, MySQL and Oracle. Joining the
    // segments raw gave the container `["a/b"]` and the `b` folder of container `["a"]` the
    // same string, and that string is React's list key, the expansion-set member and the
    // objects cache key, so one row's twisty opened the other.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [
        { path: ["a"], name: "a", level: 0 },
        { path: ["a/table"], name: "a/table", level: 0 },
      ],
      expanded: new Set(["a"]),
      counts: {},
      objects: {},
    });
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The folder keeps the readable spelling; the exotic name is the one that is escaped.
    expect(rows.find((r) => r.kind === "folder" && r.kindId === "table")?.id).toBe("a/table");
    expect(rows.filter((r) => r.kind === "container").map((r) => r.id)).toEqual(["a", "a%2Ftable"]);
  });

  test("the escape character is itself escaped, so two exotic names cannot converge", () => {
    // Without escaping the escape, a container literally named `a%2Fb` and one named `a/b`
    // both encode to `a%2Fb`. The pair is what makes the encoding injective rather than
    // merely different in the one case U23 reported.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [
        { path: ["a/b"], name: "a/b", level: 0 },
        { path: ["a%2Fb"], name: "a%2Fb", level: 0 },
      ],
      expanded: new Set<string>(),
      counts: {},
      objects: {},
    });
    expect(rows.map((r) => r.id)).toEqual(["a%2Fb", "a%252Fb"]);
  });

  test("a folder and an object whose segments hold the separator keep their own ids", () => {
    // The same rule reaches the other two id shapes: a folder id is the container path plus
    // the kind, an object id is the object path plus the kind, and both are built from the
    // same encoder rather than from a second copy of the rule.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["a/b"], name: "a/b", level: 0 }],
      expanded: new Set(["a%2Fb", "a%2Fb/table"]),
      counts: { "a%2Fb": { table: { count: 1 } } },
      objects: { "a%2Fb/table": [{ path: ["a/b", "c/d"], name: "c/d", kind: "table" }] },
    });
    expect(rows.filter((r) => r.kind !== "container").map((r) => r.id)).toEqual([
      "a%2Fb/table",
      "a%2Fb/c%2Fd/table",
      "a%2Fb/view",
      "a%2Fb/procedure",
    ]);
    // The badge proves the counts key is built by that same encoder: a lookup under the raw
    // join would miss this container and leave the folder unbadged.
    expect(rows.find((r) => r.kind === "folder" && r.kindId === "table")?.badge).toBe("1");
  });

  test("a container row carries no kind id", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set<string>(),
      counts: {},
      objects: {},
    });
    expect(rows[0]?.kindId).toBeUndefined();
    expect(rows[0]?.path).toEqual(["app"]);
  });
});

describe("flattenTree labels", () => {
  test("an object row is labelled by its name and never by its path segment", () => {
    // Standing ruling 2: a routine's path segment carries its argument types so that two
    // overloads have two addresses, and `name` is the display label. A label read off the
    // path would show `order_total(integer)` to a person.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/procedure"]),
      counts: {},
      objects: {
        "app/procedure": [
          { path: ["app", "order_total(integer)"], name: "order_total", kind: "procedure" },
          { path: ["app", "order_total(text)"], name: "order_total", kind: "procedure" },
        ],
      },
    });
    const objects = rows.filter((r) => r.kind === "object");
    expect(objects.map((r) => r.label)).toEqual(["order_total", "order_total"]);
    expect(objects.map((r) => r.id)).toEqual(["app/order_total(integer)/procedure", "app/order_total(text)/procedure"]);
  });

  test("a folder is labelled by the engine's own plural and a container by its name", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["reporting"], name: "reporting", level: 0 }],
      expanded: new Set(["reporting"]),
      counts: {},
      objects: {},
    });
    expect(rows.map((r) => r.label)).toEqual(["reporting", "Tables", "Views", "Procedures"]);
  });
});

describe("flattenTree folder set", () => {
  test("the folders come from the declaration in declaration order, not from the counts keys", () => {
    // A count answers for a folder; it never decides that the folder exists. The engine
    // declaring the kind is what draws it, so a container whose counts have not arrived
    // still shows every folder, and one that answered for a single kind shows the rest
    // without a badge rather than hiding them.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app"]),
      counts: { app: { procedure: { count: 3 }, table: { count: 1 } } },
      objects: {},
    });
    expect(rows.filter((r) => r.kind === "folder").map((r) => r.kindId)).toEqual(["table", "view", "procedure"]);
    expect(rows.find((r) => r.kindId === "view")?.badge).toBeUndefined();
  });

  test("a container with no counts at all still draws every declared folder", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app"]),
      counts: {},
      objects: {},
    });
    expect(rows.filter((r) => r.kind === "folder")).toHaveLength(3);
    expect(rows.every((r) => r.badge === undefined)).toBe(true);
  });
});

describe("flattenTree expandability", () => {
  test("a folder whose objects have not been loaded is still expandable", () => {
    // Expandability is declared, never inferred from what is cached: a folder that reads
    // as a leaf until its own contents arrive can never be opened to fetch them.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { count: 9 } } },
      objects: {},
    });
    expect(rows.find((r) => r.kindId === "table")).toMatchObject({ expanded: true });
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("a folder loaded as empty is expandable, expanded and childless", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { count: 0 } } },
      objects: { "app/table": [] },
    });
    expect(rows.find((r) => r.kindId === "table")).toMatchObject({ expanded: true, badge: "0" });
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("a collapsed folder holds its loaded objects back", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app"]),
      counts: { app: { table: { count: 1 } } },
      objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
    });
    expect(rows.find((r) => r.kindId === "table")).toMatchObject({ expanded: false });
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("a folder whose count was refused is a leaf and yields no children", () => {
    // Task 6 renders the sentence in place of the badge and offers no twisty. The row model
    // is the single source of that, so the refusal has to reach it as an absent `expanded`
    // rather than as something the row component works out for itself.
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { unavailable: "permission denied for schema app" } } },
      objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
    });
    const table = rows.find((r) => r.kindId === "table");
    expect(table?.expanded).toBeUndefined();
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("an object is a leaf", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: {},
      objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
    });
    expect(rows.find((r) => r.kind === "object")?.expanded).toBeUndefined();
  });
});

const packageKinds = [
  { id: "package", role: "group", label: "Package", labelPlural: "Packages", childKinds: ["procedure", "type"] },
  { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
  { id: "type", role: "config", label: "Type", labelPlural: "Types" },
] as const;

describe("flattenTree object children", () => {
  test("an object whose kind declares child kinds is still a leaf in Phase 1", () => {
    // `childKinds` is a true claim about the engine: an Oracle package really does hold
    // routines. Nothing can FILL that folder yet, because `countObjects(container)` and
    // `listObjects(container, kind)` are both container-scoped and no method lists the
    // children of one object, so a nested Procedures folder would draw, never badge, and
    // open on nothing. It renders when that method exists (#789).
    const rows = flattenTree({
      kinds: packageKinds,
      containerDepth: 1,
      containers: [{ path: ["hr"], name: "hr", level: 0 }],
      expanded: new Set(["hr", "hr/package", "hr/payroll/package"]),
      counts: { hr: { package: { count: 1 }, procedure: { count: 4 } } },
      objects: { "hr/package": [{ path: ["hr", "payroll"], name: "payroll", kind: "package" }] },
    });
    expect(rows.map((r) => `${r.depth}:${r.kind}:${r.posInSet}/${r.setSize}:${r.id}`)).toEqual([
      "0:container:1/1:hr",
      "1:folder:1/3:hr/package",
      "2:object:1/1:hr/payroll/package",
      "1:folder:2/3:hr/procedure",
      "1:folder:3/3:hr/type",
    ]);
    expect(rows.find((r) => r.kind === "object")?.expanded).toBeUndefined();
  });

  test("an object of a kind the provider never declared is a leaf rather than a crash", () => {
    const rows = flattenTree({
      kinds: packageKinds,
      containerDepth: 1,
      containers: [{ path: ["hr"], name: "hr", level: 0 }],
      expanded: new Set(["hr", "hr/procedure", "hr/legacy/synonym"]),
      counts: {},
      objects: { "hr/procedure": [{ path: ["hr", "legacy"], name: "legacy", kind: "synonym" }] },
    });
    const object = rows.find((r) => r.kind === "object");
    expect(object?.id).toBe("hr/legacy/synonym");
    expect(object?.expanded).toBeUndefined();
    expect(rows.filter((r) => r.depth > 2)).toHaveLength(0);
  });
});

describe("flattenTree object rows", () => {
  test("objects carry their own aria positions inside their folder", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { count: 3 } } },
      objects: {
        "app/table": [
          { path: ["app", "orders"], name: "orders", kind: "table" },
          { path: ["app", "customers"], name: "customers", kind: "table" },
          { path: ["app", "invoices"], name: "invoices", kind: "table" },
        ],
      },
    });
    const objects = rows.filter((r) => r.kind === "object");
    expect(objects.map((r) => `${r.depth}:${r.posInSet}/${r.setSize}`)).toEqual(["2:1/3", "2:2/3", "2:3/3"]);
    expect(objects.map((r) => r.path)).toEqual([
      ["app", "orders"],
      ["app", "customers"],
      ["app", "invoices"],
    ]);
  });

  test("an object row carries no badge, because a row count is an estimate and a badge is a count", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 1,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: {},
      objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1200 }] },
    });
    expect(rows.find((r) => r.kind === "object")?.badge).toBeUndefined();
  });
});

describe("flattenTree container levels", () => {
  test("two declared levels nest, and only the deeper level carries folders", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 2,
      containers: [
        { path: ["main"], name: "main", level: 0 },
        { path: ["main", "app"], name: "app", level: 1 },
        { path: ["main", "sales"], name: "sales", level: 1 },
        { path: ["archive"], name: "archive", level: 0 },
        // Belongs to the OTHER catalog, which is collapsed. A child group matched on
        // length alone, or on nothing, would hang it under `main`.
        { path: ["archive", "legacy"], name: "legacy", level: 1 },
      ],
      expanded: new Set(["main", "main/app"]),
      counts: { "main/app": { table: { count: 7 } } },
      objects: {},
    });
    expect(rows.map((r) => `${r.depth}:${r.posInSet}/${r.setSize}:${r.id}`)).toEqual([
      "0:1/2:main",
      "1:1/2:main/app",
      "2:1/3:main/app/table",
      "2:2/3:main/app/view",
      "2:3/3:main/app/procedure",
      "1:2/2:main/sales",
      "0:2/2:archive",
    ]);
    expect(rows.find((r) => r.id === "main/app/table")?.badge).toBe("7");
  });

  test("a schema under an unexpanded catalog stays out of the flat list", () => {
    const rows = flattenTree({
      kinds,
      containerDepth: 2,
      containers: [
        { path: ["main"], name: "main", level: 0 },
        { path: ["main", "app"], name: "app", level: 1 },
      ],
      expanded: new Set<string>(),
      counts: {},
      objects: {},
    });
    expect(rows.map((r) => r.id)).toEqual(["main"]);
  });

  test("an engine with no container level puts its folders at the root", () => {
    // sqlite, libsql, elasticsearch, opensearch and libredb have no container at all, so
    // the kind folders themselves are the top row group and the container path is empty.
    const rows = flattenTree({
      kinds,
      containerDepth: 0,
      containers: [],
      expanded: new Set(["table"]),
      counts: { "": { table: { count: 2 }, view: { count: 0 }, procedure: { count: 0 } } },
      objects: { table: [{ path: ["orders"], name: "orders", kind: "table" }] },
    });
    expect(rows.map((r) => `${r.depth}:${r.posInSet}/${r.setSize}:${r.id}`)).toEqual([
      "0:1/3:table",
      "1:1/1:orders/table",
      "0:2/3:view",
      "0:3/3:procedure",
    ]);
    expect(rows[0]?.badge).toBe("2");
    expect(rows[0]?.path).toEqual([]);
  });

  test("a provider that declares no container level renders its folders, not an empty tree", () => {
    // The depth is whatever `containerDepth()` answered, and this walks the real helper
    // rather than a number typed here: `ProviderCapabilities.containerLevels` says absent
    // and empty both mean the engine has none, so a provider that omits the field entirely
    // must reach the same tree as one declaring `[]`. Reading the field by length in this
    // module instead would have answered one level and drawn nothing at all, since a
    // no-container engine has no container row to hang the folders under.
    const declaresNothing: ProviderCapabilities = {
      queryLanguage: "sql",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      schemaRefreshPattern: "",
      objectKinds: kinds,
    };
    const rows = flattenTree({
      kinds,
      containerDepth: containerDepth(declaresNothing),
      containers: [],
      expanded: new Set<string>(),
      counts: { "": { table: { count: 5 } } },
      objects: {},
    });
    expect(containerDepth(declaresNothing)).toBe(0);
    expect(rows.map((r) => `${r.depth}:${r.posInSet}/${r.setSize}:${r.id}`)).toEqual([
      "0:1/3:table",
      "0:2/3:view",
      "0:3/3:procedure",
    ]);
    expect(rows[0]?.badge).toBe("5");
  });
});
