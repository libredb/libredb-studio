/**
 * run_weaviate_read: MCP's Weaviate arm, run by the statement core over the real Weaviate provider, through the real
 * route, seed file and handler, with a recording transport answered from what 1.40.2 answered the same request
 * (tests/fixtures/weaviate/1.40.2/agent-boundary/ and data-scope/) in place of a server.
 *
 * The provider is the one the factory would hand out, built here only so its transport is the recording one: the agent
 * read-only profile opens it under `readOnly` with `sendsStatements`, which `queryReadOnly` refuses without, and every
 * other profile does not. The request is the agent's own, read and admitted by the agent's own Weaviate adapter: a
 * read answers the metadata-only projection behind the untrusted-content notice, after the server proves the key a
 * viewer again; an object read, a search, GraphQL, an aggregate's filter and a write are refused before anything is
 * acquired; a key the proof refuses is refused at the open; a COLD tenant is refused rather than woken; a read past the
 * row budget is refused with the request's own advice, and a result cut to max_rows says how to narrow it, since the
 * tool takes no offset. A verbose node read names no tenant, also for a key whose tenants the server filters elsewhere.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { TransportError } from "@/lib/db/http/node-transport";
import { WEAVIATE_AGENT_UNREADABLE, WEAVIATE_PROOF_SENTENCES } from "@/lib/db/providers/vector/weaviate/metadata-read";
import { WeaviateProvider } from "@/lib/db/providers/vector/weaviate/index";
import { createRestWeaviateClient } from "@/lib/db/providers/vector/weaviate/rest-client";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import {
  agentAnswer,
  agentCollectionAnswer,
  agentServer,
  scopeAnswer,
  scopeServer,
} from "../../helpers/weaviate-agent";
import { type RecordedAnswer, okAnswer, recordingWeaviateTransport } from "../../helpers/weaviate-wire";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-weaviate-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("weaviateapi");
const RUN_WEAVIATE_READ_ARM = mcpStatementArm("run_weaviate_read");
/** A seed is plain data, so its key is written as the operator writes it. */
const VECTORS_SEED = { id: "vectors", type: "weaviate", host: "127.0.0.1", port: 8080, password: "not-a-real-key" };
/** Stored values the captures hold: an object's text, a tenant's object text, a vector component. */
const STORED = /stored-|doc-1|tenant-(hot|cold)|0\.4/;

/** The viewer's server, with the two collection records the provider reads before a collection's read. */
const viewerServer = (overrides: Readonly<Record<string, ReturnType<typeof agentAnswer>>> = {}): RecordedAnswer =>
  agentServer("viewer", {
    "GET /v1/schema/Note": agentCollectionAnswer("Note"),
    "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
    ...overrides,
  });

let answer: RecordedAnswer = viewerServer();
let transport = recordingWeaviateTransport((request, line) => answer(request, line));
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

