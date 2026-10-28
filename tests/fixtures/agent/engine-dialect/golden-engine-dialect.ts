/**
 * The behaviour-neutral oracle of the agent's dialect-bound compositions, the companion of
 * `golden-sql-agent-surface.ts` and `golden-language-agent-surface.ts`, which hold what a model is sent.
 *
 * Per engine, every statement the agent composes for itself and every refusal it gives instead, each over a fixed
 * input: the catalog read per kind and selector (and, on PostgreSQL, the same read without the extension-ownership
 * tests), the estimating plan over a fixed set of statements, the statistics availability probe, and the table profile
 * per depth over one column of each type the profile composer decides on. Beside them, the statistics block as packed
 * for each dialect at both details, and the plan-mode posture body, which names the engines whose grounding capture is
 * a catalog read. The engines are the five SQL engines, the two other families' engines, and three engines with no
 * family, so a refusal is pinned as exactly as a statement.
 *
 * `golden-engine-dialect.json` beside this file is this module's output on the commit before the engine overlays
 * existed, except where a later change moved an answer on purpose and said why in its commit, and
 * `tests/unit/lib/agent/engine-dialect-golden.test.ts` holds today's output to it byte for byte. A change that means to
 * move an answer regenerates the file from the base it starts from, with that base's code, and commits it on its own
 * first:
 *
 *   bun tests/fixtures/agent/engine-dialect/golden-engine-dialect.ts > tests/fixtures/agent/engine-dialect/golden-engine-dialect.json
 *
 * Nothing here builds a provider or reaches a database: every entry point it calls is a pure function of its input.
 */
import {
  composeCatalogRead,
  composeEstimatingExplain,
  composeStatisticsAvailabilityProbe,
} from "@/lib/agent/composed-sql";
import {
  AgentComposedSqlError,
  type AgentCatalogKind,
  type AgentCatalogSelector,
} from "@/lib/agent/composed-sql-primitives";
import { withoutExtensionOwnershipTest } from "@/lib/agent/languages/sql/engines/postgres";
import { agentPosture } from "@/lib/agent/posture";
import { type AgentStatisticsDetail, type AgentTableEstimate, packSchemaStatistics } from "@/lib/agent/schema-stats";
import { type AgentProfileDepth, composeTableProfile } from "@/lib/agent/table-profile";
import type { AgentInventory } from "@/lib/agent/types";
import type { ColumnSchema, DatabaseType } from "@/lib/types";

const ENGINES: readonly DatabaseType[] = [
  "postgres",
  "sqlite",
  "duckdb",
  "mssql",
  "mysql",
  "mongodb",
  "kubernetes",
  "oracle",
  "redis",
  "libsql",
];

const KINDS: readonly AgentCatalogKind[] = ["columns", "relations", "indexes", "statistics"];

/** A bare read, a mixed-case schema, SQLite's own schema in capitals, and one table in one schema. */
const SELECTORS: readonly Omit<AgentCatalogSelector, "kind">[] = [
  {},
  { schema: "Sales" },
  { schema: "MAIN" },
  { schema: "public", table: "orders" },
];

/**
 * The statements an estimating plan is composed over: a bare read, each prefix a model has been seen to write itself,
 * the executing form that must not be stripped, and nothing at all.
 */
const EXPLAINED: readonly string[] = [
  "SELECT 1",
  "  explain select 1",
  "EXPLAIN QUERY PLAN SELECT 1",
  "EXPLAIN (FORMAT JSON) SELECT 1",
  "EXPLAIN FORMAT=JSON SELECT 1",
  "EXPLAIN ANALYZE SELECT 1",
  "",
];

const DEPTHS: readonly AgentProfileDepth[] = ["basic", "distribution", "pattern"];

/** One column per type the profile composer decides on, named after its type, and one SQL Server alias type. */
const PROFILE_COLUMNS: readonly ColumnSchema[] = [
  ...["int", "varchar", "text", "ntext", "image", "json", "jsonb", "xml", "geography", "geometry", "point", "uuid"].map(
    (type) => ({ name: `c_${type}`, type, nullable: true, isPrimary: false }),
  ),
  { name: "c_phone", type: "Phone", baseType: "nvarchar", nullable: true, isPrimary: false },
];

