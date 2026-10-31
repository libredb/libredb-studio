/**
 * What an agent's Kafka read sends and answers (`agent-metadata-read.ts`): every read of the closed table pinned to the
 * exact calls it makes on the agent's client, its rows pinned whole, and every failure worded by its category, never
 * by the broker's words.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  KAFKA_AGENT_TOPIC_COLUMNS,
  KAFKA_METADATA_ONLY,
  kafkaAgentFailure,
  kafkaAgentResult,
  runKafkaAgentRead,
} from "@/lib/db/providers/stream/kafka/agent-metadata-read";
import type { KafkaAgentPlan } from "@/lib/db/providers/stream/kafka/agent-statement";
import {
  type KafkaAgentReadClient,
  type KafkaClusterMetadata,
  KafkaError,
  type KafkaErrorCategory,
  type KafkaOffsetPosition,
  type KafkaTopicMetadata,
} from "@/lib/db/providers/stream/kafka/client";
import { BYTE_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };
const B = (n: number) => BigInt(n);

/** A broker's address the answers carry and no agent answer may hold. */
const HOST = "broker-host.internal";
const PORT = 19_093;

function topic(name: string, partitions: number, replicas = [1, 2], isr = replicas, leader = 1): KafkaTopicMetadata {
  return {
    name,
    id: `id-${name}`,
    partitions: Array.from({ length: partitions }, (_v, partition) => ({
      partition,
      leader,
      leaderEpoch: 0,
      replicas,
      isr,
      offlineReplicas: [],
    })),
  };
}

const CLUSTER: KafkaClusterMetadata = {
  clusterId: "cluster-a",
  controllerId: 2,
  brokers: [
    { nodeId: 2, host: HOST, port: PORT, rack: null },
    { nodeId: 1, host: HOST, port: PORT, rack: "rack-a" },
    { nodeId: 3, host: HOST, port: PORT, rack: "rack-b" },
  ],
  topics: [],
};

type Call = readonly [string, ...unknown[]];

/** A recording agent client over fixed answers. */
function clientOver(
  answers: {
    names?: string[];
    topics?: KafkaTopicMetadata[];
    offsets?: Partial<Record<KafkaOffsetPosition, Map<number, bigint>>>;
  } = {},
) {
  const calls: Call[] = [];
  const client: KafkaAgentReadClient = {
    metadata: async (topics) => {
      calls.push(["metadata", topics]);
      if (topics === undefined || topics.length === 0) return CLUSTER;
      return { ...CLUSTER, topics: (answers.topics ?? []).filter((t) => topics.includes(t.name)) };
    },
    listTopics: async () => {
      calls.push(["listTopics"]);
      return answers.names ?? [];
    },
    offsets: async (name, at) => {
      calls.push(["offsets", name, at]);
      return answers.offsets?.[at] ?? new Map();
    },
  };
  return { client, calls };
}

const run = (client: KafkaAgentReadClient, plan: KafkaAgentPlan) => runKafkaAgentRead(client, plan, 1_000);

