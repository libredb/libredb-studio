import { describe, test, expect } from "bun:test";
import { flatTargetName, rowActions, type TreeRowActionHandlers } from "@/components/object-tree/row-actions";
import type { TreeRowModel } from "@/components/object-tree/flatten";
import type { DatabaseObject, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";

/**
 * What one object row may be offered, and why (U22, #789).
 *
 * Every gate here is a DECLARATION: the kind's `role`, the kind's `acceptsRowWrites`, the
 * engine-wide `supportsInlineRowEdit`, and what `maintenanceControl` answers for a single
 * entity. None of them is the kind id and none is the database type id, which is what the
 * old flat menu could not avoid and what `CLAUDE.md` forbids one level up.
 */

// The object-model half only, `Pick`-bound so renaming a field in `ProviderCapabilities`
// fails this file rather than leaving the fixtures describing nothing.
type Model = Partial<
  Pick<
    ProviderCapabilities,
    | "objectKinds"
    | "supportsInlineRowEdit"
    | "supportsMaintenance"
    | "maintenanceOperations"
    | "maintenanceOperationSpecs"
    | "tablesAreDerivedGroupings"
  >
>;

function capabilitiesOf(model: Model): ProviderCapabilities {
  return { queryLanguage: "sql", ...model } as ProviderCapabilities;
}

const table = { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true } as const;
const view = { id: "view", role: "relation", label: "View", labelPlural: "Views" } as const;
const routine = { id: "function", role: "routine", label: "Function", labelPlural: "Functions" } as const;

/** PostgreSQL-shaped: tables take row writes, the grid edits rows, both operations per table. */
const postgres = capabilitiesOf({
  objectKinds: [table, view, routine],
  supportsInlineRowEdit: true,
  supportsMaintenance: true,
  maintenanceOperations: ["vacuum", "analyze"],
});

/** Everything the shell can offer, so a missing action is the DECLARATION and not the shell. */
function allHandlers(record: string[] = []): TreeRowActionHandlers {
  return {
    onGenerateSelect: () => record.push("generate-select"),
    onProfileObject: () => record.push("profile"),
    onGenerateCode: () => record.push("generate-code"),
    onGenerateTestData: () => record.push("generate-test-data"),
    onOpenMaintenance: () => record.push("maintenance"),
    onCreateObject: () => record.push("create"),
  };
}

const orders: DatabaseObject = { path: ["app", "orders"], name: "orders", kind: "table" };

function objectRow(kindId: string): TreeRowModel {
  return {
    id: `app/x/${kindId}`,
    kind: "object",
    label: "x",
    depth: 2,
    setSize: 1,
    posInSet: 1,
    path: ["app", "x"],
    kindId,
  };
}

function folderRow(kindId: string): TreeRowModel {
  return {
    id: `app/${kindId}`,
    kind: "folder",
    label: "Folder",
    depth: 1,
    setSize: 1,
    posInSet: 1,
    expanded: false,
    path: ["app"],
    kindId,
  };
}

const containerRow: TreeRowModel = {
  id: "app",
  kind: "container",
  label: "app",
  depth: 0,
  setSize: 1,
  posInSet: 1,
  expanded: false,
  path: ["app"],
};

function idsFor(
  row: TreeRowModel,
  capabilities: ProviderCapabilities,
  handlers: TreeRowActionHandlers = allHandlers(),
  object: DatabaseObject | undefined = orders,
  labels?: ProviderLabels,
): string[] {
  return rowActions({ row, object, capabilities, labels, handlers }).map((action) => action.id);
}

describe("rowActions on an object row", () => {
  test("a relation is offered every action the engine and the shell allow", () => {
    expect(idsFor(objectRow("table"), postgres)).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "generate-test-data",
      "maintenance-analyze",
      "maintenance-vacuum",
    ]);
  });

  test("a routine is offered nothing, because none of these actions addresses one", () => {
    // The gate is `role`, never the kind id: the same declaration that keeps a click on a
    // function from running `SELECT * FROM order_total(integer)`.
    expect(idsFor(objectRow("function"), postgres, allHandlers(), { ...orders, kind: "function" })).toEqual([]);
  });

  test("a relation that declares no row writes is offered everything but the row writer", () => {
    expect(idsFor(objectRow("view"), postgres, allHandlers(), { ...orders, kind: "view" })).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "maintenance-analyze",
      "maintenance-vacuum",
    ]);
  });

  test("the engine-wide row-edit flag is the other half of the gate, and is not implied by the kind", () => {
    // Standing ruling 4: `kindAcceptsRowWrites` is deliberately NOT conjoined with
    // `supportsInlineRowEdit`, because three engines declare the flag false while holding a
    // kind that does take row writes. A caller that needs both facts writes both, and this
    // is that caller, so each half is pinned on its own.
    const noGridEdit = capabilitiesOf({ objectKinds: [table], supportsInlineRowEdit: false });
    expect(idsFor(objectRow("table"), noGridEdit)).not.toContain("generate-test-data");

    const noRowWrites = capabilitiesOf({
      objectKinds: [{ ...table, acceptsRowWrites: false }],
      supportsInlineRowEdit: true,
    });
    expect(idsFor(objectRow("table"), noRowWrites)).not.toContain("generate-test-data");

    const both = capabilitiesOf({ objectKinds: [table], supportsInlineRowEdit: true });
    expect(idsFor(objectRow("table"), both)).toContain("generate-test-data");
  });

  test("an action the shell did not hand over is not offered", () => {
    // The embedded workspace is this case: it mounts no maintenance page and no create-table
    // modal, so it passes neither handler and the two items are simply absent.
    const embedded: TreeRowActionHandlers = {
      onGenerateSelect: () => {},
      onProfileObject: () => {},
      onGenerateCode: () => {},
      onGenerateTestData: () => {},
    };
    expect(idsFor(objectRow("table"), postgres, embedded)).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "generate-test-data",
    ]);
  });

  test("an object the cache has not got is offered nothing, rather than an action with no target", () => {
    // `rowActions` directly, because a default parameter would fill an explicit `undefined`
    // back in and the case would never be reached.
    const actions = rowActions({ row: objectRow("table"), capabilities: postgres, handlers: allHandlers() });
    expect(actions).toEqual([]);
  });

  test("a kind the provider never declared is offered nothing", () => {
    expect(idsFor(objectRow("package"), postgres, allHandlers(), { ...orders, kind: "package" })).toEqual([]);
  });
});

