import { describe, expect, mock, test } from "bun:test";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import {
  AGENT_STATISTICS_PACK_MAX_CHARS,
  type AgentSchemaStatistics,
  packSchemaStatistics,
  readSchemaStatistics,
} from "@/lib/agent/schema-stats";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { AgentRunMode } from "@/lib/agent/types";
import { UNTRUSTED_CONTENT_BEGIN, UNTRUSTED_CONTENT_END } from "@/lib/agent/untrusted-content";
import { QueryError } from "@/lib/db/errors";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";
import type { DatabaseConnection, DatabaseType, QueryResult, TableSchema } from "@/lib/types";

/**
 * The run's estimated statistics: reading them, and saying honestly what they are
 * (the plan-mode grounding design of 2026-08-15, work item 2).
 *
 * Three properties carry this module and each is asserted rather than described:
 *
 *  1. **Every read goes through the same audited catalog path as the inventory.**
 *     The harness is the spy pair the snapshot suite uses, so a statement that
 *     skipped the pipeline would show up here as a call this suite did not expect.
 *  2. **Absence is modelled, never defaulted.** A table the engine holds no
 *     statistics for is LISTED as having none. The whole point of the design item is
 *     that a model must not read silence as "empty table", so the tests below assert
 *     on the presence of the absent table's own line.
 *  3. **Nothing is stated more precisely than the engine stated it.** Every number
 *     reaches the model labelled an estimate, a `n_distinct` ratio is converted and
 *     labelled derived, and PostgreSQL's two "I do not know" spellings — `reltuples`
 *     of -1 and `n_distinct` of 0 — become absence rather than a number.
 */

const capabilities: ProviderCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  explainFormat: "postgres-json",
  supportsExternalQueryLimiting: true,
  supportsCreateTable: true,
  supportsInlineRowEdit: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "manual",
};

function connectionOf(type: DatabaseType): DatabaseConnection {
  return { id: "conn-1", name: "Orders", type, createdAt: new Date(0) };
}

function result(rows: readonly Record<string, unknown>[]): QueryResult {
  return {
    rows: rows as Record<string, unknown>[],
    fields: Object.keys(rows[0] ?? {}),
    rowCount: rows.length,
    executionTime: 3,
  };
}

const frozenClock = () => 1_000;

interface Harness {
  readonly context: AgentToolContext;
  readonly artifacts: ExecutionArtifactStore<QueryResult>;
  readonly statements: () => string[];
}

function harness(
  type: DatabaseType,
  answer: (sql: string) => Promise<QueryResult>,
  mode: AgentRunMode = "planning",
): Harness {
  const queryReadOnly = mock(answer);
  const provider = { queryReadOnly } as unknown as DatabaseProvider;
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });

  return {
    context: {
      runId: "run-1",
      modelId: "unmeasured-model-for-tests",
      mode,
      workflowType: "investigation",
      actor: { sessionId: "session-1", role: "user" },
      connection: connectionOf(type),
      capabilities,
      labels: TABLE_LABELS,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope("conn-1"),
      tracker: new ExecutionBudgetTracker(),
      artifacts,
      deadline: new AgentRunDeadline(
        AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2,
        frozenClock,
      ),
      repairs: new AgentRepairLedger(),
      acquireProvider: mock(async () => provider),
      clock: frozenClock,
    },
    artifacts,
    statements: () => queryReadOnly.mock.calls.map((call) => String(call[0])),
  };
}

/** What a PostgreSQL server answers the composed statistics read. */
const PG_STATISTICS = [
  {
    table_schema: "public",
    table_name: "orders",
    estimated_rows: 1000,
    column_name: "id",
    n_distinct: -1,
    null_frac: 0,
  },
  {
    table_schema: "public",
    table_name: "orders",
    estimated_rows: 1000,
    column_name: "status",
    n_distinct: 4,
    null_frac: 0.25,
  },
  // Never analysed: `pg_stats` has no row for it, so the LEFT JOIN carries the row
  // estimate with every statistics column NULL. -1 is PostgreSQL 14+'s "never
  // counted", which is not a row count of minus one and is not zero either.
  {
    table_schema: "public",
    table_name: "audit_log",
    estimated_rows: -1,
    column_name: null,
    n_distinct: null,
    null_frac: null,
  },
];

