/**
 * What one tree row may be asked to do, derived from the provider's DECLARATION (#789).
 *
 * Pure and DOM-free, for the reason `flatten.ts` is: the gating is the whole of the
 * decision, so it is decided where a test can put a declaration in and read a list of
 * action ids out, rather than through a rendered menu.
 *
 * Six actions lost their only entry point when the sidebar stopped rendering the flat
 * explorer, whose row menu lives on in `src/components/schema-explorer/TableItem.tsx` for
 * the mobile schema tab. That menu had to ask `capabilities.tablesAreDerivedGroupings` and
 * two hardcoded maintenance slots, because a flat table list carries no statement about
 * what a row IS. A tree row carries its kind, so every gate here reads the declaration for
 * that kind instead:
 *
 * - `role === "relation"` for anything that addresses rows: a routine is not selected from,
 *   not profiled and not analyzed.
 * - `acceptsRowWrites` AND the engine-wide `supportsInlineRowEdit` for the one action that
 *   writes rows. They are different questions and standing ruling 4 keeps them apart:
 *   MongoDB, Couchbase and Cassandra declare the engine flag false while declaring a kind
 *   that does take row writes, so a conjunction inside `kindAcceptsRowWrites` would answer
 *   for three engines that never asked. The conjunction belongs at the caller that needs
 *   both facts, which is this one, spelled out.
 * - `maintenanceControl(..., "perEntity")` for the two maintenance items, which is the same
 *   gate the admin Operations tab and the monitoring Tables tab ask (#496), so three
 *   surfaces cannot disagree about what a provider declared.
 *
 * Never the kind ID and never the database type id. `CLAUDE.md` forbids the second inside
 * `src/lib/db`, and the object model exists so the UI does not need the first.
 *
 * ONE gate of the flat menu has no successor here, deliberately, and the next implementer
 * needs to know which declaration replaces it. `TableItem.tsx` withheld Generate Query and
 * Profile whenever `capabilities.tablesAreDerivedGroupings` was true, because those rows are
 * key-prefix groupings this server derived from a bounded scan rather than objects anybody
 * named, so neither action has a target. Exactly two providers set that flag
 * (`keyvalue/redis.ts` and `embedded/libredb.ts`) and neither declares `objectKinds` yet, so
 * nothing is lost today. When they are migrated, a derived grouping must NOT be declared
 * with `role: "relation"` - that role is what offers both of those actions above - and must
 * not declare `acceptsRowWrites`. Recorded in standing ruling 4 against #789 Tasks 20 and 23.
 */

import { ChartColumn, Code, Funnel, Plus, Search, Trash2, WandSparkles, type LucideIcon } from "lucide-react";
import { findKind, kindAcceptsRowWrites } from "@/lib/db/object-kinds";
import {
  maintenanceControl,
  type DatabaseObject,
  type ObjectKindSpec,
  type ProviderCapabilities,
  type ProviderLabels,
} from "@/lib/db/types";
import type { TreeRowModel } from "./flatten";

/**
 * What a shell can do with a row. An ABSENT handler is an action that shell does not
 * have, and it is simply not offered: the embedded workspace mounts no maintenance page
 * and no create-table modal, so it passes neither and the tree draws neither. That is the
 * same rule `ObjectTree.onLoad` already uses, and it keeps the tree from knowing which
 * shell it is in.
 */
export interface TreeRowActionHandlers {
  /** Put a generated statement in a new tab WITHOUT running it. */
  readonly onGenerateSelect?: (object: DatabaseObject) => void;
  readonly onProfileObject?: (object: DatabaseObject) => void;
  readonly onGenerateCode?: (object: DatabaseObject) => void;
  /** Generates INSERTs and can run them, which is why it is gated on both row-write facts. */
  readonly onGenerateTestData?: (object: DatabaseObject) => void;
  /** Deep-links to the maintenance surface with this object named. */
  readonly onOpenMaintenance?: (object: DatabaseObject) => void;
  /**
   * Create an object of this folder's kind. Takes NO target: `CreateTableModal` qualifies
   * nothing, so handing it the container would promise a placement it does not honour.
   * Task 25 owns qualifying it.
   */
  readonly onCreateObject?: () => void;
}

/** One item of a row's menu. `id` is stable and is what a test asserts; `label` is read. */
export interface TreeRowAction {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  run(): void;
}

export interface TreeRowActionContext {
  readonly row: TreeRowModel;
  /** The object an object row was built from. Absent on a folder, and on a cache miss. */
  readonly object?: DatabaseObject;
  readonly capabilities: ProviderCapabilities;
  /** The engine's own wording. Only the maintenance items read it. */
  readonly labels?: ProviderLabels;
  readonly handlers: TreeRowActionHandlers;
}

