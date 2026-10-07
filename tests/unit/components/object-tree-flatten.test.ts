import { describe, test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { flattenTree, type FlattenTreeState, type TreeRowModel } from "@/components/object-tree/flatten";
import { TreeRow, type TreeRowProps } from "@/components/object-tree/TreeRow";
import { containerDepth } from "@/lib/db/object-kinds";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";

const kinds = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
] as const;

/** The same three kinds, with the relation that has columns declaring it. */
const columnKinds = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  { id: "trigger", role: "config", label: "Trigger", labelPlural: "Triggers" },
] as const;

/**
 * One walk's input, with the two fields every case would otherwise repeat.
 *
 * `readsColumns` defaults to TRUE rather than false, which is the opposite of the walk's own
 * caller-side default and is deliberate. With a false default the two leaf cases below would
 * pass because no tree in this file reads columns at all, rather than because their fixture
 * kind declares none, and they would keep passing if that kind ever declared `hasColumns`.
 * The one case that wants the flag off passes it explicitly.
 */
function stateOf(
  partial: Omit<FlattenTreeState, "details" | "readsColumns"> &
    Partial<Pick<FlattenTreeState, "details" | "readsColumns">>,
): FlattenTreeState {
  return { details: {}, readsColumns: true, ...partial };
}

describe("flattenTree", () => {
  test("a collapsed container yields one row and no children", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set<string>(),
        counts: {},
        objects: {},
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "container", depth: 0, setSize: 1, posInSet: 1, expanded: false });
  });

  test("aria positions are per sibling group, not per visible row", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [
          { path: ["app"], name: "app", level: 0 },
          { path: ["sales"], name: "sales", level: 0 },
        ],
        expanded: new Set(["app"]),
        counts: { app: { table: { count: 2 }, view: { count: 0 }, procedure: { count: 1 } } },
        objects: {},
      }),
    );
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
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app"]),
        counts: { app: { table: { count: 2 }, view: { count: 0 }, procedure: { count: 1 } } },
        objects: {},
      }),
    );
    expect(rows.find((r) => r.kindId === "view")).toMatchObject({ kind: "folder", badge: "0" });
  });

  test("a refused count carries the engine's sentence and no number", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["sales"], name: "sales", level: 0 }],
        expanded: new Set(["sales"]),
        counts: { sales: { table: { unavailable: "permission denied for schema sales" } } },
        objects: {},
      }),
    );
    const table = rows.find((r) => r.kindId === "table");
    expect(table?.badge).toBeUndefined();
    expect(table?.unavailable).toBe("permission denied for schema sales");
  });

  test("a kind the engine never declared produces no row at all", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app"]),
        counts: { app: { table: { count: 1 }, view: { count: 0 }, procedure: { count: 0 } } },
        objects: {},
      }),
    );
    expect(rows.some((r) => r.kindId === "package")).toBe(false);
  });

  test("a sampled count is a FLOOR and the badge says so, which a bare number cannot", () => {
    // The four facts this tree has to keep apart: a kind the engine does not have draws no
    // folder, `{ count: 0 }` is a zero badge, `{ unavailable }` is the engine's sentence, and a
    // bounded read is a number that is only a lower bound. Redis walks 1000 keys and collapses
    // them into groupings, so a badge reading 4 there means "at least 4" and a badge reading 4
    // on the catalog-counted kind beside it means exactly 4. Rendering both as `4` states a
    // fact the provider never measured (#789, backlog X13).
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["0"], name: "0", level: 0 }],
        expanded: new Set(["0"]),
        counts: {
          0: {
            table: { count: 1204, sampledFrom: "one 1,000-key SCAN walk" },
            view: { count: 1204 },
            procedure: { count: 0 },
          },
        },
        objects: {},
      }),
    );
    const sampled = rows.find((r) => r.kindId === "table");
    const exact = rows.find((r) => r.kindId === "view");
    expect(sampled?.badge).toBe("1,204+");
    expect(sampled?.badgeTitle).toBe("At least 1,204: counted from one 1,000-key SCAN walk");
    // The same number counted from a catalog must not pick up either mark.
    expect(exact?.badge).toBe("1,204");
    expect(exact?.badgeTitle).toBeUndefined();
    // And a sampled count is not a refusal: the folder still opens.
    expect(sampled?.unavailable).toBeUndefined();
    expect(sampled?.expanded).toBe(false);
  });

  test("a sampled count of zero still reads as a floor, not as an engine holding none", () => {
    // A bounded walk that saw nothing has not proved the container is empty, so `0+` and `0`
    // stay different rows. This is the arm a `count > 0` guard would collapse.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["0"], name: "0", level: 0 }],
        expanded: new Set(["0"]),
        counts: { 0: { table: { count: 0, sampledFrom: "one 1,000-key SCAN walk" } } },
        objects: {},
      }),
    );
    expect(rows.find((r) => r.kindId === "table")?.badge).toBe("0+");
  });

  test("a folder badge never comes from the loaded object list", () => {
    // The list is capped by the route; the count is a real COUNT. Reading the length back
    // as a count is how a saturated list passes every gate while being wrong.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table"]),
        counts: { app: { table: { count: 43512 }, view: { count: 0 }, procedure: { count: 0 } } },
        objects: { "app/table": [{ path: ["app", "a"], name: "a", kind: "table" }] },
      }),
    );
    expect(rows.find((r) => r.kindId === "table" && r.kind === "folder")?.badge).toBe("43,512");
  });
});

