/**
 * run_sparkplug_read: MCP's Sparkplug arm, run by the statement core over the real Sparkplug provider, through the real
 * route, seed file and handler, with a scripted broker behind the provider's read seam in place of a socket.
 *
 * The provider is the one the factory would hand out, built here only so its reader is the scripted one: the agent
 * read-only profile opens it to send statements, which `queryReadOnly` refuses without. The request is the agent's own,
 * read and admitted by the agent's own Sparkplug reader: a read answers one row of counts and flags behind the
 * untrusted-content notice, with its window and the completeness sentence as notes, never an id, a metric name or a
 * value; a call opens two broker sessions, the handshake that subscribes to nothing and the read, and neither writes a
 * PUBLISH; an id with a wildcard, the STATE group and any other read are refused before anything is acquired; a read of
 * another group on a connection that names one is refused before the read is sent; a timeout too short for the window
 * is refused before anything is acquired; and inspect_schema answers an empty page, since an agent-mode handle
 * declares no container level and no object kind.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPARKPLUG_MCP_LEAST_TIMEOUT_MS } from "@/lib/agent/languages/sparkplugread/mcp";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import {
  SPARKPLUG_COMPLETENESS,
  SPARKPLUG_EXACT_LAST_MESSAGE,
} from "@/lib/db/providers/industrial/sparkplug/agent-read";
import { dialAndRead, SparkplugProvider, type SparkplugReader } from "@/lib/db/providers/industrial/sparkplug/index";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import { CONNACK, metric, payload, publish, scripted, subscribedFilters } from "../../unit/db/sparkplug/fake-plant";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-sparkplug-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("sparkplugread");
const RUN_SPARKPLUG_READ_ARM = mcpStatementArm("run_sparkplug_read");
/** Ids, metric names and the host application the plant script carries; none may reach an answer. */
const IDS = ["Plant-North", "Line-7", "Press-3", "host-scada", "Temperature", "Pressure", "broker.test"];
const PLANT = [
  ...CONNACK,
  ...publish("spBv1.0/STATE/host-scada", [...new TextEncoder().encode('{"online":true,"timestamp":1}')]),
  ...publish("spBv1.0/Plant-North/NBIRTH/Line-7", payload(metric("bdSeq", 0), metric("Temperature", 21))),
  ...publish("spBv1.0/Plant-North/DBIRTH/Line-7/Press-3", payload(metric("Pressure", 4))),
  ...publish("spBv1.0/Plant-North/DDATA/Line-7/Press-3", payload(metric("Pressure", 5))),
];

/** Each broker session's packets, in order: the acquisition's handshake first. */
let sessions: Uint8Array[][] = [];
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

