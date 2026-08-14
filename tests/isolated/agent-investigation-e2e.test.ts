import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { type AgentToolResources, runInvestigation } from "@/lib/agent/investigation";
import type { AgentModel } from "@/lib/agent/model-adapter";
import { resolveAgentProviderAdapter } from "@/lib/agent/provider-registry";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunActor, AgentRunEvent } from "@/lib/agent/types";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { chatToolCallStream, type FetchDouble } from "./fixtures/agent-transport";

/**
 * The capstone (#329 T14, epic #325): one whole investigation, driven twice, against
 * engines that really answer.
 *
 * Every other agent suite substitutes something for the database. `tools.ts`'s unit
 * tests hand the tool layer a spy `queryReadOnly`; `agent-investigation.test.ts` does
 * the same so it can assert what the loop DECIDES without an engine's opinions in the
 * way. Both are the right shape for what they prove, and neither can prove the thing
 * this file exists for: that the arc works when the answers come from a real engine —
 * a real error text, a real catalog, real rows, real column names.
 *
 * So nothing here is stubbed between the run loop and the engine:
 *
 *  - **The provider is acquired through the production seam.** The acquirer is
 *    `acquireExecutionProfileProvider` (`src/lib/db/factory.ts`), the same function
 *    T9's routes hand the loop, so the provider is opened under the agent read-only
 *    profile with its role verification and its `PRAGMA query_only` — not constructed
 *    here with the right-looking arguments.
 *  - **SQLite is a real temporary database file**, seeded through a writable provider
 *    and then read through a second, profiled one, the way
 *    `tests/integration/db/sqlite-provider.test.ts` does it. Its catalog rows are
 *    whatever `sqlite_master` holds, and its failure text is whatever the engine says.
 *  - **PostgreSQL is the suite's engine fixture**, meaning the technique
 *    `tests/integration/db/postgres-provider.test.ts` established: `mock.module("pg")`
 *    in front of a stateful in-process server double, so `PostgresProvider` runs
 *    unmodified — its `BEGIN READ ONLY` envelope, its extended-protocol statement, its
 *    `ROLLBACK`/`DISCARD ALL`. CI runs no PostgreSQL service (`docs/BACKLOG.md` A5),
 *    and that is recorded rather than papered over. Be exact about the split: what is
 *    REAL on this side is the PROVIDER and its envelope; the catalog rows, the result
 *    rows AND the `relation "ordrs" does not exist` refusal are all scripted, written
 *    to PostgreSQL's own wording and SQLSTATE. Only the SQLite half gets a failure text
 *    an engine genuinely produced.
 *  - **The model is the ratified provider package** over a scripted transport, as in
 *    the sibling suites: a stubbed model would prove the loop calls what it calls, not
 *    that the transcript it builds is one an SDK will send.
 *
 * The arc is the acceptance bar's, beat for beat: a drafted statement, a failure on a
 * wrong identifier, a repair informed by the schema tool, a verified statement, stored
 * artifacts, and a report whose claims cite them.
 *
 * One honest limit on how far "end to end" reaches: the tool resources below are
 * composed by hand, in parallel with `src/lib/agent/runtime.ts`, because that module
 * exports no composer to reuse. So a production wiring change that stays
 * type-compatible — a differently clocked deadline, another tracker — would not
 * surface here. What this file pins is the RUN, not the composition root; `runtime.ts`
 * has its own suite for that.
 *
 * Own test group, not part of Group 0f: this file mocks `pg`, and `mock.module` is
 * process-wide.
 */

const ACTOR: AgentRunActor = { sessionId: "sess_e2e", role: "user" };

const OBJECTIVE = "Which order statuses dominate the orders table?";

/** Connections are dated from a fixed instant; nothing in the arc reads it. */
const TIME = new Date(0);

// ─── the PostgreSQL engine double ───────────────────────────────────────────

/** An error shaped the way `pg` surfaces one the server raised. */
function pgServerError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

interface EngineAnswer {
  readonly rows: Record<string, unknown>[];
  readonly fields: { name: string }[];
  readonly rowCount: number;
}

/**
 * `fields` is derived from the first row, which is faithful only while a read returns
 * one — a real server reports the SELECT list even for an empty result. No read in
 * this arc comes back empty, so the shortcut is stated rather than fixed.
 */