const answerPostgres = async (): Promise<QueryResult> => result(PG_STATISTICS);

const SQLITE_STATISTICS = [
  { table_name: "orders", index_name: "orders_customer_idx", stat: "1000 4" },
  // ANALYZE writes no `sqlite_stat1` row for a table with no index, and the LEFT
  // JOIN in the composed read is what keeps the table listed at all.
  { table_name: "notes", index_name: null, stat: null },
];

function answerSqlite(withStatisticsTable: boolean): (sql: string) => Promise<QueryResult> {
  return async (sql: string) => {
    if (sql.includes("name = 'sqlite_stat1'")) {
      return result(withStatisticsTable ? [{ name: "sqlite_stat1" }] : []);
    }
    return result(SQLITE_STATISTICS);
  };
}

/** The inventory the statistics are packed against. Order is the inventory's own. */
const TABLES: readonly TableSchema[] = [
  {
    name: "public.orders",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "status", type: "text", nullable: true, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
  },
  {
    name: "public.audit_log",
    columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
    indexes: [],
    foreignKeys: [],
  },
  // In the inventory and absent from the reading altogether — the other shape
  // absence takes, and the one a naive packing would simply not print.
  {
    name: "public.staging",
    columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
    indexes: [],
    foreignKeys: [],
  },
];

async function readOf(h: Harness): Promise<AgentSchemaStatistics> {
  return readSchemaStatistics(h.context);
}

describe("readSchemaStatistics — PostgreSQL", () => {
  test("sends exactly one statement, the server-composed statistics read", async () => {
    const h = harness("postgres", answerPostgres);

    await readOf(h);

    // One and only one: PostgreSQL needs no availability probe, because absence
    // there is per-table and already expressed as NULL statistics columns.
    expect(h.statements()).toHaveLength(1);
    expect(h.statements()[0]).toContain("pg_stats");
    expect(h.statements()[0]).toContain("reltuples");
  });

  test("keys the estimates by the qualified name the inventory uses", async () => {
    const statistics = await readOf(harness("postgres", answerPostgres));

    if (statistics.kind !== "read") throw new Error(`expected a reading, got ${statistics.reasonCode}`);
    expect([...statistics.byTable.keys()].sort()).toEqual(["public.audit_log", "public.orders"]);
    expect(statistics.byTable.get("public.orders")?.estimatedRows).toBe(1000);
  });

  test("reltuples of -1 is the engine saying it has never counted, so it is absence and not a count", async () => {
    const statistics = await readOf(harness("postgres", answerPostgres));

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("public.audit_log")?.estimatedRows).toBeNull();
    // And the table is still present: an unanalysed table must be listable AS
    // unanalysed, which is impossible if the reading drops it.
    expect(statistics.byTable.has("public.audit_log")).toBe(true);
  });

  test("carries n_distinct and null_frac per column, raw, and keeps the ratio's sign", async () => {
    const statistics = await readOf(harness("postgres", answerPostgres));

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("public.orders")?.columns).toEqual([
      { column: "id", distinct: -1, nullFraction: 0 },
      { column: "status", distinct: 4, nullFraction: 0.25 },
    ]);
    // A row with no `pg_stats` match carries no column at all, rather than a column
    // named "" with nothing known about it.
    expect(statistics.byTable.get("public.audit_log")?.columns).toEqual([]);
  });

  test("n_distinct of 0 is PostgreSQL's unknown, and is read as unknown rather than as no distinct values", async () => {
    const h = harness("postgres", async () =>
      result([
        { table_schema: "public", table_name: "t", estimated_rows: 5, column_name: "c", n_distinct: 0, null_frac: 0 },
      ]),
    );

    const statistics = await readOf(h);

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("public.t")?.columns[0]).toEqual({ column: "c", distinct: null, nullFraction: 0 });
  });

  test("numbers an engine returned as text are read as numbers, and unreadable ones as absent", async () => {
    const h = harness("postgres", async () =>
      result([
        {
          table_schema: "public",
          table_name: "t",
          estimated_rows: "1200",
          column_name: "c",
          n_distinct: "-0.5",
          null_frac: "not a number",
        },
      ]),
    );

    const statistics = await readOf(h);

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("public.t")?.estimatedRows).toBe(1200);
    expect(statistics.byTable.get("public.t")?.columns[0]).toEqual({
      column: "c",
      distinct: -0.5,
      nullFraction: null,
    });
  });

  test("a refused read leaves the run without statistics, and says which", async () => {
    const h = harness("postgres", async () => {
      throw new QueryError("permission denied for relation pg_statistic", "postgres");
    });

    const statistics = await readOf(h);

    expect(statistics).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
  });

  test("a reading whose rows the run no longer holds is not reconstructed from the model text", async () => {
    const h = harness("postgres", answerPostgres);
    const original = h.artifacts.put.bind(h.artifacts);
    h.artifacts.put = ((artifact: Parameters<typeof original>[0], nowMs: number) => {
      original(artifact, nowMs);
      h.artifacts.releaseRun("run-1");
    }) as typeof original;

    const statistics = await readOf(h);

    expect(statistics).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_RESULT_UNAVAILABLE" });
  });
});