describe("flattenTree row identity", () => {
  test("a row id is its path segments escaped and joined with a slash, plus the kind id on folders and objects", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table"]),
        counts: { app: { table: { count: 1 } } },
        objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
      }),
    );
    // Depth first: an expanded folder's objects come before the next sibling folder.
    expect(rows.map((r) => r.id)).toEqual(["app", "app/table", "app/orders/table", "app/view", "app/procedure"]);
  });

  test("two objects sharing a path but not a kind get two ids", () => {
    // Standing ruling 3: paths are unique WITHIN a kind and deliberately not across kinds,
    // and this is the property that permission rests on. MySQL allows a table and a routine
    // to share a name in one schema.
    const rows = flattenTree(
      stateOf({
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
      }),
    );
    const objectIds = rows.filter((r) => r.kind === "object").map((r) => r.id);
    expect(objectIds).toEqual(["app/audit/table", "app/audit/procedure"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test("a container whose name holds the separator does not take the id of a folder under its prefix", () => {
    // U23. `a/b` is a legal quoted identifier on PostgreSQL, MySQL and Oracle. Joining the
    // segments raw gave the container `["a/b"]` and the `b` folder of container `["a"]` the
    // same string, and that string is React's list key, the expansion-set member and the
    // objects cache key, so one row's twisty opened the other.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [
          { path: ["a"], name: "a", level: 0 },
          { path: ["a/table"], name: "a/table", level: 0 },
        ],
        expanded: new Set(["a"]),
        counts: {},
        objects: {},
      }),
    );
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
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [
          { path: ["a/b"], name: "a/b", level: 0 },
          { path: ["a%2Fb"], name: "a%2Fb", level: 0 },
        ],
        expanded: new Set<string>(),
        counts: {},
        objects: {},
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["a%2Fb", "a%252Fb"]);
  });

  test("a folder and an object whose segments hold the separator keep their own ids", () => {
    // The same rule reaches the other two id shapes: a folder id is the container path plus
    // the kind, an object id is the object path plus the kind, and both are built from the
    // same encoder rather than from a second copy of the rule.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["a/b"], name: "a/b", level: 0 }],
        expanded: new Set(["a%2Fb", "a%2Fb/table"]),
        counts: { "a%2Fb": { table: { count: 1 } } },
        objects: { "a%2Fb/table": [{ path: ["a/b", "c/d"], name: "c/d", kind: "table" }] },
      }),
    );
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
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set<string>(),
        counts: {},
        objects: {},
      }),
    );
    expect(rows[0]?.kindId).toBeUndefined();
    expect(rows[0]?.path).toEqual(["app"]);
  });

  test("a column row cannot take the id of an object row, however the two are named", () => {
    // The pair is reachable rather than theoretical, and it is legal on SQLite, PostgreSQL,
    // MySQL and Oracle: a column named `trigger` on table `orders` gives the naive sequence
    // ["orders", "table", "trigger"], and a trigger literally named `table` on `orders` has
    // the path ["orders", "table"] and the kind "trigger", which is the same sequence. The id
    // is React's list key, the `expanded` member and the `data-row-id` the focus effect matches
    // on, so one key for two rows opens one row's twisty on the other (#789).
    const rows = flattenTree(
      stateOf({
        kinds: columnKinds,
        containerDepth: 0,
        containers: [],
        expanded: new Set(["table", "trigger", "orders/table"]),
        counts: {},
        objects: {
          table: [{ path: ["orders"], name: "orders", kind: "table" }],
          trigger: [{ path: ["orders", "table"], name: "table", kind: "trigger" }],
        },
        details: {
          "orders/table": {
            path: ["orders"],
            columns: [{ name: "trigger", type: "INTEGER", nullable: true, isPrimary: false }],
            indexes: [],
            foreignKeys: [],
          },
        },
      }),
    );
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.find((r) => r.kind === "column")?.id).toBe("column%3Aorders/table/trigger");
    expect(rows.find((r) => r.kindId === "trigger" && r.kind === "object")?.id).toBe("orders/table/trigger");
  });
});