function engineRows(data: Record<string, unknown>[]): EngineAnswer {
  return { rows: data, fields: Object.keys(data[0] ?? {}).map((name) => ({ name })), rowCount: data.length };
}

/**
 * The column inventory `information_schema.columns` answers for this fixture's two
 * tables — one row per column, which is the projection `composed-sql.ts` composes.
 */
const PG_COLUMN_ROWS: Record<string, unknown>[] = [
  {
    table_schema: "public",
    table_name: "customers",
    column_name: "id",
    data_type: "integer",
    is_nullable: "NO",
    ordinal_position: 1,
  },
  {
    table_schema: "public",
    table_name: "customers",
    column_name: "name",
    data_type: "text",
    is_nullable: "NO",
    ordinal_position: 2,
  },
  {
    table_schema: "public",
    table_name: "orders",
    column_name: "id",
    data_type: "integer",
    is_nullable: "NO",
    ordinal_position: 1,
  },
  {
    table_schema: "public",
    table_name: "orders",
    column_name: "customer_id",
    data_type: "integer",
    is_nullable: "NO",
    ordinal_position: 2,
  },
  {
    table_schema: "public",
    table_name: "orders",
    column_name: "status",
    data_type: "text",
    is_nullable: "NO",
    ordinal_position: 3,
  },
  {
    table_schema: "public",
    table_name: "orders",
    column_name: "total_cents",
    data_type: "integer",
    is_nullable: "NO",
    ordinal_position: 4,
  },
];

const PG_RELATION_ROWS: Record<string, unknown>[] = [
  {
    table_schema: "public",
    table_name: "orders",
    column_name: "customer_id",
    referenced_schema: "public",
    referenced_table: "customers",
    referenced_column: "id",
  },
];

const PG_INDEX_ROWS: Record<string, unknown>[] = [
  {
    table_schema: "public",
    table_name: "orders",
    index_name: "orders_pkey",
    is_unique: true,
    is_primary: true,
    column_name: "id",
  },
  {
    table_schema: "public",
    table_name: "orders",
    index_name: "orders_status_idx",
    is_unique: false,
    is_primary: false,
    column_name: "status",
  },
];

/** What the repaired statement returns. The same shape SQLite's real rows have. */
const PG_STATUS_ROWS: Record<string, unknown>[] = [
  { status: "paid", order_count: 3 },
  { status: "pending", order_count: 1 },
];

/** Applies the composed `AND table_name = '<name>'` narrowing, when the read carries one. */
function narrowByTable(rows: Record<string, unknown>[], sql: string): Record<string, unknown>[] {
  const selector = /table_name = '([^']+)'/.exec(sql);
  return selector === null ? rows : rows.filter((row) => row.table_name === selector[1]);
}

/**
 * A PostgreSQL server double: enough of one to run `PostgresProvider`'s read-only
 * profile unmodified, and no more.
 *
 * It is a second, smaller double rather than an import of the one in
 * `tests/integration/db/postgres-provider.test.ts`. That one is a security-model
 * simulator — it answers every SELECT with the same configured rows, because its job
 * is to prove what a read-only transaction does and does not stop. This one has to
 * answer three different catalog reads, a wrong identifier and a grouped aggregate
 * differently, which is a different question. It is also declared inside that file's
 * `describe` block, closed over its helpers and not exported, so sharing it would
 * mean refactoring a 2495-line reviewed suite for this test's convenience.
 */
class PostgresEngineDouble {
  /** Every statement the provider sent, envelope included, in order. */
  readonly statements: string[] = [];
  /** Set while a `BEGIN READ ONLY` is open, so a read can prove it arrived inside one. */
  private inReadOnlyTransaction = false;
  /** Statements that arrived OUTSIDE the read-only envelope. Must stay empty. */
  readonly unenveloped: string[] = [];

