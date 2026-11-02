/**
 * run_redis_read: MCP's Redis arm, run by the statement core over the real Redis provider, through the real route,
 * seed file, factory and handler, with a driver double in place of ioredis that answers what Redis 8.10.2 answered each
 * principal (tests/fixtures/redis/8.10.2/agent-boundary/).
 *
 * The command is the agent's own, read and admitted by the agent's own Redis adapter: a read answers the metadata-only
 * projection behind the untrusted-content notice and never repeats its key; a write, a key listing, a value read,
 * `INFO` and a second command are refused before anything is acquired. The acquisition is the agent read-only profile,
 * so a seed that names no ACL user or names `default` is refused before any socket, a writable user is refused by the
 * proof, and the proof runs again on the command's own connection right before the command. A key-pattern reader is
 * refused a key outside its patterns in the same words whether the key exists or not, and those words never name it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import { REDIS_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/keyvalue/redis-metadata-read";
import { REDIS_PROOF_SENTENCES } from "@/lib/db/providers/keyvalue/redis-read-only-proof";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { type McpStatementInput, runStatement } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import { asReply, type CapturedStep, principalCapture, probeLabel, stepFor } from "../../helpers/redis-agent";

pinMcpTestEnvironment();

const VERSION = "8.10.2";

interface Opened {
  readonly options: Record<string, unknown>;
  readonly calls: string[][];
  readonly pipelines: string[][][];
  disconnected: boolean;
}
const opened: Opened[] = [];
/** A read that never answers, so the call meets its deadline or its cancel instead. */
let hang = false;

function replyError(message: string): Error {
  const error = new Error(message);
  error.name = "ReplyError";
  return error;
}

/** The captured principal a connection signs in as: its ACL user's name with the `agent_` prefix dropped. */
function principalOf(options: Record<string, unknown>): string {
  return String(options.username)
    .replace(/^agent_/, "")
    .replace(/_/g, "-");
}

mock.module("ioredis", () => {
  class MockRedis {
    private readonly state: Opened;
    constructor(options: Record<string, unknown>) {
      this.state = { options, calls: [], pipelines: [], disconnected: false };
      opened.push(this.state);
    }
    on() {
      return this;
    }
    async connect() {}
    async select() {
      return "OK";
    }
    async call(command: string, ...args: string[]) {
      const argv = [command, ...args];
      this.state.calls.push(argv);
      if (hang) return new Promise<never>(() => {});
      const step = stepFor(principalCapture(VERSION, principalOf(this.state.options)).table, argv);
      if (step === undefined) throw new Error(`no captured read for ${argv.join(" ")}`);
      if (step.outcome === "error") throw replyError(step.error ?? "");
      return step.reply;
    }
    pipeline() {
      const queued: string[][] = [];
      this.state.pipelines.push(queued);
      const principal = principalOf(this.state.options);
      const pipeline = {
        call(command: string, ...args: string[]) {
          queued.push([command, ...args]);
          return pipeline;
        },
        async exec() {
          return queued.map((argv): [Error | null, unknown] => {
            const capture = principalCapture(VERSION, argv[0] === "HELLO" ? "reader-info" : principal);
            const step =
              argv[0] === "HELLO"
                ? (stepFor(capture.outside, ["HELLO", "2"]) as CapturedStep)
                : capture.probes.find((probe) => probeLabel(probe.argv) === probeLabel(argv));
            if (step === undefined) throw new Error(`no captured probe for ${argv.join(" ")}`);
            const reply = asReply(step);
            return reply.ok ? [null, reply.reply] : [replyError(reply.error), undefined];
          });
        },
      };
      return pipeline;
    }
    disconnect() {
      this.state.disconnected = true;
    }
    async quit() {
      this.state.disconnected = true;
    }
  }
  return { default: MockRedis };
});

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-redis-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("rediscli");
const RUN_REDIS_READ_ARM = mcpStatementArm("run_redis_read");
/** A seed is plain data; the password is a placeholder the double never checks. */
const redisSeed = (id: string, user?: string) => ({
  id,
  type: "redis",
  host: "127.0.0.1",
  port: 6379,
  ...(user === undefined ? {} : { user }),
  password: "not-a-real-password",
});