describe("rowActions and maintenance", () => {
  test("an engine with no maintenance offers no maintenance item", () => {
    const none = capabilitiesOf({ objectKinds: [table], supportsInlineRowEdit: true });
    expect(idsFor(objectRow("table"), none)).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "generate-test-data",
    ]);
  });

  test("an operation the engine cannot run against one table is withheld", () => {
    // SQLite's VACUUM takes no target, so the page this item deep-links to renders no
    // per-table control for it (#496). `maintenanceControl` is the one reader of that fact.
    const sqlite = capabilitiesOf({
      objectKinds: [table],
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze"],
      maintenanceOperationSpecs: {
        vacuum: { global: true, perEntity: false, label: "Vacuum Database" },
        analyze: { global: true, perEntity: true, label: "Analyze Table" },
      },
    });
    expect(idsFor(objectRow("table"), sqlite)).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "maintenance-analyze",
    ]);

    // The other slot, so that BOTH read the placement rather than one reading it and the
    // other being right by accident: an engine whose analyze is whole-database only
    // withholds that item and keeps the one it can target.
    const analyzeIsGlobalOnly = capabilitiesOf({
      objectKinds: [table],
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze"],
      maintenanceOperationSpecs: {
        vacuum: { global: true, perEntity: true, label: "Vacuum Table" },
        analyze: { global: true, perEntity: false, label: "Analyze Database" },
      },
    });
    expect(idsFor(objectRow("table"), analyzeIsGlobalOnly)).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "maintenance-vacuum",
    ]);
  });

  test("the vacuum slot follows the engine's own redirect and carries its wording", () => {
    // Four providers point the vacuum wording at an operation that is not a vacuum. MySQL is
    // one: the slot is OPTIMIZE, and following the literal `vacuum` would drop the item from
    // an engine that does have a per-table operation.
    const mysql = capabilitiesOf({
      objectKinds: [table],
      supportsMaintenance: true,
      maintenanceOperations: ["analyze", "optimize"],
      maintenanceOperationSpecs: {
        analyze: { global: false, perEntity: true, label: "Analyze Table" },
        optimize: { global: false, perEntity: true, label: "Optimize Table" },
      },
    });
    const labels = { vacuumActionOperation: "optimize" } as ProviderLabels;
    const actions = rowActions({
      row: objectRow("table"),
      object: orders,
      capabilities: mysql,
      labels,
      handlers: allHandlers(),
    });
    expect(actions.map((action) => action.label)).toContain("Optimize Table");
    // The control: without the redirect the literal `vacuum` is not declared at all here.
    expect(idsFor(objectRow("table"), mysql)).not.toContain("maintenance-vacuum");
  });
});

