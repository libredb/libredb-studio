import { describe, test, expect } from "bun:test";
import { flattenTree } from "@/components/object-tree/flatten";

const kinds = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
] as const;

describe("flattenTree", () => {
  test("a collapsed container yields one row and no children", () => {
    const rows = flattenTree({
      kinds,
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
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { count: 43512 }, view: { count: 0 }, procedure: { count: 0 } } },
      objects: { "app/table": [{ path: ["app", "a"], name: "a", kind: "table" }] },
    });
    expect(rows.find((r) => r.kindId === "table" && r.kind === "folder")?.badge).toBe("43,512");
  });
});

describe("flattenTree row identity", () => {
  test("a row id is its path joined with a slash, plus the kind id on folders and objects", () => {
    const rows = flattenTree({
      kinds,
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

  test("a container row carries no kind id", () => {
    const rows = flattenTree({
      kinds,
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
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: { app: { table: { unavailable: "permission denied for schema app" } } },
      objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
    });
    const table = rows.find((r) => r.kindId === "table");
    expect(table?.expanded).toBeUndefined();
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("an object is a leaf unless its kind declares child kinds", () => {
    const rows = flattenTree({
      kinds,
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
  test("an object of a kind declaring child kinds is expandable and nests its own folders", () => {
    const rows = flattenTree({
      kinds: packageKinds,
      containers: [{ path: ["hr"], name: "hr", level: 0 }],
      expanded: new Set(["hr", "hr/package", "hr/payroll/package", "hr/payroll/procedure"]),
      counts: { hr: { package: { count: 1 }, procedure: { count: 4 } } },
      objects: {
        "hr/package": [{ path: ["hr", "payroll"], name: "payroll", kind: "package" }],
        "hr/payroll/procedure": [{ path: ["hr", "payroll", "run"], name: "run", kind: "procedure" }],
      },
    });
    expect(rows.map((r) => `${r.depth}:${r.kind}:${r.posInSet}/${r.setSize}:${r.id}`)).toEqual([
      "0:container:1/1:hr",
      "1:folder:1/3:hr/package",
      "2:object:1/1:hr/payroll/package",
      "3:folder:1/2:hr/payroll/procedure",
      "4:object:1/1:hr/payroll/run/procedure",
      "3:folder:2/2:hr/payroll/type",
      "1:folder:2/3:hr/procedure",
      "1:folder:3/3:hr/type",
    ]);
  });

  test("a child kind the provider never declared draws no folder and does not inflate the set size", () => {
    // `childKinds` names ids; only the declaration carries the label a folder needs. This
    // provider holds packages and procedures and has no `type` kind at all.
    const rows = flattenTree({
      kinds: packageKinds.filter((spec) => spec.id !== "type"),
      containers: [{ path: ["hr"], name: "hr", level: 0 }],
      expanded: new Set(["hr", "hr/package", "hr/payroll/package"]),
      counts: {},
      objects: { "hr/package": [{ path: ["hr", "payroll"], name: "payroll", kind: "package" }] },
    });
    const nested = rows.filter((r) => r.depth === 3);
    expect(nested.map((r) => r.id)).toEqual(["hr/payroll/procedure"]);
    expect(nested[0]?.setSize).toBe(1);
  });

  test("an object of an undeclared kind is a leaf rather than a crash", () => {
    const rows = flattenTree({
      kinds: packageKinds,
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
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app", "app/table"]),
      counts: {},
      objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1200 }] },
    });
    expect(rows.find((r) => r.kind === "object")?.badge).toBeUndefined();
  });
});

const twoLevels = [
  { id: "catalog", label: "Database", labelPlural: "Databases" },
  { id: "schema", label: "Schema", labelPlural: "Schemas" },
] as const;

describe("flattenTree container levels", () => {
  test("two declared levels nest, and only the deeper level carries folders", () => {
    const rows = flattenTree({
      kinds,
      containerLevels: twoLevels,
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
      containerLevels: twoLevels,
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
      containerLevels: [],
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

  test("one declared level renders exactly what the default does", () => {
    const state = {
      kinds,
      containers: [{ path: ["app"], name: "app", level: 0 }],
      expanded: new Set(["app"]),
      counts: { app: { table: { count: 2 } } },
      objects: {},
    };
    const declared = flattenTree({
      ...state,
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
    });
    expect(declared).toEqual(flattenTree(state));
    expect(declared.map((r) => r.id)).toEqual(["app", "app/table", "app/view", "app/procedure"]);
  });
});
