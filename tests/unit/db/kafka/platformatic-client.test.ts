import { describe, expect, test } from "bun:test";
import { KafkaError, type KafkaTopicMetadata } from "@/lib/db/providers/stream/kafka/client";
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
const leaderless = (response: unknown = RAW_OFFLINE) =>
  libError({ code: "PLT_KFK_MULTIPLE", message: "metadata failed 2 times." }, [
    libError(
      { code: "PLT_KFK_RESPONSE", message: "Received response with error while executing API Metadata(v12)", response },
      [libError({ code: "PLT_KFK_PROTOCOL", apiId: "LEADER_NOT_AVAILABLE", path: "/topics/1/partitions/0" })],
    ),
  ]);
const notLeader = () =>
  libError({ code: "PLT_KFK_RESPONSE" }, [libError({ code: "PLT_KFK_PROTOCOL", apiId: "NOT_LEADER_OR_FOLLOWER" })]);

/** A metadata answer for orders whose partition 1 has the given leader. */
const ordersWithLeader = (leader: number) => {
  const md = kafkaFixture<{ topics: Map<string, { partitions: Array<{ leader: number }> }> }>("metadata-orders");
  md.topics.get("orders")!.partitions[1].leader = leader;
  return md;
};

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
  test("mutes the protocol logger, which prints request frames under DEBUG, and hands over the four members (K3)", async () => {
    const protocol = { enabled: true };
    const library = {
      loggers: { protocol, client: { enabled: true } },
      Admin: class {},
      Consumer: class {},
      Connection: class {},
      consumerGroupDescribeV0: { api: { async: async () => undefined } },
      Producer: class {},
    };
    const lib = await loadPlatformatic(async () => library as never);
    expect(protocol.enabled).toBe(false);
    // The client logger is not the provider's to silence.
    expect(library.loggers.client.enabled).toBe(true);
    expect(Object.keys(lib).sort()).toEqual(["Admin", "Connection", "Consumer", "consumerGroupDescribeV0"]);
    expect(lib.Admin).toBe(library.Admin as never);
    expect(lib.Consumer).toBe(library.Consumer as never);
    expect(lib.Connection).toBe(library.Connection as never);
    expect(lib.consumerGroupDescribeV0).toBe(library.consumerGroupDescribeV0 as never);
  });

  test("refuses a library that no longer exports its protocol logger, rather than run with it unmuted", async () => {
    await expect(loadPlatformatic(async () => ({ loggers: {} }) as never)).rejects.toThrow("loggers.protocol");
  });

  test("loads the installed library by default", async () => {
    const lib = await loadPlatformatic();
    expect([typeof lib.Admin, typeof lib.Consumer, typeof lib.Connection]).toEqual([
      "function",
      "function",
      "function",
    ]);
    expect(typeof lib.consumerGroupDescribeV0.api.async).toBe("function");
  });
});

