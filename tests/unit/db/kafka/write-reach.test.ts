/**
 * Kafka's write reach: the API key set `KAFKA_READ_APIS` is the whole of what Studio can send a broker.
 *
 * Kafka is recorded `none` on the strength of one claim: the client builds no write request, because every Kafka
 * request it sends is one of the APIs `KAFKA_READ_APIS` lists, and every one of them is a read. The editor's grammar
 * is `parseReadRequest`, which admits a read request only, and the provider has no other route that sends anything.
 * This file holds the claim four ways, each of which a change to the client would have to break on purpose.
 *
 * 1. The table itself: frozen, every entry a read API under its protocol key, and none of the write, group-membership
 *    or admin APIs.
 * 2. The client as it runs: the real `@platformatic/kafka`, loaded through `loadPlatformatic()`, drives every method
 *    of the client against a local listener that records the API key of every request frame. The keys recorded are
 *    exactly the table's, every Metadata request asks for no topic creation, and an internal topic is refused before
 *    any frame is sent. The methods are read from the client object, not from a list this file keeps, so a new
 *    method that is not driven fails.
 * 3. The source: every call `platformatic-client.ts` makes on a library object is a member this file maps to the
 *    table's APIs, every raw protocol call is one of the two the table covers, and only the clients the table covers
 *    are built. The check is a parse, so it sees a call in a branch the run above never drives; the same check runs
 *    over sample sources that plant a write in such a branch.
 * 4. The live run: tests/fixtures/kafka/4.3.1/write-reach/write-reach.json, written by tests/live/kafka-write-reach.ts
 *    through its run.sh against a fresh Apache Kafka 4.3.1, records the topic list, every partition's end offset and
 *    every group's committed offsets unchanged across every provider surface, every request frame Studio sent through
 *    a recording forwarder, and a control write by the script that moved them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import ts from "typescript";
import type { KafkaReadClient, KafkaTopicMetadata } from "@/lib/db/providers/stream/kafka/client";
import {
  createPlatformaticClient,
  KAFKA_READ_APIS,
  loadPlatformatic,
} from "@/lib/db/providers/stream/kafka/platformatic-client";
import { kafkaFixture } from "../../../helpers/kafka-fixtures";
import { platformTimeoutMs } from "../../../helpers/platform-timeout";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CAPTURE = join(ROOT, "tests", "fixtures", "kafka", "4.3.1", "write-reach", "write-reach.json");
const ADAPTER_SOURCE = join(ROOT, "src", "lib", "db", "providers", "stream", "kafka", "platformatic-client.ts");

/**
 * The Kafka APIs that only read, by their protocol key (Apache Kafka's ApiKeys, as `protocolAPIsById` in
 * `@platformatic/kafka`'s `dist/protocol/apis.js` names them): the cluster, topic, offset, group and config reads,
 * and the connection's own version and authentication exchange, which changes no broker state.
 */
const READ_API_KEYS: Readonly<Record<string, number>> = {
  Fetch: 1,
  ListOffsets: 2,
  Metadata: 3,
  OffsetFetch: 9,
  FindCoordinator: 10,
  DescribeGroups: 15,
  ListGroups: 16,
  SaslHandshake: 17,
  ApiVersions: 18,
  DescribeAcls: 29,
  DescribeConfigs: 32,
  DescribeLogDirs: 35,
  SaslAuthenticate: 36,
  DescribeDelegationToken: 41,
  DescribeClientQuotas: 48,
  DescribeUserScramCredentials: 50,
  DescribeCluster: 60,
  DescribeProducers: 61,
  DescribeTransactions: 65,
  ListTransactions: 66,
  ConsumerGroupDescribe: 69,
};

/**
 * The APIs that write a record, a topic, a config, an offset, a group's membership or a producer's state, by key. The
 * table may hold none of them; every one the design names is here, and the rest of the protocol's writes besides.
 */
