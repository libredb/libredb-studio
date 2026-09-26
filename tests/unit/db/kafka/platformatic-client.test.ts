import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { KafkaError, type KafkaReadClient, type KafkaTopicMetadata } from "@/lib/db/providers/stream/kafka/client";
import {
  createPlatformaticClient,
  KAFKA_SENTINEL_GROUP_ID,
  loadPlatformatic,
  translateError,
} from "@/lib/db/providers/stream/kafka/platformatic-client";
import { kafkaFixture, recordedLib } from "../../../helpers/kafka-fixtures";

const OPTIONS = { clientId: "libredb-studio", broker: { host: "localhost", port: 9092 }, timeoutMs: 5000 };
const big = (value: number) => BigInt(value);
const signal = () => new AbortController().signal;

/** The shared recorded library (tests/helpers/kafka-fixtures.ts), under the name these tests read best with. */
const fakeLib = recordedLib;

/** An error shaped as the library builds one: its own fields, then nested `errors` (and `cause`, when given). */
const libError = (props: Record<string, unknown>, nested: unknown[] = []) =>
  Object.assign(new Error(String(props.message ?? "x")), props, { errors: nested });

/** A Metadata answer holding a leaderless partition, as metadata-v12.js throws it and the retry wraps it. */
const RAW_OFFLINE = {
  brokers: [{ nodeId: 1, host: "localhost", port: 9092, rack: null }],
  clusterId: "c",
  controllerId: 1,
  topics: [
    { name: "__consumer_offsets", topicId: "t0", isInternal: true, partitions: [] },
    {
      name: "orders",
      topicId: "t1",
      isInternal: false,
      partitions: [
        { partitionIndex: 1, leaderId: -1, leaderEpoch: 0, replicaNodes: [1], isrNodes: [], offlineReplicas: [1] },
        { partitionIndex: 0, leaderId: 1, leaderEpoch: 0, replicaNodes: [1], isrNodes: [1], offlineReplicas: [] },
      ],
    },
  ],
};
const leaderless = (response: unknown = RAW_OFFLINE, apiIds: string[] = ["LEADER_NOT_AVAILABLE"]) =>
  libError({ code: "PLT_KFK_MULTIPLE", message: "metadata failed 2 times." }, [
    libError(
      { code: "PLT_KFK_RESPONSE", message: "Received response with error while executing API Metadata(v12)", response },
      // One protocol error per leaderless partition, each on its own partition's path.
      apiIds.map((apiId, index) =>
        libError({ code: "PLT_KFK_PROTOCOL", apiId, path: `/topics/1/partitions/${index}` }),
      ),
    ),
  ]);
const notLeader = () =>
  libError({ code: "PLT_KFK_RESPONSE" }, [libError({ code: "PLT_KFK_PROTOCOL", apiId: "NOT_LEADER_OR_FOLLOWER" })]);
/** The client's NetworkError for one connection, with the Node error as its cause (dist/network/connection.js; captured, error-refused). */
const connectionFailure = (host: string, port: number, nodeCode: string) =>
  libError({
    code: "PLT_KFK_NETWORK",
    message: `Connection to ${host}:${port} failed.`,
    cause: Object.assign(new Error(`connect ${nodeCode} ${host}:${port}`), { code: nodeCode }),
  });
/** One Fetch answer carrying the partition's error code, as the client's ResponseError holds it (captured, error-offset-out-of-range). */
const fetchRefusal = (apiId: string) =>
  libError({ code: "PLT_KFK_RESPONSE", message: "Received response with error while executing API Fetch(v13)" }, [
    libError({ code: "PLT_KFK_PROTOCOL", apiId, path: "/responses/0/partitions/0" }),
  ]);

/** The library's own text for each protocol error the API 69 tests throw (dist/protocol/errors.js). */
const PROTOCOL_TEXT: Record<string, string> = {
  COORDINATOR_LOAD_IN_PROGRESS: "The coordinator is loading and hence can't process requests.",
  COORDINATOR_NOT_AVAILABLE: "The coordinator is not available.",
  NOT_COORDINATOR: "This is not the correct coordinator.",
  TOPIC_AUTHORIZATION_FAILED: "Topic authorization failed.",
  GROUP_AUTHORIZATION_FAILED: "Group authorization failed.",
};
/**
 * An API 69 answer whose entries carry the errors given, thrown as the library throws it: a
 * ResponseError carrying the whole response, with one ProtocolError per errored entry, on that entry's
 * path (dist/apis/admin/consumer-group-describe-v0.js; captured, error-consumer-group-describe-mixed).
 */
const groupDescribeRefusal = (
  entries: Array<{ groupId: string; error?: [apiId: string, apiCode: number, brokerText: string | null] }>,
) =>
  libError(
    {
      code: "PLT_KFK_RESPONSE",
      message: "Received response with error while executing API ConsumerGroupDescribe(v0)",
      response: {
        groups: entries.map(({ groupId, error }) => ({
          errorCode: error?.[1] ?? 0,
          errorMessage: error?.[2] ?? null,
          groupId,
          groupState: error === undefined ? "Stable" : "",
          assignorName: error === undefined ? "uniform" : "",
          members: [],
        })),
      },
    },
    entries.flatMap(({ error }, index) =>
      error === undefined
        ? []
        : [
            libError({
              code: "PLT_KFK_PROTOCOL",
              message: PROTOCOL_TEXT[error[0]],
              apiId: error[0],
              apiCode: error[1],
              serverErrorMessage: error[2],
              path: `/groups/${index}`,
            }),
          ],
    ),
  );

/** Brokers a leader can move to, beside the capture's broker 1 at localhost:9092. */
const OTHER_BROKERS: Array<[number, { host: string; port: number; rack: null }]> = [
  [0, { host: "broker-0.example", port: 9090, rack: null }],
  [2, { host: "broker-2.example", port: 9094, rack: null }],
];
const NODE_AT = new Map([
  ["localhost:9092", 1],
  ["broker-0.example:9090", 0],
  ["broker-2.example:9094", 2],
]);

/** A metadata answer for orders whose partition 1 has the given leader, on a cluster that also lists brokers 0 and 2. */
const ordersWithLeader = (leader: number) => {
  const md = kafkaFixture<{
    brokers: Map<number, { host: string; port: number; rack: string | null }>;
    topics: Map<string, { partitions: Array<{ leader: number }> }>;
  }>("metadata-orders");
  md.topics.get("orders")!.partitions[1].leader = leader;
  md.brokers = new Map([...md.brokers, ...OTHER_BROKERS]);
  return md;
};

/** The node each fetch was sent to, read from the pooled connection it went out on. */
const fetchedFrom = (calls: Array<[string, unknown[]]>) =>
  calls
    .filter(([name]) => name === "fetchV13")
    .map(([, args]) => {
      const { host, port } = (args[0] as { broker: { host: string; port: number } }).broker;
      return NODE_AT.get(`${host}:${port}`);
    });
const fetchCount = (calls: Array<[string, unknown[]]>) => calls.filter(([name]) => name === "fetchV13").length;

/** Every seeded topic's captured metadata, answered for the names asked, as the library answers them. */
const ALL = kafkaFixture<{ topics: Map<string, { id: string }> } & Record<string, unknown>>("metadata-all");
const allTopics = (o: unknown) => {
  const wanted = (o as { topics: string[] }).topics;
  return { ...ALL, topics: new Map([...ALL.topics].filter(([name]) => wanted.includes(name))) };
};
const ORDERS_ID = ALL.topics.get("orders")!.id;

/** Every call's first argument, for one recorded method. */
const argsOf = (calls: Array<[string, unknown[]]>, name: string) =>
  calls.filter(([called]) => called === name).map(([, args]) => args[0]);

/**
 * Kafka's internal topics, the set Apache Kafka's own Topic.isInternal reads in 4.3.1
 * (org.apache.kafka.common.internals.Topic, INTERNAL_TOPICS), and the refusal each one answers.
 */
const INTERNAL_TOPICS = ["__consumer_offsets", "__transaction_state", "__share_group_state"];
const internalRefusal = (name: string) =>
  `Topic ${JSON.stringify(name)} is internal to Kafka, and the client this provider uses drops internal topics from its metadata, so it is not readable here`;
/** A topic's metadata under another name, which only a caller that built it could hand over. */
const topicNamed = (name: string): KafkaTopicMetadata => ({
  name,
  id: ORDERS_ID,
  partitions: [{ partition: 0, leader: 1, leaderEpoch: 0, replicas: [1], isr: [1], offlineReplicas: [] }],
});
/** Every seam method that names a topic, as a caller asks it about one. */
const NAMING_CALLS = new Map<string, (client: KafkaReadClient, name: string) => Promise<unknown>>([
  ["metadata", (client, name) => client.metadata([name])],
  ["metadata among other names", (client, name) => client.metadata(["orders", name])],
  ["offsets at the earliest", (client, name) => client.offsets(name, "earliest")],
  ["offsets at the latest", (client, name) => client.offsets(name, "latest")],
  ["offsets at the high watermark", (client, name) => client.offsets(name, "high-watermark")],
  ["offsetsForTimestamp", (client, name) => client.offsetsForTimestamp(name, big(5))],
  ["fetch", (client, name) => client.fetch(topicNamed(name), 0, big(0), signal())],
  ["topicConfigs", (client, name) => client.topicConfigs(name)],
  ["logDirs", (client, name) => client.logDirs([topicNamed("orders"), topicNamed(name)])],
]);

/**
 * A client over orders whose partition 1 is led by node 1 until a forced metadata read names
 * `movedTo`, and whose first fetch fails with `failure`, at the fetch itself or at the pooled
 * connection it needs; every later fetch answers the capture.
 */
const afterLeaderMove = (movedTo: number, failure: () => unknown, failing: "fetchV13" | "pool.get" = "fetchV13") => {
  let attempts = 0;
  const recorded = fakeLib({
    "admin.metadata": (o) => ordersWithLeader((o as { forceUpdate?: boolean }).forceUpdate ? movedTo : 1),
    [failing]: (answer: unknown) => {
      attempts++;
      if (attempts === 1) throw failure();
      return failing === "pool.get" ? { broker: answer } : kafkaFixture("fetch-orders-p1-o5");
    },
  });
  const client = createPlatformaticClient(OPTIONS, recorded.lib);
  return {
    read: async () => client.fetch((await client.metadata(["orders"])).topics[0], 1, big(5), signal()),
    nodes: () => fetchedFrom(recorded.calls),
    calls: recorded.calls,
  };
};

/** A fetch that answers only when the test releases it, counting how many are in flight at once. */
const heldFetches = () => {
  const held: Array<() => void> = [];
  const state = { inFlight: 0, most: 0 };
  const fetch = () => {
    state.inFlight++;
    state.most = Math.max(state.most, state.inFlight);
    return new Promise((resolve) => {
      held.push(() => {
        state.inFlight--;
        resolve(kafkaFixture("fetch-orders-p1-o5"));
      });
    });
  };
  return { held, state, fetch };
};
const until = async (condition: () => boolean) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("loadPlatformatic", () => {
  test("mutes the protocol logger, which prints request frames under DEBUG, and hands over the six members (K3)", async () => {
    const protocol = { enabled: true };
    const library = {
      loggers: { protocol, client: { enabled: true } },
      Admin: class {},
      Consumer: class {},
      Connection: class {},
      ConnectionPool: class {},
      consumerGroupDescribeV0: { api: { async: async () => undefined } },
      fetchV13: { api: { async: async () => undefined } },
      fetchV17: { api: { async: async () => undefined } },
      Producer: class {},
    };
    const lib = await loadPlatformatic(async () => library as never);
    expect(protocol.enabled).toBe(false);
    // The client logger is not the provider's to silence.
    expect(library.loggers.client.enabled).toBe(true);
    expect(Object.keys(lib).sort()).toEqual([
      "Admin",
      "Connection",
      "ConnectionPool",
      "Consumer",
      "consumerGroupDescribeV0",
      "fetchV13",
    ]);
    expect(lib.Admin).toBe(library.Admin as never);
    expect(lib.Consumer).toBe(library.Consumer as never);
    expect(lib.Connection).toBe(library.Connection as never);
    expect(lib.ConnectionPool).toBe(library.ConnectionPool as never);
    expect(lib.consumerGroupDescribeV0).toBe(library.consumerGroupDescribeV0 as never);
    expect(lib.fetchV13).toBe(library.fetchV13 as never);
  });

  test("refuses a library that no longer exports its protocol logger, rather than run with it unmuted", async () => {
    await expect(loadPlatformatic(async () => ({ loggers: {} }) as never)).rejects.toThrow("loggers.protocol");
  });

  test("loads the installed library by default", async () => {
    const lib = await loadPlatformatic();
    expect([typeof lib.Admin, typeof lib.Consumer, typeof lib.Connection, typeof lib.ConnectionPool]).toEqual([
      "function",
      "function",
      "function",
      "function",
    ]);
    expect(typeof lib.consumerGroupDescribeV0.api.async).toBe("function");
    expect(typeof lib.fetchV13.api.async).toBe("function");
  });
});

