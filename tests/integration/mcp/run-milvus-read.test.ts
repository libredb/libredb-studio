/**
 * run_milvus_read: MCP's milvusrpc arm, run by the statement core over the real Milvus provider and its real gRPC
 * adapter, through the real route, seed file and handler, with a recorded wire in place of a server.
 *
 * The wire answers as Milvus 3.0.2 answered a user granted two of three collections of `default`
 * (tests/fixtures/milvus/3.0.2/mcp-scope/), so the read-only proof, the listings and each collection, alias and index
 * read are the server's own answers. The provider is the one the factory would hand out, built here only so its client
 * rides that wire: the agent read-only profile opens it under `readOnly` and `sendsStatements`, which `queryReadOnly`
 * refuses without, and every other profile does not. A read answers the metadata projection behind the
 * untrusted-content notice after the proof; a collection outside the user's grants, an alias and a missing name are
 * refused alike; a request outside the closed table is refused before anything is acquired; a provider not opened
 * under the profile refuses; a result cut to max_rows says how to read a narrower route, since the tool takes no
 * offset; and a read past timeout_ms is answered as the timeout.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { createGrpcMilvusClient } from "@/lib/db/providers/vector/milvus/grpc-client";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import { MILVUS_AGENT_SCOPE_SENTENCES } from "@/lib/db/providers/vector/milvus/metadata-read";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { scopeMilvusWire } from "../../helpers/milvus-agent";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import type { RecordedMilvusAnswer, RecordedMilvusWire } from "../../helpers/milvus-wire";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-milvus-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("milvusrpc");
const RUN_MILVUS_READ_ARM = mcpStatementArm("run_milvus_read");
/** A seed is plain data; this one names a loopback server the recorded wire stands in for, and a placeholder password. */
const VECTORS_SEED = {
  id: "vectors",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  user: "scope_few",
  password: "not-a-real-password",
  database: "default",
};

let wire: RecordedMilvusWire = scopeMilvusWire("few");
let overrides: Parameters<typeof scopeMilvusWire>[1] = {};
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

/** The same user's seed naming a second database, as a tenant's seed would. */
const TENANT_SEED = { ...VECTORS_SEED, id: "tenant", database: "scope_db_a" };

beforeEach(() => {
  overrides = {};
  honourProfile = true;
  writeSeedFile(dir, [VECTORS_SEED, TENANT_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  // The factory's provider, with only its wire replaced: opened to send statements for agent-read-only alone, and
  // read-only without statements for agent-operations, as the factory's profile table opens them.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      const execution = !honourProfile
        ? {}
        : profile === "agent-read-only"
          ? { readOnly: true, sendsStatements: true }
          : { readOnly: true };
      wire = scopeMilvusWire("few", overrides);
      const provider = new MilvusProvider(
        connection as DatabaseConnection,
        { queryTimeout: 30_000 },
        execution,
        (options) => createGrpcMilvusClient(options, wire.transport),
      );
      await provider.connect();
      // connect()'s own GetVersion and the open's proof are left behind.
      wire.calls.length = 0;
      return provider;
    },
  );
});

