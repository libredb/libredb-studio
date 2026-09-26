/**
 * Control 3.7 (#246): every MCP tool call is audited under one correlation id, its decision before
 * any provider is reached, and a call whose decision cannot be recorded does not run.
 *
 * Driven through the route with a token minted at run time, and read on the authoritative stdout
 * line, the channel an operator's log pipeline consumes. The two cancellation exits need a signal
 * the test controls, so they call the tool handlers with a context built for the token's user.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as route from "@/app/api/mcp/route";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { logger } from "@/lib/logger";
import { McpConnectionContext } from "@/lib/mcp/context";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import { RunReadQueryInputSchema, runReadQuery } from "@/lib/mcp/tools/run-read-query";
import {
  countMethod,
  createDuckdbFile,
  createSqliteFile,
  failNextCall,
  gateMethod,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../helpers/mcp-fixtures";
import { legacyPost, modernPost, readJsonRpc, routeServe } from "../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../helpers/mcp-token";

pinMcpTestEnvironment();

const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-audit-"));
const AUDIT_FAILURE = "The call was not run because its audit record could not be written.";
const TOOL_ACTIONS = new Set(["list_connections", "inspect_schema", "run_read_query", "mint_token"]);
let token = "";
let restoreChannel: () => void = () => {};
let sink: ReturnType<typeof spyOn<Console, "log">>;

beforeAll(async () => {
  createSqliteFile(join(dir, "shop.db"), [
    "CREATE TABLE numbers (id INTEGER PRIMARY KEY)",
    "INSERT INTO numbers VALUES (1), (2)",
  ]);
  await createDuckdbFile(join(dir, "warehouse.duckdb"), ["CREATE TABLE facts (id INTEGER)"]);
});

beforeEach(async () => {
  clearRateLimitState();
  restoreChannel = useMcpChannel();
  token = await mintTestToken({ username: "alice", role: "admin" });
  writeSeedFile(dir, [
    { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
    { id: "warehouse", type: "duckdb", database: join(dir, "warehouse.duckdb") },
  ]);
  sink = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  sink.mockRestore();
  restoreChannel();
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The mcp_operation lines on stdout, in order. The provider factory also writes a plain-text
 * "[DB] Creating" line to console.log, so only the JSON lines are audit lines.
 */
function mcpLines(): Record<string, unknown>[] {
  return sink.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "mcp_operation");
}

/**
 * Makes only the audit lines throw. The provider factory's plain-text line goes through the same
 * console.log, and a sink that threw on it too would stop the call before any provider method is
 * reached whatever the audit code did, which would make the "never reached" counts vacuous.
 */
function failAuditLines(message: string): void {
  sink.mockImplementation((line?: unknown) => {
    if (String(line).startsWith("{")) throw new Error(message);
  });
}

async function callTool(name: string, args: Record<string, unknown>, id: number | string = 1) {
  return readJsonRpc(
    await serve(legacyPost({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, { token })),
  );
}

describe("a call whose decision cannot be recorded does not run", () => {
  test("run_read_query never reaches queryReadOnly, and the client reads only the fixed sentence", async () => {
    failAuditLines("audit sink unavailable at the log volume");
    const reads = countMethod(SQLiteProvider.prototype, "queryReadOnly");
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const reply = await callTool("run_read_query", { connection_id: "seed:shop", sql: "SELECT id FROM numbers" });
      expect(reply.result?.content).toEqual([{ type: "text", text: AUDIT_FAILURE }]);
      expect(JSON.stringify(reply)).not.toContain("audit sink unavailable");
      expect(reads.calls).toBe(0);
    } finally {
      reads.restore();
      errorLog.mockRestore();
    }
  });

  test("inspect_schema never reaches its provider", async () => {
    failAuditLines("audit sink unavailable");
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const reply = await callTool("inspect_schema", { connection_id: "seed:shop" });
      expect(reply.result?.content).toEqual([{ type: "text", text: AUDIT_FAILURE }]);
      expect(connects.calls).toBe(0);
    } finally {
      connects.restore();
      errorLog.mockRestore();
    }
  });
});