describe("the topic listing", () => {
  const names = ["audit", "orders", "payments"];
  const topics = [
    topic("audit", 1, [1]),
    topic("orders", 3, [1, 2, 3], [1, 2]),
    topic("payments", 2, [1, 2], [1, 2], -1),
  ];

  test("reads every name, then the page's topics, with Metadata alone, and answers counts", async () => {
    const { client, calls } = clientOver({ names, topics });
    const answer = await run(client, { op: "topics", limit: 50 });
    expect(calls).toEqual([["listTopics"], ["metadata", ["audit", "orders", "payments"]]]);
    const result = kafkaAgentResult(answer, BUDGET, "s", 4);
    expect(result).toEqual({
      fields: ["topic", "partitions", "replication_factor", "offline_partitions", "under_replicated_partitions"],
      rows: [
        { topic: "audit", partitions: 1, replication_factor: 1, offline_partitions: 0, under_replicated_partitions: 0 },
        {
          topic: "orders",
          partitions: 3,
          replication_factor: 3,
          offline_partitions: 0,
          under_replicated_partitions: 3,
        },
        {
          topic: "payments",
          partitions: 2,
          replication_factor: 2,
          offline_partitions: 2,
          under_replicated_partitions: 0,
        },
      ],
      rowCount: 3,
      executionTime: 4,
    });
  });

  test("a cursor and a limit page the names Studio already holds, and the answer says more follow without naming them", async () => {
    const { client, calls } = clientOver({ names, topics });
    const answer = await run(client, { op: "topics", after: "audit", limit: 1 });
    expect(calls).toEqual([["listTopics"], ["metadata", ["orders"]]]);
    const result = kafkaAgentResult(answer, BUDGET, "s", 0);
    expect(result.rows.map((row) => row.topic)).toEqual(["orders"]);
    expect(result.warnings).toEqual([
      { message: 'More topics follow this answer: read on with "after" set to the last topic of this answer.' },
    ]);
  });

  test("a cursor past the last name reads no Metadata of topics", async () => {
    const { client, calls } = clientOver({ names, topics });
    const answer = await run(client, { op: "topics", after: "zz", limit: 5 });
    expect(calls).toEqual([["listTopics"]]);
    expect(kafkaAgentResult(answer, BUDGET, "s", 0)).toEqual({
      fields: ["topic", "partitions", "replication_factor", "offline_partitions", "under_replicated_partitions"],
      rows: [],
      rowCount: 0,
      executionTime: 0,
    });
  });
});

describe("the broker listing", () => {
  test("names node ids, racks and the cluster id, never a host or a port", async () => {
    const { client, calls } = clientOver();
    const result = kafkaAgentResult(await run(client, { op: "brokers", limit: 50 }), BUDGET, "s", 0);
    expect(calls).toEqual([["metadata", []]]);
    expect(result.fields).toEqual(["node_id", "rack", "cluster_id"]);
    expect(result.rows).toEqual([
      { node_id: 1, rack: "rack-a", cluster_id: "cluster-a" },
      { node_id: 2, rack: null, cluster_id: "cluster-a" },
      { node_id: 3, rack: "rack-b", cluster_id: "cluster-a" },
    ]);
    expect(JSON.stringify(result)).not.toContain(HOST);
    expect(JSON.stringify(result)).not.toContain(String(PORT));
  });

  test("pages by node id, and a cluster id the broker did not give is null", async () => {
    const calls: Call[] = [];
    const client: KafkaAgentReadClient = {
      ...clientOver().client,
      metadata: async (topics) => {
        calls.push(["metadata", topics]);
        return { ...CLUSTER, clusterId: "" };
      },
    };
    const result = kafkaAgentResult(await run(client, { op: "brokers", after: 1, limit: 1 }), BUDGET, "s", 0);
    expect(result.rows).toEqual([{ node_id: 2, rack: null, cluster_id: null }]);
    expect(result.warnings?.[0]?.message).toStartWith("More brokers follow this answer");
  });
});

describe("one topic's partitions", () => {
  test("one Metadata request naming the topic; node ids as names, -1 as no leader", async () => {
    const offline: KafkaTopicMetadata = {
      name: "orders",
      id: "x",
      partitions: [
        { partition: 1, leader: -1, leaderEpoch: 3, replicas: [2, 3], isr: [], offlineReplicas: [2, 3] },
        { partition: 0, leader: 1, leaderEpoch: 0, replicas: [1, 2], isr: [1, 2], offlineReplicas: [] },
      ],
    };
    const { client, calls } = clientOver({ topics: [offline] });
    const result = kafkaAgentResult(
      await run(client, { op: "partitions", topic: "orders", limit: 50 }),
      BUDGET,
      "s",
      0,
    );
    expect(calls).toEqual([["metadata", ["orders"]]]);
    expect(result.fields).toEqual([
      "partition",
      "leader",
      "replicas",
      "in_sync_replicas",
      "offline_replicas",
      "offline",
    ]);
    expect(result.rows).toEqual([
      { partition: 0, leader: 1, replicas: "1,2", in_sync_replicas: "1,2", offline_replicas: null, offline: false },
      { partition: 1, leader: null, replicas: "2,3", in_sync_replicas: null, offline_replicas: "2,3", offline: true },
    ]);
  });

  test("pages by partition id", async () => {
    const { client } = clientOver({ topics: [topic("orders", 5)] });
    const result = kafkaAgentResult(
      await run(client, { op: "partitions", topic: "orders", after: 1, limit: 2 }),
      BUDGET,
      "s",
      0,
    );
    expect(result.rows.map((row) => row.partition)).toEqual([2, 3]);
    expect(result.warnings?.[0]?.message).toStartWith("More partitions follow this answer");
  });
});

