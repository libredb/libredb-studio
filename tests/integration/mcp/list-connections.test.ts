/**
 * list_connections (#246), through the production handler and the official client in both eras:
 * the opted-in connections without credentials or file paths, paged under the 32 KiB result cap,
 * in one compact JSON block with no untrusted-content notice, and one audit event per call.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerAuditBuffer } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { MCP_CONNECTION_UNAVAILABLE_TEXT } from "@/lib/mcp/availability";
import { MCP_CONNECTIONS_UNREADABLE, type McpCaller, McpConnectionContext } from "@/lib/mcp/context";
import { MCP_RESULT_CAP_BYTES, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { AGENT_LANGUAGE_MCP_FACETS } from "@/lib/agent/languages/mcp";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { MCP_EXPOSABLE, MCP_STATEMENT_READ } from "@/lib/db/compatibility";
import { LIST_CONNECTIONS_DESCRIPTION } from "@/lib/mcp/tools/list-connections";
import { mcpStatementToolFor, servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import { resetCache } from "@/lib/seed";
import type { DatabaseType } from "@/lib/types";
import {
  createSqliteFile,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
  type SeedEntry,
} from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo, type Negotiation } from "../../helpers/mcp-harness";

const STAND_IN_AGENT_PASSWORD_MARKER = ["not", "a", "real", "agent", "password", "marker"].join("-");

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-list-"));
const serve = handlerServe(testAuthInfo());

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Listed {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
}

async function list(args: Record<string, unknown> = {}, negotiation: Negotiation = "legacy"): Promise<Listed> {
  const session = await connectClient(serve, { negotiation });
  try {
    return (await session.client.callTool({ name: "list_connections", arguments: args })) as Listed;
  } finally {
    await session.close();
  }
}

/** What the handler returned, measured as byte_size is: the era's own additions left out. */
const handlerBytes = (result: Listed) =>
  new TextEncoder().encode(JSON.stringify({ content: result.content, structuredContent: result.structuredContent }))
    .byteLength;

const SHOP: SeedEntry = {
  id: "shop",
  type: "sqlite",
  database: "/srv/libredb/data/shop.db",
  environment: "production",
};
const ANALYTICS: SeedEntry = {
  id: "analytics",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "analytics",
};

