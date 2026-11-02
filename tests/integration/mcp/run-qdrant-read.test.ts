/**
 * run_qdrant_read: MCP's Qdrant arm, run by the statement core over the real Qdrant provider and REST client, through
 * the real route, seed file and handler, with a recording transport answering from what 1.19.1 answered the same
 * request (tests/fixtures/qdrant/1.19.1/agent-boundary/) in place of a server.
 *
 * The provider is the one the factory would hand out, built here only so its transport is the recording one: the agent
 * read-only profile opens it to send statements, which `queryReadOnly` refuses without. The request is the agent's
 * own, read and admitted by the agent's own Qdrant reader: a metadata read answers names, counts and flags behind the
 * untrusted-content notice, after the server refused the proof's two no-op writes; a point read, a query, a count
 * filter and a write are refused before anything is acquired; a key the server answers a write is refused at the open
 * in the tool's sentence; a read past the row budget is refused with the request's own advice, and a result cut to
 * max_rows says how to narrow it, since the tool takes no offset.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import type { QdrantAnswer } from "@/lib/db/providers/vector/qdrant/client";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { QDRANT_PROOF_SENTENCES } from "@/lib/db/providers/vector/qdrant/metadata-read";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import { agentAnswer, agentServer } from "../../helpers/qdrant-agent";
import { type RecordedAnswer, okAnswer, recordingQdrantTransport } from "../../helpers/qdrant-transport";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-qdrant-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("qdrantapi");
const RUN_QDRANT_READ_ARM = mcpStatementArm("run_qdrant_read");
/** A seed is plain data, so its key is written as the operator writes it. */
const VECTORS_SEED = { id: "vectors", type: "qdrant", host: "127.0.0.1", port: 6333, password: "not-a-real-key" };
/** What a stored payload or vector of the captures holds; none of it may reach an answer. */
const STORED = /stored-|written|0\.4/;

/** The read-only key's server: `docs` was never sent an empty delete by the probe, so it answers as `other` did. */
const readOnly = (overrides: Readonly<Record<string, QdrantAnswer | (() => QdrantAnswer)>> = {}) =>
  agentServer("read-only", {
    "POST /collections/docs/points/delete": agentAnswer("proof-delete-other-read-only"),
    ...overrides,
  });

/** An alias list of `count` aliases, every one of `plain`. */
function aliases(count: number): QdrantAnswer {
  const listed = Array.from({ length: count }, (_, i) => ({ alias_name: `alias_${i}`, collection_name: "plain" }));
  return okAnswer(JSON.stringify({ result: { aliases: listed }, status: "ok", time: 0 }));
}

let answer: RecordedAnswer = readOnly();
let transport = recordingQdrantTransport(answer);
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

beforeEach(() => {
  answer = readOnly();
  honourProfile = true;
  writeSeedFile(dir, [VECTORS_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  // The factory's provider, with only its transport replaced: opened to send statements for agent-read-only alone.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      transport = recordingQdrantTransport((request, line) => answer(request, line));
      const agent = honourProfile && profile === "agent-read-only";
      const provider = new QdrantProvider(
        connection as DatabaseConnection,
        { queryTimeout: 30_000 },
        { readOnly: agent, sendsStatements: agent },
        (options, routes) => createRestQdrantClient(options, routes, transport.factory),
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

const qdrant = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_qdrant_read", { connection_id: "seed:vectors", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

const lines = () => transport.calls.map((sent) => sent.method);

/** The open's two reads, then the proof: an empty alias update and an empty delete on each listed collection. */
const OPEN = [
  "GET /",
  "GET /collections",
  "POST /collections/aliases",
  "GET /collections",
  "POST /collections/docs/points/delete",
  "POST /collections/other/points/delete",
  "POST /collections/plain/points/delete",
];
/** The proof again, before the request, with no verdict kept from the open. */
const PROOF = OPEN.slice(2);

describe("the tool", () => {
  test("is listed read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_qdrant_read");
      expect(tool?.description).toBe(RUN_QDRANT_READ_ARM.description);
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

  test("describes Qdrant as the engine it runs on", () => {
    expect(RUN_QDRANT_READ_ARM.engines).toBe("Qdrant");
  });

  test("list_connections names it as the Qdrant connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:vectors", "run_qdrant_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("the collection list answers names behind the notice, after the proof, recorded under run_qdrant_read", async () => {
    const result = await qdrant("GET /collections");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:vectors",
      columns: [{ name: "collection" }],
      rows: [{ collection: "docs" }, { collection: "other" }, { collection: "plain" }],
      row_count: 3,
      truncated: false,
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    expect(lines()).toEqual([...OPEN, ...PROOF, "GET /collections"]);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_qdrant_read", "mcp/decision", "success"],
      ["run_qdrant_read", "mcp/execution", "success"],
    ]);
  });

  test("a collection read answers its names, counts and flags, and no stored payload, vector or configuration value", async () => {
    const result = await qdrant("GET /collections/plain");
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows[0]).toMatchObject({ name: "plain", kind: "collection", points: 3 });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(STORED);
    expect(text).not.toContain("hnsw_config");
  });

  test("a bare count answers the collection's point count", async () => {
    const result = await qdrant('POST /collections/plain/points/count\n{"exact": true}');
    expect(result.structuredContent).toMatchObject({ rows: [{ collection: "plain", count: 3 }], row_count: 1 });
  });

  test("a read past max_rows is cut to it, and the hint narrows the read rather than paging", async () => {
    answer = readOnly({ "GET /aliases": aliases(150) });
    const result = await qdrant("GET /aliases", { max_rows: 100 });
    expect(result.structuredContent).toMatchObject({
      row_count: 100,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 100, hasMore: true, nextOffset: null, wasLimited: false },
      hint: RUN_QDRANT_READ_ARM.moreRows("GET /aliases", "qdrant", { maxRows: 100, shown: 100, cut: "max_rows" }),
    });
  });
});

