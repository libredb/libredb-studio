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
 * The broker's answers were captured from the compose `kafka` service, `apache/kafka:4.3.1`
 * (`apache/kafka@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837`),
 * cluster `4L6g3nShT-eMCtK--X86sw`, seeded by `docker/kafka/seed.sh` and
 * `docker/kafka/seed-binary.ts`. The captured failures come from that broker, from `kafka-auth`
 * (the same image with cluster `7L6g3nShT-eMCtK--X86sw`, as the principal `reader` with no ACL,
 * or with a wrong password), from Redpanda, and from local listeners with no broker behind them;
 * each fixture's `$captured` key holds its image, cluster id, capture date and the call it answers,
 * and `tests/fixtures/kafka/README.md` lists them.
 *
 * Five answers are BUILT from a capture rather than read from one, and each says so where it is
 * built: topic configs for a topic other than `orders`, broker configs for a broker other than 1,
 * and the description of a classic group other than `lag-classic`, which answer the one captured
 * shape under the name asked; the transactional topic's fetch, which gets back the aborted batch
 * the client's own filter dropped from the capture; and every answer a test states inline, such as
 * a broker list, a slow fetch or a record past the result budget. One capture answers a wider
 * request than the one it was taken for: the log-dir capture named `orders` alone, so the
 * provider's request, which names every listed topic, gets orders' 5,503 bytes on broker 1's one
 * log dir, and every size below is that one topic's, not the seeded cluster's. Every library
 * failure a test throws is a capture; the failure tests throw every one the fixtures directory
 * holds, found by name, and compute what each surface must answer from what the adapter itself
 * answers at the read that failed. The `TypeError`s, which stand for a defect of the provider's own,
 * and a close that fails are built inline.
 *
 * The recorded library answers every construction of a class with the same object, so two clients
 * would share their calls and their closes. A test therefore counts clients by the provider's own
 * factory calls and by the library's construction log, never by what was called or closed.
 *
 * Most rules the provider owns are compositions no module can see, and many of them are kept by what
 * the provider does not do: build no second client, degrade no read but the two KM4 names, add no read
 * to a module's, keep no answer for the next call. So those rules are pinned whole, as a class, rather
 * than one mutant at a time: the lifecycle test counts every client, the KM4 matrix answers every
 * combination of the two refusals, the failure matrix fails each read of each surface separately with
 * every captured failure, and the wire traces and the delegation tests compare every read a surface
 * makes. What this file can throw at a read is a capture, though, which the adapter makes into ten of
 * the fourteen KafkaError categories, so a rule over every category, such as KM4's (only an
 * authorization refusal degrades), cannot be reached here whole; and what its modules answer holds
 * only the parts the captures hold. The same rules over their whole domains (every category, every
 * part of every module answer, by identity, and every query timeout) are pinned at the provider's own
 * seam, the KafkaReadClient interface, by tests/unit/db/kafka/provider.test.ts.
 *
 * A section number below, "spec 5.1" for example, is a section of #1088's design.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { flattenTree } from "@/components/object-tree/flatten";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";
import { containerDepth, declaredKinds } from "@/lib/db/object-kinds";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import { KafkaError, type KafkaReadClient } from "@/lib/db/providers/stream/kafka/client";
import { kafkaConnectionOptions } from "@/lib/db/providers/stream/kafka/connection-options";
import { toDatabaseError } from "@/lib/db/providers/stream/kafka/errors";
import * as kafkaObjects from "@/lib/db/providers/stream/kafka/objects";
import { createPlatformaticClient, loadPlatformatic } from "@/lib/db/providers/stream/kafka/platformatic-client";
import { KAFKA_CELL_LIMIT, KAFKA_RESULT_BYTE_BUDGET, readMessages } from "@/lib/db/providers/stream/kafka/read";
import { parseReadRequest } from "@/lib/db/providers/stream/kafka/request";
import { KAFKA_RESULT_FIELDS, toQueryResult } from "@/lib/db/providers/stream/kafka/results";
import type { ObjectSourceDocument, ProviderCapabilities, ProviderOptions, QueryResult } from "@/lib/db/types";
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

/** How the captured broker answers each library call, as a broker answers the request the call carries. */
const BROKER_ANSWERS: Readonly<Record<string, Answer>> = {
  "admin.metadata": metadataFor,
  // The captured listing, which the client answered without the internal topics.
  "admin.listTopics": () => kafkaFixture("list-topics"),
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
};

function brokerLib(overrides: Record<string, Answer> = {}) {
  return recordedLib({ ...BROKER_ANSWERS, ...overrides });
}

const CONNECTION = {
  id: "k1",
  name: "kafka",
  type: "kafka",
  host: "localhost",
  port: 9092,
  createdAt: new Date(),
} as unknown as DatabaseConnection;

/** One client, as the library builds it: one Admin, one Consumer and one fetch pool (spec 3.6 K8). */
const LIBRARY_CLIENTS = ["Admin", "Consumer", "ConnectionPool"];

/**
 * A provider over the captured broker, not yet connected, with every client its factory built: the
 * count that tells one client from two, which the shared objects of the recorded library cannot.
 */
function unconnected(overrides: Record<string, Answer> = {}, options: ProviderOptions = {}) {
  const recorded = brokerLib(overrides);
  const created: KafkaReadClient[] = [];
  const provider = new KafkaProvider(CONNECTION, options, async (clientOptions) => {
    const client = createPlatformaticClient(clientOptions, recorded.lib);
    created.push(client);
    return client;
  });
  return { provider, recorded, created };
}

async function connected(overrides: Record<string, Answer> = {}, queryTimeout?: number) {
  const setup = unconnected(overrides, queryTimeout === undefined ? {} : { queryTimeout });
  await setup.provider.connect();
  return setup;
}

/** The query timeout the failure tests connect with, which a TimeoutError carries. */
const FAILURE_TIMEOUT_MS = 7_000;

/** A read composed as spec 3.5 and 5.1 compose it, over one client, its time left out: the time has its own test. */
const composedReadOf =
  (text: string) =>
  async (client: KafkaReadClient): Promise<QueryResult> => {
    const request = parseReadRequest(text, DEFAULT_QUERY_LIMIT);
    const outcome = await readMessages(
      client,
      request,
      { resultByteBudget: KAFKA_RESULT_BYTE_BUDGET, cellLimit: KAFKA_CELL_LIMIT },
      AbortSignal.timeout(FAILURE_TIMEOUT_MS),
    );
    return toQueryResult(outcome.rows, 0, request.limit, outcome.warnings, outcome.wasLimited);
  };

/**
 * One read a surface makes, as spec 7.1 names it, and which calls of one library member carry it: a
 * metadata call is the forced broker read when it names no topic, and a topic read when it names some.
 */