beforeEach(() => {
  answer = viewerServer();
  transport = recordingWeaviateTransport((request, line) => answer(request, line));
  honourProfile = true;
  writeSeedFile(dir, [VECTORS_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  // The factory's provider, with only its transport replaced: opened under the agent's context for agent-read-only.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      // Every execution profile opens read-only; only agent-read-only sends statements (the factory's own table).
      const agent = honourProfile && profile === "agent-read-only";
      const provider = new WeaviateProvider(
        connection as DatabaseConnection,
        { queryTimeout: 30_000 },
        { readOnly: honourProfile, sendsStatements: agent },
        (options, routes) => createRestWeaviateClient(options, routes, transport.factory),
      );
      await provider.connect();
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
  structuredContent?: Record<string, any>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { negotiation: "legacy" });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const weaviate = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_weaviate_read", { connection_id: "seed:vectors", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

const lines = () => transport.calls.map((sent) => sent.method);
const textOf = (result: Answered) => result.content.map((block) => block.text).join("\n");

describe("the tool", () => {
  test("is listed, read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain("run_weaviate_read");
      const tool = tools.find((candidate) => candidate.name === "run_weaviate_read");
      expect(tool?.description).toBe(RUN_WEAVIATE_READ_ARM.description);
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

  test("describes Weaviate as the engine it runs on", () => {
    expect(RUN_WEAVIATE_READ_ARM.engines).toBe("Weaviate");
  });

  test("list_connections names it as the Weaviate connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:vectors", "run_weaviate_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("the schema answers names, counts and flags behind the notice, after the key is proved again", async () => {
    const result = await weaviate("GET /v1/schema");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:vectors",
      truncated: false,
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    expect(result.structuredContent?.columns.map((column: { name: string }) => column.name)).toEqual([
      "collection",
      "vectorizer",
      "properties",
      "named_vectors",
      "multi_tenant",
      "auto_tenant_activation",
      "replication_factor",
    ]);
    expect(lines()).toEqual(["GET /v1/meta", "GET /v1/users/own-info", "GET /v1/users/own-info", "GET /v1/schema"]);
    expect(JSON.stringify(result)).not.toMatch(STORED);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_weaviate_read", "mcp/decision", "success"],
      ["run_weaviate_read", "mcp/execution", "success"],
    ]);
  });

  test("a count answers the collection, the tenant and the number, and no object", async () => {
    const result = await weaviate("POST /v1/aggregate/Note");
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows).toEqual([{ collection: "Note", tenant: null, count: 3 }]);
    expect(lines().slice(-2)).toEqual(["GET /v1/schema/Note", "POST /v1/aggregate/Note"]);
  });

  test("a verbose node read neither names nor counts a tenant, also for a key whose tenant list the server filters", async () => {
    answer = agentServer("viewer", {
      "GET /v1/users/own-info": scopeAnswer("own-info-scoped"),
      "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
      "GET /v1/nodes/Tenanted?output=verbose": scopeAnswer("collection-nodes-tenanted-scoped"),
      "GET /v1/schema/Tenanted/tenants": scopeAnswer("tenants-scoped"),
    });
    const nodes = await weaviate("GET /v1/nodes/Tenanted?output=verbose");
    expect(nodes.isError ?? false).toBe(false);
    expect(nodes.structuredContent?.rows).toEqual([{ node: "node1", collection: "Tenanted" }]);
    for (const tenant of ["acme", "globex", "initech"]) expect(JSON.stringify(nodes)).not.toContain(tenant);
    const tenants = await weaviate("GET /v1/schema/Tenanted/tenants");
    expect(tenants.structuredContent?.rows).toEqual([{ tenant: "acme", status: "HOT" }]);
  });

  test("a name outside the key's grants and a missing one are one answer, without the server's words", async () => {
    answer = scopeServer("scoped");
    const texts: string[] = [];
    for (const statement of [
      "GET /v1/aliases/DocsAlias",
      "GET /v1/aliases/MissingAlias",
      "GET /v1/schema/Doc",
      "GET /v1/schema/Missing",
      "GET /v1/schema/TenantedAlias/tenants",
      'POST /v1/aggregate/TenantedAlias {"tenant": "acme"}',
    ]) {
      const result = await weaviate(statement);
      expect(result.isError).toBe(true);
      texts.push(textOf(result));
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toContain(WEAVIATE_AGENT_UNREADABLE);
    for (const word of ["DocsAlias", "Tenanted", "scoped", "403", "404"]) expect(texts[0]).not.toContain(word);
    expect(lines()).not.toContain("GET /v1/schema/TenantedAlias/tenants");
    expect(lines()).not.toContain("POST /v1/aggregate/TenantedAlias");
  });

  test("a read past max_rows is cut to it, and the hint narrows the read rather than paging", async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({ name: `t${index}`, activityStatus: "HOT" }));
    answer = viewerServer({ "GET /v1/schema/Tenanted/tenants": okAnswer(JSON.stringify(many)) });
    const statement = "GET /v1/schema/Tenanted/tenants";
    const result = await weaviate(statement, { max_rows: 100 });
    expect(result.structuredContent).toMatchObject({
      row_count: 100,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 100, hasMore: true, nextOffset: null, wasLimited: false },
      hint: RUN_WEAVIATE_READ_ARM.moreRows(statement, "weaviate", { maxRows: 100, shown: 100, cut: "max_rows" }),
    });
  });
});

