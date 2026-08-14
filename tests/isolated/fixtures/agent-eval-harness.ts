/**
 * The eval harness (#330 T1): what drives one scripted investigation to a ledger,
 * and reads that ledger back.
 *
 * The measuring instrument this milestone needed, and the reason it is first in
 * #330's order. Nine live runs on 2026-08-12 (#341) ended with every gate green and
 * not one report between them; what was missing was not a test but a REQUIREMENT,
 * and a requirement about model behaviour can only be enforced by something that
 * exercises model behaviour.
 *
 * Two rules shape it, both learned rather than chosen:
 *
 *  - **A scenario asserts against a LEDGER, not against prose.** The existing suite
 *    had one test touching this and it asserted the model's text was returned to
 *    the CALLER — a correct test of the wrong thing, because a user reads the
 *    ledger. `EvalDrive` therefore exposes the folded events, the statements that
 *    reached the database, and the goal verdict; the driver's return value is one
 *    field among them rather than the subject.
 *  - **A "restart" is a genuinely second set of in-memory objects** over the same
 *    data directory. `EvalRun.drive` builds a new store, service, budget tracker,
 *    artifact store, deadline and repair ledger every time, so a resumed run can
 *    only know what the previous one wrote down. Nothing is carried across by
 *    reference.
 *
 * The database is scripted rather than real: these scenarios measure the MODEL's
 * strategy, and a real engine would make the same scenario answer differently on
 * two machines. `tests/isolated/agent-investigation-e2e.test.ts` is where real
 * engines are driven, and it stays that way.
 *
 * Nothing here registers a `mock.module`. Files importing this must not share a
 * process with a suite that stubs `@/lib/llm/types`, `@/lib/agent/model-adapter` or
 * `@/lib/agent/provider-registry`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { type AgentGoalVerdict, verifyRunGoal } from "@/lib/agent/goal-verifier";
import { type AgentToolResources, runInvestigation } from "@/lib/agent/investigation";
import type { AgentModel } from "@/lib/agent/model-adapter";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type {
  AgentRunActor,
  AgentRunEvent,
  AgentRunMode,
  AgentRunStopReason,
  AgentRunWorkflowType,
  AgentRunTerminalStatus,
} from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { type ScriptedTurn, modelOver, scriptedModel } from "./agent-scripted-model";

// ─── the two Phase 1 engines ────────────────────────────────────────────────

export type EvalEngine = "postgres" | "sqlite" | "mysql";

export interface EvalEnginePreset {
  readonly connection: DatabaseConnection;
  readonly capabilities: ProviderCapabilities;
  /**
   * Catalog statements one drive sends before the model's first turn, in order.
   *
   * The count is a real per-engine difference rather than a fixture detail:
   * PostgreSQL reads three inventories (columns, relations, indexes) while SQLite
   * reads two, because `sqlite_master` returns each object's own DDL and the
   * relations come out of parsing it (`context-snapshot.ts`).
   */
  readonly catalogReads: readonly string[];
  /** What the scripted engine answers a catalog read with, so a snapshot can be built. */
  readonly catalogAnswer: (sql: string) => QueryResult | null;
  /**
   * Whether the stub provider carries `queryReadOnly` at all.
   *
   * The engine property that decides which workflows may run: only PostgreSQL and
   * SQLite implement it, and `acquireExecutionProfileProvider` refuses the
   * `agent-read-only` profile without it. A preset that does not serve it therefore
   * cannot answer a statement AT ALL — which is what makes "this run sent none" a
   * property the fixture enforces rather than one the assertions merely observe.
   */
  readonly servesReadOnlyStatements: boolean;
}