type Read = { readonly name: string; readonly member: string; readonly carries: (request: unknown) => boolean };
const namesNoTopic = (request: unknown) => (request as { topics: string[] }).topics.length === 0;
const everyCall = () => true;
const READS = {
  forcedBrokers: { name: "the forced broker read", member: "admin.metadata", carries: namesNoTopic },
  topicListing: { name: "the topic listing", member: "admin.listTopics", carries: everyCall },
  listedTopics: { name: "the listed topics' metadata", member: "admin.metadata", carries: (r) => !namesNoTopic(r) },
  brokerConfigs: { name: "the lowest broker's configs", member: "admin.describeConfigs", carries: everyCall },
  logDirs: { name: "the log dirs", member: "admin.describeLogDirs", carries: everyCall },
  offsets: { name: "the topic's offsets", member: "consumer.listOffsets", carries: everyCall },
  topicMetadata: { name: "the topic's metadata", member: "admin.metadata", carries: (r) => !namesNoTopic(r) },
  topicConfigs: { name: "the topic's configs", member: "admin.describeConfigs", carries: everyCall },
} satisfies Record<string, Read>;

/**
 * A provider connected over the captured broker, after which every call that carries one read fails
 * with `failure` while every other call is answered. Connect's own round trip is a metadata read, so
 * the read starts failing only once connect is done, and the failure is always the surface's own.
 */
async function connectedThenFailing(read: Read, failure: unknown) {
  let armed = false;
  const answer = BROKER_ANSWERS[read.member];
  const setup = await connected(
    {
      [read.member]: (...args) => {
        if (armed && read.carries(args[0])) throw failure;
        return answer(...args);
      },
    },
    FAILURE_TIMEOUT_MS,
  );
  armed = true;
  return setup;
}

/**
 * The same captured broker behind no provider, failing the same read with the same failure object:
 * what the adapter itself answers there is what every expectation of the failure tests is computed
 * from. `afterConnect` leaves the first forced broker read answered, as a provider's connect had it.
 */
async function referenceFailing(read: Read, failure: unknown, afterConnect = true): Promise<KafkaReadClient> {
  let armed = !afterConnect;
  const answer = BROKER_ANSWERS[read.member];
  const recorded = brokerLib({
    [read.member]: (...args) => {
      if (armed && read.carries(args[0])) throw failure;
      return answer(...args);
    },
  });
  const client = createPlatformaticClient(kafkaConnectionOptions(CONNECTION, FAILURE_TIMEOUT_MS), recorded.lib);
  if (afterConnect) await client.metadata([]);
  armed = true;
  return client;
}

/**
 * Every failure the capture harness recorded, found by the fixtures' own naming (`error-*`, and
 * Redpanda's `redpanda-error-*`) rather than listed by hand, so a capture added later is thrown at
 * every read below as well (spec 11 KM4: "every captured failure"), and a defect of the provider's
 * own, which is no library failure. What each is, and where it was captured, is its `$captured` key
 * and the fixtures README; the error table's answer to each is computed from what the adapter makes
 * of it at the read it meets, never restated here.
 */
const DEFECT = "a defect of the provider's own";
const FAILURES_THROWN: readonly string[] = [
  ...readdirSync(join(import.meta.dir, "..", "..", "fixtures", "kafka"))
    .filter((name) => /^(redpanda-)?error-.+\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ""))
    .sort(),
  DEFECT,
];
const failureNamed = (name: string): unknown =>
  name === DEFECT ? new TypeError("a defect, not a refusal") : libError(name);

/** A call's end: what it answered, or what it threw. */
type Settled = { readonly value: unknown } | { readonly error: unknown };
const settle = (run: () => Promise<unknown>): Promise<Settled> =>
  run().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
/** An error as a caller reads it: its class, its message and every field it carries. */
const described = (error: unknown) =>
  error instanceof Error ? { ...error, class: error.constructor.name, message: error.message } : { value: error };
/** What a call came to, as a caller meets it. */
type Outcome = { readonly answered: unknown } | { readonly threw: unknown };
/** What a call came to, a failure that surfaced as itself saying so. */
const outcomeOf = (settled: Settled, failure: unknown): Outcome =>
  "value" in settled
    ? { answered: settled.value }
    : { threw: settled.error === failure ? "the failure itself" : described(settled.error) };
/** The address this file's connection validated, which a bootstrap failure carries. */
const BOOTSTRAP = kafkaConnectionOptions(CONNECTION, FAILURE_TIMEOUT_MS).broker;
/** The error table's answer (spec 5.6) to what the adapter threw, with that address and the query timeout. */
const tableAnswer = (thrown: unknown, failure: unknown) =>
  outcomeOf({ error: toDatabaseError(thrown, BOOTSTRAP, FAILURE_TIMEOUT_MS) }, failure);
/** KM4's one degrading failure (spec 11): an authorization refusal. */
const isAuthorizationRefusal = (error: unknown) => error instanceof KafkaError && error.category === "authorization";
/** A read the adapter answered although the library failed it: a leaderless partition, read through (spec 4.1). */
const READ_THROUGH = "the read answered: the adapter read the failure through";

type BrokerRead = readonly [
  surface: string,
  readName: string,
  read: Read,
  call: (provider: KafkaProvider) => Promise<unknown>,
  /** What the surface must come to, from what the same read comes to without the provider. */
  expected: (reference: KafkaReadClient, capabilities: ProviderCapabilities, failure: unknown) => Promise<Outcome>,
];

/**
 * A surface that delegates: it answers what its module answers over the failing read, a failure
 * through the error table (spec 3.5, 5.6).
 */
const delegated = (
  surface: string,
  read: Read,
  call: (provider: KafkaProvider) => Promise<unknown>,
  viaModule: (client: KafkaReadClient, capabilities: ProviderCapabilities) => Promise<unknown>,
  normalize: (value: unknown) => unknown = (value) => value,
): BrokerRead => [
  surface,
  read.name,
  read,
  async (provider) => normalize(await call(provider)),
  async (reference, capabilities, failure) => {
    const settled = await settle(() => viaModule(reference, capabilities));
    return "value" in settled ? { answered: normalize(settled.value) } : tableAnswer(settled.error, failure);
  },
];

/**
 * A panel the provider composes from the reads spec 7.1 gives it: a read the adapter fails fails the
 * panel through the error table, but an authorization refusal of the two reads KM4 names, which
 * degrades the panel to `degraded`; a read the adapter answers leaves the panel answering.
 */
const composed = (
  surface: string,
  read: Read,
  call: (provider: KafkaProvider) => Promise<unknown>,
  adapterRead: (client: KafkaReadClient) => Promise<unknown>,
  degraded?: unknown,
): BrokerRead => [
  surface,
  read.name,
  read,
  call,
  async (reference, _capabilities, failure) => {
    const settled = await settle(() => adapterRead(reference));
    if ("value" in settled) return { answered: READ_THROUGH };
    if (degraded !== undefined && isAuthorizationRefusal(settled.error)) return { answered: degraded };
    return tableAnswer(settled.error, failure);
  },
];

/** The reads each panel makes, as the adapter's own calls carrying them. */
const forcedBrokerRead = (client: KafkaReadClient) => client.metadata([]);
const topicListingRead = (client: KafkaReadClient) => client.listTopics();
const listedTopicsRead = (client: KafkaReadClient) => client.metadata();
const logDirsRead = async (client: KafkaReadClient) => client.logDirs((await client.metadata()).topics);
const brokerConfigsRead = (client: KafkaReadClient) => client.brokerConfigs(1);

