/**
 * KafkaProvider under the agent profiles: `queryReadOnly` only on a handle the agent read-only profile opened, every
 * request outside the closed table refused before anything is sent, and on a handle of either agent profile every
 * surface read through the agent's client, which holds the Metadata and ListOffsets reads alone. The fake client
 * throws on every other member, so a surface that reached a Fetch, a timestamp lookup, a group, config or
 * log-directory read would fail here, and every answer is searched for the broker's host and port.
 */
// oxlint-disable no-await-in-loop -- each surface runs after the one before, so each refusal and each recorded call is its own.
import { describe, expect, test } from "bun:test";
import { ConnectionError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import { KAFKA_AGENT_SHAPE, KAFKA_AGENT_WITHHELD } from "@/lib/db/providers/stream/kafka/agent-surface";
import { KAFKA_AGENT_SENTENCES } from "@/lib/db/providers/stream/kafka/agent-statement";
import {
  type KafkaClusterMetadata,
  KafkaError,
  type KafkaReadClient,
  type KafkaTopicMetadata,
} from "@/lib/db/providers/stream/kafka/client";
import { KAFKA_TOPIC_COLUMNS } from "@/lib/db/providers/stream/kafka/objects";
import { ROW_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const CONNECTION = {
  id: "k1",
  name: "kafka",
  type: "kafka",
  host: "localhost",
  createdAt: new Date(0),
} as unknown as DatabaseConnection;

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };

const HOST = "advertised-broker.internal";
const PORT = 29_093;

const ORDERS: KafkaTopicMetadata = {
  name: "orders",
  id: "id-orders",
  partitions: [{ partition: 0, leader: 1, leaderEpoch: 0, replicas: [1], isr: [1], offlineReplicas: [] }],
};

const CLUSTER: KafkaClusterMetadata = {
  clusterId: "cluster-a",
  controllerId: 1,
  brokers: [{ nodeId: 1, host: HOST, port: PORT, rack: null }],
  topics: [],
};

/** Every member off the agent path throws, so reaching one fails the test that reached it. */
function fakeClient(fail?: () => Error) {
  const calls: string[] = [];
  const off = (name: string) => async () => {
    throw new Error(`${name} is not on the agent path`);
  };
  const client: KafkaReadClient = {
    metadata: async (topics) => {
      calls.push(`metadata ${JSON.stringify(topics ?? null)}`);
      if (fail !== undefined && calls.length > 1) throw fail();
      return topics === undefined || topics.length === 0 ? CLUSTER : { ...CLUSTER, topics: [ORDERS] };
    },
    listTopics: async () => {
      calls.push("listTopics");
      return ["orders"];
    },
    offsets: async (topic, at) => {
      calls.push(`offsets ${topic} ${at}`);
      return new Map([[0, at === "earliest" ? BigInt(3) : BigInt(9)]]);
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
  return { client, calls };
}

async function connected(execution: ProviderExecutionContext, fail?: () => Error) {
  const fake = fakeClient(fail);
  const provider = new KafkaProvider(CONNECTION, { queryTimeout: 4_000 }, execution, async () => fake.client);
  await provider.connect();
  // connect()'s own forced broker read is left behind.
  fake.calls.length = 0;
  return { provider, calls: fake.calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (answer) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
    },
    (error: unknown) => error,
  );
}

describe("who may call queryReadOnly", () => {
  test("an editor handle is refused, and nothing is sent", async () => {
    const { provider, calls } = await connected({});
    const error = await rejection(provider.queryReadOnly('{"read": "topics"}', BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toBe(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(calls).toEqual([]);
  });

  test("an operations handle, which sends no statement, is refused too", async () => {
    const { provider, calls } = await connected(OPERATIONS);
    expect(await rejection(provider.queryReadOnly('{"read": "topics"}', BUDGET))).toBeInstanceOf(
      RefusedBeforeSendError,
    );
    expect(calls).toEqual([]);
  });

  test("an unconnected handle is refused before anything", async () => {
    const provider = new KafkaProvider(CONNECTION, {}, READ_ONLY, async () => fakeClient().client);
    expect(((await rejection(provider.queryReadOnly('{"read": "topics"}', BUDGET))) as Error).message).toContain(
      "not connected",
    );
  });

  test("an estimate and a budget the shared check refuses are refused before anything is sent", async () => {
    const { provider, calls } = await connected(READ_ONLY);
    expect(
      ((await rejection(provider.queryReadOnly('{"read": "topics"}', BUDGET, "estimate-plan"))) as Error).message,
    ).toBe("Kafka composes no estimating plan for the agent");
    expect(
      await rejection(provider.queryReadOnly('{"read": "topics"}', { ...BUDGET, maxResultRows: 0 })),
    ).toBeInstanceOf(Error);
    expect(calls).toEqual([]);
  });
});

describe("refused before anything is sent", () => {
  test("a request outside the closed table, with the reader's own sentence", async () => {
    const { provider, calls } = await connected(READ_ONLY);
    for (const [text, sentence] of [
      ['{"read": "fetch", "topic": "orders"}', KAFKA_AGENT_SENTENCES.notARead],
      ['{"read": "offsets", "topic": "orders", "timestamp": 1}', KAFKA_AGENT_SENTENCES.keys],
      ['{"read": "partitions", "topic": "__consumer_offsets"}', KAFKA_AGENT_SENTENCES.internal],
    ] as const) {
      const error = await rejection(provider.queryReadOnly(text, BUDGET));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect((error as Error).message).toBe(sentence);
    }
    expect(calls).toEqual([]);
  });

  test("a limit past the row budget is refused, never cut", async () => {
    const { provider, calls } = await connected(READ_ONLY);
    const error = await rejection(provider.queryReadOnly('{"read": "topics", "limit": 201}', BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toStartWith(ROW_BUDGET_PREFIX);
    expect(calls).toEqual([]);
  });
});

describe("an admitted read", () => {
  test("sends the closed table's calls alone and answers the projection", async () => {
    const { provider, calls } = await connected(READ_ONLY);
    const result = await provider.queryReadOnly('{"read": "offsets", "topic": "orders"}', BUDGET);
    expect(calls).toEqual(['metadata ["orders"]', "offsets orders earliest", "offsets orders high-watermark"]);
    expect(result.rows).toEqual([{ partition: 0, earliest_offset: 3, end_offset: 9, offset_span: 6 }]);
  });

  test("a broker read names no host or port", async () => {
    const { provider } = await connected(READ_ONLY);
    const result = await provider.queryReadOnly('{"read": "brokers"}', BUDGET);
    expect(result.rows).toEqual([{ node_id: 1, rack: null, cluster_id: "cluster-a" }]);
    expect(JSON.stringify(result)).not.toContain(HOST);
  });

  test("a failure is worded by its category, never with the advertised address", async () => {
    const { provider } = await connected(READ_ONLY, () => new KafkaError("advertised-unreachable", `${HOST}:${PORT}`));
    await provider.queryReadOnly('{"read": "brokers"}', BUDGET);
    const error = await rejection(provider.queryReadOnly('{"read": "brokers"}', BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toStartWith("The broker could not be reached for the read.");
    expect((error as Error).message).not.toContain(HOST);
  });

  test("a defect of ours surfaces as itself", async () => {
    const { provider } = await connected(READ_ONLY, () => new TypeError("defect"));
    await provider.queryReadOnly('{"read": "brokers"}', BUDGET);
    expect(await rejection(provider.queryReadOnly('{"read": "brokers"}', BUDGET))).toBeInstanceOf(TypeError);
  });
});

describe("every surface of an agent-mode handle", () => {
  test.each([
    ["read-only", READ_ONLY],
    ["operations", OPERATIONS],
  ] as const)("on the %s profile reads Metadata alone and names no address", async (_label, execution) => {
    const { provider, calls } = await connected(execution);
    const counts = await provider.countObjects([]);
    expect(counts).toEqual({
      topic: { count: 1 },
      consumer_group: { unavailable: KAFKA_AGENT_WITHHELD.groups },
      broker: { count: 1 },
    });
    expect(Object.keys(counts)).toEqual(["topic", "consumer_group", "broker"]);
    expect(await provider.listObjects([], "topic")).toEqual([{ path: ["orders"], name: "orders", kind: "topic" }]);
    expect(await provider.listObjects([], "broker")).toEqual([{ path: ["1"], name: "1", kind: "broker" }]);
    expect((await provider.describeObject(["orders"], "topic")).columns.map((c) => c.name)).toEqual([
      "partition",
      "earliest_offset",
      "end_offset",
      "offset_span",
    ]);
    const batch = await provider.describeObjects([], "topic");
    expect(batch.details[0]?.columns.map((c) => c.name)).not.toContain("value");
    expect(await provider.getHealth()).toEqual({
      databaseSize: KAFKA_AGENT_WITHHELD.logDirs,
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(calls.every((call) => call.startsWith("metadata") || call === "listTopics")).toBe(true);
    expect(JSON.stringify({ counts })).not.toContain(HOST);
  });

  test("a topic count past the listing cap says it is a floor", async () => {
    const fake = fakeClient();
    const many = Array.from({ length: 2001 }, (_v, i) => `t${String(i).padStart(4, "0")}`);
    fake.client.listTopics = async () => many;
    const provider = new KafkaProvider(CONNECTION, {}, OPERATIONS, async () => fake.client);
    await provider.connect();
    expect((await provider.countObjects([])).topic).toEqual({
      count: 2000,
      sampledFrom: "one topic listing capped at 2,000 names",
    });
  });

  test("what needs a withheld read answers its reason, never an empty answer or a zero", async () => {
    const { provider, calls } = await connected(OPERATIONS);
    const withheld: [Promise<unknown>, string][] = [
      [provider.listObjects([], "consumer_group"), KAFKA_AGENT_WITHHELD.groups],
      [provider.readObjectSource(["orders"], "topic"), KAFKA_AGENT_WITHHELD.source],
      [provider.getOverview(), KAFKA_AGENT_WITHHELD.overview],
      [provider.getStorageStats(), KAFKA_AGENT_WITHHELD.storage],
      [provider.getSlowQueries(), KAFKA_AGENT_WITHHELD.slowQueries],
      [provider.getActiveSessions(), KAFKA_AGENT_WITHHELD.sessions],
      [provider.getTableStats(), KAFKA_AGENT_WITHHELD.tableStats],
      [provider.getIndexStats(), KAFKA_AGENT_WITHHELD.indexStats],
    ];
    for (const [promise, sentence] of withheld) {
      const error = await rejection(promise);
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toBe(sentence);
    }
    expect(calls).toEqual([]);
  });

  test("the editor's read is refused before anything is sent, on either profile", async () => {
    for (const execution of [READ_ONLY, OPERATIONS]) {
      const { provider, calls } = await connected(execution);
      const error = await rejection(provider.query('{"topic": "orders"}'));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect((error as Error).message).toBe(KAFKA_AGENT_WITHHELD.query);
      expect(calls).toEqual([]);
    }
  });

  test("a kind the provider does not declare is refused", async () => {
    const { provider } = await connected(OPERATIONS);
    expect(((await rejection(provider.listObjects([], "acl"))) as Error).message).toBe(
      'Kafka declares no object kind "acl"',
    );
    expect(await rejection(provider.listObjects(["x"], "topic"))).toBeInstanceOf(Error);
  });

  test("Studio's own refusal of a container or kind is its own sentence, and nothing is sent", async () => {
    for (const execution of [READ_ONLY, OPERATIONS]) {
      const { provider, calls } = await connected(execution);
      for (const [promise, sentence] of [
        [provider.describeObject(["orders"], "bogus"), KAFKA_AGENT_SHAPE.kind("bogus")],
        [provider.listObjects(["x"], "topic"), KAFKA_AGENT_SHAPE.container],
        [provider.countObjects(["x"]), KAFKA_AGENT_SHAPE.container],
        [provider.describeObjects(["x"], "topic"), KAFKA_AGENT_SHAPE.container],
      ] as const) {
        const error = await rejection(promise);
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toBe(sentence);
      }
      expect(KAFKA_AGENT_SHAPE.kind("bogus")).toBe('Kafka declares no object kind "bogus"');
      expect(KAFKA_AGENT_SHAPE.container).not.toContain("broker's answer");
      expect(calls).toEqual([]);
    }
  });

  test("a surface failure is worded by its category", async () => {
    const { provider } = await connected(OPERATIONS, () => new KafkaError("network", `${HOST}:${PORT} refused`));
    await provider.getHealth();
    const error = await rejection(provider.getHealth());
    expect((error as Error).message).not.toContain(HOST);
    expect((error as Error).message).toStartWith("The broker could not be reached");
  });

  test("an editor handle keeps the editor's columns and its withheld surfaces", async () => {
    const { provider } = await connected({});
    expect((await provider.describeObject(["orders"], "topic")).columns).toEqual(KAFKA_TOPIC_COLUMNS);
    expect(await provider.getSlowQueries()).toEqual([]);
  });

  test("the capability states the reads' columns, and the group kind's count is its listing", () => {
    const capabilities = new KafkaProvider(CONNECTION).getCapabilities();
    expect(Object.keys(capabilities.metadataOnly ?? {})).toEqual(["topics", "brokers", "partitions", "offsets"]);
    expect(capabilities.objectKinds?.find((kind) => kind.id === "consumer_group")?.countIsListing).toBe(true);
  });
});
