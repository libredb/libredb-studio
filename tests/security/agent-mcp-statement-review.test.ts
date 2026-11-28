/**
 * Every agent and MCP statement gate reads Studio's review record of the engines statements run on at run time, and a
 * provider's own read-only statement path never opens an engine the record does not list. Every server gate, the start
 * of a run, the factory, the core read paths and the MCP statement tools, reads it as each engine record's
 * `agentExecution` grant (`servedEngineRecord` in src/lib/db/server-catalog.ts).
 *
 * The record is narrowed for this one process: SQLite's engine record's grant is false, because its real provider
 * implements `queryReadOnly` and needs only a temporary file, so each gate is shown refusing an engine whose provider
 * claims the path. PostgreSQL, still on the record, is the control in each test. Studio's own catalog with SQLite's
 * record changed is installed before any module under test is imported, so a module that derives a set from the
 * records as it loads (the MCP statement arms) derives it from the narrowed one. The catalog is forgotten when the file
 * ends. Run in its own process by `tests/run-tests.ts`, so the substitution reaches no other file.
 */
import { afterAll, describe, expect, mock, spyOn, test, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { McpStatementInput } from "@/lib/mcp/tools/run-statement";
import type { DatabaseProvider, ProviderCapabilities, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection, DatabaseType, QueryResult } from "@/lib/types";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, installHostCore } from "@/lib/provider-host/instance";
import { LEGACY_RUN_SESSIONS } from "../helpers/agent-engine-sessions";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

// The server's gates read SQLite's engine record, so Studio's own catalog with that record's grant changed is installed
// before any of them loads, and forgotten when the file ends.
const { craftedCatalog } = await import("../helpers/package-catalog");
const { forgetServerCatalog, installServerCatalog, legacyConnection, serverCatalogInstalled, servedEngineRecord } =
  await import("@/lib/db/server-catalog");
installServerCatalog(craftedCatalog({ sqlite: { agentExecution: false } }));
afterAll(forgetServerCatalog);

const { workflowAvailability } = await import("@/lib/agent/agent-manifest");
const { acquireExecutionProfileProvider, clearProviderCache, getExecutionProfileCacheStats } = await import(
  "@/lib/db/factory"
);
const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
const { ExecutionProfileError } = await import("@/lib/db/errors");
const { runReadOnlyReading } = await import("@/lib/db/operations/read-only-statement");
const { runReadOnlyExecute } = await import("@/lib/api/read-only-execute");
const { runReadQueryTool } = await import("@/lib/agent/tools");
const { captureContextSnapshot } = await import("@/lib/agent/context-snapshot");
const { AGENT_WORKFLOW_BUDGETS } = await import("@/lib/agent/execution-policy");
const { AgentRunDeadline } = await import("@/lib/agent/deadline");
const { AgentRepairLedger } = await import("@/lib/agent/repair-ledger");
const { ExecutionArtifactStore } = await import("@/lib/db/operations/artifacts");
const { ExecutionBudgetTracker } = await import("@/lib/db/operations/budgets");
const { createCanonicalOperationRegistry } = await import("@/lib/db/operations/descriptors");
const { createTargetScope } = await import("@/lib/db/operations/policy");
const { TABLE_LABELS } = await import("../fixtures/provider-labels");
const { mcpStatementSurface, mcpStatementArm, mcpStatementToolFor } = await import("@/lib/mcp/tools/statement-arms");
const { runStatement } = await import("@/lib/mcp/tools/run-statement");
const { McpConnectionContext } = await import("@/lib/mcp/context");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { createSqliteFile, pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } = await import(
  "../helpers/mcp-fixtures"
);

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-statement-review-"));
const sqliteFile = join(dir, "shop.db");
createSqliteFile(sqliteFile, ["CREATE TABLE numbers (id INTEGER PRIMARY KEY)", "INSERT INTO numbers VALUES (1)"]);

afterAll(async () => {
  await resetMcpTestState();
  rmSync(dir, { recursive: true, force: true });
});

const notReviewed = (type: DatabaseType) =>
  `Provider type "${type}" is not on the review record of engines that run agent and MCP statements, so no statement is sent on it, whatever its provider implements`;

const budget: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 10, maxResultBytes: 10_000 };

function answer(): QueryResult {
  return { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 1 };
}

/** Settles `promise` as its value or its error, so a refusal is asserted after a plain await. */
function settled<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (error: unknown) => error,
  );
}

/**
 * Asserts the refusal by its class, code and message only, so an answer that is not one prints as a short line. The
 * class is `StudioProfileRefusal`, the execution profile refusal Studio's own code writes.
 */