describe("a refusal", () => {
  test.each([
    ["a point read", 'POST /collections/plain/points\n{"ids": [1], "with_payload": true}'],
    ["a scroll", "POST /collections/plain/points/scroll"],
    ["a query", 'POST /collections/plain/points/query\n{"query": [0.1, 0.2, 0.3, 0.4]}'],
    ["a count filter", 'POST /collections/plain/points/count\n{"filter": {"must": []}}'],
    ["a write", 'PUT /collections/plain/points\n{"points": []}'],
    ["a collection delete", "DELETE /collections/plain"],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, request) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await qdrant(request);
    const refusal = server.admit?.(request);
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
        action: "run_qdrant_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test("the API key, which the server answers an empty alias update, is refused at the open in the tool's sentence", async () => {
    answer = agentServer("full");
    const result = await qdrant("GET /collections");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `run_qdrant_read cannot run on this connection: ${QDRANT_PROOF_SENTENCES.writes.replace(/\.+$/, "")}. It runs on Qdrant.`,
        },
      ],
    });
    expect(lines()).toEqual(["GET /", "GET /collections", "POST /collections/aliases"]);
  });

  test("a key that can write a collection it lists is refused at that collection's empty delete", async () => {
    answer = agentServer("jwt-collection-write", {
      "GET /": agentAnswer("root-read-only"),
      "POST /collections/aliases": agentAnswer("proof-alias-jwt-collection-write"),
    });
    const result = await qdrant("GET /collections");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(QDRANT_PROOF_SENTENCES.writesCollection.replace(/\.+$/, ""));
    expect(lines().at(-1)).toBe("POST /collections/plain/points/delete");
  });

  test("a provider not opened under the agent read-only profile refuses the read, and sends it nowhere", async () => {
    honourProfile = false;
    const result = await qdrant("GET /collections");
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(lines()).toEqual(["GET /", "GET /collections"]);
  });

  test("another collection a collection-scoped JWT may not read is refused in Studio's words, never the server's", async () => {
    answer = agentServer("jwt-collection-read");
    const result = await qdrant("GET /collections/other");
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => block.text).join("\n");
    expect(text).toContain("The server's own words are not passed on to agent mode");
    expect(text).not.toContain("Access to collection");
  });

  test("a read past the provider's row budget is refused with the request's own advice", async () => {
    answer = readOnly({ "GET /aliases": aliases(1_001) });
    const result = await qdrant("GET /aliases");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("GET /aliases", "1000")}`,
        },
      ],
    });
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_result_too_large" });
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_qdrant_read", { connection_id: "seed:shop", statement: "GET /collections" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_qdrant_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on Qdrant.",
        },
      ],
    });
  });

  test("run_read_query refuses a Qdrant connection, naming run_qdrant_read", async () => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await call("run_read_query", { connection_id: "seed:vectors", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve Qdrant; use run_qdrant_read there");
    expect(acquire).not.toHaveBeenCalled();
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "plain" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await qdrant("GET /collections", extra);
    expect(result.isError).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });
});
