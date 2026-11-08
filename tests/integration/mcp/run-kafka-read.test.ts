/**
 * run_kafka_read: MCP's kafkaread arm, run by the statement core over the real Kafka provider, through the real route,
 * seed file and handler, with a fake client in place of a broker.
 *
 * The provider is the one the factory would hand out, built here only so its client is the fake one: the agent
 * read-only profile opens it under `readOnly` and `sendsStatements`, which `queryReadOnly` refuses without, and every
 * other profile does not. The fake client throws on every member off the agent's path, so a read that reached a Fetch,
 * a timestamp lookup, a group, config or log-directory read would fail here. The request is the agent's own, read and
 * admitted by the agent's own Kafka adapter: a read answers the metadata projection behind the untrusted-content
 * notice, so a record cell and a broker's host and port never reach the client, and a platform's own topics are not
 * listed; a request outside the closed table is refused before anything is acquired; a provider not opened under the
 * profile refuses; a result cut to max_rows says how to read on with "after", since the tool takes no offset; and a
 * read past timeout_ms is answered as the timeout.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import type { KafkaClusterMetadata, KafkaReadClient, KafkaTopicMetadata } from "@/lib/db/providers/stream/kafka/client";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-kafka-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("kafkaread");
const RUN_KAFKA_READ_ARM = mcpStatementArm("run_kafka_read");
const HOST = "advertised-broker.internal";
const PORT = 29_093;
/** A seed is plain data; this one names a broker the fake client stands in for. */
const CLUSTER_SEED = { id: "cluster", type: "kafka", host: "broker.example", port: 9092 };

const topic = (name: string): KafkaTopicMetadata => ({
  name,
  id: `id-${name}`,
  partitions: [0, 1].map((partition) => ({
    partition,
    leader: 1,
    leaderEpoch: 0,
    replicas: [1],
    isr: [1],
    offlineReplicas: [],
  })),
});

/** Ordinary topics and a platform's own: Schema Registry's, Confluent's and Kafka Connect's. */
const TOPIC_NAMES = ["_confluent-metrics", "_schemas", "audit", "connect-configs", "orders", "payments"];

function fakeClient() {
  const calls: string[] = [];
  let hang = false;
  const off = (name: string) => async () => {
    throw new Error(`${name} is not on the agent path`);
  };
  const cluster = (topics: readonly string[] | undefined): KafkaClusterMetadata => ({
    clusterId: "cluster-a",
    controllerId: 1,
    brokers: [{ nodeId: 1, host: HOST, port: PORT, rack: "rack-a" }],
    topics: (topics ?? []).map(topic),
  });
  const client: KafkaReadClient = {
    metadata: async (topics) => {
      calls.push(`metadata ${JSON.stringify(topics ?? null)}`);
      return cluster(topics);
    },
    listTopics: async () => {
      calls.push("listTopics");
      if (hang) await new Promise<never>(() => {});
      return TOPIC_NAMES;
    },
    offsets: async (name, at) => {
      calls.push(`offsets ${name} ${at}`);
      return new Map([
        [0, at === "earliest" ? BigInt(3) : BigInt(9)],
        [1, at === "earliest" ? BigInt(0) : BigInt(4)],
      ]);
    },
    offsetsForTimestamp: off("offsetsForTimestamp"),
    fetch: off("fetch"),
    topicConfigs: off("topicConfigs"),
    brokerConfigs: off("brokerConfigs"),
    listGroups: off("listGroups"),
    describeGroup: off("describeGroup"),
    committedOffsets: off("committedOffsets"),
    logDirs: off("logDirs"),
    close: async () => undefined,
  };
  return {
    client,
    calls,
    hang: () => {
      hang = true;
    },
  };
}

let fake = fakeClient();
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