  async query(arg: unknown): Promise<EngineAnswer> {
    const text = (typeof arg === "string" ? arg : (arg as { text: string }).text).trim();

    // The role-privilege probe the profile runs at open, before any transaction.
    // Not recorded as a statement: the assertions below read `statements` as "what
    // the agent path sent".
    if (/is_superuser/i.test(text)) {
      return engineRows([
        { is_superuser: false, reads_server_files: false, writes_server_files: false, executes_programs: false },
      ]);
    }

    this.statements.push(text);

    if (/^BEGIN READ ONLY$/i.test(text)) {
      this.inReadOnlyTransaction = true;
      return engineRows([]);
    }
    if (/^SET LOCAL statement_timeout = \d+$/i.test(text)) return engineRows([]);
    if (/^ROLLBACK$/i.test(text)) {
      this.inReadOnlyTransaction = false;
      return engineRows([]);
    }
    if (/^DISCARD ALL$/i.test(text)) return engineRows([]);

    if (!this.inReadOnlyTransaction) this.unenveloped.push(text);

    // The narrowing is HONOURED rather than ignored: `inspect_schema({table})` composes
    // `AND table_name = '…'`, and a double that answered the whole inventory either way
    // would let a regression that dropped the clause pass unnoticed here. Only the
    // COLUMN read is narrowed: the relation and index reads are answered whole because
    // nothing in this arc narrows them, so a later test that does would need this to
    // grow their selectors (`tc.table_name`, `t.relname`) too.
    if (/information_schema\.columns/.test(text)) return engineRows(narrowByTable(PG_COLUMN_ROWS, text));
    if (/information_schema\.table_constraints/.test(text)) return engineRows(PG_RELATION_ROWS);
    if (/\bpg_index\b/.test(text)) return engineRows(PG_INDEX_ROWS);
    // The wrong identifier, refused by the engine in the engine's own words.
    if (/\bordrs\b/.test(text)) throw pgServerError('relation "ordrs" does not exist', "42P01");
    if (/\bFROM orders\b/i.test(text)) return engineRows(PG_STATUS_ROWS);

    // A statement the fixture has no answer for is a test defect, and it says so
    // rather than answering an empty result that an assertion might accept.
    throw pgServerError(`the PostgreSQL fixture has no answer for: ${text}`, "42601");
  }
}

/** The engine the mocked `pg` pool currently serves. Re-pointed per test. */
let engine = new PostgresEngineDouble();

class MockPool extends EventEmitter {
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;

  async connect() {
    return { query: (arg: unknown) => engine.query(arg), release: (_destroy?: Error) => {} };
  }

  async end() {}
}

mock.module("pg", () => ({
  Pool: function () {
    return new MockPool();
  },
}));

// ─── the scripted model ─────────────────────────────────────────────────────

interface Turn {
  readonly body: Record<string, unknown>;
  readonly transcript: string;
}

/** A model whose every turn is a function of what it was actually sent. */
function scriptedModel(...turns: readonly ((turn: Turn) => Response)[]): { fetch: FetchDouble; turns: Turn[] } {
  const seen: Turn[] = [];
  const fetchImpl: FetchDouble = async (_input, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const turn: Turn = { body, transcript: JSON.stringify(body.messages ?? []) };
    seen.push(turn);
    const next = turns[seen.length - 1];
    if (!next) throw new TypeError(`the script has no turn ${seen.length}`);
    return next(turn);
  };
  return { fetch: fetchImpl, turns: seen };
}

async function modelOver(fetchImpl: FetchDouble): Promise<AgentModel> {
  const config = { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" } as const;
  return {
    provider: "openai",
    modelId: config.model,
    model: await resolveAgentProviderAdapter("openai").createModel(config, fetchImpl),
  };
}

const callsTool = (name: string, input: unknown, callId: string) => (): Response =>
  chatToolCallStream(name, JSON.stringify(input), callId);

/**
 * The correlation id of the LAST read whose result is in the transcript — the one the
 * model just received, which is the artifact a report about it has to cite. Taken from
 * the transcript the way a model would have to take it: `executeAuditedOperation` mints
 * a plain UUID and it reaches the model inside the fenced result's header.
 */
function lastCorrelationIdIn(transcript: string): string {
  const matches = transcript.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
  if (!matches?.length) throw new Error(`no artifact reference in the transcript: ${transcript.slice(0, 400)}`);
  return matches[matches.length - 1]!;
}

const REPORT_CLAIM = "Paid is the dominant order status.";

// ─── one process's view of a run ────────────────────────────────────────────

const tempDirs: string[] = [];

function freshTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  readonly connection: DatabaseConnection;
  readonly capabilities: ProviderCapabilities;
  /** The statement the model drafts first, naming a table that is not there. */
  readonly failingSql: string;
  /** The statement it drafts after reading the catalog. */
  readonly repairedSql: string;
}

