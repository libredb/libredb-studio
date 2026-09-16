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
 *   for three engines that never asked. The conjunction belongs at each caller that needs
 *   both facts, this one and the mobile `TableItem.tsx`, spelled out.
 * - `maintenanceControl(..., "perEntity")` for the two maintenance items, which is the same
 *   gate the admin Operations tab and the monitoring Tables tab ask (#496), so three
 *   surfaces cannot disagree about what a provider declared.
 * - `offersColumnProfiling` and `offersCodeGeneration` for the two actions whose destination
 *   speaks only some query languages: `POST /api/db/profile` builds SQL or a MongoDB document,
 *   and the code generator maps columns onto table and document models, so a PromQL metric is
 *   offered neither (#1085). Both sit beside `maintenanceControl` in `src/lib/db/types.ts`,
 *   and the mobile menu asks the same two.
 *
 * Never the kind ID and never the database type id. `CLAUDE.md` forbids the second inside
 * `src/lib/db`, and the object model exists so the UI does not need the first.
 *
 * ONE gate of the flat menu has a successor of its own, and it was the only one that was not
 * a statement about a KIND until the two language gates above joined it. `TableItem.tsx`
 * withheld three items whenever `capabilities.tablesAreDerivedGroupings` was true - Profile,
 * Generate Test Data and the two per-row maintenance links - because those rows are key-prefix
 * groupings a server derived from a bounded scan rather than objects anybody named. Since #1085
 * (decision D-M) it asks this file's row-write rule for Generate Test Data instead, and still
 * asks the flag for the other two. It does NOT withhold Generate Query,
 * and that is right rather than an oversight: the Redis generator answers
 * `SCAN 0 MATCH user:* COUNT 50` for a prefix group, a runnable command against exactly the
 * keys the row summarises (`src/lib/query-generators.ts`), and the row click that opens data
 * runs the same thing. Measured in the source on 2026-09-11 while Task 20 migrated Redis; an
 * earlier version of this note said Generate Query was withheld, and it was not.
 *
 * Two of the three therefore need no new gate: a derived grouping declares no
 * `acceptsRowWrites`, so the test-data and create items are already withheld; Redis
 * declares its one maintenance operation as `perEntity: false` and LibreDB declares none
 * (`supportsMaintenance: false`), so `maintenanceControl` withholds those.
 * PROFILE is the one that has no kind-level
 * declaration behind it - profiling needs an ADDRESSABLE object, while every other relation
 * action here needs only a pattern - so it reads the same engine-wide flag the flat menu
 * read. Exactly two providers set it, `keyvalue/redis.ts` and `embedded/libredb.ts`, and it
 * is read `=== true` here for the reason its own docblock gives: absent means ordinary
 * objects. Standing ruling 4 against #789 Tasks 20 and 23.
 */

import {
  ChartColumn,
  Code,
  FileCode,
  Funnel,
  Hash,
  Plus,
  Search,
  Trash2,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { canGenerateCountQuery } from "@/lib/query-generators";
import { findKind, kindAcceptsRowWrites, kindHasSource } from "@/lib/db/object-kinds";
import {
  maintenanceControl,
  offersCodeGeneration,
  offersColumnProfiling,
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
  /** Prepare a count in the editor; a full-table scan must remain an explicit Run. */
  readonly onGenerateCount?: (object: DatabaseObject) => void;
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
  /**
   * Open this object's DEFINITION TEXT, read-only (#789 Phase 2).
   *
   * The one handler here that no shell is obliged to have. A shell that cannot mount the
   * source viewer simply does not pass it and the item is not drawn, which is the same rule
   * the maintenance and create handlers already follow.
   */
  readonly onViewSource?: (object: DatabaseObject) => void;
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

export function rowActions({
  row,
  object,
  capabilities,
  labels,
  handlers,
}: TreeRowActionContext): readonly TreeRowAction[] {
  // A COLUMN row is not an object and is not addressable as one. The `kind === undefined` guard
  // below already answers nothing for it, because a column row carries no kind id; this line is
  // the STATEMENT of that, so a later change to how a column row addresses itself cannot turn a
  // cache miss into the parent table's whole menu offered against one of its columns. The shape
  // that would be: `objectFor` resolving the parent and `objectActions` offering "Vacuum Table"
  // on `order_id`, with the table's status and row count drawn on the column row beside it.
  if (row.kind === "column") return [];
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

  const count = handlers.onGenerateCount;
  if (isRelation && count !== undefined && canGenerateCountQuery(capabilities)) {
    actions.push({ id: "generate-count", label: "Generate Count Query", icon: Hash, run: () => count(object) });
  }

  // Profile asks two engine-wide facts rather than a per-kind one: see the note at the top of
  // this file. A Redis `user:*` row is a grouping this server summarised, so the profiler has
  // no object to run its per-column statistics against (#427); and the profile route builds
  // SQL or a MongoDB document, so a language it writes neither in is not offered it (#1085).
  const profile = handlers.onProfileObject;
  if (
    isRelation &&
    profile !== undefined &&
    capabilities.tablesAreDerivedGroupings !== true &&
    offersColumnProfiling(capabilities)
  ) {
    actions.push({ id: "profile", label: `Profile ${kind.label}`, icon: ChartColumn, run: () => profile(object) });
  }

  // Generate Code names the row rather than addressing it, so a derived grouping keeps it
  // (#427); the language gate withholds it where the columns model no stored record (#1085).
  const generateCode = handlers.onGenerateCode;
  if (isRelation && generateCode !== undefined && offersCodeGeneration(capabilities)) {
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

  /*
   * View Source, and the ONE gate in this file that does not ask the role (#789 Phase 2).
   *
   * Every action above addresses ROWS, which is why every one of them asks `role`. This one
   * addresses the definition TEXT, a different fact about a kind that the provider declares
   * as one, so the gate is the declaration for that kind and nothing else. No `isRelation`
   * conjunction, deliberately: the kinds this feature exists for carry `role: "routine"`,
   * `"attached"`, `"group"` and `"config"`, none of which has ever been offered a single
   * action, so a conjunction would withhold the item from exactly the rows it is for.
   *
   * The consequence is expected rather than a side effect: `ObjectTree.hasRowMenu` is
   * `actionsFor(row).length > 0`, so those rows now show the visible ellipsis trigger and
   * announce `aria-haspopup="menu"` for the first time. That single predicate is also what
   * keeps a visible trigger from ever opening an empty menu, which is why no second gate is
   * added beside it.
   *
   * LAST in the sequence, so no existing row's menu is reordered by this addition. On the
   * rows this feature is for it is the only item, so its position there is moot.
   *
   * Phase 3's EDIT gate is not this gate and must not be built from it: editing asks four
   * conjuncts, three of them per-PART facts that live in the opened tab's state rather than
   * on the row (a truncated part is not editable, and a refused part has no text at all).
   */
  const viewSource = handlers.onViewSource;
  if (viewSource !== undefined && kindHasSource(capabilities, kind.id)) {
    actions.push({ id: "view-source", label: "View Source", icon: FileCode, run: () => viewSource(object) });
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