describe("the answer", () => {
  test.each(["legacy", "pinned"] as const)(
    "is the connections structured, in one compact JSON block and no notice (%s)",
    async (negotiation) => {
      writeSeedFile(dir, [SHOP, ANALYTICS]);
      const result = await list({}, negotiation);
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toEqual({
        connections: [
          {
            id: "seed:shop",
            name: "shop",
            engine: "sqlite",
            database: "shop.db",
            environment: "production",
            read_tool: "run_read_query",
          },
          {
            id: "seed:analytics",
            name: "analytics",
            engine: "postgres",
            database: "analytics",
            read_tool: "run_read_query",
          },
        ],
        total_connections: 2,
        has_more: false,
        next_offset: null,
      });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
      expect(JSON.stringify(result)).not.toContain(MCP_UNTRUSTED_NOTICE);
    },
  );

  test("carries no read_only, host, port, user, password, connection string or file path", async () => {
    writeSeedFile(dir, [SHOP, { ...ANALYTICS, environment: "production" }]);
    const text = JSON.stringify(await list());
    for (const hidden of ["read_only", "db.internal", "5432", "/srv/libredb", "password", "connectionString"]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("carries no server-side marker of whom a seed is offered to", async () => {
    writeSeedFile(dir, [{ ...ANALYTICS, roles: ["admin", "user"] }]);
    const result = await list();
    expect(result.structuredContent?.connections).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("sharedWithNonAdminRoles");
  });

  test("carries neither field of an agent credential, nor either value, on any page", async () => {
    const agent = { agentUser: "not-a-real-agent-user-marker", agentPassword: STAND_IN_AGENT_PASSWORD_MARKER };
    const many = Array.from({ length: 40 }, (_, index) => ({ ...ANALYTICS, id: `analytics-${index}`, ...agent }));
    writeSeedFile(dir, [SHOP, ...many]);
    let offset: number | null = 0;
    let listed = 0;
    while (offset !== null) {
      // oxlint-disable-next-line no-await-in-loop -- each page names the offset of the one after it.
      const result: Listed = await list({ offset });
      const text = JSON.stringify(result);
      for (const hidden of ["agentUser", "agentPassword", "agent_user", "not-a-real-agent"]) {
        expect(text).not.toContain(hidden);
      }
      listed += result.structuredContent?.connections.length ?? 0;
      offset = result.structuredContent?.next_offset ?? null;
    }
    expect(listed).toBe(41);
  });

  test("names a file-based database by its file name alone, a Windows path included", async () => {
    writeSeedFile(dir, [
      { id: "warehouse", type: "duckdb", database: "C:\\data\\warehouse.duckdb" },
      { id: "notes", type: "libredb", database: "/var/lib/studio/notes.libredb" },
    ]);
    const databases = (await list()).structuredContent?.connections.map(
      (connection: { database: string }) => connection.database,
    );
    expect(databases).toEqual(["warehouse.duckdb", "notes.libredb"]);
  });

  test("names the tool that runs a statement on each connection, and null where inspect_schema is the read", async () => {
    // The expected tool of each row comes from the served-engine resolver, which list_connections also answers from,
    // so the two independent pins are the wire's own tools/list and the records read directly, in both directions:
    // a row names a tool exactly when agent mode executes on the engine, MCP offers it, its statement read is open
    // and its language declares a facet, and then the facet's own tool. Druid is the control seed that only its
    // statement-read record keeps closed; Snowflake and InfluxDB over InfluxQL are closed by their other records.
    const CLUSTER = {
      id: "cluster",
      type: "kubernetes",
      host: "api.example",
      port: 6443,
      database: "shop",
      password: "TEST_PASSWORD",
    };
    const WAREHOUSE = {
      id: "warehouse",
      type: "snowflake",
      host: "org-account",
      user: "svc",
      role: "RO",
      password: "token",
      authMethod: "pat",
    };
    const seeds = [
      SHOP,
      { id: "events", type: "clickhouse", host: "127.0.0.1", port: 8123, database: "demo" },
      { id: "edge", type: "libsql", host: "127.0.0.1", port: 8080 },
      { id: "metrics", type: "influxdb3", host: "127.0.0.1", port: 8181, database: "home" },
      { id: "legacy-metrics", type: "influxdb", host: "127.0.0.1", port: 8086, database: "home" },
      { id: "search", type: "elasticsearch", host: "127.0.0.1", port: 9200 },
      { id: "fork-search", type: "opensearch", host: "127.0.0.1", port: 9201 },
      { id: "ledger", type: "oracle", host: "127.0.0.1", port: 1521, database: "FREEPDB1" },
      { id: "mainframe", type: "db2", host: "127.0.0.1", port: 50000, database: "SAMPLE" },
      { id: "ring", type: "cassandra", host: "127.0.0.1", port: 9042, database: "shop" },
      { id: "mongo", type: "mongodb", host: "127.0.0.1", port: 27017, database: "app" },
      { id: "travel", type: "couchbase", host: "127.0.0.1", port: 8091, database: "travel" },
      CLUSTER,
      { id: "kv", type: "libredb", database: join(dir, "kv.libredb") },
      { id: "semantic", type: "weaviate", host: "127.0.0.1", port: 8080 },
      { id: "vectors", type: "qdrant", host: "127.0.0.1", port: 6333 },
      { id: "embeddings", type: "milvus", host: "127.0.0.1", port: 19530 },
      { id: "broker", type: "rabbitmq", host: "127.0.0.1", port: 15672 },
      { id: "stream", type: "kafka", host: "127.0.0.1", port: 9092 },
      { id: "cache", type: "redis", host: "127.0.0.1", port: 6379 },
      { id: "olap", type: "druid", host: "127.0.0.1", port: 8888 },
      WAREHOUSE,
    ];
    writeSeedFile(dir, seeds);
    const session = await connectClient(serve);
    try {
      const listed = new Set((await session.client.listTools()).tools.map((tool) => tool.name));
      const answer = (await session.client.callTool({ name: "list_connections", arguments: {} })) as Listed;
      const rows: Array<{ id: string; read_tool: string | null }> = answer.structuredContent?.connections;
      expect(rows.map((row) => [row.id, row.read_tool])).toEqual(
        seeds.map((seed) => [`seed:${seed.id}`, mcpStatementToolFor(seed.type as DatabaseType)]),
      );
      const served = new Set<string>(servingStatementArms().flatMap((arm) => arm.types));
      for (const [index, row] of rows.entries()) {
        const type = seeds[index].type as DatabaseType;
        if (row.read_tool !== null) expect(listed.has(row.read_tool)).toBe(true);
        expect(row.read_tool === null).toBe(!served.has(type));
        const language = AGENT_STATEMENT_LANGUAGE[type];
        const facet = language === null ? null : AGENT_LANGUAGE_MCP_FACETS[language];
        const open = AGENT_EXECUTION_ENGINES.includes(type) && MCP_EXPOSABLE[type] && MCP_STATEMENT_READ[type];
        expect([row.id, row.read_tool]).toEqual([row.id, open && facet !== null ? facet.tool : null]);
      }
      const closed = new Set(["seed:legacy-metrics", "seed:olap", "seed:warehouse"]);
      expect(rows.filter((row) => closed.has(row.id)).map((row) => [row.id, row.read_tool])).toEqual([
        ["seed:legacy-metrics", null],
        ["seed:olap", null],
        ["seed:warehouse", null],
      ]);
      expect([AGENT_EXECUTION_ENGINES.includes("druid"), MCP_EXPOSABLE.druid, MCP_STATEMENT_READ.druid]).toEqual([
        true,
        true,
        false,
      ]);
    } finally {
      await session.close();
    }
  });

  test("with no seed file at all is the empty list", async () => {
    process.env.SEED_CONFIG_PATH = join(dir, "absent-seed-connections.yaml");
    resetCache();
    expect((await list()).structuredContent).toEqual({
      connections: [],
      total_connections: 0,
      has_more: false,
      next_offset: null,
    });
  });

  test("is filtered by environment before it is counted", async () => {
    writeSeedFile(dir, [SHOP, ANALYTICS]);
    const result = await list({ environment: "production" });
    expect(result.structuredContent?.connections.map((connection: { id: string }) => connection.id)).toEqual([
      "seed:shop",
    ]);
    expect(result.structuredContent?.total_connections).toBe(1);
  });
});

describe("a connection no tool can read", () => {
  const ALICE: McpCaller = { username: "alice", role: "admin" };
  const BOB: McpCaller = { username: "bob", role: "user" };
  let savedGovernance: string | undefined;
  let savedEnabledProviders: string | undefined;

  // The listing and editorExecutionContext both read GOVERNANCE_SOURCE, and acquiring a provider reads
  // LIBREDB_ENABLED_PROVIDERS, so a developer's setting of either is set aside.
  beforeEach(() => {
    savedGovernance = process.env.GOVERNANCE_SOURCE;
    delete process.env.GOVERNANCE_SOURCE;
    savedEnabledProviders = process.env.LIBREDB_ENABLED_PROVIDERS;
    delete process.env.LIBREDB_ENABLED_PROVIDERS;
  });

  afterEach(() => {
    if (savedGovernance === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedGovernance;
    if (savedEnabledProviders === undefined) delete process.env.LIBREDB_ENABLED_PROVIDERS;
    else process.env.LIBREDB_ENABLED_PROVIDERS = savedEnabledProviders;
  });

  /** One list_connections call with no arguments, through the production handler, as `caller`'s token. */
  async function listAs(caller: McpCaller): Promise<Listed> {
    const session = await connectClient(handlerServe(testAuthInfo(caller)));
    try {
      return (await session.client.callTool({ name: "list_connections", arguments: {} })) as Listed;
    } finally {
      await session.close();
    }
  }

  test.each([
    ["every role, to an admin token", ALICE, ["*"]],
    ["the user role, to a user token", BOB, ["user"]],
    ["admin and user, to an admin token, as a seed another role can use opens for no caller", ALICE, ["admin", "user"]],
  ] as const)(
    "a SQLite seed offered to %s lists read_tool null and the unavailable sentence",
    async (_, caller, roles) => {
      writeSeedFile(dir, [{ ...SHOP, roles }]);
      expect((await listAs(caller)).structuredContent?.connections).toEqual([
        {
          id: "seed:shop",
          name: "shop",
          engine: "sqlite",
          database: "shop.db",
          environment: "production",
          read_tool: null,
          unavailable: MCP_CONNECTION_UNAVAILABLE_TEXT,
        },
      ]);
    },
  );

  test("a SQLite seed offered to admins alone keeps its read tool for an admin token, and carries no unavailable", async () => {
    writeSeedFile(dir, [{ ...SHOP, roles: ["admin"] }]);
    expect((await listAs(ALICE)).structuredContent?.connections).toEqual([
      {
        id: "seed:shop",
        name: "shop",
        engine: "sqlite",
        database: "shop.db",
        environment: "production",
        read_tool: "run_read_query",
      },
    ]);
  });

  test("a DuckDB seed offered to every role keeps its read tool, since DuckDB confines a handle opened with file access denied", async () => {
    writeSeedFile(dir, [
      { id: "warehouse", type: "duckdb", database: "/srv/libredb/data/warehouse.duckdb", roles: ["*"] },
    ]);
    expect((await listAs(BOB)).structuredContent?.connections).toEqual([
      {
        id: "seed:warehouse",
        name: "warehouse",
        engine: "duckdb",
        database: "warehouse.duckdb",
        read_tool: "run_read_query",
      },
    ]);
  });

  test("a connection lists unavailable exactly where acquiring it for the token's caller is refused, under both MCP profiles", async () => {
    const file = join(dir, "agree.db");
    createSqliteFile(file, ["CREATE TABLE IF NOT EXISTS t (id INTEGER)"]);
    writeSeedFile(dir, [
      { id: "everyone", type: "sqlite", database: file, roles: ["*"] },
      { id: "both", type: "sqlite", database: file, roles: ["admin", "user"] },
      { id: "users", type: "sqlite", database: file, roles: ["user"] },
      { id: "admins", type: "sqlite", database: file, roles: ["admin"] },
    ]);
    const outcomeOf = (acquisition: Promise<unknown>) =>
      acquisition.then(
        () => "opened",
        (error: unknown) =>
          error instanceof Error && error.message.includes("require an administrator") ? "refused" : String(error),
      );
    const seen: Array<[string, string, boolean, string, string]> = [];
    for (const caller of [ALICE, BOB]) {
      // oxlint-disable-next-line no-await-in-loop -- one caller at a time.
      const rows: Array<{ id: string; unavailable?: string }> = (await listAs(caller)).structuredContent?.connections;
      const context = new McpConnectionContext(caller);
      for (const row of rows) {
        // oxlint-disable-next-line no-await-in-loop -- one caller at a time.
        const connection = await context.resolve(row.id);
        if (connection === null || connection === MCP_CONNECTIONS_UNREADABLE)
          throw new Error(`${row.id} did not resolve`);
        // oxlint-disable-next-line no-await-in-loop -- one caller at a time.
        const readOnly = await outcomeOf(context.acquire(connection, "agent-read-only"));
        // oxlint-disable-next-line no-await-in-loop -- one caller at a time.
        const operations = await outcomeOf(context.acquire(connection, "agent-operations"));
        seen.push([caller.role, row.id, row.unavailable !== undefined, readOnly, operations]);
      }
    }
    expect(seen).toEqual([
      ["admin", "seed:everyone", true, "refused", "refused"],
      ["admin", "seed:both", true, "refused", "refused"],
      ["admin", "seed:admins", false, "opened", "opened"],
      ["user", "seed:everyone", true, "refused", "refused"],
      ["user", "seed:both", true, "refused", "refused"],
      ["user", "seed:users", true, "refused", "refused"],
    ]);
  });

  test("a page holding an unavailable connection is one audit event, as every list is", async () => {
    writeSeedFile(dir, [{ ...SHOP, roles: ["*"] }, ANALYTICS]);
    await listAs(ALICE);
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "mcp_operation");
    expect(events.map((event) => [event.action, event.target, event.result, event.reason])).toEqual([
      ["list_connections", "mcp/decision", "success", undefined],
    ]);
  });
});

describe("paging under the 32 KiB cap", () => {
  const MANY: SeedEntry[] = Array.from({ length: 300 }, (_, index) => ({
    id: `conn-${index}`,
    type: "postgres",
    host: "db.internal",
    database: `database_${index}`,
    name: `${"connection name written out at length ".repeat(3)}${index}`,
  }));

  test("lists every connection exactly once across pages, each page within the cap", async () => {
    writeSeedFile(dir, MANY);
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const result = await list({ offset });
      pages += 1;
      expect(handlerBytes(result)).toBeLessThanOrEqual(MCP_RESULT_CAP_BYTES);
      seen.push(...result.structuredContent?.connections.map((connection: { id: string }) => connection.id));
      if (!result.structuredContent?.has_more) break;
      expect(result.structuredContent.next_offset).toBe(offset + result.structuredContent.connections.length);
      offset = result.structuredContent.next_offset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(MANY.map((entry) => `seed:${entry.id}`));
  });

  test("an entry that alone does not fit ends the page before it, and is then refused by name and recorded as too large", async () => {
    writeSeedFile(dir, [
      ANALYTICS,
      { id: "huge", type: "postgres", host: "db.internal", database: "d".repeat(40_000) },
    ]);
    const first = await list();
    expect(first.structuredContent).toMatchObject({ has_more: true, next_offset: 1 });
    const refused = await list({ offset: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(refused.content).toEqual([
      {
        type: "text",
        text: "The connection seed:huge cannot be listed within the 32 KiB result limit on its own. Ask the operator to shorten that seed entry.",
      },
    ]);
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "mcp_operation");
    expect(events.map((event) => [event.action, event.result, event.reason])).toEqual([
      ["list_connections", "success", undefined],
      ["list_connections", "failure", "mcp_result_too_large"],
    ]);
  });
});

describe("the audit record", () => {
  test("is one mcp_operation event for the token's user, with no connection", async () => {
    writeSeedFile(dir, [SHOP]);
    await list();
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "mcp_operation");
    expect(events).toEqual([
      expect.objectContaining({ action: "list_connections", target: "mcp/decision", user: "alice", result: "success" }),
    ]);
    expect(events[0].connectionName).toBeUndefined();
  });

  test("that cannot be written withholds the list behind the fixed error", async () => {
    writeSeedFile(dir, [SHOP]);
    const sink = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const result = await list();
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "The call was not run because its audit record could not be written." },
      ]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      sink.mockRestore();
      errorLog.mockRestore();
    }
  });
});

describe("the registration", () => {
  test.each(["legacy", "pinned"] as const)(
    "gives the tool its title, description, annotations and output schema (%s)",
    async (negotiation) => {
      writeSeedFile(dir, [SHOP]);
      const session = await connectClient(serve, { negotiation });
      try {
        const tool = (await session.client.listTools()).tools.find(
          (candidate) => candidate.name === "list_connections",
        );
        expect(tool?.title).toBe("List connections");
        expect(tool?.description).toBe(LIST_CONNECTIONS_DESCRIPTION);
        expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
        expect(tool?.outputSchema?.type).toBe("object");
        expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["environment", "offset"]);
      } finally {
        await session.close();
      }
    },
  );

  test("says a connection that carries unavailable cannot be read by any tool, right after what read_tool names", () => {
    expect(LIST_CONNECTIONS_DESCRIPTION).toContain(
      "Each connection's read_tool names the tool that runs a statement on it, or is null where inspect_schema is the only read. A connection that carries unavailable cannot be read by any tool, and unavailable says why and what an operator changes.",
    );
  });
});