/** The panels a refused cluster read degrades (KM4), each whole, over the captured broker. */
const HEALTH_WITHOUT_LOG_DIRS = { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
const OVERVIEW_WITHOUT_LOG_DIRS = {
  version: "N/A",
  uptime: "N/A",
  maxConnections: 2147483647,
  databaseSize: "N/A",
  tableCount: ALL.topics.size,
  indexCount: 0,
};
const OVERVIEW_WITHOUT_BROKER_CONFIGS = {
  version: "N/A",
  uptime: "N/A",
  maxConnections: 0,
  databaseSize: "5.37 KB on disk, all replicas, internal topics excluded",
  databaseSizeBytes: 5503,
  tableCount: ALL.topics.size,
  indexCount: 0,
};

const READ_REQUEST = '{"topic":"codec-gzip","from":"earliest","limit":1}';
/** A read's result without its time, which has its own test. */
const untimed = (value: unknown) => ({ ...(value as QueryResult), executionTime: 0 });

/**
 * Every read each surface makes, each failed on its own. A monitoring panel is listed once for every
 * read spec 7.1 gives it, because the provider composes those reads itself; a surface that delegates
 * is listed with one read, because its module owns the rest.
 */
const BROKER_READS: readonly BrokerRead[] = [
  delegated("query", READS.offsets, (p) => p.query(READ_REQUEST), composedReadOf(READ_REQUEST), untimed),
  delegated(
    "listObjects",
    READS.topicListing,
    (p) => p.listObjects([], "topic"),
    (c) => kafkaObjects.listObjects(c, [], "topic"),
  ),
  delegated(
    "describeObject",
    READS.topicMetadata,
    (p) => p.describeObject(["orders"], "topic"),
    (c, capabilities) => kafkaObjects.describeObject(c, capabilities, ["orders"], "topic"),
  ),
  delegated(
    "describeObjects",
    READS.topicListing,
    (p) => p.describeObjects([], "topic"),
    (c) => kafkaObjects.describeObjects(c, [], "topic"),
  ),
  delegated(
    "readObjectSource",
    READS.topicConfigs,
    (p) => p.readObjectSource(["orders"], "topic"),
    (c, capabilities) => kafkaObjects.readObjectSource(c, capabilities, ["orders"], "topic"),
  ),
  // The forced broker read, then the log-dir read: the listing it names, their metadata, the log dirs.
  composed("getHealth", READS.forcedBrokers, (p) => p.getHealth(), forcedBrokerRead),
  composed("getHealth", READS.topicListing, (p) => p.getHealth(), topicListingRead),
  composed("getHealth", READS.listedTopics, (p) => p.getHealth(), listedTopicsRead),
  composed("getHealth", READS.logDirs, (p) => p.getHealth(), logDirsRead, HEALTH_WITHOUT_LOG_DIRS),
  // The forced broker read, then the topic listing, the lowest broker's configs and the log-dir read.
  composed("getOverview", READS.forcedBrokers, (p) => p.getOverview(), forcedBrokerRead),
  composed("getOverview", READS.topicListing, (p) => p.getOverview(), topicListingRead),
  composed("getOverview", READS.listedTopics, (p) => p.getOverview(), listedTopicsRead),
  composed(
    "getOverview",
    READS.brokerConfigs,
    (p) => p.getOverview(),
    brokerConfigsRead,
    OVERVIEW_WITHOUT_BROKER_CONFIGS,
  ),
  composed("getOverview", READS.logDirs, (p) => p.getOverview(), logDirsRead, OVERVIEW_WITHOUT_LOG_DIRS),
  // The log-dir read alone.
  composed("getStorageStats", READS.topicListing, (p) => p.getStorageStats(), topicListingRead),
  composed("getStorageStats", READS.listedTopics, (p) => p.getStorageStats(), listedTopicsRead),
  composed("getStorageStats", READS.logDirs, (p) => p.getStorageStats(), logDirsRead, []),
];

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

/** Every surface of a provider, called as a caller would; each answers over the captured broker but maintenance. */
const SURFACES: ReadonlyArray<readonly [string, (provider: KafkaProvider) => Promise<unknown>]> = [
  ["query", (p) => p.query('{"topic":"codec-gzip","from":"earliest","limit":1}')],
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
  test("connect builds one client from the validated options and proves the broker answers with one forced metadata read", async () => {
    const { recorded, created } = await connected({}, 7_000);
    // One client, which is the library's one Admin, one Consumer and one fetch pool (spec 3.6 K8).
    expect(created).toHaveLength(1);
    expect(recorded.constructed.map(([name]) => name)).toEqual(LIBRARY_CLIENTS);
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
    const { provider, recorded, created } = unconnected({
      "admin.metadata": () => {
        throw libError("error-connection-closed");
      },
    });
    const error = await provider.connect().catch((e) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ provider: "kafka", host: "localhost", port: 9092 });
    // The client it closed is the one it built: no other was built to be closed in its place.
    expect(created).toHaveLength(1);
    expect(recorded.constructed.map(([name]) => name)).toEqual(LIBRARY_CLIENTS);
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

  test("a failure carries the address the connection validated: the host lower-cased, and the default port when none is typed", async () => {
    const typed = { ...CONNECTION, host: "LocalHost", port: undefined } as unknown as DatabaseConnection;
    const lost = () => {
      throw libError("error-connection-closed");
    };
    // The connect's own failure.
    const refusing = brokerLib({ "admin.metadata": lost });
    const failed = await new KafkaProvider(typed, {}, async (options) =>
      createPlatformaticClient(options, refusing.lib),
    )
      .connect()
      .catch((e) => e);
    expect(failed).toBeInstanceOf(ConnectionError);
    expect(failed).toMatchObject({ provider: "kafka", host: "localhost", port: 9092 });
    // And a surface's, once connected.
    const recorded = brokerLib({ "admin.listTopics": lost });
    const provider = new KafkaProvider(typed, {}, async (options) => createPlatformaticClient(options, recorded.lib));
    await provider.connect();
    const later = await provider.listObjects([], "topic").catch((e) => e);
    expect(later).toBeInstanceOf(ConnectionError);
    expect(later).toMatchObject({ provider: "kafka", host: "localhost", port: 9092 });
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
    const { provider, recorded, created } = await connected();
    await provider.disconnect();
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
    // Closing builds nothing: the one client connect built is the one closed.
    expect(created).toHaveLength(1);
    expect(recorded.constructed.map(([name]) => name)).toEqual(LIBRARY_CLIENTS);
    expect(provider.isConnected()).toBe(false);
    const callsAfterClose = recorded.calls.length;
    await expect(provider.query('{"topic":"orders"}')).rejects.toThrow("Provider is not connected");
    expect(recorded.calls).toHaveLength(callsAfterClose);
    // A second disconnect has nothing left to close.
    await provider.disconnect();
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
  });

  test("K8: one connect builds one client; the constructor, the declarations, every surface and disconnect build none", async () => {
    const { provider, recorded, created } = unconnected();
    const built = () => recorded.constructed.map(([name]) => name);
    // Building the provider and reading its declarations opens nothing (C-65, Y-06).
    provider.getCapabilities();
    provider.getLabels();
    expect(created).toEqual([]);
    expect(built()).toEqual([]);
    expect(recorded.calls).toEqual([]);
    await provider.connect();
    expect(created).toHaveLength(1);
    expect(built()).toEqual(LIBRARY_CLIENTS);
    // Every surface answers over that one client, and a source of each kind as well; the only other
    // construction is the one-off Connection of a consumer-protocol group's API 69 description (spec
    // 4.3), which the adapter closes before the source answers.
    const answered = await Promise.all([
      ...SURFACES.map(([name, call]) => (name === "runMaintenance" ? call(provider).catch((e) => e) : call(provider))),
      provider.readObjectSource(["lag-classic"], "consumer_group"),
      provider.readObjectSource(["lag-kip848"], "consumer_group"),
      provider.readObjectSource(["1"], "broker"),
    ]);
    expect(answered).toHaveLength(SURFACES.length + 3);
    expect(created).toHaveLength(1);
    expect(built()).toEqual([...LIBRARY_CLIENTS, "Connection"]);
    expect(closesOf(recorded.calls)).toEqual(["connection.close"]);
    await provider.disconnect();
    expect(created).toHaveLength(1);
    expect(built()).toEqual([...LIBRARY_CLIENTS, "Connection"]);
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "connection.close", "consumer.close", "pool.close"]);
  });

  test("a disconnect whose close fails reports that failure, and leaves the provider disconnected all the same", async () => {
    const refusal = new Error("close refused");
    const { provider, recorded } = await connected({
      "admin.close": () => {
        throw refusal;
      },
    });
    expect(await provider.disconnect().catch((e) => e)).toBe(refusal);
    expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
    expect(provider.isConnected()).toBe(false);
    await expect(provider.query('{"topic":"orders"}')).rejects.toThrow("Provider is not connected");
    // It holds no client afterwards, so a second disconnect has nothing left to close.
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

  test("the read's time is the span of the read itself on Date.now(), in milliseconds (spec 3.5)", async () => {
    // A clock that moves only while the broker answers the fetch, so the one right answer is the 42
    // ms the fetch took: an instant, a span that starts after the read, a constant added, another
    // clock or another unit each answers something else.
    let now = 1_790_000_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { provider } = await connected({
        fetchV13: (...args) => {
          now += 42;
          return fetchAnswerFor(args[7]);
        },
      });
      const result = await provider.query('{"topic":"codec-gzip","from":"earliest","limit":1}');
      expect(result.rows).toHaveLength(1);
      expect(result.executionTime).toBe(42);
    } finally {
      clock.mockRestore();
    }
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
    // A list is refused for holding an entry, whatever the entry: an undefined or a null is bound too.
    const boundEmptyValues = await Promise.all(
      [[undefined], [null]].map((params) => provider.query('{"topic":"orders"}', params).catch((e) => e)),
    );
    for (const refusal of boundEmptyValues) {
      expect(refusal).toBeInstanceOf(DatabaseConfigError);
      expect(refusal.message).toBe(bound.message);
    }
    // None of them reached the broker.
    expect(recorded.calls).toHaveLength(sent);
    for (const refusal of [empty, invalid, bound, ...boundEmptyValues]) expect(refusal.provider).toBe("kafka");
    // Empty text and bound params need no broker, so they come before anything else, the
    // connection check included: a provider that never connected refuses them the same way.
    const unconnected = new KafkaProvider(CONNECTION);
    const [emptyFirst, boundFirst] = await Promise.all([
      unconnected.query("  \n ", [1]).catch((e) => e),
      unconnected.query('{"topic":"orders"}', [1]).catch((e) => e),
    ]);
    expect(emptyFirst).toBeInstanceOf(QueryError);
    expect(emptyFirst.message).toBe(empty.message);
    expect(boundFirst).toBeInstanceOf(DatabaseConfigError);
    expect(boundFirst.message).toBe(bound.message);
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

  test("describeObject confirms the topic asked for exists, never creating it, and answers the fixed columns (spec 4.2, 4.5)", async () => {
    const { provider, recorded } = await connected();
    const sent = recorded.calls.length;
    const detail = await provider.describeObject(["codec-gzip"], "topic");
    expect(detail).toEqual({
      path: ["codec-gzip"],
      columns: [...kafkaObjects.KAFKA_TOPIC_COLUMNS],
      indexes: [],
      foreignKeys: [],
    });
    expect(detail.columns.map((column) => column.name)).toEqual([
      "partition",
      "offset",
      "timestamp",
      "key",
      "key_encoding",
      "value",
      "value_encoding",
      "headers",
    ]);
    // A topic deleted since the tree was listed; createErrorResponse (src/lib/api/errors.ts) answers
    // this QueryError with a 400, where an error outside the table would be a 500.
    const missing = await provider.describeObject(["ghost"], "topic").catch((e) => e);
    expect(missing).toBeInstanceOf(QueryError);
    expect(missing).toMatchObject({ provider: "kafka", message: "The topic does not exist" });
    // One metadata read each, naming the topic asked for and no other, with topic creation off (M-B).
    expect(recorded.calls.slice(sent)).toEqual([
      ["admin.metadata", [{ topics: ["codec-gzip"], autocreateTopics: false }]],
      ["admin.metadata", [{ topics: ["ghost"], autocreateTopics: false }]],
    ]);
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

describe("internal topics, never named to the broker (spec 4.1, 4.5)", () => {
  // Kafka's own list (Topic.isInternal in 4.3.1). A broker before Apache Kafka 2.8 creates a missing
  // internal topic for any Metadata request that names one, whatever allowAutoTopicCreation and
  // auto.create.topics.enable say, so no surface may send a request that names one.
  const INTERNAL = ["__consumer_offsets", "__transaction_state", "__share_group_state"];
  const refusal = (name: string) =>
    `Topic ${JSON.stringify(name)} is internal to Kafka, and the client this provider uses drops internal topics from its metadata, so it is not readable here`;
  const SURFACES_NAMING_A_TOPIC: ReadonlyArray<
    readonly [string, (provider: KafkaProvider, name: string) => Promise<unknown>]
  > = [
    ["a read", (provider, name) => provider.query(JSON.stringify({ topic: name }))],
    ["describeObject", (provider, name) => provider.describeObject([name], "topic")],
    ["readObjectSource", (provider, name) => provider.readObjectSource([name], "topic")],
  ];

  test.each(INTERNAL.flatMap((name) => SURFACES_NAMING_A_TOPIC.map(([surface]) => [name, surface])))(
    "%s: %s answers the internal-topic refusal and the library is asked nothing",
    async (name, surface) => {
      const { provider, recorded } = await connected();
      const sent = recorded.calls.length;
      const ask = SURFACES_NAMING_A_TOPIC.find(([named]) => named === surface)![1];
      const error = await ask(provider, name).catch((e) => e);
      expect(error).toBeInstanceOf(QueryError);
      expect(error).toMatchObject({ provider: "kafka", message: refusal(name) });
      expect(recorded.calls.slice(sent)).toEqual([]);
    },
  );

  test("a group committed on an internal topic keeps its rows there, with no latest offset and the reason, and no request names the topic", async () => {
    const { provider, recorded } = await connected({
      // lag-classic's own entry, with offsets committed on __consumer_offsets too, as a group that
      // reads that topic, such as a lag monitor's, commits them.
      "admin.listConsumerGroupOffsets": (request) => {
        const asked = (request as { groups: string[] }).groups;
        const answer = kafkaFixture<CommittedAnswer>("committed-offsets").filter((g) => asked.includes(g.groupId));
        for (const entry of answer) {
          entry.topics.push({
            name: "__consumer_offsets",
            partitions: [
              { partitionIndex: 1, committedOffset: BigInt(9) },
              { partitionIndex: 0, committedOffset: BigInt(7) },
            ],
          });
        }
        return answer;
      },
    });
    const sent = recorded.calls.length;
    const rows = await lagRows(provider, "lag-classic");
    // Each whole row, the latest offset included, which lagRows does not type.
    const internalRows: unknown[] = rows.filter((r) => r.topic === "__consumer_offsets");
    expect(internalRows).toEqual([
      {
        topic: "__consumer_offsets",
        partition: 0,
        committedOffset: "7",
        latestOffset: null,
        lag: null,
        note: `latest offset not read: ${refusal("__consumer_offsets")}`,
      },
      {
        topic: "__consumer_offsets",
        partition: 1,
        committedOffset: "9",
        latestOffset: null,
        lag: null,
        note: `latest offset not read: ${refusal("__consumer_offsets")}`,
      },
    ]);
    // The control: the group's other topic keeps its lag, read at the high watermark.
    expect(rows.filter((r) => r.topic === "orders").map((r) => r.lag)).toHaveLength(3);
    expect(rows.filter((r) => r.topic === "orders").every((r) => r.lag !== null)).toBe(true);
    const named = recorded.calls
      .slice(sent)
      .filter(([, args]) =>
        JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? value.toString() : value)).includes(
          "__consumer_offsets",
        ),
      );
    expect(named).toEqual([]);
  });
});

describe("a group committed on several topics (spec 4.3, 4.4)", () => {
  test("its source shows lag rows for every partition of each topic it committed on, each read at its own high watermark", async () => {
    // Every captured group committed on one topic. lag-classic's entry gains codec-gzip, whose one
    // partition's captured high watermark is 20, committed at 7.
    const { provider, recorded } = await connected({
      "admin.listConsumerGroupOffsets": (request) => {
        const asked = (request as { groups: string[] }).groups;
        const answer = kafkaFixture<CommittedAnswer>("committed-offsets").filter((g) => asked.includes(g.groupId));
        for (const entry of answer) {
          entry.topics.push({ name: "codec-gzip", partitions: [{ partitionIndex: 0, committedOffset: BigInt(7) }] });
        }
        return answer;
      },
    });
    const sent = recorded.calls.length;
    const rows = await lagRows(provider, "lag-classic");
    const latest = kafkaFixture<Map<string, bigint[]>>("offsets-latest").get("orders") ?? [];
    const committed = kafkaFixture<CommittedAnswer>("committed-offsets")
      .find((g) => g.groupId === "lag-classic")
      ?.topics.find((t) => t.name === "orders")?.partitions;
    const orders = [...(committed ?? [])]
      .sort((a, b) => a.partitionIndex - b.partitionIndex)
      .map((p) => ({
        topic: "orders",
        partition: p.partitionIndex,
        committedOffset: p.committedOffset.toString(),
        latestOffset: latest[p.partitionIndex].toString(),
        lag: (latest[p.partitionIndex] - p.committedOffset).toString(),
      }));
    expect(orders).toHaveLength(3);
    const whole: unknown[] = rows;
    expect(whole).toEqual([
      { topic: "codec-gzip", partition: 0, committedOffset: "7", latestOffset: "20", lag: "13" },
      ...orders,
    ]);
    // Each topic's high watermark read on its own: the log end, read uncommitted.
    expect(argsOf(recorded.calls.slice(sent), "consumer.listOffsets")).toEqual(
      expect.arrayContaining([
        { topics: ["codec-gzip"], timestamp: BigInt(-1), isolationLevel: 0 },
        { topics: ["orders"], timestamp: BigInt(-1), isolationLevel: 0 },
      ]),
    );
  });
});

describe("several brokers and log directories (spec 7.1)", () => {
  test("storage has a row per broker and log directory, and the overview's size is the sum over all of them", async () => {
    // The capture holds one broker with one log directory. Built here: broker 2 with two directories,
    // listed first, and broker 1 with one that reports no total or usable bytes.
    const dir = (logDir: string, totalBytes: number, usableBytes: number, sizes: number[]) => ({
      logDir,
      totalBytes: BigInt(totalBytes),
      usableBytes: BigInt(usableBytes),
      topics: [{ partitions: sizes.map((size) => ({ partitionSize: BigInt(size) })) }],
    });
    const { provider } = await connected({
      "admin.describeLogDirs": () => [
        { broker: 2, results: [dir("/a", 4000, 1000, [1024, 1024]), dir("/b", 8000, 6000, [512])] },
        { broker: 1, results: [dir("/c", -1, -1, [3072])] },
      ],
    });
    expect(await provider.getStorageStats()).toEqual([
      { name: "broker 2: /a", location: "/a", size: "2 KB", sizeBytes: 2048, usagePercent: 75 },
      { name: "broker 2: /b", location: "/b", size: "512 B", sizeBytes: 512, usagePercent: 25 },
      { name: "broker 1: /c", location: "/c", size: "3 KB", sizeBytes: 3072 },
    ]);
    const overview = await provider.getOverview();
    expect([overview.databaseSize, overview.databaseSizeBytes]).toEqual([
      "5.5 KB on disk, all replicas, internal topics excluded",
      5632,
    ]);
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
      containerLevels: kafkaObjects.KAFKA_CONTAINER_LEVELS,
      objectKinds: kafkaObjects.KAFKA_OBJECT_KINDS,
    };
    expect(capabilities).toMatchObject(declared);
    // Exactly these members, so no flag the spec does not name (a key browser, an explain format) is declared.
    expect(Object.keys(capabilities).sort()).toEqual(Object.keys(declared).sort());
    // The declarations are the objects module's own, not copies of them.
    expect(capabilities.objectKinds).toBe(kafkaObjects.KAFKA_OBJECT_KINDS);
    expect(capabilities.containerLevels).toBe(kafkaObjects.KAFKA_CONTAINER_LEVELS);
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

  const clusterRefusal: Answer = () => {
    throw libError("error-cluster-authorization");
  };
  const ON_DISK = "5.37 KB on disk, all replicas, internal topics excluded";
  const STORAGE_ROW = {
    name: "broker 1: /tmp/kafka-logs",
    location: "/tmp/kafka-logs",
    size: "5.37 KB",
    sizeBytes: 5503,
    usagePercent: 79,
  };
  // The two cluster reads need different rights (Describe and DescribeConfigs on the cluster), so
  // either can be refused alone (KM4): every combination, and each panel's whole answer in each.
  const KM4_COMBINATIONS = [
    ["neither cluster read refused", {}, { configs: true, logDirs: true }],
    [
      "the broker configs refused alone",
      { "admin.describeConfigs": clusterRefusal },
      { configs: false, logDirs: true },
    ],
    ["the log dirs refused alone", { "admin.describeLogDirs": clusterRefusal }, { configs: true, logDirs: false }],
    [
      "both cluster reads refused",
      { "admin.describeConfigs": clusterRefusal, "admin.describeLogDirs": clusterRefusal },
      { configs: false, logDirs: false },
    ],
  ] as const;

  test.each(KM4_COMBINATIONS)(
    "KM4: with %s, each panel degrades by the read it was refused and by no other",
    async (_combination, overrides, readable) => {
      const { provider } = await connected(overrides);
      const [overview, health, storage] = await Promise.all([
        provider.getOverview(),
        provider.getHealth(),
        provider.getStorageStats(),
      ]);
      const size = readable.logDirs ? ON_DISK : "N/A";
      expect(overview).toEqual({
        version: "N/A",
        uptime: "N/A",
        // A refused broker-config read is no limit published, the one meaning 0 has (spec 7.1).
        maxConnections: readable.configs ? 2147483647 : 0,
        databaseSize: size,
        ...(readable.logDirs ? { databaseSizeBytes: 5503 } : {}),
        tableCount: ALL.topics.size,
        indexCount: 0,
      });
      expect(health).toEqual({ databaseSize: size, cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
      expect(storage).toEqual(readable.logDirs ? [STORAGE_ROW] : []);
    },
  );

  test("each panel makes exactly the reads spec 7.1 lists, and makes them again on every load", async () => {
    const { provider, recorded } = await connected();
    type Call = [name: string, args: unknown[]];
    const forcedBrokers: Call = ["admin.metadata", [{ topics: [], autocreateTopics: false, forceUpdate: true }]];
    const listing: Call = ["admin.listTopics", []];
    const listedTopics: Call = [
      "admin.metadata",
      [{ topics: [...kafkaFixture<string[]>("list-topics")].sort(), autocreateTopics: false }],
    ];
    const logDirs: Call = [
      "admin.describeLogDirs",
      [{ topics: [...ALL.topics].map(([name, topic]) => ({ name, partitions: topic.partitions.map((_, i) => i) })) }],
    ];
    const brokerConfigs: Call = [
      "admin.describeConfigs",
      [
        {
          resources: [{ resourceType: BROKER_RESOURCE, resourceName: "1" }],
          includeSynonyms: false,
          includeDocumentation: false,
        },
      ],
    ];
    /** The calls one load of a panel made, in order. */
    const readsOf = async (load: () => Promise<unknown>) => {
      const sent = recorded.calls.length;
      await load();
      return recorded.calls.slice(sent);
    };
    const inAnyOrder = (calls: unknown[]) => calls.map((call) => JSON.stringify(call)).sort();
    // Health: the forced broker read, then the log-dir read, and no broker config (spec 7.1, KM6).
    const health = [await readsOf(() => provider.getHealth()), await readsOf(() => provider.getHealth())];
    expect(health).toEqual([
      [forcedBrokers, listing, listedTopics, logDirs],
      [forcedBrokers, listing, listedTopics, logDirs],
    ]);
    // Storage: the log-dir read alone.
    const storage = [await readsOf(() => provider.getStorageStats()), await readsOf(() => provider.getStorageStats())];
    expect(storage).toEqual([
      [listing, listedTopics, logDirs],
      [listing, listedTopics, logDirs],
    ]);
    // The overview: the forced broker read first, since its lowest broker is the one whose configs
    // are read, then the topic listing, those configs and the log-dir read, in whatever order they run.
    const overview = [await readsOf(() => provider.getOverview()), await readsOf(() => provider.getOverview())];
    for (const [first, ...rest] of overview) {
      expect(first).toEqual(forcedBrokers);
      expect(inAnyOrder(rest)).toEqual(inAnyOrder([listing, brokerConfigs, listing, listedTopics, logDirs]));
    }
  });

  test("a max.connections the broker publishes as no whole number fails the overview, never reads as no limit", async () => {
    const { provider } = await connected({
      "admin.describeConfigs": (request) => {
        const answer = BROKER_ANSWERS["admin.describeConfigs"](request) as Array<{
          configs: Array<{ name: string; value: string | null }>;
        }>;
        for (const config of answer[0].configs) if (config.name === "max.connections") config.value = "unlimited";
        return answer;
      },
    });
    const error = await provider.getOverview().catch((e) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect(error).toMatchObject({
      provider: "kafka",
      message: "The broker published max.connections as a value that is not a whole number",
    });
  });

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

describe("failures (spec 5.6)", () => {
  /**
   * The words each captured failure reaches a caller in, end to end (spec 5.6): the adapter's own
   * sentence under the error table's class, never the client's message, which can carry a host and
   * port, and the address a connection failure names: the bootstrap's, or the one the broker
   * advertised (K2). One row per capture, held to the captures found by name, so a capture added
   * later needs its row here. Each is thrown at a topic source's config read, which is no fetch, so
   * the two offset refusals name no range: spec 5.6's range belongs to a fetch's refusal. An
   * authorization refusal at that read is the configs part's refusal, in the same words, and no error
   * (spec 4.4), so its row is that part.
   */
  const CAPTURED_WORDS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    "error-authorization": {
      id: "configs",
      label: "Configs that differ from the default",
      unavailable: "The broker denied access to this topic",
    },
    "error-cluster-authorization": {
      id: "configs",
      label: "Configs that differ from the default",
      unavailable: "The broker denied access to this cluster",
    },
    "error-connect-timeout": {
      class: "ConnectionError",
      message:
        "The broker advertised 10.255.255.1:9092, which this server cannot reach; the cluster's advertised listeners must be reachable from where Studio runs",
      host: "10.255.255.1",
      port: 9092,
    },
    "error-connection-closed": {
      class: "ConnectionError",
      message: "The broker could not be reached (connection-lost)",
      host: "localhost",
      port: 9092,
    },
    "error-consumer-group-describe-mixed": {
      class: "QueryError",
      message: "The request to the broker failed (GROUP_ID_NOT_FOUND)",
    },
    "error-leaderless-list-topics": {
      class: "QueryError",
      message: "A partition of the topic has no leader, and the topic cannot be read until every partition has one",
    },
    "error-leaderless-metadata": {
      class: "QueryError",
      message: "A partition of the topic has no leader, and the topic cannot be read until every partition has one",
    },
    "error-offset-out-of-range": { class: "QueryError", message: "The offset is outside the partition's range" },
    "error-refused": {
      class: "ConnectionError",
      message:
        "The broker advertised localhost:19099, which this server cannot reach; the cluster's advertised listeners must be reachable from where Studio runs",
      host: "localhost",
      port: 19099,
    },
    "error-request-timeout": {
      class: "TimeoutError",
      message: "The broker did not answer in time",
      timeout: FAILURE_TIMEOUT_MS,
    },
    "error-requires-tls": {
      class: "ConnectionError",
      message: "The broker requires TLS: turn TLS on for this connection",
      host: "localhost",
      port: 9092,
    },
    "error-sasl": { class: "AuthenticationError", message: "SASL authentication failed" },
    "error-tls-ca": {
      class: "ConnectionError",
      message: "The TLS handshake failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
      host: "localhost",
      port: 9092,
    },
    "error-tls-handshake": {
      class: "ConnectionError",
      message: "The TLS handshake failed: this port may not speak TLS",
      host: "localhost",
      port: 9092,
    },
    "error-topic-authorization": {
      id: "configs",
      label: "Configs that differ from the default",
      unavailable: "The broker denied access to this topic",
    },
    "error-unknown-topic": { class: "QueryError", message: "The topic does not exist" },
    // Redpanda closes the connection on a ConsumerGroupDescribe it does not offer (spec 8).
    "redpanda-error-consumer-group-describe-mixed": {
      class: "ConnectionError",
      message: "The broker could not be reached (connection-lost)",
      host: "localhost",
      port: 9092,
    },
    "redpanda-error-offset-out-of-range": {
      class: "QueryError",
      message: "The offset is outside the partition's range",
    },
    "redpanda-error-unknown-topic": { class: "QueryError", message: "The topic does not exist" },
  };

  test("every captured failure reaches a caller in the error table's words, naming the address the failure names (spec 5.6, K2)", async () => {
    const captures = FAILURES_THROWN.filter((name) => name !== DEFECT);
    expect(Object.keys(CAPTURED_WORDS).sort()).toEqual(captures);
    // A topic source's config read, which every capture fails: no read there is read through.
    const words = await Promise.all(
      captures.map(async (name) => {
        const { provider } = await connectedThenFailing(READS.topicConfigs, libError(name));
        const settled = await settle(() => provider.readObjectSource(["orders"], "topic"));
        // A refusal there is the configs part's own answer (spec 4.4), beside the partitions part.
        if ("value" in settled) return [name, (settled.value as ObjectSourceDocument).parts[1]];
        const {
          class: className,
          message,
          host,
          port,
          timeout,
          provider: stamped,
        } = described(settled.error) as Record<string, unknown>;
        const address = host === undefined && port === undefined ? {} : { host, port };
        return [
          name,
          { class: className, message, ...address, ...(timeout === undefined ? {} : { timeout }), stamped },
        ];
      }),
    );
    // Every error carries the provider's stamp; a refused part is no error and carries none.
    expect(Object.fromEntries(words)).toEqual(
      Object.fromEntries(
        Object.entries(CAPTURED_WORDS).map(([name, said]) => [
          name,
          "class" in said ? { ...said, stamped: "kafka" } : said,
        ]),
      ),
    );
  });

  test("the failures thrown are every capture the fixtures hold, the KM4 refusal among them, and a defect", () => {
    // The control that keeps the matrices below from going vacuous on a renamed fixture directory.
    expect(FAILURES_THROWN).toContain("error-cluster-authorization");
    expect(FAILURES_THROWN).toContain(DEFECT);
    expect(FAILURES_THROWN.length).toBeGreaterThan(2);
    expect(FAILURES_THROWN.filter((name) => name !== DEFECT).every((name) => kafkaFixture(name) !== undefined)).toBe(
      true,
    );
  });

  test.each(BROKER_READS)(
    "%s, when %s meets each captured failure or a defect, answers as the adapter's own read there says: the error table's error, KM4's degraded panel, or the panel a read-through leaves",
    async (_surface, _readName, read, call, expected) => {
      const outcomes = await Promise.all(
        FAILURES_THROWN.map(async (name) => {
          // One failure object, thrown by the provider's library and by the reference's, so a failure
          // that surfaces as itself is known by identity.
          const failure = failureNamed(name);
          const [{ provider }, reference] = await Promise.all([
            connectedThenFailing(read, failure),
            referenceFailing(read, failure),
          ]);
          const want = await expected(reference, provider.getCapabilities(), failure);
          const got = outcomeOf(await settle(() => call(provider)), failure);
          // Where the adapter read the failure through, the panel answering is what is asked of it;
          // what it then answers is the composition's, pinned by the tests of each panel.
          const readThrough = "answered" in want && want.answered === READ_THROUGH && "answered" in got;
          return [name, readThrough ? want : got, want] as const;
        }),
      );
      expect(Object.fromEntries(outcomes.map(([name, got]) => [name, got]))).toEqual(
        Object.fromEntries(outcomes.map(([name, , want]) => [name, want])),
      );
      // The control: at every read, some captured failure fails the surface, so the matrix is no list
      // of read-throughs.
      expect(outcomes.some(([, , want]) => "threw" in want)).toBe(true);
    },
  );

  test.each(BROKER_READS.filter(([, , read]) => read === READS.logDirs || read === READS.brokerConfigs))(
    "%s still answers when %s is refused for want of the cluster ACL (KM4)",
    async (_surface, _readName, read, call, expected) => {
      // What the panel then answers is the matrix's to pin; here, that each captured failure the adapter
      // reads as an authorization refusal at this read degrades the panel rather than failing it (M-I).
      const refused = await Promise.all(
        FAILURES_THROWN.map(async (name) => {
          const failure = failureNamed(name);
          const [setup, reference] = await Promise.all([
            connectedThenFailing(read, failure),
            referenceFailing(read, failure),
          ]);
          const want = await expected(reference, setup.provider.getCapabilities(), failure);
          const got = await settle(() => call(setup.provider));
          // The control: the refused read was asked.
          const asked = setup.recorded.calls.some(([member, args]) => member === read.member && read.carries(args[0]));
          return {
            name,
            degraded: "answered" in want && want.answered !== READ_THROUGH,
            answered: "value" in got,
            asked,
          };
        }),
      );
      const degraded = refused.filter((outcome) => outcome.degraded);
      expect(degraded.map((outcome) => outcome.name)).toEqual([
        "error-authorization",
        "error-cluster-authorization",
        "error-topic-authorization",
      ]);
      for (const outcome of degraded) expect(outcome).toMatchObject({ answered: true, asked: true });
    },
  );

  test.each([...FAILURES_THROWN])(
    "a connect whose forced broker read meets %s answers as the adapter's own read there says: the error table's error with the one client it built closed and none kept, or connected where the adapter reads it through",
    async (name) => {
      const failure = failureNamed(name);
      const failingForced: Record<string, Answer> = {
        "admin.metadata": (...args) => {
          if (READS.forcedBrokers.carries(args[0])) throw failure;
          return metadataFor(args[0]);
        },
      };
      const { provider, recorded, created } = unconnected(failingForced, { queryTimeout: FAILURE_TIMEOUT_MS });
      const reference = await settle(async () =>
        (await referenceFailing(READS.forcedBrokers, failure, false)).metadata([]),
      );
      const got = outcomeOf(await settle(() => provider.connect()), failure);
      expect(created).toHaveLength(1);
      expect(recorded.constructed.map(([built]) => built)).toEqual(LIBRARY_CLIENTS);
      if ("value" in reference) {
        // A leaderless partition's metadata is read through the response its error carries (spec 4.1):
        // the broker answered, so the connect stands.
        expect(got).toEqual({ answered: undefined });
        expect(provider.isConnected()).toBe(true);
        expect(closesOf(recorded.calls)).toEqual([]);
        return;
      }
      expect(got).toEqual(tableAnswer(reference.error, failure));
      expect(closesOf(recorded.calls)).toEqual(["admin.close", "consumer.close", "pool.close"]);
      expect(provider.isConnected()).toBe(false);
      const sent = recorded.calls.length;
      await expect(provider.query('{"topic":"orders"}')).rejects.toThrow("Provider is not connected");
      await provider.disconnect();
      expect(recorded.calls).toHaveLength(sent);
    },
  );

  test("a connect fails on every captured failure but the leaderless partitions the adapter reads through (spec 4.1)", async () => {
    // The control of the test above: its branch that connects is taken only where the adapter's own
    // forced read answers, and a failure it fails on is never one a connect takes for an answer.
    const answered = await Promise.all(
      FAILURES_THROWN.map(async (name) => {
        const reference = await referenceFailing(READS.forcedBrokers, failureNamed(name), false);
        return [name, "value" in (await settle(() => reference.metadata([])))] as const;
      }),
    );
    expect(answered.filter(([, readThrough]) => readThrough).map(([name]) => name)).toEqual([
      "error-leaderless-list-topics",
      "error-leaderless-metadata",
    ]);
  });

  test.each([...FAILURES_THROWN])(
    "a topic listing that meets %s answers the overview as the adapter's listing there does, whichever of its two listings it is: never a count of no topics",
    async (name) => {
      // The overview lists the topics twice, for its count and for the log-dir request, so one listing
      // can fail while the other answers; a count taken from a failed listing would read as 0 topics.
      // Neither listing is a read KM4 degrades, so an authorization refusal of it fails the overview too.
      const outcomes = await Promise.all(
        [1, 2].map(async (failingListing) => {
          const failure = failureNamed(name);
          let listings = 0;
          const { provider } = await connected(
            {
              "admin.listTopics": () => {
                listings++;
                if (listings === failingListing) throw failure;
                return kafkaFixture("list-topics");
              },
            },
            FAILURE_TIMEOUT_MS,
          );
          const reference = await referenceFailing(READS.topicListing, failure);
          const want = await settle(() => reference.listTopics());
          const got = outcomeOf(await settle(() => provider.getOverview()), failure);
          return { want, got, failure, listings };
        }),
      );
      for (const { want, got, failure, listings } of outcomes) {
        // A listing the adapter reads through is no failure, so the overview answers; any other fails it.
        if ("value" in want) expect("answered" in got).toBe(true);
        else expect(got).toEqual(tableAnswer(want.error, failure));
        // The control: both listings were asked, so the other one answered.
        expect(listings).toBe(2);
      }
    },
  );

  test.each([...FAILURES_THROWN])(
    "countObjects, when the topic listing meets %s, answers what objects.ts answers over the adapter's failing listing",
    async (name) => {
      const failure = failureNamed(name);
      const [{ provider }, reference] = await Promise.all([
        connectedThenFailing(READS.topicListing, failure),
        referenceFailing(READS.topicListing, failure),
      ]);
      const want = await settle(() => kafkaObjects.countObjects(reference, []));
      const got = outcomeOf(await settle(() => provider.countObjects([])), failure);
      expect(got).toEqual("value" in want ? { answered: want.value } : tableAnswer(want.error, failure));
    },
  );
});

describe("delegation (spec 3.5)", () => {
  // index.ts composes and delegates: each of these surfaces answers what the module that owns it
  // answers over a client in the same state, and makes exactly the reads that module makes, on every
  // call. So anything the provider put between the caller and the module (a read of its own, an
  // argument changed, an answer reshaped or kept for the next call) shows here, whichever it is.
  /** A call's arguments, compared across two recorded libraries: each hands out objects whose functions are its own. */
  const comparable = (value: unknown): unknown => {
    if (typeof value === "function") return "[function]";
    if (Array.isArray(value)) return value.map(comparable);
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, comparable(member)]));
    }
    return value;
  };
  const WHOLE_PARTITION = '{"topic":"codec-gzip","from":"earliest","limit":3}';
  const FROM_AN_OFFSET = '{"topic":"orders","partition":1,"from":{"offset":5},"limit":2}';
  const CUT_TO_THE_CELL = '{"topic":"big","from":"earliest","limit":1}';

  const DELEGATIONS: ReadonlyArray<
    readonly [
      surface: string,
      viaProvider: (provider: KafkaProvider) => Promise<unknown>,
      viaModule: (client: KafkaReadClient, capabilities: ProviderCapabilities) => Promise<unknown>,
    ]
  > = [
    ["query, a whole partition", (p) => p.query(WHOLE_PARTITION).then(untimed), composedReadOf(WHOLE_PARTITION)],
    [
      "query, from an offset and cut by its limit",
      (p) => p.query(FROM_AN_OFFSET).then(untimed),
      composedReadOf(FROM_AN_OFFSET),
    ],
    [
      "query, a record cut to the cell limit",
      (p) => p.query(CUT_TO_THE_CELL).then(untimed),
      composedReadOf(CUT_TO_THE_CELL),
    ],
    ["countObjects", (p) => p.countObjects([]), (c) => kafkaObjects.countObjects(c, [])],
    ...kafkaObjects.KAFKA_OBJECT_KINDS.map(
      (kind) =>
        [
          `listObjects of ${kind.id}`,
          (p: KafkaProvider) => p.listObjects([], kind.id),
          (c: KafkaReadClient) => kafkaObjects.listObjects(c, [], kind.id),
        ] as const,
    ),
    [
      "describeObject",
      (p) => p.describeObject(["orders"], "topic"),
      (c, capabilities) => kafkaObjects.describeObject(c, capabilities, ["orders"], "topic"),
    ],
    ["describeObjects", (p) => p.describeObjects([], "topic"), (c) => kafkaObjects.describeObjects(c, [], "topic")],
    [
      "describeObjects, bounded by the caller",
      (p) => p.describeObjects([], "topic", 3),
      (c) => kafkaObjects.describeObjects(c, [], "topic", 3),
    ],
    [
      "readObjectSource of a topic, bounded by the caller",
      (p) => p.readObjectSource(["orders"], "topic", 40),
      (c, capabilities) => kafkaObjects.readObjectSource(c, capabilities, ["orders"], "topic", 40),
    ],
    [
      "readObjectSource of a classic group",
      (p) => p.readObjectSource(["lag-classic"], "consumer_group"),
      (c, capabilities) => kafkaObjects.readObjectSource(c, capabilities, ["lag-classic"], "consumer_group"),
    ],
    [
      "readObjectSource of a consumer-protocol group",
      (p) => p.readObjectSource(["lag-kip848"], "consumer_group"),
      (c, capabilities) => kafkaObjects.readObjectSource(c, capabilities, ["lag-kip848"], "consumer_group"),
    ],
    [
      "readObjectSource of a broker",
      (p) => p.readObjectSource(["1"], "broker"),
      (c, capabilities) => kafkaObjects.readObjectSource(c, capabilities, ["1"], "broker"),
    ],
  ];

  test.each(DELEGATIONS)(
    "%s answers what its module answers, with the same reads, on every call",
    async (_surface, viaProvider, viaModule) => {
      const { provider, recorded } = await connected();
      const capabilities = provider.getCapabilities();
      const reference = brokerLib();
      const client = createPlatformaticClient(kafkaConnectionOptions(CONNECTION, FAILURE_TIMEOUT_MS), reference.lib);
      // The provider's client made connect's forced broker read, so this one makes it too: both start alike.
      await client.metadata([]);
      const compareOneCall = async () => {
        const [sent, referenceSent] = [recorded.calls.length, reference.calls.length];
        expect(await viaProvider(provider)).toEqual(await viaModule(client, capabilities));
        const reads = recorded.calls.slice(sent);
        expect(comparable(reads)).toEqual(comparable(reference.calls.slice(referenceSent)));
        // The control: the module read the broker, so an equal trace is not two empty ones.
        expect(reads.length).toBeGreaterThan(0);
      };
      await compareOneCall();
      await compareOneCall();
    },
  );
});
