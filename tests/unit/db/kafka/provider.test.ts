/**
 * KafkaProvider at its own seam (issue #1088, spec 3.5 and 10).
 *
 * index.ts composes and delegates, and each rule it owns is a rule over a whole domain: every failure
 * a client call can answer, every read a panel makes, every answer a module gives, every query
 * timeout. The integration test (tests/integration/db/kafka-provider.test.ts) runs the provider over
 * the real adapter and the captured broker, so it reaches only what the captures and the adapter
 * make: ten of the fourteen KafkaError categories, some of them only at some reads, and answers that
 * hold only the parts the captures hold. This file tests the same rules where index.ts meets its one
 * dependency, the KafkaReadClient interface (spec 3.5, dependency inversion), where each domain can
 * be written out whole:
 * - every KafkaErrorCategory, listed from a Record that tsc holds to the union, and three failures
 *   that are not a refusal: a validator's DatabaseConfigError no provider stamped, a defect, and a
 *   defect that carries an authorization refusal's category without being one;
 * - every read each monitoring panel makes (spec 7.1), failed alone, and with the other KM4 read refused;
 * - every module answer, by identity: the module functions index.ts calls are spied with spyOn and
 *   answer objects of this file's own, and the provider must hand back those very objects and hand
 *   the modules the very objects it was given, so a composition that reshapes any part of an answer
 *   fails, whichever part it is (spec 3.5);
 * - query timeouts on both sides of every clamp a deadline could hide behind.
 * The fake client records every call and answers objects of this file's own; it keeps the client's
 * contract (brokers in node-id order). Every spy is restored after its test. No mock.module(): it is
 * process-wide in bun.
 *
 * A section number below, "spec 7.1" for example, is a section of #1088's design; an IX number is a
 * rule of plan Task 16's list "Rules index.ts owns".
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import {
  type KafkaBroker,
  type KafkaClusterMetadata,
  type KafkaConfigEntry,
  KafkaError,
  type KafkaErrorCategory,
  type KafkaLogDir,
  type KafkaReadClient,
  type KafkaTopicMetadata,
} from "@/lib/db/providers/stream/kafka/client";
import {
  type KafkaConnectionOptions,
  kafkaConnectionOptions,
} from "@/lib/db/providers/stream/kafka/connection-options";
import { toDatabaseError } from "@/lib/db/providers/stream/kafka/errors";
import * as monitoringModule from "@/lib/db/providers/stream/kafka/monitoring";
import * as objectsModule from "@/lib/db/providers/stream/kafka/objects";
import * as readModule from "@/lib/db/providers/stream/kafka/read";
import * as requestModule from "@/lib/db/providers/stream/kafka/request";
import * as resultsModule from "@/lib/db/providers/stream/kafka/results";
import {
  type Container,
  DEFAULT_QUERY_TIMEOUT,
  type DatabaseObject,
  type DatabaseOverview,
  type HealthInfo,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectSourceDocument,
  type ProviderOptions,
  type QueryResult,
  type StorageStats,
} from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection } from "@/lib/types";

// ============================================================================
// The domains
// ============================================================================

/**
 * Every category the seam defines. A Record over the union, so tsc refuses this list when the union
 * gains a category it does not hold, or when it holds one the union lacks.
 */
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

type Failure = readonly [label: string, make: () => unknown];

/**
 * Every failure a client call or a module can answer, each built fresh: a refusal of every category,
 * carrying every detail a refusal can carry (an advertised address above all), and the three that
 * are not a refusal. Only the authorization refusal is the one KM4 degrades on.
 */
const FAILURES: readonly Failure[] = [
  ...CATEGORIES.map(
    (category): Failure => [
      `the ${category} refusal`,
      () =>
        new KafkaError(category, `the client's ${category} refusal`, {
          apiId: "SOME_API_ERROR",
          host: "broker-9.internal",
          port: 19092,
          nodeCode: "ESOME",
        }),
    ],
  ),
  ["a DatabaseConfigError no provider stamped", () => new DatabaseConfigError("a shared validator's refusal")],
  ["a defect of the provider's own", () => new TypeError("a defect, not a refusal")],
  [
    "a defect that carries an authorization refusal's category",
    () => Object.assign(new Error("not a KafkaError"), { category: "authorization" }),
  ],
];

/** KM4's one degrading failure (spec 11): an authorization refusal, and nothing merely shaped like one. */
const isAuthorizationRefusal = (failure: unknown) =>
  failure instanceof KafkaError && failure.category === "authorization";

/**
 * Typed as a user types it: a host in capitals and no port. The address the provider validated,
 * lower-cased and with the default port, is the one a failure must carry, so the two are told apart.
 */
const CONNECTION = {
  id: "k1",
  name: "kafka",
  type: "kafka",
  host: "Broker-1.Example",
  createdAt: new Date(),
} as unknown as DatabaseConnection;

