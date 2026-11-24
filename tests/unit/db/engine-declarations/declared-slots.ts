/**
 * The census's one table of the slots an engine declaration names a function by, keyed by slot name
 * (docs/providers/CONTRACT.md, clause M-31).
 *
 * A declaration never carries a function: it states, at the member a function fills, the name of the slot that member
 * is. The table below maps each slot name to the registry it belongs to and the dotted path of its member in that
 * registry's row, as `functionPaths` in tests/unit/db/engine-declarations.test.ts spells it. It is written here, apart
 * from scripts/generate-engine-declarations.ts, so a slip in the generator cannot certify itself: the census holds every
 * name a declaration states to the path this table gives it, and every function a row holds to the name this table
 * gives its path.
 *
 * An SQL generator slot is resolved on the row the engine's own module exports, imported by its absolute path, never
 * through the registry index the generator reads, so the census holds the module's row and the registry's row to be the
 * same object as a separate fact; the SQL generator modules are found from the import statements of the query
 * generators' registry file, read as source (`sqlGeneratorModules` in
 * tests/unit/db/engine-declarations/sql-generator-modules.ts). An SQL writing slot is read on `SQL_WRITING` and a
 * migration DDL slot on `MIGRATION_DDL`, each row of which Studio composes from the engine's declaration, and the census
 * holds the function there to the one Studio's SQL writing or migration DDL function table binds at that slot. An engine's agent server
 * overlay module is found by the agent leg's triad path, `src/lib/agent/languages/<family>/engines/<type-id>.ts`, the
 * family being the engine's `AGENT_STATEMENT_LANGUAGE` row, and its slots sit at the same dotted path in the module's
 * overlay and in the declaration's `agent.overlay`.
 */

/** The registries whose rows the table names slots of. */
export type SlotTable = "SQL_WRITING" | "MIGRATION_DDL" | "SQL_ENGINE_GENERATORS" | "AGENT_SERVER_OVERLAY";

/** One slot: the registry whose row holds it and the dotted path of its member in that row. */
export interface DeclaredSlot {
  readonly table: SlotTable;
  readonly path: string;
}

/** Every slot an engine declaration names a function by, keyed by the slot's name. */
export const DECLARED_SLOTS = Object.freeze({
  escapeLiteral: { table: "SQL_WRITING", path: "escapeLiteral" },
  unescapeLiteral: { table: "SQL_WRITING", path: "unescapeLiteral" },
  quoteIdentifier: { table: "SQL_WRITING", path: "quoteIdentifier" },
  placeholder: { table: "SQL_WRITING", path: "placeholder" },
  temporalLiteral: { table: "SQL_WRITING", path: "temporalLiteral" },
  insertDocuments: { table: "SQL_WRITING", path: "insertDocuments" },
  boundEdit: { table: "SQL_WRITING", path: "inlineEdit.boundEdit" },
  binaryLiteral: { table: "SQL_WRITING", path: "export.binaryLiteral" },
  rewriteDeclared: { table: "SQL_WRITING", path: "export.rewriteDeclared" },
  declareFromSample: { table: "SQL_WRITING", path: "export.declareFromSample" },
  typedLiteral: { table: "SQL_WRITING", path: "export.typedLiteral" },
  columnWriters: { table: "SQL_WRITING", path: "export.columnWriters" },
  createTableKeyClause: { table: "SQL_WRITING", path: "export.createTableKey.clause" },
  createTablePrimaryKey: { table: "MIGRATION_DDL", path: "createTable.primaryKey" },
  createTableForeignKey: { table: "MIGRATION_DDL", path: "createTable.foreignKey" },
  createTableRefusal: { table: "MIGRATION_DDL", path: "createTable.createTableRefusal" },
  columnDef: { table: "MIGRATION_DDL", path: "columnDef" },
  createIndex: { table: "MIGRATION_DDL", path: "createIndex" },
  dropIndex: { table: "MIGRATION_DDL", path: "dropIndex" },
  addForeignKey: { table: "MIGRATION_DDL", path: "addForeignKey" },
  dropForeignKey: { table: "MIGRATION_DDL", path: "dropForeignKey" },
  addColumn: { table: "MIGRATION_DDL", path: "addColumn" },
  dropColumn: { table: "MIGRATION_DDL", path: "dropColumn" },
  modifyColumn: { table: "MIGRATION_DDL", path: "modifyColumn" },
  dropTable: { table: "MIGRATION_DDL", path: "dropTable" },
  generatorQuote: { table: "SQL_ENGINE_GENERATORS", path: "quote" },
  generatorTable: { table: "SQL_ENGINE_GENERATORS", path: "table" },
  generatorSelect: { table: "SQL_ENGINE_GENERATORS", path: "select" },
  generatorSelectList: { table: "SQL_ENGINE_GENERATORS", path: "selectList" },
  catalogColumns: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.compose.columns" },
  catalogRelations: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.compose.relations" },
  catalogIndexes: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.compose.indexes" },
  catalogStatistics: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.compose.statistics" },
  declaredSchema: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.declaredSchema" },
  retryMatches: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.retry.matches" },
  retryRewrite: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.retry.rewrite" },
  mapRows: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogRead.mapRows" },
  emailShapeTest: { table: "AGENT_SERVER_OVERLAY", path: "dialect.profileComposition.shapeTests.email" },
  digitRunShapeTest: { table: "AGENT_SERVER_OVERLAY", path: "dialect.profileComposition.shapeTests.digitRun" },
  statisticsBuild: { table: "AGENT_SERVER_OVERLAY", path: "dialect.statistics.build" },
  captureBuild: { table: "AGENT_SERVER_OVERLAY", path: "dialect.catalogCapture.build" },
  groundingOverride: { table: "AGENT_SERVER_OVERLAY", path: "grounding" },
} as const satisfies Readonly<Record<string, DeclaredSlot>>);

/** The name of a slot of the table. */
export type DeclaredSlotName = keyof typeof DECLARED_SLOTS;

/** Whether `name` is the name of a slot of the table. */
export function isDeclaredSlotName(name: string): name is DeclaredSlotName {
  return Object.hasOwn(DECLARED_SLOTS, name);
}

/** The name of the slot at the dotted `path` of a `table` row, or undefined where the table names no slot there. */
export function slotNameAt(table: SlotTable, path: string): DeclaredSlotName | undefined {
  const names = Object.keys(DECLARED_SLOTS) as DeclaredSlotName[];
  return names.find((name) => DECLARED_SLOTS[name].table === table && DECLARED_SLOTS[name].path === path);
}

/** The value at the dotted `path` of `value`, or undefined where a member on the way is absent or null. */
export function valueAt(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const member of path.split(".")) {
    if (typeof at !== "object" || at === null || !Object.hasOwn(at, member)) return undefined;
    at = (at as Record<string, unknown>)[member];
  }
  return at;
}

/** The value `row` holds at the slot `name`'s path: the function the slot names, where the row fills it. */
export function slotFunction(row: object, name: DeclaredSlotName): unknown {
  return valueAt(row, DECLARED_SLOTS[name].path);
}