describe("one topic's offsets", () => {
  const offsets = {
    earliest: new Map([
      [0, B(0)],
      [1, B(5)],
      [2, B(7)],
    ]),
    "high-watermark": new Map([
      [0, B(10)],
      [1, B(5)],
    ]),
  };

  test("Metadata, then ListOffsets at the earliest and at the latest sentinel, and nothing else", async () => {
    const { client, calls } = clientOver({ topics: [topic("orders", 3)], offsets });
    const result = kafkaAgentResult(await run(client, { op: "offsets", topic: "orders", limit: 50 }), BUDGET, "s", 0);
    expect(calls).toEqual([
      ["metadata", ["orders"]],
      ["offsets", "orders", "earliest"],
      ["offsets", "orders", "high-watermark"],
    ]);
    expect(result.fields).toEqual(["partition", "earliest_offset", "end_offset", "offset_span"]);
    // A side the broker did not answer is null, and so is the span, never 0.
    expect(result.rows).toEqual([
      { partition: 0, earliest_offset: 0, end_offset: 10, offset_span: 10 },
      { partition: 1, earliest_offset: 5, end_offset: 5, offset_span: 0 },
      { partition: 2, earliest_offset: 7, end_offset: null, offset_span: null },
    ]);
  });

  test("a cursor past the last partition sends no ListOffsets", async () => {
    const { client, calls } = clientOver({ topics: [topic("orders", 3)], offsets });
    const result = kafkaAgentResult(
      await run(client, { op: "offsets", topic: "orders", after: 2, limit: 50 }),
      BUDGET,
      "s",
      0,
    );
    expect(calls).toEqual([["metadata", ["orders"]]]);
    expect(result.rows).toEqual([]);
  });

  test("an offset no number holds exactly refuses the whole answer, naming the column and not the value", async () => {
    const huge = B(Number.MAX_SAFE_INTEGER) + B(2);
    const { client } = clientOver({
      topics: [topic("orders", 1)],
      offsets: { earliest: new Map([[0, B(0)]]), "high-watermark": new Map([[0, huge]]) },
    });
    const answer = await run(client, { op: "offsets", topic: "orders", limit: 50 });
    const error = (() => {
      try {
        kafkaAgentResult(answer, BUDGET, "s", 0);
      } catch (thrown) {
        return thrown;
      }
    })();
    const failure = kafkaAgentFailure(error, 1_000, "s");
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure?.message).toContain('"end_offset" is not a whole number from 0');
    expect(failure?.message).not.toContain(String(huge));
  });
});

describe("budgets and the deadline", () => {
  test("an answer past the byte budget is refused rather than cut", async () => {
    const { client } = clientOver({ names: ["a", "b"], topics: [topic("a", 1), topic("b", 1)] });
    const answer = await run(client, { op: "topics", limit: 50 });
    expect(() => kafkaAgentResult(answer, { ...BUDGET, maxResultBytes: 10 }, "s", 0)).toThrow(BYTE_BUDGET_PREFIX);
  });

  test("a read that outlives the deadline is the time budget's refusal", async () => {
    const client: KafkaAgentReadClient = {
      metadata: () => new Promise(() => undefined),
      listTopics: () => new Promise(() => undefined),
      offsets: () => new Promise(() => undefined),
    };
    const error = await runKafkaAgentRead(client, { op: "brokers", limit: 1 }, 5).catch((thrown: unknown) => thrown);
    expect(kafkaAgentFailure(error, 5, "s")?.message).toBe(`${TIME_BUDGET_PREFIX}: no answer within 5ms`);
  });

  test("a read that fails after the deadline won leaves no unhandled rejection", async () => {
    let fail: (error: Error) => void = () => undefined;
    const client: KafkaAgentReadClient = {
      ...clientOver().client,
      metadata: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    };
    const error = await runKafkaAgentRead(client, { op: "brokers", limit: 1 }, 1).catch((thrown: unknown) => thrown);
    fail(new KafkaError("network", "late"));
    await Bun.sleep(1);
    expect(kafkaAgentFailure(error, 1)?.message).toStartWith(TIME_BUDGET_PREFIX);
  });
});

