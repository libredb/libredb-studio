/**
 * run_influxql_read: MCP's InfluxQL arm, run by the statement core over the real InfluxDB provider, through the real
 * route, seed file and handler, with the recording transport of tests/helpers/influxdb-transport.ts answering from
 * what 1.13.1 answered each principal (tests/fixtures/influxdb/1.13.1/agent-boundary/).
 *
 * The provider is the one the factory would hand out, built here only so its transport is the recording one: the agent
 * read-only profile opens it under `readOnly` with statements to send, which `queryReadOnly` refuses without, and
 * every other profile does not. The statement is the agent's own, read and admitted by the agent's own InfluxQL
 * adapter: a read answers its rows behind the untrusted-content notice after the principal is proved read-only again;
 * INTO, a write and every spelling of SHOW QUERIES and SHOW CONTINUOUS QUERIES are refused before anything is
 * acquired; an answer shaped as either is refused by the provider from its columns alone; a principal that can write
 * is refused at open; a read past the row budget is refused in the statement's own words, and a result cut to
 * max_rows says how to page inside the statement, since the tool takes no offset.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { createInfluxClient, type InfluxClientFactory } from "@/lib/db/providers/timeseries/influxdb/client";
import { INFLUXQL_AGENT_QUERY_TEXT_SENTENCE } from "@/lib/db/providers/timeseries/influxdb/influxql-agent-read";
import { InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/influxql-provider";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { type InfluxCapture, loadInfluxCapture } from "../../helpers/influxdb-fixtures";
import { type RecordedInfluxRequest, recordingInfluxTransport } from "../../helpers/influxdb-transport";
import { INFLUXQL_QUERY_TEXT_SPELLINGS } from "../../helpers/influxql-query-text-spellings";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-influxql-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("influxql");
const RUN_INFLUXQL_READ_ARM = mcpStatementArm("run_influxql_read");
const PROBE = /^DELETE FROM "libredb_agent_probe_[0-9a-f]{16}" WHERE time < 0$/;

/** A seed is plain data, so its password is written as the operator writes it. */
const INFLUX_SEED = {
  id: "influx",
  type: "influxdb",
  host: "127.0.0.1",
  port: 8086,
  user: "reader",
  password: "not-a-real-password",
  database: "home",
};

const at = (name: string): InfluxCapture => loadInfluxCapture("1.13.1", `agent-boundary/${name}`);

/** The connect sequence, then the open's proof for the reader: SHOW USERS refused, the listing, the probe refused. */
const OPEN = [loadInfluxCapture("1.13.1", "ping-anon"), loadInfluxCapture("1.13.1", "health-anon")];
const READER_PROOF = [at("admin-read-reader"), at("listing-reader"), at("write-probe-reader-home")];
const RW_PROOF = [at("admin-read-rw"), at("listing-rw"), at("write-probe-rw-home"), at("write-probe-rw-other")];

/** An answer of `count` rows, time first, as a SELECT is answered. */
function selectAnswer(count: number): InfluxCapture {
  const values = Array.from({ length: count }, (_, index) => [index, index]);
  return {
    ...loadInfluxCapture("1.13.1", "preview-home"),
    body: `${JSON.stringify({ results: [{ statement_id: 0, series: [{ name: "home", columns: ["time", "temp"], values }] }] })}\n`,
  };
}

/** What the connection's next acquisition is answered, after its connect sequence and its listing. */
let script: readonly InfluxCapture[] = [];
let wire = recordingInfluxTransport([]);
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