beforeEach(() => {
  sessions = [];
  honourProfile = true;
  writeSeedFile(dir, [
    { id: "plant", type: "sparkplug", host: "broker.test", port: 1883 },
    { id: "north", type: "sparkplug", host: "broker.test", port: 1883, database: "Plant-North" },
    { id: "shop", type: "sqlite", database: join(dir, "absent.db") },
  ]);
  // The factory's provider, with only its reader replaced: the handshake answers CONNACK, every read the plant.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      const queue = [CONNACK];
      const reader: SparkplugReader = (request) => {
        const { factory, written } = scripted(queue.shift() ?? PLANT);
        sessions.push(written);
        return dialAndRead(request, factory);
      };
      // Every agent profile opens read-only; only agent-read-only sends statements, as executionContextFor derives.
      const agent = honourProfile && profile === "agent-read-only";
      const provider = new SparkplugProvider(
        connection as DatabaseConnection,
        {},
        { readOnly: honourProfile, sendsStatements: agent },
        reader,
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

const sparkplug = (statement: string, extra: Record<string, unknown> = {}, connection = "seed:plant") =>
  call("run_sparkplug_read", { connection_id: connection, statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

const acquireSpy = () => McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;

const holdsNoId = (answer: Answered) => {
  const text = JSON.stringify(answer);
  for (const id of IDS) expect(text).not.toContain(id);
};

describe("the tool", () => {
  test("is listed read-only, with the statement schema, no offset or database, and its least timeout", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_sparkplug_read");
      expect(tool?.description).toBe(RUN_SPARKPLUG_READ_ARM.description);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "connection_id",
        "statement",
        "max_rows",
        "timeout_ms",
      ]);
      expect(tool?.inputSchema.properties?.timeout_ms).toMatchObject({ minimum: 5000, maximum: 30000, default: 10000 });
    } finally {
      await session.close();
    }
  });

  test("takes 5,000 ms at the least: the window and its dial, after the handshake", () => {
    expect(SPARKPLUG_MCP_LEAST_TIMEOUT_MS).toBe(5000);
    expect(RUN_SPARKPLUG_READ_ARM.engines).toBe("Sparkplug B");
  });

  test("list_connections names it as each Sparkplug connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:plant", "run_sparkplug_read"],
      ["seed:north", "run_sparkplug_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });

  test("list_connections leaves out the group a connection names, since a group id is a stored value", async () => {
    const result = await call("list_connections", {});
    const north = result.structuredContent?.connections.find(
      (connection: { id: string }) => connection.id === "seed:north",
    );
    expect(north).toEqual({ id: "seed:north", name: "north", engine: "sparkplug", read_tool: "run_sparkplug_read" });
    holdsNoId(result);
  });

  test("inspect_schema answers an empty page, since an agent-mode handle declares no kind, after one handshake", async () => {
    const result = await call("inspect_schema", { connection_id: "seed:north" });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual({
      connection_id: "seed:north",
      schema: "default",
      total_tables: 0,
      offset: 0,
      limit: 50,
      has_more: false,
      next_offset: null,
      tables: [],
    });
    holdsNoId(result);
    // The agent-operations handle's handshake, which subscribes to nothing, and no read.
    expect(sessions.map((written) => written.map((bytes) => bytes[0]))).toEqual([[0x10, 0xe0]]);
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", result: "success" });
  });
});

describe("inspect_schema's schema names", () => {
  test("are unavailable, since the handle declares no level, and name no id", async () => {
    const result = await call("inspect_schema", { connection_id: "seed:north", include_schema_names: true });
    expect(result.structuredContent?.schema_names).toEqual({
      unavailable:
        "This connection has no schema level: its tables are read at its root, and inspect_schema takes no schema.",
    });
    holdsNoId(result);
  });
});

describe("a read", () => {
  test("the window answers totals behind the notice, with its window and the completeness sentence as notes", async () => {
    const result = await sparkplug('{"read": "window"}');
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent?.rows).toEqual([
      expect.objectContaining({
        scope: "window",
        groups_seen: 1,
        edge_nodes_seen: 1,
        devices_seen: 1,
        messages: 4,
        nbirth: 1,
        dbirth: 1,
        ddata: 1,
        other_messages: 1,
        metrics: 4,
      }),
    ]);
    const notes = result.structuredContent?.notes as string[];
    expect(notes[0]).toContain("Studio listened to the whole spBv1.0 namespace");
    expect(notes[0]).toContain("It counted 4 messages from 1 group, 1 edge node and 1 device.");
    expect(notes.at(-1)).toBe(SPARKPLUG_COMPLETENESS);
    holdsNoId(result);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_sparkplug_read", "mcp/decision", "success"],
      ["run_sparkplug_read", "mcp/execution", "success"],
    ]);
  });

  test("a call opens two broker sessions, the handshake then the read, and neither writes a PUBLISH", async () => {
    await sparkplug('{"read": "window"}');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.map((bytes) => bytes[0])).toEqual([0x10, 0xe0]);
    expect(subscribedFilters(sessions[1] ?? [])).toEqual(["spBv1.0/#"]);
    for (const written of sessions) for (const bytes of written) expect((bytes[0] as number) >> 4).not.toBe(3);
  });

  test("a device the request names answers its counts, never its id, a metric name or a value", async () => {
    const result = await sparkplug(
      '{"read": "device", "group": "Plant-North", "edgeNode": "Line-7", "device": "Press-3"}',
    );
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows).toEqual([
      expect.objectContaining({ seen: true, messages: 2, dbirth: 1, ddata: 1, birth_seen: true, metrics: 2 }),
    ]);
    const notes = result.structuredContent?.notes as string[];
    expect(notes[0]).toContain("the one device the request named");
    expect(notes).toContain(SPARKPLUG_EXACT_LAST_MESSAGE);
    expect(notes.at(-1)).toBe(SPARKPLUG_COMPLETENESS);
    holdsNoId(result);
  });

  test("on a connection that names a group, the window listens to that group alone", async () => {
    const result = await sparkplug('{"read": "window"}', {}, "seed:north");
    expect(result.isError ?? false).toBe(false);
    expect(subscribedFilters(sessions[1] ?? [])).toEqual(["spBv1.0/Plant-North/#"]);
    holdsNoId(result);
  });
});

