import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import type { ProviderCapabilities } from "@/lib/db/types";
import { KafkaError, type KafkaConfigEntry, type KafkaTopicMetadata } from "@/lib/db/providers/stream/kafka/client";
import {
  countObjects,
  describeObject,
  describeObjects,
  KAFKA_CONTAINER_LEVELS,
  KAFKA_OBJECT_KINDS,
  KAFKA_TOPIC_COLUMNS,
  KAFKA_TOPIC_LIST_CAP,
  listContainers,
  listObjects,
  type ObjectsClient,
  readObjectSource,
  topicStatus,
} from "@/lib/db/providers/stream/kafka/objects";
import { kafkaFixture } from "../../../helpers/kafka-fixtures";

const big = (value: number) => BigInt(value);
const CAPS = {
  containerLevels: KAFKA_CONTAINER_LEVELS,
  objectKinds: KAFKA_OBJECT_KINDS,
} as unknown as ProviderCapabilities;
const partition = (p: number, over: object = {}) => ({
  partition: p,
  leader: 1,
  leaderEpoch: 0,
  replicas: [1, 2],
  isr: [1, 2],
  offlineReplicas: [],
  ...over,
});
const topic = (name: string, partitions = [partition(0)]): KafkaTopicMetadata => ({
  name,
  id: `id-${name}`,
  partitions,
});

function client(topicNames: string[], over: Partial<ObjectsClient> = {}): ObjectsClient {
  return {
    listTopics: async () => [...topicNames].sort(),
    metadata: async (topics) => {
      const wanted = topics ?? topicNames;
      const missing = wanted.find((t) => !topicNames.includes(t));
      if (missing) throw new KafkaError("unknown-topic", "The topic does not exist");
      return {
        clusterId: "c",
        controllerId: 1,
        brokers: [
          { nodeId: 2, host: "b2", port: 9092, rack: null },
          { nodeId: 1, host: "b1", port: 9092, rack: null },
        ],
        topics: wanted.map((t) => topic(t)),
      };
    },
    offsets: async (_t, at) => new Map([[0, at === "earliest" ? big(3) : big(24)]]),
    topicConfigs: async () => [
      { name: "retention.ms", value: "604800000", readOnly: false, isSensitive: false, source: 5 },
      { name: "cleanup.policy", value: "compact", readOnly: false, isSensitive: false, source: 1 },
    ],
    brokerConfigs: async () => [
      { name: "ssl.keystore.password", value: null, readOnly: true, isSensitive: true, source: 4 },
    ],
    listGroups: async () => [{ groupId: "billing", state: "Stable", groupType: "classic", protocolType: "consumer" }],
    describeGroup: async (l) => ({
      groupId: l.groupId,
      groupType: l.groupType,
      state: l.state,
      protocolOrAssignor: "range",
      members: [],
    }),
    committedOffsets: async () => [{ topic: "orders", partition: 0, offset: big(20) }],
    ...over,
  };
}
const textOf = (doc: { parts: readonly unknown[] }, index: number) => (doc.parts[index] as { text: string }).text;

/**
 * A captured DescribeConfigs answer (tests/fixtures/kafka), as the seam hands it over: the one
 * resource's entries, in the broker's order, with `configSource` read as `source` the way the
 * adapter's `mapConfigs` reads it (its own test pins that mapping; this file pins what the object
 * surface makes of the broker's real population).
 */
function capturedConfigs(name: "configs-broker-1" | "configs-topic-orders"): KafkaConfigEntry[] {
  const [resource] =
    kafkaFixture<
      Array<{
        configs: Array<{
          name: string;
          value: string | null;
          readOnly: boolean;
          isSensitive: boolean;
          configSource: number;
        }>;
      }>
    >(name);
  return resource.configs.map((c) => ({
    name: c.name,
    value: c.value,
    readOnly: c.readOnly,
    isSensitive: c.isSensitive,
    source: c.configSource,
  }));
}
type ShownConfig = { name: string; value: string | null; source: string; readOnly: boolean };