/** Not the product's default, so a timeout written as a constant is told apart from the connection's own. */
const QUERY_TIMEOUT_MS = 4321;
const VALIDATED = kafkaConnectionOptions(CONNECTION, QUERY_TIMEOUT_MS);

/**
 * Query timeouts on both sides of each bound a deadline could be clamped to (a floor of half a second,
 * a ceiling of thirty seconds, the default itself), and the product's default, which a provider built
 * with no timeout takes.
 */
const QUERY_TIMEOUTS = [
  undefined,
  1,
  50,
  499,
  500,
  501,
  29_999,
  30_000,
  30_001,
  DEFAULT_QUERY_TIMEOUT - 1,
  DEFAULT_QUERY_TIMEOUT + 1,
  120_000,
].map((timeout) => [timeout === undefined ? "the default" : `${timeout} ms`, timeout] as const);

// ============================================================================
// The client this file builds the provider over
// ============================================================================

const broker = (nodeId: number): KafkaBroker => ({ nodeId, host: `broker-${nodeId}`, port: 9092, rack: null });
const topicNamed = (name: string): KafkaTopicMetadata => ({
  name,
  id: `id-${name}`,
  partitions: [{ partition: 0, leader: 2, leaderEpoch: 0, replicas: [2], isr: [2], offlineReplicas: [] }],
});

/**
 * The forced broker read: the live brokers in node-id order, as the client lists them, and a
 * controller that is not the lowest, since KRaft answers a random live broker there (spec 4.1).
 */
const FORCED: KafkaClusterMetadata = {
  clusterId: "c",
  controllerId: 4,
  brokers: [broker(2), broker(3), broker(4)],
  topics: [],
};
/**
 * The listed topics' metadata, the read the log-dir request names: two topics where the listing names
 * three, so a count taken from it is told apart from the listing's, and a copy that still lists broker
 * 1, which has left, so a broker taken from it is told apart from the forced read's.
 */
const LISTED: KafkaClusterMetadata = {
  clusterId: "c",
  controllerId: 4,
  brokers: [broker(1), broker(2), broker(3), broker(4)],
  topics: [topicNamed("a"), topicNamed("b")],
};
const TOPIC_NAMES = ["a", "b", "c"];
const BROKER_CONFIGS: KafkaConfigEntry[] = [
  { name: "max.connections", value: "100", readOnly: false, isSensitive: false, source: 4 },
];
const LOG_DIRS: KafkaLogDir[] = [
  { brokerId: 2, path: "/var/kafka", sizeBytes: BigInt(2048), totalBytes: BigInt(8192), usableBytes: BigInt(2048) },
];

type Method = keyof KafkaReadClient;
type Call = [method: Method, args: unknown[]];

/** One read a panel makes, as spec 7.1 names it, and which calls of one client method carry it. */
interface ClientRead {
  readonly name: string;
  readonly method: Method;
  readonly carries: (args: readonly unknown[]) => boolean;
}
const READS = {
  forcedBrokers: {
    name: "the forced broker read",
    method: "metadata",
    carries: (args) => Array.isArray(args[0]) && args[0].length === 0,
  },
  listedTopics: { name: "the listed topics' metadata", method: "metadata", carries: (args) => args[0] === undefined },
  topicListing: { name: "the topic listing", method: "listTopics", carries: () => true },
  brokerConfigs: { name: "the lowest broker's configs", method: "brokerConfigs", carries: () => true },
  logDirs: { name: "the log dirs", method: "logDirs", carries: () => true },
} satisfies Record<string, ClientRead>;

interface FakeClient {
  readonly client: KafkaReadClient;
  readonly calls: Call[];
  /** From now on, every call that carries `read` fails with `failure`, and every other call is answered. */
  fail(read: ClientRead, failure: unknown): void;
}

/** A KafkaReadClient that records every call and answers this file's own objects, or `answers` where given. */
function fakeClient(answers: Partial<KafkaReadClient> = {}): FakeClient {
  const calls: Call[] = [];
  const failing: Array<{ read: ClientRead; failure: unknown }> = [];
  const call = async (method: Method, args: unknown[], fallback: () => unknown): Promise<never> => {
    calls.push([method, args]);
    const failed = failing.find(({ read }) => read.method === method && read.carries(args));
    if (failed !== undefined) throw failed.failure;
    const answer = answers[method] as ((...values: unknown[]) => unknown) | undefined;
    return (await (answer === undefined ? fallback() : answer(...args))) as never;
  };
  const client: KafkaReadClient = {
    metadata: (...args) =>
      call("metadata", args, () => {
        const [topics] = args;
        if (topics === undefined) return LISTED;
        if (topics.length === 0) return FORCED;
        return { ...LISTED, topics: topics.map(topicNamed) };
      }),
    listTopics: (...args) => call("listTopics", args, () => [...TOPIC_NAMES]),
    offsets: (...args) => call("offsets", args, () => new Map([[0, BigInt(0)]])),
    offsetsForTimestamp: (...args) => call("offsetsForTimestamp", args, () => new Map([[0, BigInt(0)]])),
    fetch: (...args) => call("fetch", args, () => ({ records: [], nextOffset: args[2] })),
    topicConfigs: (...args) => call("topicConfigs", args, () => []),
    brokerConfigs: (...args) => call("brokerConfigs", args, () => BROKER_CONFIGS),
    listGroups: (...args) => call("listGroups", args, () => []),
    describeGroup: (...args) =>
      call("describeGroup", args, () => ({
        groupId: args[0].groupId,
        groupType: args[0].groupType,
        state: "Empty",
        protocolOrAssignor: "",
        members: [],
      })),
    committedOffsets: (...args) => call("committedOffsets", args, () => []),
    logDirs: (...args) => call("logDirs", args, () => LOG_DIRS),
    close: (...args) => call("close", args, () => undefined),
  };
  return { client, calls, fail: (read, failure) => failing.push({ read, failure }) };
}

