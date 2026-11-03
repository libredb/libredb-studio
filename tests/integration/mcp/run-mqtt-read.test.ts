/**
 * run_mqtt_read: MCP's MQTT arm, run by the statement core over the real MQTT provider, through the real route, seed
 * file and handler, with a scripted MQTT 5.0 broker behind the provider's transport seam in place of a socket.
 *
 * The provider is the one the factory would hand out, built here only so its transport is the scripted one: the agent
 * read-only profile opens it to send statements, which `queryReadOnly` refuses without. The request is the agent's own,
 * read and admitted by the agent's own MQTT reader: a read answers one row of counts and flags behind the
 * untrusted-content notice, with its window and the completeness sentence as notes, never a topic name, a payload or a
 * credential; a call opens two broker sessions, the handshake that subscribes to nothing and the read, and neither
 * writes a PUBLISH; a filter of the model's, a `$` root, a publish and a will are refused before anything is acquired;
 * a timeout too short for the window is refused before anything is acquired; and inspect_schema refuses the
 * connection by name.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MQTT_MCP_LEAST_TIMEOUT_MS } from "@/lib/agent/languages/mqttread/mcp";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { MQTT_COMPLETENESS, MQTT_TOPIC_LAST_MESSAGE } from "@/lib/db/providers/keyvalue/mqtt/agent-read";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import { type FakeBroker, type FakeBrokerScript, fakeBroker, subscribeFilters } from "../../unit/db/mqtt/fake-broker";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-mqtt-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("mqttread");
const RUN_MQTT_READ_ARM = mcpStatementArm("run_mqtt_read");
/** A seed is plain data, so its password is written as the operator writes it. */
const BROKER_SEED = {
  id: "plant",
  type: "mqtt",
  host: "broker.test",
  port: 1883,
  user: "agent-reader",
  password: "not-a-real-password",
  ssl: { mode: "require" },
};
/** Topics whose names stand for the people and devices behind them, and their payloads; none may reach an answer. */
const PEOPLE = [
  { topic: "homes/ayse-yilmaz/door", payload: "OPEN-SECRET-PAYLOAD" },
  { topic: "people/alice/heart-rate", payload: "Qx", retain: false },
] as const;
const WITHHELD = [
  ...PEOPLE.flatMap(({ topic, payload }) => [topic, payload]),
  "ayse",
  "alice",
  "agent-reader",
  "not-a-real-password",
  "broker.test",
];

let script: FakeBrokerScript = {};
let broker: FakeBroker = fakeBroker();
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

beforeEach(() => {
  script = { messages: PEOPLE, end: "disconnect" };
  honourProfile = true;
  writeSeedFile(dir, [BROKER_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  // The factory's provider, with only its transport replaced: opened to send statements for agent-read-only alone.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      broker = fakeBroker(script);
      // Every agent profile opens read-only; only agent-read-only sends statements, as executionContextFor derives.
      const agent = honourProfile && profile === "agent-read-only";
      const provider = new MqttProvider(
        connection as DatabaseConnection,
        {},
        { readOnly: honourProfile, sendsStatements: agent },
        broker.factory,
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

const mqtt = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_mqtt_read", { connection_id: "seed:plant", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

/** Each broker session's packet types, in the order it wrote them. */
const packetTypes = () => broker.connections.map((written) => written.map((bytes) => (bytes[0] as number) >> 4));

const acquireSpy = () => McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;

const expectNoWithheld = (answer: Answered) => {
  const text = JSON.stringify(answer);
  for (const word of WITHHELD) expect(text).not.toContain(word);
};

/** An answer with the clock's own figures taken out, so two reads of one broker compare. */
const untimed = (answer: Answered) =>
  JSON.stringify(answer.structuredContent ?? answer)
    .replace(/"(window_ms|listened_ms|last_seen_ms|execution_time_ms|byte_size)":\d+/g, '"$1":0')
    .replace(/\d[\d,]* ms/g, "N ms");

describe("the tool", () => {
  test("is listed read-only, with the statement schema, no offset or database, and its least timeout", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_mqtt_read");
      expect(tool?.description).toBe(RUN_MQTT_READ_ARM.description);
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
    expect(MQTT_MCP_LEAST_TIMEOUT_MS).toBe(5000);
    expect(RUN_MQTT_READ_ARM.engines).toBe("MQTT");
  });

  test("list_connections names it as the MQTT connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:plant", "run_mqtt_read"],
      ["seed:shop", "run_read_query"],
    ]);
    expectNoWithheld(result);
  });

  test("list_connections leaves out a connection's discovery filter, since a topic filter is a stored value", async () => {
    writeSeedFile(dir, [{ ...BROKER_SEED, id: "homes", database: "homes/ayse-yilmaz/#" }]);
    const result = await call("list_connections", {});
    expect(result.structuredContent?.connections).toEqual([
      { id: "seed:homes", name: "homes", engine: "mqtt", read_tool: "run_mqtt_read" },
    ]);
    expectNoWithheld(result);
  });

  test("inspect_schema refuses an MQTT connection by name before anything is acquired, pointing here", async () => {
    const result = await call("inspect_schema", { connection_id: "seed:plant" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "MQTT holds no table for inspect_schema to list. Read this connection with run_mqtt_read.",
        },
      ],
    });
    expect(acquireSpy()).not.toHaveBeenCalled();
  });
});

