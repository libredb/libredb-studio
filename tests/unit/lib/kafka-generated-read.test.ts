import { describe, expect, test } from "bun:test";
import type { KafkaRecord, KafkaTopicMetadata } from "@/lib/db/providers/stream/kafka/client";
import { type ReadClient, readMessages } from "@/lib/db/providers/stream/kafka/read";
import { parseReadRequest } from "@/lib/db/providers/stream/kafka/request";
import type { ProviderCapabilities } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { generateSelectQuery, generateTableQuery } from "@/lib/query-generators";

/**
 * The texts the tree writes for a topic, sent through the provider's own parser and read loop, so
 * "runs as is" is a test and not a claim (#1088, section 6.4). The editor sends the whole buffer as
 * one read request, and the provider parses it with `DEFAULT_QUERY_LIMIT` as its maximum.
 */
describe("the tree's read requests run as is on the provider's read path, on any retention", () => {
  const caps = { queryLanguage: "json", queryDialect: "kafka" } as ProviderCapabilities;
  const LIMITS = { resultByteBudget: 1024 * 1024, cellLimit: 1024 };
  const TOPIC: KafkaTopicMetadata = {
    name: "orders",
    id: "t",
    partitions: [{ partition: 0, leader: 1, leaderEpoch: 0, replicas: [1], isr: [1], offlineReplicas: [] }],
  };
  // Partition 0 of `orders` holding one record per offset from `earliest` up to `end`, at most ten a
  // fetch, as a broker answers a bounded fetch.
  const retained = (earliest: number, end: number): ReadClient => ({
    metadata: async () => ({ clusterId: "c", controllerId: 1, brokers: [], topics: [TOPIC] }),
    offsets: async (_topic, at) => new Map([[0, BigInt(at === "earliest" ? earliest : end)]]),
    offsetsForTimestamp: async () => new Map(),
    fetch: async (_topic, partition, offset) => {
      const records: KafkaRecord[] = [];
      for (let o = Number(offset); o < end && records.length < 10; o++) {
        records.push({ partition, offset: BigInt(o), timestamp: BigInt(o), key: null, value: null, headers: [] });
      }
      return { records, nextOffset: offset + BigInt(records.length) };
    },
  });
  const run = (text: string, client: ReadClient) =>
    readMessages(client, parseReadRequest(text, DEFAULT_QUERY_LIMIT), LIMITS, AbortSignal.timeout(5000));

  test("Generate Read Request on a partition whose earliest offset retention moved to 1200 reads from 1200", async () => {
    const out = await run(generateSelectQuery(["orders"], [], caps), retained(1200, 1500));
    expect(out.rows).toHaveLength(50);
    expect(out.rows.map((row) => row.offset)).toEqual(Array.from({ length: 50 }, (_, i) => String(1200 + i)));
    expect(out.warnings).toEqual([]);
  });

  test("Generate Read Request on an empty partition answers no rows and no error", async () => {
    const out = await run(generateSelectQuery(["orders"], [], caps), retained(1500, 1500));
    expect(out.rows).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test("the tree click reads the latest 50 messages there, the last 50 offsets below the end", async () => {
    const out = await run(generateTableQuery(["orders"], caps), retained(1200, 1500));
    expect(out.rows.map((row) => row.offset)).toEqual(Array.from({ length: 50 }, (_, i) => String(1450 + i)));
  });

  test("the offset-0 form Generate Read Request replaced is refused there, which is why its form is earliest", async () => {
    const offsetZero = JSON.stringify({ topic: "orders", partition: 0, from: { offset: 0 }, limit: 50 });
    await expect(run(offsetZero, retained(1200, 1500))).rejects.toMatchObject({
      category: "offset-out-of-range",
      detail: { validRange: { earliest: BigInt(1200), latest: BigInt(1500) } },
    });
  });
});