beforeEach(() => {
  opened.length = 0;
  hang = false;
  writeSeedFile(dir, [
    redisSeed("cache", "agent_reader_info"),
    redisSeed("scoped", "agent_prefix"),
    redisSeed("writer", "agent_full"),
    redisSeed("stock"),
    redisSeed("named-default", "default"),
    { id: "shop", type: "sqlite", database: join(dir, "absent.db") },
  ]);
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

const redis = (statement: string, extra: Record<string, unknown> = {}, connection = "seed:cache") =>
  call("run_redis_read", { connection_id: connection, statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

const textOf = (result: Answered) => result.content.map((block) => block.text).join("\n");

/** Every command any connection sent outside the proof's pipelines. */
const sentCommands = () => opened.flatMap((connection) => connection.calls);

describe("the tool", () => {
  test("is listed after run_cypher_read, read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      expect(tools.map((tool) => tool.name).indexOf("run_redis_read")).toBe(
        tools.map((tool) => tool.name).indexOf("run_cypher_read") + 1,
      );
      const tool = tools.find((candidate) => candidate.name === "run_redis_read");
      expect(tool?.description).toBe(RUN_REDIS_READ_ARM.description);
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

  test("describes Redis as the engine it runs on", () => {
    expect(RUN_REDIS_READ_ARM.engines).toBe("Redis");
  });

  test("list_connections names it as each Redis connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:cache", "run_redis_read"],
      ["seed:scoped", "run_redis_read"],
      ["seed:writer", "run_redis_read"],
      ["seed:stock", "run_redis_read"],
      ["seed:named-default", "run_redis_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("TYPE answers the key's type behind the notice, never its name, recorded under run_redis_read", async () => {
    const result = await redis("TYPE agent:hash");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:cache",
      columns: [{ name: "type" }],
      rows: [{ type: "hash" }],
      row_count: 1,
      truncated: false,
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    expect(JSON.stringify(result)).not.toContain("agent:hash");
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_redis_read", "mcp/decision", "success"],
      ["run_redis_read", "mcp/execution", "success"],
    ]);
  });

  test("the command runs on a connection of its own, proved read-only right before it, and closed after", async () => {
    await redis("MEMORY USAGE agent:hash SAMPLES 5", { timeout_ms: 5_000 });
    // The handle's own connection, proved at the open, and the command's, proved again before the command.
    expect(opened).toHaveLength(2);
    const [handle, command] = opened;
    expect(handle.pipelines).toHaveLength(1);
    expect(handle.calls).toEqual([]);
    expect(command.pipelines).toHaveLength(1);
    expect(command.pipelines[0][0]).toEqual(["HELLO", "2"]);
    expect(command.pipelines[0].slice(1).map(probeLabel)).toEqual(
      principalCapture(VERSION, "reader-info").probes.map((step) => probeLabel(step.argv)),
    );
    expect(command.calls).toEqual([["MEMORY", "USAGE", "agent:hash", "SAMPLES", "5"]]);
    expect(command.disconnected).toBe(true);
    // The call's time left is the command's timeout, so the server's work is bounded by the call's deadline.
    expect(command.options.commandTimeout).toBeGreaterThan(0);
    expect(command.options.commandTimeout).toBeLessThanOrEqual(5_000);
    expect(command.options.username).toBe("agent_reader_info");
  });

  test("DBSIZE answers the database's key count", async () => {
    const result = await redis("DBSIZE");
    expect(result.structuredContent?.rows).toEqual([{ keys: 8 }]);
  });
});

describe("a refusal", () => {
  test.each([
    ["a write", "SET agent:hash x"],
    ["a key listing", "SCAN 0"],
    ["KEYS", "KEYS *"],
    ["a value read", "GET agent:string"],
    ["INFO", "INFO keyspace"],
    ["a second command", "DBSIZE\nDEL agent:hash"],
    ["a trailing CRLF", "TYPE agent:hash\r\n"],
    ["a leading line break", "\nTYPE agent:hash"],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, line) => {
    const result = await redis(line);
    const refusal = server.admit?.(line);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The command was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(opened).toEqual([]);
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_redis_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test.each([
    ["names no ACL user", "seed:stock", REDIS_PROOF_SENTENCES.noUser],
    ["names default", "seed:named-default", REDIS_PROOF_SENTENCES.defaultUser],
  ])("a seed that %s is refused before any socket, in the tool's sentence", async (_what, connection, sentence) => {
    const result = await redis("DBSIZE", {}, connection);
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `run_redis_read cannot run on this connection: ${sentence}`.replace(/\.$/, "") + ". It runs on Redis.",
        },
      ],
    });
    expect(opened).toEqual([]);
  });

  test("a writable user is refused by the proof at the open, and no command is sent", async () => {
    const result = await redis("DBSIZE", {}, "seed:writer");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `run_redis_read cannot run on this connection: ${REDIS_PROOF_SENTENCES.admitted("DEL").replace(/\.$/, "")}. It runs on Redis.`,
        },
      ],
    });
    expect(sentCommands()).toEqual([]);
  });

  test("a key-pattern reader is refused a key outside its patterns in the same words whether it exists or not", async () => {
    const hit = await redis("TYPE agent:hash", {}, "seed:scoped");
    const miss = await redis("TYPE agent:missing", {}, "seed:scoped");
    expect(hit.isError).toBe(true);
    expect(textOf(hit)).toContain(REDIS_AGENT_FAILURE_SENTENCES.noPerm);
    expect(textOf(miss)).toBe(textOf(hit));
    for (const answer of [hit, miss]) {
      expect(textOf(answer)).not.toContain("agent:");
      expect(textOf(answer)).not.toContain("No permissions to access a key");
    }
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_execution_failed" });
    // The same reader still reads what its grants allow: the database's key count.
    expect((await redis("DBSIZE", {}, "seed:scoped")).structuredContent?.rows).toEqual([{ keys: 8 }]);
  });

  test("a read of the wrong type is worded by its code alone", async () => {
    const result = await redis("STRLEN agent:hash");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(REDIS_AGENT_FAILURE_SENTENCES.wrongType);
    expect(textOf(result)).not.toContain("agent:hash");
  });

  test("a read past timeout_ms is answered as the timeout, and the command's connection carried the deadline", async () => {
    hang = true;
    const result = await redis("DBSIZE", { timeout_ms: 500 });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000.",
        },
      ],
    });
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_timeout" });
    expect(opened.at(-1)?.options.commandTimeout).toBeLessThanOrEqual(500);
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_redis_read", { connection_id: "seed:shop", statement: "DBSIZE" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_redis_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on Redis.",
        },
      ],
    });
  });

  test("run_read_query refuses a Redis connection, naming run_redis_read", async () => {
    const result = await call("run_read_query", { connection_id: "seed:cache", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve Redis; use run_redis_read there");
    expect(opened).toEqual([]);
  });

  test.each([
    ["an offset", { offset: 1 }],
    ["a database", { database: "1" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const result = await redis("DBSIZE", extra);
    expect(result.isError).toBe(true);
    expect(opened).toEqual([]);
  });
});

describe("a cancel", () => {
  test("ends the client's wait; the command's own timeout, the call's time left, ends the read", async () => {
    hang = true;
    const connection = {
      ...redisSeed("cache", "agent_reader_info"),
      id: "seed:cache",
      name: "cache",
      seedId: "cache",
      managed: true,
      mcp: true,
      roles: ["*"],
      createdAt: new Date(),
    } as unknown as ManagedConnection;
    const context = {
      caller: { username: "alice", role: "admin" },
      visibleConnections: async () => [connection],
      resolve: async () => connection,
      acquire: (target: ManagedConnection, profile: ExecutionProfile) =>
        acquireExecutionProfileProvider(target, profile),
    } as unknown as McpConnectionContext;
    const controller = new AbortController();
    const args = RUN_REDIS_READ_ARM.inputSchema.parse({
      connection_id: "seed:cache",
      statement: "DBSIZE",
      timeout_ms: 5_000,
    }) as McpStatementInput;
    const answered = runStatement(RUN_REDIS_READ_ARM, args, { context, signal: controller.signal });
    // Cancel once the command is on the wire.
    while (opened.length < 2 || opened[1].calls.length === 0) await Bun.sleep(5);
    controller.abort();
    expect(await answered).toEqual({ isError: true, content: [{ type: "text", text: MCP_CANCELLED_TEXT }] });
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_cancelled" });
    expect(opened[1].calls).toEqual([["DBSIZE"]]);
    expect(opened[1].options.commandTimeout).toBeGreaterThan(0);
    expect(opened[1].options.commandTimeout).toBeLessThanOrEqual(5_000);
    await clearProviderCache();
  });
});