describe("flattenTree labels", () => {
  test("an object row is labelled by its name and never by its path segment", () => {
    // Standing ruling 2: a routine's path segment carries its argument types so that two
    // overloads have two addresses, and `name` is the display label. A label read off the
    // path would show `order_total(integer)` to a person.
    const rows = flattenTree(
      stateOf({
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
      }),
    );
    const objects = rows.filter((r) => r.kind === "object");
    expect(objects.map((r) => r.label)).toEqual(["order_total", "order_total"]);
    expect(objects.map((r) => r.id)).toEqual(["app/order_total(integer)/procedure", "app/order_total(text)/procedure"]);
  });

  test("a folder is labelled by the engine's own plural and a container by its name", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["reporting"], name: "reporting", level: 0 }],
        expanded: new Set(["reporting"]),
        counts: {},
        objects: {},
      }),
    );
    expect(rows.map((r) => r.label)).toEqual(["reporting", "Tables", "Views", "Procedures"]);
  });
});

describe("flattenTree folder set", () => {
  test("the folders come from the declaration in declaration order, not from the counts keys", () => {
    // A count answers for a folder; it never decides that the folder exists. The engine
    // declaring the kind is what draws it, so a container whose counts have not arrived
    // still shows every folder, and one that answered for a single kind shows the rest
    // without a badge rather than hiding them.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app"]),
        counts: { app: { procedure: { count: 3 }, table: { count: 1 } } },
        objects: {},
      }),
    );
    expect(rows.filter((r) => r.kind === "folder").map((r) => r.kindId)).toEqual(["table", "view", "procedure"]);
    expect(rows.find((r) => r.kindId === "view")?.badge).toBeUndefined();
  });

  test("a container with no counts at all still draws every declared folder", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app"]),
        counts: {},
        objects: {},
      }),
    );
    expect(rows.filter((r) => r.kind === "folder")).toHaveLength(3);
    expect(rows.every((r) => r.badge === undefined)).toBe(true);
  });
});

describe("flattenTree expandability", () => {
  test("a folder whose objects have not been loaded is still expandable", () => {
    // Expandability is declared, never inferred from what is cached: a folder that reads
    // as a leaf until its own contents arrive can never be opened to fetch them.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table"]),
        counts: { app: { table: { count: 9 } } },
        objects: {},
      }),
    );
    expect(rows.find((r) => r.kindId === "table")).toMatchObject({ expanded: true });
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("a folder loaded as empty is expandable, expanded and childless", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table"]),
        counts: { app: { table: { count: 0 } } },
        objects: { "app/table": [] },
      }),
    );
    expect(rows.find((r) => r.kindId === "table")).toMatchObject({ expanded: true, badge: "0" });
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("a collapsed folder holds its loaded objects back", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app"]),
        counts: { app: { table: { count: 1 } } },
        objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
      }),
    );
    expect(rows.find((r) => r.kindId === "table")).toMatchObject({ expanded: false });
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("a folder whose count was refused is a leaf and yields no children", () => {
    // Task 6 renders the sentence in place of the badge and offers no twisty. The row model
    // is the single source of that, so the refusal has to reach it as an absent `expanded`
    // rather than as something the row component works out for itself.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table"]),
        counts: { app: { table: { unavailable: "permission denied for schema app" } } },
        objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
      }),
    );
    const table = rows.find((r) => r.kindId === "table");
    expect(table?.expanded).toBeUndefined();
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(0);
  });

  test("an object of a kind that declares no columns is a leaf", () => {
    // The gate is the DECLARATION and never the answer: `table` here declares nothing, so the
    // row carries no `expanded`, no read is derived for it and no twisty opens on nothing.
    // `stateOf` reads columns by default, so this is the kind's own statement failing to
    // declare them and not the tree being unable to read any.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table"]),
        counts: {},
        objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
      }),
    );
    expect(rows.find((r) => r.kind === "object")?.expanded).toBeUndefined();
  });
});