/** A provider over fake clients, not yet connected, with every client its factory built and every options object it was handed. */
function providerOver(
  options: ProviderOptions = { queryTimeout: QUERY_TIMEOUT_MS },
  answers?: Partial<KafkaReadClient>,
) {
  const built: FakeClient[] = [];
  const handed: KafkaConnectionOptions[] = [];
  const provider = new KafkaProvider(CONNECTION, options, async (clientOptions) => {
    handed.push(clientOptions);
    const fake = fakeClient(answers);
    built.push(fake);
    return fake.client;
  });
  return { provider, built, handed };
}

async function connectedOver(options?: ProviderOptions, answers?: Partial<KafkaReadClient>) {
  const setup = providerOver(options, answers);
  await setup.provider.connect();
  const [fake] = setup.built;
  // Only what the surface under test sends is compared: connect's own round trip is left behind.
  fake.calls.length = 0;
  return { ...setup, fake };
}

// ============================================================================
// Spies, and outcomes compared whole
// ============================================================================

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** A spy seen through the members this file uses, whatever the signature of the function it spies on. */
interface LooseSpy {
  mockResolvedValue(value: unknown): LooseSpy;
  mockResolvedValueOnce(value: unknown): LooseSpy;
  mockRejectedValue(value: unknown): LooseSpy;
  mockReturnValue(value: unknown): LooseSpy;
  mockReturnValueOnce(value: unknown): LooseSpy;
  mockImplementation(run: (...args: never[]) => unknown): LooseSpy;
  mockReset(): LooseSpy;
  mockClear(): LooseSpy;
  readonly mock: { readonly calls: unknown[][]; readonly results: Array<{ readonly value: unknown }> };
}
/** Spies on one function of a module (or on AbortSignal.timeout, Date.now or console.error), restored after the test. */
function spyOnly(target: object, key: string): LooseSpy {
  const spy = spyOn(target as Record<string, (...args: never[]) => unknown>, key);
  spies.push(spy);
  return spy as unknown as LooseSpy;
}

/** An error as a caller reads it: its class, its message and every field it carries. */
const described = (error: unknown) =>
  error instanceof Error ? { ...error, class: error.constructor.name, message: error.message } : { value: error };

/** What a call came to: what it answered, or what it threw, where a failure that surfaced as itself says so. */
async function outcomeOf(run: () => Promise<unknown>, failure: unknown): Promise<unknown> {
  try {
    return { answered: await run() };
  } catch (error) {
    return error === failure ? { threw: "the failure itself" } : { threw: described(error) };
  }
}

/**
 * The error table's answer to a failure (spec 5.6), with the address the connection validated and the
 * query timeout, as a caller must meet it: a failure the table answers as itself surfaces as itself.
 */
function tableAnswer(failure: unknown, timeoutMs = QUERY_TIMEOUT_MS): unknown {
  const answer = toDatabaseError(failure, VALIDATED.broker, timeoutMs);
  return answer === failure ? { threw: "the failure itself" } : { threw: described(answer) };
}

/** The base's refusal of a surface asked before connect() or after disconnect(), stamped with the connection's type. */
const NOT_CONNECTED = {
  threw: described(new DatabaseConfigError("Provider is not connected. Call connect() first.", CONNECTION.type)),
};

// ============================================================================
// The domains themselves
// ============================================================================