describe("inspect_schema", () => {
  test("lists a collection the key may read the definition of and none of its objects, reading no object", async () => {
    answer = scopeServer("nodata");
    const result = await call("inspect_schema", { connection_id: "seed:vectors", include_indexes: true });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.tables.map((table: { name: string }) => table.name)).toEqual(["Note"]);
    const columns = result.structuredContent?.tables[0].columns as { name: string; data_type: string }[];
    expect(columns.map((column) => column.name)).toEqual(["$id", "body", "$vector"]);
    expect(columns.at(-1)?.data_type).toBe("Vector(?, cosine, hnsw)");
    expect(lines().some((line) => line.startsWith("GET /v1/objects"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("nodata");
  });

  test("a definition read the server refuses is worded by its status, never the server's words", async () => {
    answer = scopeServer("nodata");
    const refused = scopeAnswer("objects-note-sample-nodata");
    answer = (request, line) =>
      line === "GET /v1/schema/Note" ? { ...refused } : scopeServer("nodata")(request, line);
    const result = await call("inspect_schema", { connection_id: "seed:vectors" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("The credential is not allowed to run this request.");
    for (const word of ["nodata", "rbac", "read_data"]) expect(textOf(result)).not.toContain(word);
  });
});

describe("a refusal", () => {
  test.each([
    ["an object read", "GET /v1/objects?class=Note&limit=2"],
    ["a search", 'POST /v1/search/Note/bm25 {"query": "x"}'],
    [
      "an aggregate's filter",
      'POST /v1/aggregate/Note {"where": {"path": ["body"], "operator": "Like", "valueText": "x"}}',
    ],
    ["GraphQL", 'POST /v1/graphql {"query": "{ Get { Note { body } } }"}'],
    ["a write", "DELETE /v1/schema/Note"],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await weaviate(statement);
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
    expect(transport.calls).toEqual([]);
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_weaviate_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test.each([
    ["the root key", "own-info-root", WEAVIATE_PROOF_SENTENCES.widened("create_roles")],
    ["an administrator's key", "own-info-admin", WEAVIATE_PROOF_SENTENCES.widened("create_roles")],
    ["a role that also writes", "own-info-widened", WEAVIATE_PROOF_SENTENCES.widened("update_data")],
    ["a key on a server with RBAC off", "own-info-keyonly", WEAVIATE_PROOF_SENTENCES.rbacOff],
  ])("%s is refused at the open, and nothing is read", async (_who, capture, sentence) => {
    answer = viewerServer({ "GET /v1/users/own-info": agentAnswer(capture) });
    const result = await weaviate("GET /v1/schema");
    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: `run_weaviate_read cannot run on this connection: ${sentence} It runs on Weaviate.` },
      ],
    });
    expect(lines()).toEqual(["GET /v1/meta", "GET /v1/users/own-info"]);
  });

  test("a key widened after the open is refused before the read is sent", async () => {
    let proofs = 0;
    answer = viewerServer();
    const viewer = answer;
    answer = (request, line) => {
      if (line === "GET /v1/users/own-info") {
        proofs += 1;
        return agentAnswer(proofs === 1 ? "own-info-drift-before" : "own-info-drift-after");
      }
      return viewer(request, line);
    };
    const result = await weaviate("GET /v1/schema");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(WEAVIATE_PROOF_SENTENCES.widened("update_data"));
    expect(lines()).toEqual(["GET /v1/meta", "GET /v1/users/own-info", "GET /v1/users/own-info"]);
  });

  test("a connection with no key is refused before anything is sent", async () => {
    writeSeedFile(dir, [{ id: "vectors", type: "weaviate", host: "127.0.0.1", port: 8080 }]);
    const result = await weaviate("GET /v1/schema");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(WEAVIATE_PROOF_SENTENCES.keyless);
    expect(transport.calls).toEqual([]);
  });

  test("a COLD tenant is refused rather than woken: its record is read, and the count is never sent", async () => {
    answer = viewerServer({ "GET /v1/schema/Tenanted/tenants/cold": agentAnswer("wake-record-before") });
    const result = await weaviate('POST /v1/aggregate/Tenanted {"tenant": "cold"}');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('The tenant "cold" is COLD.');
    expect(lines()).not.toContain("POST /v1/aggregate/Tenanted");
  });

  test("a provider not opened under the agent read-only profile refuses the read", async () => {
    honourProfile = false;
    const result = await weaviate("GET /v1/schema");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(lines()).toEqual(["GET /v1/meta"]);
  });

  test("a read past the provider's row budget is refused with the request's own advice", async () => {
    const many = Array.from({ length: 1_001 }, (_, index) => ({ name: `t${index}`, activityStatus: "HOT" }));
    answer = viewerServer({ "GET /v1/schema/Tenanted/tenants": okAnswer(JSON.stringify(many)) });
    const statement = "GET /v1/schema/Tenanted/tenants";
    const result = await weaviate(statement);
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(statement, "1000")}`,
        },
      ],
    });
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_result_too_large" });
  });

  test("a read the server does not answer within timeout_ms is answered as the timeout", async () => {
    answer = viewerServer();
    const viewer = answer;
    answer = (request, line) => {
      if (line === "GET /v1/schema") throw new TransportError("timeout", "no answer");
      return viewer(request, line);
    };
    const result = await weaviate("GET /v1/schema", { timeout_ms: 1_000 });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The statement did not finish within timeout_ms (1000 ms). Narrow it, or raise timeout_ms up to 30000.",
        },
      ],
    });
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_weaviate_read", { connection_id: "seed:shop", statement: "GET /v1/meta" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_weaviate_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on Weaviate.",
        },
      ],
    });
  });

  test("run_read_query refuses a Weaviate connection, naming run_weaviate_read", async () => {
    const result = await call("run_read_query", { connection_id: "seed:vectors", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve Weaviate; use run_weaviate_read there");
    expect(transport.calls).toEqual([]);
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "Note" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const result = await weaviate("GET /v1/schema", extra);
    expect(result.isError).toBe(true);
    expect(transport.calls).toEqual([]);
  });
});
