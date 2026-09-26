import { describe, test, expect } from "bun:test";
import { rowActions, type TreeRowActionHandlers } from "@/components/object-tree/row-actions";
import type { TreeRowModel } from "@/components/object-tree/flatten";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka/index";
import type { DatabaseObject, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";

/**
 * What one object row may be offered, and why (U22, #789).
 *
 * Every gate here is a DECLARATION: the kind's `role`, the kind's `acceptsRowWrites`, the
 * engine-wide `supportsInlineRowEdit`, and what `maintenanceControl` answers for a single
 * entity. None of them is the kind id and none is the database type id, which is what the
 * old flat menu could not avoid and what `CLAUDE.md` forbids one level up.
 */

// The declaration fields these gates read, `Pick`-bound so renaming a field in
// `ProviderCapabilities` fails this file rather than leaving the fixtures describing nothing.
type Model = Partial<
  Pick<
    ProviderCapabilities,
    | "queryLanguage"
    | "queryDialect"
    | "objectKinds"
    | "supportsInlineRowEdit"
    | "supportsMaintenance"
    | "maintenanceOperations"
    | "maintenanceOperationSpecs"
    | "tablesAreDerivedGroupings"
    | "keyScan"
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
    onViewSource: () => record.push("view-source"),
    onBrowseKeys: () => record.push("browse-keys"),
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

/**
 * A column row, as `flattenTree` builds one: no kind id, and a path that names the COLUMN.
 *
 * Built here with the id prefix the walk uses rather than an invented one, because the guard
 * being pinned is about the row's ADDRESSING and a row that addressed itself like an object
 * would be a different subject.
 */
function columnRow(): TreeRowModel {
  return {
    id: "column%3Aapp/x/table/order_id",
    kind: "column",
    label: "order_id",
    depth: 3,
    setSize: 1,
    posInSet: 1,
    path: ["app", "x", "order_id"],
    column: { name: "order_id", type: "integer", nullable: false, isPrimary: false },
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
  test("offers a count query only for a supported relation with a handler", () => {
    const record: DatabaseObject[] = [];
    const handlers = { onGenerateCount: (object: DatabaseObject) => record.push(object) };
    const actions = rowActions({ row: objectRow("table"), object: orders, capabilities: postgres, handlers });
    expect(actions.map((action) => action.id)).toEqual(["generate-count"]);
    actions[0].run();
    expect(record).toEqual([orders]);
    expect(idsFor(objectRow("table"), postgres, {})).not.toContain("generate-count");
    expect(idsFor(objectRow("function"), postgres, handlers)).not.toContain("generate-count");
    expect(idsFor(folderRow("table"), postgres, handlers)).not.toContain("generate-count");
    for (const capabilities of [
      { ...postgres, tablesAreDerivedGroupings: true },
      { ...postgres, queryDialect: "redis" as const },
      { ...postgres, queryDialect: "libredb" as const },
      { ...postgres, queryLanguage: "promql" as const },
      // A read request has no count grammar: it reads messages and counts none (#1088).
      { ...postgres, queryDialect: "kafka" as const },
    ]) {
      expect(idsFor(objectRow("table"), capabilities, handlers)).not.toContain("generate-count");
    }
    expect(idsFor(objectRow("view"), postgres, handlers)).toEqual(["generate-count"]);
  });
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

describe("rowActions on a column row", () => {
  test("a column row is offered nothing", () => {
    // The object is handed in DELIBERATELY: a resolved parent is exactly the state the refusal
    // has to survive, and passing `undefined` here would pin nothing.
    expect(idsFor(columnRow(), postgres, allHandlers(), orders)).toEqual([]);
  });

  test("and still nothing where the row carries its parent's kind id", () => {
    // This is what the first line of `rowActions` is FOR, and it is the one case that can fail
    // without it. The row above misses by CONSTRUCTION, because `flattenTree` gives a column row
    // no kind id and the lookup below needs one; that is a property of how a column row is built
    // today, not a statement about this function. So the fixture here is a column row that does
    // carry one, which no walk produces and which a later change to how a column row addresses
    // itself would produce. Without the refusal it resolves the parent's kind and offers
    // "Vacuum Table" on `order_id`, with the table's status and row count drawn beside it.
    expect(idsFor({ ...columnRow(), kindId: "table" }, postgres, allHandlers(), orders)).toEqual([]);
  });

  test("the control: the rows that DO get a menu still get the same one", () => {
    // The new first line is a refusal for one row kind and must not be a refusal for any
    // other, which a bare "a column gets nothing" cannot say on its own.
    expect(idsFor(objectRow("table"), postgres)).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "generate-test-data",
      "maintenance-analyze",
      "maintenance-vacuum",
    ]);
    expect(idsFor(folderRow("table"), postgres)).toEqual(["create"]);
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

/**
 * Browse Keys, the ONE action that opens another READING of the row rather than acting on it.
 *
 * TWO declarations and no kind id, which is what makes this a gate rather than a special case:
 * `keyScan` says the engine has a key space AND that the shell mounts a panel for it, and
 * `tablesAreDerivedGroupings` says the relation rows are prefixes a server summarised rather than
 * objects anybody named. Either fact alone is not enough, and every direction is pinned below.
 */
describe("Browse Keys is gated on the walk and on the rows being key patterns", () => {
  const keyspace = { id: "keyspace", role: "relation", label: "Key Pattern", labelPlural: "Key Patterns" } as const;
  const walk = { defaultCount: 500, maxCount: 1000 } as const;
  /** Redis: it walks a key space, and its relation rows ARE the prefixes of one. */
  const redis = capabilitiesOf({ objectKinds: [keyspace], tablesAreDerivedGroupings: true, keyScan: walk });
  const grouping: DatabaseObject = { path: ["0", "user:*"], name: "user:*", kind: "keyspace" };
  const groupingRow: TreeRowModel = { ...objectRow("keyspace"), path: ["0", "user:*"] };

  const idsFor = (
    capabilities: ProviderCapabilities,
    object: DatabaseObject = grouping,
    handlers: TreeRowActionHandlers = allHandlers(),
    row: TreeRowModel = groupingRow,
  ): readonly string[] => rowActions({ row, object, capabilities, handlers }).map((action) => action.id);

  test("is offered on a key pattern of an engine that declares the walk", () => {
    expect(idsFor(redis)).toEqual(["generate-select", "generate-code", "browse-keys"]);
  });

  test("is withheld from the same rows when the engine declares no key-space walk", () => {
    // LibreDB-shaped: relation rows that are derived groupings, and no panel to show them in. The
    // item would name a destination that does not exist.
    const noWalk = capabilitiesOf({ objectKinds: [keyspace], tablesAreDerivedGroupings: true });
    expect(idsFor(noWalk)).not.toContain("browse-keys");
  });

  test("is withheld from ordinary objects even on an engine that DOES declare the walk", () => {
    // A table name is not a `MATCH` pattern: `orders` would be handed to the panel as a glob that
    // matches one key nobody meant.
    //
    // The row has to be the kind the declaration actually names. This case used to pass
    // `objectRow("keyspace")` against a declaration of `table`, so the kind lookup missed, no
    // action was ever considered, and the empty list was true for a reason that had nothing to
    // do with the gate. Resolving the row is what leaves `tablesAreDerivedGroupings` as the only
    // thing standing between a table row and Browse Keys.
    const tables = capabilitiesOf({ objectKinds: [table], keyScan: walk });
    // Asserted whole rather than with `not.toContain`, so a gate that stopped asking whether the
    // rows are derived groupings would offer a fourth item here and fail on it: a `not.toContain`
    // on an empty list is the vacuous shape this case used to have.
    expect(
      idsFor(tables, { path: ["app", "orders"], name: "orders", kind: "table" }, allHandlers(), objectRow("table")),
    ).toEqual(["generate-select", "profile", "generate-code"]);
  });

  test("is withheld from a routine row, because a routine is not a prefix", () => {
    const functions = capabilitiesOf({
      objectKinds: [keyspace, routine],
      tablesAreDerivedGroupings: true,
      keyScan: walk,
    });
    expect(
      idsFor(functions, { path: ["0", "lib"], name: "lib", kind: "function" }, allHandlers(), objectRow("function")),
    ).not.toContain("browse-keys");
  });

  test("is withheld when the shell passes no handler, which is how a shell says it cannot", () => {
    expect(idsFor(redis, grouping, {})).toEqual([]);
  });

  test("hands the handler the object the row was built from, so the pattern is the row's own name", () => {
    const seen: DatabaseObject[] = [];
    const actions = rowActions({
      row: groupingRow,
      object: grouping,
      capabilities: redis,
      handlers: { onBrowseKeys: (target) => seen.push(target) },
    });

    expect(actions.map((action) => action.id)).toEqual(["browse-keys"]);
    expect(actions[0].label).toBe("Browse Keys");
    actions[0].run();
    // The name VERBATIM, `*` and all: a key grouping already carries its glob, and a caller that
    // appended another would address a different set of keys.
    expect(seen).toEqual([grouping]);
    expect(seen[0].name).toBe("user:*");
  });
});

/**
 * View Source, the FIRST action whose gate is not `role === "relation"` (#789 Phase 2).
 *
 * Every other action in this file addresses ROWS, so every other gate asks the role. This one
 * addresses the definition TEXT, which is a different fact about a kind and is declared as one:
 * `hasSource` on the kind spec, read through `kindHasSource`. There is deliberately NO role
 * conjunction, and the consequence is the point rather than a side effect: a routine, a trigger,
 * a `group` kind and a `config` kind have had no row menu at all until now, so this is the item
 * that gives those rows their first one.
 *
 * The two facts are ORTHOGONAL and both directions are pinned below, because a conjunction with
 * the role would pass the routine case and fail nothing else in this file:
 *
 * - a routine that declares source is offered it, and it is the only item on that row;
 * - a relation that declares source keeps every row action it had AND gains this one, last;
 * - a relation that declares none is offered its row actions and not this one;
 * - a routine that declares none is offered nothing at all, exactly as before.
 */
describe("View Source is gated on the kind's declared source, and on nothing else", () => {
  const sourceTable = { ...table, hasSource: true, sourceLanguage: "sql" } as const;
  const sourceRoutine = { ...routine, hasSource: true, sourceLanguage: "sql" } as const;
  /** A trigger: `role: "attached"`, a kind whose rows the tree has always drawn menu-less. */
  const sourceTrigger = {
    id: "trigger",
    role: "attached",
    label: "Trigger",
    labelPlural: "Triggers",
    attachedTo: "table",
    hasSource: true,
    sourceLanguage: "sql",
  } as const;
  /** Declares nothing, and is the control for every assertion that a kind WITH source gains one. */
  const sequence = { id: "sequence", role: "group", label: "Sequence", labelPlural: "Sequences" } as const;

  const withSourceKinds = capabilitiesOf({
    objectKinds: [sourceTable, view, sourceRoutine, sourceTrigger, sequence],
    supportsInlineRowEdit: true,
  });

  const objectOf = (kindId: string): DatabaseObject => ({ path: ["app", "x"], name: "x", kind: kindId });

  test("offers View Source on a ROUTINE row, which has never had a menu at all", () => {
    expect(idsFor(objectRow("function"), withSourceKinds, allHandlers(), objectOf("function"))).toEqual([
      "view-source",
    ]);
  });

  test("offers it on an ATTACHED row too, so the gate is not a second spelling of one role", () => {
    expect(idsFor(objectRow("trigger"), withSourceKinds, allHandlers(), objectOf("trigger"))).toEqual(["view-source"]);
  });

  test("offers View Source on a relation row WITHOUT reordering anything that was there", () => {
    // LAST in the sequence. The order is asserted whole rather than with `toContain`, because
    // the reason this item is pushed last is that no existing row's menu may be reordered.
    expect(idsFor(objectRow("table"), withSourceKinds, allHandlers(), objectOf("table"))).toEqual([
      "generate-select",
      "profile",
      "generate-code",
      "generate-test-data",
      "view-source",
    ]);
  });

  test("withholds it for a kind that declares no source, whatever its role", () => {
    // A relation that declares none keeps its row actions and gains nothing, and a `group`
    // kind that declares none is still offered nothing at all.
    expect(idsFor(objectRow("view"), withSourceKinds, allHandlers(), objectOf("view"))).toEqual([
      "generate-select",
      "profile",
      "generate-code",
    ]);
    expect(idsFor(objectRow("sequence"), withSourceKinds, allHandlers(), objectOf("sequence"))).toEqual([]);
  });

  test("withholds it when the shell passes no handler, which is how a shell says it cannot", () => {
    expect(idsFor(objectRow("function"), withSourceKinds, {}, objectOf("function"))).toEqual([]);
  });

  test("hands the handler the object the row was built from, and reads its own label", () => {
    const seen: DatabaseObject[] = [];
    const object = objectOf("function");
    const actions = rowActions({
      row: objectRow("function"),
      object,
      capabilities: withSourceKinds,
      handlers: { onViewSource: (target) => seen.push(target) },
    });
    expect(actions.map((action) => action.label)).toEqual(["View Source"]);
    actions[0].run();
    expect(seen).toEqual([object]);
  });

  test("a folder of a source-bearing kind is still offered nothing, because a folder has no source", () => {
    expect(rowActions({ row: folderRow("function"), capabilities: withSourceKinds, handlers: allHandlers() })).toEqual(
      [],
    );
  });
});

/**
 * The two actions whose DESTINATION speaks only some query languages (#1085).
 *
 * `POST /api/db/profile` writes SQL aggregates or a MongoDB `aggregate` document and nothing
 * else, and the code generator maps columns onto table and document models. A PromQL metric
 * is a relation, and a click on it selects its series, while neither destination has anything
 * to say about it, so both items also ask the language gates in `src/lib/db/types.ts`, the
 * two the mobile menu asks too. Every negative below is paired with the same declaration in a
 * language the destination does speak, so an empty answer cannot come from a fixture that
 * lost its kind or its handlers.
 */
describe("the actions whose destination speaks only some query languages", () => {
  const metric = { id: "metric", role: "relation", label: "Metric", labelPlural: "Metrics", hasColumns: true } as const;
  const up: DatabaseObject = { path: ["up"], name: "up", kind: "metric" };
  const metricRow: TreeRowModel = { ...objectRow("metric"), path: ["up"] };

  test("a PromQL metric is offered neither Profile nor Generate Code, and keeps Generate Query", () => {
    const promql = capabilitiesOf({ queryLanguage: "promql", objectKinds: [metric] });
    expect(idsFor(metricRow, promql, allHandlers(), up)).toEqual(["generate-select"]);
  });

  test("the control: the same declaration in SQL is offered both", () => {
    const sql = capabilitiesOf({ queryLanguage: "sql", objectKinds: [metric] });
    expect(idsFor(metricRow, sql, allHandlers(), up)).toEqual(["generate-select", "profile", "generate-code"]);
  });

  test("JSON in a dialect of its own is not profiled, and still generates code", () => {
    // Redis-shaped WITHOUT `tablesAreDerivedGroupings`, so the language gate is the only one
    // here that can withhold Profile.
    const redisDialect = capabilitiesOf({ queryLanguage: "json", queryDialect: "redis", objectKinds: [table] });
    expect(idsFor(objectRow("table"), redisDialect)).toEqual(["generate-select", "generate-code"]);
  });

  test("the control: MongoDB's JSON, with no dialect, is profiled and generates code", () => {
    const mongodb = capabilitiesOf({ queryLanguage: "json", objectKinds: [table] });
    expect(idsFor(objectRow("table"), mongodb)).toEqual(["generate-select", "profile", "generate-code"]);
  });

  test("a Kafka topic is offered Generate Query and View Source, and nothing that profiles, models, counts or writes its rows (#1088)", () => {
    // The provider's own declaration, so the menu is the one a topic row is really offered: its
    // text is a read request, which the profile route builds no statement in, whose fixed columns
    // the generated models reject, which has no count grammar, and whose topic takes no row writes.
    const kafka = new KafkaProvider({
      id: "kafka-row-actions",
      name: "Kafka",
      type: "kafka",
      host: "localhost",
      port: 9092,
      createdAt: new Date(0),
    }).getCapabilities();
    const topic: DatabaseObject = { path: ["orders"], name: "orders", kind: "topic" };
    const topicRow: TreeRowModel = { ...objectRow("topic"), path: ["orders"] };
    const handlers: TreeRowActionHandlers = { ...allHandlers(), onGenerateCount: () => {} };

    expect(idsFor(topicRow, kafka, handlers, topic)).toEqual(["generate-select", "view-source"]);
    // The control, in the one field under test: the same declaration with the dialect removed is
    // MongoDB's JSON, which is profiled, counted and generates code, so the refusals above are the
    // dialect's. Generate Test Data stays withheld there too: no Kafka kind declares row writes.
    expect(idsFor(topicRow, { ...kafka, queryDialect: undefined }, handlers, topic)).toEqual([
      "generate-select",
      "generate-count",
      "profile",
      "generate-code",
      "view-source",
    ]);
  });
});
