/**
 * Apache Kafka provider, end to end (issue #1088)
 *
 * The real adapter, the real read loop, the real object surface, the real monitoring mappings and
 * the real error table all run; only the broker is fake. The fake is the recorded library of
 * tests/helpers/kafka-fixtures.ts, injected through the provider constructor's createClient
 * parameter, so every call the provider's composition makes reaches `@platformatic/kafka`'s shape
 * and is answered from what that library answered against a live broker. mock.module() is
 * deliberately not used: it is process-wide in bun and would poison sibling test files.
 *
 * Every payload was captured from `apache/kafka:4.3.1`
 * (`apache/kafka@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837`),
 * cluster `4L6g3nShT-eMCtK--X86sw`, seeded by `docker/kafka/seed.sh` and
 * `docker/kafka/seed-binary.ts`; each fixture's `$captured` key holds its image, cluster id,
 * capture date and the call it answers, and `tests/fixtures/kafka/README.md` lists them.
 *
 * Five answers are BUILT from a capture rather than read from one, and each says so where it is
 * built: topic configs for a topic other than `orders`, broker configs for a broker other than 1,
 * and the description of a classic group other than `lag-classic`, which answer the one captured
 * shape under the name asked; the transactional topic's fetch, which gets back the aborted batch
 * the client's own filter dropped from the capture; and every answer a test states inline, such as
 * a broker list, a slow fetch or a record past the result budget. One capture answers a wider
 * request than the one it was taken for: the log-dir capture named `orders` alone, so the
 * provider's request, which names every listed topic, gets orders' 5,503 bytes on broker 1's one
 * log dir, and every size below is that one topic's, not the seeded cluster's. The four transport
 * and authorization failures are captures.
 *
 * A section number below, "spec 5.1" for example, is a section of #1088's design.
 */
import { describe, expect, spyOn, test } from "bun:test";
import net from "node:net";
import { flattenTree } from "@/components/object-tree/flatten";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import { containerDepth, declaredKinds } from "@/lib/db/object-kinds";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import { KAFKA_CONTAINER_LEVELS, KAFKA_OBJECT_KINDS } from "@/lib/db/providers/stream/kafka/objects";
import { createPlatformaticClient, loadPlatformatic } from "@/lib/db/providers/stream/kafka/platformatic-client";
import { KAFKA_CELL_LIMIT, KAFKA_RESULT_BYTE_BUDGET } from "@/lib/db/providers/stream/kafka/read";
import { parseReadRequest } from "@/lib/db/providers/stream/kafka/request";
import { KAFKA_RESULT_FIELDS } from "@/lib/db/providers/stream/kafka/results";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection } from "@/lib/types";
import { kafkaFixture, recordedLib } from "../../helpers/kafka-fixtures";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

type Answer = (...args: unknown[]) => unknown;
type LibBroker = { host: string; port: number; rack: string | null };
type LibMetadata = {
  id: string;
  controllerId: number;
  topics: Map<string, { id: string; partitions: unknown[] }>;
  brokers: Map<number, LibBroker>;
};
type LibRecord = {
  offsetDelta: number;
  timestampDelta: bigint;
  key: Uint8Array | null;
  value: Uint8Array | null;
  headers: Array<[Uint8Array | null, Uint8Array | null]>;
};
type LibBatch = {
  firstOffset: bigint;
  lastOffsetDelta: number;
  firstTimestamp: bigint;
  maxTimestamp: bigint;
  attributes: number;
  producerId: bigint;
  records: LibRecord[];
};
type LibFetchAnswer = { responses: Array<{ topicId: string; partitions: Array<{ records: LibBatch[] }> }> };
type LibConfigResource = { resourceType: number; resourceName: string; configs: unknown[] };
type CommittedAnswer = Array<{
  groupId: string;
  topics: Array<{ name: string; partitions: Array<{ partitionIndex: number; committedOffset: bigint }> }>;
}>;

const ALL = kafkaFixture<LibMetadata>("metadata-all");
const TOPIC_BY_ID = new Map([...ALL.topics].map(([name, topic]) => [topic.id, name]));
/** ConfigResourceTypes.BROKER in the protocol. */
const BROKER_RESOURCE = 4;

/** A captured failure as the library threw it: an Error carrying the capture's code, errors and cause. */
const libError = (fixture: string) => {
  const captured = kafkaFixture<Record<string, unknown>>(fixture);
  return Object.assign(new Error(String(captured.message)), captured);
};
/** The first argument of every recorded call of one library method. */
const argsOf = (calls: Array<[string, unknown[]]>, name: string) =>
  calls.filter(([called]) => called === name).map(([, args]) => args[0]);
const closesOf = (calls: Array<[string, unknown[]]>) =>
  calls
    .map(([name]) => name)
    .filter((name) => name.endsWith(".close"))
    .sort();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The captured cluster, cut to the topics a Metadata request names; a name the cluster lacks fails as the library fails (M-B). */
function metadataFor(request: unknown): LibMetadata {
  const wanted = (request as { topics: string[] }).topics;
  if (wanted.some((name) => !ALL.topics.has(name))) throw libError("error-unknown-topic");
  return { ...ALL, topics: new Map([...ALL.topics].filter(([name]) => wanted.includes(name))) };
}

/** The captured ListOffsets answer for the topic asked, at the earliest (-2) or latest (-1) sentinel. */
function offsetsFor(request: unknown) {
  const { topics, timestamp } = request as { topics: string[]; timestamp: bigint };
  const at = timestamp === BigInt(-2) ? "earliest" : "latest";
  return kafkaFixture(topics[0] === "orders" ? `offsets-${at}` : `offsets-${at}-${topics[0]}`);
}

/**
 * The transactional topic's fetch, as the broker sends it to a READ_COMMITTED fetch. The capture was
 * taken through the client's Consumer.fetch, whose own filter dropped the aborted transaction's batch,
 * so that batch is put back here at offsets 3 and 4, from producer 9, which the answer already lists
 * as aborted from offset 3; the COMMIT marker is at 2 and the ABORT marker at 5 (spec 5.2).
 */