interface Arc {
  readonly runId: string;
  readonly status: string;
  readonly stopReason: string;
  readonly turns: number;
  readonly events: readonly AgentRunEvent[];
  readonly transcripts: readonly string[];
  /** The execution profile every acquisition asked the factory for. */
  readonly profiles: readonly ExecutionProfile[];
  /** The id the model cited, read out of the transcript as a model would have to. */
  readonly citedCorrelationId: string;
  /**
   * What the run's artifact store HELD for that id at the moment the report was
   * composed — the only point from which "stored artifacts" is observable, since
   * finishing a run releases them (`releaseExecutionRun`).
   */
  readonly storedAtReport: QueryResult | null;
  /** Whether the store still holds it once the run has ended. It must not. */
  readonly stillStoredAfterRun: boolean;
}

/**
 * Drives the whole arc once, against whichever engine the fixture opens.
 *
 * The ledger is a real `@workflow/world-local` over a real temporary directory; the
 * budget tracker, artifact store, deadline and repair ledger are this drive's own, as
 * they are in production.
 */
async function driveArc(fixture: Fixture): Promise<Arc> {
  const store = new AgentRunStore({
    world: createLocalWorld({ dataDir: freshTempDir("agent-e2e-ledger-"), recoverActiveRuns: false }),
  });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 32 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });

  const profiles: ExecutionProfile[] = [];
  const resources: AgentToolResources = {
    connection: fixture.connection,
    capabilities: fixture.capabilities,
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(fixture.connection.id),
    tracker,
    artifacts,
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.runDeadlineMs, Date.now),
    repairs: new AgentRepairLedger(),
    // The production seam, not a stand-in: this is what opens the provider under the
    // read-only profile, so the run really is bounded by the profile's own controls.
    acquireProvider: async (connection, profile) => {
      profiles.push(profile);
      return acquireExecutionProfileProvider(connection, profile);
    },
  };

  const run = await service.start({
    mode: "agent",
    actor: ACTOR,
    connectionId: fixture.connection.id,
    objective: OBJECTIVE,
  });

  // The report turn is also the only vantage point from which the run's artifact
  // store can be read WHILE the run is live: `finish` releases a run's artifacts with
  // its budget, so a check after `runInvestigation` returns can only ever see the
  // release. Reading it here is what makes "stored artifacts" an observation rather
  // than an inference from the reference the ledger kept.
  let citedCorrelationId = "";
  let storedAtReport: QueryResult | null = null;
  const composesReport = (turn: Turn): Response => {
    citedCorrelationId = lastCorrelationIdIn(turn.transcript);
    storedAtReport = artifacts.get(citedCorrelationId, Date.now())?.value ?? null;
    return chatToolCallStream(
      "compose_report",
      JSON.stringify({
        claims: [{ claim: REPORT_CLAIM, evidence: [{ source: "artifact", correlationId: citedCorrelationId }] }],
      }),
      "call_report",
    );
  };

  const script = scriptedModel(
    callsTool("run_read_query", { sql: fixture.failingSql, rationale: "count the orders by status" }, "call_draft"),
    callsTool("inspect_schema", { table: "orders" }, "call_schema"),
    callsTool("run_read_query", { sql: fixture.repairedSql, rationale: "the table is named orders" }, "call_repair"),
    composesReport,
  );

  const result = await runInvestigation(run.runId, {
    service,
    model: await modelOver(script.fetch),
    resources,
  });

  const view = await store.read(run.runId);
  if (!view) throw new Error(`run ${run.runId} has no ledger`);

  return {
    runId: result.runId,
    status: result.status,
    stopReason: result.stopReason,
    turns: result.turns,
    events: view.record.events,
    transcripts: script.turns.map((turn) => turn.transcript),
    profiles,
    citedCorrelationId,
    storedAtReport,
    stillStoredAfterRun: artifacts.get(citedCorrelationId, Date.now()) !== undefined,
  };
}

// ─── shared assertions ──────────────────────────────────────────────────────

const kindsOf = (events: readonly AgentRunEvent[]): string[] => events.map((event) => event.kind);

/**
 * The arc, asserted as the ordered ledger it wrote.
 *
 * Written as one equality rather than as a set of `toContain`s: the ORDER is the
 * claim. A repair that preceded the failure it repairs, or a report composed before
 * the read it cites, would satisfy every membership check and none of this.
 */