describe("the domains this file walks", () => {
  test("every category the seam defines, once each, and the error table answers each with an error class of its own", () => {
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
    for (const category of CATEGORIES) {
      const refusal = new KafkaError(category, "a refusal");
      const answer = toDatabaseError(refusal, VALIDATED.broker, QUERY_TIMEOUT_MS);
      expect(answer).not.toBe(refusal);
      expect(answer).not.toBeInstanceOf(KafkaError);
    }
    // The control: of every failure below, only the authorization refusal is the one KM4 degrades on.
    expect(
      FAILURES.map(([label, make]) => [label, isAuthorizationRefusal(make())]).filter(([, degrades]) => degrades),
    ).toEqual([["the authorization refusal", true]]);
  });

  test("every method the provider defines is classified, so no surface escapes the tables below", () => {
    const classified = {
      // Declarations and lifecycle: "connect" below, and the integration test's "declarations" and
      // "connect and disconnect" blocks.
      lifecycle: ["constructor", "getCapabilities", "getLabels", "connect", "disconnect"],
      // What the composition keeps to itself.
      helpers: ["bootstrap", "guarded", "readLogDirs", "readBrokerConfigs"],
      // Failed at every step, and compared by identity, below.
      read: ["query"],
      objectSurface: [...new Set(OBJECT_SURFACES.map(([, surface]) => surface))],
      readingPanels: PANELS.map(([panel]) => panel),
      // Read nothing and answer the protocol's honest absences: "listContainers answers ..." below, and
      // the integration test's "storage comes from the log dirs; the surfaces the protocol cannot fill
      // are empty; maintenance is refused".
      noRead: [
        "listContainers",
        "getPerformanceMetrics",
        "getSlowQueries",
        "getActiveSessions",
        "getTableStats",
        "getIndexStats",
        "runMaintenance",
      ],
    };
    expect(Object.getOwnPropertyNames(KafkaProvider.prototype).sort()).toEqual(Object.values(classified).flat().sort());
  });
});

// ============================================================================
// connect (IX-03 to IX-05)
// ============================================================================

describe("connect", () => {
  test.each(QUERY_TIMEOUTS)(
    "with a query timeout of %s, builds one client from the options the connection validates and proves the broker with one forced read before it counts as connected",
    async (_label, timeout) => {
      let connectedDuringRead: boolean | undefined;
      const { provider, built, handed } = providerOver(timeout === undefined ? {} : { queryTimeout: timeout }, {
        metadata: async () => {
          connectedDuringRead = provider.isConnected();
          return FORCED;
        },
      });
      await provider.connect();
      // The factory was handed exactly the validated options, whose client timeouts are the query timeout.
      expect(handed).toEqual([kafkaConnectionOptions(CONNECTION, timeout ?? DEFAULT_QUERY_TIMEOUT)]);
      expect(built).toHaveLength(1);
      expect(built[0].calls).toEqual([["metadata", [[]]]]);
      expect(connectedDuringRead).toBe(false);
      expect(provider.isConnected()).toBe(true);
      // It keeps that client: the next surface hands its module the very client the factory built.
      const listObjects = spyOnly(objectsModule, "listObjects").mockResolvedValue([]);
      await provider.listObjects([], "topic");
      expect(listObjects.mock.calls[0][0]).toBe(built[0].client);
    },
  );

  test.each(FAILURES)(
    "a connect whose forced read meets %s answers the table's error once the client it built is closed, and keeps none",
    async (_label, make) => {
      const failure = make();
      let closed = false;
      const { provider, built } = providerOver(undefined, {
        metadata: async () => {
          throw failure;
        },
        // A close that finishes a turn of the event loop later, so a connect that answers before its
        // client's sockets are closed is seen.
        close: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          closed = true;
        },
      });
      const outcome = await outcomeOf(() => provider.connect(), failure);
      expect(closed).toBe(true);
      expect(outcome).toEqual(tableAnswer(failure));
      expect(built).toHaveLength(1);
      expect(built[0].calls).toEqual([
        ["metadata", [[]]],
        ["close", []],
      ]);
      expect(provider.isConnected()).toBe(false);
      // It holds no client: a surface refuses and sends nothing, and a disconnect closes nothing more.
      expect(await outcomeOf(() => provider.listObjects([], "topic"), undefined)).toEqual(NOT_CONNECTED);
      await provider.disconnect();
      expect(built[0].calls).toHaveLength(2);
    },
  );

  test.each(FAILURES)(
    "a connect whose client factory meets %s answers the table's error, with nothing to close",
    async (_label, make) => {
      const failure = make();
      const provider = new KafkaProvider(CONNECTION, { queryTimeout: QUERY_TIMEOUT_MS }, async () => {
        throw failure;
      });
      expect(await outcomeOf(() => provider.connect(), failure)).toEqual(tableAnswer(failure));
      expect(provider.isConnected()).toBe(false);
      expect(await outcomeOf(() => provider.getHealth(), undefined)).toEqual(NOT_CONNECTED);
    },
  );

  test.each(FAILURES)(
    "a close that fails after a connect met %s is logged, and the connect still answers its own failure",
    async (_label, make) => {
      const failure = make();
      const logged = spyOnly(console, "error").mockImplementation(() => {});
      const { provider, built } = providerOver(undefined, {
        metadata: async () => {
          throw failure;
        },
        close: async () => {
          throw new Error("close refused");
        },
      });
      expect(await outcomeOf(() => provider.connect(), failure)).toEqual(tableAnswer(failure));
      expect(built[0].calls.map(([method]) => method)).toEqual(["metadata", "close"]);
      expect(logged.mock.calls).toEqual([["[DB:kafka] connect cleanup failed: close refused"]]);
    },
  );
});

