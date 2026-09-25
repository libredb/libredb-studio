/**
 * The one reader of the Kafka fixtures (#1088, spec section 10, gate 4).
 *
 * `tests/fixtures/kafka/` holds what `@platformatic/kafka` 2.11.0 answered against the compose
 * brokers before any provider code existed, one surface per file, as its README lists them.
 * Each file is `{ "$captured": {...}, "outcome": "pass" | "fail", "payload": <value> }`, with a
 * bigint written as `{ "$bigint": "<digits>" }`, a Buffer as `{ "$bytes": "<base64>" }` and a
 * Map as `{ "$map": [[key, value], ...] }`. `kafkaFixture` revives the payload. A captured error
 * stays the plain object the capture encoded (its class, message, code, errors, cause and the
 * response it carried), which is what the adapter's error translation walks.
 *
 * `recordedLib` is a recorded library: every construction and call is logged, and every method
 * answers from these files unless an override names it, so the provider's tests run over the
 * real adapter and only the broker is fake. It imports nothing from the library itself: the
 * seam guard allows exactly the adapter and the fixture seed to do that.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlatformaticLib } from "@/lib/db/providers/stream/kafka/platformatic-client";

const DIR = join(import.meta.dir, "..", "fixtures", "kafka");

/** ConfigResourceTypes.BROKER in the protocol; TOPIC is 2. */
const BROKER_RESOURCE = 4;

/** The payload of one capture, revived: bigints, Buffers and Maps as the library handed them over. */
export function kafkaFixture<T = unknown>(name: string): T {
  const record = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
  if (!Object.hasOwn(record, "payload")) {
    throw new Error(`${name}.json holds no payload; every capture is { $captured, outcome, payload }`);
  }
  const revive = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(revive);
    if (value === null || typeof value !== "object") return value;
    const o = value as Record<string, unknown>;
    if (typeof o.$bigint === "string") return BigInt(o.$bigint);
    if (typeof o.$bytes === "string") return Buffer.from(o.$bytes, "base64");
    if (Array.isArray(o.$map)) return new Map((o.$map as [unknown, unknown][]).map(([k, v]) => [revive(k), revive(v)]));
    // Buffer.prototype.toJSON's own shape: a capture that serialised a Buffer before its replacer saw it.
    if (o.type === "Buffer" && Array.isArray(o.data)) {
      throw new Error(
        `${name}.json holds a Buffer serialised by Buffer.toJSON; capture it again with a replacer that writes { $bytes }`,
      );
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, revive(v)]));
  };
  return revive(record.payload) as T;
}

type Answer = (...args: unknown[]) => unknown;

/**
 * A recorded @platformatic/kafka. Every construction lands in `constructed` and every call in
 * `calls`, as `[name, args]`, with names such as `admin.metadata` or `fetchV13`; an override
 * keyed by that name answers in place of the fixture. Shared by the adapter's unit test and the
 * provider's integration test.
 *
 * A read's fetch is two calls: `pool.get` with the leader's advertised `{ host, port }`, which
 * answers a pooled connection naming that broker, and `fetchV13` with the library's positional
 * arguments, `(connection, maxWaitMs, minBytes, maxBytes, isolationLevel, sessionId,
 * sessionEpoch, topics, forgottenTopicsData, rackId)`, so a fetch override reads its topics at
 * index 7 and the broker it was sent to at `args[0].broker`.
 */
export function recordedLib(overrides: Record<string, Answer> = {}) {
  const constructed: Array<[string, unknown]> = [];
  const calls: Array<[string, unknown[]]> = [];
  const record =
    (name: string, answer: Answer) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      return (overrides[name] ?? answer)(...args);
    };
  const admin = {
    metadata: record("admin.metadata", () => kafkaFixture("metadata-orders")),
    listTopics: record("admin.listTopics", () => kafkaFixture("list-topics")),
    // The broker answers the resource asked for: topic orders and broker 1 are captured.
    describeConfigs: record("admin.describeConfigs", (o) => {
      const [resource] = (o as { resources: Array<{ resourceType: number; resourceName: string }> }).resources;
      const kind = resource.resourceType === BROKER_RESOURCE ? "broker" : "topic";
      return kafkaFixture(`configs-${kind}-${resource.resourceName}`);
    }),
    listGroups: record("admin.listGroups", () => kafkaFixture("list-groups")),
    describeGroups: record("admin.describeGroups", () => kafkaFixture("describe-groups-classic")),
    // The broker answers the groups asked for and no others, as the library does.
    listConsumerGroupOffsets: record("admin.listConsumerGroupOffsets", (o) =>
      kafkaFixture<Array<{ groupId: string }>>("committed-offsets").filter((g) =>
        (o as { groups: string[] }).groups.includes(g.groupId),
      ),
    ),
    describeLogDirs: record("admin.describeLogDirs", () => kafkaFixture("log-dirs")),
    findCoordinator: record("admin.findCoordinator", () => kafkaFixture("find-coordinator")),
    listApis: record("admin.listApis", () => kafkaFixture("api-versions")),
    close: record("admin.close", () => undefined),
  };
  const consumer = {
    listOffsets: record("consumer.listOffsets", () => kafkaFixture("offsets-latest")),
    listOffsetsWithTimestamps: record("consumer.listOffsetsWithTimestamps", () => kafkaFixture("offsets-timestamp")),
    close: record("consumer.close", () => undefined),
  };
  const connection = {
    connect: record("connection.connect", () => undefined),
    close: record("connection.close", () => undefined),
  };
  const pool = {
    get: record("pool.get", (broker) => ({ broker })),
    close: record("pool.close", () => undefined),
  };
  const lib: PlatformaticLib = {
    Admin: class {
      constructor(o: object) {
        constructed.push(["Admin", o]);
        return admin;
      }
    } as never,
    Consumer: class {
      constructor(o: object) {
        constructed.push(["Consumer", o]);
        return consumer;
      }
    } as never,
    Connection: class {
      constructor(id: string, o: object) {
        constructed.push(["Connection", { id, ...o }]);
        return connection;
      }
    } as never,
    ConnectionPool: class {
      constructor(id: string, o: object) {
        constructed.push(["ConnectionPool", { id, ...o }]);
        return pool;
      }
    } as never,
    consumerGroupDescribeV0: {
      api: { async: record("consumerGroupDescribeV0", () => kafkaFixture("consumer-group-describe")) as never },
    },
    fetchV13: {
      api: { async: record("fetchV13", () => kafkaFixture("fetch-orders-p1-o5")) as never },
    },
  };
  return { lib, constructed, calls };
}