const packageKinds = [
  { id: "package", role: "group", label: "Package", labelPlural: "Packages", childKinds: ["procedure", "type"] },
  { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
  { id: "type", role: "config", label: "Type", labelPlural: "Types" },
] as const;

describe("flattenTree object children", () => {
  test("a kind that declares `childKinds` is still a leaf, because no method lists an object's children", () => {
    // `childKinds` is a true claim about the engine: an Oracle package really does hold
    // routines. Nothing can FILL that folder, because `countObjects(container)` and
    // `listObjects(container, kind)` are both container-scoped and no method lists the
    // children of one object, so a nested Procedures folder would draw, never badge, and
    // open on nothing. It renders when that method exists (#789). COLUMNS are the other
    // half and are not blocked by it: `describeObject(path, kind)` is object-scoped and
    // every provider implements it, which is why a kind declaring `hasColumns` does expand.
    const rows = flattenTree(
      stateOf({
        kinds: packageKinds,
        containerDepth: 1,
        containers: [{ path: ["hr"], name: "hr", level: 0 }],
        expanded: new Set(["hr", "hr/package", "hr/payroll/package"]),
        counts: { hr: { package: { count: 1 }, procedure: { count: 4 } } },
        objects: { "hr/package": [{ path: ["hr", "payroll"], name: "payroll", kind: "package" }] },
      }),
    );
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
    const rows = flattenTree(
      stateOf({
        kinds: packageKinds,
        containerDepth: 1,
        containers: [{ path: ["hr"], name: "hr", level: 0 }],
        expanded: new Set(["hr", "hr/procedure", "hr/legacy/synonym"]),
        counts: {},
        objects: { "hr/procedure": [{ path: ["hr", "legacy"], name: "legacy", kind: "synonym" }] },
      }),
    );
    const object = rows.find((r) => r.kind === "object");
    expect(object?.id).toBe("hr/legacy/synonym");
    expect(object?.expanded).toBeUndefined();
    expect(rows.filter((r) => r.depth > 2)).toHaveLength(0);
  });
});

describe("flattenTree object rows", () => {
  test("objects carry their own aria positions inside their folder", () => {
    const rows = flattenTree(
      stateOf({
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
      }),
    );
    const objects = rows.filter((r) => r.kind === "object");
    expect(objects.map((r) => `${r.depth}:${r.posInSet}/${r.setSize}`)).toEqual(["2:1/3", "2:2/3", "2:3/3"]);
    expect(objects.map((r) => r.path)).toEqual([
      ["app", "orders"],
      ["app", "customers"],
      ["app", "invoices"],
    ]);
  });

  test("an object row carries no badge, because a row count is an estimate and a badge is a count", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table"]),
        counts: {},
        objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1200 }] },
      }),
    );
    expect(rows.find((r) => r.kind === "object")?.badge).toBeUndefined();
  });
});

describe("flattenTree container levels", () => {
  test("two declared levels nest, and only the deeper level carries folders", () => {
    const rows = flattenTree(
      stateOf({
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
      }),
    );
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
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 2,
        containers: [
          { path: ["main"], name: "main", level: 0 },
          { path: ["main", "app"], name: "app", level: 1 },
        ],
        expanded: new Set<string>(),
        counts: {},
        objects: {},
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["main"]);
  });

  test("an engine with no container level puts its folders at the root", () => {
    // sqlite, libsql, elasticsearch, opensearch and libredb have no container at all, so
    // the kind folders themselves are the top row group and the container path is empty.
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 0,
        containers: [],
        expanded: new Set(["table"]),
        counts: { "": { table: { count: 2 }, view: { count: 0 }, procedure: { count: 0 } } },
        objects: { table: [{ path: ["orders"], name: "orders", kind: "table" }] },
      }),
    );
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
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: containerDepth(declaresNothing),
        containers: [],
        expanded: new Set<string>(),
        counts: { "": { table: { count: 5 } } },
        objects: {},
      }),
    );
    expect(containerDepth(declaresNothing)).toBe(0);
    expect(rows.map((r) => `${r.depth}:${r.posInSet}/${r.setSize}:${r.id}`)).toEqual([
      "0:1/3:table",
      "0:2/3:view",
      "0:3/3:procedure",
    ]);
    expect(rows[0]?.badge).toBe("5");
  });
});

/**
 * Columns under an open object row (#789).
 *
 * The state this group exists to keep apart is ABSENT versus EMPTY in `details`, exactly as the
 * `objects` map already has to: a missing key is "not read yet" and the cache that owns the map
 * draws the busy row for it, while a key holding `columns: []` is a real answer from four
 * measured engines and has to say so on the object row. Asking whether the value is empty
 * collapses the two, which is how a tree spins for ever or reports a read that never happened.
 */
const ordersColumns = [
  { name: "id", type: "integer", nullable: false, isPrimary: true },
  { name: "total", type: "NUMERIC(10,2)", nullable: true, isPrimary: false },
] as const;

function detailOf(columns: readonly { name: string; type: string; nullable: boolean; isPrimary: boolean }[]) {
  return { path: ["app", "orders"], columns, indexes: [], foreignKeys: [] };
}

const ordersOpen = {
  kinds: columnKinds,
  containerDepth: 1,
  containers: [{ path: ["app"], name: "app", level: 0 }],
  expanded: new Set(["app", "app/table", "app/orders/table"]),
  counts: {},
  objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
} as const;

