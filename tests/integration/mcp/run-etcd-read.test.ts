/**
 * run_etcd_read: MCP's etcd arm, run by the statement core over the real etcd provider, through the real route, seed
 * file and handler, with a client answering from what etcd v3.7.2 answered the same principal
 * (tests/fixtures/etcd/v3.7.2/agent-boundary/) in place of a server.
 *
 * The provider is the one the factory would hand out, built here only so its client is the recorded one: the agent
 * read-only profile opens it to send statements, which `queryReadOnly` refuses without. The command is the agent's
 * own, read and admitted by the agent's own etcd reader: a metadata read answers names, counts and sizes behind the
 * untrusted-content notice, after the server answered the proof's three reads; a ranged get, a value read, a watch and
 * a write are refused before anything is acquired; a user the proof refuses is refused at the open in the tool's
 * sentence; a key outside the user's READ ranges is refused in Studio's words whether it exists or not; and a read
 * past the row budget is refused with the command's own advice.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { ETCD_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-metadata-read";
import { ETCD_PROOF_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-read-only-proof";
import type { EtcdClient } from "@/lib/db/providers/keyvalue/etcd/client";
import { EtcdError } from "@/lib/db/providers/keyvalue/etcd/client";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { capturedClient, type EtcdAgentPrincipal, principalCapture } from "../../helpers/etcd-agent";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../helpers/etcd-fake-client";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-etcd-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("etcdctl");
const RUN_ETCD_READ_ARM = mcpStatementArm("run_etcd_read");
/** A seed is plain data, so its password is written as the operator writes it. */
const CLUSTER_SEED = {
  id: "cluster",
  type: "etcd",
  host: "etcd.test",
  port: 2379,
  user: "agent_reader_range",
  password: "not-a-real-password",
  ssl: { mode: "require" },
};
/** Every key name and value the capture seeded; none may reach an answer. */
const SEEDED = /\/app\/|\/other\/|fixture-/;

let principal: EtcdAgentPrincipal = "reader-range";
let overrides: Partial<EtcdClient> = {};
let client: FakeEtcdClient = createFakeEtcdClient();
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

beforeEach(() => {
  principal = "reader-range";
  overrides = {};
  honourProfile = true;
  writeSeedFile(dir, [CLUSTER_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  // The factory's provider, with only its client replaced: opened to send statements for agent-read-only alone.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      client = createFakeEtcdClient({
        ...capturedClient(principalCapture(principal)),
        authenticate: async () => {},
        close: async () => {},
        ...overrides,
      });
      // Every agent profile opens read-only; only agent-read-only sends statements, as executionContextFor derives.
      const agent = honourProfile && profile === "agent-read-only";
      const provider = new EtcdProvider(
        connection as DatabaseConnection,
        { queryTimeout: 30_000 },
        { readOnly: honourProfile, sendsStatements: agent },
        async () => client,
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

const etcd = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_etcd_read", { connection_id: "seed:cluster", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

const methods = () => client.calls.map((sent) => sent.method);

/** The proof's three reads, one RoleGet per role: at the open, and again before every command. */
const PROOF: readonly (keyof EtcdClient)[] = ["authStatus", "userGet", "roleGet"];

describe("the tool", () => {
  test("is listed read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_etcd_read");
      expect(tool?.description).toBe(RUN_ETCD_READ_ARM.description);
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

  test("describes etcd as the engine it runs on", () => {
    expect(RUN_ETCD_READ_ARM.engines).toBe("etcd");
  });

  test("list_connections names it as the etcd connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:cluster", "run_etcd_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });

  test("inspect_schema lists no key prefix, since key names are withheld from every agent-mode handle", async () => {
    const result = await call("inspect_schema", { connection_id: "seed:cluster" });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toMatchObject({ total_tables: 0, tables: [], has_more: false });
    expect(methods()).not.toContain("range");
  });
});

describe("a read", () => {
  test("the member list answers ids and counts behind the notice, after the proof, recorded under run_etcd_read", async () => {
    const result = await etcd("member list");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:cluster",
      columns: [
        { name: "member_id" },
        { name: "name" },
        { name: "is_learner" },
        { name: "peer_urls" },
        { name: "client_urls" },
      ],
      rows: [
        { member_id: "b815839983d33568", name: "pr39-etcd-auth", is_learner: false, peer_urls: 1, client_urls: 1 },
      ],
      row_count: 1,
      truncated: false,
      hint: null,
    });
    // No member's address reaches the answer: its URLs are counted.
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    // The open's own reads and the grants, the proof at the open, then the proof again and the one request.
    expect(methods()).toEqual([
      "authenticate",
      "status",
      "authStatus",
      "userGet",
      "roleGet",
      ...PROOF,
      ...PROOF,
      "memberList",
    ]);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_etcd_read", "mcp/decision", "success"],
      ["run_etcd_read", "mcp/execution", "success"],
    ]);
  });

  test("a key the user may read answers its metadata, and no key name or value", async () => {
    const result = await etcd("get /app/config");
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows).toEqual([
      { exists: true, create_revision: 2, mod_revision: 2, version: 1, lease_id: null, value_bytes: 20 },
    ]);
    expect(JSON.stringify(result.structuredContent)).not.toMatch(SEEDED);
  });

  test("a missing key in the user's ranges answers that it does not exist", async () => {
    const result = await etcd("get /app/missing");
    expect(result.structuredContent?.rows).toEqual([
      {
        exists: false,
        create_revision: null,
        mod_revision: null,
        version: null,
        lease_id: null,
        value_bytes: null,
      },
    ]);
  });
});