beforeEach(() => {
  fake = fakeClient();
  honourProfile = true;
  writeSeedFile(dir, [CLUSTER_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  // The factory's provider, with only its client replaced: opened to send statements for agent-read-only alone.
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(
    async (connection: ManagedConnection, profile: ExecutionProfile) => {
      const agent = honourProfile && profile === "agent-read-only";
      const provider = new KafkaProvider(
        connection as DatabaseConnection,
        { queryTimeout: 30_000 },
        agent ? { readOnly: true, sendsStatements: true } : {},
        async () => fake.client,
      );
      await provider.connect();
      // connect()'s own forced broker read is left behind.
      fake.calls.length = 0;
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

const kafka = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_kafka_read", { connection_id: "seed:cluster", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

describe("the tool", () => {
  test("is listed, read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain("run_kafka_read");
      const tool = tools.find((candidate) => candidate.name === "run_kafka_read");
      expect(tool?.description).toBe(RUN_KAFKA_READ_ARM.description);
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

  test("describes Apache Kafka as the engine it runs on", () => {
    expect(RUN_KAFKA_READ_ARM.engines).toBe("Apache Kafka");
  });

  test("list_connections names it as the Kafka connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:cluster", "run_kafka_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("the topic listing answers names and counts behind the notice, a platform's own topics withheld", async () => {
    const result = await kafka('{"read": "topics"}');
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:cluster",
      row_count: 3,
      truncated: false,
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    expect(result.structuredContent?.rows?.map((row) => row.topic)).toEqual(["audit", "orders", "payments"]);
    // Only the listed page's topics are named to the broker, and no platform topic is among them.
    expect(fake.calls).toEqual(["listTopics", 'metadata ["audit","orders","payments"]']);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_kafka_read", "mcp/decision", "success"],
      ["run_kafka_read", "mcp/execution", "success"],
    ]);
  });

  test("the broker listing names node ids and racks, never a broker's host or port", async () => {
    const result = await kafka('{"read": "brokers"}');
    expect(result.structuredContent?.rows).toEqual([{ node_id: 1, rack: "rack-a", cluster_id: "cluster-a" }]);
    const text = JSON.stringify(result);
    expect(text).not.toContain(HOST);
    expect(text).not.toContain(String(PORT));
  });

  test("a topic's offsets are its partitions' earliest and end offsets, through Metadata and ListOffsets alone", async () => {
    const result = await kafka('{"read": "offsets", "topic": "orders"}');
    expect(result.structuredContent?.rows).toEqual([
      { partition: 0, earliest_offset: 3, end_offset: 9, offset_span: 6 },
      { partition: 1, earliest_offset: 0, end_offset: 4, offset_span: 4 },
    ]);
    expect(fake.calls).toEqual(['metadata ["orders"]', "offsets orders earliest", "offsets orders high-watermark"]);
  });

  test("a read past max_rows is cut to it, and the hint reads on with after rather than an offset", async () => {
    const statement = '{"read": "topics"}';
    const result = await kafka(statement, { max_rows: 2 });
    expect(result.structuredContent).toMatchObject({
      row_count: 2,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 2, hasMore: true, nextOffset: null, wasLimited: false },
      hint: RUN_KAFKA_READ_ARM.moreRows(statement, "kafka", { maxRows: 2, shown: 2, cut: "max_rows" }),
    });
    expect(result.structuredContent?.hint).toContain('"after"');
  });

  test("a request's own limit pages with after, as the description says, since a full page carries no warning", async () => {
    const first = await kafka('{"read": "topics", "limit": 1}');
    expect(first.structuredContent?.rows).toEqual([expect.objectContaining({ topic: "audit" })]);
    expect(first.structuredContent).toMatchObject({ truncated: false, hint: null });
    const next = await kafka('{"read": "topics", "limit": 1, "after": "audit"}');
    expect(next.structuredContent?.rows).toEqual([expect.objectContaining({ topic: "orders" })]);
    expect(RUN_KAFKA_READ_ARM.description).toContain(
      'an answer that holds as many rows as its "limit" may have more after it, so read on with "after" until an answer holds fewer',
    );
  });

  test("a read past timeout_ms is answered as the timeout, and the broker is not waited for", async () => {
    fake.hang();
    const result = await kafka('{"read": "topics"}', { timeout_ms: 500 });
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain("500 ms");
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", result: "failure" });
  });
});

describe("a refusal", () => {
  test.each([
    ["the editor's record read", '{"topic": "orders", "from": "latest"}'],
    ["a fetch", '{"read": "fetch", "topic": "orders"}'],
    ["a timestamp lookup", '{"read": "offsets", "topic": "orders", "timestamp": "2026-01-01T00:00:00Z"}'],
    ["an internal topic", '{"read": "offsets", "topic": "__consumer_offsets"}'],
    ["a platform's own topic", '{"read": "partitions", "topic": "connect-configs"}'],
    ["a key written twice", '{"read": "topics", "read": "brokers"}'],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await kafka(statement);
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
    expect(acquire).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_kafka_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test("a provider not opened under the agent read-only profile refuses the read, and nothing is sent", async () => {
    honourProfile = false;
    const result = await kafka('{"read": "topics"}');
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(fake.calls).toEqual([]);
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_kafka_read", { connection_id: "seed:shop", statement: '{"read": "topics"}' });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_kafka_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on Apache Kafka.",
        },
      ],
    });
  });

  test("run_read_query refuses a Kafka connection, naming run_kafka_read", async () => {
    const result = await call("run_read_query", { connection_id: "seed:cluster", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve Apache Kafka; use run_kafka_read there");
    expect(fake.calls).toEqual([]);
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "shop" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const result = await kafka('{"read": "topics"}', extra);
    expect(result.isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});