// ============================================================================
// query (IX-09 to IX-14, IX-24)
// ============================================================================

describe("query", () => {
  const TEXT = '{"topic":"orders","from":"earliest"}';
  /** The limit the parsed request carries, which is not the parser's maximum, so the two are told apart. */
  const REQUEST_LIMIT = 3;
  const EMPTY_OUTCOME: readModule.ReadOutcome = { rows: [], warnings: [], wasLimited: false };

  /**
   * Every part a read's outcome carries, each independently in every state it can take: limited or
   * not, warnings or none, and rows or none, where the rows are exactly the request's limit and hold a
   * tombstone (a null value) and keyless records.
   */
  const OUTCOMES = [false, true].flatMap((wasLimited) =>
    [0, 2].flatMap((warningCount) =>
      [0, REQUEST_LIMIT].map((rowCount) => {
        const make = (): readModule.ReadOutcome => ({
          rows: Array.from({ length: rowCount }, (_, i) => ({
            offset: String(i),
            key: null,
            value: i === 0 ? null : { i },
          })),
          warnings: Array.from({ length: warningCount }, (_, i) => ({ message: `warning ${i}` })),
          wasLimited,
        });
        return [
          `${wasLimited ? "limited" : "not limited"}, with ${warningCount} warnings and ${rowCount} rows`,
          make,
        ] as const;
      }),
    ),
  );

  test.each(OUTCOMES)(
    "a read whose outcome is %s answers toQueryResult's own answer over that outcome's own parts, on every call",
    async (_label, make) => {
      const { provider, fake } = await connectedOver();
      let now = 1_790_000_000_000;
      spyOnly(Date, "now").mockImplementation(() => now);
      const parse = spyOnly(requestModule, "parseReadRequest");
      const readMessages = spyOnly(readModule, "readMessages");
      const toQueryResult = spyOnly(resultsModule, "toQueryResult");
      const deadline = spyOnly(AbortSignal, "timeout");
      /** One read, with objects of its own, so an answer kept from a call before would show. */
      const oneRead = async (label: string) => {
        const request: requestModule.ReadRequest = {
          topic: "orders",
          from: { kind: "earliest" },
          limit: REQUEST_LIMIT,
        };
        const outcome = make();
        const answer: QueryResult = { rows: [{ label }], fields: [label], rowCount: 1, executionTime: -1 };
        parse.mockReset().mockReturnValue(request);
        // The clock moves only while the read runs, so its span is the one right execution time.
        readMessages.mockReset().mockImplementation(async () => {
          now += 42;
          return outcome;
        });
        toQueryResult.mockReset().mockReturnValue(answer);
        deadline.mockClear();
        expect(await provider.query(TEXT)).toBe(answer);
        expect(parse.mock.calls).toEqual([[TEXT, DEFAULT_QUERY_LIMIT]]);
        expect(readMessages.mock.calls).toHaveLength(1);
        const [client, handedRequest, limits, signal] = readMessages.mock.calls[0];
        expect(client).toBe(fake.client);
        expect(handedRequest).toBe(request);
        expect(limits).toEqual({
          resultByteBudget: readModule.KAFKA_RESULT_BYTE_BUDGET,
          cellLimit: readModule.KAFKA_CELL_LIMIT,
        });
        expect(signal).toBe(deadline.mock.results[0].value);
        expect(toQueryResult.mock.calls).toHaveLength(1);
        const [rows, executionTime, limit, warnings, wasLimited] = toQueryResult.mock.calls[0];
        expect(rows).toBe(outcome.rows);
        expect(executionTime).toBe(42);
        expect(limit).toBe(REQUEST_LIMIT);
        expect(warnings).toBe(outcome.warnings);
        expect(wasLimited).toBe(outcome.wasLimited);
        // The provider reads nothing of its own: the read module is the one that reads the broker.
        expect(fake.calls).toEqual([]);
      };
      await oneRead("the first read");
      await oneRead("the second read");
    },
  );

  test.each(QUERY_TIMEOUTS)(
    "with a query timeout of %s, each read runs under its own deadline of AbortSignal.timeout of exactly that timeout, and its timeout refusal carries it",
    async (_label, timeout) => {
      const queryTimeout = timeout ?? DEFAULT_QUERY_TIMEOUT;
      const { provider } = await connectedOver(timeout === undefined ? {} : { queryTimeout: timeout });
      const deadline = spyOnly(AbortSignal, "timeout");
      const readMessages = spyOnly(readModule, "readMessages").mockResolvedValue(EMPTY_OUTCOME);
      await provider.query(TEXT);
      await provider.query(TEXT);
      expect(deadline.mock.calls).toEqual([[queryTimeout], [queryTimeout]]);
      expect(readMessages.mock.calls[0][3]).toBe(deadline.mock.results[0].value);
      expect(readMessages.mock.calls[1][3]).toBe(deadline.mock.results[1].value);
      expect(readMessages.mock.calls[1][3]).not.toBe(readMessages.mock.calls[0][3]);
      // A read its deadline stopped is a TimeoutError carrying that same timeout (spec 5.6).
      const stopped = new KafkaError("timeout", "The read ran past its time limit and was stopped");
      readMessages.mockRejectedValue(stopped);
      expect(await outcomeOf(() => provider.query(TEXT), stopped)).toEqual(tableAnswer(stopped, queryTimeout));
    },
  );

  /** Each step of a read, and how it is made to fail while the steps before it answer. */
  const STEPS: ReadonlyArray<readonly [step: string, failWith: (failure: unknown) => void]> = [
    [
      "the parse",
      (failure) => {
        spyOnly(requestModule, "parseReadRequest").mockImplementation(() => {
          throw failure;
        });
      },
    ],
    [
      "the read",
      (failure) => {
        spyOnly(readModule, "readMessages").mockRejectedValue(failure);
      },
    ],
    [
      "the shaping",
      (failure) => {
        spyOnly(readModule, "readMessages").mockResolvedValue(EMPTY_OUTCOME);
        spyOnly(resultsModule, "toQueryResult").mockImplementation(() => {
          throw failure;
        });
      },
    ],
  ];

  test.each(
    STEPS.flatMap(([step, failWith]) => FAILURES.map(([label, make]) => [step, label, failWith, make] as const)),
  )("%s meeting %s fails the read with the table's error", async (_step, _label, failWith, make) => {
    const failure = make();
    const { provider } = await connectedOver();
    failWith(failure);
    expect(await outcomeOf(() => provider.query(TEXT), failure)).toEqual(tableAnswer(failure));
  });
});