beforeEach(() => {
  script = [];
  honourProfile = true;
  writeSeedFile(dir, [INFLUX_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  // The factory's provider, with only its transport replaced: opened under `readOnly` for agent-read-only alone.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      const agent = honourProfile && profile === "agent-read-only";
      wire = recordingInfluxTransport([...OPEN, at("listing-reader"), ...script]);
      const factory: InfluxClientFactory = (options, routes) => createInfluxClient(options, routes, wire.factory);
      const provider = new InfluxDBProvider(
        connection as DatabaseConnection,
        { queryTimeout: 30_000 },
        { readOnly: agent, sendsStatements: agent },
        factory,
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

const influxql = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_influxql_read", { connection_id: "seed:influx", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

/** The forms sent, the probe's measurement read as its shape. */
const forms = (requests: readonly RecordedInfluxRequest[]) =>
  requests.map((request) => {
    const form = { ...request.form };
    if (PROBE.test(form.q ?? "")) form.q = "<probe>";
    return form;
  });

const text = (result: Answered) => result.content.map((block) => block.text).join("\n");

describe("the tool", () => {
  test("is listed read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_influxql_read");
      expect(tool?.description).toBe(RUN_INFLUXQL_READ_ARM.description);
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

  test("describes InfluxDB over InfluxQL as the engine it runs on", () => {
    expect(RUN_INFLUXQL_READ_ARM.engines).toBe("InfluxDB (InfluxQL)");
  });

  test("list_connections names it as the InfluxDB connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:influx", "run_influxql_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("a SELECT is sent after the proof runs again, with the bound database, and answers behind the notice", async () => {
    script = [...READER_PROOF, ...READER_PROOF, selectAnswer(2)];
    const result = await influxql("SELECT temp FROM home WHERE time > now() - 1h LIMIT 2");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:influx",
      row_count: 2,
      truncated: false,
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    expect(forms(wire.requests.slice(2))).toEqual([
      { q: "SHOW DATABASES" },
      { q: "SHOW USERS" },
      { q: "SHOW DATABASES" },
      { db: "home", q: "<probe>" },
      { q: "SHOW USERS" },
      { q: "SHOW DATABASES" },
      { db: "home", q: "<probe>" },
      {
        db: "home",
        q: "SELECT temp FROM home WHERE time > now() - 1h LIMIT 2",
        chunked: "true",
        chunk_size: "1000",
      },
    ]);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_influxql_read", "mcp/decision", "success"],
      ["run_influxql_read", "mcp/execution", "success"],
    ]);
  });

  test("a SHOW of the catalog answers its rows", async () => {
    script = [...READER_PROOF, ...READER_PROOF, at("show-measurements-reader")];
    const result = await influxql("SHOW MEASUREMENTS");
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows).toEqual([{ name: "big" }, { name: "home" }]);
  });

  test("a read past max_rows is cut to it, and the hint pages inside the statement rather than with an offset", async () => {
    script = [...READER_PROOF, ...READER_PROOF, selectAnswer(150)];
    const statement = "SELECT temp FROM home WHERE time > now() - 1h";
    const result = await influxql(statement, { max_rows: 100 });
    expect(result.structuredContent).toMatchObject({
      row_count: 100,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 100, hasMore: true, nextOffset: null, wasLimited: false },
      hint: RUN_INFLUXQL_READ_ARM.moreRows(statement, "influxdb", { maxRows: 100, shown: 100, cut: "max_rows" }),
    });
    expect(result.structuredContent?.hint).toContain("OFFSET 100");
  });
});

describe("a refusal", () => {
  test.each([
    ["INTO", 'SELECT * INTO "other".."m" FROM home'],
    ["a write", "DROP MEASUREMENT home"],
    ["SHOW USERS", "SHOW USERS"],
    ...INFLUXQL_QUERY_TEXT_SPELLINGS.map((spelling) => ["a spelling of a statement text read", spelling]),
  ])("%s (%p) is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await influxql(statement);
    const refusal = server.admit?.(server.canonicalize({ statement }) ?? statement);
    expect(refusal).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(text(result)).toStartWith("The statement was refused before it reached the database");
    expect(acquire).not.toHaveBeenCalled();
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_influxql_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test.each(["show-queries-during-admin-read-reader", "show-continuous-queries-reader"])(
    "an answer shaped as %s is refused by the provider from its columns, and none of its text reaches the client",
    async (name) => {
      const captured = at(name);
      script = [...READER_PROOF, ...READER_PROOF, { ...captured, body: captured.body.replaceAll("<qid>", "7") }];
      const result = await influxql("SELECT temp FROM home WHERE time > now() - 1h");
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(INFLUXQL_AGENT_QUERY_TEXT_SENTENCE);
      expect(text(result)).not.toContain("SELECT count(v)");
      expect(text(result)).not.toContain("CREATE CONTINUOUS QUERY");
      expect(text(result)).not.toContain("admin");
      expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", result: "failure" });
    },
  );

  test("a user that can write a second database is refused at open, in the tool's sentence, and nothing is sent", async () => {
    script = RW_PROOF;
    const result = await influxql("SELECT temp FROM home WHERE time > now() - 1h");
    expect(result.isError).toBe(true);
    expect(text(result)).toStartWith("run_influxql_read cannot run on this connection: The agent read-only profile");
    expect(text(result)).toContain('can write the database "other"');
    expect(text(result)).toEndWith("It runs on InfluxDB (InfluxQL).");
    expect(wire.requests.map((request) => request.form?.q)).not.toContain(
      "SELECT temp FROM home WHERE time > now() - 1h",
    );
  });

  test("a provider not opened under the agent read-only profile refuses the read", async () => {
    honourProfile = false;
    const result = await influxql("SELECT temp FROM home WHERE time > now() - 1h");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Read-only execution requires a provider opened under the agent read-only profile");
    expect(wire.requests).toHaveLength(3);
  });

  test("a read past the provider's row budget is refused with the statement's own advice", async () => {
    script = [...READER_PROOF, ...READER_PROOF, selectAnswer(1_001)];
    const statement = "SELECT temp FROM home WHERE time > now() - 1h";
    const result = await influxql(statement);
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

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_influxql_read", { connection_id: "seed:shop", statement: "SHOW DATABASES" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_influxql_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on InfluxDB (InfluxQL).",
        },
      ],
    });
  });

  test("run_read_query refuses an InfluxDB connection, naming run_influxql_read", async () => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await call("run_read_query", { connection_id: "seed:influx", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "this tool does not serve InfluxDB (InfluxQL); use run_influxql_read there",
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "other" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await influxql("SHOW MEASUREMENTS", extra);
    expect(result.isError).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });
});