describe("readSchemaStatistics — SQLite", () => {
  test("probes for sqlite_stat1 first, and only then reads it", async () => {
    const h = harness("sqlite", answerSqlite(true));

    await readOf(h);

    expect(h.statements()).toHaveLength(2);
    expect(h.statements()[0]).toContain("name = 'sqlite_stat1'");
    expect(h.statements()[1]).toContain("sqlite_stat1");
  });

  test("a database that has never been ANALYZEd is reported as having no statistics, not as a failure", async () => {
    const h = harness("sqlite", answerSqlite(false));

    const statistics = await readOf(h);

    expect(statistics).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_NEVER_COLLECTED" });
    // And the read that would have failed to PREPARE was never sent: this is the
    // whole reason the probe is a separate statement.
    expect(h.statements()).toHaveLength(1);
  });

  test("a refused probe is a refusal, not an absence — the two are different facts", async () => {
    const h = harness("sqlite", async () => {
      throw new QueryError("database is locked", "sqlite");
    });

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
  });

  test("a probe whose rows the run no longer holds is not read as an absent statistics table", async () => {
    const h = harness("sqlite", answerSqlite(true));
    const original = h.artifacts.put.bind(h.artifacts);
    h.artifacts.put = ((artifact: Parameters<typeof original>[0], nowMs: number) => {
      original(artifact, nowMs);
      h.artifacts.releaseRun("run-1");
    }) as typeof original;

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_RESULT_UNAVAILABLE" });
  });

  test("takes the row estimate from the first field of stat, and holds no column statistics at all", async () => {
    const statistics = await readOf(harness("sqlite", answerSqlite(true)));

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("orders")).toEqual({ estimatedRows: 1000, columns: [] });
    // The index-less table has a row in the reading and no estimate in it. Listing
    // it is what lets the packing say its size is unknown rather than omit it.
    expect(statistics.byTable.get("notes")).toEqual({ estimatedRows: null, columns: [] });
  });

  test("a stat string that does not begin with a number yields no estimate rather than a wrong one", async () => {
    const h = harness("sqlite", async (sql) =>
      sql.includes("name = 'sqlite_stat1'")
        ? result([{ name: "sqlite_stat1" }])
        : result([{ table_name: "orders", index_name: "i", stat: "unordered" }]),
    );

    const statistics = await readOf(h);

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("orders")?.estimatedRows).toBeNull();
  });
});

describe("readSchemaStatistics — what it will not do", () => {
  test("an engine with no verified statistics composition is refused, and no statement is sent", async () => {
    const h = harness("mysql", async () => result([]));

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "DIALECT_HAS_NO_STATISTICS" });
    expect(h.statements()).toHaveLength(0);
  });

  test("it is the SERVER's grounding read, so it works in planning mode — where the MODEL still has no tools", async () => {
    // The mode gate in `tools.ts` refuses a model-driven call outside agent mode.
    // This read is not one: it is the server establishing the run's context before
    // the first turn, exactly as it does in agent mode.
    const planning = await readOf(harness("postgres", answerPostgres, "planning"));
    const agent = await readOf(harness("postgres", answerPostgres, "agent"));

    expect(planning.kind).toBe("read");
    expect(agent.kind).toBe("read");
  });
});