// ============================================================================
// The object surface (IX-15, IX-24)
// ============================================================================

type ObjectSurface = readonly [
  label: string,
  surface: "countObjects" | "listObjects" | "describeObject" | "describeObjects" | "readObjectSource",
  call: (provider: KafkaProvider) => Promise<unknown>,
  /** What the module must be handed: the provider's client, its declarations where the module reads them, and the caller's arguments. */
  handed: (client: KafkaReadClient, capabilities: ReturnType<KafkaProvider["getCapabilities"]>) => unknown[],
  answer: () => unknown,
];
/** Arguments no real module would accept, so only a pass-through hands them on unchanged. */
const CONTAINER = ["a-container"];
const PATH = ["a-topic", "a-part"];
const KIND = "a-kind";
const SOURCE_PART: ObjectSourceDocument["parts"][number] = {
  id: "p",
  label: "P",
  text: "{}",
  language: "json",
  form: "complete",
  origin: "rendered",
};
const OBJECT_SURFACES: readonly ObjectSurface[] = [
  [
    "countObjects",
    "countObjects",
    (p) => p.countObjects(CONTAINER),
    (c) => [c, CONTAINER],
    (): Record<string, KindCount> => ({
      topic: { count: 2000, sampledFrom: "a floor" },
      broker: { unavailable: "no" },
    }),
  ],
  [
    "listObjects",
    "listObjects",
    (p) => p.listObjects(CONTAINER, KIND),
    (c) => [c, CONTAINER, KIND],
    (): DatabaseObject[] => [{ path: ["t"], name: "t", kind: "topic", status: "offline" }],
  ],
  [
    "describeObject",
    "describeObject",
    (p) => p.describeObject(PATH, KIND),
    (c, capabilities) => [c, capabilities, PATH, KIND],
    (): ObjectDetail => ({ path: ["t"], columns: [], indexes: [], foreignKeys: [] }),
  ],
  [
    "describeObjects with no bound",
    "describeObjects",
    (p) => p.describeObjects(CONTAINER, KIND),
    (c) => [c, CONTAINER, KIND, undefined],
    (): ObjectDetailBatch => ({ details: [], truncated: { limit: 0, reason: "a reason" } }),
  ],
  [
    "describeObjects bounded by the caller",
    "describeObjects",
    (p) => p.describeObjects(CONTAINER, KIND, 7),
    (c) => [c, CONTAINER, KIND, 7],
    (): ObjectDetailBatch => ({ details: [] }),
  ],
  [
    "readObjectSource with no bound",
    "readObjectSource",
    (p) => p.readObjectSource(PATH, KIND),
    (c, capabilities) => [c, capabilities, PATH, KIND, undefined],
    (): ObjectSourceDocument => ({ path: ["t"], kind: "topic", parts: [SOURCE_PART] }),
  ],
  [
    "readObjectSource bounded by the caller",
    "readObjectSource",
    (p) => p.readObjectSource(PATH, KIND, 40),
    (c, capabilities) => [c, capabilities, PATH, KIND, 40],
    (): ObjectSourceDocument => ({
      path: ["t"],
      kind: "topic",
      parts: [{ ...SOURCE_PART, truncated: { limit: 40, reason: "a reason" } }],
    }),
  ],
];

