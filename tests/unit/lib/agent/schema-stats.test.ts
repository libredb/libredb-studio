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
import { type AgentToolContext, readStatisticsForGrounding } from "@/lib/agent/tools";
import type { AgentInventory, AgentInventoryObject, AgentRunMode } from "@/lib/agent/types";
import { UNTRUSTED_CONTENT_BEGIN, UNTRUSTED_CONTENT_END } from "@/lib/agent/untrusted-content";
import { QueryError } from "@/lib/db/errors";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import { TABLE_LABELS } from "../../../fixtures/provider-labels";
import type { DatabaseConnection, DatabaseType, QueryResult } from "@/lib/types";

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
  /** Every statement sent, through either provider method, in order. */
  readonly statements: () => string[];
  /** The method each statement went through: `queryReadOnly` under the read-only profile, `query` under operations. */
  readonly methods: () => string[];
  /** Every profile the read acquired, in order. */
  readonly profiles: () => string[];
}

function harness(
  type: DatabaseType,
  answer: (sql: string) => Promise<QueryResult>,
  mode: AgentRunMode = "planning",
  statementLanguage?: AgentToolContext["statementLanguage"],
): Harness {
  const sent: { readonly method: string; readonly sql: string }[] = [];
  const provider = {
    queryReadOnly: async (sql: string) => {
      sent.push({ method: "queryReadOnly", sql });
      return answer(sql);
    },
    query: async (sql: string) => {
      sent.push({ method: "query", sql });
      return answer(sql);
    },
  } as unknown as DatabaseProvider;
  const acquireProvider = mock(async (_connection: DatabaseConnection, _profile: string) => provider);
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });

  return {
    context: {
      runId: "run-1",
      modelId: "unmeasured-model-for-tests",
      mode,
      workflowType: "investigation",
      ...(statementLanguage === undefined ? {} : { statementLanguage }),
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
      acquireProvider,
      clock: frozenClock,
    },
    artifacts,
    statements: () => sent.map((call) => call.sql),
    methods: () => sent.map((call) => call.method),
    profiles: () => acquireProvider.mock.calls.map((call) => String(call[1])),
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

/**
 * What SQL Server answers `composeMssqlStatistics`: one row per user table, the sum of
 * `sys.partitions.rows` over the heap or clustered index. `sa` reading
 * AdventureWorks2022 gets 72 such rows.
 *
 * `estimated_rows` arrives as TEXT here on purpose: `SUM(p.rows)` is a `bigint` and a
 * driver is entitled to hand one back as a string rather than lose precision, which is
 * the case `numeric` exists for.
 */
const MSSQL_STATISTICS = [
  { table_schema: "public", table_name: "orders", estimated_rows: "1000" },
  { table_schema: "public", table_name: "audit_log", estimated_rows: 0 },
];

const answerMssql = async (): Promise<QueryResult> => result(MSSQL_STATISTICS);

function answerSqlite(withStatisticsTable: boolean): (sql: string) => Promise<QueryResult> {
  return async (sql: string) => {
    if (sql.includes("name = 'sqlite_stat1'")) {
      return result(withStatisticsTable ? [{ name: "sqlite_stat1" }] : []);
    }
    return result(SQLITE_STATISTICS);
  };
}

/** The inventory the statistics are packed against. Order is the inventory's own. */
const TABLE_OBJECTS: readonly AgentInventoryObject[] = [
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

/** The same inventory, with the kinds a PostgreSQL capture really carries. */
const TABLES: AgentInventory = {
  objects: TABLE_OBJECTS.map((object) => ({ ...object, kind: "table" })),
  kinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
    { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
  ],
};

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

describe("readSchemaStatistics — SQL Server", () => {
  /**
   * `ESTIMATE_BUILDERS` had arms for PostgreSQL and SQLite only, so every SQL Server run
   * reported `DIALECT_HAS_NO_STATISTICS` while the composer beside it answered 72 rows of
   * real table estimates. The composer being served is not enough on its own: this module
   * reads the rows BACK, and the two decisions are separate.
   */
  test("sends one statement and no availability probe, because sys.partitions is always there", async () => {
    const h = harness("mssql", answerMssql);

    const statistics = await readOf(h);

    expect(statistics.kind).toBe("read");
    expect(h.statements()).toHaveLength(1);
    expect(h.statements()[0]).toContain("SUM(p.rows)");
  });

  test("keys the estimates by the qualified name the inventory uses, so the two join", async () => {
    const statistics = await readOf(harness("mssql", answerMssql));

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.dialect).toBe("mssql");
    expect([...statistics.byTable.keys()]).toEqual(["public.orders", "public.audit_log"]);
  });

  test("reads a bigint handed back as text as a number, and holds no column statistics", async () => {
    const statistics = await readOf(harness("mssql", answerMssql));

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("public.orders")).toEqual({ estimatedRows: 1000, columns: [] });
    // 0 is a real count on this engine: `sys.partitions` is maintained, so an empty table
    // is 0 rather than the "never counted" -1 PostgreSQL's `reltuples` carries.
    expect(statistics.byTable.get("public.audit_log")).toEqual({ estimatedRows: 0, columns: [] });
  });

  test("an unreadable value is absence rather than a NaN that would print as a row count", async () => {
    const h = harness("mssql", async () =>
      result([{ table_schema: "public", table_name: "orders", estimated_rows: "not a number" }]),
    );

    const statistics = await readOf(h);

    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("public.orders")?.estimatedRows).toBeNull();
  });

  test("the estimates reach the packed block, which is what the run shows the model", async () => {
    const packed = packSchemaStatistics(TABLES, await readOf(harness("mssql", answerMssql)));

    expect(packed).toContain("public.orders: roughly 1000 row(s), estimated");
    expect(packed).toContain("public.audit_log: roughly 0 row(s), estimated");
    // In the inventory and absent from the reading: listed as unknown, never omitted.
    expect(packed).toContain("public.staging: no statistics recorded for this table; its size is unknown");
    // SQLite's absolute per-column limit is not claimed here: SQL Server DOES record
    // distributions, behind a DBCC command this boundary refuses, so the sentence that
    // says the engine records none would be false.
    expect(packed).not.toContain("records no per-column distinct count");
  });
});