function expectNotReviewed(error: unknown, type: DatabaseType): void {
  const seen =
    error instanceof ExecutionProfileError
      ? [error.constructor.name, error.reasonCode, error.message]
      : `not refused: ${Object.prototype.toString.call(error)} ${error?.constructor?.name ?? ""}`;
  expect(seen).toEqual(["StudioProfileRefusal", "PROFILE_ENGINE_NOT_REVIEWED", notReviewed(type)]);
}

describe("an engine the review record does not list, though its provider implements queryReadOnly", () => {
  test("the record this process reads is the shipped one without SQLite", async () => {
    // The shipped grant register grants SQLite, so the installed engine record's false grant is this file's narrowing.
    const { GRANTED_AGENT_EXECUTION_ENGINES } = await import("@/lib/db/claim-grants");
    expect(GRANTED_AGENT_EXECUTION_ENGINES).toContain("sqlite");
    expect(serverCatalogInstalled()).toBe(true);
    expect(servedEngineRecord("sqlite").grants.agentExecution).toBe(false);
    expect(servedEngineRecord("postgres").grants.agentExecution).toBe(true);
    expect(typeof SQLiteProvider.prototype.queryReadOnly).toBe("function");
  });

  test("a statement-sending agent run on SQLite is refused at start as not reviewed, while plan mode, the operations workflow and an engine on the record still open", () => {
    expect(workflowAvailability("agent", "investigation", servedEngineRecord("sqlite"))).toEqual({
      open: false,
      cause: "not-reviewed",
    });
    expect(workflowAvailability("planning", "investigation", servedEngineRecord("sqlite")).open).toBe(true);
    expect(workflowAvailability("agent", "operations", servedEngineRecord("sqlite")).open).toBe(true);
    expect(workflowAvailability("agent", "investigation", servedEngineRecord("postgres")).open).toBe(true);
  });

  test.each([
    ["planning", "investigation"],
    ["agent", "operations"],
  ] as const)(
    "%s mode's %s workflow opens on SQLite but runs ungrounded: its composed catalog read is a statement, so the factory refuses its agent-read-only acquisition by name and nothing is built",
    async (mode, workflowType) => {
      const connection: DatabaseConnection = {
        id: `review-grounding-${mode}`,
        name: "Shop",
        type: "sqlite",
        database: sqliteFile,
        createdAt: new Date(0),
      };
      expect(workflowAvailability(mode, workflowType, servedEngineRecord("sqlite")).open).toBe(true);
      const acquisitions: Array<[string, unknown]> = [];
      const context: AgentToolContext = {
        runId: `run-grounding-${mode}`,
        modelId: "unmeasured-model-for-tests",
        mode,
        workflowType,
        actor: { sessionId: "session-grounding", role: "admin" },
        connection,
        capabilities: new SQLiteProvider(connection).getCapabilities(),
        labels: TABLE_LABELS,
        registry: createCanonicalOperationRegistry(),
        scope: createTargetScope(connection.id),
        tracker: new ExecutionBudgetTracker(),
        artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
        deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets.maxTotalRunMs, () => 1_000),
        repairs: new AgentRepairLedger(),
        sessions: LEGACY_RUN_SESSIONS,
        acquireProvider: async (target, profile) => {
          try {
            const provider = await acquireExecutionProfileProvider(
              legacyConnection(servedEngineRecord(target.type), target),
              profile,
              {},
              { allowExternalFileAccess: true },
            );
            acquisitions.push([profile, "granted"]);
            return provider;
          } catch (error) {
            acquisitions.push([profile, error]);
            throw error;
          }
        },
        clock: () => 1_000,
      };
      try {
        const capture = await captureContextSnapshot(context);
        expect(acquisitions.map(([profile]) => profile)).toEqual(["agent-read-only"]);
        expectNotReviewed(acquisitions[0]?.[1], "sqlite");
        expect(getExecutionProfileCacheStats().size).toBe(0);
        expect([
          capture.kind,
          capture.kind === "unavailable" ? capture.profileRefusal?.reasonCode : "not refused",
        ]).toEqual(["unavailable", "PROFILE_ENGINE_NOT_REVIEWED"]);
      } finally {
        await clearProviderCache();
      }
    },
  );

  test("the agent-read-only and agent-handover acquisitions of a SQLite file are refused by name though its provider implements queryReadOnly, and nothing is connected; agent-operations still opens it", async () => {
    const connection: DatabaseConnection = {
      id: "review-sqlite",
      name: "review sqlite",
      type: "sqlite",
      database: sqliteFile,
      createdAt: new Date(0),
    };
    const admin = { allowExternalFileAccess: true };
    const connect = spyOn(SQLiteProvider.prototype, "connect");
    const queryReadOnly = spyOn(SQLiteProvider.prototype, "queryReadOnly");
    try {
      const refusals = await Promise.all(
        (["agent-read-only", "agent-handover"] as const).map((profile) =>
          settled(acquireExecutionProfileProvider(connection, profile, {}, admin)),
        ),
      );
      for (const refusal of refusals) expectNotReviewed(refusal, "sqlite");
      expect(connect).not.toHaveBeenCalled();
      expect(queryReadOnly).not.toHaveBeenCalled();

      const operations = await acquireExecutionProfileProvider(connection, "agent-operations", {}, admin);
      expect(operations).toBeInstanceOf(SQLiteProvider);
      expect(operations.isConnected()).toBe(true);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      connect.mockRestore();
      queryReadOnly.mockRestore();
      await clearProviderCache();
    }
  });

  test("a statement and a reading on SQLite through the core read path are refused by name, and the provider is never called", async () => {
    const queryReadOnly = mock(async () => answer());
    const provider = { queryReadOnly } as unknown as DatabaseProvider;
    const read = mock(async () => answer());

    expectNotReviewed(
      await settled(
        runReadOnlyExecute(provider, {
          type: "sqlite",
          statement: "SELECT 1",
          budget,
          caller: new AbortController().signal,
          route: "/api/mcp",
        }),
      ),
      "sqlite",
    );
    expectNotReviewed(
      await settled(
        runReadOnlyReading({
          type: "sqlite",
          scrub: { type: "sqlite", forms: [] },
          statement: "catalog",
          budget,
          read,
          servedRows: (result) => result.rows,
          maxRows: budget.maxResultRows,
        }),
      ),
      "sqlite",
    );
    expect(queryReadOnly).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    const served = await runReadOnlyExecute(provider, {
      type: "postgres",
      statement: "SELECT 1",
      budget,
      caller: new AbortController().signal,
      route: "/api/mcp",
    });
    expect(served.rows).toEqual([{ id: 1 }]);
  });

  test("the agent's statement tool refuses a statement on a SQLite connection whatever acquirer hands its provider over, and nothing reaches the provider", async () => {
    const queryReadOnly = mock(async () => answer());
    const acquireProvider = mock(async () => ({ queryReadOnly }) as unknown as DatabaseProvider);
    const capabilities: ProviderCapabilities = {
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "sqlite-queryplan",
      supportsExternalQueryLimiting: true,
      supportsInlineRowEdit: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: null,
      schemaRefreshPattern: "manual",
    };
    const context: AgentToolContext = {
      runId: "run-review",
      modelId: "unmeasured-model-for-tests",
      mode: "agent",
      workflowType: "investigation",
      actor: { sessionId: "session-review", role: "user" },
      connection: { id: "conn-review", name: "Shop", type: "sqlite", createdAt: new Date(0) },
      capabilities,
      labels: TABLE_LABELS,
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope("conn-review"),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs, () => 1_000),
      repairs: new AgentRepairLedger(),
      sessions: LEGACY_RUN_SESSIONS,
      acquireProvider,
      clock: () => 1_000,
    };

    expectNotReviewed(await settled(runReadQueryTool(context, { sql: "SELECT id FROM numbers" })), "sqlite");
    expect(queryReadOnly).not.toHaveBeenCalled();
  });

  test("no MCP statement tool serves SQLite, and run_read_query refuses a SQLite seed before anything is acquired", async () => {
    for (const arm of Object.values(mcpStatementSurface().arms)) {
      if (arm !== null) expect(arm.types).not.toContain("sqlite");
    }
    expect(mcpStatementToolFor("sqlite")).toBeNull();
    expect(mcpStatementToolFor("postgres")).toBe("run_read_query");

    writeSeedFile(dir, [{ id: "shop", type: "sqlite", database: sqliteFile }]);
    getServerAuditBuffer().clear();
    const arm = mcpStatementArm("run_read_query");
    const acquire = spyOn(McpConnectionContext.prototype, "acquire");
    try {
      const result = await runStatement(
        arm,
        arm.inputSchema.parse({ connection_id: "seed:shop", sql: "SELECT 1" }) as McpStatementInput,
        {
          context: new McpConnectionContext({ username: "alice", role: "admin" }),
          signal: new AbortController().signal,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: `run_read_query cannot run on this connection: this tool does not serve SQLite; use inspect_schema there. It runs on ${arm.engines}.`,
        },
      ]);
      expect(acquire).not.toHaveBeenCalled();
      expect(
        getServerAuditBuffer()
          .getAll()
          .filter((event) => event.type === "mcp_operation"),
      ).toEqual([
        expect.objectContaining({
          action: "run_read_query",
          target: "mcp/decision",
          result: "failure",
          reason: "mcp_execution_failed",
          connectionName: "shop",
        }),
      ]);
    } finally {
      acquire.mockRestore();
    }
  });
});