const POSTGRES_CAPABILITIES: ProviderCapabilities = {
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

const SQLITE_CAPABILITIES: ProviderCapabilities = {
  ...POSTGRES_CAPABILITIES,
  explainFormat: "sqlite-queryplan",
  supportsConnectionString: false,
  defaultPort: 0,
};

function result(rows: readonly Record<string, unknown>[], fields: readonly string[]): QueryResult {
  return { rows: [...rows], fields: [...fields], rowCount: rows.length, executionTime: 4 };
}

/** The eight-department fixture #341's turn-exhaustion defect was reproduced on. */
export const DEPARTMENTS = [
  "engineering",
  "sales",
  "support",
  "finance",
  "legal",
  "people",
  "marketing",
  "research",
] as const;

const PG_COLUMN_ROWS = DEPARTMENTS.flatMap((table) => [
  { table_schema: "public", table_name: table, column_name: "id", data_type: "integer", is_nullable: "NO" },
  { table_schema: "public", table_name: table, column_name: "name", data_type: "text", is_nullable: "YES" },
]);

const SQLITE_DDL_ROWS = DEPARTMENTS.map((table) => ({
  name: table,
  type: "table",
  sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, name TEXT)`,
}));

export const EVAL_ENGINES: Readonly<Record<EvalEngine, EvalEnginePreset>> = Object.freeze({
  postgres: {
    connection: { id: "conn_eval", name: "Company (PostgreSQL)", type: "postgres", createdAt: new Date(0) },
    capabilities: POSTGRES_CAPABILITIES,
    catalogReads: ["information_schema.columns", "information_schema.table_constraints", "pg_index"],
    catalogAnswer: (sql) => {
      if (sql.includes("information_schema.columns")) {
        return result(PG_COLUMN_ROWS, ["table_schema", "table_name", "column_name", "data_type", "is_nullable"]);
      }
      if (sql.includes("information_schema.table_constraints")) return result([], ["table_name"]);
      if (sql.includes("pg_index")) return result([], ["tablename"]);
      return null;
    },
    servesReadOnlyStatements: true,
  },
  sqlite: {
    connection: { id: "conn_eval", name: "Company (SQLite)", type: "sqlite", createdAt: new Date(0) },
    capabilities: SQLITE_CAPABILITIES,
    catalogReads: ["sqlite_master", "sqlite_master"],
    catalogAnswer: (sql) => {
      if (!sql.includes("sqlite_master")) return null;
      // The index inventory narrows on `type = 'index'`; the object read does not.
      return sql.includes("'index'")
        ? result([], ["name", "tbl_name", "sql"])
        : result(SQLITE_DDL_ROWS, ["name", "type", "sql"]);
    },
    servesReadOnlyStatements: true,
  },
  /**
   * A THIRD engine, and the only one here that is not a Phase 1 engine.
   *
   * It exists to make the operations workflow's whole claim observable: that
   * workflow is offered on engines with no database-native read-only statement path,
   * and until this preset the harness could not express one.
   *
   * It carries NO `queryReadOnly`, exactly as the real MySQL provider does not, so it
   * can answer neither a catalog read nor a statement: a run that sent one dies
   * visibly here instead of being quietly answered by PostgreSQL's default fixture
   * row. That is the difference between a fixture that observes the workflow's
   * central property and one that enforces it.
   */
  mysql: {
    connection: { id: "conn_eval", name: "Company (MySQL)", type: "mysql", createdAt: new Date(0) },
    capabilities: { ...POSTGRES_CAPABILITIES, explainFormat: "mysql-json", defaultPort: 3306 },
    catalogReads: [],
    catalogAnswer: () => null,
    servesReadOnlyStatements: false,
  },
} satisfies Record<EvalEngine, EvalEnginePreset>);

/**
 * What the scripted engine reports about ITSELF, for the curated readings.
 *
 * Every provider declares these six on the `DatabaseProvider` interface, which is
 * exactly why the operations workflow can be offered everywhere — so the stub
 * carries them on every engine, not only on the ones that answer statements.
 */
export interface EvalCuratedReadings {
  readonly getActiveSessions: (options?: { limit?: number }) => Promise<unknown[]>;
  readonly getSlowQueries: (options?: { limit?: number }) => Promise<unknown[]>;
  readonly getTableStats: (options?: { schema?: string }) => Promise<unknown[]>;
  readonly getIndexStats: (options?: { schema?: string }) => Promise<unknown[]>;
  readonly getStorageStats: () => Promise<unknown[]>;
  readonly getHealth: () => Promise<unknown>;
}

const DEFAULT_CURATED: EvalCuratedReadings = {
  getActiveSessions: async () => [
    {
      pid: 71,
      user: "app",
      database: "company",
      state: "active",
      query: "UPDATE orders SET total = 1 WHERE id = 9",
      duration: "00:04:10",
      durationMs: 250_000,
      blocked: true,
      waitEvent: "lock",
    },
  ],
  getSlowQueries: async () => [
    { queryId: "q7", query: "SELECT * FROM orders", calls: 900, totalTime: 90_000, avgTime: 100, rows: 900 },
  ],
  getTableStats: async () => [
    {
      schemaName: "company",
      tableName: "orders",
      rowCount: 1_000_000,
      tableSize: "900 MB",
      tableSizeBytes: 900_000_000,
      totalSize: "1 GB",
      totalSizeBytes: 1_000_000_000,
    },
  ],
  getIndexStats: async () => [
    {
      schemaName: "company",
      tableName: "orders",
      indexName: "orders_unused_idx",
      columns: ["note"],
      isUnique: false,
      isPrimary: false,
      indexSize: "40 MB",
      indexSizeBytes: 40_000_000,
      scans: 0,
    },
  ],
  getStorageStats: async () => [{ name: "data", size: "1 GB", sizeBytes: 1_000_000_000, usagePercent: 91 }],
  getHealth: async () => ({
    activeConnections: 12,
    databaseSize: "1 GB",
    cacheHitRatio: "88.0",
    slowQueries: [],
    activeSessions: [],
  }),
};

// ─── one drive's observation ────────────────────────────────────────────────

export interface EvalDrive {
  readonly status: AgentRunTerminalStatus;
  readonly stopReason: AgentRunStopReason;
  /** Model turns THIS drive took. A resumed run counts its own. */
  readonly turns: number;
  /** The model's closing prose. */
  readonly text: string;
  /** The ledger's event kinds, in order — what a reader of the timeline sees. */
  readonly kinds: readonly string[];
  readonly events: readonly AgentRunEvent[];
  /** Every statement that reached the database in this drive, in order. */
  readonly statements: readonly string[];
  /** Statements the MODEL asked for, with the drive's own catalog reads removed. */
  readonly modelStatements: readonly string[];
  /** What the model was sent, per turn. */
  readonly transcripts: readonly string[];
  /** Whether this run met the goal its mode was opened for. */
  readonly verdict: AgentGoalVerdict;
}

export interface EvalRunOptions {
  readonly engine?: EvalEngine;
  readonly mode?: AgentRunMode;
  /** What the run is FOR. Defaults to an investigation, as the store does. */
  readonly workflowType?: AgentRunWorkflowType;
  readonly objective?: string;
  readonly actor?: AgentRunActor;
  /**
   * Whether the run may also hand its answer to the editor. Defaults to off, as the
   * store does — which is the setting §4.4's third case is about: a run with this
   * unticked must still score `answered`, because the verdict asks what the run
   * PRODUCED and the hand-over is only where that answer was delivered.
   */
  readonly autoExecute?: boolean;
  /** What the scripted engine answers a MODEL statement with. Catalog reads are served by the preset. */
  readonly answer?: (sql: string) => Promise<QueryResult>;
  /**
   * Replaces the preset's catalog answers, so a fixture can put HOSTILE identifiers
   * into the inventory a run captures. Returning `null` for a statement falls back
   * to the preset, which is how a fixture makes one inventory hostile and leaves the
   * rest ordinary.
   */
  readonly catalogAnswer?: (sql: string) => QueryResult | null;
  /**
   * Fails the provider acquisition — a reach that dies BEFORE the statement is
   * sent, so it propagates rather than settling. Called once per acquisition and
   * may return nothing, which is how a fixture lets the drive's context capture
   * succeed and takes the pool away afterwards. This is the only way to leave a
   * step invoked with no outcome, which is the process-death window itself.
   */
  readonly acquireFails?: () => Error | undefined;
  /**
   * Overrides individual curated readings, so a fixture can make ONE of them
   * unavailable on an engine that serves the rest — the case the operations
   * verifier's second arm exists for.
   */
  readonly curated?: Partial<Record<keyof EvalCuratedReadings, unknown>>;
}

export interface EvalDriveOptions {
  readonly maxTurns?: number;
  readonly turnTimeoutMs?: number;
  /** Milliseconds the run's clock has jumped by the time the deadline is next read. */
  readonly spentMs?: number;
}

const DEFAULT_ACTOR: AgentRunActor = { sessionId: "sess_eval", role: "admin" };

/**
 * A run whose ledger outlives the processes that drive it.
 *
 * `drive` may be called more than once: each call is a fresh process's view of the
 * same durable directory, which is what makes a crash-and-resume scenario
 * expressible rather than simulated.
 */
export interface EvalRun {
  readonly runId: string;
  readonly engine: EvalEnginePreset;
  drive(script: readonly ScriptedTurn[], options?: EvalDriveOptions): Promise<EvalDrive>;
  /**
   * The same drive against a model this caller built — a REAL one, for the
   * scheduled real-model job. The scenario is otherwise identical, which is the
   * point: a scripted case and its live counterpart differ in the model and in
   * nothing else, so a disagreement between them is about the model.
   */
  driveModel(model: AgentModel, options?: EvalDriveOptions): Promise<EvalDrive>;
  /** Records a stop request against the durable ledger, as the HTTP surface would. */
  requestCancellation(): Promise<void>;
  events(): Promise<readonly AgentRunEvent[]>;
  dispose(): void;
}

export async function openEvalRun(options: EvalRunOptions = {}): Promise<EvalRun> {
  const engine = EVAL_ENGINES[options.engine ?? "postgres"];
  const mode = options.mode ?? "agent";
  const actor = options.actor ?? DEFAULT_ACTOR;
  const objective = options.objective ?? "Which department has the most employees?";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-"));

  const answer =
    options.answer ?? (async () => result([{ department: "engineering", headcount: 41 }], ["department", "headcount"]));
  const statements: string[] = [];

  const boot = () => {
    const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
    const tracker = new ExecutionBudgetTracker();
    const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 64 });
    return { store, service: new AgentRunService({ store, resources: { tracker, artifacts } }), tracker, artifacts };
  };

  const opened = boot();
  const record = await opened.service.start({
    mode,
    ...(options.workflowType === undefined ? {} : { workflowType: options.workflowType }),
    ...(options.autoExecute === undefined ? {} : { autoExecute: options.autoExecute }),
    actor,
    connectionId: engine.connection.id,
    objective,
  });

  /** One drive, whatever model is driving it. */
  const driveWith = async (
    model: AgentModel,
    transcripts: () => readonly string[],
    driveOptions: EvalDriveOptions,
  ): Promise<EvalDrive> => {
    const before = statements.length;
    const { store, service, tracker, artifacts } = boot();
    const queryReadOnly = async (sql: string): Promise<QueryResult> => {
      statements.push(sql);
      return options.catalogAnswer?.(sql) ?? engine.catalogAnswer(sql) ?? (await answer(sql));
    };
    // The curated readings sit on EVERY preset, because every provider declares them;
    // `queryReadOnly` sits only on the presets whose real engine implements it. A
    // preset without it can answer nothing but a curated reading, so an operations
    // eval that sent a statement fails on the fixture rather than on an assertion
    // somebody might later delete as redundant.
    const provider = {
      ...(engine.servesReadOnlyStatements ? { queryReadOnly } : {}),
      ...DEFAULT_CURATED,
      ...options.curated,
    } as unknown as DatabaseProvider;

    // The deadline's clock reads its start, and every later reading is that start
    // plus `spentMs`. At the default of zero it never advances, so the deadline is
    // never the reason anything fails — except where that is the point.
    const startedAtMs = 10_000;
    let started = false;
    const clock = (): number => {
      if (!started) {
        started = true;
        return startedAtMs;
      }
      return startedAtMs + (driveOptions.spentMs ?? 0);
    };

    /*
      The workflow this run was OPENED as, read back off the ledger — which is what
      `driveAgentRun` does (`src/lib/agent/runtime.ts`) and the reason this is a read
      rather than a closure over `record`: a drive is a fresh process's view of a
      durable run, so the budget it enforces has to come from the same place that
      process would find it.

      It was `AGENT_WORKFLOW_BUDGETS.investigation` for every drive, whatever the run
      was for (#373 review), so a `data-analysis` eval ran against 450 s where
      production gives it 900 s. Nothing failed; the scenarios were simply measured
      against a bound no run of that workflow has.
    */
    const persisted = await service.status(record.runId);
    if (persisted === null) throw new Error(`run ${record.runId} vanished between opening and driving it`);
    const budget = AGENT_WORKFLOW_BUDGETS[persisted.record.workflowType];

    const resources: AgentToolResources = {
      connection: engine.connection,
      capabilities: engine.capabilities,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(engine.connection.id),
      tracker,
      artifacts,
      deadline: new AgentRunDeadline(budget.runDeadlineMs, clock),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => {
        const failure = options.acquireFails?.();
        if (failure) throw failure;
        return provider;
      },
    };

    const outcome = await runInvestigation(record.runId, {
      service,
      model,
      resources,
      ...(driveOptions.maxTurns === undefined ? {} : { maxTurns: driveOptions.maxTurns }),
      ...(driveOptions.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: driveOptions.turnTimeoutMs }),
    });

    const view = await store.read(record.runId);
    if (!view) throw new Error(`run ${record.runId} has no ledger`);
    const sent = statements.slice(before);
    return {
      status: outcome.status,
      stopReason: outcome.stopReason,
      turns: outcome.turns,
      text: outcome.text,
      kinds: view.record.events.map((event) => event.kind),
      events: view.record.events,
      statements: sent,
      modelStatements: withoutCatalogReads(sent, mode === "agent" ? engine.catalogReads : []),
      transcripts: transcripts(),
      verdict: verifyRunGoal(view.record),
    };
  };

  return {
    runId: record.runId,
    engine,
    async drive(script, driveOptions = {}) {
      const scripted = scriptedModel(...script);
      return driveWith(
        await modelOver(scripted.fetch),
        () => scripted.turns.map((turn) => turn.transcript),
        driveOptions,
      );
    },
    async driveModel(model, driveOptions = {}) {
      return driveWith(model, () => [], driveOptions);
    },
    async requestCancellation() {
      await boot().store.requestCancellation(record.runId, actor);
    },
    async events() {
      const view = await boot().store.read(record.runId);
      if (!view) throw new Error(`run ${record.runId} has no ledger`);
      return view.record.events;
    },
    dispose() {
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * The statements the MODEL asked for, after the drive's own catalog reads.
 *
 * The prefix is VERIFIED rather than assumed: a bare `slice` would also return an
 * empty list for a run that never reached the database, so an assertion of `[]`
 * would pass both for a run that did exactly the right thing and for one that did
 * nothing at all. A drive that reused its run's recorded inventory reads no catalog,
 * which is why the expected prefix is only consumed while it matches.
 */
function withoutCatalogReads(sent: readonly string[], catalogReads: readonly string[]): readonly string[] {
  let index = 0;
  while (index < catalogReads.length && sent[index]?.includes(catalogReads[index] ?? "")) index += 1;
  if (index !== 0 && index !== catalogReads.length) {
    throw new Error(
      `expected ${catalogReads.length} catalog read(s) first, got: ${sent.slice(0, index + 1).join(" | ")}`,
    );
  }
  return sent.slice(index);
}