describe("createPlatformaticClient", () => {
  test("one Admin and one Consumer: autocreateTopics false on both; the Consumer gets the sentinel group, autocommit off and the classic protocol", () => {
    const { lib, constructed } = fakeLib();
    createPlatformaticClient(OPTIONS, lib);
    expect(constructed.map(([n]) => n)).toEqual(["Admin", "Consumer"]);
    const admin = constructed.find(([n]) => n === "Admin")![1] as Record<string, unknown>;
    const consumer = constructed.find(([n]) => n === "Consumer")![1] as Record<string, unknown>;
    expect(admin.autocreateTopics).toBe(false);
    expect(consumer).toMatchObject({
      autocreateTopics: false,
      groupId: KAFKA_SENTINEL_GROUP_ID,
      autocommit: false,
      groupProtocol: "classic",
    });
    expect(admin).toMatchObject({
      clientId: "libredb-studio",
      bootstrapBrokers: [{ host: "localhost", port: 9092 }],
      retries: 1,
      connectTimeout: 5000,
      requestTimeout: 5000,
    });
  });

  test("a fetch session the broker asked to reset is retried at once; every other retry keeps the library's one-second delay", () => {
    // After a fetch answered with a partition error (OFFSET_OUT_OF_RANGE, NOT_LEADER_OR_FOLLOWER) the
    // broker has moved its session epoch and the library has not, so the next fetch to that broker
    // meets INVALID_FETCH_SESSION_EPOCH (measured on Kafka 4.3.1 and Redpanda v26.2.2).
    const { lib, constructed } = fakeLib();
    createPlatformaticClient(OPTIONS, lib);
    const protocolError = (apiId: string) =>
      libError({ code: "PLT_KFK_RESPONSE" }, [libError({ code: "PLT_KFK_PROTOCOL", apiId })]);
    for (const [, options] of constructed) {
      const delay = (options as { retryDelay: (...args: unknown[]) => number }).retryDelay;
      expect(delay({}, "fetch", 1, 1, protocolError("INVALID_FETCH_SESSION_EPOCH"))).toBe(0);
      expect(delay({}, "fetch", 1, 1, protocolError("FETCH_SESSION_ID_NOT_FOUND"))).toBe(0);
      expect(delay({}, "metadata", 1, 1, leaderless())).toBe(1000);
      expect(delay({}, "fetch", 1, 1, libError({ code: "PLT_KFK_NETWORK", message: "Connection closed" }))).toBe(1000);
    }
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

  test("a cluster that advertises a broker by IP gets both clients rebuilt without SNI, once", async () => {
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
      calls
        .map(([n]) => n)
        .filter((n) => n.endsWith(".close"))
        .sort(),
    ).toEqual(["admin.close", "consumer.close"]);
  });

  test("a cluster that advertises its brokers by name keeps SNI", async () => {
    const { lib, constructed } = fakeLib();
    const client = createPlatformaticClient(
      { ...OPTIONS, tls: { rejectUnauthorized: true }, tlsServerName: true },
      lib,
    );
    await client.metadata([]);
    expect(constructed.map(([n]) => n)).toEqual(["Admin", "Consumer"]);
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

  test("metadata with no names reads every listed topic", async () => {
    const { lib, calls } = fakeLib();
    await createPlatformaticClient(OPTIONS, lib).metadata();
    expect((argsOf(calls, "admin.metadata")[0] as { topics: string[] }).topics).toEqual(
      kafkaFixture<string[]>("list-topics"),
    );
  });

  test("an internal topic, which the library answers as undefined, is refused in words", async () => {
    const { lib } = fakeLib({
      "admin.metadata": () => ({
        id: "c",
        controllerId: 1,
        brokers: new Map(),
        topics: new Map([["__consumer_offsets", undefined]]),
      }),
    });
    const error = await createPlatformaticClient(OPTIONS, lib)
      .metadata(["__consumer_offsets"])
      .catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("unreadable-topic");
    expect(error.message).toContain("internal");
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

  test("a leaderless answer holds exactly the topics asked for, and refuses an internal one in words", async () => {
    const { lib } = fakeLib({
      "admin.metadata": () => {
        throw leaderless();
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const internal = await client.metadata(["orders", "__consumer_offsets"]).catch((e) => e);
    expect(internal).toBeInstanceOf(KafkaError);
    expect(internal.category).toBe("unreadable-topic");
    expect(internal.message).toContain("internal");
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

  test("listTopics reads names through a leaderless partition too, internal topics excluded", async () => {
    const { lib } = fakeLib({
      "admin.listTopics": () => {
        throw libError({ code: "PLT_KFK_MULTIPLE", message: "Listing topics failed." }, [leaderless()]);
      },
    });
    expect(await createPlatformaticClient(OPTIONS, lib).listTopics()).toEqual(["orders"]);
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

  test("any other metadata failure is not read through", async () => {
    const denied = libError({ code: "PLT_KFK_RESPONSE", response: RAW_OFFLINE }, [
      libError({ code: "PLT_KFK_PROTOCOL", apiId: "TOPIC_AUTHORIZATION_FAILED", path: "/topics/1" }),
    ]);
    const { lib } = fakeLib({
      "admin.metadata": () => {
        throw denied;
      },
      "admin.listTopics": () => {
        throw denied;
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    expect((await client.metadata(["orders"]).catch((e) => e)).category).toBe("authorization");
    expect((await client.listTopics().catch((e) => e)).category).toBe("authorization");
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

  test("offsets of an internal topic are refused before the library is asked, which would never settle", async () => {
    const { lib, calls } = fakeLib({
      "admin.metadata": () => ({
        id: "c",
        controllerId: 1,
        brokers: new Map(),
        topics: new Map([["__consumer_offsets", undefined]]),
      }),
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    for (const read of [
      () => client.offsets("__consumer_offsets", "latest"),
      () => client.offsetsForTimestamp("__consumer_offsets", big(5)),
    ]) {
      expect((await read().catch((e) => e)).category).toBe("unreadable-topic");
    }
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
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const md = await client.metadata(["orders"]);
    const result = await client.fetch(md.topics[0], 1, big(5), signal());
    expect(result.records.map((r) => r.offset)).toEqual([5, 6, 7, 8, 9, 10, 11].map(big));
    expect(result.records.every((r) => r.partition === 1)).toBe(true);
    expect(result.nextOffset).toBe(big(12));
    expect(argsOf(calls, "consumer.fetch")).toEqual([
      {
        node: 1,
        maxWaitTime: 250,
        maxBytes: 1024 * 1024,
        isolationLevel: 1,
        topics: [
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
      },
    ]);
  });

  test("a partition the topic's metadata does not hold is refused before any fetch", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const error = await client.fetch(orders, 7, big(0), signal()).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("invalid-request");
    expect(error.message).toContain("partition 7");
    expect(calls.some(([n]) => n === "consumer.fetch")).toBe(false);
  });

  test("fetch checks once that the broker names topics by id (Fetch 13), and refuses one that cannot", async () => {
    const { lib, calls } = fakeLib();
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    await client.fetch(orders, 1, big(5), signal());
    await client.fetch(orders, 1, big(5), signal());
    expect(calls.filter(([n]) => n === "admin.listApis").length).toBe(1);
    for (const apis of [[{ apiKey: 1, name: "Fetch", minVersion: 0, maxVersion: 12 }], []]) {
      const old = fakeLib({ "admin.listApis": () => apis });
      const oldClient = createPlatformaticClient(OPTIONS, old.lib);
      const error = await oldClient
        .fetch((await oldClient.metadata(["orders"])).topics[0], 1, big(5), signal())
        .catch((e) => e);
      expect(error.category).toBe("unsupported-broker");
      expect(error.message).toContain("Fetch 13");
      expect(old.calls.some(([n]) => n === "consumer.fetch")).toBe(false);
    }
  });

  test("a fetch sent to a leader that moved is sent once more, to the new leader", async () => {
    let fetches = 0;
    const { lib, calls } = fakeLib({
      "admin.metadata": (o) => ordersWithLeader((o as { forceUpdate?: boolean }).forceUpdate ? 2 : 1),
      "consumer.fetch": () => {
        fetches++;
        if (fetches === 1) throw notLeader();
        return kafkaFixture("fetch-orders-p1-o5");
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const result = await client.fetch((await client.metadata(["orders"])).topics[0], 1, big(5), signal());
    expect(result.records[0].offset).toBe(big(5));
    expect(argsOf(calls, "consumer.fetch").map((o) => (o as { node: number }).node)).toEqual([1, 2]);
    expect(argsOf(calls, "admin.metadata").at(-1)).toEqual({
      topics: ["orders"],
      autocreateTopics: false,
      forceUpdate: true,
    });
  });

  test("a leader the library's metadata no longer names is followed too", async () => {
    let fetches = 0;
    const { lib, calls } = fakeLib({
      "admin.metadata": (o) => ordersWithLeader((o as { forceUpdate?: boolean }).forceUpdate ? 2 : 1),
      "consumer.fetch": () => {
        fetches++;
        if (fetches === 1) throw libError({ code: "PLT_KFK_USER", message: "Cannot find broker with node id 1" });
        return kafkaFixture("fetch-orders-p1-o5");
      },
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    await client.fetch((await client.metadata(["orders"])).topics[0], 1, big(5), signal());
    expect(argsOf(calls, "consumer.fetch").map((o) => (o as { node: number }).node)).toEqual([1, 2]);
  });

  test("a stale leader that has not moved is said as such; any other fetch failure is not retried", async () => {
    const stuck = fakeLib({
      "consumer.fetch": () => {
        throw notLeader();
      },
    });
    const stuckClient = createPlatformaticClient(OPTIONS, stuck.lib);
    const stale = await stuckClient
      .fetch((await stuckClient.metadata(["orders"])).topics[0], 1, big(5), signal())
      .catch((e) => e);
    expect(stale.message).toContain("leadership moved");
    const range = fakeLib({
      "consumer.fetch": () => {
        throw libError({ code: "PLT_KFK_RESPONSE" }, [
          libError({ code: "PLT_KFK_PROTOCOL", apiId: "OFFSET_OUT_OF_RANGE" }),
        ]);
      },
    });
    const rangeClient = createPlatformaticClient(OPTIONS, range.lib);
    const error = await rangeClient
      .fetch((await rangeClient.metadata(["orders"])).topics[0], 1, big(5), signal())
      .catch((e) => e);
    expect(error.category).toBe("offset-out-of-range");
    expect(range.calls.filter(([n]) => n === "consumer.fetch").length).toBe(1);
  });

  test("two reads never have two fetches in flight: the library keeps one fetch session per broker (KIP-227)", async () => {
    const { held, state, fetch } = heldFetches();
    const { lib } = fakeLib({ "consumer.fetch": fetch });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const settled: string[] = [];
    const first = client.fetch(orders, 1, big(5), signal()).then(() => settled.push("first"));
    const second = client.fetch(orders, 1, big(5), signal()).then(() => settled.push("second"));
    await until(() => held.length > 0);
    await pause(20);
    expect(held.length).toBe(1);
    held.shift()!();
    await until(() => held.length > 0);
    held.shift()!();
    await Promise.all([first, second]);
    expect(state.most).toBe(1);
    expect(settled).toEqual(["first", "second"]);
  });

  test("a read its timeout stopped keeps its turn until its fetch settles, so the next fetch cannot collide with it", async () => {
    const { held, fetch } = heldFetches();
    const { lib, calls } = fakeLib({ "consumer.fetch": fetch });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const controller = new AbortController();
    const stopped = client.fetch(orders, 1, big(5), controller.signal).catch((e) => e);
    await until(() => held.length > 0);
    const next = client.fetch(orders, 1, big(5), signal());
    controller.abort();
    expect((await stopped).category).toBe("timeout");
    await pause(20);
    // The stopped read's fetch is still on the session, so the next one has not been sent.
    expect(calls.filter(([n]) => n === "consumer.fetch").length).toBe(1);
    held.shift()!();
    await until(() => held.length > 0);
    held.shift()!();
    expect((await next).records[0].offset).toBe(big(5));
  });

  test("a read stopped while it waits for its turn never sends its fetch, and the turn passes on", async () => {
    const { held, fetch } = heldFetches();
    const { lib, calls } = fakeLib({ "consumer.fetch": fetch });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const first = client.fetch(orders, 1, big(5), signal());
    await until(() => held.length > 0);
    const controller = new AbortController();
    const waiting = client.fetch(orders, 1, big(5), controller.signal).catch((e) => e);
    await pause(20);
    controller.abort();
    expect((await waiting).category).toBe("timeout");
    held.shift()!();
    await first;
    await pause(20);
    expect(calls.filter(([n]) => n === "consumer.fetch").length).toBe(1);
    // The control: a later read is sent, so the stopped one released its turn.
    const later = client.fetch(orders, 1, big(5), signal());
    await until(() => held.length > 0);
    held.shift()!();
    expect((await later).records[0].offset).toBe(big(5));
    expect(calls.filter(([n]) => n === "consumer.fetch").length).toBe(2);
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
    expect(calls.some(([n]) => n === "consumer.fetch" || n === "admin.listApis")).toBe(false);
  });

  test("a read stopped while its broker check was in flight is answered at once, not after another read's fetch", async () => {
    const { held, fetch } = heldFetches();
    const checks: Array<() => void> = [];
    const { lib } = fakeLib({
      "consumer.fetch": fetch,
      "admin.listApis": () =>
        new Promise((resolve) => {
          checks.push(() => resolve(kafkaFixture("api-versions")));
        }),
    });
    const client = createPlatformaticClient(OPTIONS, lib);
    const [orders] = (await client.metadata(["orders"])).topics;
    const first = client.fetch(orders, 1, big(5), signal());
    const controller = new AbortController();
    const settled: string[] = [];
    const stopped = client
      .fetch(orders, 1, big(5), controller.signal)
      .catch((e) => e)
      .then((e) => {
        settled.push("stopped");
        return e;
      });
    await until(() => checks.length === 2);
    checks.shift()!();
    await until(() => held.length > 0);
    controller.abort();
    checks.shift()!();
    await pause(20);
    // The first read's fetch is still held, and the stopped read has answered anyway.
    expect(held.length).toBe(1);
    expect(settled).toEqual(["stopped"]);
    expect((await stopped).category).toBe("timeout");
    held.shift()!();
    expect((await first).records[0].offset).toBe(big(5));
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

  test("an API 69 entry with an error code, or no entry, is unknown-object; no coordinator is said, never guessed", async () => {
    const listing = {
      groupId: "lag-classic",
      state: "Empty",
      groupType: "consumer" as const,
      protocolType: "consumer",
    };
    const { lib } = fakeLib({
      consumerGroupDescribeV0: () => ({
        groups: [
          {
            errorCode: 69,
            errorMessage: "not a consumer group",
            groupId: "lag-classic",
            groupState: "",
            assignorName: "",
            members: [],
          },
        ],
      }),
      "admin.findCoordinator": () => [{ key: "lag-classic", nodeId: 1, host: "localhost", port: 9092 }],
    });
    const coded = await createPlatformaticClient(OPTIONS, lib)
      .describeGroup(listing)
      .catch((e) => e);
    expect(coded.category).toBe("unknown-object");
    expect(coded.message).toContain("not a consumer group");
    const empty = fakeLib({
      consumerGroupDescribeV0: () => ({ groups: [] }),
      "admin.findCoordinator": () => [{ key: "lag-classic", nodeId: 1, host: "localhost", port: 9092 }],
    });
    const absent = await createPlatformaticClient(OPTIONS, empty.lib)
      .describeGroup(listing)
      .catch((e) => e);
    expect(absent.category).toBe("unknown-object");
    expect(absent.message).toContain("no entry");
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

  test("close closes both clients", async () => {
    const { lib, calls } = fakeLib();
    await createPlatformaticClient(OPTIONS, lib).close();
    expect(
      calls
        .map(([n]) => n)
        .filter((n) => n.endsWith(".close"))
        .sort(),
    ).toEqual(["admin.close", "consumer.close"]);
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
    const { lib } = fakeLib({ "consumer.fetch": () => response, "admin.metadata": allTopics });
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