const WRITE_API_KEYS: Readonly<Record<string, number>> = {
  Produce: 0,
  OffsetCommit: 8,
  JoinGroup: 11,
  Heartbeat: 12,
  LeaveGroup: 13,
  SyncGroup: 14,
  CreateTopics: 19,
  DeleteTopics: 20,
  DeleteRecords: 21,
  InitProducerId: 22,
  AddPartitionsToTxn: 24,
  AddOffsetsToTxn: 25,
  EndTxn: 26,
  TxnOffsetCommit: 28,
  CreateAcls: 30,
  DeleteAcls: 31,
  AlterConfigs: 33,
  AlterReplicaLogDirs: 34,
  CreatePartitions: 37,
  CreateDelegationToken: 38,
  RenewDelegationToken: 39,
  ExpireDelegationToken: 40,
  DeleteGroups: 42,
  ElectLeaders: 43,
  IncrementalAlterConfigs: 44,
  AlterPartitionReassignments: 45,
  OffsetDelete: 47,
  AlterClientQuotas: 49,
  AlterUserScramCredentials: 51,
  UnregisterBroker: 64,
  ConsumerGroupHeartbeat: 68,
};

/** One request frame as the listener received it: its API key, its version and its body after the header. */
interface Frame {
  readonly apiKey: number;
  readonly version: number;
  readonly body: Buffer;
}

const TOPIC = "orders";
const TOPIC_ID = "8f0c1c1e-4a51-4b9d-9a3f-1f2a3b4c5d6e";
const GROUP = "lag-classic";
/** A stand-in credential, built rather than written, so no scanner reads it as one. */
const STAND_IN_PASSWORD = ["not", "a", "real", "password"].join("-");