function txnAnswer(): LibFetchAnswer {
  const answer = kafkaFixture<LibFetchAnswer>("fetch-txn");
  const batches = answer.responses[0].partitions[0].records;
  const aborted = structuredClone(batches[0]);
  aborted.firstOffset = BigInt(3);
  aborted.records.forEach((record, index) => {
    record.value = Buffer.from(JSON.stringify({ txn: "aborted", n: 3 + index }));
  });
  batches.splice(2, 0, aborted);
  return answer;
}

/** Which captured fetch answers a fetch, by the topic id, partition and offset the adapter sent. */
function fetchAnswerFor(topics: unknown): unknown {
  const [asked] = topics as Array<{ topicId: string; partitions: Array<{ partition: number; fetchOffset: bigint }> }>;
  const name = TOPIC_BY_ID.get(asked.topicId);
  const { partition, fetchOffset } = asked.partitions[0];
  if (name === "orders" && partition === 1 && fetchOffset === BigInt(5)) return kafkaFixture("fetch-orders-p1-o5");
  if (name === "txn") return txnAnswer();
  return kafkaFixture(`fetch-${name}`);
}

function brokerLib(overrides: Record<string, Answer> = {}) {
  return recordedLib({
    "admin.metadata": metadataFor,
    // Topic orders and broker 1 were captured. Any other topic answers orders' captured configs, and
    // any other broker broker 1's, under its own name: the shape a broker answers for any resource.
    "admin.describeConfigs": (request) => {
      const [resource] = (request as { resources: Array<{ resourceType: number; resourceName: string }> }).resources;
      const captured = resource.resourceType === BROKER_RESOURCE ? "configs-broker-1" : "configs-topic-orders";
      const answer = kafkaFixture<LibConfigResource[]>(captured);
      for (const entry of answer) entry.resourceName = resource.resourceName;
      return answer;
    },
    // The capture of a request that named orders alone, whatever the request names: every size these
    // tests read is orders' 5,503 bytes on broker 1's one log dir, not the seeded cluster's.
    "admin.describeLogDirs": () => kafkaFixture("log-dirs"),
    // Only lag-classic's description was captured. lag-partial is also an Empty classic group with
    // no members (list-groups), so it answers the same shape under its own id.
    "admin.describeGroups": (request) => {
      const [group] = kafkaFixture<Map<string, Record<string, unknown>>>("describe-groups-classic").values();
      return new Map((request as { groups: string[] }).groups.map((id) => [id, { ...group, id }]));
    },
    "consumer.listOffsets": offsetsFor,
    // The library's positional arguments: the topics are at index 7.
    fetchV13: (...args) => fetchAnswerFor(args[7]),
    ...overrides,
  });
}

const CONNECTION = {
  id: "k1",
  name: "kafka",
  type: "kafka",
  host: "localhost",
  port: 9092,
  createdAt: new Date(),
} as unknown as DatabaseConnection;

async function connected(overrides: Record<string, Answer> = {}, queryTimeout?: number) {
  const recorded = brokerLib(overrides);
  const provider = new KafkaProvider(CONNECTION, queryTimeout === undefined ? {} : { queryTimeout }, async (options) =>
    createPlatformaticClient(options, recorded.lib),
  );
  await provider.connect();
  return { provider, recorded };
}

const lagRows = async (provider: KafkaProvider, group: string) => {
  const doc = await provider.readObjectSource([group], "consumer_group");
  return JSON.parse((doc.parts[1] as { text: string }).text) as Array<{
    topic: string;
    partition: number;
    committedOffset: string | null;
    lag: string | null;
    note?: string;
  }>;
};

/** Every surface of a provider, called as a caller would. */
const SURFACES: ReadonlyArray<readonly [string, (provider: KafkaProvider) => Promise<unknown>]> = [
  ["query", (p) => p.query('{"topic":"orders"}')],
  ["listContainers", (p) => p.listContainers()],
  ["countObjects", (p) => p.countObjects([])],
  ["listObjects", (p) => p.listObjects([], "topic")],
  ["describeObject", (p) => p.describeObject(["orders"], "topic")],
  ["describeObjects", (p) => p.describeObjects([], "topic")],
  ["readObjectSource", (p) => p.readObjectSource(["orders"], "topic")],
  ["getHealth", (p) => p.getHealth()],
  ["getOverview", (p) => p.getOverview()],
  ["getStorageStats", (p) => p.getStorageStats()],
  ["getPerformanceMetrics", (p) => p.getPerformanceMetrics()],
  ["getSlowQueries", (p) => p.getSlowQueries()],
  ["getActiveSessions", (p) => p.getActiveSessions()],
  ["getTableStats", (p) => p.getTableStats()],
  ["getIndexStats", (p) => p.getIndexStats()],
  ["runMaintenance", (p) => p.runMaintenance("vacuum")],
];