describe("flattenTree column rows", () => {
  test("an open object of a kind that declares columns emits one leaf row per column", () => {
    const rows = flattenTree(stateOf({ ...ordersOpen, details: { "app/orders/table": detailOf(ordersColumns) } }));
    expect(rows.map((r) => `${r.depth}:${r.kind}:${r.posInSet}/${r.setSize}:${r.id}`)).toEqual([
      "0:container:1/1:app",
      "1:folder:1/3:app/table",
      "2:object:1/1:app/orders/table",
      "3:column:1/2:column%3Aapp/orders/table/id",
      "3:column:2/2:column%3Aapp/orders/table/total",
      "1:folder:2/3:app/view",
      "1:folder:3/3:app/trigger",
    ]);
  });

  test("a column row carries the column and none of an object row's addressing", () => {
    // It addresses something no `listObjects` answer ever named, which is the point: without a
    // kind id `objectFor` misses by construction, so the parent table's menu, status and row
    // count cannot reach it.
    const rows = flattenTree(stateOf({ ...ordersOpen, details: { "app/orders/table": detailOf(ordersColumns) } }));
    const total = rows.find((r) => r.kind === "column" && r.label === "total");
    expect(total).toMatchObject({ label: "total", depth: 3, path: ["app", "orders", "total"] });
    expect(total?.expanded).toBeUndefined();
    expect(total?.badge).toBeUndefined();
    expect(total?.kindId).toBeUndefined();
    expect(total?.unavailable).toBeUndefined();
    expect(total?.column).toEqual({ name: "total", type: "NUMERIC(10,2)", nullable: true, isPrimary: false });
    // The provider's order, verbatim: Cassandra orders partition key, then clustering, then
    // alphabetical, and no client sort may reorder that on the way to the screen.
    expect(rows.filter((r) => r.kind === "column").map((r) => r.label)).toEqual(["id", "total"]);
  });

  test("an open object whose detail has not arrived is open, childless and says nothing", () => {
    // No key in `details` is the UNREAD state. The row stays open so the spinner the cache draws
    // has somewhere to be, and it must not claim the engine answered with nothing.
    const rows = flattenTree(stateOf(ordersOpen));
    const orders = rows.find((r) => r.kind === "object");
    expect(orders?.expanded).toBe(true);
    expect(orders?.unavailable).toBeUndefined();
    expect(rows.filter((r) => r.kind === "column")).toHaveLength(0);
  });

  test("an open object whose detail carries no column says so, which an empty expansion cannot", () => {
    // A PRESENT key holding `columns: []` is a real answer: an object dropped between the
    // listing and the expand, a Couchbase INFER the reader has no SELECT grant for, an empty
    // collection, a Cassandra UDT with no field. Silence would make those four, the unread row
    // and a rendering bug one screen.
    const rows = flattenTree(stateOf({ ...ordersOpen, details: { "app/orders/table": detailOf([]) } }));
    const orders = rows.find((r) => r.kind === "object");
    expect(orders?.expanded).toBe(true);
    expect(orders?.unavailable).toBe("No columns reported");
    expect(rows.filter((r) => r.kind === "column")).toHaveLength(0);
  });

  test("a CLOSED object says nothing, whatever its detail holds", () => {
    // The sentence answers a question the reader asked. Nobody asked on a closed row, so a
    // cached empty answer must not put a warning on a row that is merely shut.
    const rows = flattenTree(
      stateOf({
        ...ordersOpen,
        expanded: new Set(["app", "app/table"]),
        details: { "app/orders/table": detailOf([]) },
      }),
    );
    const orders = rows.find((r) => r.kind === "object");
    expect(orders?.expanded).toBe(false);
    expect(orders?.unavailable).toBeUndefined();
  });

  test("a collapsed object holds its loaded columns back", () => {
    const rows = flattenTree(
      stateOf({
        ...ordersOpen,
        expanded: new Set(["app", "app/table"]),
        details: { "app/orders/table": detailOf(ordersColumns) },
      }),
    );
    expect(rows.find((r) => r.kind === "object")?.expanded).toBe(false);
    expect(rows.filter((r) => r.kind === "column")).toHaveLength(0);
  });

  test("only the kind that declares columns gets a twisty, in one tree with a kind that does not", () => {
    // The contrast is what makes the declaration the gate rather than the row kind. Both rows
    // are objects, both are open in the expansion set, and only one of them can be opened.
    const rows = flattenTree(
      stateOf({
        kinds: columnKinds,
        containerDepth: 1,
        containers: [{ path: ["app"], name: "app", level: 0 }],
        expanded: new Set(["app", "app/table", "app/trigger", "app/orders/table", "app/audit/trigger"]),
        counts: {},
        objects: {
          "app/table": [{ path: ["app", "orders"], name: "orders", kind: "table" }],
          "app/trigger": [{ path: ["app", "audit"], name: "audit", kind: "trigger" }],
        },
        details: { "app/orders/table": detailOf(ordersColumns) },
      }),
    );
    expect(rows.find((r) => r.kindId === "table" && r.kind === "object")?.expanded).toBe(true);
    expect(rows.find((r) => r.kindId === "trigger" && r.kind === "object")?.expanded).toBeUndefined();
    expect(rows.filter((r) => r.kind === "column").map((r) => r.label)).toEqual(["id", "total"]);
  });

  test("an answer carrying another kind than the folder asked for gets no twisty", () => {
    // `spec.id === object.kind` because the row id, the describe request and this gate must
    // read ONE fact. A twisty here would open a read addressing something else.
    const rows = flattenTree(
      stateOf({
        ...ordersOpen,
        objects: { "app/table": [{ path: ["app", "orders"], name: "orders", kind: "view" }] },
        expanded: new Set(["app", "app/table", "app/orders/view"]),
        details: { "app/orders/view": detailOf(ordersColumns) },
      }),
    );
    expect(rows.find((r) => r.kind === "object")?.expanded).toBeUndefined();
    expect(rows.filter((r) => r.kind === "column")).toHaveLength(0);
  });

  test("a source that cannot answer a describe read withholds the twisty entirely", () => {
    // B76: an absent affordance is not a regression, a read that cannot succeed is. An embedded
    // host that implements no `describeObject` gets the tree exactly as it was.
    const rows = flattenTree(
      stateOf({ ...ordersOpen, readsColumns: false, details: { "app/orders/table": detailOf(ordersColumns) } }),
    );
    const orders = rows.find((r) => r.kind === "object");
    expect(orders?.expanded).toBeUndefined();
    expect(orders?.unavailable).toBeUndefined();
    expect(rows.filter((r) => r.kind === "column")).toHaveLength(0);
  });
});