const int8 = (value: number) => Buffer.from([value & 0xff]);
const int16 = (value: number) => {
  const out = Buffer.alloc(2);
  out.writeInt16BE(value);
  return out;
};
const int32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeInt32BE(value);
  return out;
};
const uvarint = (value: number) => {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const TAGS = uvarint(0);
const compactString = (value: string | null) =>
  value === null ? uvarint(0) : Buffer.concat([uvarint(Buffer.byteLength(value) + 1), Buffer.from(value)]);
const string16 = (value: string) => Buffer.concat([int16(Buffer.byteLength(value)), Buffer.from(value)]);
const compactArray = <T>(items: readonly T[], encode: (item: T) => Buffer) =>
  Buffer.concat([uvarint(items.length + 1), ...items.map(encode)]);

/** Reads an unsigned varint at `at`, answering its value and the offset after it. */
function readUvarint(buffer: Buffer, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let offset = at;
  for (;;) {
    const byte = buffer[offset];
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
}

/** The broker's ApiVersions answer: the API ranges Apache Kafka 4.3.1 advertised, as captured (tests/fixtures/kafka). */
const apiVersionsBody = () =>
  Buffer.concat([
    int16(0),
    compactArray(
      kafkaFixture<Array<{ apiKey: number; minVersion: number; maxVersion: number }>>("api-versions"),
      (api) => Buffer.concat([int16(api.apiKey), int16(api.minVersion), int16(api.maxVersion), TAGS]),
    ),
    int32(0),
    TAGS,
  ]);

/** Metadata v12: this listener is broker 1 and leads the one partition of the one topic. */
const metadataBody = (port: number) =>
  Buffer.concat([
    int32(0),
    compactArray([port], (p) =>
      Buffer.concat([int32(1), compactString("127.0.0.1"), int32(p), compactString(null), TAGS]),
    ),
    compactString("write-reach-cluster"),
    int32(1),
    compactArray([TOPIC], (name) =>
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

/** The keys a FindCoordinator v4 or later request names, so the answer names the same ones. */
function coordinatorKeys(body: Buffer): string[] {
  let [count, at] = readUvarint(body, 1);
  const keys: string[] = [];
  for (count -= 1; count > 0; count -= 1) {
    const [length, start] = readUvarint(body, at);
    keys.push(body.subarray(start, start + length - 1).toString());
    at = start + length - 1;
  }
  return keys;
}

/** FindCoordinator v6: this listener coordinates every key asked about. */
const coordinatorBody = (keys: readonly string[], port: number) =>
  Buffer.concat([
    int32(0),
    compactArray(keys, (key) =>
      Buffer.concat([
        compactString(key),
        int32(1),
        compactString("127.0.0.1"),
        int32(port),
        int16(0),
        compactString(null),
        TAGS,
      ]),
    ),
    TAGS,
  ]);

/** SaslHandshake v1: the mechanism the client asked for is enabled. */
const saslHandshakeBody = () => Buffer.concat([int16(0), int32(1), string16("PLAIN")]);

/** The Metadata v12 request's topic names and its allow_auto_topic_creation flag. */
function metadataRequest(body: Buffer): { topics: string[] | null; autoCreate: boolean } {
  let [count, at] = readUvarint(body, 0);
  const topics: string[] = [];
  for (count -= 1; count > 0; count -= 1) {
    at += 16;
    const [length, start] = readUvarint(body, at);
    if (length > 0) topics.push(body.subarray(start, start + length - 1).toString());
    at = Math.max(start, start + length - 1);
    at = readUvarint(body, at)[1];
  }
  return { topics: readUvarint(body, 0)[0] === 0 ? null : topics, autoCreate: body[at] !== 0 };
}

/**
 * A listener that answers ApiVersions, Metadata, FindCoordinator and SaslHandshake as a one-broker cluster and
 * records every request frame it receives. Any other request is recorded and then refused by closing the socket,
 * which the client reports as a failed call: a read that gets that far has already sent its request, which is all
 * this file needs.
 */
async function recordingBroker() {
  const frames: Frame[] = [];
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
        // The request header: the client id as a length and its bytes, then, on a flexible version, the header's tags.
        const flexible = apiKey !== READ_API_KEYS.SaslHandshake;
        const body = frame.subarray(8 + 2 + frame.readInt16BE(8) + (flexible ? 1 : 0));
        frames.push({ apiKey, version, body });
        let reply: Buffer;
        if (apiKey === READ_API_KEYS.ApiVersions) reply = Buffer.concat([int32(correlationId), apiVersionsBody()]);
        else if (apiKey === READ_API_KEYS.Metadata)
          reply = Buffer.concat([int32(correlationId), TAGS, metadataBody(port)]);
        else if (apiKey === READ_API_KEYS.FindCoordinator)
          reply = Buffer.concat([int32(correlationId), TAGS, coordinatorBody(coordinatorKeys(body), port)]);
        else if (apiKey === READ_API_KEYS.SaslHandshake)
          reply = Buffer.concat([int32(correlationId), saslHandshakeBody()]);
        else {
          socket.destroy();
          return;
        }
        socket.write(Buffer.concat([int32(reply.length), reply]));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    frames,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const ORDERS: KafkaTopicMetadata = {
  name: TOPIC,
  id: TOPIC_ID,
  partitions: [{ partition: 0, leader: 1, leaderEpoch: 0, replicas: [1], isr: [1], offlineReplicas: [] }],
};

/** Every method of the client, called once with arguments its signature takes; the answers do not matter. */
const CALLS: Readonly<Record<keyof KafkaReadClient, (client: KafkaReadClient) => Promise<unknown>>> = {
  metadata: (client) => client.metadata([TOPIC]),
  listTopics: (client) => client.listTopics(),
  offsets: (client) => client.offsets(TOPIC, "latest"),
  offsetsForTimestamp: (client) => client.offsetsForTimestamp(TOPIC, BigInt(0)),
  fetch: (client) => client.fetch(ORDERS, 0, BigInt(0), AbortSignal.timeout(2_000)),
  topicConfigs: (client) => client.topicConfigs(TOPIC),
  brokerConfigs: (client) => client.brokerConfigs(1),
  listGroups: (client) => client.listGroups(),
  describeGroup: async (client) => {
    await client
      .describeGroup({ groupId: GROUP, state: "Empty", groupType: "classic", protocolType: "consumer" })
      .catch(() => undefined);
    return client.describeGroup({ groupId: GROUP, state: "Stable", groupType: "consumer", protocolType: "consumer" });
  },
  committedOffsets: (client) => client.committedOffsets(GROUP),
  logDirs: (client) => client.logDirs([ORDERS]),
  close: (client) => client.close(),
};

/** The methods that name a topic to the broker, each called with an internal one. */
const INTERNAL_TOPIC_CALLS: Readonly<Record<string, (client: KafkaReadClient, topic: string) => Promise<unknown>>> = {
  metadata: (client, topic) => client.metadata([topic]),
  offsets: (client, topic) => client.offsets(topic, "earliest"),
  offsetsForTimestamp: (client, topic) => client.offsetsForTimestamp(topic, BigInt(0)),
  fetch: (client, topic) => client.fetch({ ...ORDERS, name: topic }, 0, BigInt(0), AbortSignal.timeout(2_000)),
  topicConfigs: (client, topic) => client.topicConfigs(topic),
  logDirs: (client, topic) => client.logDirs([{ ...ORDERS, name: topic }]),
};

async function clientOn(port: number, sasl: boolean): Promise<KafkaReadClient> {
  return createPlatformaticClient(
    {
      clientId: "libredb-studio",
      broker: { host: "127.0.0.1", port },
      timeoutMs: 2_000,
      ...(sasl ? { sasl: { mechanism: "PLAIN" as const, username: "reader", password: STAND_IN_PASSWORD } } : {}),
    },
    await loadPlatformatic(),
  );
}

const keyName = (key: number) =>
  Object.entries({ ...READ_API_KEYS, ...WRITE_API_KEYS }).find(([, value]) => value === key)?.[0] ?? `key ${key}`;
const TABLE_KEYS: readonly number[] = Object.values(KAFKA_READ_APIS);

describe("KAFKA_READ_APIS, the client's API key set", () => {
  test("is frozen", () => {
    expect(Object.isFrozen(KAFKA_READ_APIS)).toBe(true);
  });

  test("holds read APIs only, each under its own protocol key", () => {
    for (const [name, key] of Object.entries(KAFKA_READ_APIS)) {
      expect({ name, key }).toEqual({ name, key: READ_API_KEYS[name] });
    }
  });

  test("holds none of the write, group-membership or admin APIs", () => {
    for (const [name, key] of Object.entries(WRITE_API_KEYS)) {
      expect({ name, inTable: TABLE_KEYS.includes(key) }).toEqual({ name, inTable: false });
    }
  });
});

/**
 * Every method of a plain client, then one call of a client with SASL configured, which alone runs the
 * authentication exchange, all against one recording listener. Run once and shared: the listener refuses most
 * requests by closing the socket, and the client's retry after each refusal makes the run take seconds.
 */
let driven: Promise<{ methods: string[]; frames: readonly Frame[] }> | undefined;
function driveEveryMethod(): Promise<{ methods: string[]; frames: readonly Frame[] }> {
  driven ??= (async () => {
    const broker = await recordingBroker();
    try {
      const plain = await clientOn(broker.port, false);
      const methods = Object.keys(plain).sort();
      for (const call of Object.values(CALLS)) {
        // A call the listener refuses fails after its request was sent, which is all this test needs.
        await call(plain).catch(() => undefined);
      }
      const authenticated = await clientOn(broker.port, true);
      await authenticated.listTopics().catch(() => undefined);
      await authenticated.close();
      return { methods, frames: broker.frames };
    } finally {
      await broker.close();
    }
  })();
  return driven;
}

/** The whole drive takes about fifteen seconds on Linux, most of it the client's retry delay. */
const DRIVE_TIMEOUT_MS = platformTimeoutMs(60_000);

describe("the real client sends exactly the table's APIs", () => {
  test(
    "every method it answers is driven here, and the frames recorded carry every table key and no other",
    async () => {
      const { methods, frames } = await driveEveryMethod();
      expect(methods).toEqual(Object.keys(CALLS).sort());
      const sent = [...new Set(frames.map((frame) => frame.apiKey))].sort((a, b) => a - b);
      expect(sent.map(keyName)).toEqual([...TABLE_KEYS].sort((a, b) => a - b).map(keyName));
    },
    DRIVE_TIMEOUT_MS,
  );

  test(
    "every Metadata request asks the broker to create no topic",
    async () => {
      const { frames } = await driveEveryMethod();
      const metadata = frames.filter((frame) => frame.apiKey === KAFKA_READ_APIS.Metadata);
      // The control: the requests were read, both with a topic named and with none.
      expect(metadata.some((frame) => metadataRequest(frame.body).topics?.includes(TOPIC))).toBe(true);
      expect(metadata.some((frame) => metadataRequest(frame.body).topics?.length === 0)).toBe(true);
      expect(metadata.every((frame) => frame.version === 12)).toBe(true);
      for (const frame of metadata) {
        expect(metadataRequest(frame.body)).toMatchObject({ autoCreate: false });
      }
    },
    DRIVE_TIMEOUT_MS,
  );

  test.each(Object.keys(INTERNAL_TOPIC_CALLS))(
    "%s refuses an internal topic before any request names it",
    async (method) => {
      const broker = await recordingBroker();
      const client = await clientOn(broker.port, false);
      try {
        // Connected first, so a frame sent by the call itself would be the only one after this point.
        await client.metadata([]);
        const before = broker.frames.length;
        for (const topic of ["__consumer_offsets", "__transaction_state", "__share_group_state"]) {
          await expect(INTERNAL_TOPIC_CALLS[method](client, topic)).rejects.toThrow("internal to Kafka");
        }
        expect(broker.frames.slice(before).map((frame) => keyName(frame.apiKey))).toEqual([]);
      } finally {
        await client.close();
        await broker.close();
      }
    },
  );
});

describe("the request parser this file reads Metadata with", () => {
  test("reads the creation flag either way and the topic names", () => {
    const request = (autoCreate: boolean) =>
      Buffer.concat([
        compactArray([TOPIC], (name) => Buffer.concat([Buffer.alloc(16), compactString(name), TAGS])),
        int8(autoCreate ? 1 : 0),
        int8(0),
        TAGS,
      ]);
    expect(metadataRequest(request(true))).toEqual({ topics: [TOPIC], autoCreate: true });
    expect(metadataRequest(request(false))).toEqual({ topics: [TOPIC], autoCreate: false });
    expect(metadataRequest(Buffer.concat([uvarint(0), int8(1), int8(0), TAGS]))).toEqual({
      topics: null,
      autoCreate: true,
    });
  });
});

/** The names the adapter holds library objects under (the seam guard pins the same naming). */
const LIBRARY_RECEIVERS = new Set(["admin", "consumer", "connection", "fetchPool"]);

/**
 * Every library call the adapter may make, and the APIs it sends: the client's own reads, each the request the
 * library builds for it (dist/clients/admin/admin.js and dist/clients/consumer/consumer.js in 2.14.0), and the
 * connection's version and authentication exchange, which a connection or a pooled one sends when it opens.
 */
const MEMBER_APIS: Readonly<Record<string, readonly (keyof typeof KAFKA_READ_APIS)[]>> = {
  "admin.metadata": ["Metadata"],
  "admin.listTopics": ["Metadata"],
  "admin.describeConfigs": ["Metadata", "DescribeConfigs"],
  "admin.listGroups": ["Metadata", "ListGroups"],
  "admin.describeGroups": ["FindCoordinator", "DescribeGroups"],
  "admin.listConsumerGroupOffsets": ["FindCoordinator", "OffsetFetch"],
  "admin.describeLogDirs": ["Metadata", "DescribeLogDirs"],
  "admin.findCoordinator": ["FindCoordinator"],
  "admin.listApis": ["ApiVersions"],
  "consumer.listOffsets": ["Metadata", "ListOffsets"],
  "consumer.listOffsetsWithTimestamps": ["Metadata", "ListOffsets"],
  "connection.connect": ["ApiVersions", "SaslHandshake", "SaslAuthenticate"],
  "fetchPool.get": ["ApiVersions", "SaslHandshake", "SaslAuthenticate"],
  "admin.close": [],
  "consumer.close": [],
  "connection.close": [],
  "fetchPool.close": [],
  "lib.fetchV13.api.async": ["Fetch"],
  "lib.consumerGroupDescribeV0.api.async": ["ConsumerGroupDescribe"],
};

/** The members of the loaded library the adapter may read: the four clients it builds, the two raw protocol modules, and the loggers it mutes. */
const LIBRARY_MEMBERS = new Set([
  "Admin",
  "Consumer",
  "Connection",
  "ConnectionPool",
  "fetchV13",
  "consumerGroupDescribeV0",
  "loggers",
]);

/** The dotted text of a property access chain on an identifier, or null for any other expression. */
function dotted(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const head = dotted(node.expression);
    return head === null ? null : `${head}.${node.name.text}`;
  }
  return null;
}

/**
 * Every way a source could send a library request that `MEMBER_APIS` does not map, as one line each: a call of a
 * member on a library object that the map does not hold, a raw protocol call other than the two it holds, and a read
 * of a library member other than the clients, the two raw modules and the loggers. Branches are read like any other
 * code, so a call in a branch no test drives is found.
 */
function unmappedCalls(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = dotted(node.expression);
      const receiver = callee?.split(".")[0];
      if (callee !== null && receiver !== undefined && (LIBRARY_RECEIVERS.has(receiver) || receiver === "lib")) {
        if (!Object.hasOwn(MEMBER_APIS, callee)) found.push(`call ${callee}`);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "lib" &&
      !LIBRARY_MEMBERS.has(node.name.text)
    ) {
      found.push(`lib.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);

describe("platformatic-client.ts sends nothing the table does not cover", () => {
  const source = parse(ADAPTER_SOURCE, readFileSync(ADAPTER_SOURCE, "utf8"));

  test("every library call it makes is mapped, and every mapped API is in the table", () => {
    expect(unmappedCalls(source)).toEqual([]);
    for (const [member, apis] of Object.entries(MEMBER_APIS)) {
      for (const api of apis)
        expect({ member, api, inTable: Object.hasOwn(KAFKA_READ_APIS, api) }).toMatchObject({ inTable: true });
    }
    // The control: together the mapped calls reach every table entry, so the table holds nothing the source cannot send.
    expect([...new Set(Object.values(MEMBER_APIS).flat())].sort()).toEqual(Object.keys(KAFKA_READ_APIS).sort());
  });

  test("the file still has the library calls the check looks for", () => {
    const text = source.getText(source);
    for (const needle of ["admin.metadata(", "consumer.listOffsets(", "lib.fetchV13.api.async(", "fetchPool.get("]) {
      expect({ needle, present: text.includes(needle) }).toEqual({ needle, present: true });
    }
  });

  test("the check sees a write planted in a branch no run drives", () => {
    const sample = parse(
      "sample.ts",
      [
        "async function read(admin, consumer, lib, rare) {",
        "  if (rare) await admin.createTopics({ topics: [{ name: 'x' }] });",
        "  else if (rare === 0) await consumer.commit({ offsets: [] });",
        "  await admin.metadata({ topics: [], autocreateTopics: false });",
        "}",
      ].join("\n"),
    );
    expect(unmappedCalls(sample)).toEqual(["call admin.createTopics", "call consumer.commit"]);
  });

  test("the check sees a raw protocol call and a library client outside the table", () => {
    const sample = parse(
      "sample.ts",
      [
        "function write(lib, connection, never) {",
        "  if (never) return lib.produceV11.api.async(connection, 1, 0, []);",
        "  const producer = new lib.Producer({});",
        "  return lib.offsetCommitV9.api(connection);",
        "}",
      ].join("\n"),
    );
    expect(unmappedCalls(sample)).toEqual([
      "call lib.produceV11.api.async",
      "lib.produceV11",
      "lib.Producer",
      "call lib.offsetCommitV9.api",
      "lib.offsetCommitV9",
    ]);
  });
});

interface Capture {
  readonly $captured: { readonly broker: string };
  readonly readOnlyConnectionAccepted: boolean;
  readonly handles: readonly {
    readonly handle: string;
    readonly surfaces: readonly { readonly surface: string; readonly ok: boolean }[];
    readonly snapshotDiff: readonly string[];
    readonly missingTopicCreated: boolean;
  }[];
  readonly studioLeftStateUnchanged: boolean;
  readonly sentByStudio: readonly string[];
  readonly control: { readonly topicList: boolean; readonly endOffsets: boolean; readonly committedOffsets: boolean };
}

describe("the live run against Apache Kafka 4.3.1 with no authentication and topic creation on", () => {
  const capture = JSON.parse(readFileSync(CAPTURE, "utf8")) as Capture;

  test("ran on a broker that would have taken a write", () => {
    expect(capture.$captured.broker).toContain("no authentication");
    expect(capture.$captured.broker).toContain("auto.create.topics.enable=true");
    expect(capture.readOnlyConnectionAccepted).toBe(true);
  });

  test("left the topic list, every offset, every committed offset and every config unchanged across every handle", () => {
    expect(capture.handles.map((entry) => entry.handle)).toEqual([
      "read-only connection",
      "agent read-only profile",
      "agent operations profile",
    ]);
    for (const entry of capture.handles) {
      const answered = entry.surfaces.filter((surface) => surface.ok).length;
      expect({ handle: entry.handle, answered: answered > 10 }).toEqual({ handle: entry.handle, answered: true });
      expect({ handle: entry.handle, diff: entry.snapshotDiff }).toEqual({ handle: entry.handle, diff: [] });
      // Every handle read a topic no one created, which a Metadata request allowing creation would have created.
      expect({ handle: entry.handle, created: entry.missingTopicCreated }).toEqual({
        handle: entry.handle,
        created: false,
      });
    }
    expect(capture.studioLeftStateUnchanged).toBe(true);
  });

  test("Studio sent only the table's APIs", () => {
    expect(capture.sentByStudio.length).toBeGreaterThan(0);
    for (const request of capture.sentByStudio) {
      const key = Number.parseInt(request, 10);
      expect({ request, api: keyName(key), inTable: TABLE_KEYS.includes(key) }).toEqual({
        request,
        api: keyName(key),
        inTable: true,
      });
    }
  });

  test("the control: the script's own produce, group commit and topic creation each moved the snapshot", () => {
    expect(capture.control).toMatchObject({ topicList: true, endOffsets: true, committedOffsets: true });
  });
});