describe("readSchemaStatistics: the profile it reads under", () => {
  /**
   * A plan run reads its statistics under the profile its inventory was read under. On an engine whose inventory comes
   * from its provider, that is the operations profile, and the read-only profile is never acquired: acquiring it runs
   * the engine's own read-only open, which refuses a login that can write and may run a write probe to find out.
   */
  test("SQL Server in plan mode: the composed read goes through the operations profile, never the read-only one", async () => {
    const h = harness("mssql", answerMssql);

    const statistics = await readOf(h);

    expect(statistics.kind).toBe("read");
    expect(h.profiles()).toEqual(["agent-operations"]);
    expect(h.methods()).toEqual(["query"]);
    expect(h.statements()[0]).toContain("SUM(p.rows)");
    // The estimates are the same ones the read-only path reads: the statement is the same composed one.
    if (statistics.kind !== "read") throw new Error("expected a reading");
    expect(statistics.byTable.get("public.orders")).toEqual({ estimatedRows: 1000, columns: [] });
  });

  test("SQL Server in agent mode grounds under its execution profile, so its statistics do too", async () => {
    const h = harness("mssql", answerMssql, "agent", "sql");

    expect((await readOf(h)).kind).toBe("read");
    expect(h.profiles()).toEqual(["agent-read-only"]);
    expect(h.methods()).toEqual(["queryReadOnly"]);
  });

  test.each([
    ["postgres", answerPostgres, 1],
    ["sqlite", answerSqlite(true), 2],
  ] as const)(
    "%s reads its composed catalog under the read-only profile, so its statistics are unchanged",
    async (type, answer, sent) => {
      const h = harness(type, answer);

      expect((await readOf(h)).kind).toBe("read");
      expect(h.profiles()).toEqual(Array(sent).fill("agent-read-only"));
      expect(h.methods()).toEqual(Array(sent).fill("queryReadOnly"));
    },
  );

  test("a read that fails under the operations profile is a refused read, said as one", async () => {
    const h = harness("mssql", async () => {
      throw new QueryError("The SELECT permission was denied on the object 'partitions'", "mssql");
    });

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
    expect(h.profiles()).toEqual(["agent-operations"]);
  });

  test("a driver failure that is no database error is still a refused read rather than a crash", async () => {
    const h = harness("mssql", async () => {
      throw new TypeError("the driver could not read the answer");
    });

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
  });

  test("more rows than the run's budget is refused, never cut, as the read-only path refuses it", async () => {
    const rows = Array.from(
      { length: AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxResultRows + 1 },
      (_, i) => ({
        table_schema: "dbo",
        table_name: `t${i}`,
        estimated_rows: i,
      }),
    );
    const h = harness("mssql", async () => result(rows));

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
  });

  test("more bytes than the run's budget is refused as well", async () => {
    const wide = "x".repeat(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxResultBytes);
    const h = harness("mssql", async () => result([{ table_schema: "dbo", table_name: wide, estimated_rows: 1 }]));

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
  });

  test("a read that outlasts the time the call was granted is refused, and the run stops waiting for it", async () => {
    const h = harness("mssql", () => new Promise<QueryResult>(() => {}));
    // 250ms is `AGENT_MINIMUM_CALL_MS`, the smallest call this deadline will admit, so the granted timeout is the
    // whole of what the run has left.
    const context = { ...h.context, deadline: new AgentRunDeadline(250, frozenClock) };

    expect(await readSchemaStatistics(context)).toEqual({ kind: "unavailable", reasonCode: "STATISTICS_READ_REFUSED" });
  });
});