/**
 * The row the walk built, DRAWN (#789).
 *
 * In this file rather than in a component suite because the trailing-slot cases below live in the
 * SEAM between the walk and the row, and neither module can see them on its own. `flattenTree`
 * writes the "no columns" sentence onto the MODEL out of a stored answer; the failure of a later
 * read never passes through the walk at all and reaches the row as a PROP. Only a drawn row holds
 * both. The twisty's tab stop is here for the same instrument rather than the same reason: it is
 * a property of the drawn row with no gesture in it, so a driven tree would only be a slower way
 * to read one attribute.
 *
 * Static markup rather than a mounted tree because nothing here is a gesture: every fact is
 * settled before the row renders, and `TreeRowProps.onToggle` is optional for exactly this, a row
 * drawn on its own. Parsed into an element rather than matched as a string, so an absence is an
 * absent NODE and not a substring some other attribute could have supplied.
 */
function drawRow(props: Partial<TreeRowProps> & Pick<TreeRowProps, "row">): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(TreeRow, {
      active: false,
      selected: false,
      busy: false,
      onOpenMenu: () => undefined,
      top: 0,
      ...props,
    }),
  );
  return host;
}

/** The one open object row of an `ordersOpen` walk, which is what every case below draws. */
function openOrdersRow(details: FlattenTreeState["details"]): TreeRowModel {
  const orders = flattenTree(stateOf({ ...ordersOpen, details })).find((row) => row.kind === "object");
  if (orders === undefined) throw new Error("the walk emitted no object row to draw");
  return orders;
}

/** The listing entry the row was built from, carrying the estimate the trailing slot competes with. */
const ordersObject: DatabaseObject = { path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1234 };