describe("the object surface", () => {
  test.each(OBJECT_SURFACES)(
    "%s answers the very object objects.ts answers, handed the caller's arguments and the provider's client, on every call",
    async (_label, surface, call, handed, answer) => {
      const { provider, fake } = await connectedOver();
      const [first, second] = [answer(), answer()];
      const owner = spyOnly(objectsModule, surface).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      expect(await call(provider)).toBe(first);
      expect(await call(provider)).toBe(second);
      const expected = handed(fake.client, provider.getCapabilities());
      expect(owner.mock.calls).toEqual([expected, expected]);
      for (const args of owner.mock.calls) expect(args[0]).toBe(fake.client);
      // The provider reads nothing of its own: objects.ts is the one that reads the broker.
      expect(fake.calls).toEqual([]);
    },
  );

  test("listContainers answers the very list objects.ts answers, on every call, and reads nothing", async () => {
    const { provider, fake } = await connectedOver();
    const [first, second]: Container[][] = [[], []];
    const owner = spyOnly(objectsModule, "listContainers").mockReturnValueOnce(first).mockReturnValueOnce(second);
    expect(await provider.listContainers()).toBe(first);
    expect(await provider.listContainers()).toBe(second);
    expect(owner.mock.calls).toEqual([[], []]);
    expect(fake.calls).toEqual([]);
  });

  test.each(
    OBJECT_SURFACES.flatMap(([label, surface, call]) =>
      FAILURES.map(([failureLabel, make]) => [label, failureLabel, surface, call, make] as const),
    ),
  )(
    "%s, when objects.ts meets %s, fails with the table's error",
    async (_label, _failureLabel, surface, call, make) => {
      const failure = make();
      const { provider } = await connectedOver();
      spyOnly(objectsModule, surface).mockRejectedValue(failure);
      expect(await outcomeOf(() => call(provider), failure)).toEqual(tableAnswer(failure));
    },
  );
});

// ============================================================================
// The monitoring panels (IX-16 to IX-22, IX-24)
// ============================================================================

type Panel = "getHealth" | "getOverview" | "getStorageStats";
/**
 * Each panel that reads the broker, the reads spec 7.1 gives it, and for the reads an authorization
 * refusal degrades (KM4), the panel's answer then: its mapping's answer with that one read's answer
 * replaced by the absence it degrades to, and every other read's answer kept.
 */
const PANELS: ReadonlyArray<
  readonly [panel: Panel, reads: ReadonlyArray<readonly [read: ClientRead, degradedAnswer?: () => unknown]>]
> = [
  [
    "getHealth",
    [[READS.forcedBrokers], [READS.listedTopics], [READS.logDirs, () => monitoringModule.healthFrom(undefined)]],
  ],
  [
    "getOverview",
    [
      [READS.forcedBrokers],
      [READS.topicListing],
      [READS.listedTopics],
      [
        READS.brokerConfigs,
        () => monitoringModule.overviewFrom({ topicCount: TOPIC_NAMES.length, brokerConfigs: [], logDirs: LOG_DIRS }),
      ],
      [
        READS.logDirs,
        () =>
          monitoringModule.overviewFrom({
            topicCount: TOPIC_NAMES.length,
            brokerConfigs: BROKER_CONFIGS,
            logDirs: undefined,
          }),
      ],
    ],
  ],
  ["getStorageStats", [[READS.listedTopics], [READS.logDirs, () => monitoringModule.storageFrom(undefined)]]],
];