describe("declaration", () => {
  test("three kinds, no container level, only topic has columns, every kind has a JSON source, none writable", () => {
    expect(KAFKA_CONTAINER_LEVELS).toEqual([]);
    expect(listContainers()).toEqual([]);
    expect(KAFKA_OBJECT_KINDS.map((k) => [k.id, k.role, k.hasColumns === true])).toEqual([
      ["topic", "relation", true],
      ["consumer_group", "group", false],
      ["broker", "config", false],
    ]);
    for (const kind of KAFKA_OBJECT_KINDS) {
      expect(kind).toMatchObject({ hasSource: true, sourceLanguage: "json" });
      expect(kind.acceptsRowWrites).toBeUndefined();
      expect(kind.acceptsSourceEdits).toBeUndefined();
    }
  });

  test("the fixed topic columns", () => {
    expect(KAFKA_TOPIC_COLUMNS.map((c) => c.name)).toEqual([
      "partition",
      "offset",
      "timestamp",
      "key",
      "key_encoding",
      "value",
      "value_encoding",
      "headers",
    ]);
  });

  test("every kind's path is [name]: a missing or an extra segment is refused by the shared shape check", async () => {
    for (const kind of ["topic", "consumer_group", "broker"]) {
      for (const path of [[], ["a", "extra"]]) {
        const error = await describeObject(client(["a"]), CAPS, path, kind).catch((e) => e);
        expect(error).toBeInstanceOf(QueryError);
        expect(error.message).toBe(`A Kafka "${kind}" path is [name], received ${JSON.stringify(path)}`);
        await expect(readObjectSource(client(["a"]), CAPS, path, kind)).rejects.toThrow(
          `A Kafka "${kind}" path is [name]`,
        );
      }
    }
    // The control: the same calls on a one-segment path answer, so the refusals come from the shape.
    expect((await describeObject(client(["a"]), CAPS, ["a"], "topic")).path).toEqual(["a"]);
  });
});

describe("topicStatus", () => {
  test("offline wins over under-replicated; healthy is undefined", () => {
    expect(topicStatus(topic("t", [partition(0)]))).toBeUndefined();
    expect(topicStatus(topic("t", [partition(0, { isr: [1] })]))).toBe("under-replicated");
    expect(topicStatus(topic("t", [partition(0, { isr: [1] }), partition(1, { leader: -1 })]))).toBe("offline");
  });
});

describe("counting and listing", () => {
  test("the count is the listed length", async () => {
    expect(await countObjects(client(["a", "b"]), [])).toEqual({
      topic: { count: 2 },
      consumer_group: { count: 1 },
      broker: { count: 2 },
    });
  });

  test("past the cap the topic count is a floor and the list is cut", async () => {
    const names = Array.from({ length: KAFKA_TOPIC_LIST_CAP + 5 }, (_, i) => `t${String(i).padStart(5, "0")}`);
    const counts = await countObjects(client(names), []);
    expect(counts.topic).toEqual({
      count: KAFKA_TOPIC_LIST_CAP,
      sampledFrom: "one topic listing capped at 2,000 names",
    });
    expect((await listObjects(client(names), [], "topic")).length).toBe(KAFKA_TOPIC_LIST_CAP);
  });

  test("a kind the broker refuses is unavailable in its words, and the other kinds are still counted", async () => {
    const denied = client(["a"], {
      listGroups: async () => {
        throw new KafkaError("authorization", "The broker denied access to this group");
      },
    });
    expect(await countObjects(denied, [])).toEqual({
      topic: { count: 1 },
      consumer_group: { unavailable: "The broker denied access to this group" },
      broker: { count: 2 },
    });
    const defect = client(["a"], {
      listGroups: async () => {
        throw new TypeError("x is undefined");
      },
    });
    await expect(countObjects(defect, [])).rejects.toBeInstanceOf(TypeError);
  });

  test("brokers are named with host and port in node order, with no controller marker", async () => {
    const rows = await listObjects(client(["a"]), [], "broker");
    expect(rows.map((r) => [r.path, r.name])).toEqual([
      [["1"], "1 b1:9092"],
      [["2"], "2 b2:9092"],
    ]);
  });

  test("a topic row carries status and never a rowCount; an empty cluster lists no topics", async () => {
    const [row] = await listObjects(
      client(["a"], {
        metadata: async () => ({
          clusterId: "c",
          controllerId: 1,
          brokers: [],
          topics: [topic("a", [partition(0, { isr: [1] })])],
        }),
      }),
      [],
      "topic",
    );
    expect(row).toEqual({ path: ["a"], name: "a", kind: "topic", status: "under-replicated" });
    expect(await listObjects(client([]), [], "topic")).toEqual([]);
  });

  test("a non-empty container, or a kind Kafka does not declare, is refused", async () => {
    await expect(listObjects(client([]), ["x"], "topic")).rejects.toThrow(KafkaError);
    await expect(listObjects(client([]), [], "partition")).rejects.toThrow(KafkaError);
  });
});