describe("TreeRow trailing slot", () => {
  test("the walk's sentence holds the slot alone while no read has failed", () => {
    // The control for the case below, and it has to be here: it shows the instrument can see the
    // walk's sentence at all, and that the slot already holds exactly one thing, the count having
    // stood down for it.
    const host = drawRow({ row: openOrdersRow({ "app/orders/table": detailOf([]) }), object: ordersObject });
    expect(host.querySelector('[data-testid="tree-row-unavailable"]')?.textContent).toBe("No columns reported");
    expect(host.querySelector('[data-testid="tree-row-failure"]')).toBeNull();
    expect(host.querySelector('[data-testid="tree-row-count"]')).toBeNull();
  });

  test("a failed re-read takes the slot from the sentence its own stale answer left there", () => {
    // The state a refresh produces: a describe answered "none", so the walk put its sentence on
    // the model, and the re-read a DDL statement triggered then failed without clearing the
    // detail. Both facts are true of the row at once and they are about DIFFERENT reads, so
    // drawing both puts two reports of one read side by side in one slot, and `aria-labelledby`
    // names both, which is how "ordersNo columns reportedconnection reset" was measured.
    const host = drawRow({
      row: openOrdersRow({ "app/orders/table": detailOf([]) }),
      object: ordersObject,
      failure: { message: "connection reset" },
    });
    expect(host.querySelector('[data-testid="tree-row-failure"]')?.textContent).toBe("connection reset");
    expect(host.querySelector('[data-testid="tree-row-unavailable"]')).toBeNull();
    expect(host.querySelector('[data-testid="tree-row-count"]')).toBeNull();
    // Read out, not merely rendered: every slot joins the name, so the row must not say two
    // things about one read.
    expect(host.textContent).toBe("ordersconnection reset");
  });

  test("a folder's count refusal stands down for a failed listing, which is the same rule", () => {
    // The rule is about the SLOT and not about object rows. On a folder the two sentences are
    // about two different reads, a refused count and a failed listing, so the freshness argument
    // does not reach here and the ranking does. Reachable and never measured in the wild: the
    // listing fails first, a later counts refresh comes back refused, and `readFor`'s folder arm
    // resolves the listing slot whether or not the folder is still expandable.
    const refusedCount = { app: { table: { unavailable: "Counting is not permitted here" } } };
    const folder = flattenTree(stateOf({ ...ordersOpen, counts: refusedCount })).find((row) => row.kind === "folder");
    if (folder === undefined) throw new Error("the walk emitted no folder row to draw");
    const alone = drawRow({ row: folder });
    expect(alone.querySelector('[data-testid="tree-row-unavailable"]')?.textContent).toBe(
      "Counting is not permitted here",
    );
    const withFailure = drawRow({ row: folder, failure: { message: "listing refused" } });
    expect(withFailure.querySelector('[data-testid="tree-row-failure"]')?.textContent).toBe("listing refused");
    expect(withFailure.querySelector('[data-testid="tree-row-unavailable"]')).toBeNull();
  });

  test("a sentence and the row's name split the room 60/40, and each takes what the other leaves", () => {
    // etcd's reader, as Task 27 saw it: the Leases folder carries a refusal many times its name's
    // width, and the two shared the row's shrinking in proportion to their widths, so the name read
    // "Le...". A 40% cap on the sentence kept the name whole but cut every sentence wider than 40%
    // of the row, even where the row had room for it. The split does neither: each starts from its
    // share of the row, grows into what the other leaves, and stops at its own text, so a sentence
    // is cut only where the two do not fit. happy-dom lays nothing out, so the classes are what this
    // can read, as the flat explorer's column list pins its own cap.
    const refusal = "Listing leases needs READ on every leased key in the cluster (etcd: permission denied)";
    const tokens = (element: Element | null) => element?.className.split(" ") ?? [];
    const nameShare = ["grow", "basis-[60%]", "max-w-max", "truncate"];
    const sentenceShare = ["ml-auto", "min-w-0", "grow", "basis-[40%]", "max-w-max", "truncate"];
    const folder = flattenTree(
      stateOf({
        kinds: [{ id: "lease", role: "config", label: "Lease", labelPlural: "Leases" }],
        containerDepth: 0,
        containers: [],
        expanded: new Set<string>(),
        counts: { "": { lease: { unavailable: refusal } } },
        objects: {},
      }),
    ).find((row) => row.kind === "folder");
    if (folder === undefined) throw new Error("the walk emitted no folder row to draw");

    const refused = drawRow({ row: folder });
    const name = refused.querySelector('[data-testid="tree-row-label"]');
    expect(name?.textContent).toBe("Leases");
    expect(tokens(name)).toEqual(expect.arrayContaining(nameShare));
    const sentence = refused.querySelector('[data-testid="tree-row-unavailable"]');
    expect(sentence?.getAttribute("title")).toBe(refusal);
    expect(tokens(sentence)).toEqual(expect.arrayContaining(sentenceShare));
    expect(tokens(sentence)).not.toContain("max-w-[40%]");

    // A failure takes the same slot from the refusal, so it splits the row the same way.
    const failed = drawRow({ row: folder, failure: { message: refusal } });
    expect(tokens(failed.querySelector('[data-testid="tree-row-label"]'))).toEqual(expect.arrayContaining(nameShare));
    const failure = failed.querySelector('[data-testid="tree-row-failure"]');
    expect(tokens(failure)).toEqual(expect.arrayContaining(sentenceShare));
    expect(tokens(failure)).not.toContain("max-w-[40%]");

    // A failure alone splits the row too, and it is the common case: a describe that failed, or a 429,
    // on an object row that carries no refusal, so the failure is the row's only sentence.
    const failedAlone = drawRow({
      row: openOrdersRow({}),
      object: ordersObject,
      failure: { message: "Too many requests. Try again in 41 seconds." },
    });
    expect(failedAlone.querySelector('[data-testid="tree-row-unavailable"]')).toBeNull();
    expect(tokens(failedAlone.querySelector('[data-testid="tree-row-label"]'))).toEqual(
      expect.arrayContaining(nameShare),
    );
    expect(tokens(failedAlone.querySelector('[data-testid="tree-row-failure"]'))).toEqual(
      expect.arrayContaining(sentenceShare),
    );

    // The control: a row with no sentence draws its name exactly as before, so an object's count and
    // a column's type share the row with it as they always have.
    const counted = drawRow({ row: openOrdersRow({}), object: ordersObject });
    expect(counted.querySelector('[data-testid="tree-row-count"]')).not.toBeNull();
    expect(counted.querySelector('[data-testid="tree-row-label"]')?.className).toBe("truncate");
  });

  test("the twisty is not a tab stop, on the very row that holds the tree's one", () => {
    // The roving tabindex is the whole keyboard design: ArrowRight and ArrowLeft open and close a
    // row, so a focusable twisty would add a second tab stop to every mounted object row and a
    // third to the active one. Both controls are in this same markup: the treeitem and the menu
    // trigger report 0 on the active row, so a "-1" here is a deliberate difference and not an
    // instrument that cannot read the attribute.
    const host = drawRow({
      row: openOrdersRow({}),
      object: ordersObject,
      active: true,
      hasActions: true,
      onToggle: () => undefined,
    });
    expect(host.querySelector('[role="treeitem"]')?.getAttribute("tabindex")).toBe("0");
    expect(host.querySelector('[data-testid="tree-row-menu-trigger"]')?.getAttribute("tabindex")).toBe("0");
    expect(host.querySelector('[data-testid="tree-row-twisty"]')?.getAttribute("tabindex")).toBe("-1");
  });
});