describe("every refusal exit writes one event with its reason", () => {
  test.each([
    [
      "a connection that is not visible",
      "run_read_query",
      { connection_id: "seed:absent", sql: "SELECT 1" },
      "mcp/decision",
      "mcp_connection_not_visible",
    ],
    [
      "a fence refusal",
      "run_read_query",
      { connection_id: "seed:shop", sql: "DELETE FROM numbers" },
      "mcp/decision",
      "mcp_statement_refused",
    ],
    [
      "a named schema the connection does not have",
      "inspect_schema",
      { connection_id: "seed:warehouse", schema: "nope" },
      "mcp/execution",
      "mcp_schema_not_found",
    ],
    [
      "an offset on a query that cannot be paged",
      "run_read_query",
      { connection_id: "seed:shop", sql: "VALUES (1)", offset: 1 },
      "mcp/execution",
      "mcp_offset_unsupported",
    ],
  ] as const)("%s", async (_name, tool, args, target, reason) => {
    await callTool(tool, args);
    const failures = mcpLines().filter((line) => line.outcome === "failure");
    expect(failures).toEqual([expect.objectContaining({ action: tool, route: target, reason })]);
  });

  test("a signal aborted before the call is refused as a decision", async () => {
    const controller = new AbortController();
    controller.abort();
    const context = new McpConnectionContext({ username: "alice", role: "admin" });
    await runReadQuery(RunReadQueryInputSchema.parse({ connection_id: "seed:shop", sql: "SELECT 1" }), {
      context,
      signal: controller.signal,
    });
    expect(mcpLines()).toEqual([expect.objectContaining({ route: "mcp/decision", reason: "mcp_cancelled" })]);
  });

  test("an abort during acquisition is the outcome mcp_cancelled", async () => {
    const gate = gateMethod(SQLiteProvider.prototype, "connect");
    try {
      const controller = new AbortController();
      const context = new McpConnectionContext({ username: "alice", role: "admin" });
      const call = inspectSchema(InspectSchemaInputSchema.parse({ connection_id: "seed:shop" }), {
        context,
        signal: controller.signal,
      });
      await gate.entered;
      controller.abort();
      gate.release();
      await call;
      expect(mcpLines().map((line) => [line.route, line.reason])).toEqual([
        ["mcp/decision", undefined],
        ["mcp/execution", "mcp_cancelled"],
      ]);
    } finally {
      gate.release();
      gate.restore();
    }
  });
});

describe("the SDK's argument refusals are recorded by the route", () => {
  test.each([
    ["run_read_query", { connection_id: "seed:shop", sql: "SELECT 1", max_rows: 999 }],
    ["inspect_schema", {}],
  ] as const)(
    "%s with invalid arguments writes one decision event for the token's user and no connection",
    async (tool, args) => {
      const reply = await callTool(tool, args);
      expect(JSON.stringify(reply.result?.content)).toContain("Input validation error");
      expect(mcpLines()).toEqual([
        expect.objectContaining({
          action: tool,
          route: "mcp/decision",
          outcome: "failure",
          reason: "mcp_invalid_arguments",
          actor: "alice",
        }),
      ]);
      expect(mcpLines()[0]).not.toHaveProperty("connection");
    },
  );

  test("an unknown tool and a call an SDK gate refused write no event", async () => {
    await callTool("no_such_tool", { max_rows: 999 });
    const gated = await serve(
      modernPost("tools/call", { name: "run_read_query", arguments: { max_rows: 999 } }, { token }),
    );
    expect(gated.status).toBe(400);
    expect(mcpLines()).toEqual([]);
  });
});

describe("what the trail records", () => {
  test.each(["seed:shop\nFORGED AUDIT LINE", "https://evil.example/seed:shop", `seed:${"x".repeat(10_000)}`])(
    "a connection id holding %# appears in no audit line",
    async (connectionId) => {
      await callTool("run_read_query", { connection_id: connectionId, sql: "SELECT 1" });
      for (const [line] of sink.mock.calls) expect(String(line)).not.toContain(connectionId);
    },
  );

  test("the decision precedes the outcome under one correlation id, and a reused JSON-RPC id gets a new one", async () => {
    await callTool("run_read_query", { connection_id: "seed:shop", sql: "SELECT id FROM numbers" }, 7);
    await callTool("run_read_query", { connection_id: "seed:shop", sql: "SELECT id FROM numbers" }, 7);
    const lines = mcpLines();
    expect(lines.map((line) => line.route)).toEqual(["mcp/decision", "mcp/execution", "mcp/decision", "mcp/execution"]);
    expect(lines[0].correlation_id).toBe(lines[1].correlation_id);
    expect(lines[2].correlation_id).toBe(lines[3].correlation_id);
    expect(lines[0].correlation_id).not.toBe(lines[2].correlation_id);
    expect(lines[0].connection).toBe("shop");
  });

  test("list_connections writes one event", async () => {
    await callTool("list_connections", {});
    expect(mcpLines()).toEqual([expect.objectContaining({ action: "list_connections", outcome: "success" })]);
  });

  test("the user is the token's, whatever the arguments claim, and the action is one of the four names", async () => {
    await callTool("run_read_query", { connection_id: "seed:shop", sql: "SELECT 'mallory' AS user_name" });
    for (const line of mcpLines()) {
      expect(line.actor).toBe("alice");
      expect(TOOL_ACTIONS.has(String(line.action))).toBe(true);
    }
  });

  test("a provider failure writes mcp_execution_failed, and the client reads it redacted", async () => {
    const failing = failNextCall(
      SQLiteProvider.prototype,
      "queryReadOnly",
      new Error("login failed for postgres://reader:hunter-two@db.internal/app"),
    );
    try {
      const reply = await callTool("run_read_query", { connection_id: "seed:shop", sql: "SELECT 1" });
      expect(JSON.stringify(reply)).not.toContain("hunter-two");
      expect(mcpLines().at(-1)).toMatchObject({ outcome: "failure", reason: "mcp_execution_failed" });
    } finally {
      failing.restore();
    }
  });
});