describe("a read", () => {
  test("the window answers totals behind the notice, with its window and the completeness sentence as notes", async () => {
    const result = await mqtt('{"read": "window"}');
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:plant",
      rows: [
        {
          stop_reason: "server-disconnect",
          scope: "incomplete",
          broker_reason_code: null,
          topics_seen: 2,
          messages: 2,
          retained_messages: 1,
          payload_bytes: 21,
          messages_lost: 0,
        },
      ],
      row_count: 1,
      truncated: false,
      hint: null,
    });
    const notes = result.structuredContent?.notes as string[];
    expect(notes[0]).toContain("Studio listened to every topic (the filter #");
    expect(notes[0]).toContain("It counted 2 messages on 2 distinct topics, 1 retained.");
    expect(notes.at(-1)).toBe(MQTT_COMPLETENESS);
    expectNoWithheld(result);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_mqtt_read", "mcp/decision", "success"],
      ["run_mqtt_read", "mcp/execution", "success"],
    ]);
  });

  test("a call opens two broker sessions, the handshake then the read, and neither writes a PUBLISH", async () => {
    await mqtt('{"read": "window"}');
    // The connection's check: CONNECT and DISCONNECT, no subscription. Then the read: CONNECT and SUBSCRIBE to #, and
    // the broker ends this one with its own DISCONNECT, which the read answers with one of its own.
    expect(packetTypes()).toEqual([
      [1, 14],
      [1, 8, 14],
    ]);
    const subscribe = broker.connections[1]?.find((bytes) => (bytes[0] as number) >> 4 === 8) as Buffer;
    expect(subscribeFilters(subscribe)).toEqual(["#"]);
    expect(packetTypes().flat()).not.toContain(3);
  });

  test("each session's client id is its own, so a call never takes a live client's id", async () => {
    await mqtt('{"read": "window"}');
    await mqtt('{"read": "window"}');
    const ids = broker.connections.map((written) => {
      const connect = written[0] as Buffer;
      // The client id is the CONNECT payload's first string, after the variable header and its properties.
      const at = 2 + 6 + 1 + 1 + 2 + 1 + (connect[12] as number);
      return connect.subarray(at + 2, at + 2 + connect.readUInt16BE(at)).toString();
    });
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^libredb-[0-9a-f]{16}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a topic the request names answers its counts and flags, never its name or payload", async () => {
    const result = await mqtt('{"read": "topic", "topic": "homes/ayse-yilmaz/door"}');
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows).toEqual([
      expect.objectContaining({
        stop_reason: "server-disconnect",
        scope: "incomplete",
        seen: true,
        messages: 1,
        retained: true,
        delivered_qos: 0,
        payload_bytes: 19,
        messages_lost: 0,
      }),
    ]);
    const notes = result.structuredContent?.notes as string[];
    expect(notes[0]).toContain("the one topic the request named");
    expect(notes).toContain(MQTT_TOPIC_LAST_MESSAGE);
    expect(notes.at(-1)).toBe(MQTT_COMPLETENESS);
    expectNoWithheld(result);
  });

  test("a topic the login may not read answers alike whether or not it exists", async () => {
    const answers: string[] = [];
    for (const topic of ["homes/ayse-yilmaz/door", "homes/nobody/door"]) {
      // The broker's ACL refuses the subscription with 135, Not authorized, before it looks for the topic.
      script = { messages: PEOPLE, subackCode: 0x87, end: "disconnect" };
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each reads its own answer.
      const result = await mqtt(JSON.stringify({ read: "topic", topic }));
      expect(result.structuredContent?.rows[0]).toMatchObject({
        stop_reason: "subscription-refused",
        broker_reason_code: 135,
        seen: false,
      });
      answers.push(untimed(result));
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).not.toContain("ayse");
  });
});

