/**
 * The Db2 LUW provider's capabilities and labels (#786).
 *
 * Kept out of the provider module so the declarations read as one table, and so a census can read
 * them without the driver. Every value below is a decision this provider made, and each one that
 * withholds a surface says why beside it.
 */
import type { ContainerLevels, ObjectKindSpec, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import { MAINTAINED_KINDS } from "./maintenance";
import { DB2_PREVIEW_PROJECTION } from "./values";

/**
 * One level, the schema. A connection opens one database, and nothing in the product can switch
 * the database on a live connection, so the database is not a level.
 */
export const DB2_CONTAINER_LEVELS: ContainerLevels = [{ id: "schema", label: "Schema", labelPlural: "Schemas" }];

/** The definition text of a view, a routine or a trigger is stored SQL, read out of `SYSCAT`. */
const SOURCE = { hasSource: true, sourceLanguage: "sql" } as const;

/**
 * Nine kinds, in the order the tree draws them.
 *
 * Only a table declares `acceptsRowWrites`, which opens the inline editor's writes, the data
 * import dialog and the row menus on it. db2-node 1.0.22 decoded non-ASCII VARCHAR as EBCDIC 037
 * (K1) and stored a bound DECIMAL that did not fit its column as a wrong value (K22), so a
 * read-then-write-back corrupted data and every write was off; 1.0.24 fixes both, measured on
 * 12.1.0.0 and 11.5.9.0 by an edit and an import of non-ASCII text and a DECIMAL read back as HEX.
 * A materialized query table is maintained by Db2, a view is not a table, and nothing declares
 * `acceptsSourceEdits` (`docs/providers/db2.md`, "Object edit").
 *
 * A materialized query table is Db2's materialized view: a table whose rows its query computes,
 * so it has columns and a definition. A module groups routines the way an Oracle package does,
 * and has no text of its own. An alias and a sequence are catalog rows rather than stored text, so
 * neither has a source.
 */
export const DB2_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true, acceptsRowWrites: true },
  { id: "view", role: "relation", label: "View", labelPlural: "Views", hasColumns: true, ...SOURCE },
  {
    id: "materialized_query_table",
    role: "relation",
    label: "Materialized Query Table",
    labelPlural: "Materialized Query Tables",
    hasColumns: true,
    ...SOURCE,
  },
  { id: "alias", role: "config", label: "Alias", labelPlural: "Aliases" },
  { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" },
  { id: "module", role: "group", label: "Module", labelPlural: "Modules", childKinds: ["procedure", "function"] },
  { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures", ...SOURCE },
  { id: "function", role: "routine", label: "Function", labelPlural: "Functions", ...SOURCE },
  { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table", ...SOURCE },
];

export function db2Capabilities(base: ProviderCapabilities): ProviderCapabilities {
  return {
    ...base,
    queryLanguage: "sql",
    defaultPort: 50000,
    // Db2's EXPLAIN fills the explain tables rather than answering a plan, so the single-statement
    // explain path has nothing to read.
    supportsExplain: false,
    // The create-table dialog has no Db2 row of column types in this version, and without one it
    // would emit PostgreSQL DDL in silence; an import into a new table would write `TEXT`, which
    // Db2 refuses (SQL0204N), and `NUMERIC`, which Db2 reads as DECIMAL(5,0) (D145).
    supportsCreateTable: false,
    // The grid's inline editor is a read-then-write-back, which db2-node 1.0.24 carries intact (K1
    // and K22 fixed; see `DB2_OBJECT_KINDS`).
    supportsInlineRowEdit: true,
    // `OFFSET m ROWS FETCH NEXT n ROWS ONLY`, built by this provider's own `prepareQuery`.
    supportsResultPagination: true,
    // No held session in this version.
    supportsTransactions: false,
    supportsMaintenance: true,
    // RUNSTATS and REORG, each run per table: Db2 LUW has no whole-database form of either, so
    // neither is offered globally. A Db2 view is a relation and refuses both, so each names the
    // kinds it runs on.
    maintenanceOperations: ["analyze", "optimize"],
    maintenanceOperationSpecs: {
      analyze: { label: "Run Statistics", perEntity: true, global: false, kinds: MAINTAINED_KINDS },
      optimize: { label: "Reorganize Table", perEntity: true, global: false, kinds: MAINTAINED_KINDS },
    },
    // A `db2://` URL pasted into the form fills its fields.
    supportsConnectionString: true,
    // Declared rather than left to the query generators' port heuristic, which has no arm for
    // 50000: its PostgreSQL fall-through quotes the same way today, and a declaration cannot
    // change under a later edit of that heuristic.
    identifierQuoting: "double",
    containerLevels: DB2_CONTAINER_LEVELS,
    // Only the declared depth is an address: a partial path would leave the schema unbound.
    containerPathShapes: "exact",
    objectKinds: DB2_OBJECT_KINDS,
    // How a preview reads each column: a LOB or XML column beside others is left out (`values.ts`).
    previewProjection: DB2_PREVIEW_PROJECTION,
  };
}

export function db2Labels(base: ProviderLabels): ProviderLabels {
  return {
    ...base,
    entityName: "Table",
    entityNamePlural: "Tables",
    analyzeAction: "Run Statistics",
    vacuumAction: "Reorganize Table",
    // Db2 has no VACUUM; this slot runs a REORG, which is `optimize`.
    vacuumActionOperation: "optimize",
    slowQueriesEmptyState: "Db2 query statistics are not read in this version of the Db2 provider.",
    sessionsEmptyState: "Db2 sessions are not read in this version of the Db2 provider.",
  };
}