/**
 * The one place the object model is narrowed to the old flat model.
 *
 * `DataProfiler`, `CodeGenerator`, `TestDataGenerator`, `handleGenerateSelect` and the
 * maintenance deep link all take a table NAME and look it up in the flat `TableSchema`
 * list by `name`. `path` is what ADDRESSES an object and `name` is what LABELS it
 * (standing ruling 2), so the name is the half those consumers can still use, and it is
 * the same string `onObjectClick` already hands `handleTableClick` in both shells. A
 * schema-qualified object therefore behaves exactly as it did under the flat explorer,
 * including its ambiguity when two schemas hold the same table name.
 *
 * Exported, and called at the SHELL rather than inside the tree, so that the tree stays in
 * object-model terms and every site Task 25 has to migrate is one grep for this name.
 */
export function flatTargetName(object: DatabaseObject): string {
  return object.name;
}

export function rowActions({
  row,
  object,
  capabilities,
  labels,
  handlers,
}: TreeRowActionContext): readonly TreeRowAction[] {
  const kind = row.kindId === undefined ? undefined : findKind(capabilities, row.kindId);
  // A container row, and a row whose kind the provider does not declare. Neither can be
  // reasoned about from a declaration that is not there.
  if (kind === undefined) return [];
  if (row.kind === "folder") return folderActions(kind, capabilities, handlers);
  // An object row whose object the cache no longer holds: an action with no target is
  // worse than no action, because it looks like it addresses the row under the pointer.
  return object === undefined ? [] : objectActions(object, kind, capabilities, labels, handlers);
}

function objectActions(
  object: DatabaseObject,
  kind: ObjectKindSpec,
  capabilities: ProviderCapabilities,
  labels: ProviderLabels | undefined,
  handlers: TreeRowActionHandlers,
): readonly TreeRowAction[] {
  const actions: TreeRowAction[] = [];
  const isRelation = kind.role === "relation";

  const select = handlers.onGenerateSelect;
  if (isRelation && select !== undefined) {
    actions.push({
      id: "generate-select",
      label: labels?.generateAction ?? "Generate Query",
      icon: Funnel,
      run: () => select(object),
    });
  }

  const profile = handlers.onProfileObject;
  if (isRelation && profile !== undefined) {
    actions.push({ id: "profile", label: `Profile ${kind.label}`, icon: ChartColumn, run: () => profile(object) });
  }

  const generateCode = handlers.onGenerateCode;
  if (isRelation && generateCode !== undefined) {
    actions.push({ id: "generate-code", label: "Generate Code", icon: Code, run: () => generateCode(object) });
  }

  // The row-write gate, both halves, at the caller that needs both.
  const testData = handlers.onGenerateTestData;
  if (
    testData !== undefined &&
    kindAcceptsRowWrites(capabilities, kind.id) &&
    capabilities.supportsInlineRowEdit === true
  ) {
    actions.push({
      id: "generate-test-data",
      label: "Generate Test Data",
      icon: WandSparkles,
      run: () => testData(object),
    });
  }

  const maintenance = handlers.onOpenMaintenance;
  if (isRelation && maintenance !== undefined) {
    const analyze = maintenanceControl(capabilities, "analyze", "perEntity");
    if (analyze.offered) {
      actions.push({
        id: "maintenance-analyze",
        label: analyze.label ?? labels?.analyzeAction ?? `Analyze ${kind.label}`,
        icon: Search,
        run: () => maintenance(object),
      });
    }
    // The redirect, not the literal `vacuum`: four providers point that wording at an
    // operation that is not a vacuum, and the page this item opens follows the same
    // redirect, so reading the literal here would withhold an item the destination has.
    const vacuum = maintenanceControl(capabilities, labels?.vacuumActionOperation ?? "vacuum", "perEntity");
    if (vacuum.offered) {
      actions.push({
        id: "maintenance-vacuum",
        label: vacuum.label ?? labels?.vacuumAction ?? `Vacuum ${kind.label}`,
        icon: Trash2,
        run: () => maintenance(object),
      });
    }
  }
  return actions;
}

/**
 * A folder's own actions.
 *
 * Creating an object is offered on the FOLDER and not on the container, because the folder
 * is the row that names a kind: a container row would have to pick one of the kinds under
 * it. The gate is `role === "relation"` AND `acceptsRowWrites`, which together say "a kind
 * whose objects hold rows the engine can write" - what `CREATE TABLE` makes. A views
 * folder is a relation folder that declares no row writes, and an item there would open a
 * modal that cannot produce a view.
 *
 * `supportsInlineRowEdit` deliberately does NOT gate this one: that flag is the results
 * grid's inline editor, and the three engines that declare it false still create tables.
 */
function folderActions(
  kind: ObjectKindSpec,
  capabilities: ProviderCapabilities,
  handlers: TreeRowActionHandlers,
): readonly TreeRowAction[] {
  const create = handlers.onCreateObject;
  if (create === undefined || kind.role !== "relation" || !kindAcceptsRowWrites(capabilities, kind.id)) return [];
  return [{ id: "create", label: `Create ${kind.label}`, icon: Plus, run: create }];
}