const PROFILE_SEGMENTS: readonly string[] = ["Sales", "Orders"];

/** The inventory the statistics are packed against: two tables with estimates, one with none, and a routine. */
const INVENTORY: AgentInventory = {
  objects: [
    {
      name: "public.orders",
      kind: "table",
      columns: [
        { name: "id", type: "integer", nullable: false, isPrimary: true },
        { name: "status", type: "text", nullable: true, isPrimary: false },
        { name: "note", type: "text", nullable: true, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: "public.audit_log",
      kind: "table",
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: "public.staging",
      kind: "table",
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
    },
    { name: "public.order_total(integer)", kind: "function", columns: [], indexes: [], foreignKeys: [] },
  ],
  kinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
    { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
  ],
};

/** A distinct count, a negative ratio, a null fraction, and a table whose row estimate is absent. */
const ESTIMATES: ReadonlyMap<string, AgentTableEstimate> = new Map([
  [
    "public.orders",
    {
      estimatedRows: 1200,
      columns: [
        { column: "status", distinct: 4, nullFraction: 0 },
        { column: "note", distinct: -0.5, nullFraction: 0.25 },
      ],
    },
  ],
  ["public.audit_log", { estimatedRows: null, columns: [{ column: "id", distinct: -1, nullFraction: null }] }],
]);

const STATISTICS_DIALECTS: readonly DatabaseType[] = ["postgres", "sqlite", "mssql", "mysql"];
const DETAILS: readonly AgentStatisticsDetail[] = ["rows-and-columns", "rows"];

/** A composed answer, or the composer's own refusal; anything else thrown is a defect and fails the generation. */
function outcome<T>(compose: () => T): T | { readonly reasonCode: string; readonly message: string } {
  try {
    return compose();
  } catch (error) {
    if (error instanceof AgentComposedSqlError) return { reasonCode: error.reasonCode, message: error.message };
    throw error;
  }
}

function engineEntry(engine: DatabaseType) {
  return {
    catalogRead: Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        SELECTORS.map((selector) => ({
          selector,
          sql: outcome(() => composeCatalogRead(engine, { ...selector, kind })),
        })),
      ]),
    ),
    estimatingExplain: EXPLAINED.map((sql) => ({
      sql,
      composed: outcome(() => composeEstimatingExplain(engine, sql)),
    })),
    statisticsAvailabilityProbe: outcome(() => composeStatisticsAvailabilityProbe(engine)),
    tableProfile: {
      ...Object.fromEntries(
        DEPTHS.map((depth) => [
          depth,
          outcome(() => composeTableProfile(engine, { segments: PROFILE_SEGMENTS, depth }, PROFILE_COLUMNS)),
        ]),
      ),
      noColumns: outcome(() => composeTableProfile(engine, { segments: PROFILE_SEGMENTS, depth: "basic" }, [])),
      noSegments: outcome(() => composeTableProfile(engine, { segments: [], depth: "basic" }, PROFILE_COLUMNS)),
    },
  };
}

/** The oracle's text: one JSON object, two spaces of indentation, and a final newline. */
export function goldenEngineDialect(): string {
  const result = {
    engines: Object.fromEntries(ENGINES.map((engine) => [engine, engineEntry(engine)])),
    withoutExtensionOwnershipTest: Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        SELECTORS.map((selector) => ({
          selector,
          sql: withoutExtensionOwnershipTest(composeCatalogRead("postgres", { ...selector, kind })),
        })),
      ]),
    ),
    packSchemaStatistics: Object.fromEntries(
      STATISTICS_DIALECTS.map((dialect) => [
        dialect,
        Object.fromEntries(
          DETAILS.map((detail) => [
            detail,
            packSchemaStatistics(INVENTORY, { kind: "read", dialect, byTable: ESTIMATES }, { detail }),
          ]),
        ),
      ]),
    ),
    planPostureBody: agentPosture({ mode: "planning", engine: null, engineLabel: "", handover: false }).body,
  };
  return `${JSON.stringify(result, null, 2)}\n`;
}

if (import.meta.main) process.stdout.write(goldenEngineDialect());