const ARC_LEDGER = [
  "run-started",
  // The drive's own schema capture, before the model was asked anything (T8).
  "context-captured",
  // Beat 1: the initial draft, recorded before the call it describes.
  "statement-drafted",
  "tool-invoked",
  // Beat 2: the engine refused it — a wrong identifier.
  "tool-refused",
  // Beat 3: the schema tool, which needs no draft (the model supplies a selector).
  "tool-invoked",
  "tool-completed",
  // Beat 4: the repaired statement, verified.
  "statement-drafted",
  "tool-invoked",
  "tool-completed",
  // Beat 5: the report, whose claims cite what the run read.
  "report-composed",
  "run-finished",
];

interface ArcExpectation {
  /** A fragment of the ENGINE's own refusal, so the failure is the database's. */
  readonly failureText: string;
  /** The columns the engine returned for the repaired statement. */
  readonly columnNames: readonly string[];
  readonly rowCount: number;
  /** A value from the rows, which must reach the model fenced as untrusted. */
  readonly rowValue: string;
  /** Content the catalog read really returned, in that engine's own catalog shape. */
  readonly catalogText: string;
  /**
   * Rows the NARROWED catalog read returned. Pins the `table` selector: without the
   * composed `AND … = 'orders'` the read comes back with the other table's rows too,
   * and every content check above would still pass.
   */
  readonly catalogRowCount: number;
  /** The rows the engine returned, which the run's artifact store must hold verbatim. */
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * A needle as it appears in a captured transcript. The transcript is the request body
 * re-serialised, so an engine message carrying double quotes (`relation "ordrs" …`)
 * is in there escaped; comparing the raw text would silently never match.
 */
const asTranscribed = (text: string): string => JSON.stringify(text).slice(1, -1);

/** The correlation id a completion recorded, or a sentinel that cannot match one. */
function referenceOf(event: AgentRunEvent | undefined): string {
  return event !== undefined && "artifact" in event ? event.artifact.correlationId : "(no artifact)";
}

function expectTheWholeArc(arc: Arc, expected: ArcExpectation): void {
  expect(arc.status).toBe("succeeded");
  expect(arc.stopReason).toBe("report-composed");
  expect(arc.turns).toBe(4);
  expect(kindsOf(arc.events)).toEqual(ARC_LEDGER);

  // Every acquisition went through the profile seam, and asked for the read-only
  // profile: the whole run's database access was under it.
  expect(arc.profiles.length).toBeGreaterThan(0);
  expect([...new Set(arc.profiles)]).toEqual(["agent-read-only"]);

  // Beat 2 — the refusal is a DATABASE error carrying the engine's own words, not a
  // policy denial. The two are different variants on purpose (`tools.ts`), and a run
  // whose repair was prompted by a boundary decision would be a different story.
  const refused = arc.events.find((event) => event.kind === "tool-refused");
  expect(refused && "refusal" in refused && refused.refusal.class).toBe("database-error");
  const refusal = refused && "refusal" in refused && "message" in refused.refusal ? refused.refusal : null;
  expect(refusal?.message).toContain(expected.failureText);
  // …and it reached the model fenced, under the failed statement's fingerprint — the
  // reference a failed execution has instead of a correlation id, since it produced no
  // artifact. Engine words are untrusted content even when they are an error.
  expect(arc.transcripts[1]).toContain(asTranscribed(expected.failureText));
  expect(arc.transcripts[1]).toContain(`reference ${refusal?.statementFingerprint}`);

  const completions = arc.events.filter((event) => event.kind === "tool-completed");
  expect(completions).toHaveLength(2);
  const schemaRead = completions[0];
  const verified = completions[1];

  // Beat 3 — the catalog read the repair was informed by, identified by ITS OWN
  // correlation id in the fenced header. Content alone would not do: the T8 snapshot
  // is fenced into the very first request and names the same tables and columns, so
  // an `inspect_schema` result that never arrived would still leave the engine's
  // catalog words in the transcript. The id is what only this read could have put there.
  const schemaTurn = arc.transcripts[2] ?? "";
  expect(schemaTurn).toContain(expected.catalogText);
  // `reference <id>` is the fenced header's own wording, so one assertion pins BOTH
  // that the result was fenced as untrusted content and that it is THIS read's. A bare
  // check for the begin-marker would pin neither: the T8 snapshot is fenced into the
  // very first request, so every transcript from index 0 already carries a fence.
  expect(schemaTurn).toContain(`reference ${referenceOf(schemaRead)}`);
  expect(schemaRead && "artifact" in schemaRead && schemaRead.artifact.summary.rowCount).toBe(expected.catalogRowCount);

  // Beat 4 — the verified statement's artifact, summarised from what the engine
  // really returned.
  expect(verified && "artifact" in verified && verified.artifact.summary.rowCount).toBe(expected.rowCount);
  expect(verified && "artifact" in verified && verified.artifact.summary.columnNames).toEqual([
    ...expected.columnNames,
  ]);
  expect(verified && "artifact" in verified && verified.artifact.runId).toBe(arc.runId);
  // The rows themselves reached the model, fenced under the verified read's own
  // reference — not merely present somewhere in a cumulative transcript.
  expect(arc.transcripts[3]).toContain(expected.rowValue);
  expect(arc.transcripts[3]).toContain(`reference ${referenceOf(verified)}`);

  // …and the run's artifact store HELD them while the run was live, keyed by the id
  // the model cited, then released them with the run.
  expect(arc.citedCorrelationId).toBe(referenceOf(verified));
  expect(arc.storedAtReport?.rows).toEqual([...expected.rows]);
  expect(arc.stillStoredAfterRun).toBe(false);

  // Beat 5 — the report's claim cites the artifact this run produced, by the id the
  // ledger records for it.
  const report = arc.events.find((event) => event.kind === "report-composed");
  expect(report && "claims" in report && report.claims).toHaveLength(1);
  expect(report && "claims" in report && report.claims[0]?.claim).toBe(REPORT_CLAIM);
  expect(report && "claims" in report && report.claims[0]?.evidence[0]).toEqual({
    source: "artifact",
    correlationId: referenceOf(verified),
  });
}

// ─── the SQLite fixture: a real database file ───────────────────────────────

const SQLITE_DDL = [
  "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE orders (" +
    "id INTEGER PRIMARY KEY, " +
    "customer_id INTEGER NOT NULL REFERENCES customers(id), " +
    "status TEXT NOT NULL, " +
    "total_cents INTEGER NOT NULL)",
  "CREATE INDEX orders_status_idx ON orders (status)",
  "INSERT INTO customers (id, name) VALUES (1, 'Ada'), (2, 'Grace')",
  "INSERT INTO orders (id, customer_id, status, total_cents) VALUES " +
    "(1, 1, 'paid', 1200), (2, 1, 'paid', 900), (3, 2, 'paid', 4500), (4, 2, 'pending', 700)",
];

/** What the repaired statement really returns from the seeded file. */
const SQLITE_STATUS_ROWS: Record<string, unknown>[] = [
  { status: "paid", order_count: 3 },
  { status: "pending", order_count: 1 },
];

/** Seeds a real database file through a WRITABLE provider, then closes it. */
async function seedSqliteFile(): Promise<string> {
  const dbPath = path.join(freshTempDir("agent-e2e-sqlite-"), "orders.db");
  const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
  const writer = new SQLiteProvider({ id: "seed", name: "seed", type: "sqlite", database: dbPath, createdAt: TIME });
  await writer.connect();
  try {
    for (const statement of SQLITE_DDL) await writer.query(statement);
  } finally {
    await writer.disconnect();
  }
  return dbPath;
}

// ─── the run ────────────────────────────────────────────────────────────────

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  engine = new PostgresEngineDouble();
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  await clearProviderCache();
  consoleSpy.mockRestore();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the whole investigation, against a real SQLite database file", () => {
  async function sqliteFixture(): Promise<Fixture> {
    const database = await seedSqliteFile();
    const connection: DatabaseConnection = {
      id: "conn_sqlite_e2e",
      name: "Orders (SQLite)",
      type: "sqlite",
      database,
      createdAt: TIME,
    };
    // Read from the provider the run itself will use, rather than declaring a
    // capability set by hand that could drift from the one the engine has.
    const provider: DatabaseProvider = await acquireExecutionProfileProvider(connection, "agent-read-only");
    return {
      connection,
      capabilities: provider.getCapabilities(),
      failingSql: "SELECT status, COUNT(*) AS order_count FROM ordrs GROUP BY status ORDER BY status",
      repairedSql: "SELECT status, COUNT(*) AS order_count FROM orders GROUP BY status ORDER BY status",
    };
  }