describe("the monitoring panels", () => {
  test("each panel makes exactly the reads spec 7.1 lists, on every load, and answers its mapping's own answer over those reads' own answers", async () => {
    const { provider, fake } = await connectedOver();
    const health: HealthInfo = { databaseSize: "h", cacheHitRatio: "h", slowQueries: [], activeSessions: [] };
    const overview = { version: "o" } as DatabaseOverview;
    const storage: StorageStats[] = [];
    const healthFrom = spyOnly(monitoringModule, "healthFrom").mockReturnValue(health);
    const overviewFrom = spyOnly(monitoringModule, "overviewFrom").mockReturnValue(overview);
    const storageFrom = spyOnly(monitoringModule, "storageFrom").mockReturnValue(storage);
    const logDirsRequest: Call = ["logDirs", [LISTED.topics]];
    const inAnyOrder = (calls: Call[]) => calls.map((c) => JSON.stringify(c)).sort();
    /** One load of each panel, which must make its reads again and hand its mapping those reads' answers. */
    const loadEach = async (load: number) => {
      fake.calls.length = 0;
      expect(await provider.getHealth()).toBe(health);
      // Health: the forced broker read, then the log-dir read, and no broker config (spec 7.1, KM6).
      expect(fake.calls).toEqual([["metadata", [[]]], ["metadata", []], logDirsRequest]);
      expect(fake.calls[2][1][0]).toBe(LISTED.topics);
      expect(healthFrom.mock.calls).toHaveLength(load);
      expect(healthFrom.mock.calls[load - 1][0]).toBe(LOG_DIRS);

      fake.calls.length = 0;
      expect(await provider.getOverview()).toBe(overview);
      // The overview: the forced broker read first, since its lowest broker is the one whose configs
      // are read (not the controller, and not a broker only the listed copy names), then the rest.
      const [first, ...rest] = fake.calls;
      expect(first).toEqual(["metadata", [[]]]);
      expect(inAnyOrder(rest)).toEqual(
        inAnyOrder([["listTopics", []], ["brokerConfigs", [2]], ["metadata", []], logDirsRequest]),
      );
      expect(overviewFrom.mock.calls).toHaveLength(load);
      const [handed] = overviewFrom.mock.calls[load - 1] as [Record<string, unknown>];
      expect(Object.keys(handed).sort()).toEqual(["brokerConfigs", "logDirs", "topicCount"]);
      expect(handed.topicCount).toBe(TOPIC_NAMES.length);
      expect(handed.brokerConfigs).toBe(BROKER_CONFIGS);
      expect(handed.logDirs).toBe(LOG_DIRS);

      fake.calls.length = 0;
      expect(await provider.getStorageStats()).toBe(storage);
      // Storage: the log-dir read alone.
      expect(fake.calls).toEqual([["metadata", []], logDirsRequest]);
      expect(storageFrom.mock.calls).toHaveLength(load);
      expect(storageFrom.mock.calls[load - 1][0]).toBe(LOG_DIRS);
    };
    await loadEach(1);
    await loadEach(2);
  });

  test("a forced broker read that lists no broker fails the overview in words, and nothing else is read", async () => {
    const { provider, fake } = await connectedOver(undefined, { metadata: async () => ({ ...FORCED, brokers: [] }) });
    expect(await outcomeOf(() => provider.getOverview(), undefined)).toEqual(
      tableAnswer(new KafkaError("protocol", "The broker's metadata listed no live broker")),
    );
    expect(fake.calls).toEqual([["metadata", [[]]]]);
  });

  test.each(
    PANELS.flatMap(([panel, reads]) =>
      reads.flatMap(([read, degradedAnswer]) =>
        FAILURES.map(([label, make]) => [panel, read.name, label, read, degradedAnswer, make] as const),
      ),
    ),
  )(
    "%s, when %s alone meets %s, degrades as KM4 says or fails with the table's error",
    async (panel, _readName, _label, read, degradedAnswer, make) => {
      const failure = make();
      const { provider, fake } = await connectedOver();
      fake.fail(read, failure);
      // An authorization refusal of the log dirs or of the overview's broker configs degrades the panel
      // by that read alone, every other read's answer kept; any other failure, at any read, fails it.
      const expected =
        degradedAnswer !== undefined && isAuthorizationRefusal(failure)
          ? { answered: degradedAnswer() }
          : tableAnswer(failure);
      expect(await outcomeOf(() => provider[panel](), failure)).toEqual(expected);
      // The control: the failing read was asked.
      expect(fake.calls.some(([method, args]) => method === read.method && read.carries(args))).toBe(true);
    },
  );

  test.each(
    [
      [READS.brokerConfigs, READS.logDirs],
      [READS.logDirs, READS.brokerConfigs],
    ].flatMap(([refused, other]) =>
      FAILURES.map(([label, make]) => [refused.name, other.name, label, refused, other, make] as const),
    ),
  )(
    "the overview, with %s refused for want of the cluster ACL, answers %s meeting %s as KM4 says",
    async (_refusedName, _otherName, _label, refused, other, make) => {
      const failure = make();
      const { provider, fake } = await connectedOver();
      fake.fail(refused, new KafkaError("authorization", "The broker denied access to this cluster"));
      fake.fail(other, failure);
      // Both refused: no limit published and no size. Anything else at the other read fails the overview.
      const expected = isAuthorizationRefusal(failure)
        ? {
            answered: monitoringModule.overviewFrom({
              topicCount: TOPIC_NAMES.length,
              brokerConfigs: [],
              logDirs: undefined,
            }),
          }
        : tableAnswer(failure);
      expect(await outcomeOf(() => provider.getOverview(), failure)).toEqual(expected);
    },
  );

  test.each(
    (
      [
        ["getHealth", "healthFrom"],
        ["getOverview", "overviewFrom"],
        ["getStorageStats", "storageFrom"],
      ] as const
    ).flatMap(([panel, mapping]) => FAILURES.map(([label, make]) => [panel, mapping, label, make] as const)),
  )("%s, when its mapping %s refuses with %s, fails with the table's error", async (panel, mapping, _label, make) => {
    const failure = make();
    const { provider } = await connectedOver();
    // Only the first mapping refuses; a second one would answer, so a panel that asks its mapping
    // again after a refusal, to answer something in its place, is seen.
    let mapped = 0;
    spyOnly(monitoringModule, mapping).mockImplementation(() => {
      mapped++;
      if (mapped === 1) throw failure;
      return [];
    });
    expect(await outcomeOf(() => provider[panel](), failure)).toEqual(tableAnswer(failure));
    expect(mapped).toBe(1);
  });
});