describe("a refusal", () => {
  test.each([
    ["a wildcard below the root", '{"read": "topic", "topic": "homes/+/door"}'],
    ["a multi-level wildcard below the root", '{"read": "topic", "topic": "homes/#"}'],
    ["the broker's $SYS tree", '{"read": "topic", "topic": "$SYS/broker/clients/connected"}'],
    ["a shared subscription", '{"read": "topic", "topic": "$share/studio/plant/line1/temp"}'],
    ["a publish", '{"read": "publish", "topic": "plant/line1/temp", "payload": "1"}'],
    ["a will", '{"read": "window", "will": {"topic": "plant/line1/temp"}}'],
    ["a filter of the model's", '{"read": "window", "filter": "homes/#"}'],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const result = await mqtt(statement);
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
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_mqtt_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test("a timeout_ms too short for the window and its dial is refused in words before anything is acquired", async () => {
    const result = await mqtt('{"read": "window"}', { timeout_ms: 4_999 });
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => block.text).join("\n");
    expect(text).toContain("Input validation error");
    expect(text).toContain(
      "timeout_ms must be at least 5000 for run_mqtt_read: an MQTT read listens for a 3,000 ms window and needs 4,000 ms with its dial, after the connection's own handshake, and a window is never shortened, so nothing was sent.",
    );
    expect(acquireSpy()).not.toHaveBeenCalled();
  });

  test("the least timeout_ms is taken", async () => {
    const result = await mqtt('{"read": "window"}', { timeout_ms: 5_000 });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows[0]).toMatchObject({ stop_reason: "server-disconnect" });
  });

  test("a broker that refuses the login is answered in Studio's words, naming no credential", async () => {
    script = { connackCode: 0x87 };
    const result = await mqtt('{"read": "window"}');
    expect(result.isError).toBe(true);
    expectNoWithheld(result);
    expect(packetTypes()).toEqual([[1]]);
  });

  test("a provider not opened under the agent read-only profile refuses the read, and sends it nowhere", async () => {
    honourProfile = false;
    const result = await mqtt('{"read": "window"}');
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    // The editor handle's own connect read, and no session for the request.
    expect(broker.connections).toHaveLength(1);
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_mqtt_read", { connection_id: "seed:shop", statement: '{"read": "window"}' });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_mqtt_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on MQTT.",
        },
      ],
    });
    expect(acquireSpy()).not.toHaveBeenCalled();
  });
});

describe("the words a cut result would take", () => {
  test("say an MQTT read answers one row and is never paged", () => {
    expect(RUN_MQTT_READ_ARM.moreRows('{"read": "window"}', "mqtt", { maxRows: 1, shown: 1, cut: "max_rows" })).toBe(
      `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice('{"read": "window"}', "1")} To read one topic the request names in full, since an MQTT read answers one row and is never paged.`,
    );
    expect(
      RUN_MQTT_READ_ARM.moreRows('{"read": "window"}', "mqtt", { maxRows: 1, shown: 0, cut: "result_bytes" }),
    ).toBe(
      "More rows exist than the 32 KiB result limit holds, and 0 of them fitted; this tool does not page with offset. Read one topic the request names in full instead of the window to fit more rows, and to read one topic the request names in full, since an MQTT read answers one row and is never paged.",
    );
    expect(RUN_MQTT_READ_ARM.rowOverCap).toBe(
      "The one row of this read is larger than the 32 KiB result limit, which a count and a flag never are. Run the read again.",
    );
  });
});