// ============================================================================
// Packing
// ============================================================================

async function statisticsOf(h: Harness): Promise<AgentSchemaStatistics> {
  return readOf(h);
}

describe("packSchemaStatistics", () => {
  test("lists a table the engine holds no statistics for AS holding none", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));

    const packed = packSchemaStatistics(TABLES, statistics);

    // The design's emphatic requirement: silence must not be readable as zero. So
    // both shapes of absence are named, with what is not known about them.
    expect(packed).toContain("public.audit_log: no row estimate recorded; its size is unknown");
    expect(packed).toContain("public.staging: no statistics recorded for this table; its size is unknown");
    expect(packed).not.toContain("roughly 0 row(s)");
  });

  test("labels every number an estimate, and says so in the server's own voice as well", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));

    const packed = packSchemaStatistics(TABLES, statistics);

    expect(packed).toContain("roughly 1000 row(s), estimated");
    expect(packed).toContain("4 distinct value(s), estimated");
    expect(packed).toContain("25.0% null, estimated");
    // The preface is the SERVER speaking, so it sits ahead of the fence.
    expect(packed.indexOf("never an exact count")).toBeLessThan(packed.indexOf(UNTRUSTED_CONTENT_BEGIN));
    expect(packed).toContain("is not an empty table");
  });

  test("converts a negative n_distinct, and says the number is derived rather than reported", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));

    const packed = packSchemaStatistics(TABLES, statistics);

    // -1 is "distinct in every row": 1000 rows means about 1000 distinct values,
    // and the model must be able to tell that from a number the engine stated.
    expect(packed).toContain("id: about 1000 distinct value(s), derived");
  });

  test("a ratio with no row estimate to apply it to stays a ratio, and is not invented into a count", async () => {
    const h = harness("postgres", async () =>
      result([
        {
          table_schema: "public",
          table_name: "orders",
          estimated_rows: -1,
          column_name: "id",
          n_distinct: -0.5,
          null_frac: null,
        },
      ]),
    );

    const packed = packSchemaStatistics(TABLES, await readOf(h));

    expect(packed).toContain("id: about 50.0% of the row count distinct");
    expect(packed).toContain("which this engine has not estimated");
  });

  test("names the engine's own limits where they are absolute, rather than leaving a gap to be guessed at", async () => {
    const statistics = await statisticsOf(harness("sqlite", answerSqlite(true)));

    const packed = packSchemaStatistics([{ name: "orders", columns: [], indexes: [], foreignKeys: [] }], statistics);

    expect(packed).toContain("orders: roughly 1000 row(s), estimated");
    expect(packed).toContain("no per-column distinct count or null fraction at all");
  });

  test("database-derived text is fenced, because a table name is writable by whoever can write to the database", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));

    const packed = packSchemaStatistics(TABLES, statistics);

    expect(packed).toContain(UNTRUSTED_CONTENT_BEGIN);
    expect(packed).toContain(UNTRUSTED_CONTENT_END);
  });

  test("statistics that could not be read leave the model told that no size is known, not that sizes are small", async () => {
    const packed = packSchemaStatistics(TABLES, { kind: "unavailable", reasonCode: "STATISTICS_NEVER_COLLECTED" });

    expect(packed).toContain("has never been analysed");
    expect(packed).toContain("treat every table's size as unknown");
    // Nothing database-derived is in it, so there is nothing for a fence to mark.
    expect(packed).not.toContain(UNTRUSTED_CONTENT_BEGIN);
  });

  test("each reason for having no statistics is said in its own words", async () => {
    const reasons = (["DIALECT_HAS_NO_STATISTICS", "STATISTICS_READ_REFUSED", "STATISTICS_RESULT_UNAVAILABLE"] as const)
      .map((reasonCode) => packSchemaStatistics(TABLES, { kind: "unavailable", reasonCode }))
      .map((text) => text.split("\n")[0] ?? "");

    expect(new Set(reasons).size).toBe(3);
    expect(reasons[0]).toContain("does not hold");
  });

  test("an empty inventory packs to the reason it is empty rather than to a bare fence", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));

    const packed = packSchemaStatistics([], statistics);

    expect(packed).toContain("no tables");
    expect(packed).not.toContain(UNTRUSTED_CONTENT_BEGIN);
  });

  test("stays inside its bound, and names what it left out instead of truncating silently", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      table_schema: "public",
      table_name: `table_${index}`,
      estimated_rows: 1000 + index,
      column_name: "id",
      n_distinct: 5,
      null_frac: 0.5,
    }));
    const statistics = await readOf(harness("postgres", async () => result(rows)));
    const tables = rows.map((row) => ({
      name: `public.${row.table_name}`,
      columns: [],
      indexes: [],
      foreignKeys: [],
    })) as TableSchema[];

    const packed = packSchemaStatistics(tables, statistics);

    expect(packed.length).toBeLessThanOrEqual(AGENT_STATISTICS_PACK_MAX_CHARS);
    expect(packed).toContain("further table(s) omitted");
  });

  test("one wide table cannot spend the whole block on itself, and says how much it did not show", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      table_schema: "public",
      table_name: "orders",
      estimated_rows: 10,
      column_name: `column_${index}`,
      n_distinct: 3,
      null_frac: 0,
    }));
    const statistics = await readOf(harness("postgres", async () => result(rows)));

    const packed = packSchemaStatistics(
      [{ name: "public.orders", columns: [], indexes: [], foreignKeys: [] }],
      statistics,
    );

    expect(packed).toContain("more column(s) with statistics not shown");
  });

  /*
    `detail: "rows"`, which exists for the one workflow whose whole context is table
    names and index names (#411).

    That run is told in the server's own unfenced voice that it has been shown no column,
    and the default rendering names a column beside every table it has an estimate for —
    so the block under that sentence made it false, and a column name left the process on
    a run whose documented egress is identifiers of two kinds. What it needs from the
    estimates is which table is worth a reading, which is the one thing this rendering
    keeps. Found by review on #411.
  */
  test("row estimates alone, for a reader that has been shown no columns", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));

    const packed = packSchemaStatistics(TABLES, statistics, { detail: "rows" });

    expect(packed).toContain("roughly 1000 row(s), estimated");
    // Absence still says what is unknown, because that is the sentence about SIZE.
    expect(packed).toContain("public.audit_log: no row estimate recorded; its size is unknown");
    expect(packed).not.toContain("distinct value(s)");
    expect(packed).not.toContain("null, estimated");
  });

  test("not even the count of the columns it withheld", async () => {
    // "+3 more column(s) with statistics not shown" is a statement about columns, and
    // this rendering exists so a run told it has been shown none is not shown one.
    const rows = Array.from({ length: 40 }, (_unused, index) => ({
      table_schema: "public",
      table_name: "orders",
      estimated_rows: 10,
      column_name: `column_${index}`,
      n_distinct: 3,
      null_frac: 0,
    }));
    const statistics = await readOf(harness("postgres", async () => result(rows)));

    const packed = packSchemaStatistics(
      [{ name: "public.orders", columns: [], indexes: [], foreignKeys: [] }],
      statistics,
      { detail: "rows" },
    );

    expect(packed).toContain("public.orders: roughly 10 row(s), estimated");
    expect(packed).not.toContain("column(s)");
  });

  test("SQLite's per-column gap is not mentioned to a reader that gets no column either way", async () => {
    const statistics = await statisticsOf(harness("sqlite", answerSqlite(true)));

    expect(packSchemaStatistics(TABLES, statistics)).toContain("records no per-column distinct count");
    expect(packSchemaStatistics(TABLES, statistics, { detail: "rows" })).not.toContain("per-column");
  });

  test("with no statistics at all, a prose reader is not told what not to rest a STATEMENT on", async () => {
    // The same #350 shape: a rule about an artifact the run cannot produce is a rule it
    // has to guess at. This workflow writes no statement.
    const statistics = await statisticsOf(harness("mysql", async () => result([])));

    expect(packSchemaStatistics(TABLES, statistics, { detail: "rows" })).toContain(
      "rest nothing on how large a table is",
    );
    expect(packSchemaStatistics(TABLES, statistics)).toContain("do not write a statement whose correctness depends");
  });
});
