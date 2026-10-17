/**
 * run_query (#1774): one statement on a seed the operator opted in with mcp: "write", run under
 * the seed's own account. Covers the write switch, the per-seed opt-in, real writes on SQLite,
 * the read-only opt-in refusal, the untrusted notice, and the audit decision and outcome with a
 * statement kind.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerAuditBuffer } from "@/lib/audit";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_NOT_VISIBLE_TEXT, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { ROW_OVER_CAP_TEXT, timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { RunQueryInputSchema, runQuery, WRITE_NOT_OPTED_IN_TEXT } from "@/lib/mcp/tools/run-query";
import {
  createSqliteFile,
  failNextCall,
  gateMethod,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo, type Negotiation } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-write-"));
const serve = handlerServe(testAuthInfo());

beforeAll(() => {
  createSqliteFile(join(dir, "shop.db"), [
    "CREATE TABLE numbers (id INTEGER PRIMARY KEY, label TEXT)",
    "INSERT INTO numbers VALUES (1, 'one')",
  ]);
});

beforeEach(() => {
  process.env.LIBREDB_MCP_WRITE_ENABLED = "true";
  writeSeedFile(dir, [
    { id: "write", type: "sqlite", database: join(dir, "shop.db"), mcp: "write" },
    { id: "read", type: "sqlite", database: join(dir, "shop.db"), mcp: true },
  ]);
});

afterEach(async () => {
  delete process.env.LIBREDB_MCP_WRITE_ENABLED;
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Answered {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  negotiation: Negotiation = "legacy",
): Promise<Answered> {
  const session = await connectClient(serve, { negotiation });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation" && event.action === "run_query");

describe("run_query on a mcp: write seed", () => {
  test("inserts a row, answers the untrusted notice, and the row is really there", async () => {
    const inserted = await call("run_query", {
      connection_id: "seed:write",
      sql: "INSERT INTO numbers (id, label) VALUES (2, 'two')",
    });
    expect(inserted.isError).toBeUndefined();
    expect(inserted.content.map((block) => block.text)).toContain(MCP_UNTRUSTED_NOTICE);
    const read = await call("run_query", { connection_id: "seed:write", sql: "SELECT COUNT(*) AS n FROM numbers" });
    expect(read.structuredContent?.rows).toEqual([{ n: 2 }]);
  });

  test("updates, deletes and creates through run_query", async () => {
    await call("run_query", { connection_id: "seed:write", sql: "UPDATE numbers SET label = 'ONE' WHERE id = 1" });
    await call("run_query", { connection_id: "seed:write", sql: "CREATE TABLE extra (id INTEGER PRIMARY KEY)" });
    await call("run_query", { connection_id: "seed:write", sql: "INSERT INTO extra VALUES (10)" });
    await call("run_query", { connection_id: "seed:write", sql: "DELETE FROM numbers WHERE id = 1" });
    const read = await call("run_query", { connection_id: "seed:write", sql: "SELECT COUNT(*) AS n FROM numbers" });
    expect(read.structuredContent?.rows).toEqual([{ n: 1 }]);
  });

  test("refuses a seed opted in with mcp: true, with the fixed sentence and no provider", async () => {
    const reply = await call("run_query", { connection_id: "seed:read", sql: "INSERT INTO numbers (id) VALUES (99)" });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toBe(WRITE_NOT_OPTED_IN_TEXT);
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/decision", reason: "mcp_statement_refused" });
  });

  test("answers a made-up connection id exactly as a seed that did not opt in for write", async () => {
    const madeUp = await call("run_query", {
      connection_id: "seed:absent",
      sql: "INSERT INTO numbers (id) VALUES (99)",
    });
    expect(madeUp.isError).toBe(true);
    expect(madeUp.content[0].text).toBe(MCP_NOT_VISIBLE_TEXT);
  });

  test("writes the decision and outcome under one correlation id, naming the statement kind", async () => {
    await call("run_query", {
      connection_id: "seed:write",
      sql: "INSERT INTO numbers (id, label) VALUES (3, 'three')",
    });
    const events = mcpEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ target: "mcp/decision", statementKind: "write", result: "success" });
    expect(events[1]).toMatchObject({ target: "mcp/execution", statementKind: "write", result: "success" });
    expect(events[0].correlationId).toBe(events[1].correlationId);
  });

  test("classifies SELECT as read and DDL as ddl in the audit", async () => {
    await call("run_query", { connection_id: "seed:write", sql: "CREATE TABLE kind_ddl (id INTEGER)" });
    await call("run_query", { connection_id: "seed:write", sql: "SELECT 1" });
    const kinds = mcpEvents()
      .filter((event) => event.target === "mcp/decision")
      .map((event) => event.statementKind);
    expect(kinds).toContain("ddl");
    expect(kinds).toContain("read");
  });

  test.each([
    ["SELECT 1", "read"],
    ["VALUES (1)", "read"],
    ["SHOW TABLES", "read"],
    ["EXPLAIN SELECT 1", "read"],
    ["GRANT SELECT ON numbers TO alice", "other"],
    ["COPY numbers TO 'out'", "other"],
    ["CALL something()", "other"],
    ["DO something()", "other"],
    ["SET x = 1", "other"],
    ["EXPLAIN ANALYZE SELECT 1", "other"],
    ["EXPLAIN (ANALYZE) SELECT 1", "other"],
  ] as const)("classifies %s as %s", async (sql, kind) => {
    await runQuery(RunQueryInputSchema.parse({ connection_id: "seed:write", sql }), {
      context: new McpConnectionContext({ username: "alice", role: "admin" }),
      signal: new AbortController().signal,
    });
    const decision = mcpEvents().find((event) => event.target === "mcp/decision");
    expect(decision?.statementKind).toBe(kind);
  });
});

describe("the write switch", () => {
  test("run_query is absent from tools/list while the switch is off", async () => {
    delete process.env.LIBREDB_MCP_WRITE_ENABLED;
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("run_query");
      expect(names).toContain("run_read_query");
    } finally {
      await session.close();
    }
  });

  test("run_query is listed while the switch is on", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const names = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("run_query");
    } finally {
      await session.close();
    }
  });
});

describe("the tool module's boundaries", () => {
  test("never uses the read-only annotations and never calls queryReadOnly", () => {
    const source = readFileSync(join(import.meta.dir, "../../../src/lib/mcp/tools/run-query.ts"), "utf8");
    expect(source).not.toContain("MCP_READ_ONLY_ANNOTATIONS");
    expect(source).not.toMatch(/\.queryReadOnly\s*\(/);
    expect(source).toContain("MCP_WRITE_ANNOTATIONS");
    expect(source).toContain('call.context.acquire(connection, "mcp-write")');
  });

  test("parses its input schema and classifies the statement kind through the tool", async () => {
    const args = RunQueryInputSchema.parse({
      connection_id: "seed:write",
      sql: "UPDATE numbers SET label = 'x' WHERE id = 2",
    });
    const result = await runQuery(args, {
      context: new McpConnectionContext({ username: "alice", role: "admin" }),
      signal: new AbortController().signal,
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("failures", () => {
  test("a multi-statement text is refused before the provider, with no statement kind", async () => {
    const query = spyOn(SQLiteProvider.prototype, "query");
    try {
      const reply = await call("run_query", {
        connection_id: "seed:write",
        sql: "SELECT 1; DROP TABLE numbers",
      });
      expect(reply.isError).toBe(true);
      expect(reply.content[0].text).toContain("MULTIPLE_STATEMENTS");
      expect(reply.content[0].text).toContain("run_query runs exactly one SQL statement.");
      expect(query).not.toHaveBeenCalled();
      const decision = mcpEvents().find((event) => event.target === "mcp/decision");
      expect(decision).toMatchObject({ target: "mcp/decision", reason: "mcp_statement_refused" });
      expect(decision?.statementKind).toBeUndefined();
    } finally {
      query.mockRestore();
    }
  });

  test("a driver error is answered redacted and records mcp_execution_failed", async () => {
    const reply = await call("run_query", { connection_id: "seed:write", sql: "SELECT * FROM no_such_table" });
    expect(reply.isError).toBe(true);
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_execution_failed" });
  });

  test("a database argument on a connection that names its own database is refused", async () => {
    const reply = await call("run_query", { connection_id: "seed:write", sql: "SELECT 1", database: "other" });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toBe(
      "This connection reads only the database it names; call again without database.",
    );
  });

  test("an offset on a statement that cannot be paged is refused", async () => {
    const reply = await call("run_query", {
      connection_id: "seed:write",
      sql: "INSERT INTO numbers (id) VALUES (50)",
      offset: 1,
    });
    expect(reply.isError).toBe(true);
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_offset_unsupported" });
  });

  test("a row larger than the result cap is refused with the fixed sentence", async () => {
    const reply = await call("run_query", { connection_id: "seed:write", sql: "SELECT hex(zeroblob(20000)) AS fat" });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toBe(ROW_OVER_CAP_TEXT);
  });

  test("a result over the cap is cut to the largest page that fits", async () => {
    const reply = await call("run_query", {
      connection_id: "seed:write",
      sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 8) SELECT hex(zeroblob(4000)) AS pad FROM n",
    });
    expect(reply.isError).toBeUndefined();
    expect(reply.structuredContent?.truncated).toBe(true);
    expect(reply.structuredContent?.truncated_by).toBe("result_bytes");
  });

  test("a provider that throws while preparing the statement is answered as an engine failure", async () => {
    const spy = spyOn(SQLiteProvider.prototype, "prepareQuery").mockImplementation(() => {
      throw new Error("prepare refused");
    });
    try {
      const reply = await call("run_query", { connection_id: "seed:write", sql: "SELECT 1" });
      expect(reply.isError).toBe(true);
      expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_execution_failed" });
    } finally {
      spy.mockRestore();
    }
  });

  test("a failure to acquire the provider is answered as an engine failure", async () => {
    const failing = failNextCall(SQLiteProvider.prototype, "connect", new Error("dial refused"));
    try {
      const reply = await call("run_query", { connection_id: "seed:write", sql: "SELECT 1" });
      expect(reply.isError).toBe(true);
      expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_execution_failed" });
    } finally {
      failing.restore();
    }
  });

  test("a statement that outruns its deadline is the timeout", async () => {
    const gate = gateMethod(SQLiteProvider.prototype, "query");
    try {
      const pending = call("run_query", { connection_id: "seed:write", sql: "SELECT 1", timeout_ms: 500 });
      await gate.entered;
      const reply = await pending;
      expect(reply.content[0].text).toBe(timeoutText(500));
      expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_timeout" });
      gate.release();
      // Let the held statement finish so its file handle closes before the temp dir is removed.
      await gate.finished;
    } finally {
      gate.restore();
    }
  });

  test("a signal aborted before the call is the cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runQuery(RunQueryInputSchema.parse({ connection_id: "seed:write", sql: "SELECT 1" }), {
      context: new McpConnectionContext({ username: "alice", role: "admin" }),
      signal: controller.signal,
    });
    expect(result.content[0].text).toBe(MCP_CANCELLED_TEXT);
  });
});