  test("drafts, fails on a wrong identifier, repairs from the catalog, and reports with evidence", async () => {
    const arc = await driveArc(await sqliteFixture());

    expectTheWholeArc(arc, {
      // SQLite's own words for a table that is not there.
      failureText: "no such table: ordrs",
      columnNames: ["status", "order_count"],
      rowCount: 2,
      rowValue: "paid",
      // `sqlite_master` returns each object's DDL text, which is what the SQLite
      // catalog read yields (`composed-sql.ts` explains why there is no structured
      // column list on this path).
      catalogText: "CREATE TABLE orders",
      // One object row: `sqlite_master` holds one entry per table, narrowed to `orders`.
      catalogRowCount: 1,
      rows: SQLITE_STATUS_ROWS,
    });
  });

  test("the rows the report rests on are the ones the engine really holds", async () => {
    // The scripted model can claim anything; what it cannot do is invent the engine's
    // answer. This pins the aggregate against the seeded file, so a fixture that
    // silently stopped seeding — or a read that reached a different database — fails
    // here rather than passing with an empty result.
    const fixture = await sqliteFixture();
    const provider = await acquireExecutionProfileProvider(fixture.connection, "agent-read-only");
    // The profile seam guarantees this method exists — it refuses a provider without
    // one — so its absence here is a wiring fault worth failing loudly on.
    if (typeof provider.queryReadOnly !== "function") throw new Error("the profiled provider has no read-only path");
    const result = await provider.queryReadOnly(fixture.repairedSql, {
      statementTimeoutMs: 5_000,
      maxResultRows: 100,
      maxResultBytes: 1_000_000,
    });

    expect(result.rows).toEqual(SQLITE_STATUS_ROWS);
  });
});