describe("connect and disconnect", () => {
  test("connect builds the client from the validated options and proves the broker answers with one forced metadata read", async () => {
    const { recorded } = await connected({}, 7_000);
    const [admin] = recorded.constructed.filter(([name]) => name === "Admin").map(([, options]) => options);
    expect(admin).toMatchObject({
      clientId: "libredb-studio",
      bootstrapBrokers: [{ host: "localhost", port: 9092 }],
      connectTimeout: 7_000,
      requestTimeout: 7_000,
    });
    expect(recorded.calls.map(([name]) => name)).toEqual(["admin.metadata"]);
    expect(argsOf(recorded.calls, "admin.metadata")).toEqual([
      { topics: [], autocreateTopics: false, forceUpdate: true },
    ]);
  });

  test("a connect the broker fails closes the client it built and reports the broker's failure", async () => {
    const recorded = brokerLib({
      "admin.metadata": () => {
        throw libError("error-connection-closed");
      },
    });
    const provider = new KafkaProvider(CONNECTION, {}, async (options) =>
      createPlatformaticClient(options, recorded.lib),
    );
    const error = await provider.connect().catch((e) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ provider: "kafka", host: "localhost", port: 9092 });
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
    expect(provider.isConnected()).toBe(false);
    await expect(provider.query('{"topic":"orders"}')).rejects.toThrow("Provider is not connected");
    // It holds no client afterwards, so a disconnect has nothing left to close (spec 3.6 K8).
    await provider.disconnect();
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
  });

  test("a connect the broker does not answer in time is a TimeoutError carrying the connection's query timeout", async () => {
    const recorded = brokerLib({
      "admin.metadata": () => {
        throw libError("error-request-timeout");
      },
    });
    const provider = new KafkaProvider(CONNECTION, { queryTimeout: 7_000 }, async (options) =>
      createPlatformaticClient(options, recorded.lib),
    );
    const error = await provider.connect().catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ provider: "kafka", timeout: 7_000 });
  });

  test("a close that fails after a failed connect is logged, never thrown over the connect's own failure", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const recorded = brokerLib({
        "admin.metadata": () => {
          throw libError("error-connection-closed");
        },
        "admin.close": () => {
          throw new Error("close refused");
        },
      });
      const provider = new KafkaProvider(CONNECTION, {}, async (options) =>
        createPlatformaticClient(options, recorded.lib),
      );
      const error = await provider.connect().catch((e) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect(logged.mock.calls.map((call) => String(call[0]))).toEqual([
        "[DB:kafka] connect cleanup failed: close refused",
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  test("K8: disconnect closes both clients and the fetch pool, and the provider then refuses every call", async () => {
    const { provider, recorded } = await connected();
    await provider.disconnect();
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
    expect(provider.isConnected()).toBe(false);
    const callsAfterClose = recorded.calls.length;
    await expect(provider.query('{"topic":"orders"}')).rejects.toThrow("Provider is not connected");
    expect(recorded.calls).toHaveLength(callsAfterClose);
    // A second disconnect has nothing left to close.
    await provider.disconnect();
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
  });

  test.each(SURFACES)("%s refuses before connect and after disconnect, and sends nothing", async (_name, call) => {
    const recorded = brokerLib();
    const provider = new KafkaProvider(CONNECTION, {}, async (options) =>
      createPlatformaticClient(options, recorded.lib),
    );
    const refusal = () =>
      call(provider).then(
        () => undefined,
        (error: Error) => error,
      );
    const before = await refusal();
    expect(before).toBeInstanceOf(DatabaseConfigError);
    expect(before?.message).toBe("Provider is not connected. Call connect() first.");
    expect(recorded.calls).toEqual([]);
    await provider.connect();
    await provider.disconnect();
    const sent = recorded.calls.length;
    const after = await refusal();
    expect(after).toBeInstanceOf(DatabaseConfigError);
    expect(after?.message).toBe("Provider is not connected. Call connect() first.");
    expect(recorded.calls).toHaveLength(sent);
  });

  test("K1: a host carrying :, /, @, % or whitespace, or a port outside 1 to 65535, is refused before any connection", async () => {
    let accepts = 0;
    const listener = net.createServer((socket) => {
      accepts++;
      socket.destroy();
    });
    // On ::1 because a zoned host (`::1%lo`) is the one refused form the real client would dial.
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "::1", resolve);
    });
    const port = (listener.address() as net.AddressInfo).port;
    let created = 0;
    try {
      const cases = [
        ...["a:1", "a/b", "u@a", "a b", "a%25b", "::1%lo"].map((host) => ({ host, port })),
        { host: "::1", port: 0 },
        { host: "::1", port: 65536 },
      ];
      const errors = await Promise.all(
        cases.map((bad) =>
          new KafkaProvider({ ...CONNECTION, ...bad } as DatabaseConnection, {}, async (options) => {
            created++;
            return createPlatformaticClient(options, await loadPlatformatic());
          })
            .connect()
            .catch((e) => e),
        ),
      );
      errors.forEach((error, index) => {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(error.provider).toBe("kafka");
        expect(error.message).not.toContain(cases[index].host);
      });
    } finally {
      listener.close();
    }
    expect(created).toBe(0);
    expect(accepts).toBe(0);
  });

  test("K3: SASL without TLS fails connect before any client exists, and the password is never printed", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      let created = 0;
      const provider = new KafkaProvider(
        { ...CONNECTION, saslMechanism: "PLAIN", user: "u", password: "hunter2" } as DatabaseConnection,
        {},
        async (options) => {
          created++;
          return createPlatformaticClient(options, brokerLib().lib);
        },
      );
      const error = await provider.connect().catch((e) => e);
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toContain("requires TLS");
      expect(error.message).not.toContain("hunter2");
      expect(created).toBe(0);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("hunter2");
    } finally {
      logged.mockRestore();
    }
  });

  test("an SSH tunnel is refused before any client exists (spec 6.1)", async () => {
    let created = 0;
    const provider = new KafkaProvider(
      { ...CONNECTION, sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u" } } as DatabaseConnection,
      {},
      async (options) => {
        created++;
        return createPlatformaticClient(options, brokerLib().lib);
      },
    );
    const error = await provider.connect().catch((e) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toContain("SSH tunnel");
    expect(created).toBe(0);
  });

  test("with no client factory, the provider loads the real library, and an unreachable broker is a ConnectionError", async () => {
    const provider = new KafkaProvider({ ...CONNECTION, host: "127.0.0.1", port: 1 } as DatabaseConnection, {
      queryTimeout: 2000,
    });
    const error = await provider.connect().catch((e) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ provider: "kafka", host: "127.0.0.1", port: 1 });
    expect(provider.isConnected()).toBe(false);
  }, 20_000);
});