/**
 * A group's readable ranges reach no tree row (etcd spec 3.4, E13).
 *
 * `DatabaseObject.readRanges` names the pieces of a group a user who is not root may read, and a
 * piece can be a single key, so it is the one field of a listed object that may name a key. It
 * travels with the object for the two browser-side generators alone: the walk builds its rows from
 * the fields it names, and the drawn row reads `status` and `rowCount` off the object, so neither
 * the model, the label, the badge nor any title carries a range.
 */
describe("a listed object's readable ranges", () => {
  const scoped: DatabaseObject = {
    path: ["/config/*"],
    name: "/config/*",
    kind: "table",
    readRanges: [{ key: "grant-key-a" }, { prefix: "grant-prefix-b/" }, { start: "grant-start-c", end: "grant-end-d" }],
  };

  test("reach neither the rows the walk builds nor the row drawn from the object", () => {
    const rows = flattenTree(
      stateOf({
        kinds,
        containerDepth: 0,
        containers: [],
        expanded: new Set(["table"]),
        counts: { "": { table: { count: 1, sampledFrom: "the 2 ranges etcd user reader may read" } } },
        objects: { table: [scoped] },
      }),
    );
    const row = rows.find((candidate) => candidate.kind === "object");
    if (row === undefined) throw new Error("the walk emitted no object row to draw");
    expect(JSON.stringify(rows)).not.toContain("grant-");
    const host = drawRow({ row, object: scoped });
    expect(host.innerHTML).not.toContain("grant-");
    // The control: the same instrument reads the row's own label, so an absence above is an
    // absence and not a row that drew nothing at all.
    expect(host.textContent).toContain("/config/*");
  });
});

describe("a filtered row's label", () => {
  const base: TreeRowModel = {
    id: "app/orders/table",
    kind: "object",
    label: "customer_orders",
    depth: 2,
    setSize: 1,
    posInSet: 1,
    path: ["app", "customer_orders"],
    kindId: "table",
  };

  test("wraps the matched letters in a mark and keeps the whole name readable", () => {
    const label = drawRow({ row: { ...base, match: [9, 13] } }).querySelector('[data-testid="tree-row-label"]');
    expect(label?.querySelector("mark")?.textContent).toBe("orde");
    expect(label?.textContent).toBe("customer_orders");
  });

  // The browser draws a mark in black, and `text-foreground` resolves through `--foreground`, which
  // lives in `globals.css` and is not packaged: measured in the embedded shell on a dark host, the
  // matched letters were dark on dark. Inheriting takes the row's own colour in both shells.
  test("the mark takes the row's colour rather than a token the package does not ship", () => {
    const mark = drawRow({ row: { ...base, match: [9, 13] } }).querySelector("mark");
    expect(mark?.classList.contains("text-inherit")).toBe(true);
    expect(mark?.classList.contains("text-foreground")).toBe(false);
  });

  test("an empty range draws no mark", () => {
    const label = drawRow({ row: { ...base, match: [0, 0] } }).querySelector('[data-testid="tree-row-label"]');
    expect(label?.querySelector("mark")).toBeNull();
    expect(label?.textContent).toBe("customer_orders");
  });
});