describe("the whole investigation, against the PostgreSQL suite's engine fixture", () => {
  async function postgresFixture(): Promise<Fixture> {
    const connection: DatabaseConnection = {
      id: "conn_pg_e2e",
      name: "Orders (PostgreSQL)",
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "orders",
      user: "agent",
      password: "secret",
      createdAt: TIME,
    };
    const provider: DatabaseProvider = await acquireExecutionProfileProvider(connection, "agent-read-only");
    return {
      connection,
      capabilities: provider.getCapabilities(),
      failingSql: "SELECT status, COUNT(*) AS order_count FROM ordrs GROUP BY status ORDER BY status",
      repairedSql: "SELECT status, COUNT(*) AS order_count FROM orders GROUP BY status ORDER BY status",
    };
  }

  test("drafts, fails on a wrong identifier, repairs from the catalog, and reports with evidence", async () => {
    const arc = await driveArc(await postgresFixture());

    expectTheWholeArc(arc, {
      failureText: 'relation "ordrs" does not exist',
      columnNames: ["status", "order_count"],
      rowCount: 2,
      rowValue: "paid",
      // The PostgreSQL catalog read is a structured column inventory, so a column of
      // the table the selector narrowed to is what the model sees.
      catalogText: "customer_id",
      // One row per COLUMN of `orders`, and none of `customers`.
      catalogRowCount: 4,
      rows: PG_STATUS_ROWS,
    });
  });

  test("every statement of the run arrived inside the read-only envelope", async () => {
    await driveArc(await postgresFixture());

    // The provider's envelope, not this test's: nothing here writes it, and a
    // provider that stopped opening one would leave the reads bare.
    expect(engine.unenveloped).toEqual([]);
    // Three catalog reads for the snapshot, then the model's three calls, the first
    // of which failed at the engine — six statements, each in its own transaction.
    expect(engine.statements.filter((text) => /^BEGIN READ ONLY$/i.test(text))).toHaveLength(6);
    expect(engine.statements.filter((text) => /^DISCARD ALL$/i.test(text))).toHaveLength(6);
    // Every one of the six is a DISTINCT statement — nothing was sent twice, and in
    // particular the failed one was not. Note what this does NOT prove: this script
    // never asks for it again, so the repair ledger's refusal of a fingerprint it has
    // already failed on is not what makes the count six here. That refusal is T6's
    // claim and `tests/unit/lib/agent/tools.test.ts` is where it is asserted.
    const reads = engine.statements.filter(
      (text) => !/^(BEGIN READ ONLY|SET LOCAL statement_timeout = \d+|ROLLBACK|DISCARD ALL)$/i.test(text),
    );
    expect(reads).toHaveLength(6);
    expect(new Set(reads).size).toBe(6);
  });
});