describe("describe", () => {
  test("describeObject on a topic answers the fixed columns after an existence check; other kinds answer none", async () => {
    expect((await describeObject(client(["orders"]), CAPS, ["orders"], "topic")).columns).toEqual(KAFKA_TOPIC_COLUMNS);
    await expect(describeObject(client([]), CAPS, ["ghost"], "topic")).rejects.toThrow(KafkaError);
    expect((await describeObject(client([]), CAPS, ["billing"], "consumer_group")).columns).toEqual([]);
    await expect(describeObject(client([]), CAPS, ["x"], "partition")).rejects.toThrow(KafkaError);
  });

  test("describeObjects is one listing read, fixed columns, and a caller's bound in the one shared sentence", async () => {
    let reads = 0;
    const c = client(["a", "b", "c"], {
      listTopics: async () => {
        reads++;
        return ["a", "b", "c"];
      },
    });
    const batch = await describeObjects(c, [], "topic", 2);
    expect(reads).toBe(1);
    expect(batch.details.map((d) => d.path)).toEqual([["a"], ["b"]]);
    expect(batch.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
    expect(await describeObjects(c, [], "topic")).toEqual({ details: expect.any(Array) });
    expect(await describeObjects(c, [], "broker")).toEqual({ details: [] });
  });

  test("past the topic cap, the cap is said; with a caller's bound too, both are, the caller's first", async () => {
    const names = Array.from({ length: KAFKA_TOPIC_LIST_CAP + 1 }, (_, i) => `t${String(i).padStart(5, "0")}`);
    const capped = await describeObjects(client(names), [], "topic");
    expect(capped.truncated).toEqual({
      limit: KAFKA_TOPIC_LIST_CAP,
      reason: "the listing is one topic listing capped at 2,000 names",
    });
    expect(capped.truncated?.reason).not.toContain(callerBoundTruncationReason(KAFKA_TOPIC_LIST_CAP));
    const both = await describeObjects(client(names), [], "topic", 10);
    expect(both.truncated).toEqual({
      limit: 10,
      reason: `${callerBoundTruncationReason(10)}, and the listing is one topic listing capped at 2,000 names`,
    });
  });
});

describe("sources", () => {
  test("topic: partitions with offsets to the high watermark and the offset span, then non-default configs", async () => {
    const positions: string[] = [];
    const c = client(["orders"], {
      offsets: async (_t, at) => {
        positions.push(at);
        return new Map([[0, at === "earliest" ? big(3) : big(24)]]);
      },
    });
    const doc = await readObjectSource(c, CAPS, ["orders"], "topic");
    expect(doc.parts.map((p) => p.id)).toEqual(["partitions", "configs"]);
    expect(positions.sort()).toEqual(["earliest", "high-watermark"]);
    const partitions = JSON.parse(textOf(doc, 0));
    expect(partitions[0]).toMatchObject({ partition: 0, earliestOffset: "3", latestOffset: "24", offsetSpan: "21" });
    const configs = JSON.parse(textOf(doc, 1));
    expect(configs.map((c: { name: string }) => c.name)).toEqual(["cleanup.policy"]);
    expect(configs[0]).toEqual({
      name: "cleanup.policy",
      value: "compact",
      source: "dynamic topic config",
      readOnly: false,
    });
    expect(doc.parts[0]).toMatchObject({ language: "json", form: "complete", origin: "rendered" });
    expect(doc.parts.every((p) => !("truncated" in p))).toBe(true);
  });

  test("an offline topic's source shows its partitions without offsets, and says why", async () => {
    let offsetReads = 0;
    const c = client(["orders"], {
      metadata: async () => ({
        clusterId: "c",
        controllerId: 1,
        brokers: [],
        topics: [topic("orders", [partition(0), partition(1, { leader: -1 })])],
      }),
      offsets: async () => {
        offsetReads++;
        return new Map();
      },
    });
    const doc = await readObjectSource(c, CAPS, ["orders"], "topic");
    expect(offsetReads).toBe(0);
    expect(doc.parts[0].label).toContain("partition 1 has no leader");
    expect(JSON.parse(textOf(doc, 0))[1]).toMatchObject({
      partition: 1,
      leader: -1,
      earliestOffset: null,
      latestOffset: null,
      offsetSpan: null,
    });
  });

  test("a partition the offsets answer does not name has no offset and says so, never an invented 0", async () => {
    const c = client(["orders"], {
      metadata: async () => ({
        clusterId: "c",
        controllerId: 1,
        brokers: [],
        topics: [topic("orders", [partition(0), partition(1), partition(2), partition(3)])],
      }),
      offsets: async (_t, at) =>
        at === "earliest"
          ? new Map([
              [0, big(3)],
              [2, big(5)],
            ])
          : new Map([
              [0, big(24)],
              [1, big(9)],
            ]),
    });
    const rows = JSON.parse(textOf(await readObjectSource(c, CAPS, ["orders"], "topic"), 0));
    expect(rows[0]).toMatchObject({ earliestOffset: "3", latestOffset: "24", offsetSpan: "21" });
    expect("note" in rows[0]).toBe(false);
    expect(rows[1]).toMatchObject({
      partition: 1,
      earliestOffset: null,
      latestOffset: "9",
      offsetSpan: null,
      note: "the broker reported no earliest offset for this partition",
    });
    expect(rows[2]).toMatchObject({
      partition: 2,
      earliestOffset: "5",
      latestOffset: null,
      offsetSpan: null,
      note: "the broker reported no latest offset for this partition",
    });
    expect(rows[3]).toMatchObject({
      partition: 3,
      earliestOffset: null,
      latestOffset: null,
      offsetSpan: null,
      note: "the broker reported no earliest or latest offset for this partition",
    });
  });

  test("a caller's source bound cuts each part to its limit and marks it; a part within the bound is not marked", async () => {
    const whole = await readObjectSource(client(["a"]), CAPS, ["1"], "broker");
    const length = textOf(whole, 0).length;
    const cut = await readObjectSource(client(["a"]), CAPS, ["1"], "broker", 40);
    expect(textOf(cut, 0)).toBe(textOf(whole, 0).slice(0, 40));
    expect(cut.parts[0]).toMatchObject({
      form: "complete",
      truncated: { limit: 40, reason: sourceBoundTruncationReason(40) },
    });
    const fits = await readObjectSource(client(["a"]), CAPS, ["1"], "broker", length);
    expect("truncated" in fits.parts[0]).toBe(false);
  });

  test("broker: a sensitive value is shown as redacted by the broker, and an unknown config source by its number", async () => {
    const doc = await readObjectSource(client(["a"]), CAPS, ["1"], "broker");
    expect(JSON.parse(textOf(doc, 0))[0]).toEqual({
      name: "ssl.keystore.password",
      value: "redacted by the broker",
      source: "static broker config",
      readOnly: true,
    });
    const future = await readObjectSource(
      client(["a"], {
        brokerConfigs: async () => [{ name: "x", value: "1", readOnly: false, isSensitive: false, source: 42 }],
      }),
      CAPS,
      ["1"],
      "broker",
    );
    expect(JSON.parse(textOf(future, 0))[0].source).toBe("42");
  });

  test("broker: only an entry the broker marks sensitive and withholds reads as redacted; an unset one, and a value it sent, stay as sent", async () => {
    const doc = await readObjectSource(
      client(["a"], {
        brokerConfigs: async () => [
          { name: "ssl.keystore.password", value: null, readOnly: true, isSensitive: true, source: 4 },
          // Unset, and not sensitive: kafka-configs.sh prints it as null too, never as a secret.
          {
            name: "remote.log.metadata.manager.listener.name",
            value: null,
            readOnly: true,
            isSensitive: false,
            source: 5,
          },
          // A value the broker did send is shown as sent (K6), whatever it marks the entry.
          { name: "sasl.jaas.config", value: "sent anyway", readOnly: true, isSensitive: true, source: 4 },
        ],
      }),
      CAPS,
      ["1"],
      "broker",
    );
    expect((JSON.parse(textOf(doc, 0)) as ShownConfig[]).map((c) => [c.name, c.value])).toEqual([
      ["ssl.keystore.password", "redacted by the broker"],
      ["remote.log.metadata.manager.listener.name", null],
      ["sasl.jaas.config", "sent anyway"],
    ]);
  });

  test("broker 1's captured configs: exactly the sensitive entries read as redacted, and every other value as the broker sent it", async () => {
    const entries = capturedConfigs("configs-broker-1");
    const doc = await readObjectSource(client(["a"], { brokerConfigs: async () => entries }), CAPS, ["1"], "broker");
    const shown = JSON.parse(textOf(doc, 0)) as ShownConfig[];
    const sensitive = entries.filter((c) => c.isSensitive);
    const unsetPlain = entries.filter((c) => !c.isSensitive && c.value === null);
    // The capture's own census (Apache Kafka 4.3.1): 340 entries, the 10 sensitive ones all
    // withheld, and 42 that are simply unset, which a rule reading every null as redacted
    // would show as secrets.
    expect([shown.length, sensitive.length, unsetPlain.length]).toEqual([340, 10, 42]);
    expect(sensitive.every((c) => c.value === null)).toBe(true);
    expect(shown.filter((c) => c.value === "redacted by the broker").map((c) => c.name)).toEqual(
      sensitive.map((c) => c.name),
    );
    expect(shown.find((c) => c.name === "remote.log.metadata.manager.listener.name")?.value).toBeNull();
    expect(shown.map((c) => [c.name, c.value])).toEqual(
      entries.map((c) => [c.name, c.isSensitive ? "redacted by the broker" : c.value]),
    );
  });

  test("every ConfigSource number is shown in Kafka's own words, and one this build does not know as its number", async () => {
    // The protocol's ConfigSource numbers and the names Kafka gives them, the names the
    // client's `ConfigSources` enumeration and the synonyms `kafka-configs.sh --describe`
    // prints, beside the words a source shows for each.
    const kafkaSources = [
      [0, "UNKNOWN", "unknown"],
      [1, "DYNAMIC_TOPIC_CONFIG", "dynamic topic config"],
      [2, "DYNAMIC_BROKER_CONFIG", "dynamic broker config"],
      [3, "DYNAMIC_DEFAULT_BROKER_CONFIG", "dynamic default broker config"],
      [4, "STATIC_BROKER_CONFIG", "static broker config"],
      [5, "DEFAULT_CONFIG", "default"],
      [6, "DYNAMIC_BROKER_LOGGER_CONFIG", "dynamic broker logger config"],
      [7, "CLIENT_METRICS_CONFIG", "client metrics config"],
      [8, "GROUP_CONFIG", "group config"],
    ] as const;
    const doc = await readObjectSource(
      client(["a"], {
        brokerConfigs: async () => [
          ...kafkaSources.map(([source, name]) => ({ name, value: "v", readOnly: false, isSensitive: false, source })),
          { name: "NEXT_SOURCE", value: "v", readOnly: false, isSensitive: false, source: 9 },
        ],
      }),
      CAPS,
      ["1"],
      "broker",
    );
    expect((JSON.parse(textOf(doc, 0)) as ShownConfig[]).map((c) => [c.name, c.source])).toEqual([
      ...kafkaSources.map(([, name, words]) => [name, words]),
      ["NEXT_SOURCE", "9"],
    ]);
  });

  test("the captured sources read in Kafka's words: orders' one override is a dynamic default broker config, and broker 1's are defaults, static configs and that one", async () => {
    const topicDoc = await readObjectSource(
      client(["orders"], { topicConfigs: async () => capturedConfigs("configs-topic-orders") }),
      CAPS,
      ["orders"],
      "topic",
    );
    // kafka-configs.sh on the seeded broker: min.insync.replicas=1 synonyms={DYNAMIC_DEFAULT_BROKER_CONFIG:...}.
    expect(JSON.parse(textOf(topicDoc, 1))).toEqual([
      { name: "min.insync.replicas", value: "1", source: "dynamic default broker config", readOnly: false },
    ]);
    const brokerDoc = await readObjectSource(
      client(["a"], { brokerConfigs: async () => capturedConfigs("configs-broker-1") }),
      CAPS,
      ["1"],
      "broker",
    );
    const shown = JSON.parse(textOf(brokerDoc, 0)) as ShownConfig[];
    const byName = new Map(shown.map((c) => [c.name, c]));
    expect([
      byName.get("node.id"),
      byName.get("log.cleaner.min.compaction.lag.ms"),
      byName.get("min.insync.replicas"),
    ]).toEqual([
      { name: "node.id", value: "1", source: "static broker config", readOnly: true },
      { name: "log.cleaner.min.compaction.lag.ms", value: "0", source: "default", readOnly: false },
      { name: "min.insync.replicas", value: "1", source: "dynamic default broker config", readOnly: false },
    ]);
    // Every entry of the capture, by the source it was shown with: 324 defaults, 15 static, 1 dynamic default.
    const bySource = new Map<string, number>();
    for (const c of shown) bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
    expect(Object.fromEntries(bySource)).toEqual({
      default: 324,
      "static broker config": 15,
      "dynamic default broker config": 1,
    });
  });

  test("consumer group: the description then the lag", async () => {
    const doc = await readObjectSource(client(["orders"]), CAPS, ["billing"], "consumer_group");
    expect(doc.parts.map((p) => p.id)).toEqual(["group", "offsets"]);
    expect(JSON.parse(textOf(doc, 1))[0]).toMatchObject({ lag: "4" });
  });

  test("a missing name of any kind is a QueryError-mapped unknown-object naming the segment", async () => {
    for (const [kind, name] of [
      ["topic", "ghost"],
      ["consumer_group", "ghost"],
      ["broker", "9"],
    ] as const) {
      const error = await readObjectSource(client(["a"]), CAPS, [name], kind).catch((e) => e);
      expect(error).toBeInstanceOf(KafkaError);
      expect(["unknown-object", "unknown-topic"]).toContain(error.category);
      expect(error.message).toContain(name);
    }
  });

  test("any other failure reading a topic's metadata propagates unchanged", async () => {
    const denied = new KafkaError("authorization", "The broker denied access to this topic");
    const c = client(["orders"], {
      metadata: async () => {
        throw denied;
      },
    });
    expect(await readObjectSource(c, CAPS, ["orders"], "topic").catch((e) => e)).toBe(denied);
  });

  test("a kind declared beyond Kafka's three is refused, not guessed", async () => {
    const extra = {
      ...CAPS,
      objectKinds: [
        ...KAFKA_OBJECT_KINDS,
        { id: "partition", role: "relation", label: "Partition", labelPlural: "Partitions" },
      ],
    } as unknown as ProviderCapabilities;
    await expect(readObjectSource(client([]), extra, ["x"], "partition")).rejects.toThrow(
      "Kafka declares no object kind",
    );
  });
});