describe("rowActions on a folder row", () => {
  test("the folder of a kind whose objects hold writable rows offers creating one", () => {
    const actions = rowActions({
      row: folderRow("table"),
      capabilities: postgres,
      handlers: allHandlers(),
    });
    expect(actions.map((action) => action.id)).toEqual(["create"]);
    expect(actions[0].label).toBe("Create Table");
  });

  test("the folder of a relation that takes no row writes offers nothing", () => {
    // `CreateTableModal` writes `CREATE TABLE`. A views folder is a relation folder, and an
    // item there would open a modal that cannot produce a view.
    expect(idsFor(folderRow("view"), postgres)).toEqual([]);
  });

  test("a folder does not inherit the object actions", () => {
    expect(idsFor(folderRow("table"), postgres)).not.toContain("profile");
  });

  test("a kind that takes row writes but is not a relation offers nothing either", () => {
    // Both halves are needed and neither implies the other. A kind whose objects are
    // defined by text or JSON can still accept row writes - a ClickHouse dictionary is
    // declared that way - and `CreateTableModal` writes `CREATE TABLE`, which does not
    // make one.
    const dictionaries = capabilitiesOf({
      objectKinds: [
        { id: "dictionary", role: "config", label: "Dictionary", labelPlural: "Dictionaries", acceptsRowWrites: true },
      ],
    });
    expect(idsFor(folderRow("dictionary"), dictionaries)).toEqual([]);
  });

  test("the engine-wide row-edit flag does NOT gate creating a table", () => {
    // A different question again: `supportsInlineRowEdit` is the results grid's editor, and
    // three engines that declare it false still create tables.
    const noGridEdit = capabilitiesOf({ objectKinds: [table], supportsInlineRowEdit: false });
    expect(idsFor(folderRow("table"), noGridEdit)).toEqual(["create"]);
  });
});

describe("rowActions on a container row", () => {
  test("a container is offered nothing", () => {
    expect(idsFor(containerRow, postgres)).toEqual([]);
  });
});

describe("running an action", () => {
  test("each action hands its handler the object the row was built from", () => {
    const record: string[] = [];
    const actions = rowActions({
      row: objectRow("table"),
      object: orders,
      capabilities: postgres,
      handlers: allHandlers(record),
    });
    for (const action of actions) action.run();
    expect(record).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "generate-test-data",
      "maintenance",
      "maintenance",
    ]);
  });

  test("the object itself is passed, not its label and not its path", () => {
    const seen: DatabaseObject[] = [];
    const actions = rowActions({
      row: objectRow("table"),
      object: orders,
      capabilities: postgres,
      handlers: { onProfileObject: (object) => seen.push(object) },
    });
    actions[0].run();
    expect(seen).toEqual([orders]);
  });

  test("creating an object takes no target, because the modal it opens qualifies nothing", () => {
    let calls = 0;
    const actions = rowActions({
      row: folderRow("table"),
      capabilities: postgres,
      handlers: { onCreateObject: () => (calls += 1) },
    });
    actions[0].run();
    expect(calls).toBe(1);
  });
});

describe("flatTargetName", () => {
  test("the NAME is what the old flat consumers are given, never the last path segment", () => {
    // Standing ruling 2: `path`'s last segment addresses the object and `name` labels it, and
    // they differ where an engine disambiguates. Every consumer this boundary feeds looks its
    // target up in the flat `TableSchema` list by `name` (`conn.schema.find(t => t.name ===
    // ...)`), which is the same string `onObjectClick` already hands `handleTableClick`.
    expect(flatTargetName({ path: ["app", "order_total(integer)"], name: "order_total", kind: "function" })).toBe(
      "order_total",
    );
  });
});

/**
 * The one gate here that is engine-wide rather than per kind (#789 Task 20).
 *
 * A Redis `keyspace` row is a prefix grouping this server derived from a bounded SCAN, so
 * it is a relation - `SCAN 0 MATCH user:* COUNT 50` addresses exactly the keys it
 * summarises - while having no object a profiler could compute statistics over. The flat
 * menu withheld Profile on that flag and nothing carried it into the object model.
 */
describe("a kind whose rows are derived groupings", () => {
  const keyspace = { id: "keyspace", role: "relation", label: "Key Pattern", labelPlural: "Key Patterns" } as const;
  const redis = capabilitiesOf({ objectKinds: [keyspace], tablesAreDerivedGroupings: true });
  /** The same declaration WITHOUT the flag: the control that makes the assertion non-vacuous. */
  const ordinary = capabilitiesOf({ objectKinds: [keyspace] });
  const grouping: DatabaseObject = { path: ["0", "user:*"], name: "user:*", kind: "keyspace" };

  const idsFor = (capabilities: ProviderCapabilities): readonly string[] =>
    rowActions({
      row: { ...objectRow("keyspace"), path: ["0", "user:*"] },
      object: grouping,
      capabilities,
      handlers: allHandlers(),
    }).map((action) => action.id);

  test("is not offered Profile, because the row names no object to profile", () => {
    expect(idsFor(redis)).not.toContain("profile");
  });

  test("keeps Generate Query, which the flat menu also kept: a pattern IS scannable", () => {
    expect(idsFor(redis)).toEqual(["generate-select", "generate-code"]);
  });

  test("the same kind without the flag IS offered Profile", () => {
    expect(idsFor(ordinary)).toContain("profile");
  });
});