describe("a refusal", () => {
  test.each([
    ["a prefix get", "get /app/ --prefix"],
    ["a keys-only get", "get /app/config --keys-only"],
    ["a prefix count", "get /registry/ --prefix --count-only"],
    ["a lease's keys", "lease timetolive 694d8147df1dc4c8 --keys"],
    ["a watch", "watch /app/config"],
    ["a put", "put /app/config written"],
    ["a delete", "del /app/config"],
    ["a user read", "user list"],
    ["a compaction", "compaction 1"],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, command) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await etcd(command);
    const refusal = server.admit?.(command);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The command was refused before it reached the cluster (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_etcd_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test.each([
    ["a user with READ on every key", "reader-all" as const, ETCD_PROOF_SENTENCES.everyKey],
    ["a user with a READWRITE range", "readwrite-range" as const, ETCD_PROOF_SENTENCES.writer],
    ["a user holding the root role", "root-role" as const, ETCD_PROOF_SENTENCES.rootRole],
  ])("%s is refused at the open in the tool's sentence, and no command is sent", async (_what, refused, sentence) => {
    principal = refused;
    const result = await etcd("endpoint status");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `run_etcd_read cannot run on this connection: ${sentence.replace(/\.+$/, "")}. It runs on etcd.`,
        },
      ],
    });
    expect(methods()).not.toContain("memberList");
  });

  test("a user and password on a server with authentication off is refused at the open in the tool's sentence", async () => {
    principal = "auth-off";
    overrides = {
      authenticate: async () => {
        throw new EtcdError("failed-precondition", "etcdserver: authentication is not enabled", 9);
      },
    };
    const result = await etcd("endpoint status");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `run_etcd_read cannot run on this connection: ${ETCD_PROOF_SENTENCES.authOff.replace(/\.+$/, "")}. It runs on etcd.`,
        },
      ],
    });
    expect(result.content[0].text).not.toContain("(etcd:");
    expect(methods()).toEqual(["authenticate", "close"]);
  });

  test("a user whose READ reaches /registry/ is refused at the open, naming the prefix", async () => {
    overrides = {
      userGet: async () => ["agent_read_registry"],
      roleGet: async () => [
        {
          type: "read",
          key: new TextEncoder().encode("/registry/secrets/"),
          rangeEnd: new TextEncoder().encode("/registry/secrets0"),
        },
      ],
    };
    const result = await etcd("endpoint status");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(ETCD_PROOF_SENTENCES.kubernetes("/registry/").replace(/\.+$/, ""));
  });

  test("a key outside the user's READ ranges is refused in Studio's words, never etcd's", async () => {
    const result = await etcd("get /other/credential");
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => block.text).join("\n");
    expect(text).toContain(ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied"));
    expect(text).not.toContain("etcdserver");
    expect(text).not.toMatch(SEEDED);
  });

  test("a key outside the user's READ ranges answers alike whether or not it exists", async () => {
    const answers: string[] = [];
    for (const key of ["/registry/secrets/default/present", "/registry/secrets/default/absent"]) {
      overrides = {
        range: async () => Promise.reject(new EtcdError("permission-denied", "etcdserver: permission denied", 7)),
      };
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each reads its own answer.
      const result = await etcd(`get ${key}`);
      answers.push(JSON.stringify(result));
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).not.toContain("present");
  });

  test("a provider not opened under the agent read-only profile refuses the read, and sends it nowhere", async () => {
    honourProfile = false;
    const result = await etcd("endpoint status");
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    // The editor handle's own open, and nothing for the command.
    expect(methods()).toEqual(["authenticate", "status", "authStatus", "userGet", "roleGet"]);
  });

  test("a read past the provider's row budget is refused with the command's own advice", async () => {
    overrides = {
      leaseLeases: async () => ({
        header: { clusterId: "1", memberId: "1", revision: "1", raftTerm: "1" },
        ids: Array.from({ length: 1_001 }, (_, i) => String(i + 1)),
      }),
    };
    const result = await etcd("lease list");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("lease list", "1000")}`,
        },
      ],
    });
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_result_too_large" });
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_etcd_read", { connection_id: "seed:shop", statement: "endpoint status" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_etcd_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on etcd.",
        },
      ],
    });
  });

  test("run_read_query refuses an etcd connection, naming run_etcd_read", async () => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await call("run_read_query", { connection_id: "seed:cluster", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve etcd; use run_etcd_read there");
    expect(acquire).not.toHaveBeenCalled();
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "app" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await etcd("endpoint status", extra);
    expect(result.isError).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });
});