describe("a refusal", () => {
  test.each([
    ["an id with a wildcard", '{"read": "group", "group": "Plant-+"}'],
    ["an id with a level separator", '{"read": "edgeNode", "group": "Plant-North/NBIRTH", "edgeNode": "Line-7"}'],
    ["the host state group", '{"read": "group", "group": "STATE"}'],
    ["a read outside the four", '{"read": "metrics", "group": "Plant-North"}'],
    ["a command", '{"read": "rebirth", "group": "Plant-North", "edgeNode": "Line-7"}'],
    ["another key", '{"read": "window", "filter": "spBv1.0/#"}'],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const result = await sparkplug(statement);
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The read request was refused before it reached the broker (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(acquireSpy()).not.toHaveBeenCalled();
  });

  test("a group other than the connection's own is refused before the read is sent", async () => {
    const result = await sparkplug('{"read": "group", "group": "Plant-South"}', {}, "seed:north");
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "This connection names one group in its Database field, and an agent read stays inside it",
    );
    // The handshake alone: no session for the read.
    expect(sessions).toHaveLength(1);
  });

  test.each(["database", "offset"])(
    "an argument the tool does not name (%s) is refused, not dropped, before anything is acquired",
    async (key) => {
      const result = await sparkplug('{"read": "window"}', { [key]: key === "offset" ? 1 : "elsewhere" });
      expect(result.isError).toBe(true);
      const text = result.content.map((block) => block.text).join("\n");
      expect(text).toContain("Input validation error");
      expect(text).toContain(key);
      expect(acquireSpy()).not.toHaveBeenCalled();
    },
  );

  test("a timeout_ms too short for the window and its dial is refused in words before anything is acquired", async () => {
    const result = await sparkplug('{"read": "window"}', { timeout_ms: 4_999 });
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => block.text).join("\n");
    expect(text).toContain("Input validation error");
    expect(text).toContain(
      "timeout_ms must be at least 5000 for run_sparkplug_read: a Sparkplug read listens for a 3,000 ms window and needs 4,000 ms with its dial, after the connection's own handshake, and a window is never shortened, so nothing was sent.",
    );
    expect(acquireSpy()).not.toHaveBeenCalled();
  });

  test("a provider not opened under the agent read-only profile refuses the read, and sends it nowhere", async () => {
    honourProfile = false;
    const result = await sparkplug('{"read": "window"}');
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_sparkplug_read", { connection_id: "seed:shop", statement: '{"read": "window"}' });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_sparkplug_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on Sparkplug B.",
        },
      ],
    });
    expect(acquireSpy()).not.toHaveBeenCalled();
  });
});

describe("the words a cut result would take", () => {
  test("say a Sparkplug read answers one row and is never paged", () => {
    const statement = '{"read": "window"}';
    expect(RUN_SPARKPLUG_READ_ARM.moreRows(statement, "sparkplug", { maxRows: 1, shown: 1, cut: "max_rows" })).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(statement, "1")} To read one group, edge node or device the request names in full, since a Sparkplug read answers one row and is never paged.`,
    );
    expect(RUN_SPARKPLUG_READ_ARM.moreRows(statement, "sparkplug", { maxRows: 1, shown: 0, cut: "result_bytes" })).toBe(
      "More rows exist than the 32 KiB result limit holds, and 0 of them fitted; this tool does not page with offset. Read one group, edge node or device the request names in full instead of the window to fit more rows, and to read one group, edge node or device the request names in full, since a Sparkplug read answers one row and is never paged.",
    );
    expect(RUN_SPARKPLUG_READ_ARM.rowOverCap).toBe(
      "The one row of this read is larger than the 32 KiB result limit, which a count and a flag never are. Run the read again.",
    );
  });
});