describe("readStatisticsForGrounding", () => {
  test("a probe asked of a dialect that has none is the server's own defect, and nothing is acquired", async () => {
    const h = harness("mssql", answerMssql);

    await expect(readStatisticsForGrounding(h.context, "availability")).rejects.toThrow(
      "agent tool layer: mssql has no statistics availability probe to send",
    );
    expect(h.profiles()).toEqual([]);
  });
});

describe("readSchemaStatistics — what it will not do", () => {
  test("an engine with no verified statistics composition is refused, and no statement is sent", async () => {
    const h = harness("mysql", async () => result([]));

    expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "DIALECT_HAS_NO_STATISTICS" });
    expect(h.statements()).toHaveLength(0);
  });

  // DuckDB is composed for but has no reader; Oracle is not composed for at all. Both arrive
  // at the same answer before a statement is sent.
  test.each(["duckdb", "oracle"] as const)(
    "%s has no statistics this run reads, and no statement is sent",
    async (type) => {
      const h = harness(type, async () => result([]));

      expect(await readOf(h)).toEqual({ kind: "unavailable", reasonCode: "DIALECT_HAS_NO_STATISTICS" });
      expect(h.statements()).toHaveLength(0);
    },
  );

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

    const packed = packSchemaStatistics(
      { objects: [{ name: "orders", columns: [], indexes: [], foreignKeys: [] }] },
      statistics,
    );

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

  /*
    The inventory carries the engine's functions and sequences too (#789), and this pack
    speaks about every entry it is given in the words "no statistics recorded for this
    table; its size is unknown". Said about a function that is a category error handed to
    a model as a fact, so the pack reads only what the declared role says has rows.
  */
  test("a FUNCTION in the inventory gets no line, because a routine has no rows and no size", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));
    const withRoutine: AgentInventory = {
      ...TABLES,
      objects: [
        ...TABLES.objects,
        { name: "public.order_total(integer)", kind: "function", label: "order_total", columns: [], indexes: [] },
      ],
    };

    const packed = packSchemaStatistics(withRoutine, statistics);

    expect(packed).not.toContain("order_total");
    expect(packed).toContain("public.orders: roughly 1000 row(s), estimated");
  });

  test("an inventory of nothing but routines packs the same sentence an empty one does", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));
    const routinesOnly: AgentInventory = {
      kinds: TABLES.kinds,
      objects: [{ name: "public.order_total(integer)", kind: "function", columns: [], indexes: [] }],
    };

    expect(packSchemaStatistics(routinesOnly, statistics)).toContain("no tables");
  });

  test("an empty inventory packs to the reason it is empty rather than to a bare fence", async () => {
    const statistics = await statisticsOf(harness("postgres", answerPostgres));

    const packed = packSchemaStatistics({ objects: [] }, statistics);

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
    })) as AgentInventoryObject[];

    const packed = packSchemaStatistics({ objects: tables }, statistics);

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
      { objects: [{ name: "public.orders", columns: [], indexes: [], foreignKeys: [] }] },
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
      { objects: [{ name: "public.orders", columns: [], indexes: [], foreignKeys: [] }] },
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