describe("reads over captured payloads", () => {
  test("reads orders partition 1 from offset 5: JSON values, the repeated header as an array, and the rest marked unread", async () => {
    const { provider } = await connected();
    const result = await provider.query('{"topic":"orders","partition":1,"from":{"offset":5},"limit":2}');
    expect(result.fields).toEqual([...KAFKA_RESULT_FIELDS]);
    expect(result.rows.map((r) => [r.partition, r.offset])).toEqual([
      [1, "5"],
      [1, "6"],
    ]);
    expect(result.rows[0]).toMatchObject({
      key: "key-0",
      key_encoding: "text",
      value: { id: 25, country: "DE", note: "ü ö 日本" },
      value_encoding: "json",
      headers: { trace: ["t1", "u1"], h1: "v25" },
    });
    expect(result.rowCount).toBe(2);
    expect(result.pagination).toEqual({ limit: 2, offset: 0, hasMore: false, totalReturned: 2, wasLimited: true });
    expect(result.warnings).toBeUndefined();
  });

  test("a read the limit does not cut reads the whole partition, unlimited and with no warning, up to DEFAULT_QUERY_LIMIT", async () => {
    const { provider } = await connected();
    const result = await provider.query(`{"topic":"codec-gzip","from":"earliest","limit":${DEFAULT_QUERY_LIMIT}}`);
    expect(result.rows.map((r) => (r.value as { n: number }).n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(result.pagination).toEqual({
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
      hasMore: false,
      totalReturned: 20,
      wasLimited: false,
    });
    expect(result.warnings).toBeUndefined();
    const past = await provider.query(`{"topic":"codec-gzip","limit":${DEFAULT_QUERY_LIMIT + 1}}`).catch((e) => e);
    expect(past).toBeInstanceOf(DatabaseConfigError);
    expect(past.message).toBe(`"limit" must be a whole number from 1 to ${DEFAULT_QUERY_LIMIT}`);
  });

  test.each(["gzip", "snappy", "lz4", "zstd"])("reads the %s topic from its captured batch", async (codec) => {
    const { provider } = await connected();
    const result = await provider.query(`{"topic":"codec-${codec}","from":"earliest","limit":1}`);
    expect(result.rows.map((r) => r.value)).toEqual([{ n: 1, codec }]);
  });

  test("the 900 KB record is cut to the cell limit, with a warning naming the limit and wasLimited", async () => {
    const { provider } = await connected();
    const result = await provider.query('{"topic":"big","from":"earliest","limit":1}');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].value_encoding).toBe("text");
    expect((result.rows[0].value as string).length).toBe(KAFKA_CELL_LIMIT);
    expect(result.pagination?.wasLimited).toBe(true);
    expect(result.warnings).toEqual([
      { message: `1 cell(s) were cut at ${KAFKA_CELL_LIMIT.toLocaleString("en-US")} characters` },
    ]);
  });

  test("the result budget stops a read whose records together pass it, and the warning names the budget (built inline)", async () => {
    // Two records of just over half the budget each: the first always stays, and the second would pass it.
    const half = KAFKA_RESULT_BYTE_BUDGET / 2 + 1;
    const answer = kafkaFixture<LibFetchAnswer>("fetch-big");
    const [batch] = answer.responses[0].partitions[0].records;
    batch.lastOffsetDelta = 1;
    batch.records = [0, 1].map(
      (offsetDelta): LibRecord => ({
        offsetDelta,
        timestampDelta: BigInt(offsetDelta),
        key: null,
        value: Buffer.alloc(half, "x"),
        headers: [],
      }),
    );
    const { provider } = await connected({
      "consumer.listOffsets": (request) =>
        (request as { timestamp: bigint }).timestamp === BigInt(-2)
          ? new Map([["big", [BigInt(0)]]])
          : new Map([["big", [BigInt(2)]]]),
      fetchV13: () => answer,
    });
    const result = await provider.query('{"topic":"big","from":"earliest"}');
    expect(result.rows.map((r) => r.offset)).toEqual(["0"]);
    expect(result.warnings).toEqual([
      {
        message: `The read stopped before offset 1 of partition 0, at the result budget of ${KAFKA_RESULT_BYTE_BUDGET.toLocaleString("en-US")} bytes of record data; narrow it with a partition, an offset or a smaller limit`,
      },
      { message: `1 cell(s) were cut at ${KAFKA_CELL_LIMIT.toLocaleString("en-US")} characters` },
    ]);
    expect(result.pagination?.wasLimited).toBe(true);
  });

  test("a non-UTF-8 value is base64 and the framed value is labelled confluent", async () => {
    const { provider } = await connected();
    const result = await provider.query('{"topic":"bytes","from":"earliest","limit":5}');
    expect(result.rows.map((r) => r.value_encoding)).toEqual(["confluent", "base64"]);
    expect(result.rows[0].value).toBe("schema id 42, not decoded");
    expect(result.rows[1].value).toBe("//4AAQ== (4 bytes)");
  });

  test("a transactional topic reads its committed records only, and no transaction marker is a row", async () => {
    const { provider } = await connected();
    const result = await provider.query('{"topic":"txn","from":"earliest","limit":50}');
    expect(result.rows.map((r) => [r.offset, r.value])).toEqual([
      ["0", { txn: "committed", n: 1 }],
      ["1", { txn: "committed", n: 2 }],
    ]);
  });

  test("a LogAppendTime topic's rows carry the broker's append time, the batch's maxTimestamp (spec 5.2)", async () => {
    const { provider } = await connected();
    const [batch] = kafkaFixture<LibFetchAnswer>("fetch-ts-append").responses[0].partitions[0].records;
    const result = await provider.query('{"topic":"ts-append","from":"earliest"}');
    const appended = new Date(Number(batch.maxTimestamp)).toISOString();
    expect(result.rows.map((r) => r.timestamp)).toEqual([appended, appended]);
    // The control: the producer's own clock, which the records' deltas keep, is another instant.
    expect(new Date(Number(batch.firstTimestamp + batch.records[0].timestampDelta)).toISOString()).not.toBe(appended);
  });

  test("a timestamp read starts each partition at the first offset at or after it", async () => {
    const { provider, recorded } = await connected({
      "consumer.listOffsetsWithTimestamps": () =>
        new Map([["codec-gzip", new Map([[0, { offset: BigInt(4), timestamp: BigInt(1) }]])]]),
    });
    const result = await provider.query('{"topic":"codec-gzip","from":{"timestamp":"2026-09-23T00:00:00Z"},"limit":1}');
    expect(result.rows.map((r) => [r.offset, r.value])).toEqual([["4", { n: 5, codec: "gzip" }]]);
    expect((argsOf(recorded.calls, "consumer.listOffsetsWithTimestamps")[0] as { timestamp: bigint }).timestamp).toBe(
      BigInt(Date.parse("2026-09-23T00:00:00Z")),
    );
  });

  test("the read's time is measured around the read itself", async () => {
    const { provider } = await connected({
      fetchV13: async (...args) => {
        await sleep(40);
        return fetchAnswerFor(args[7]);
      },
    });
    const result = await provider.query('{"topic":"codec-gzip","from":"earliest","limit":1}');
    expect(result.executionTime).toBeGreaterThanOrEqual(30);
  });

  test("a read past the connection's query timeout is a TimeoutError carrying that timeout, answered at once", async () => {
    const { provider } = await connected(
      {
        fetchV13: async (...args) => {
          await sleep(1_000);
          return fetchAnswerFor(args[7]);
        },
      },
      50,
    );
    const started = Date.now();
    const error = await provider.query('{"topic":"codec-gzip","from":"earliest","limit":1}').catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ provider: "kafka", timeout: 50 });
    expect(Date.now() - started).toBeLessThan(800);
  });

  test("refusals: empty text first, an invalid request, bound params, a missing topic, an offset outside the range", async () => {
    const { provider, recorded } = await connected();
    const sent = recorded.calls.length;
    const empty = await provider.query("  \n ", [1]).catch((e) => e);
    expect(empty).toBeInstanceOf(QueryError);
    expect(empty.message).toBe('The editor is empty: write a read request such as {"topic": "orders"}');
    const invalid = await provider.query("{}").catch((e) => e);
    expect(invalid).toBeInstanceOf(DatabaseConfigError);
    expect(invalid.message).toContain('"topic" is required');
    const bound = await provider.query('{"topic":"orders"}', [1]).catch((e) => e);
    expect(bound).toBeInstanceOf(DatabaseConfigError);
    expect(bound.message).toBe("Bound params are not supported: a Kafka read request has no placeholders");
    // None of the three reached the broker.
    expect(recorded.calls).toHaveLength(sent);
    for (const refusal of [empty, invalid, bound]) expect(refusal.provider).toBe("kafka");
    // An empty parameter list binds nothing, so the request reads.
    expect((await provider.query('{"topic":"codec-gzip","from":"earliest","limit":1}', [])).rows).toHaveLength(1);
    await expect(provider.query('{"topic":"ghost"}')).rejects.toBeInstanceOf(QueryError);
    const pastEnd = await provider.query('{"topic":"orders","partition":1,"from":{"offset":1000}}').catch((e) => e);
    expect(pastEnd).toBeInstanceOf(QueryError);
    expect(pastEnd.message).toBe("Offset 1000 is outside partition 1's range 0 to 12");
  });

  test("an authorization failure from the broker is an AuthenticationError", async () => {
    const { provider } = await connected({
      fetchV13: () => {
        throw libError("error-authorization");
      },
    });
    const error = await provider.query('{"topic":"orders","from":"earliest"}').catch((e) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe("The broker denied access to this topic");
  });
});