describe("createPlatformaticClient", () => {
  test("one Admin, one Consumer and one fetch pool: autocreateTopics false on both clients; the Consumer gets the sentinel group, autocommit off and the classic protocol", () => {
    const { lib, constructed } = fakeLib();
    createPlatformaticClient(OPTIONS, lib);
    expect(constructed.map(([n]) => n)).toEqual(["Admin", "Consumer", "ConnectionPool"]);
    const admin = constructed.find(([n]) => n === "Admin")![1] as Record<string, unknown>;
    const consumer = constructed.find(([n]) => n === "Consumer")![1] as Record<string, unknown>;
    // Whole, so an option the adapter did not mean to pass shows: no client takes a retry delay of its
    // own, since no fetch goes through the client and so no fetch session exists to reset (spec 3.6 K8).
    expect(admin).toEqual({
      clientId: "libredb-studio",
      bootstrapBrokers: [{ host: "localhost", port: 9092 }],
      autocreateTopics: false,
      retries: 1,
      connectTimeout: 5000,
      requestTimeout: 5000,
    });
    expect(consumer).toEqual({
      ...admin,
      groupId: KAFKA_SENTINEL_GROUP_ID,
      autocommit: false,
      groupProtocol: "classic",
    });
    // The pool's connections carry the same transport as the clients' and nothing a client reads.
    expect(constructed.find(([n]) => n === "ConnectionPool")![1]).toEqual({
      id: "libredb-studio",
      connectTimeout: 5000,
      requestTimeout: 5000,
    });
  });

  test("TLS, SNI and SASL reach the client options; a connection without them carries none", () => {
    const { lib, constructed } = fakeLib();
    createPlatformaticClient(
      {
        ...OPTIONS,
        tls: { ca: "CA", rejectUnauthorized: true },
        tlsServerName: true,
        sasl: { mechanism: "SCRAM-SHA-512", username: "u", password: "p" },
      },
      lib,
    );
    // The fetch pool's connections too: a read's fetch is sent on one of them (spec 3.6 K8).
    expect(constructed.map(([n]) => n)).toEqual(["Admin", "Consumer", "ConnectionPool"]);
    for (const [, options] of constructed) {
      expect(options).toMatchObject({
        tls: { ca: "CA", rejectUnauthorized: true },
        tlsServerName: true,
        sasl: { mechanism: "SCRAM-SHA-512", username: "u", password: "p" },
      });
    }
    const plain = fakeLib();
    createPlatformaticClient(OPTIONS, plain.lib);
    for (const [, options] of plain.constructed) {
      expect(Object.keys(options as object)).not.toContain("tlsServerName");
      expect(Object.keys(options as object)).not.toContain("tls");
      expect(Object.keys(options as object)).not.toContain("sasl");
    }
  });

  test("a cluster that advertises a broker by IP gets both clients and the fetch pool rebuilt without SNI, once", async () => {
    const { lib, constructed, calls } = fakeLib({
      "admin.metadata": () => ({
        id: "c",
        controllerId: 1,
        brokers: new Map([[1, { host: "10.0.0.5", port: 9092, rack: null }]]),
        topics: new Map(),
      }),
    });
    const client = createPlatformaticClient(
      { ...OPTIONS, tls: { rejectUnauthorized: true }, tlsServerName: true },
      lib,
    );
    await client.metadata([]);
    await client.metadata([]);
    const admins = constructed
      .filter(([n]) => n === "Admin")
      .map(([, o]) => (o as Record<string, unknown>).tlsServerName);
    expect(admins).toEqual([true, undefined]);
    expect(constructed.filter(([n]) => n === "Consumer").length).toBe(2);
    expect(
      constructed.filter(([n]) => n === "ConnectionPool").map(([, o]) => (o as Record<string, unknown>).tlsServerName),
    ).toEqual([true, undefined]);
    expect(
      calls
        .map(([n]) => n)
        .filter((n) => n.endsWith(".close"))
        .sort(),
    ).toEqual(["admin.close", "consumer.close", "pool.close"]);
  });

  test.each(["10.0.0.5", "fd00::5"])(
    "one broker advertised by IP (%s) among named ones is enough: both clients are rebuilt without SNI (spec 6.1)",
    async (ip) => {
      // The client's SNI option is one flag for all of its broker connections, and Node 26 throws
      // on an IP literal as a server name. The IP broker sits between two named ones, so a check
      // that asks whether any broker has a name, or reads only the first or the last, keeps SNI.
      const { lib, constructed, calls } = fakeLib({
        "admin.metadata": () => ({
          id: "c",
          controllerId: 1,
          brokers: new Map([
            [1, { host: "broker-1.example", port: 9092, rack: null }],
            [2, { host: ip, port: 9092, rack: null }],
            [3, { host: "broker-3.example", port: 9092, rack: null }],
          ]),
          topics: new Map(),
        }),
      });
      const client = createPlatformaticClient(
        { ...OPTIONS, tls: { rejectUnauthorized: true }, tlsServerName: true },
        lib,
      );
      await client.metadata([]);
      expect(constructed.map(([n, o]) => [n, (o as Record<string, unknown>).tlsServerName])).toEqual([
        ["Admin", true],
        ["Consumer", true],
        ["ConnectionPool", true],
        ["Admin", undefined],
        ["Consumer", undefined],
        ["ConnectionPool", undefined],
      ]);
      expect(
        calls
          .map(([n]) => n)
          .filter((n) => n.endsWith(".close"))
          .sort(),
      ).toEqual(["admin.close", "consumer.close", "pool.close"]);
    },
  );

  test("a cluster that advertises its brokers by name keeps SNI", async () => {
    const { lib, constructed } = fakeLib();
    const client = createPlatformaticClient(
      { ...OPTIONS, tls: { rejectUnauthorized: true }, tlsServerName: true },
      lib,
    );
    await client.metadata([]);
    expect(constructed.map(([n]) => n)).toEqual(["Admin", "Consumer", "ConnectionPool"]);
  });

  test("an IP broker a read's fetch first learns of rebuilds the fetch pool without SNI before the fetch connects", async () => {
    // The address a fetch is sent to comes from the cluster's broker list, which the fetch may be the
    // first to read on this client; it is checked the same way, so no connection names an IP as a server.
    const { lib, constructed, calls } = fakeLib({
      "admin.metadata": () => {
        const md = kafkaFixture<{ brokers: Map<number, { host: string; port: number; rack: null }> }>(
          "metadata-orders",
        );
        md.brokers = new Map([[1, { host: "10.0.0.5", port: 9092, rack: null }]]);
        return md;
      },
    });
    const client = createPlatformaticClient(
      { ...OPTIONS, tls: { rejectUnauthorized: true }, tlsServerName: true },
      lib,
    );
    const orders = kafkaFixture<{ topics: Map<string, { id: string }> }>("metadata-orders").topics.get("orders")!;
    const topic: KafkaTopicMetadata = {
      name: "orders",
      id: orders.id,
      partitions: [0, 1, 2].map((partition) => ({
        partition,
        leader: 1,
        leaderEpoch: 0,
        replicas: [1],
        isr: [1],
        offlineReplicas: [],
      })),
    };
    await client.fetch(topic, 1, big(5), signal());
    const pools = constructed.filter(([n]) => n === "ConnectionPool").map(([, o]) => o as Record<string, unknown>);
    expect(pools.map((o) => o.tlsServerName)).toEqual([true, undefined]);
    // The fetch went out on the rebuilt pool, the one whose connections carry no server name.
    const gets = calls.filter(([n]) => n === "pool.get").length;
    const closes = calls.filter(([n]) => n === "pool.close").length;
    expect([gets, closes]).toEqual([1, 1]);
    expect(calls.findIndex(([n]) => n === "pool.close")).toBeLessThan(calls.findIndex(([n]) => n === "pool.get"));
  });

  test("every metadata read passes autocreateTopics: false; a brokers-only read is forced past the library's cache", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    await client.metadata(["orders"]);
    await client.metadata([]);
    expect(argsOf(calls, "admin.metadata")).toEqual([
      { topics: ["orders"], autocreateTopics: false },
      { topics: [], autocreateTopics: false, forceUpdate: true },
    ]);
  });

  test("metadata leaves the caller's names as they were, though the library sorts the array it is given in place (D-T2-12)", async () => {
    const { lib, calls } = fakeLib({
      "admin.metadata": (o) => {
        // What #performMetadata does to build its deduplication key.
        (o as { topics: string[] }).topics.sort();
        return allTopics(o);
      },
    });
    const names = ["txn", "orders", "big"];
    const md = await createPlatformaticClient(OPTIONS, lib).metadata(names);
    expect(names).toEqual(["txn", "orders", "big"]);
    // The control: the array the library was handed did get sorted, so the assertion above can fail.
    expect((argsOf(calls, "admin.metadata")[0] as { topics: string[] }).topics).toEqual(["big", "orders", "txn"]);
    expect(md.topics.map((t) => t.name)).toEqual(["big", "orders", "txn"]);
  });

  test("metadata maps brokers, controller and partitions from the captured payload", async () => {
    const { lib } = fakeLib();
    const md = await createPlatformaticClient(OPTIONS, lib).metadata(["orders"]);
    expect(md.clusterId).toBe("4L6g3nShT-eMCtK--X86sw");
    expect(md.controllerId).toBe(1);
    expect(md.brokers).toEqual([{ nodeId: 1, host: "localhost", port: 9092, rack: null }]);
    expect(md.topics.map((t) => [t.name, t.id])).toEqual([["orders", ORDERS_ID]]);
    expect(md.topics[0].partitions.map((p) => p.partition)).toEqual([0, 1, 2]);
    expect(md.topics[0].partitions[1]).toEqual({
      partition: 1,
      leader: 1,
      leaderEpoch: 2,
      replicas: [1],
      isr: [1],
      offlineReplicas: [],
    });
  });

  test("metadata answers brokers in node-id order and topics in name order on both paths, whatever order the answer holds", async () => {
    // The overview reads max.connections from the first broker listed, which is the lowest node id
    // (spec 7.1), and a broker lists brokers and topics in its own order. The orders below are
    // neither sorted nor reversed, so a missing sort and a reversal both show.
    const answered = fakeLib({
      "admin.metadata": () => ({
        id: "c",
        controllerId: 2,
        brokers: new Map([3, 1, 2].map((nodeId) => [nodeId, { host: `b${nodeId}`, port: 9092, rack: null }])),
        topics: new Map(["orders", "big", "txn"].map((name) => [name, ALL.topics.get(name)])),
      }),
    });
    const md = await createPlatformaticClient(OPTIONS, answered.lib).metadata(["orders", "big", "txn"]);
    expect(md.brokers.map((b) => b.nodeId)).toEqual([1, 2, 3]);
    expect(md.topics.map((t) => t.name)).toEqual(["big", "orders", "txn"]);
    const raw = {
      ...RAW_OFFLINE,
      brokers: [3, 1, 2].map((nodeId) => ({ nodeId, host: `b${nodeId}`, port: 9092, rack: null })),
      topics: [
        RAW_OFFLINE.topics[1],
        { ...RAW_OFFLINE.topics[1], name: "txn", topicId: "t3" },
        { ...RAW_OFFLINE.topics[1], name: "big", topicId: "t2" },
      ],
    };
    const leaderlessPath = fakeLib({
      "admin.metadata": () => {
        throw leaderless(raw);
      },
    });
    const through = await createPlatformaticClient(OPTIONS, leaderlessPath.lib).metadata(["orders", "big", "txn"]);
    expect(through.brokers.map((b) => b.nodeId)).toEqual([1, 2, 3]);
    expect(through.topics.map((t) => t.name)).toEqual(["big", "orders", "txn"]);
  });

  test("a leaderless failure the library retried is read from its last attempt's answer, the fresher one", async () => {
    // metadata failed 2 times: each attempt's ResponseError carries its own answer, in order.
    const later = {
      ...RAW_OFFLINE,
      topics: [
        RAW_OFFLINE.topics[0],
        {
          ...RAW_OFFLINE.topics[1],
          partitions: [
            { partitionIndex: 1, leaderId: -1, leaderEpoch: 0, replicaNodes: [1], isrNodes: [], offlineReplicas: [1] },
            {
              partitionIndex: 0,
              leaderId: 2,
              leaderEpoch: 1,
              replicaNodes: [1, 2],
              isrNodes: [2],
              offlineReplicas: [],
            },
          ],
        },
      ],
    };
    const attempt = (response: unknown) =>
      libError(
        {
          code: "PLT_KFK_RESPONSE",
          message: "Received response with error while executing API Metadata(v12)",
          response,
        },
        [libError({ code: "PLT_KFK_PROTOCOL", apiId: "LEADER_NOT_AVAILABLE", path: "/topics/1/partitions/0" })],
      );
    const { lib } = fakeLib({
      "admin.metadata": () => {
        throw libError({ code: "PLT_KFK_MULTIPLE", message: "metadata failed 2 times." }, [
          attempt(RAW_OFFLINE),
          attempt(later),
        ]);
      },
    });
    const [orders] = (await createPlatformaticClient(OPTIONS, lib).metadata(["orders"])).topics;
    expect(orders.partitions.map((p) => [p.partition, p.leader])).toEqual([
      [0, 2],
      [1, -1],
    ]);
  });

  test("metadata with no names reads every listed topic", async () => {
    const { lib, calls } = fakeLib();
    await createPlatformaticClient(OPTIONS, lib).metadata();
    expect((argsOf(calls, "admin.metadata")[0] as { topics: string[] }).topics).toEqual(
      kafkaFixture<string[]>("list-topics"),
    );
  });

  test.each(INTERNAL_TOPICS.flatMap((name) => [...NAMING_CALLS.keys()].map((call) => [name, call])))(
    "%s is refused by name at %s, and no request names it (spec 4.1, 4.5)",
    async (name, call) => {
      // A broker before Apache Kafka 2.8 creates a missing internal topic for any Metadata request
      // that names it, whatever allowAutoTopicCreation and auto.create.topics.enable say (2.7's
      // KafkaApis.getTopicMetadata), and the library's listOffsets on one never settles: so the name
      // is refused before the library is asked anything, and the library records no call at all.
      const { lib, calls } = fakeLib();
      const error = await NAMING_CALLS.get(call)!(createPlatformaticClient(OPTIONS, lib), name).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(KafkaError);
      expect(error).toMatchObject({ category: "unreadable-topic", message: internalRefusal(name) });
      expect(calls).toEqual([]);
    },
  );

  test.each(["__consumer_offsets_mirror", "_consumer_offsets", "__Consumer_Offsets", "__confluent.support.metrics"])(
    "%s only looks like an internal topic, and every seam method asks the library about it as about any other",
    async (name) => {
      // The control of the refusal above: the set is Kafka's own, matched whole and by case, so a
      // topic a user or a vendor named with Kafka's prefix is read as any topic is.
      const asked = await Promise.all(
        [...NAMING_CALLS].map(async ([call, ask]) => {
          const { lib, calls } = fakeLib();
          await ask(createPlatformaticClient(OPTIONS, lib), name).catch(() => undefined);
          return [call, calls.length > 0];
        }),
      );
      expect(asked).toEqual([...NAMING_CALLS.keys()].map((call) => [call, true]));
    },
  );

  test("a topic the broker marks internal and Kafka's list does not name, which the library answers as undefined, is refused in words all the same", async () => {
    // The second guard: the library's metadata cache skips every topic the broker marks internal
    // and answers its name with undefined (dist/clients/base/base.js), a vendor's internal topic too.
    const { lib } = fakeLib({
      "admin.metadata": () => ({
        id: "c",
        controllerId: 1,
        brokers: new Map(),
        topics: new Map([["__vendor_internal", undefined]]),
      }),
    });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .metadata(["__vendor_internal"])
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("unreadable-topic");
    expect(error.message).toBe(internalRefusal("__vendor_internal"));
  });

  test("a leaderless partition's metadata is read from the response its error carries, as leader -1", async () => {
    const { lib, calls } = fakeLib({
      "admin.metadata": () => {
        throw leaderless();
      },
    });
    const md = await createPlatformaticClient(OPTIONS, lib).metadata(["orders"]);
    expect(md.clusterId).toBe("c");
    expect(md.brokers).toEqual([{ nodeId: 1, host: "localhost", port: 9092, rack: null }]);
    expect(md.topics.map((t) => [t.name, t.id])).toEqual([["orders", "t1"]]);
    expect(md.topics[0].partitions).toEqual([
      { partition: 0, leader: 1, leaderEpoch: 0, replicas: [1], isr: [1], offlineReplicas: [] },
      { partition: 1, leader: -1, leaderEpoch: 0, replicas: [1], isr: [], offlineReplicas: [1] },
    ]);
    // Asked again with every name forced, because the library fetched only what it had no fresh copy of.
    expect(argsOf(calls, "admin.metadata").map((o) => (o as { forceUpdate?: boolean }).forceUpdate)).toEqual([
      undefined,
      true,
    ]);
  });

  test("a leaderless answer holds exactly the topics asked for, and refuses one it marks internal in words", async () => {
    // The raw answer's own mark is the second guard here: a name Kafka's list holds never gets this
    // far, so the topic it marks internal is one of a vendor's.
    const vendorInternal = { ...RAW_OFFLINE.topics[0], name: "__vendor_internal" };
    const { lib } = fakeLib({
      "admin.metadata": () => {
        throw leaderless({ ...RAW_OFFLINE, topics: [...RAW_OFFLINE.topics, vendorInternal] });
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const internal = await client.metadata(["orders", "__vendor_internal"]).catch((e) => e);
    expect(internal).toBeInstanceOf(KafkaError);
    expect(internal.category).toBe("unreadable-topic");
    expect(internal.message).toBe(internalRefusal("__vendor_internal"));
    const missing = await client.metadata(["orders", "payments"]).catch((e) => e);
    expect(missing.category).toBe("protocol");
    expect(missing.message).toContain('"payments"');
  });

  test("a leader back by the second read answers it, and a second read failing otherwise propagates", async () => {
    let reads = 0;
    const back = fakeLib({
      "admin.metadata": () => {
        reads++;
        if (reads === 1) throw leaderless();
        return kafkaFixture("metadata-orders");
      },
    });
    const md = await createPlatformaticClient(OPTIONS, back.lib).metadata(["orders"]);
    expect(md.topics[0].partitions.every((p) => p.leader >= 0)).toBe(true);
    let attempts = 0;
    const down = fakeLib({
      "admin.metadata": () => {
        attempts++;
        if (attempts === 1) throw leaderless();
        throw libError({
          code: "PLT_KFK_NETWORK",
          message: "Connection to localhost:9092 failed.",
          cause: { code: "ECONNREFUSED" },
        });
      },
    });
    expect(
      (
        await createPlatformaticClient(OPTIONS, down.lib)
          .metadata(["orders"])
          .catch((e) => e)
      ).category,
    ).toBe("network");
  });

  test.each<[string, string[]]>([
    ["LISTENER_NOT_FOUND", ["LISTENER_NOT_FOUND"]],
    ["LISTENER_NOT_FOUND beside LEADER_NOT_AVAILABLE", ["LEADER_NOT_AVAILABLE", "LISTENER_NOT_FOUND"]],
  ])(
    "a partition answered with %s has no leader either, and is read through as leader -1 (spec 4.1)",
    async (_, apiIds) => {
      // Kafka answers LISTENER_NOT_FOUND, with leader -1, for a partition whose leader has no endpoint
      // on the listener the request came in on: the other form a leaderless partition takes.
      const { lib } = fakeLib({
        "admin.metadata": () => {
          throw leaderless(RAW_OFFLINE, apiIds);
        },
        "admin.listTopics": () => {
          throw libError({ code: "PLT_KFK_MULTIPLE", message: "Listing topics failed." }, [
            leaderless(RAW_OFFLINE, apiIds),
          ]);
        },
      });
      const client = createPlatformaticClient(OPTIONS, lib);
      const [orders] = (await client.metadata(["orders"])).topics;
      expect(orders.partitions.map((p) => [p.partition, p.leader])).toEqual([
        [0, 1],
        [1, -1],
      ]);
      expect(await client.listTopics()).toEqual(["orders"]);
    },
  );

  test("listTopics reads names through a leaderless partition too, internal topics excluded", async () => {
    const { lib } = fakeLib({
      "admin.listTopics": () => {
        throw libError({ code: "PLT_KFK_MULTIPLE", message: "Listing topics failed." }, [leaderless()]);
      },
    });
    expect(await createPlatformaticClient(OPTIONS, lib).listTopics()).toEqual(["orders"]);
  });

  test("listTopics answers every name sorted, whatever order the listing holds, on both paths (the seam's contract)", async () => {
    // A broker lists topics in its own order (neither Kafka 4.3.1 nor Redpanda v26.2.2 sorts
    // them), and only the library's success path sorts. The orders below are neither sorted
    // nor reversed, so a missing sort and a reversal both show.
    const sorted = ["events", "orders", "payments"];
    const raw = {
      ...RAW_OFFLINE,
      topics: [
        RAW_OFFLINE.topics[1],
        { ...RAW_OFFLINE.topics[1], name: "payments", topicId: "t2" },
        RAW_OFFLINE.topics[0],
        { ...RAW_OFFLINE.topics[1], name: "events", topicId: "t3" },
      ],
    };
    const throughLeaderless = fakeLib({
      "admin.listTopics": () => {
        throw libError({ code: "PLT_KFK_MULTIPLE", message: "Listing topics failed." }, [leaderless(raw)]);
      },
    });
    expect(await createPlatformaticClient(OPTIONS, throughLeaderless.lib).listTopics()).toEqual(sorted);
    const answered = fakeLib({ "admin.listTopics": () => ["orders", "payments", "events"] });
    expect(await createPlatformaticClient(OPTIONS, answered.lib).listTopics()).toEqual(sorted);
  });

  test("a leaderless listing that names a topic by id alone is a protocol error, never an empty name", async () => {
    const byIdOnly = { ...RAW_OFFLINE, topics: [{ ...RAW_OFFLINE.topics[1], name: null }] };
    const { lib } = fakeLib({
      "admin.listTopics": () => {
        throw libError({ code: "PLT_KFK_MULTIPLE", message: "Listing topics failed." }, [leaderless(byIdOnly)]);
      },
    });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .listTopics()
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("protocol");
  });

  test("the captured leaderless failures (a fake broker, Task 2) are read through as leader -1 and as names", async () => {
    const thrown = (fixture: string) => {
      const captured = kafkaFixture<Record<string, unknown>>(fixture);
      return () => {
        throw Object.assign(new Error(String(captured.message)), captured);
      };
    };
    const { lib } = fakeLib({
      "admin.metadata": thrown("error-leaderless-metadata"),
      "admin.listTopics": thrown("error-leaderless-list-topics"),
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    expect(orders.partitions.map((p) => [p.partition, p.leader])).toEqual([
      [0, 1],
      [1, -1],
    ]);
    expect(await client.listTopics()).toEqual(["orders"]);
  });

  test("a leader error on the topic itself, not on a partition, is not read through", async () => {
    // A topic still being created answers LEADER_NOT_AVAILABLE on the topic, with partitions it may not list yet.
    const creating = libError({ code: "PLT_KFK_RESPONSE", response: RAW_OFFLINE }, [
      libError({ code: "PLT_KFK_PROTOCOL", apiId: "LEADER_NOT_AVAILABLE", path: "/topics/1" }),
    ]);
    const { lib } = fakeLib({
      "admin.metadata": () => {
        throw creating;
      },
      "admin.listTopics": () => {
        throw creating;
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    expect((await client.metadata(["orders"]).catch((e) => e)).category).toBe("unreadable-topic");
    expect((await client.listTopics().catch((e) => e)).category).toBe("unreadable-topic");
  });

  test.each<[string, unknown[], string]>([
    [
      "another protocol error",
      [libError({ code: "PLT_KFK_PROTOCOL", apiId: "TOPIC_AUTHORIZATION_FAILED", path: "/topics/1" })],
      "authorization",
    ],
    [
      "a leaderless partition beside another protocol error",
      [
        libError({ code: "PLT_KFK_PROTOCOL", apiId: "LEADER_NOT_AVAILABLE", path: "/topics/1/partitions/0" }),
        libError({ code: "PLT_KFK_PROTOCOL", apiId: "TOPIC_AUTHORIZATION_FAILED", path: "/topics/0" }),
      ],
      "authorization",
    ],
    ["a response that names no protocol error at all", [], "protocol"],
  ])("a Metadata failure carrying its answer with %s is not read through", async (_, nested, category) => {
    // Only a failure whose every protocol error is a partition's missing leader is read through.
    const failure = libError({ code: "PLT_KFK_RESPONSE", response: RAW_OFFLINE }, nested);
    const { lib } = fakeLib({
      "admin.metadata": () => {
        throw failure;
      },
      "admin.listTopics": () => {
        throw failure;
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    expect((await client.metadata(["orders"]).catch((e) => e)).category).toBe(category);
    expect((await client.listTopics().catch((e) => e)).category).toBe(category);
  });

  test("offsets read each position at its isolation level", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    for (const at of ["earliest", "latest", "high-watermark"] as const) await client.offsets("orders", at);
    expect(argsOf(calls, "consumer.listOffsets")).toEqual([
      { topics: ["orders"], timestamp: big(-2), isolationLevel: 1 },
      { topics: ["orders"], timestamp: big(-1), isolationLevel: 1 },
      { topics: ["orders"], timestamp: big(-1), isolationLevel: 0 },
    ]);
    const captured = kafkaFixture<Map<string, bigint[]>>("offsets-latest").get("orders")!;
    expect([...(await client.offsets("orders", "latest"))]).toEqual(
      captured.map((offset, partition) => [partition, offset]),
    );
  });

  test("a partition the ListOffsets answer leaves out is left out, never read as 0", async () => {
    const sparse: bigint[] = [];
    sparse[0] = big(24);
    sparse[2] = big(7);
    const { lib } = fakeLib({ "consumer.listOffsets": () => new Map([["orders", sparse]]) });
    const client = createPlatformaticClient(OPTIONS, lib);
    expect([...(await client.offsets("orders", "latest"))]).toEqual([
      [0, big(24)],
      [2, big(7)],
    ]);
    const none = fakeLib({ "consumer.listOffsets": () => new Map() });
    expect((await createPlatformaticClient(OPTIONS, none.lib).offsets("orders", "latest")).size).toBe(0);
  });

  test("offsets of a topic with a leaderless partition are refused before the library is asked", async () => {
    const { lib, calls } = fakeLib({
      "admin.metadata": () => {
        throw leaderless();
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    for (const read of [() => client.offsets("orders", "latest"), () => client.offsetsForTimestamp("orders", big(5))]) {
      const error = await read().catch((e) => e);
      expect(error.category).toBe("unreadable-topic");
      expect(error.message).toContain("partition 1");
    }
    expect(calls.some(([n]) => n.startsWith("consumer.listOffsets"))).toBe(false);
  });

  test("offsets of a topic the broker marks internal are refused before the library's listOffsets is asked, which would never settle", async () => {
    // The second guard on the offsets path, for a name Kafka's list does not hold (the refusal by
    // name, above, sends nothing at all).
    const { lib, calls } = fakeLib({
      "admin.metadata": () => ({
        id: "c",
        controllerId: 1,
        brokers: new Map(),
        topics: new Map([["__vendor_internal", undefined]]),
      }),
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const refusals = await Promise.all(
      [
        () => client.offsets("__vendor_internal", "latest"),
        () => client.offsetsForTimestamp("__vendor_internal", big(5)),
      ].map((read) => read().catch((e) => e.message)),
    );
    expect(refusals).toEqual([internalRefusal("__vendor_internal"), internalRefusal("__vendor_internal")]);
    expect(calls.some(([n]) => n.startsWith("consumer.listOffsets"))).toBe(false);
  });

  test("offsetsForTimestamp maps each partition's offset, read committed", async () => {
    const { lib, calls } = fakeLib({
      "consumer.listOffsetsWithTimestamps": () =>
        new Map([
          [
            "orders",
            new Map([
              [0, { offset: big(3), timestamp: big(9) }],
              [1, { offset: big(-1), timestamp: big(-1) }],
            ]),
          ],
        ]),
    });
    expect(await createPlatformaticClient(OPTIONS, lib).offsetsForTimestamp("orders", big(5))).toEqual(
      new Map([
        [0, big(3)],
        [1, big(-1)],
      ]),
    );
    expect(argsOf(calls, "consumer.listOffsetsWithTimestamps")).toEqual([
      { topics: ["orders"], timestamp: big(5), isolationLevel: 1 },
    ]);
  });

  test("offsetsForTimestamp reads the captured answers, one day ahead as -1 on every partition", async () => {
    const { lib } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const captured = kafkaFixture<Map<string, Map<number, { offset: bigint }>>>("offsets-timestamp").get("orders")!;
    expect([...(await client.offsetsForTimestamp("orders", big(1790275771460)))]).toEqual(
      [...captured].map(([partition, { offset }]) => [partition, offset]),
    );
    const future = fakeLib({ "consumer.listOffsetsWithTimestamps": () => kafkaFixture("offsets-timestamp-future") });
    const ahead = await createPlatformaticClient(OPTIONS, future.lib).offsetsForTimestamp("orders", big(1));
    expect([...ahead.values()]).toEqual([big(-1), big(-1), big(-1)]);
    const none = fakeLib({ "consumer.listOffsetsWithTimestamps": () => new Map() });
    expect((await createPlatformaticClient(OPTIONS, none.lib).offsetsForTimestamp("orders", big(1))).size).toBe(0);
  });

  test("fetch filters records below the requested offset and reports nextOffset past the last batch", async () => {
    const { lib } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const md = await client.metadata(["orders"]);
    const result = await client.fetch(md.topics[0], 1, big(5), signal());
    expect(result.records.map((r) => r.offset)).toEqual([5, 6, 7, 8, 9, 10, 11].map(big));
    expect(result.records.every((r) => r.partition === 1)).toBe(true);
    expect(result.nextOffset).toBe(big(12));
  });

  test("a fetch is the adapter's own Fetch v13, READ_COMMITTED and sessionless, on a pooled connection to the leader's advertised address", async () => {
    // Never the client's Consumer.fetch (spec 3.6 K8): its READ_COMMITTED filter throws inside the
    // socket handler on answers a cleaned transactional log holds, and its fetch sessions collide
    // when reads overlap. Session id 0 with epoch -1 asks for a full answer and opens no session (KIP-227).
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    await client.fetch(orders, 1, big(5), signal());
    expect(argsOf(calls, "pool.get")).toEqual([{ host: "localhost", port: 9092 }]);
    expect(calls.filter(([n]) => n === "fetchV13").map(([, args]) => args)).toEqual([
      [
        { broker: { host: "localhost", port: 9092 } },
        250,
        1,
        1024 * 1024,
        1,
        0,
        -1,
        [
          {
            topicId: ORDERS_ID,
            partitions: [
              {
                partition: 1,
                fetchOffset: big(5),
                partitionMaxBytes: 1024 * 1024,
                currentLeaderEpoch: -1,
                lastFetchedEpoch: -1,
              },
            ],
          },
        ],
        [],
        "",
      ],
    ]);
    // The leader's address comes from the broker list the client holds: a brokers-only read, not forced.
    expect(argsOf(calls, "admin.metadata").at(-1)).toEqual({ topics: [], autocreateTopics: false });
  });

  test("the leader is found by partition number, never by position in the topic's list", async () => {
    // A caller may hand over a topic whose partitions are not listed from 0 up.
    const { lib, calls } = fakeLib({ "admin.metadata": () => ordersWithLeader(2) });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const onlyPartitionOne = { ...orders, partitions: orders.partitions.filter((p) => p.partition === 1) };
    const result = await client.fetch(onlyPartitionOne, 1, big(5), signal());
    expect(result.records[0].offset).toBe(big(5));
    expect(fetchedFrom(calls)).toEqual([2]);
  });

  test("a partition the topic's metadata does not hold is refused before any fetch", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const error = await client.fetch(orders, 7, big(0), signal()).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("invalid-request");
    expect(error.message).toContain("partition 7");
    expect(calls.some(([n]) => n === "fetchV13" || n === "pool.get")).toBe(false);
  });

  test("fetch checks once that the broker answers Fetch 13, the version it sends, and refuses one whose range does not hold it", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    await client.fetch(orders, 1, big(5), signal());
    await client.fetch(orders, 1, big(5), signal());
    expect(calls.filter(([n]) => n === "admin.listApis").length).toBe(1);
    /** One read against a broker whose ApiVersions answer is `apis`, and what it sent. */
    const readAgainst = async (apis: unknown) => {
      const recorded = fakeLib({ "admin.listApis": () => apis });
      const against = createPlatformaticClient(OPTIONS, recorded.lib);
      const [topic] = (await against.metadata(["orders"])).topics;
      const outcome = await against.fetch(topic, 1, big(5), signal()).catch((e: KafkaError) => e);
      return { outcome, sent: fetchCount(recorded.calls) + argsOf(recorded.calls, "pool.get").length };
    };
    const fetchRange = (minVersion: number, maxVersion: number) => [
      { apiKey: 1, name: "Fetch", minVersion, maxVersion },
    ];
    // Fetch 13 at either end of a range is enough: the first version that names a topic by id, and
    // where Redpanda v26.2.2 stops.
    const held = await Promise.all([readAgainst(fetchRange(4, 13)), readAgainst(fetchRange(13, 18))]);
    expect(held.map(({ outcome }) => (outcome instanceof Error ? outcome : outcome.records[0].offset))).toEqual([
      big(5),
      big(5),
    ]);
    expect(held.map(({ sent }) => sent)).toEqual([2, 2]);
    const refused = await Promise.all([
      readAgainst(fetchRange(0, 12)),
      readAgainst(fetchRange(14, 18)),
      readAgainst([]),
    ]);
    expect(refused.map(({ outcome }) => (outcome as KafkaError).category)).toEqual([
      "unsupported-broker",
      "unsupported-broker",
      "unsupported-broker",
    ]);
    expect(refused.map(({ outcome }) => (outcome as KafkaError).message)).toEqual([
      "This broker answers Fetch versions 0 to 12; a read sends Fetch 13, which Apache Kafka answers from 3.1 on",
      "This broker answers Fetch versions 14 to 18; a read sends Fetch 13, which Apache Kafka answers from 3.1 on",
      "This broker answers no Fetch version; a read sends Fetch 13, which Apache Kafka answers from 3.1 on",
    ]);
    // Refused before a connection is asked for, let alone a fetch sent.
    expect(refused.map(({ sent }) => sent)).toEqual([0, 0, 0]);
  });

  test("Redpanda's captured answers read and fetch: node 0 leads every partition, and its Fetch range ends at 13", async () => {
    // Redpanda v26.2.2 runs one broker, node 0, and answers Fetch up to v13, so it sits on the
    // boundary of both refusals above: a leader of 0 is a leader (a partition with none answers
    // -1), and Fetch 13 is the version a read sends.
    const { lib, calls } = fakeLib({
      "admin.metadata": () => kafkaFixture("redpanda-metadata-orders"),
      "admin.listApis": () => kafkaFixture("redpanda-api-versions"),
      "consumer.listOffsets": () => kafkaFixture("redpanda-offsets-latest"),
      fetchV13: () => kafkaFixture("redpanda-fetch-orders-p1-o5"),
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    // The control: the captures hold both boundaries.
    expect(orders.partitions.map((p) => p.leader)).toEqual([0, 0, 0]);
    expect(
      kafkaFixture<Array<{ apiKey: number; maxVersion: number }>>("redpanda-api-versions").find((a) => a.apiKey === 1)
        ?.maxVersion,
    ).toBe(13);
    const offsets = await client.offsets("orders", "latest");
    expect(argsOf(calls, "consumer.listOffsets")).toHaveLength(1);
    expect([...offsets.keys()]).toEqual([0, 1, 2]);
    const captured = kafkaFixture<Map<string, bigint[]>>("redpanda-offsets-latest").get("orders")!;
    expect([...offsets]).toEqual(captured.map((offset, partition) => [partition, offset]));
    const read = await client.fetch(orders, 1, big(5), signal());
    // Node 0's advertised address, where Redpanda's one broker listens.
    expect(argsOf(calls, "pool.get")).toEqual([{ host: "localhost", port: 29092 }]);
    expect(read.records.map((r) => r.offset)).toEqual([5, 6, 7, 8, 9, 10, 11].map(big));
    expect(read.records.every((r) => r.partition === 1)).toBe(true);
    expect(read.nextOffset).toBe(big(12));
    // The captured batch starts at offset 0, so its records from the sixth on are the ones read.
    const [batch] = kafkaFixture<{
      responses: Array<{ partitions: Array<{ records: Array<{ records: Array<{ value: Uint8Array | null }> }> }> }>;
    }>("redpanda-fetch-orders-p1-o5").responses[0].partitions[0].records;
    expect(read.records.map((r) => r.value)).toEqual(batch.records.slice(5).map((r) => r.value));
  });

  test("a fetch sent to a leader that moved is sent once more, to the new leader's advertised address", async () => {
    const moved = afterLeaderMove(2, notLeader);
    const result = await moved.read();
    expect(result.records[0].offset).toBe(big(5));
    expect(moved.nodes()).toEqual([1, 2]);
    expect(argsOf(moved.calls, "pool.get")).toEqual([
      { host: "localhost", port: 9092 },
      { host: "broker-2.example", port: 9094 },
    ]);
    expect(argsOf(moved.calls, "admin.metadata").at(-1)).toEqual({
      topics: ["orders"],
      autocreateTopics: false,
      forceUpdate: true,
    });
  });

  test("a leader the cluster's broker list does not name is followed where a forced re-read says it moved", async () => {
    // Metadata lists live brokers only, so a leader that went down, or the leader of a stale copy,
    // has no address; no fetch is sent to it, and the re-read's leader is followed, to the address
    // the re-read lists: the copy the client held named broker 1 alone.
    const { lib, calls } = fakeLib({
      "admin.metadata": (o) => {
        if ((o as { forceUpdate?: boolean }).forceUpdate) return ordersWithLeader(2);
        const held = kafkaFixture<{ topics: Map<string, { partitions: Array<{ leader: number }> }> }>(
          "metadata-orders",
        );
        held.topics.get("orders")!.partitions[1].leader = 3;
        return held;
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    expect(orders.partitions[1].leader).toBe(3);
    const result = await client.fetch(orders, 1, big(5), signal());
    expect(result.records[0].offset).toBe(big(5));
    expect(fetchedFrom(calls)).toEqual([2]);
  });

  test("an IP broker a forced re-read first names rebuilds the fetch pool without SNI before the re-fetch connects", async () => {
    let fetches = 0;
    const { lib, constructed, calls } = fakeLib({
      "admin.metadata": (o) => {
        if (!(o as { forceUpdate?: boolean }).forceUpdate) return kafkaFixture("metadata-orders");
        const moved = ordersWithLeader(2);
        moved.brokers.set(2, { host: "10.0.0.7", port: 9094, rack: null });
        return moved;
      },
      fetchV13: () => {
        fetches++;
        if (fetches === 1) throw notLeader();
        return kafkaFixture("fetch-orders-p1-o5");
      },
    });
    const client = createPlatformaticClient(
      { ...OPTIONS, tls: { rejectUnauthorized: true }, tlsServerName: true },
      lib,
    );
    await client.fetch((await client.metadata(["orders"])).topics[0], 1, big(5), signal());
    expect(
      constructed.filter(([n]) => n === "ConnectionPool").map(([, o]) => (o as Record<string, unknown>).tlsServerName),
    ).toEqual([true, undefined]);
    const names = calls.map(([n]) => n);
    // The first pool is closed after the first fetch and before the connection the second one needs.
    expect(names.filter((n) => n === "pool.get" || n === "pool.close" || n === "fetchV13")).toEqual([
      "pool.get",
      "fetchV13",
      "pool.close",
      "pool.get",
      "fetchV13",
    ]);
    expect(argsOf(calls, "pool.get").at(-1)).toEqual({ host: "10.0.0.7", port: 9094 });
  });

  test("a leader the cluster does not list, which the re-read names again, sends no fetch and is refused, to be run again", async () => {
    const { lib, calls } = fakeLib({ "admin.metadata": () => ordersWithLeader(3) });
    const client = createPlatformaticClient(OPTIONS, lib);
    const error = await client
      .fetch((await client.metadata(["orders"])).topics[0], 1, big(5), signal())
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("protocol");
    expect(error.message).toContain("run the read again");
    expect(error.message).toContain("broker 3");
    expect(calls.some(([n]) => n === "fetchV13" || n === "pool.get")).toBe(false);
  });

  test.each<[string, "fetchV13" | "pool.get", () => unknown]>([
    ["LEADER_NOT_AVAILABLE while a new leader is elected", "fetchV13", () => fetchRefusal("LEADER_NOT_AVAILABLE")],
    [
      "UNKNOWN_TOPIC_OR_PARTITION from a broker a reassignment took the partition from",
      "fetchV13",
      () => fetchRefusal("UNKNOWN_TOPIC_OR_PARTITION"),
    ],
    [
      "a leader that is gone, which refuses the connection",
      "pool.get",
      () => connectionFailure("localhost", 9092, "ECONNREFUSED"),
    ],
  ])("%s: the fetch is sent once more, to the leader a forced re-read names", async (_, failing, failure) => {
    const moved = afterLeaderMove(2, failure, failing);
    const result = await moved.read();
    expect(result.records.map((r) => r.offset)).toEqual([5, 6, 7, 8, 9, 10, 11].map(big));
    expect(
      argsOf(moved.calls, "pool.get").map((b) =>
        NODE_AT.get(`${(b as { host: string }).host}:${(b as { port: number }).port}`),
      ),
    ).toEqual([1, 2]);
  });

  test("a leader that moved to node 0 is followed there: node 0 is a broker like any other, and Redpanda's only one", async () => {
    const moved = afterLeaderMove(0, notLeader);
    expect((await moved.read()).records[0].offset).toBe(big(5));
    expect(moved.nodes()).toEqual([1, 0]);
  });

  test("a re-read that names no leader (-1) sends no second fetch, and the read is refused, to be run again", async () => {
    const moved = afterLeaderMove(-1, notLeader);
    const error = await moved.read().catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.message).toContain("run it again");
    expect(moved.nodes()).toEqual([1]);
  });

  test("a stale leader that has not moved is said as such; any other fetch failure is not retried", async () => {
    const stuck = fakeLib({
      fetchV13: () => {
        throw notLeader();
      },
    });
    const stuckClient = createPlatformaticClient(OPTIONS, stuck.lib);
    const stale = await stuckClient
      .fetch((await stuckClient.metadata(["orders"])).topics[0], 1, big(5), signal())
      .catch((e) => e);
    expect(stale.message).toContain("leadership moved");
    // The re-read found the leader where it was, so the fetch is not sent to it again.
    expect(fetchCount(stuck.calls)).toBe(1);
    const range = fakeLib({
      fetchV13: () => {
        throw fetchRefusal("OFFSET_OUT_OF_RANGE");
      },
    });
    const rangeClient = createPlatformaticClient(OPTIONS, range.lib);
    const error = await rangeClient
      .fetch((await rangeClient.metadata(["orders"])).topics[0], 1, big(5), signal())
      .catch((e) => e);
    expect(error.category).toBe("offset-out-of-range");
    expect(fetchCount(range.calls)).toBe(1);
    expect(
      range.calls.some(([n, args]) => n === "admin.metadata" && (args[0] as { forceUpdate?: boolean }).forceUpdate),
    ).toBe(false);
  });

  test("an answer the client could not read is protocol, named by the error's code, though the client rejects it with no code of its own", async () => {
    // The client decompresses inside its response parser, and a batch that will not inflate fails the
    // fetch with zlib's own error, which carries no PLT_KFK_ code (measured through a local broker below).
    const { lib } = fakeLib({
      fetchV13: () => {
        throw Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR", errno: -3 });
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const error = await client
      .fetch((await client.metadata(["orders"])).topics[0], 1, big(5), signal())
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect([error.category, error.detail]).toEqual(["protocol", {}]);
    expect(error.message).toContain("Z_DATA_ERROR");
    expect(error.message).not.toContain("incorrect header check");
  });

  test("two reads fetch side by side: a fetch opens no session, so neither waits for the other", async () => {
    const { held, state, fetch } = heldFetches();
    const { lib } = fakeLib({ fetchV13: fetch });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const first = client.fetch(orders, 1, big(5), signal());
    const second = client.fetch(orders, 1, big(5), signal());
    await until(() => held.length === 2);
    expect(state.most).toBe(2);
    // The second read answers while the first is still held: the answers settle in any order.
    held.pop()!();
    expect((await second).records[0].offset).toBe(big(5));
    held.pop()!();
    expect((await first).records[0].offset).toBe(big(5));
  });

  test("a read its timeout stopped is answered at once, and the next read's fetch is sent while the stopped one is still out", async () => {
    const { held, fetch } = heldFetches();
    const { lib } = fakeLib({ fetchV13: fetch });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const controller = new AbortController();
    const stopped = client.fetch(orders, 1, big(5), controller.signal).catch((e) => e);
    await until(() => held.length === 1);
    controller.abort();
    expect((await stopped).category).toBe("timeout");
    const next = client.fetch(orders, 1, big(5), signal());
    await until(() => held.length === 2);
    held.pop()!();
    expect((await next).records[0].offset).toBe(big(5));
    held.pop()!();
  });

  test("an aborted signal rejects the fetch as a timeout and sends nothing", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const controller = new AbortController();
    controller.abort();
    const error = await client
      .fetch((await client.metadata(["orders"])).topics[0], 1, big(5), controller.signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("timeout");
    expect(calls.some(([n]) => n === "fetchV13" || n === "pool.get" || n === "admin.listApis")).toBe(false);
  });

  test.each<[string, string, () => unknown]>([
    ["the broker's Fetch range", "admin.listApis", () => kafkaFixture("api-versions")],
    ["the cluster's broker list", "admin.metadata", () => kafkaFixture("metadata-orders")],
    ["a pooled connection", "pool.get", () => ({ broker: { host: "localhost", port: 9092 } })],
  ])("a read stopped while it awaited %s is answered at once and sends no fetch", async (_, awaited, answer) => {
    const waiting: Array<() => void> = [];
    let armed = false;
    const { lib, calls } = fakeLib({
      [awaited]: () =>
        armed
          ? new Promise((resolve) => {
              waiting.push(() => resolve(answer()));
            })
          : answer(),
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    armed = true;
    const controller = new AbortController();
    const stopped = client.fetch(orders, 1, big(5), controller.signal).catch((e) => e);
    await until(() => waiting.length === 1);
    controller.abort();
    expect((await stopped).category).toBe("timeout");
    waiting.shift()!();
    await pause(20);
    expect(fetchCount(calls)).toBe(0);
  });

  test("a read whose signal stops while a step is being asked for is answered as it waits on it, and asks for no connection", async () => {
    // The signal stops inside the call the broker list is read with, so the step that waits on it
    // starts on a signal that has already fired and would never hear it fire.
    const controller = new AbortController();
    let armed = false;
    const { lib, calls } = fakeLib({
      "admin.metadata": () => {
        if (armed) controller.abort();
        return kafkaFixture("metadata-orders");
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    armed = true;
    const error = await client.fetch(orders, 1, big(5), controller.signal).catch((e) => e);
    expect(error.category).toBe("timeout");
    await pause(20);
    expect(calls.some(([n]) => n === "pool.get" || n === "fetchV13")).toBe(false);
  });

  test("a read stopped while it awaited the forced re-read of a moved leader is answered at once and sends no second fetch", async () => {
    const reread: Array<() => void> = [];
    const { lib, calls } = fakeLib({
      "admin.metadata": (o) =>
        (o as { forceUpdate?: boolean }).forceUpdate && (o as { topics: string[] }).topics.length > 0
          ? new Promise((resolve) => {
              reread.push(() => resolve(ordersWithLeader(2)));
            })
          : ordersWithLeader(1),
      fetchV13: () => {
        throw notLeader();
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const controller = new AbortController();
    const stopped = client.fetch(orders, 1, big(5), controller.signal).catch((e) => e);
    await until(() => reread.length === 1);
    controller.abort();
    expect((await stopped).category).toBe("timeout");
    reread.shift()!();
    await pause(20);
    expect(fetchedFrom(calls)).toEqual([1]);
  });

  test("a settled fetch leaves no listener on the read's signal, which one read shares across all its fetches", async () => {
    let fetches = 0;
    const { lib } = fakeLib({
      fetchV13: () => {
        fetches++;
        if (fetches === 2) throw fetchRefusal("OFFSET_OUT_OF_RANGE");
        return kafkaFixture("fetch-orders-p1-o5");
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const read = new AbortController();
    await client.fetch(orders, 1, big(5), read.signal);
    expect((await client.fetch(orders, 1, big(5), read.signal).catch((e) => e)).category).toBe("offset-out-of-range");
    await client.fetch(orders, 1, big(5), read.signal);
    expect(getEventListeners(read.signal, "abort")).toHaveLength(0);
  });

  test("listGroups asks for both types, because the default omits KIP-848 groups (M-E)", async () => {
    const { lib, calls } = fakeLib();
    const groups = await createPlatformaticClient(OPTIONS, lib).listGroups();
    expect(argsOf(calls, "admin.listGroups")).toEqual([{ types: ["consumer", "classic"] }]);
    expect(groups).toEqual([
      { groupId: "lag-classic", state: "Empty", groupType: "classic", protocolType: "consumer" },
      { groupId: "lag-kip848", state: "Empty", groupType: "consumer", protocolType: "consumer" },
      { groupId: "lag-partial", state: "Empty", groupType: "classic", protocolType: "consumer" },
    ]);
  });

  test("a broker below ListGroups v5 names no type, and its groups are read as classic (captured on Redpanda)", async () => {
    const { lib } = fakeLib({ "admin.listGroups": () => kafkaFixture("redpanda-list-groups") });
    expect((await createPlatformaticClient(OPTIONS, lib).listGroups()).map((g) => [g.groupId, g.groupType])).toEqual([
      ["lag-classic", "classic"],
      ["lag-partial", "classic"],
    ]);
  });

  test("listGroups keeps consumer groups only, by Kafka's own rule, and reads a missing type as classic", async () => {
    const { lib } = fakeLib({
      "admin.listGroups": () =>
        new Map([
          [
            "connect-cluster",
            { id: "connect-cluster", state: "Stable", groupType: "classic", protocolType: "connect" },
          ],
          ["schema-registry", { id: "schema-registry", state: "Stable", groupType: "classic", protocolType: "sr" }],
          ["offsets-only", { id: "offsets-only", state: "Empty", groupType: "classic", protocolType: "" }],
          ["share-group", { id: "share-group", state: "Empty", groupType: "share", protocolType: "share" }],
          // Kafka's own filter takes the type and the protocol type each on its own terms.
          ["streams-app", { id: "streams-app", state: "Stable", groupType: "streams", protocolType: "" }],
          ["kip848", { id: "kip848", state: "Stable", groupType: "consumer", protocolType: "consumer" }],
          ["pre-v5", { id: "pre-v5", state: "Stable", protocolType: "consumer" }],
        ]),
    });
    expect(await createPlatformaticClient(OPTIONS, lib).listGroups()).toEqual([
      { groupId: "kip848", state: "Stable", groupType: "consumer", protocolType: "consumer" },
      { groupId: "offsets-only", state: "Empty", groupType: "classic", protocolType: "" },
      { groupId: "pre-v5", state: "Stable", groupType: "classic", protocolType: "consumer" },
    ]);
  });

  test("describeGroup dispatches: classic to describeGroups, consumer to API 69 over a closed Connection", async () => {
    const { lib, calls, constructed } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const classic = await client.describeGroup({
      groupId: "lag-classic",
      state: "Empty",
      groupType: "classic",
      protocolType: "consumer",
    });
    expect(classic).toEqual({
      groupId: "lag-classic",
      groupType: "classic",
      state: "Empty",
      protocolOrAssignor: "",
      members: [],
    });
    expect(argsOf(calls, "admin.describeGroups")).toEqual([{ groups: ["lag-classic"] }]);
    const kip = await client.describeGroup({
      groupId: "lag-kip848",
      state: "Empty",
      groupType: "consumer",
      protocolType: "consumer",
    });
    expect(kip).toEqual({
      groupId: "lag-kip848",
      groupType: "consumer",
      state: "Empty",
      protocolOrAssignor: "uniform",
      members: [],
    });
    expect(argsOf(calls, "admin.findCoordinator")).toEqual([{ keyType: 0, keys: ["lag-kip848"] }]);
    expect(calls.find(([n]) => n === "connection.connect")![1]).toEqual(["localhost", 9092]);
    expect(calls.find(([n]) => n === "consumerGroupDescribeV0")![1].slice(1)).toEqual([["lag-kip848"], false]);
    expect(constructed.find(([n]) => n === "Connection")![1]).toMatchObject({
      id: "libredb-studio",
      connectTimeout: 5000,
      requestTimeout: 5000,
    });
    // Without TLS the connection carries no server name, as the clients carry none; with TLS, the
    // KIP-848 member test below sends one to a DNS host.
    expect(Object.keys(constructed.find(([n]) => n === "Connection")![1] as object)).not.toContain("tlsServerName");
    expect(calls.filter(([n]) => n === "connection.close").length).toBe(1);
  });

  test("a classic group's members and their assignments are mapped", async () => {
    const { lib } = fakeLib({
      "admin.describeGroups": () =>
        new Map([
          [
            "billing",
            {
              state: "Stable",
              protocol: "range",
              members: new Map([
                [
                  "m1",
                  {
                    id: "m1",
                    clientId: "c1",
                    clientHost: "/10.0.0.9",
                    assignments: new Map([["orders", { partitions: [0, 2] }]]),
                  },
                ],
                ["m2", { id: "m2", clientId: "c2", clientHost: "/10.0.0.8" }],
              ]),
            },
          ],
        ]),
    });
    expect(
      await createPlatformaticClient(OPTIONS, lib).describeGroup({
        groupId: "billing",
        state: "Stable",
        groupType: "classic",
        protocolType: "consumer",
      }),
    ).toEqual({
      groupId: "billing",
      groupType: "classic",
      state: "Stable",
      protocolOrAssignor: "range",
      members: [
        {
          memberId: "m1",
          clientId: "c1",
          clientHost: "/10.0.0.9",
          assignment: [{ topic: "orders", partitions: [0, 2] }],
        },
        // A member whose metadata the library could not read carries no assignment.
        { memberId: "m2", clientId: "c2", clientHost: "/10.0.0.8", assignment: [] },
      ],
    });
  });

  test("a classic group's description is its own entry of the answer, never the first by position", async () => {
    const { lib } = fakeLib({
      "admin.describeGroups": () =>
        new Map([
          ["other", { state: "Stable", protocol: "range", members: new Map() }],
          ["lag-classic", { state: "Empty", protocol: "", members: new Map() }],
        ]),
    });
    expect(
      await createPlatformaticClient(OPTIONS, lib).describeGroup({
        groupId: "lag-classic",
        state: "Empty",
        groupType: "classic",
        protocolType: "consumer",
      }),
    ).toEqual({ groupId: "lag-classic", groupType: "classic", state: "Empty", protocolOrAssignor: "", members: [] });
  });

  test("a classic group the description does not hold is a protocol error, never the listing's state", async () => {
    const { lib } = fakeLib({ "admin.describeGroups": () => new Map() });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .describeGroup({ groupId: "lag-classic", state: "Empty", groupType: "classic", protocolType: "consumer" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("protocol");
    expect(error.message).toContain('"lag-classic"');
  });

  test("a classic group of another protocol type is never handed to describeGroups", async () => {
    const { lib, calls } = fakeLib();
    const error = await createPlatformaticClient(OPTIONS, lib)
      .describeGroup({ groupId: "connect-cluster", state: "Stable", groupType: "classic", protocolType: "connect" })
      .catch((e) => e);
    expect(error.category).toBe("unknown-object");
    expect(calls.some(([n]) => n === "admin.describeGroups")).toBe(false);
  });

  test("a classic group with no protocol type, one that only ever committed offsets, is described (spec 4.3)", async () => {
    // A consumer that assigns its own partitions and commits under a group id never joins, so the
    // broker lists and describes its group with an empty protocol type, and the listing keeps it.
    const { lib, calls } = fakeLib({
      "admin.describeGroups": () =>
        new Map([
          ["offsets-only", { id: "offsets-only", state: "Empty", protocolType: "", protocol: "", members: new Map() }],
        ]),
    });
    const group = await createPlatformaticClient(OPTIONS, lib).describeGroup({
      groupId: "offsets-only",
      state: "Empty",
      groupType: "classic",
      protocolType: "",
    });
    expect(argsOf(calls, "admin.describeGroups")).toEqual([{ groups: ["offsets-only"] }]);
    expect(group).toEqual({
      groupId: "offsets-only",
      groupType: "classic",
      state: "Empty",
      protocolOrAssignor: "",
      members: [],
    });
  });

  test("a KIP-848 group's members are mapped from API 69, and its connection sends SNI only to a DNS host", async () => {
    const answer = {
      groups: [
        {
          errorCode: 0,
          errorMessage: null,
          groupId: "g",
          groupState: "Stable",
          assignorName: "uniform",
          members: [
            {
              memberId: "m",
              clientId: "c",
              clientHost: "/h",
              assignment: { topicPartitions: [{ topicName: "orders", partitions: [1] }] },
            },
          ],
        },
      ],
    };
    const tlsOptions = { ...OPTIONS, tls: { rejectUnauthorized: true }, tlsServerName: true as const };
    const listing = { groupId: "g", state: "Stable", groupType: "consumer" as const, protocolType: "consumer" };
    for (const [host, sni] of [
      ["broker-2.example", true],
      ["10.0.0.5", undefined],
    ] as const) {
      const { lib, constructed } = fakeLib({
        consumerGroupDescribeV0: () => answer,
        "admin.findCoordinator": () => [{ key: "g", nodeId: 2, host, port: 9092 }],
      });
      const group = await createPlatformaticClient(tlsOptions, lib).describeGroup(listing);
      expect(group.members).toEqual([
        { memberId: "m", clientId: "c", clientHost: "/h", assignment: [{ topic: "orders", partitions: [1] }] },
      ]);
      const connection = constructed.find(([n]) => n === "Connection")![1] as Record<string, unknown>;
      expect(connection.tlsServerName).toBe(sni);
      expect(connection.tls).toEqual({ rejectUnauthorized: true });
    }
  });

  test("the API 69 connection carries the SASL and TLS options the clients carry, the same objects, and neither without them (spec 4.3)", async () => {
    // Built from the same options object as the clients: without the SASL options, a SASL listener
    // closes the connection, and every consumer-protocol group's source reads as an unreachable broker.
    const listing = { groupId: "lag-kip848", state: "Empty", groupType: "consumer" as const, protocolType: "consumer" };
    const sasl = { mechanism: "SCRAM-SHA-512" as const, username: "u", password: "p" };
    const tls = { rejectUnauthorized: true };
    const secured = fakeLib();
    await createPlatformaticClient({ ...OPTIONS, tls, sasl, tlsServerName: true }, secured.lib).describeGroup(listing);
    const clients = secured.constructed.map(([name, options]) => [name, options as Record<string, unknown>] as const);
    expect(clients.map(([name]) => name)).toEqual(["Admin", "Consumer", "ConnectionPool", "Connection"]);
    for (const [, options] of clients) {
      expect(options.sasl).toBe(sasl);
      expect(options.tls).toBe(tls);
    }
    const plain = fakeLib();
    await createPlatformaticClient(OPTIONS, plain.lib).describeGroup(listing);
    const connection = plain.constructed.find(([n]) => n === "Connection")![1] as object;
    expect(Object.keys(connection).sort()).toEqual(["connectTimeout", "id", "requestTimeout"]);
  });

  test("API 69 throws a ResponseError carrying the response; the group's own entry is read from it (M-F)", async () => {
    const mixed = kafkaFixture<Record<string, unknown>>("error-consumer-group-describe-mixed");
    const { lib } = fakeLib({
      consumerGroupDescribeV0: () => {
        throw Object.assign(new Error(String(mixed.message)), mixed);
      },
    });
    const kip = await createPlatformaticClient(OPTIONS, lib).describeGroup({
      groupId: "lag-kip848",
      state: "Empty",
      groupType: "consumer",
      protocolType: "consumer",
    });
    expect(kip).toMatchObject({ groupId: "lag-kip848", state: "Empty", protocolOrAssignor: "uniform" });
  });

  test("the coordinator and API 69's answer are each read by the group asked for, never by position", async () => {
    const own = {
      errorCode: 0,
      errorMessage: null,
      groupId: "g",
      groupState: "Stable",
      assignorName: "uniform",
      members: [],
    };
    const { lib, calls } = fakeLib({
      "admin.findCoordinator": () => [
        { key: "other", nodeId: 1, host: "broker-1.example", port: 9092 },
        { key: "g", nodeId: 2, host: "broker-2.example", port: 9093 },
      ],
      consumerGroupDescribeV0: () => ({
        groups: [{ ...own, groupId: "other", groupState: "Empty", assignorName: "range" }, own],
      }),
    });
    const group = await createPlatformaticClient(OPTIONS, lib).describeGroup({
      groupId: "g",
      state: "Stable",
      groupType: "consumer",
      protocolType: "consumer",
    });
    expect(group).toEqual({
      groupId: "g",
      groupType: "consumer",
      state: "Stable",
      protocolOrAssignor: "uniform",
      members: [],
    });
    expect(calls.find(([n]) => n === "connection.connect")![1]).toEqual(["broker-2.example", 9093]);
  });

  test("an API 69 failure with no response propagates, and the connection is still closed", async () => {
    const { lib, calls } = fakeLib({
      consumerGroupDescribeV0: () => {
        throw libError({ code: "PLT_KFK_NETWORK", message: "Connection closed" });
      },
    });
    const listing = { groupId: "lag-kip848", state: "Empty", groupType: "consumer" as const, protocolType: "consumer" };
    expect(
      (
        await createPlatformaticClient(OPTIONS, lib)
          .describeGroup(listing)
          .catch((e) => e)
      ).category,
    ).toBe("network");
    expect(calls.filter(([n]) => n === "connection.close").length).toBe(1);
  });

  test("an API 69 entry answered GROUP_ID_NOT_FOUND is unknown-object in the adapter's own words, never the broker's (captured)", async () => {
    // The capture asked for lag-kip848 and lag-classic together; lag-classic's entry, second in the
    // answer, carries 69 with the broker's text "Group lag-classic is not a consumer group.".
    const mixed = kafkaFixture<Record<string, unknown>>("error-consumer-group-describe-mixed");
    const { lib, calls } = fakeLib({
      consumerGroupDescribeV0: () => {
        throw Object.assign(new Error(String(mixed.message)), mixed);
      },
      "admin.findCoordinator": () => [{ key: "lag-classic", nodeId: 1, host: "localhost", port: 9092 }],
    });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .describeGroup({ groupId: "lag-classic", state: "Empty", groupType: "consumer", protocolType: "consumer" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect([error.category, error.message, error.detail]).toEqual([
      "unknown-object",
      'Consumer group "lag-classic" could not be described: the broker holds no consumer-protocol group by that id (GROUP_ID_NOT_FOUND)',
      { apiId: "GROUP_ID_NOT_FOUND" },
    ]);
    expect(calls.filter(([n]) => n === "connection.close").length).toBe(1);
  });

  test.each<[string, number, string | null, string, string, Record<string, string>]>([
    [
      "TOPIC_AUTHORIZATION_FAILED",
      29,
      null,
      "authorization",
      "The broker denied access to this topic",
      { resource: "topic" },
    ],
    [
      "TOPIC_AUTHORIZATION_FAILED",
      29,
      "The described group uses topics that the client is not authorized to describe.",
      "authorization",
      "The broker denied access to this topic",
      { resource: "topic" },
    ],
    [
      "GROUP_AUTHORIZATION_FAILED",
      30,
      null,
      "authorization",
      "The broker denied access to this group",
      { resource: "group" },
    ],
    [
      "COORDINATOR_LOAD_IN_PROGRESS",
      14,
      null,
      "protocol",
      "The request to the broker failed (COORDINATOR_LOAD_IN_PROGRESS)",
      {},
    ],
    [
      "COORDINATOR_NOT_AVAILABLE",
      15,
      null,
      "protocol",
      "The request to the broker failed (COORDINATOR_NOT_AVAILABLE)",
      {},
    ],
    ["NOT_COORDINATOR", 16, null, "protocol", "The request to the broker failed (NOT_COORDINATOR)", {}],
  ])(
    "an API 69 entry answered %s (%d, message %p) is %s, by its protocol error name, never the broker's text (spec 5.6)",
    async (apiId, apiCode, brokerText, category, message, detail) => {
      // The group was listed, so it exists (spec 4.3): an entry that carries a coordinator's error or a
      // refusal is that error, never "no entry"; the coordinator's three errors carry a null message
      // in Kafka 4.3.1 (ConsumerGroupDescribeRequest sets only the code and the group id).
      const { lib, calls } = fakeLib({
        consumerGroupDescribeV0: () => {
          throw groupDescribeRefusal([{ groupId: "g", error: [apiId, apiCode, brokerText] }]);
        },
        "admin.findCoordinator": () => [{ key: "g", nodeId: 1, host: "localhost", port: 9092 }],
      });
      const error = await createPlatformaticClient(OPTIONS, lib)
        .describeGroup({ groupId: "g", state: "Stable", groupType: "consumer", protocolType: "consumer" })
        .catch((e) => e);
      expect(error).toBeInstanceOf(KafkaError);
      expect([error.category, error.message, error.detail]).toEqual([category, message, { apiId, ...detail }]);
      expect(calls.filter(([n]) => n === "connection.close").length).toBe(1);
    },
  );

  test("an API 69 entry's error is its own entry's, found by the group asked for, never the first error the answer holds", async () => {
    const { lib } = fakeLib({
      consumerGroupDescribeV0: () => {
        throw groupDescribeRefusal([
          { groupId: "other", error: ["GROUP_AUTHORIZATION_FAILED", 30, null] },
          { groupId: "g", error: ["NOT_COORDINATOR", 16, null] },
        ]);
      },
      "admin.findCoordinator": () => [{ key: "g", nodeId: 1, host: "localhost", port: 9092 }],
    });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .describeGroup({ groupId: "g", state: "Stable", groupType: "consumer", protocolType: "consumer" })
      .catch((e) => e);
    expect([error.category, error.detail]).toEqual(["protocol", { apiId: "NOT_COORDINATOR" }]);
  });

  test("an API 69 entry with an error code the client named no protocol error for is a protocol error naming the code", async () => {
    // The client throws on every errored entry, so an answer handed over with one is its anomaly.
    const { lib } = fakeLib({
      consumerGroupDescribeV0: () => ({
        groups: [{ errorCode: 16, errorMessage: null, groupId: "g", groupState: "", assignorName: "", members: [] }],
      }),
      "admin.findCoordinator": () => [{ key: "g", nodeId: 1, host: "localhost", port: 9092 }],
    });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .describeGroup({ groupId: "g", state: "Stable", groupType: "consumer", protocolType: "consumer" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect([error.category, error.message]).toEqual(["protocol", "The request to the broker failed (error code 16)"]);
  });

  test("an API 69 answer with no entry for the group is a protocol error saying so; no coordinator is said, never guessed", async () => {
    const listing = {
      groupId: "lag-classic",
      state: "Empty",
      groupType: "consumer" as const,
      protocolType: "consumer",
    };
    const empty = fakeLib({
      consumerGroupDescribeV0: () => ({ groups: [] }),
      "admin.findCoordinator": () => [{ key: "lag-classic", nodeId: 1, host: "localhost", port: 9092 }],
    });
    const absent = await createPlatformaticClient(OPTIONS, empty.lib)
      .describeGroup(listing)
      .catch((e) => e);
    expect(absent).toBeInstanceOf(KafkaError);
    expect([absent.category, absent.message]).toEqual([
      "protocol",
      'The broker\'s consumer group description holds no entry for group "lag-classic"',
    ]);
    const none = fakeLib({ "admin.findCoordinator": () => [] });
    expect(
      (
        await createPlatformaticClient(OPTIONS, none.lib)
          .describeGroup(listing)
          .catch((e) => e)
      ).category,
    ).toBe("protocol");
  });

  test("committed offsets are the group's own entry, wherever the answer holds it", async () => {
    const answer =
      kafkaFixture<
        Array<{
          groupId: string;
          topics: Array<{ name: string; partitions: Array<{ partitionIndex: number; committedOffset: bigint }> }>;
        }>
      >("committed-offsets");
    expect(answer.length).toBeGreaterThan(1);
    // The kip848 entry last, whatever order the capture holds, so reading by position would fail.
    const { lib, calls } = fakeLib({
      "admin.listConsumerGroupOffsets": () => [
        ...answer.filter((g) => g.groupId !== "lag-kip848"),
        ...answer.filter((g) => g.groupId === "lag-kip848"),
      ],
    });
    const own = answer.find((g) => g.groupId === "lag-kip848")!;
    expect(await createPlatformaticClient(OPTIONS, lib).committedOffsets("lag-kip848")).toEqual(
      own.topics.flatMap((t) =>
        t.partitions.map((p) => ({ topic: t.name, partition: p.partitionIndex, offset: p.committedOffset })),
      ),
    );
    expect(argsOf(calls, "admin.listConsumerGroupOffsets")).toEqual([{ groups: ["lag-kip848"] }]);
    const none = fakeLib({ "admin.listConsumerGroupOffsets": () => [] });
    expect(
      (
        await createPlatformaticClient(OPTIONS, none.lib)
          .committedOffsets("g")
          .catch((e) => e)
      ).category,
    ).toBe("protocol");
  });

  test("committed offsets are every partition of every topic the group's entry holds, in the answer's order (spec 4.3)", async () => {
    // Every capture's group committed on one topic; a real group commits on several, and a source that
    // kept the first would drop every other topic's lag rows. lag-classic's captured entry gains a
    // second topic with two partitions, listed out of order.
    const answer =
      kafkaFixture<
        Array<{
          groupId: string;
          topics: Array<{ name: string; partitions: Array<{ partitionIndex: number; committedOffset: bigint }> }>;
        }>
      >("committed-offsets");
    const own = answer.find((g) => g.groupId === "lag-classic")!;
    own.topics.push({
      name: "payments",
      partitions: [
        { partitionIndex: 1, committedOffset: big(4) },
        { partitionIndex: 0, committedOffset: big(9) },
      ],
    });
    const { lib } = fakeLib({ "admin.listConsumerGroupOffsets": () => [own] });
    const orders = own.topics[0].partitions.map((p) => ({
      topic: "orders",
      partition: p.partitionIndex,
      offset: p.committedOffset,
    }));
    expect(orders).toHaveLength(3);
    expect(await createPlatformaticClient(OPTIONS, lib).committedOffsets("lag-classic")).toEqual([
      ...orders,
      { topic: "payments", partition: 1, offset: big(4) },
      { topic: "payments", partition: 0, offset: big(9) },
    ]);
  });

  test("configs are asked for with no key list, which the protocol reads as every key: Redpanda answers an empty list with none", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const topic = await client.topicConfigs("orders");
    expect(topic.map((c) => c.name)).toEqual([...topic.map((c) => c.name)].sort());
    expect(topic.length).toBe(33);
    expect(topic.find((c) => c.name === "compression.type")).toEqual({
      name: "compression.type",
      value: "producer",
      readOnly: false,
      isSensitive: false,
      source: 5,
    });
    const broker = await client.brokerConfigs(1);
    expect(broker.some((c) => c.name === "max.connections")).toBe(true);
    expect(argsOf(calls, "admin.describeConfigs")).toEqual([
      { resources: [{ resourceType: 2, resourceName: "orders" }], includeSynonyms: false, includeDocumentation: false },
      { resources: [{ resourceType: 4, resourceName: "1" }], includeSynonyms: false, includeDocumentation: false },
    ]);
  });

  test("configs are read from the answer's entry for the resource asked; an answer without it is a protocol error", async () => {
    const { lib } = fakeLib({ "admin.describeConfigs": () => kafkaFixture("configs-broker-1") });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .topicConfigs("orders")
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("protocol");
    expect(error.message).toContain('"orders"');
  });

  test("a config entry is the resource asked for by type as well as name: broker 1's configs are not topic 1's", async () => {
    // A topic may be named "1", which is how a broker's id is written in the request.
    const { lib } = fakeLib({
      "admin.describeConfigs": () => [
        {
          resourceType: 4,
          resourceName: "1",
          configs: [{ name: "max.connections", value: "9", readOnly: false, configSource: 5, isSensitive: false }],
        },
      ],
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const error = await client.topicConfigs("1").catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("protocol");
    // The control: the same answer is broker 1's.
    expect((await client.brokerConfigs(1)).map((c) => c.name)).toEqual(["max.connections"]);
  });

  test("log dirs sum each directory's partition sizes, per broker, for the topics named", async () => {
    const { lib, calls } = fakeLib({
      "admin.describeLogDirs": () => [
        {
          broker: 1,
          results: [
            {
              logDir: "/a",
              totalBytes: big(100),
              usableBytes: big(40),
              topics: [{ partitions: [{ partitionSize: big(5) }, { partitionSize: big(7) }] }],
            },
          ],
        },
      ],
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    expect(await client.logDirs([orders])).toEqual([
      { brokerId: 1, path: "/a", sizeBytes: big(12), totalBytes: big(100), usableBytes: big(40) },
    ]);
    expect(argsOf(calls, "admin.describeLogDirs")).toEqual([{ topics: [{ name: "orders", partitions: [0, 1, 2] }] }]);
  });

  test("the captured log dirs map to one row per broker directory", async () => {
    const { lib } = fakeLib();
    expect(await createPlatformaticClient(OPTIONS, lib).logDirs([])).toEqual([
      {
        brokerId: 1,
        path: "/tmp/kafka-logs",
        // The three captured partition sizes of orders on that directory.
        sizeBytes: big(1125 + 2189 + 2189),
        totalBytes: big(294147883008),
        usableBytes: big(61404086272),
      },
    ]);
  });

  test("close closes both clients and the fetch pool, whose connections a read's fetches went out on", async () => {
    const { lib, calls } = fakeLib();
    await createPlatformaticClient(OPTIONS, lib).close();
    expect(
      calls
        .map(([n]) => n)
        .filter((n) => n.endsWith(".close"))
        .sort(),
    ).toEqual(["admin.close", "consumer.close", "pool.close"]);
  });

  test("a defect that is not a library error passes through untranslated", async () => {
    const { lib } = fakeLib({ "admin.listTopics": () => undefined });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .listTopics()
      .catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
  });
});

describe("the fetch answer's batches (Review Focus 2)", () => {
  const batch = (over: Record<string, unknown>) => ({
    firstOffset: big(0),
    lastOffsetDelta: 0,
    firstTimestamp: big(1000),
    maxTimestamp: big(1000),
    attributes: 0,
    producerId: big(-1),
    records: [],
    ...over,
  });
  const rec = (offsetDelta: number, key: number[] | null = null, timestampDelta = 0) => ({
    offsetDelta,
    timestampDelta: big(timestampDelta),
    key: key === null ? null : Buffer.from(key),
    value: Buffer.from("v"),
    headers: [],
  });
  /** The answer for orders partition 1, which is what `fetched` asks for. */
  const answer = (records: unknown[], abortedTransactions: unknown[] | null = null) => ({
    responses: [{ topicId: ORDERS_ID, partitions: [{ partitionIndex: 1, abortedTransactions, records }] }],
  });
  /** Control record keys: an int16 version, then the type, 0 ABORT or 1 COMMIT. */
  const COMMIT = [0, 0, 0, 1];
  const ABORT = [0, 0, 0, 0];
  async function fetched(response: unknown, from = 0, topic = "orders", partition = 1) {
    const { lib } = fakeLib({ fetchV13: () => response, "admin.metadata": allTopics });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [meta] = (await client.metadata([topic])).topics as KafkaTopicMetadata[];
    return client.fetch(meta, partition, big(from), signal());
  }

  test("a transaction marker is never a row, and still advances nextOffset", async () => {
    const result = await fetched(
      answer([
        batch({ records: [rec(0)] }),
        batch({ firstOffset: big(1), attributes: 0x30, producerId: big(7), records: [rec(0, COMMIT)] }),
      ]),
    );
    expect(result.records.map((r) => r.offset)).toEqual([big(0)]);
    expect(result.nextOffset).toBe(big(2));
  });

  test("nextOffset is past every batch the answer holds, whatever order it lists them in", async () => {
    // A broker lists batches in log order; an answer that does not is still read past its furthest one.
    const result = await fetched(
      answer([batch({ firstOffset: big(3), records: [rec(0)] }), batch({ firstOffset: big(1), records: [rec(0)] })]),
      1,
    );
    expect(result.nextOffset).toBe(big(4));
  });

  test("a marker-only answer advances with no records", async () => {
    expect(
      await fetched(
        answer([batch({ firstOffset: big(1), attributes: 0x30, producerId: big(7), records: [rec(0, ABORT)] })]),
        1,
      ),
    ).toEqual({
      records: [],
      nextOffset: big(2),
    });
  });

  test("a control batch with no marker record is still no row", async () => {
    const result = await fetched(
      answer([batch({ firstOffset: big(3), attributes: 0x30, producerId: big(7), records: [] })]),
      3,
    );
    expect(result).toEqual({ records: [], nextOffset: big(4) });
  });

  test("an aborted transaction's records are dropped up to its ABORT marker, and the producer's next transaction is kept", async () => {
    const result = await fetched(
      answer(
        [
          batch({ attributes: 0x10, producerId: big(7), lastOffsetDelta: 1, records: [rec(0), rec(1)] }),
          batch({ firstOffset: big(2), attributes: 0x30, producerId: big(7), records: [rec(0, ABORT)] }),
          batch({ firstOffset: big(3), records: [rec(0)] }),
          batch({ firstOffset: big(4), attributes: 0x10, producerId: big(7), records: [rec(0)] }),
        ],
        [{ producerId: big(7), firstOffset: big(0) }],
      ),
    );
    expect(result.records.map((r) => r.offset)).toEqual([big(3), big(4)]);
  });

  test("an aborted transaction whose marker lies past this answer is dropped too, which the library's own filter misses", async () => {
    const result = await fetched(
      answer(
        [
          batch({ attributes: 0x10, producerId: big(7), records: [rec(0)] }),
          batch({ firstOffset: big(1), records: [rec(0)] }),
        ],
        [{ producerId: big(7), firstOffset: big(0) }],
      ),
    );
    expect(result.records.map((r) => r.offset)).toEqual([big(1)]);
  });

  test("two aborted transactions, listed in any order, each drop their producer's batches from their own first offset", async () => {
    const result = await fetched(
      answer(
        [
          batch({ attributes: 0x10, producerId: big(8), records: [rec(0)] }),
          batch({ firstOffset: big(1), attributes: 0x10, producerId: big(7), records: [rec(0)] }),
          batch({ firstOffset: big(2), records: [rec(0)] }),
        ],
        [
          { producerId: big(7), firstOffset: big(1) },
          { producerId: big(8), firstOffset: big(0) },
        ],
      ),
    );
    expect(result.records.map((r) => r.offset)).toEqual([big(2)]);
  });

  test("only a transaction's batches are aborted: a batch of the same producer that is not transactional is kept (the Java rule)", async () => {
    const result = await fetched(
      answer(
        [
          batch({ attributes: 0x00, producerId: big(7), records: [rec(0)] }),
          batch({ firstOffset: big(1), attributes: 0x10, producerId: big(7), records: [rec(0)] }),
        ],
        [{ producerId: big(7), firstOffset: big(0) }],
      ),
    );
    expect(result.records.map((r) => r.offset)).toEqual([big(0)]);
  });

  test("a marker's type is its key's second int16, whatever its version: a version 1 ABORT still ends the transaction", async () => {
    // The Java consumer's ControlRecordType.parse reads the type at byte 2 and only logs a version it does not know.
    const result = await fetched(
      answer(
        [
          batch({ attributes: 0x10, producerId: big(7), records: [rec(0)] }),
          batch({ firstOffset: big(1), attributes: 0x30, producerId: big(7), records: [rec(0, [0, 1, 0, 0])] }),
          batch({ firstOffset: big(2), attributes: 0x10, producerId: big(7), records: [rec(0)] }),
        ],
        [{ producerId: big(7), firstOffset: big(0) }],
      ),
    );
    expect(result.records.map((r) => r.offset)).toEqual([big(2)]);
  });

  test.each<[string, number[] | null]>([
    ["no key", null],
    ["a key shorter than a version and a type", [0, 0]],
    ["a negative version", [0xff, 0xff, 0, 0]],
  ])(
    "a marker with %s is refused as the broker's anomaly, as the Java consumer refuses it, never read as no marker",
    async (_, key) => {
      const error = await fetched(
        answer([
          batch({ records: [rec(0)] }),
          batch({ firstOffset: big(1), attributes: 0x30, producerId: big(7), records: [rec(0, key)] }),
        ]),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(KafkaError);
      expect(error.category).toBe("protocol");
      expect(error.message).toContain("offset 1");
    },
  );

  test("a LogAppendTime batch stamps every record with the broker's time", async () => {
    const result = await fetched(
      answer([
        batch({
          attributes: 0x08,
          firstTimestamp: big(1000),
          maxTimestamp: big(5000),
          lastOffsetDelta: 1,
          records: [rec(0, null, 3), rec(1, null, 9)],
        }),
      ]),
    );
    expect(result.records.map((r) => r.timestamp)).toEqual([big(5000), big(5000)]);
  });

  test("a CreateTime batch gives each record its own time, the batch's first plus the record's delta", async () => {
    const result = await fetched(
      answer([batch({ maxTimestamp: big(1009), lastOffsetDelta: 1, records: [rec(0, null, 3), rec(1, null, 9)] })]),
    );
    expect(result.records.map((r) => r.timestamp)).toEqual([big(1003), big(1009)]);
  });

  test("the answer's entry is the fetched topic and partition, found by id and index, never by position", async () => {
    const entry = (partitionIndex: number, firstOffset: number) => ({
      partitionIndex,
      abortedTransactions: null,
      records: [batch({ firstOffset: big(firstOffset), records: [rec(0)] })],
    });
    const result = await fetched({
      responses: [
        { topicId: ALL.topics.get("txn")!.id, partitions: [entry(1, 90)] },
        { topicId: ORDERS_ID, partitions: [entry(0, 70), entry(1, 7)] },
      ],
    });
    expect(result.records.map((r) => [r.partition, r.offset])).toEqual([[1, big(7)]]);
  });

  test("an answer that does not hold the partition has no records, and the read stays where it was", async () => {
    expect(await fetched({ responses: [] }, 5)).toEqual({ records: [], nextOffset: big(5) });
    expect(await fetched({ responses: [{ topicId: ORDERS_ID, partitions: [] }] }, 5)).toEqual({
      records: [],
      nextOffset: big(5),
    });
    expect(
      await fetched({ responses: [{ topicId: ORDERS_ID, partitions: [{ partitionIndex: 1, records: null }] }] }, 5),
    ).toEqual({ records: [], nextOffset: big(5) });
  });

  test("the captured transactional topic answers its committed records only (fetch-txn)", async () => {
    const result = await fetched(kafkaFixture("fetch-txn"), 0, "txn", 0);
    expect(result.records.map((r) => JSON.parse(Buffer.from(r.value!).toString()).txn)).toEqual([
      "committed",
      "committed",
    ]);
    // The ABORT marker at offset 5 is the last batch the broker returned.
    expect(result.nextOffset).toBe(big(6));
  });

  test("the captured LogAppendTime topic stamps each record with its batch's maxTimestamp (fetch-ts-append)", async () => {
    const response = kafkaFixture<{
      responses: Array<{ partitions: Array<{ records: Array<{ maxTimestamp: bigint; records: unknown[] }> }> }>;
    }>("fetch-ts-append");
    const expected = response.responses[0].partitions[0].records.flatMap((b) => b.records.map(() => b.maxTimestamp));
    expect(expected.length).toBeGreaterThan(0);
    expect((await fetched(response, 0, "ts-append", 0)).records.map((r) => r.timestamp)).toEqual(expected);
  });

  test("the captured bytes keep a producer id on a batch that is not transactional (fetch-bytes)", async () => {
    const result = await fetched(kafkaFixture("fetch-bytes"), 0, "bytes", 0);
    expect(result.records.map((r) => r.offset)).toEqual([big(0), big(1)]);
    expect(Buffer.from(result.records[1].value!).toString("hex")).toBe("fffe0001");
  });
});

describe("translateError", () => {
  const bootstrap = { host: "localhost", port: 9092 };
  /** Every error in a captured chain, the way the adapter walks it. */
  const chainOf = (error: unknown): Array<Record<string, unknown>> => {
    const e = error as Record<string, unknown>;
    return [
      e,
      ...((e.errors as unknown[] | undefined) ?? []).flatMap(chainOf),
      ...(e.cause === undefined ? [] : chainOf(e.cause)),
    ];
  };
  /**
   * A listing whose broker could not be reached, as the client reports it: measured for a name
   * that does not resolve under Bun and Node, and the shape error-refused and error-tls-ca hold.
   */
  const unreachable = (host: string, port: number, nodeCode: string) =>
    libError({ code: "PLT_KFK_MULTIPLE", message: "Listing topics failed." }, [
      libError({ code: "PLT_KFK_MULTIPLE", message: "Cannot connect to any broker." }, [
        connectionFailure(host, port, nodeCode),
      ]),
    ]);

  test("Unknown topic (PLT_KFK_USER) is unknown-topic (M-B), nested under MultipleErrors or not", () => {
    expect(
      translateError(libError({ code: "PLT_KFK_USER", message: "Unknown topic probe-typo." }), bootstrap).category,
    ).toBe("unknown-topic");
    const nested = libError({ code: "PLT_KFK_MULTIPLE" }, [
      libError({ code: "PLT_KFK_USER", message: "Unknown topic x." }),
    ]);
    expect(translateError(nested, bootstrap).category).toBe("unknown-topic");
    expect(translateError(kafkaFixture("error-unknown-topic"), bootstrap).category).toBe("unknown-topic");
    expect(translateError(kafkaFixture("redpanda-error-unknown-topic"), bootstrap).category).toBe("unknown-topic");
  });

  test("OFFSET_OUT_OF_RANGE nested in a ResponseError (M-G)", () => {
    const error = libError({ code: "PLT_KFK_RESPONSE" }, [
      libError({ code: "PLT_KFK_PROTOCOL", apiId: "OFFSET_OUT_OF_RANGE" }),
    ]);
    expect(translateError(error, bootstrap).category).toBe("offset-out-of-range");
    expect(translateError(kafkaFixture("error-offset-out-of-range"), bootstrap)).toMatchObject({
      category: "offset-out-of-range",
      detail: { apiId: "OFFSET_OUT_OF_RANGE" },
    });
  });

  test("a leaderless partition is unreadable-topic", () => {
    expect(translateError(leaderless(), bootstrap)).toMatchObject({
      category: "unreadable-topic",
      detail: { apiId: "LEADER_NOT_AVAILABLE" },
    });
    // LISTENER_NOT_FOUND is the other form a partition with no leader takes (spec 4.1, 5.6).
    expect(translateError(leaderless(RAW_OFFLINE, ["LISTENER_NOT_FOUND"]), bootstrap)).toMatchObject({
      category: "unreadable-topic",
      detail: { apiId: "LISTENER_NOT_FOUND" },
    });
  });

  test("a leaderless partition beside another protocol error is that other error, never unreadable-topic", () => {
    const mixed = libError({ code: "PLT_KFK_RESPONSE" }, [
      libError({ code: "PLT_KFK_PROTOCOL", apiId: "LEADER_NOT_AVAILABLE", path: "/topics/0/partitions/0" }),
      libError({ code: "PLT_KFK_PROTOCOL", apiId: "TOPIC_AUTHORIZATION_FAILED", path: "/topics/1" }),
    ]);
    expect(translateError(mixed, bootstrap)).toMatchObject({
      category: "authorization",
      detail: { resource: "topic" },
    });
  });

  test("an *_AUTHORIZATION_FAILED is authorization naming the resource (captured on kafka-auth, M-I)", () => {
    expect(translateError(kafkaFixture("error-topic-authorization"), bootstrap)).toMatchObject({
      category: "authorization",
      detail: { resource: "topic" },
    });
    expect(translateError(kafkaFixture("error-cluster-authorization"), bootstrap)).toMatchObject({
      category: "authorization",
      detail: { resource: "cluster" },
    });
  });

  test("a SASL failure is authentication (captured, error-sasl)", () => {
    expect(translateError(kafkaFixture("error-sasl"), bootstrap).category).toBe("authentication");
    const bare = libError({ code: "PLT_KFK_RESPONSE" }, [
      libError({ code: "PLT_KFK_PROTOCOL", apiId: "SASL_AUTHENTICATION_FAILED" }),
    ]);
    expect(translateError(bare, bootstrap).category).toBe("authentication");
    // A broker that does not offer the mechanism fails the SASL handshake, which the client wraps in
    // its own AuthenticationError with no SASL_AUTHENTICATION_FAILED in the chain (dist/network/connection.js).
    const unoffered = libError({ code: "PLT_KFK_MULTIPLE", message: "Cannot connect to any broker." }, [
      libError({
        code: "PLT_KFK_NETWORK",
        message: "Connection to localhost:9092 failed.",
        cause: libError({
          code: "PLT_KFK_AUTHENTICATION",
          message: "Cannot find a suitable SASL mechanism.",
          cause: libError({ code: "PLT_KFK_RESPONSE" }, [
            libError({ code: "PLT_KFK_PROTOCOL", apiId: "UNSUPPORTED_SASL_MECHANISM" }),
          ]),
        }),
      }),
    ]);
    expect(translateError(unoffered, bootstrap).category).toBe("authentication");
  });

  test("a TLS failure keeps the Node code (captured, error-tls-ca; and a self-signed server's code)", () => {
    expect(translateError(kafkaFixture("error-tls-ca"), bootstrap)).toMatchObject({
      category: "tls",
      detail: { nodeCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    });
    const selfSigned = libError({
      code: "PLT_KFK_NETWORK",
      cause: Object.assign(new Error("self-signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    });
    expect(translateError(selfSigned, bootstrap).detail.nodeCode).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  // Each code as the client reported it through local TLS servers under Bun 1.4.2 and Node 24.14.0,
  // and UNABLE_TO_VERIFY_LEAF_SIGNATURE as error-tls-ca holds it: the Node error is the cause of the
  // connection's NetworkError. One code for each form the TLS rule reads, and Node's own for a
  // plaintext listener, where Bun names another.
  test.each([
    ["ERR_TLS_CERT_ALTNAME_INVALID", "a certificate for another name"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "TLS to a listener that answers in plaintext, under Bun"],
    ["ERR_SSL_PACKET_LENGTH_TOO_LONG", "TLS to a listener that answers in plaintext, under Node"],
    ["CERT_HAS_EXPIRED", "an expired certificate"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "a self-signed certificate"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "a chain that ends in an untrusted self-signed root"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "a certificate from an untrusted CA"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "a certificate and its intermediate, under an untrusted root"],
    [
      "INVALID_PURPOSE",
      "a server certificate whose extended key usage is client authentication only, under Bun and Node",
    ],
  ])("%s (%s) is tls carrying that code (K7)", (nodeCode) => {
    const error = translateError(unreachable("localhost", 9092, nodeCode), bootstrap);
    expect([error.category, error.detail]).toEqual(["tls", { nodeCode }]);
  });

  // Every name Node gives a certificate its TLS layer refused: OpenSSL's X509_V_ERR_ names, and
  // UNSPECIFIED for any other (X509ErrorCode in Node's src/crypto/crypto_common.cc; each is in the
  // node 24.14.0 binary). At an address the broker advertised, a refused certificate is still tls,
  // never a broker this server cannot reach.
  test.each([
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_CRL",
    "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
    "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
    "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
    "CERT_SIGNATURE_FAILURE",
    "CRL_SIGNATURE_FAILURE",
    "CERT_NOT_YET_VALID",
    "CERT_HAS_EXPIRED",
    "CRL_NOT_YET_VALID",
    "CRL_HAS_EXPIRED",
    "ERROR_IN_CERT_NOT_BEFORE_FIELD",
    "ERROR_IN_CERT_NOT_AFTER_FIELD",
    "ERROR_IN_CRL_LAST_UPDATE_FIELD",
    "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
    "OUT_OF_MEM",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_CHAIN_TOO_LONG",
    "CERT_REVOKED",
    "INVALID_CA",
    "PATH_LENGTH_EXCEEDED",
    "INVALID_PURPOSE",
    "CERT_UNTRUSTED",
    "CERT_REJECTED",
    "HOSTNAME_MISMATCH",
    "UNSPECIFIED",
  ])("a certificate Node refused as %s is tls, at the bootstrap and at an advertised broker (K7)", (nodeCode) => {
    for (const host of ["localhost", "broker-2.internal"]) {
      const error = translateError(unreachable(host, 9092, nodeCode), bootstrap);
      expect([error.category, error.detail]).toEqual(["tls", { nodeCode }]);
    }
  });

  test("a refused connection is network at the address the client named, and advertised-unreachable at any other (captured, error-refused)", () => {
    // Measured M-J: the client names "localhost" while Node's error names the resolved address,
    // so the target is read from the client's own "Connection to <host>:<port> failed." text.
    const refused = kafkaFixture("error-refused");
    const named = chainOf(refused)
      .map((e) => /^Connection to (.+):(\d+) failed\.$/.exec(String(e.message)))
      .find((match) => match !== null);
    expect(named?.[1]).toBe("localhost");
    expect(chainOf(refused).some((e) => typeof e.address === "string" && e.address !== "localhost")).toBe(true);
    const target = { host: String(named?.[1]), port: Number(named?.[2]) };
    expect(translateError(refused, target)).toMatchObject({
      category: "network",
      detail: { nodeCode: "ECONNREFUSED" },
    });
    expect(translateError(refused, { host: "127.0.0.2", port: 1 })).toMatchObject({
      category: "advertised-unreachable",
      detail: target,
    });
  });

  // A connection failure is known by the client's own "Connection to <host>:<port> failed." text,
  // whatever Node code its cause carries. ECONNREFUSED as error-refused holds it, ENOTFOUND as the
  // client reported a name that does not resolve under Bun and Node, ENETUNREACH as it reported an
  // address with no route under Node, and EINVAL as it reported a zone-less link-local IPv6
  // bootstrap (fe80::1) under Bun (measured 2026-09-25); the rest are other connection failures
  // Node names, a local firewall's EPERM among them, in the same shape.
  test.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "ECONNRESET",
    "EAI_AGAIN",
    "EINVAL",
    "EPERM",
    "EACCES",
    "EADDRNOTAVAIL",
    "ENETDOWN",
    "EHOSTDOWN",
  ])(
    "a connection that fails with %s is network at the bootstrap, and advertised-unreachable at an address the broker advertised (spec 5.6)",
    (nodeCode) => {
      const atBootstrap = translateError(unreachable("localhost", 9092, nodeCode), bootstrap);
      expect([atBootstrap.category, atBootstrap.detail]).toEqual(["network", { nodeCode }]);
      // A name the broker advertises that this server cannot reach: the Docker and NAT case.
      const advertised = translateError(unreachable("broker-2.internal", 9092, nodeCode), bootstrap);
      expect([advertised.category, advertised.detail]).toEqual([
        "advertised-unreachable",
        { host: "broker-2.internal", port: 9092, nodeCode },
      ]);
    },
  );

  test("a connection whose cause is the client's own error, not a Node one, is read as that cause reads", () => {
    // The client wraps a SASL step's own failure in the connection's "failed." text as well
    // (dist/network/connection.js, #onSaslAuthenticate): its codes are the client's, never a Node code.
    const during = (cause: unknown) =>
      libError({ code: "PLT_KFK_MULTIPLE", message: "Cannot connect to any broker." }, [
        libError({ code: "PLT_KFK_NETWORK", message: "Connection to localhost:9092 failed.", cause }),
      ]);
    const unanswered = translateError(
      during(libError({ code: "PLT_KFK_NETWORK", class: "TimeoutError", message: "Request timed out" })),
      bootstrap,
    );
    expect([unanswered.category, unanswered.detail]).toEqual(["timeout", {}]);
    const closed = translateError(
      during(libError({ code: "PLT_KFK_NETWORK", message: "Connection closed" })),
      bootstrap,
    );
    expect([closed.category, closed.detail]).toEqual(["network", { nodeCode: "connection-lost" }]);
  });

  test("a Node code outside the client's connection text is no connection failure: a batch that would not decompress is protocol", () => {
    // The library decompresses inside its response parser, so a corrupt gzip batch fails a fetch
    // with zlib's own error: bare, as the adapter's own fetch receives it, and inside the retry
    // report of a call the client retries.
    const corrupt = () => Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR", errno: -3 });
    const bare = translateError(corrupt(), bootstrap);
    expect([bare.category, bare.detail]).toEqual(["protocol", {}]);
    expect(bare.message).toContain("Z_DATA_ERROR");
    const retried = translateError(
      libError({ code: "PLT_KFK_MULTIPLE", message: "fetch failed 2 times." }, [corrupt(), corrupt()]),
      bootstrap,
    );
    expect([retried.category, retried.detail]).toEqual(["protocol", {}]);
    expect(retried.message).toContain("PLT_KFK_MULTIPLE");
  });

  test("an address on the bootstrap's host at another port is one the broker advertised (the kafka-cluster shape)", () => {
    // kafka-cluster bootstraps on localhost:9192, and its other brokers advertise localhost:9193 and localhost:9194.
    const clusterBootstrap = { host: "localhost", port: 9192 };
    const otherPort = translateError(unreachable("localhost", 9193, "ECONNREFUSED"), clusterBootstrap);
    expect([otherPort.category, otherPort.detail]).toEqual([
      "advertised-unreachable",
      { host: "localhost", port: 9193, nodeCode: "ECONNREFUSED" },
    ]);
    // The control: the bootstrap's own address is network.
    expect(translateError(unreachable("localhost", 9192, "ECONNREFUSED"), clusterBootstrap).category).toBe("network");
  });

  test("a connect that failed on every broker it tried names the first, the bootstrap, with that broker's own code", () => {
    // The client tries the bootstrap first and then the brokers its metadata names
    // (dist/clients/base/base.js, kGetBootstrapConnection), and each failure carries its own address and cause.
    const everyBroker = libError({ code: "PLT_KFK_MULTIPLE", message: "Cannot connect to any broker." }, [
      connectionFailure("localhost", 9092, "ECONNREFUSED"),
      connectionFailure("broker-2.internal", 9093, "ENOTFOUND"),
    ]);
    const error = translateError(everyBroker, bootstrap);
    expect([error.category, error.detail]).toEqual(["network", { nodeCode: "ECONNREFUSED" }]);
  });

  test("measured protocol mismatches are tls, not network (captured, M-J)", () => {
    const requiresTls = translateError(kafkaFixture("error-requires-tls"), bootstrap);
    expect(requiresTls.category).toBe("tls");
    expect(requiresTls.message).toContain("requires TLS");
    expect(translateError(kafkaFixture("error-tls-handshake"), bootstrap)).toMatchObject({
      category: "tls",
      detail: { nodeCode: "ECONNRESET" },
    });
  });

  test("a connect timeout is network at the bootstrap, and advertised-unreachable elsewhere (captured chain)", () => {
    const timedOut = kafkaFixture("error-connect-timeout");
    expect(translateError(timedOut, { host: "10.255.255.1", port: 9092 })).toMatchObject({
      category: "network",
      detail: { nodeCode: "connect-timeout" },
    });
    expect(translateError(timedOut, bootstrap)).toMatchObject({
      category: "advertised-unreachable",
      detail: { host: "10.255.255.1", port: 9092 },
    });
  });

  test("a connection that never became ready names no address, and is a connect timeout at the bootstrap (spec 5.6)", () => {
    // The client's ready() says "Connection ready timed out after <ms>ms." when the connection has no
    // address yet (dist/network/connection.js); it is a connect that was not answered in time, not a
    // connection the peer closed.
    const readyTimeout = libError({ code: "PLT_KFK_MULTIPLE", message: "Cannot connect to any broker." }, [
      libError({ code: "PLT_KFK_NETWORK", class: "TimeoutError", message: "Connection ready timed out after 5000ms." }),
    ]);
    const error = translateError(readyTimeout, bootstrap);
    expect([error.category, error.detail]).toEqual(["network", { nodeCode: "connect-timeout" }]);
    // The control: a connection that closed while the client waited for it is still a lost one.
    const closedWhileWaiting = libError({
      code: "PLT_KFK_NETWORK",
      message: "Connection closed while waiting for ready.",
    });
    expect(translateError(closedWhileWaiting, bootstrap).detail).toEqual({ nodeCode: "connection-lost" });
  });

  test("a request timeout is timeout, and a closed connection is network (captured chains)", () => {
    expect(translateError(kafkaFixture("error-request-timeout"), bootstrap).category).toBe("timeout");
    expect(translateError(kafkaFixture("error-connection-closed"), bootstrap)).toMatchObject({
      category: "network",
      detail: { nodeCode: "connection-lost" },
    });
    // Redpanda closes the connection on an API it does not offer, such as ConsumerGroupDescribe.
    expect(translateError(kafkaFixture("redpanda-consumer-group-describe"), bootstrap).category).toBe("network");
  });

  test("pin: the library's TimeoutError carries PLT_KFK_NETWORK and no Node code, which is why the text is read", () => {
    const timeouts = chainOf(kafkaFixture("error-request-timeout")).filter((e) => e.class === "TimeoutError");
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((e) => e.code === "PLT_KFK_NETWORK")).toBe(true);
  });

  test("the broker's own REQUEST_TIMED_OUT is timeout; a moved leader asks for a re-run", () => {
    const brokerTimeout = libError({ code: "PLT_KFK_RESPONSE" }, [
      libError({ code: "PLT_KFK_PROTOCOL", apiId: "REQUEST_TIMED_OUT" }),
    ]);
    expect(translateError(brokerTimeout, bootstrap).category).toBe("timeout");
    expect(translateError(notLeader(), bootstrap).message).toContain("run it again");
  });

  test("anything else is protocol, named by its protocol error or code, never by the library's text", () => {
    const other = translateError(
      libError({ code: "PLT_KFK_UNSUPPORTED_API", message: "Unsupported API at broker-1:9092" }),
      bootstrap,
    );
    expect(other.category).toBe("protocol");
    expect(other.message).toContain("PLT_KFK_UNSUPPORTED_API");
    expect(other.message).not.toContain("broker-1");
    expect(other.detail).toEqual({});
    const policy = translateError(
      libError({ code: "PLT_KFK_RESPONSE" }, [libError({ code: "PLT_KFK_PROTOCOL", apiId: "POLICY_VIOLATION" })]),
      bootstrap,
    );
    expect(policy).toMatchObject({ category: "protocol", detail: { apiId: "POLICY_VIOLATION" } });
    expect(translateError({}, bootstrap).message).toContain("unknown error");
  });

  test("a KafkaError passes through unchanged", () => {
    const own = new KafkaError("invalid-request", "x");
    expect(translateError(own, bootstrap)).toBe(own);
  });
});

/**
 * The adapter over the installed client, against a broker this test runs on a local port.
 * Kafka's cleaner leaves a transactional topic holding answers the client's own READ_COMMITTED
 * filter throws on inside its socket handler, which left that fetch unsettled under Bun and in
 * the standalone server, and ended a Node process with no uncaughtException handler (measured on
 * Kafka 4.3.1 after log cleaning, 2026-09-25). The adapter sends its own sessionless Fetch v13,
 * which the client parses inside its try and settles either way (spec 3.6 K8). The framing is
 * written by hand, because no test may import the client (the seam guard, plan Task 12).
 */
describe("the installed client against a local broker (spec 3.6 K8)", () => {
  const int8 = (n: number) => Buffer.from([n & 0xff]);
  const int16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return b;
  };
  const int32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  const int64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(n));
    return b;
  };
  const uvarint = (n: number) => {
    const out: number[] = [];
    let rest = n;
    while (rest > 0x7f) {
      out.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    out.push(rest);
    return Buffer.from(out);
  };
  /** Zigzag, as a record's fields are written. */
  const varint = (n: number) => uvarint((n << 1) ^ (n >> 31));
  const TAGS = uvarint(0);
  const compactString = (s: string | null) =>
    s === null ? uvarint(0) : Buffer.concat([uvarint(Buffer.byteLength(s) + 1), Buffer.from(s)]);
  const compactArray = <T>(items: readonly T[], each: (item: T) => Buffer) =>
    Buffer.concat([uvarint(items.length + 1), ...items.map(each)]);
  const TOPIC_ID = "3b0c8c2e-5a4f-4a8e-9d1e-2f6a7b8c9d02";
  const TRANSACTIONAL = 0x10;
  const CONTROL = 0x30;
  const GZIP = 0x01;
  const ABORT_KEY = Buffer.from([0, 0, 0, 0]);

  /** One record of a magic 2 batch: no timestamp delta and no headers. */
  const record = (offsetDelta: number, key: Buffer | null, value: Buffer | null) => {
    const bytes = (b: Buffer | null) => (b === null ? varint(-1) : Buffer.concat([varint(b.length), b]));
    const body = Buffer.concat([int8(0), varint(0), varint(offsetDelta), bytes(key), bytes(value), varint(0)]);
    return Buffer.concat([varint(body.length), body]);
  };
  /** A magic 2 record batch; the client checks no CRC, so it is written as 0. */
  const recordBatch = (b: {
    baseOffset: number;
    attributes?: number;
    producerId?: number;
    records?: Buffer[];
    compressed?: Buffer;
  }) => {
    const records = b.records ?? [];
    const count = b.compressed === undefined ? records.length : 1;
    const afterLength = Buffer.concat([
      int32(0),
      int8(2),
      int32(0),
      int16(b.attributes ?? 0),
      int32(Math.max(count - 1, 0)),
      int64(1000),
      int64(1000),
      int64(b.producerId ?? -1),
      int16(0),
      int32(0),
      int32(count),
      b.compressed ?? Buffer.concat(records),
    ]);
    return Buffer.concat([int64(b.baseOffset), int32(afterLength.length), afterLength]);
  };
  const apiVersionsBody = () =>
    Buffer.concat([
      int16(0),
      compactArray(
        [
          [18, 0, 3],
          [3, 12, 12],
          [1, 4, 17],
        ],
        ([key, min, max]) => Buffer.concat([int16(key), int16(min), int16(max), TAGS]),
      ),
      int32(0),
      TAGS,
    ]);
  /** Metadata v12: this listener is broker 1 and leads orders' one partition. */
  const metadataBody = (port: number) =>
    Buffer.concat([
      int32(0),
      compactArray([port], (p) =>
        Buffer.concat([int32(1), compactString("127.0.0.1"), int32(p), compactString(null), TAGS]),
      ),
      compactString("local-broker"),
      int32(1),
      compactArray(["orders"], (name) =>
        Buffer.concat([
          int16(0),
          compactString(name),
          Buffer.from(TOPIC_ID.replaceAll("-", ""), "hex"),
          int8(0),
          compactArray([0], (index) =>
            Buffer.concat([
              int16(0),
              int32(index),
              int32(1),
              int32(0),
              compactArray([1], int32),
              compactArray([1], int32),
              compactArray([], int32),
              TAGS,
            ]),
          ),
          int32(-2147483648),
          TAGS,
        ]),
      ),
      TAGS,
    ]);
  /** A Fetch answer for orders partition 0, the same bytes for v13 to v17, which differ only in optional tagged fields. */
  const fetchBody = (batches: Buffer[], aborted: Array<[number, number]>, end: number) => {
    const records = Buffer.concat(batches);
    return Buffer.concat([
      int32(0),
      int16(0),
      int32(0),
      compactArray([0], () =>
        Buffer.concat([
          Buffer.from(TOPIC_ID.replaceAll("-", ""), "hex"),
          compactArray([0], (index) =>
            Buffer.concat([
              int32(index),
              int16(0),
              int64(end),
              int64(end),
              int64(0),
              compactArray(aborted, ([producerId, firstOffset]) =>
                Buffer.concat([int64(producerId), int64(firstOffset), TAGS]),
              ),
              int32(-1),
              uvarint(records.length + 1),
              records,
              TAGS,
            ]),
          ),
          TAGS,
        ]),
      ),
      TAGS,
    ]);
  };

  /** A listener that answers ApiVersions, Metadata and each Fetch with `answer`, recording what each Fetch asked for. */
  async function localBroker(answer: Buffer) {
    const fetches: Array<{ version: number; isolationLevel: number; sessionId: number; sessionEpoch: number }> = [];
    const sockets = new Set<Socket>();
    let port = 0;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4 && buffered.length >= 4 + buffered.readInt32BE(0)) {
          const frame = buffered.subarray(4, 4 + buffered.readInt32BE(0));
          buffered = buffered.subarray(4 + frame.length);
          const [apiKey, version, correlationId] = [frame.readInt16BE(0), frame.readInt16BE(2), frame.readInt32BE(4)];
          // The request header: the client id as a length and its bytes, then the header's tags.
          const body = frame.subarray(8 + 2 + frame.readInt16BE(8) + 1);
          let reply: Buffer;
          if (apiKey === 18) reply = Buffer.concat([int32(correlationId), apiVersionsBody()]);
          else if (apiKey === 3) reply = Buffer.concat([int32(correlationId), TAGS, metadataBody(port)]);
          else if (apiKey === 1) {
            // Version 15 moved the replica id out of the body.
            const at = version >= 15 ? 0 : 4;
            fetches.push({
              version,
              isolationLevel: body.readInt8(at + 12),
              sessionId: body.readInt32BE(at + 13),
              sessionEpoch: body.readInt32BE(at + 17),
            });
            reply = Buffer.concat([int32(correlationId), TAGS, answer]);
          } else {
            socket.destroy();
            return;
          }
          socket.write(Buffer.concat([int32(reply.length), reply]));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    const client = createPlatformaticClient(
      { clientId: "libredb-studio", broker: { host: "127.0.0.1", port }, timeoutMs: 2000 },
      await loadPlatformatic(),
    );
    return {
      client,
      fetches,
      close: async () => {
        await client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** Reads orders partition 0 from `from` through the adapter, under a signal that stops it well before bun's test timeout. */
  async function readThrough(answer: Buffer, from: number) {
    const broker = await localBroker(answer);
    try {
      const [orders] = (await broker.client.metadata(["orders"])).topics;
      const result = await broker.client
        .fetch(orders, 0, big(from), AbortSignal.timeout(2500))
        .catch((error: unknown) => error as KafkaError);
      return { result, fetches: broker.fetches };
    } finally {
      await broker.close();
    }
  }

  test("an empty control batch beside a listed aborted transaction, the shape Kafka's cleaner leaves, reads its committed records", async () => {
    // The batches of a cleaned Kafka 4.3.1 log measured on 2026-09-25: the empty control batch the
    // cleaner kept of producer 4's last marker, producer 5's aborted batch and its ABORT marker, then plain records.
    const { result, fetches } = await readThrough(
      fetchBody(
        [
          recordBatch({ baseOffset: 11, attributes: CONTROL, producerId: 4 }),
          recordBatch({
            baseOffset: 12,
            attributes: TRANSACTIONAL,
            producerId: 5,
            records: [record(0, Buffer.from("qa"), Buffer.from("aborted"))],
          }),
          recordBatch({ baseOffset: 13, attributes: CONTROL, producerId: 5, records: [record(0, ABORT_KEY, null)] }),
          recordBatch({
            baseOffset: 14,
            records: [0, 1, 2].map((i) => record(i, Buffer.from(`k${i}`), Buffer.from("plain"))),
          }),
        ],
        [[5, 12]],
        17,
      ),
      11,
    );
    // A failure is thrown whole, so its category and message show.
    if (result instanceof Error) throw result;
    expect(result.records.map((r) => [r.offset, Buffer.from(r.key!).toString()])).toEqual([
      [big(14), "k0"],
      [big(15), "k1"],
      [big(16), "k2"],
    ]);
    expect(result.nextOffset).toBe(big(17));
    // On the wire: the adapter's own Fetch, version 13, READ_COMMITTED, with no fetch session.
    expect(fetches).toEqual([{ version: 13, isolationLevel: 1, sessionId: 0, sessionEpoch: -1 }]);
  });

  test("an ABORT marker of a producer the answer does not list, beside a listed aborted transaction, reads through", async () => {
    const { result } = await readThrough(
      fetchBody(
        [
          recordBatch({ baseOffset: 0, attributes: CONTROL, producerId: 7, records: [record(0, ABORT_KEY, null)] }),
          recordBatch({
            baseOffset: 1,
            attributes: TRANSACTIONAL,
            producerId: 8,
            records: [record(0, Buffer.from("x"), Buffer.from("aborted"))],
          }),
          recordBatch({ baseOffset: 2, attributes: CONTROL, producerId: 8, records: [record(0, ABORT_KEY, null)] }),
          recordBatch({ baseOffset: 3, records: [record(0, Buffer.from("kept"), Buffer.from("plain"))] }),
        ],
        [[8, 1]],
        4,
      ),
      0,
    );
    if (result instanceof Error) throw result;
    expect(result.records.map((r) => r.offset)).toEqual([big(3)]);
    expect(result.nextOffset).toBe(big(4));
  });

  test("a batch that will not decompress is protocol, named by zlib's code, and the read settles", async () => {
    const { result } = await readThrough(
      fetchBody([recordBatch({ baseOffset: 0, attributes: GZIP, compressed: Buffer.from("not gzip at all") })], [], 1),
      0,
    );
    expect(result).toBeInstanceOf(KafkaError);
    const error = result as KafkaError;
    expect([error.category, error.detail]).toEqual(["protocol", {}]);
    expect(error.message).toContain("Z_DATA_ERROR");
  });
});