afterEach(async () => {
  mock.restore();
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Answered {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: { rows?: Array<Record<string, unknown>>; hint?: string | null; [key: string]: unknown };
}

async function call(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { negotiation: "legacy" });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const milvus = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_milvus_read", { connection_id: "seed:vectors", statement, ...extra });

const request = (route: string, body?: unknown) =>
  body === undefined ? `POST /v2/vectordb/${route}` : `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;

const methods = () => wire.calls.map((logged) => logged.method);
const PROOF = ["ListCredUsers", "SelectUser", "SelectGrant", "SelectGrant"];
const text = (result: Answered) => result.content.map((block) => block.text).join("\n");

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

describe("the tool", () => {
  test("is listed, read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain("run_milvus_read");
      const tool = tools.find((candidate) => candidate.name === "run_milvus_read");
      expect(tool?.description).toBe(RUN_MILVUS_READ_ARM.description);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "connection_id",
        "statement",
        "max_rows",
        "timeout_ms",
      ]);
    } finally {
      await session.close();
    }
  });

  test("describes Milvus as the engine it runs on", () => {
    expect(RUN_MILVUS_READ_ARM.engines).toBe("Milvus");
  });

  test("list_connections names it as the Milvus connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:vectors", "run_milvus_read"],
      ["seed:tenant", "run_milvus_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("the collection listing is the user's own, behind the notice, after the read-only proof", async () => {
    const result = await milvus(request("collections/list"));
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:vectors",
      row_count: 2,
      truncated: false,
      hint: null,
    });
    expect(result.structuredContent?.rows).toEqual([{ collection: "scope_c1" }, { collection: "scope_c2" }]);
    expect(methods()).toEqual([...PROOF, "ShowCollections"]);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_milvus_read", "mcp/decision", "success"],
      ["run_milvus_read", "mcp/execution", "success"],
    ]);
  });

  test("a listed collection's description is its fields, types and indexes, never a value or a parameter", async () => {
    const result = await milvus(request("collections/describe", { collectionName: "scope_c1" }));
    expect(result.structuredContent?.rows?.map((row) => [row.name, row.kind, row.type])).toEqual([
      ["scope_c1", "collection", null],
      ["id", "field", "Int64"],
      ["vec", "field", "FloatVector"],
    ]);
    expect(methods()).toEqual([...PROOF, "ShowCollections", "DescribeCollection", "DescribeIndex", "GetLoadState"]);
    for (const logged of wire.calls.slice(PROOF.length)) {
      expect((logged.args?.[0] as { db_name?: string } | undefined)?.db_name).toBe("default");
    }
  });

  test("the user's own databases are the server's filtered list", async () => {
    const result = await milvus(request("databases/list"));
    expect(result.structuredContent?.rows).toEqual([{ database: "default" }]);
  });

  test("a read past max_rows is cut to it, and the hint reads a narrower route rather than an offset", async () => {
    const statement = request("collections/list");
    const result = await milvus(statement, { max_rows: 1 });
    expect(result.structuredContent).toMatchObject({
      row_count: 1,
      truncated: true,
      truncated_by: "max_rows",
      hint: RUN_MILVUS_READ_ARM.moreRows(statement, "milvus", { maxRows: 1, shown: 1, cut: "max_rows" }),
    });
    expect(result.structuredContent?.hint).toContain("since a Milvus read is never paged");
  });

  test("a read past timeout_ms is answered as the timeout, and the server is not waited for", async () => {
    overrides = { ShowCollections: () => new Promise<never>(() => {}) } satisfies Record<string, RecordedMilvusAnswer>;
    const result = await milvus(request("collections/list"), { timeout_ms: 500 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("500 ms");
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", result: "failure" });
  });
});

describe("the data scope", () => {
  test.each(["scope_c3", "scope_alias_c3", "scope_alias_c1", "scope_missing"])(
    "%s, which the user's own list does not hold, is refused in the one sentence, and nothing naming it is sent",
    async (name) => {
      const result = await milvus(request("collections/describe", { collectionName: name }));
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(MILVUS_AGENT_SCOPE_SENTENCES.collection(name));
      expect(text(result)).not.toContain("scope_few");
      expect(methods()).toEqual([...PROOF, "ShowCollections"]);
    },
  );

  test("an alias of a collection outside the user's grants is refused as a missing alias is", async () => {
    const outside = await milvus(request("aliases/describe", { aliasName: "scope_alias_c3" }));
    const missing = await milvus(request("aliases/describe", { aliasName: "scope_missing" }));
    expect(text(outside).replace("scope_alias_c3", "<alias>")).toBe(text(missing).replace("scope_missing", "<alias>"));
    expect(text(outside)).toContain(MILVUS_AGENT_SCOPE_SENTENCES.alias("scope_alias_c3"));
    const listed = await milvus(request("aliases/describe", { aliasName: "scope_alias_c1" }));
    expect(listed.structuredContent?.rows).toEqual([
      { alias: "scope_alias_c1", collection: "scope_c1", database: "default" },
    ]);
  });
});

describe("inspect_schema", () => {
  const inspect = (seed: string, extra: Record<string, unknown> = {}) =>
    call("inspect_schema", { connection_id: `seed:${seed}`, include_columns: false, ...extra });
  const databasesSent = () =>
    wire.calls.map((logged) => `${logged.method}:${String((logged.args[0] as { db_name?: string }).db_name)}`);

  test("reads the seed's own database, as run_milvus_read does, and lists no other", async () => {
    const result = await inspect("vectors");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ schema: "default", total_tables: 2 });
    expect(databasesSent()).toEqual(["ShowCollections:default"]);
    const tenant = await inspect("tenant");
    expect(tenant.structuredContent).toMatchObject({ schema: "scope_db_a" });
    expect(databasesSent()).toEqual(["ShowCollections:scope_db_a"]);
  });

  test.each([
    ["a default-database seed", "vectors", "scope_db_a"],
    ["a second database's seed", "tenant", "default"],
  ])(
    "on %s, a schema naming another database is no schema of that connection, and nothing is sent",
    async (_seed, seed, schema) => {
      const result = await inspect(seed, { schema });
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: "This connection has no schema of that name. Call inspect_schema without schema to read the default one.",
          },
        ],
      });
      expect(wire.calls).toEqual([]);
    },
  );
});

describe("a refusal", () => {
  test.each([
    ["a query of stored values", request("entities/query", { collectionName: "scope_c1", filter: "id > 0" })],
    ["a get", request("entities/get", { collectionName: "scope_c1", id: 1 })],
    ["a write", request("collections/drop", { collectionName: "scope_c1" })],
    ["a Load", request("collections/load", { collectionName: "scope_c1" })],
    ["every alias of the database", request("aliases/list")],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await milvus(statement);
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The request was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_milvus_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test("a dbName naming another database, which the admission leaves to the provider, is refused there before anything is sent", async () => {
    const statement = request("collections/list", { dbName: "scope_db_b" });
    expect(server.admit?.(statement)).toBeNull();
    const result = await milvus(statement);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("An agent request reads the connection's own database");
    expect(methods()).toEqual([]);
  });

  test("a provider not opened under the agent read-only profile refuses the read, and nothing is sent", async () => {
    honourProfile = false;
    const result = await milvus(request("collections/list"));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Read-only execution requires a provider opened under the agent read-only profile");
    expect(methods()).toEqual([]);
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_milvus_read", {
      connection_id: "seed:shop",
      statement: request("collections/list"),
    });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_milvus_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on Milvus.",
        },
      ],
    });
  });

  test("run_read_query refuses a Milvus connection, naming run_milvus_read", async () => {
    const result = await call("run_read_query", { connection_id: "seed:vectors", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve Milvus; use run_milvus_read there");
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "default" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await milvus(request("collections/list"), extra);
    expect(result.isError).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });
});