describe("the object surface", () => {
  test("lists the seeded topics from the captured listing, which the client answered without the internal topics", async () => {
    const { provider } = await connected({ "admin.listTopics": () => kafkaFixture("list-topics") });
    const names = (await provider.listObjects([], "topic")).map((o) => o.name);
    expect(names).toEqual([
      "big",
      "bytes",
      "codec-gzip",
      "codec-lz4",
      "codec-snappy",
      "codec-zstd",
      "lag-partial",
      "orders",
      "ts-append",
      "txn",
    ]);
  });

  test("group sources carry lag equal to the high watermark minus the committed offset, for both protocols", async () => {
    const { provider } = await connected();
    const latest = kafkaFixture<Map<string, bigint[]>>("offsets-latest").get("orders") ?? [];
    const committed = kafkaFixture<CommittedAnswer>("committed-offsets");
    const groups = ["lag-classic", "lag-kip848"];
    const read = await Promise.all(groups.map((group) => lagRows(provider, group)));
    groups.forEach((group, index) => {
      const orders = committed.find((g) => g.groupId === group)?.topics.find((t) => t.name === "orders");
      const expected = [...(orders?.partitions ?? [])]
        .sort((a, b) => a.partitionIndex - b.partitionIndex)
        .map((p) => (latest[p.partitionIndex] - p.committedOffset).toString());
      expect(expected).toHaveLength(3);
      expect(read[index].filter((r) => r.topic === "orders").map((r) => r.lag)).toEqual(expected);
    });
  });

  test("a partition the group never committed on is a row with no lag, saying so (lag-partial)", async () => {
    const { provider } = await connected();
    const rows = await lagRows(provider, "lag-partial");
    expect(rows.find((r) => r.partition === 1)).toMatchObject({
      committedOffset: null,
      lag: null,
      note: "no committed offset",
    });
    expect(rows.find((r) => r.partition === 0)).toMatchObject({ committedOffset: "1", lag: "0" });
  });

  test("a container path is refused by name, since a Kafka connection has no container level (spec 4.1)", async () => {
    const { provider, recorded } = await connected();
    const sent = recorded.calls.length;
    const refusals = await Promise.all([
      provider.countObjects(["x"]).catch((e) => e),
      provider.listObjects(["x"], "topic").catch((e) => e),
      provider.describeObjects(["x"], "topic").catch((e) => e),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(QueryError);
      expect(refusal.message).toBe('A Kafka connection has no container level; received ["x"]');
    }
    expect(recorded.calls).toHaveLength(sent);
  });

  test("satisfies the object-surface contract", async () => {
    const { provider } = await connected();
    await assertObjectSurface(provider, {
      // A zero-level engine lists no containers, and the helper addresses every object at the root.
      containers: [],
      // The seed: ten topics, three consumer groups, one broker. A changed seed changes these, from its capture.
      kinds: { topic: 10, consumer_group: 3, broker: 1 },
      sampleObject: { path: ["orders"], kind: "topic" },
      // The absence raise, on the kind whose existence the metadata read decides.
      absentSource: { path: ["no-such-topic"], kind: "topic" },
    });
  });

  test("the tree draws three root folders, every topic row expandable and every other row a leaf (spec 4.1)", async () => {
    const { provider } = await connected();
    const capabilities = provider.getCapabilities();
    const kinds = declaredKinds(capabilities);
    const objects = Object.fromEntries(
      await Promise.all(kinds.map(async (kind) => [kind.id, await provider.listObjects([], kind.id)] as const)),
    );
    const rows = flattenTree({
      kinds,
      containers: await provider.listContainers(),
      // Every folder open, so every object row is drawn; no object is open, so no column row is.
      expanded: new Set(kinds.map((kind) => kind.id)),
      counts: { "": await provider.countObjects([]) },
      objects,
      details: {},
      readsColumns: true,
      containerDepth: containerDepth(capabilities),
    });
    expect(rows.filter((row) => row.kind === "container")).toEqual([]);
    expect(rows.filter((row) => row.kind === "folder").map((row) => [row.id, row.label, row.depth, row.badge])).toEqual(
      [
        ["topic", "Topics", 0, "10"],
        ["consumer_group", "Consumer Groups", 0, "3"],
        ["broker", "Brokers", 0, "1"],
      ],
    );
    const objectRows = rows.filter((row) => row.kind === "object");
    expect(new Set(objectRows.map((row) => row.kindId))).toEqual(new Set(["topic", "consumer_group", "broker"]));
    expect(objectRows.filter((row) => row.kindId === "topic").every((row) => typeof row.expanded === "boolean")).toBe(
      true,
    );
    expect(objectRows.filter((row) => row.kindId !== "topic").every((row) => row.expanded === undefined)).toBe(true);
  });
});

describe("declarations", () => {
  test("capabilities and labels are the spec's, and the refresh pattern matches no read request", async () => {
    const { provider } = await connected();
    const capabilities = provider.getCapabilities();
    const declared = {
      queryLanguage: "json",
      queryDialect: "kafka",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsMaintenance: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      tablesAreDerivedGroupings: false,
      declaresForeignKeys: false,
      statementTerminator: "none",
      maintenanceOperations: [],
      schemaRefreshPattern: "(?!)",
      defaultPort: 9092,
      containerLevels: KAFKA_CONTAINER_LEVELS,
      objectKinds: KAFKA_OBJECT_KINDS,
    };
    expect(capabilities).toMatchObject(declared);
    // Exactly these members, so no flag the spec does not name (a key browser, an explain format) is declared.
    expect(Object.keys(capabilities).sort()).toEqual(Object.keys(declared).sort());
    // The declarations are the objects module's own, not copies of them.
    expect(capabilities.objectKinds).toBe(KAFKA_OBJECT_KINDS);
    expect(capabilities.containerLevels).toBe(KAFKA_CONTAINER_LEVELS);
    // Compiled the way src/lib/query-generators.ts compiles it, over a click on a topic whose name holds a SQL verb.
    const pattern = new RegExp(capabilities.schemaRefreshPattern, "i");
    expect(pattern.test(JSON.stringify({ topic: "orders-drop", from: "latest", limit: 50 }, null, 2))).toBe(false);
    // The control: the base provider's SQL pattern matches that same click.
    expect(new RegExp("(CREATE|DROP|ALTER|TRUNCATE)\\b", "i").test('{"topic":"orders-drop"}')).toBe(true);
    // Every label, and no other: the maintenance ones are never rendered behind supportsMaintenance
    // false, and are worded true for Kafka all the same (spec 6.3); no Tables caption, since that
    // list is empty rather than a ranked subset.
    expect(provider.getLabels()).toEqual({
      entityName: "Topic",
      entityNamePlural: "Topics",
      rowName: "Message",
      rowNamePlural: "Messages",
      selectAction: "Read Latest 50",
      generateAction: "Generate Read Request",
      searchPlaceholder: "Search topics...",
      statementLanguage: expect.stringContaining("the JSON read request this editor executes"),
      slowQueriesEmptyState: "Kafka exposes no query log",
      sessionsEmptyState: "Kafka does not report client sessions over its protocol",
      analyzeAction: "Analyze Topic",
      vacuumAction: "Compact Topic",
      analyzeGlobalLabel: "Analyze",
      analyzeGlobalTitle: "Not available",
      analyzeGlobalDesc: "Kafka has no statistics to update.",
      vacuumGlobalLabel: "Compact",
      vacuumGlobalTitle: "Not available",
      vacuumGlobalDesc:
        "Log compaction is a topic config the broker applies on its own schedule; Studio does not trigger it.",
    });
  });

  describe("the statement language plan mode states (spec 6.3)", () => {
    // Plan mode states this sentence verbatim ("Write it in ..."), and it is the only per-engine fact
    // about how a statement is written that plan mode's prompt carries, while the request schema is
    // this product's own; so the sentence carries the schema, and each part of it is held to the
    // parser it describes.
    const text = new KafkaProvider(CONNECTION).getLabels().statementLanguage ?? "";
    const parse = (request: string) => parseReadRequest(request, DEFAULT_QUERY_LIMIT);
    const OPENING = "the JSON read request this editor executes - one object, ";

    /** The text from the brace at `start` to the brace that closes it. */
    const bracedAt = (start: number): string => {
      if (text[start] !== "{") throw new Error(`no brace opens at ${start}`);
      let depth = 0;
      for (let end = start; end < text.length; end++) {
        if (text[end] === "{") depth++;
        if (text[end] === "}" && --depth === 0) return text.slice(start, end + 1);
      }
      throw new Error(`no brace closes the one at ${start}`);
    };

    test('its shape names the four keys and every form of "from", and each form it shows is a request the parser reads', () => {
      expect(text.startsWith(OPENING)).toBe(true);
      // The shape, each placeholder filled as a request fills it, and none left over.
      const filled = bracedAt(OPENING.length)
        .replace('"<topic name>"', '"orders"')
        .replaceAll("<n>", "0")
        .replace('"<ISO-8601 with a zone>"', '"2026-09-23T00:00:00Z"')
        .replace(`<1 to ${DEFAULT_QUERY_LIMIT}>`, String(DEFAULT_QUERY_LIMIT));
      expect(filled).not.toContain("<");
      const forms = /"from": (.+), "limit"/.exec(filled)?.[1] ?? "";
      expect(forms).not.toBe("");
      const requests = forms.split(" | ").map((form) => parse(filled.replace(forms, form)));
      expect(requests.map((request) => request.from.kind)).toEqual(["earliest", "latest", "offset", "timestamp"]);
      for (const request of requests) {
        expect(request).toMatchObject({ topic: "orders", partition: 0, limit: DEFAULT_QUERY_LIMIT });
      }
      // One object, and an instant with a zone, as the shape says: the parser refuses the rest.
      expect(() => parse('[{"topic":"orders"},{"topic":"txn"}]')).toThrow("one JSON object");
      expect(() => parse('{"topic":"orders","from":{"timestamp":"2026-09-23T00:00:00"}}')).toThrow(
        "ISO-8601 with a zone",
      );
    });

    test('it says only "topic" is required, the defaults and the maximum the parser applies, and that an offset needs a partition', () => {
      // The defaults are read from the parser rather than restated.
      const defaults = parse('{"topic":"orders"}');
      expect(text).toContain(', of which only "topic" is required: ');
      expect(text).toContain(`"from" defaults to "${defaults.from.kind}", "limit" to ${defaults.limit}`);
      expect(text).toContain(`"limit": <1 to ${DEFAULT_QUERY_LIMIT}>`);
      expect(text).toContain('"partition" is required with an offset');
      // The parser's own rules, which those clauses state.
      expect(() => parse('{"partition":0,"from":"earliest","limit":1}')).toThrow('"topic" is required');
      expect(() => parse(`{"topic":"orders","limit":${DEFAULT_QUERY_LIMIT + 1}}`)).toThrow(
        `"limit" must be a whole number from 1 to ${DEFAULT_QUERY_LIMIT}`,
      );
      expect(() => parse('{"topic":"orders","from":{"offset":5}}')).toThrow('needs a "partition"');
    });

    test("every example it shows, cut at its matching brace, is a request the parser reads", () => {
      const opening = '{"topic": "orders"';
      const examples: string[] = [];
      for (let start = text.indexOf(opening); start !== -1; start = text.indexOf(opening, start + 1)) {
        examples.push(bracedAt(start));
      }
      expect(examples).toHaveLength(2);
      for (const example of examples) expect(() => parse(example)).not.toThrow();
    });

    test("it says no other key is taken, and the parser refuses as a key every other name the inventory lists for a topic", async () => {
      // Plan mode's non-SQL contract says to use no name that is not in the inventory, which lists a
      // topic's columns; without this clause it steers a model to "offset" and "timestamp" as
      // top-level keys, which the parser refuses (spec 6.3).
      expect(text).toContain(" - and no other key: ");
      expect(text).toContain('"offset" and "timestamp" go inside "from", never at the top level');
      expect(text).toContain(
        "the inventory's other columns (key, value, headers and their encodings) are fields each message comes back with, not keys of the request",
      );
      expect(text).toContain("a read request reads one topic's messages, never a consumer group's lag");
      // The columns the inventory holds for a topic, from the provider's own bulk read. The clause
      // accounts for each of them, so a column added to the read's shape fails here first.
      const { provider } = await connected();
      const [topic] = (await provider.describeObjects([], "topic")).details;
      const columns = topic.columns.map((column) => column.name);
      expect(columns).toEqual([
        "partition",
        "offset",
        "timestamp",
        "key",
        "key_encoding",
        "value",
        "value_encoding",
        "headers",
      ]);
      // "partition" is a key of the request; the parser refuses every other one at the top level, by name.
      for (const column of columns.filter((name) => name !== "partition")) {
        expect(() => parse(`{"topic":"orders",${JSON.stringify(column)}:5}`)).toThrow(
          `Unknown key ${JSON.stringify(column)}`,
        );
      }
      // No key names a group, and "topic" names one topic.
      expect(() => parse('{"topic":"orders","group":"lag-classic"}')).toThrow('Unknown key "group"');
      expect(() => parse('{"topic":["orders","txn"]}')).toThrow('"topic" is required and must be a Kafka topic name');
    });
  });

  test("no presence-detected method that would do nothing (spec 5.5, 7.1)", () => {
    const provider = new KafkaProvider(CONNECTION);
    for (const method of [
      "cancelQuery",
      "getPoolStats",
      "queryReadOnly",
      "endOpenQueryTransaction",
      "scanKeysPage",
      "beginTransaction",
      "commitTransaction",
      "rollbackTransaction",
    ]) {
      expect(method in provider).toBe(false);
    }
    // The control: a method the provider does implement is found the same way.
    expect("readObjectSource" in provider).toBe(true);
  });
});

describe("monitoring", () => {
  test("health reads the brokers forced, then the log dirs, and reports what it cannot measure as such", async () => {
    const { provider, recorded } = await connected();
    const sent = recorded.calls.length;
    const health = await provider.getHealth();
    expect(health).toEqual({
      databaseSize: "5.37 KB on disk, all replicas, internal topics excluded",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    const [first] = recorded.calls.slice(sent);
    expect(first).toEqual(["admin.metadata", [{ topics: [], autocreateTopics: false, forceUpdate: true }]]);
    // The log-dir read names every listed topic and each of its partitions, and so no internal topic (spec 7.1).
    expect(argsOf(recorded.calls, "admin.describeLogDirs")).toEqual([
      {
        topics: [...ALL.topics].map(([name, topic]) => ({
          name,
          partitions: topic.partitions.map((_, index) => index),
        })),
      },
    ]);
    // And no broker config: a principal without the Describe Cluster ACL is refused them (spec 7.1, KM6).
    expect(argsOf(recorded.calls, "admin.describeConfigs")).toEqual([]);
  });

  test("health survives a principal that may not read the log dirs (M-I, KM4), and fails when the brokers cannot be read", async () => {
    const refused = await connected({
      "admin.describeConfigs": () => {
        throw libError("error-cluster-authorization");
      },
      "admin.describeLogDirs": () => {
        throw libError("error-cluster-authorization");
      },
    });
    expect(await refused.provider.getHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    // Connected, and then the forced broker read fails while every other read still answers (the
    // library can answer a topic read from its cache): the forced read must succeed (spec 7.1).
    let brokersDown = false;
    const { provider, recorded } = await connected({
      "admin.metadata": (request) => {
        if (brokersDown && (request as { forceUpdate?: boolean }).forceUpdate === true) {
          throw libError("error-connection-closed");
        }
        return metadataFor(request);
      },
    });
    brokersDown = true;
    const error = await provider.getHealth().catch((e) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ provider: "kafka", host: "localhost", port: 9092 });
    // The control: the log dirs, which alone would still answer, were never asked for.
    expect(argsOf(recorded.calls, "admin.describeLogDirs")).toEqual([]);
  });

  test("the overview reads the topic count, the lowest broker the forced read lists, its max.connections and the log-dir size", async () => {
    const listing = (ids: number[]) =>
      new Map(ids.map((id): [number, LibBroker] => [id, { host: `b${id}`, port: 9092, rack: null }]));
    const { provider, recorded } = await connected({
      // Only a forced read is sure to reach the broker: the client answers any other from its copy,
      // brokers included, while every topic it names is younger there than metadataMaxAge
      // (dist/clients/base/base.js #performMetadata), so that copy can still list broker 1, which
      // has left. On KRaft the controller id is a random live broker (spec 4.1), here not the lowest.
      "admin.metadata": (request) => ({
        ...metadataFor(request),
        brokers:
          (request as { forceUpdate?: boolean }).forceUpdate === true ? listing([4, 2, 3]) : listing([1, 2, 3, 4]),
        controllerId: 4,
      }),
    });
    const sent = recorded.calls.length;
    const overview = await provider.getOverview();
    expect(overview).toEqual({
      version: "N/A",
      uptime: "N/A",
      maxConnections: 2147483647,
      databaseSize: "5.37 KB on disk, all replicas, internal topics excluded",
      databaseSizeBytes: 5503,
      tableCount: ALL.topics.size,
      indexCount: 0,
    });
    // The broker is the forced read's lowest, and that read is the overview's first call (spec 7.1).
    expect(recorded.calls[sent]).toEqual([
      "admin.metadata",
      [{ topics: [], autocreateTopics: false, forceUpdate: true }],
    ]);
    expect(
      argsOf(recorded.calls, "admin.describeConfigs").map(
        (request) => (request as { resources: Array<{ resourceType: number; resourceName: string }> }).resources,
      ),
    ).toEqual([[{ resourceType: BROKER_RESOURCE, resourceName: "2" }]]);
    const empty = await connected({ "admin.metadata": (request) => ({ ...metadataFor(request), brokers: new Map() }) });
    const none = await empty.provider.getOverview().catch((e) => e);
    expect(none).toBeInstanceOf(QueryError);
    expect(none).toMatchObject({ provider: "kafka", message: "The broker's metadata listed no live broker" });
  });

  test("the overview degrades per refused cluster read (KM4), and any other failure fails it", async () => {
    const bothRefused = await connected({
      "admin.describeConfigs": () => {
        throw libError("error-cluster-authorization");
      },
      "admin.describeLogDirs": () => {
        throw libError("error-cluster-authorization");
      },
    });
    const refusedOverview = await bothRefused.provider.getOverview();
    expect(refusedOverview).toMatchObject({ maxConnections: 0, databaseSize: "N/A", tableCount: ALL.topics.size });
    expect("databaseSizeBytes" in refusedOverview).toBe(false);
    const configsRefused = await connected({
      "admin.describeConfigs": () => {
        throw libError("error-cluster-authorization");
      },
    });
    const overview = await configsRefused.provider.getOverview();
    expect(overview.maxConnections).toBe(0);
    expect(overview.databaseSize).toContain("on disk");
  });

  test.each(["admin.describeConfigs", "admin.describeLogDirs"])(
    "a %s that fails for any reason but authorization fails the overview (KM4)",
    async (failing) => {
      const { provider } = await connected({
        [failing]: () => {
          throw libError("error-connection-closed");
        },
      });
      const error = await provider.getOverview().catch((e) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).toMatchObject({ provider: "kafka", host: "localhost", port: 9092 });
      // A failure that is not the broker's is a defect, and surfaces as itself.
      const defect = new TypeError("a defect, not a refusal");
      const broken = await connected({
        [failing]: () => {
          throw defect;
        },
      });
      expect(await broken.provider.getOverview().catch((e) => e)).toBe(defect);
    },
  );

  test("storage comes from the log dirs; the surfaces the protocol cannot fill are empty; maintenance is refused", async () => {
    const { provider } = await connected();
    expect(await provider.getStorageStats()).toEqual([
      {
        name: "broker 1: /tmp/kafka-logs",
        location: "/tmp/kafka-logs",
        size: "5.37 KB",
        sizeBytes: 5503,
        usagePercent: 79,
      },
    ]);
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    const maintenance = await provider.runMaintenance("vacuum").catch((e) => e);
    expect(maintenance).toBeInstanceOf(QueryError);
    expect(maintenance).toMatchObject({ provider: "kafka", message: "Unsupported maintenance type for Kafka: vacuum" });
    const refused = await connected({
      "admin.describeLogDirs": () => {
        throw libError("error-cluster-authorization");
      },
    });
    expect(await refused.provider.getStorageStats()).toEqual([]);
  });
});