describe("failures, worded by category alone", () => {
  const CATEGORIES = Object.keys({
    "invalid-request": true,
    "invalid-config": true,
    "unknown-topic": true,
    "unknown-object": true,
    "unreadable-topic": true,
    "offset-out-of-range": true,
    authorization: true,
    authentication: true,
    tls: true,
    network: true,
    "advertised-unreachable": true,
    timeout: true,
    "unsupported-broker": true,
    protocol: true,
  } satisfies Record<KafkaErrorCategory, true>) as KafkaErrorCategory[];

  test.each(CATEGORIES)("%s never passes on the broker's words or an address", (category) => {
    const error = new KafkaError(category, `The broker advertised ${HOST}:${PORT} and said: secret broker text`, {
      host: HOST,
      port: PORT,
    });
    const failure = kafkaAgentFailure(error, 2_500, "stmt");
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure?.provider).toBe("kafka");
    expect(failure?.query).toBe("stmt");
    expect(failure?.message).not.toContain(HOST);
    expect(failure?.message).not.toContain(String(PORT));
    expect(failure?.message).not.toContain("secret");
    if (category === "timeout") expect(failure?.message).toBe(`${TIME_BUDGET_PREFIX}: no answer within 2500ms`);
    else expect(failure?.message).toEndWith("since they can name a broker's address.");
  });

  test("a missing topic says nothing was created", () => {
    expect(kafkaAgentFailure(new KafkaError("unknown-topic", "x"), 1)?.message).toStartWith(
      "The topic does not exist. Nothing was created: an agent read asks the broker never to create a topic.",
    );
  });

  test("a defect of ours passes on as itself", () => {
    expect(kafkaAgentFailure(new TypeError("defect"), 1)).toBeUndefined();
  });
});

describe("the declarations", () => {
  test("metadataOnly states every read's columns and kinds", () => {
    expect(KAFKA_METADATA_ONLY).toEqual({
      topics: [
        { column: "topic", kind: "name" },
        { column: "partitions", kind: "count" },
        { column: "replication_factor", kind: "count" },
        { column: "offline_partitions", kind: "count" },
        { column: "under_replicated_partitions", kind: "count" },
      ],
      brokers: [
        { column: "node_id", kind: "count" },
        { column: "rack", kind: "name" },
        { column: "cluster_id", kind: "name" },
      ],
      partitions: [
        { column: "partition", kind: "count" },
        { column: "leader", kind: "count" },
        { column: "replicas", kind: "name" },
        { column: "in_sync_replicas", kind: "name" },
        { column: "offline_replicas", kind: "name" },
        { column: "offline", kind: "flag" },
      ],
      offsets: [
        { column: "partition", kind: "count" },
        { column: "earliest_offset", kind: "count" },
        { column: "end_offset", kind: "count" },
        { column: "offset_span", kind: "count" },
      ],
    });
  });

  test("an agent-mode topic is described by the offset read's columns, never a record cell", () => {
    expect(KAFKA_AGENT_TOPIC_COLUMNS).toEqual([
      { name: "partition", type: "integer", nullable: false, isPrimary: false },
      { name: "earliest_offset", type: "integer", nullable: true, isPrimary: false },
      { name: "end_offset", type: "integer", nullable: true, isPrimary: false },
      { name: "offset_span", type: "integer", nullable: true, isPrimary: false },
    ]);
  });
});
