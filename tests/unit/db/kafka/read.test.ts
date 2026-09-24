import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  type KafkaFetchResult,
  KafkaError,
  type KafkaRecord,
  type KafkaTopicMetadata,
} from "@/lib/db/providers/stream/kafka/client";
import {
  type ReadClient,
  type ReadLimits,
  readMessages,
  readWarnings,
  startOffset,
} from "@/lib/db/providers/stream/kafka/read";
import type { ReadRequest, ReadStart } from "@/lib/db/providers/stream/kafka/request";
import { compareRecords, shapeRecord } from "@/lib/db/providers/stream/kafka/results";

const enc = (s: string) => new TextEncoder().encode(s);
const n = (value: number) => BigInt(value);
const LIMITS = { resultByteBudget: 1_000_000, cellLimit: 1000 };
const signal = new AbortController().signal;

/**
 * A fake log: partition -> records, offsets dense from 0 unless given. `perFetch` is how
 * many records one fetch answers, from the requested offset.
 */
function fakeClient(
  log: Record<number, KafkaRecord[]>,
  over: Partial<ReadClient> = {},
  leaders?: Record<number, number>,
  perFetch = 2,
) {
  const calls: Array<[number, bigint]> = [];
  const offsetCalls: string[] = [];
  const topic: KafkaTopicMetadata = {
    name: "orders",
    id: "id-1",
    partitions: Object.keys(log).map((p) => ({
      partition: Number(p),
      leader: leaders?.[Number(p)] ?? 1,
      leaderEpoch: 0,
      replicas: [1],
      isr: [1],
      offlineReplicas: [],
    })),
  };
  const client: ReadClient = {
    metadata: async () => ({ clusterId: "c", controllerId: 1, brokers: [], topics: [topic] }),
    offsets: async (_t, at) => {
      offsetCalls.push(at);
      return new Map(
        Object.entries(log).map(([p, records]) => [
          Number(p),
          at === "earliest" ? (records[0]?.offset ?? n(0)) : (records.at(-1)?.offset ?? n(-1)) + n(1),
        ]),
      );
    },
    offsetsForTimestamp: async (_t, ts) =>
      new Map(
        Object.entries(log).map(([p, records]) => [Number(p), records.find((r) => r.timestamp >= ts)?.offset ?? n(-1)]),
      ),
    fetch: async (_t, partition, offset) => {
      calls.push([partition, offset]);
      const records = log[partition].filter((r) => r.offset >= offset).slice(0, perFetch);
      return { records, nextOffset: records.length === 0 ? offset : records.at(-1)!.offset + n(1) };
    },
    ...over,
  };
  return { client, calls, offsetCalls };
}
const rec = (partition: number, offset: number, timestamp: number, value = "v"): KafkaRecord => ({
  partition,
  offset: n(offset),
  timestamp: n(timestamp),
  key: null,
  value: enc(value),
  headers: [],
});
const req = (over: Partial<ReadRequest>): ReadRequest => ({
  topic: "orders",
  from: { kind: "latest" },
  limit: 50,
  ...over,
});

/** The KafkaError a call throws; anything else, or nothing at all, fails the test. */
function thrown(run: () => unknown): KafkaError {
  try {
    run();
  } catch (error) {
    if (error instanceof KafkaError) return error;
    throw error;
  }
  throw new Error("expected a KafkaError, and nothing was thrown");
}

describe("readMessages", () => {
  const log = {
    0: [rec(0, 0, 10), rec(0, 1, 30), rec(0, 2, 50)],
    1: [rec(1, 0, 20), rec(1, 1, 40)],
  };

  test("earliest across partitions, ordered by timestamp, cut at the limit", async () => {
    const { client } = fakeClient(log);
    const out = await readMessages(client, req({ from: { kind: "earliest" }, limit: 3 }), LIMITS, signal);
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "1/0", "0/1"]);
  });

  test("latest is the last limit messages overall, still in timestamp order, ending at the last stable offset", async () => {
    const { client, offsetCalls } = fakeClient(log);
    const out = await readMessages(client, req({ from: { kind: "latest" }, limit: 2 }), LIMITS, signal);
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["1/1", "0/2"]);
    expect(offsetCalls).toEqual(["earliest", "latest"]);
  });

  test("the rows the merge leaves out of the limit mark the read limited, for earliest and for latest", async () => {
    // Each partition holds exactly the limit, so both reads take each partition to its end
    // and no partition is cut: only the merge leaves rows out, in either read.
    const { client } = fakeClient({ 0: [rec(0, 0, 10), rec(0, 1, 30)], 1: [rec(1, 0, 20), rec(1, 1, 40)] });
    const reads = await Promise.all([
      readMessages(client, req({ from: { kind: "earliest" }, limit: 2 }), LIMITS, signal),
      readMessages(client, req({ from: { kind: "latest" }, limit: 2 }), LIMITS, signal),
    ]);
    expect(reads.map((out) => out.rows.map((r) => `${r.partition}/${r.offset}`))).toEqual([
      ["0/0", "1/0"],
      ["0/1", "1/1"],
    ]);
    expect(reads.map((out) => out.wasLimited)).toEqual([true, true]);
    expect(reads.map((out) => out.warnings)).toEqual([[], []]);
  });

  test("a row the merge drops marks the read limited, whether it left the rows held or never came in", async () => {
    // Partition 0 is the older and then the newer: in each read partition 1's records either never come in,
    // or push partition 0's rows out, and never both.
    const older = fakeClient({ 0: [rec(0, 0, 10), rec(0, 1, 20)], 1: [rec(1, 0, 30), rec(1, 1, 40)] });
    const newer = fakeClient({ 0: [rec(0, 0, 30), rec(0, 1, 40)], 1: [rec(1, 0, 10), rec(1, 1, 20)] });
    const reads = await Promise.all(
      [older, newer].flatMap(({ client }) => [
        readMessages(client, req({ from: { kind: "earliest" }, limit: 2 }), LIMITS, signal),
        readMessages(client, req({ from: { kind: "latest" }, limit: 2 }), LIMITS, signal),
      ]),
    );
    expect(reads.map((out) => out.rows.map((r) => `${r.partition}/${r.offset}`))).toEqual([
      ["0/0", "0/1"], // older, earliest: partition 1's records never come in
      ["1/0", "1/1"], // older, latest: they push partition 0's rows out
      ["1/0", "1/1"], // newer, earliest: they push partition 0's rows out
      ["0/0", "0/1"], // newer, latest: they never come in
    ]);
    expect(reads.map((out) => out.wasLimited)).toEqual([true, true, true, true]);
    expect(reads.map((out) => out.warnings)).toEqual([[], [], [], []]);
  });

  test("a record the merge drops as it arrives is never shaped, so a timestamp no date can show refuses nothing", async () => {
    const unshowable: KafkaRecord = { ...rec(1, 0, 0), timestamp: BigInt("8640000000000001") };
    const { client } = fakeClient({ 0: [rec(0, 0, 10)], 1: [unshowable] });
    // The first message overall is partition 0's; partition 1's sorts after it and never comes in.
    const first = await readMessages(client, req({ from: { kind: "earliest" }, limit: 1 }), LIMITS, signal);
    expect(first.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0"]);
    // Control: the newest message overall is partition 1's, which the result holds, so the read is refused naming it.
    const error = await readMessages(client, req({ from: { kind: "latest" }, limit: 1 }), LIMITS, signal).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toContain("The record at partition 1, offset 0 has timestamp 8640000000000001");
  });

  test("an offset on one partition", async () => {
    const { client, calls } = fakeClient(log);
    const out = await readMessages(
      client,
      req({ partition: 0, from: { kind: "offset", offset: n(1) }, limit: 5 }),
      LIMITS,
      signal,
    );
    expect(out.rows.map((r) => r.offset)).toEqual(["1", "2"]);
    expect(calls.every(([p]) => p === 0)).toBe(true);
  });

  test("an offset outside the log is offset-out-of-range carrying the valid range", async () => {
    const { client } = fakeClient(log);
    const error = await readMessages(
      client,
      req({ partition: 1, from: { kind: "offset", offset: n(9) } }),
      LIMITS,
      signal,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("offset-out-of-range");
    expect(error.detail.validRange).toEqual({ earliest: n(0), latest: n(2) });
  });

  test("a partition that does not exist is refused", async () => {
    const { client } = fakeClient(log);
    const error = await readMessages(client, req({ partition: 7 }), LIMITS, signal).catch((e) => e);
    expect(error.category).toBe("invalid-request");
    expect(error.message).toContain("partitions 0 to 1");
  });

  test("a partition asked of a topic the metadata lists with no partitions is refused in words, never 0 to -1", async () => {
    const { client, offsetCalls } = fakeClient({});
    const error = await readMessages(client, req({ partition: 0 }), LIMITS, signal).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("invalid-request");
    expect(error.message).toBe('Topic "orders" has no partitions; partition 0 does not exist');
    expect(offsetCalls).toEqual([]);
  });

  test("a topic the metadata does not name is unknown-topic", async () => {
    const { client } = fakeClient(log, {
      metadata: async () => ({ clusterId: "c", controllerId: 1, brokers: [], topics: [] }),
    });
    expect((await readMessages(client, req({}), LIMITS, signal).catch((e) => e)).category).toBe("unknown-topic");
  });

  test("a metadata answer that names only another topic is unknown-topic, never read as the one asked for", async () => {
    const { client, calls } = fakeClient(log, {
      metadata: async () => ({
        clusterId: "c",
        controllerId: 1,
        brokers: [],
        topics: [{ name: "payments", id: "id-2", partitions: [] }],
      }),
    });
    const error = await readMessages(client, req({}), LIMITS, signal).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("unknown-topic");
    expect(error.message).toBe('Topic "orders" does not exist');
    expect(calls).toEqual([]);
  });

  test("a timestamp past the log end on a partition contributes nothing and is warned about", async () => {
    const { client } = fakeClient(log);
    const out = await readMessages(
      client,
      req({ from: { kind: "timestamp", timestampMs: n(45), iso: "x" } }),
      LIMITS,
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/2"]);
    expect(out.warnings.map((w) => w.message).join()).toContain("partition 1");
  });

  test("a timestamp read answers the first limit messages at or after the instant, across partitions", async () => {
    const { client } = fakeClient(log);
    // At or after 25: partition 0 from offset 1 (30 and 50), and partition 1 from offset 1 (40).
    const out = await readMessages(
      client,
      req({ from: { kind: "timestamp", timestampMs: n(25), iso: "x" }, limit: 2 }),
      LIMITS,
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/1", "1/1"]);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  test("the result byte budget stops the loop and sets wasLimited with a warning", async () => {
    const big = { 0: [rec(0, 0, 1, "a".repeat(600)), rec(0, 1, 2, "b".repeat(600)), rec(0, 2, 3, "c".repeat(600))] };
    const { client } = fakeClient(big);
    // 600 bytes per record: two fit in 1300, the third would reach 1800.
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1300, cellLimit: 1000 },
      signal,
    );
    expect(out.rows.length).toBe(2);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings.map((w) => w.message).join()).toContain("budget");
  });

  test("the budget stops the whole read: no later record, no later partition, and no fetch after the one that hit it", async () => {
    // One record a fetch. Partition 0 holds 600, 600, 600 and 10 bytes, and partition 1 one record of 10:
    // a budget of 1,300 holds the first two, offset 2 would pass it, and offset 3 or partition 1 would still fit.
    const log = {
      0: [
        rec(0, 0, 1, "a".repeat(600)),
        rec(0, 1, 2, "b".repeat(600)),
        rec(0, 2, 3, "c".repeat(600)),
        rec(0, 3, 4, "d".repeat(10)),
      ],
      1: [rec(1, 0, 5, "e".repeat(10))],
    };
    const { client, calls } = fakeClient(log, {}, undefined, 1);
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1300, cellLimit: 1000 },
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "0/1"]);
    expect(calls).toEqual([
      [0, n(0)],
      [0, n(1)],
      [0, n(2)],
    ]);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 2 of partition 0, at the result budget of 1,300 bytes of record data, and did not read partition 1; narrow it with a partition, an offset or a smaller limit",
    ]);
  });

  test("the budget stops inside one fetch: no record after the one that would pass it, even one that would fit", async () => {
    // One fetch answers all four records: 600, 600, 600 and 10 bytes, under a budget of 1,300.
    const { client, calls } = fakeClient(
      {
        0: [
          rec(0, 0, 1, "a".repeat(600)),
          rec(0, 1, 2, "b".repeat(600)),
          rec(0, 2, 3, "c".repeat(600)),
          rec(0, 3, 4, "d".repeat(10)),
        ],
      },
      {},
      undefined,
      100,
    );
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1300, cellLimit: 1000 },
      signal,
    );
    expect(out.rows.map((r) => r.offset)).toEqual(["0", "1"]);
    expect(calls).toEqual([[0, n(0)]]);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 2 of partition 0, at the result budget of 1,300 bytes of record data; narrow it with a partition, an offset or a smaller limit",
    ]);
  });

  test("only the read's first record is held past the budget, never each partition's first", async () => {
    const { client } = fakeClient({ 0: [rec(0, 0, 1, "a".repeat(600))], 1: [rec(1, 0, 2, "b".repeat(900))] });
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1000, cellLimit: 1000 },
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0"]);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 0 of partition 1, at the result budget of 1,000 bytes of record data; narrow it with a partition, an offset or a smaller limit",
    ]);
  });

  test("the budget counts the rows the result holds, never one the merge dropped: partitions that together pass it are all read", async () => {
    // Three partitions of offsets 0 to 9, 120 bytes each, timestamps in offset order across partitions.
    // A budget of 650 holds five rows (600 bytes) and not six, and each read below takes fifteen records.
    const three = Object.fromEntries(
      [0, 1, 2].map((p) => [p, Array.from({ length: 10 }, (_, o) => rec(p, o, o * 10 + p, "x".repeat(120)))]),
    );
    const { client, calls } = fakeClient(three);
    const limits = { resultByteBudget: 650, cellLimit: 1000 };
    const latest = await readMessages(client, req({ from: { kind: "latest" }, limit: 5 }), limits, signal);
    expect(latest.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["1/8", "2/8", "0/9", "1/9", "2/9"]);
    expect(calls.map(([p, o]) => `${p}@${o}`)).toEqual(["0@5", "0@7", "0@9", "1@5", "1@7", "1@9", "2@5", "2@7", "2@9"]);
    calls.length = 0;
    const earliest = await readMessages(client, req({ from: { kind: "earliest" }, limit: 5 }), limits, signal);
    expect(earliest.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "1/0", "2/0", "0/1", "1/1"]);
    expect(calls.map(([p, o]) => `${p}@${o}`)).toEqual(["0@0", "0@2", "0@4", "1@0", "1@2", "1@4", "2@0", "2@2", "2@4"]);
    // Nothing was cut at the budget; the rows the merge dropped still mark both reads limited.
    expect([latest.warnings, earliest.warnings]).toEqual([[], []]);
    expect([latest.wasLimited, earliest.wasLimited]).toEqual([true, true]);
    // Control: with room for every record, the reads answer the same rows.
    const roomy = await Promise.all([
      readMessages(client, req({ from: { kind: "latest" }, limit: 5 }), LIMITS, signal),
      readMessages(client, req({ from: { kind: "earliest" }, limit: 5 }), LIMITS, signal),
    ]);
    expect(roomy.map((out) => out.rows)).toEqual([latest.rows, earliest.rows]);
  });

  test("a row that falls out of the rows held gives back its own bytes and no more, so the budget still stops the next record that passes it", async () => {
    // Earliest, limit 1: each partition's one record is older than the one before, so it takes that one's place.
    // 50, 50 and 60 bytes under a budget of 55: the second fits in the first's place, and the third would hold 60.
    const { client } = fakeClient({
      0: [rec(0, 0, 20, "a".repeat(50))],
      1: [rec(1, 0, 10, "b".repeat(50))],
      2: [rec(2, 0, 5, "c".repeat(60))],
    });
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" }, limit: 1 }),
      { resultByteBudget: 55, cellLimit: 1000 },
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["1/0"]);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 0 of partition 2, at the result budget of 55 bytes of record data; narrow it with a partition, an offset or a smaller limit",
    ]);
  });

  test("a latest read the budget stops in the first partition it reads holds the oldest rows of that partition's window, and says where it stopped (the stated limit)", async () => {
    const three = Object.fromEntries(
      [0, 1, 2].map((p) => [p, Array.from({ length: 10 }, (_, o) => rec(p, o, o * 10 + p, "x".repeat(120)))]),
    );
    const { client, calls } = fakeClient(three);
    // 250 bytes hold two rows: partition 0's window, 5 to 9, stops before offset 7, and partitions 1 and 2 are never read.
    const out = await readMessages(
      client,
      req({ from: { kind: "latest" }, limit: 5 }),
      { resultByteBudget: 250, cellLimit: 1000 },
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/5", "0/6"]);
    expect(calls.map(([p, o]) => `${p}@${o}`)).toEqual(["0@5", "0@7"]);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 7 of partition 0, at the result budget of 250 bytes of record data, and did not read partition 1, 2; narrow it with a partition, an offset or a smaller limit",
    ]);
  });

  test("a latest read the budget stops in a later partition answers what it held, not the newest rows of the topic (the stated limit)", async () => {
    // Two partitions of offsets 0 to 9 with interleaved timestamps: partition 0's records are 120 bytes, partition 1's 200.
    const two = Object.fromEntries(
      [0, 1].map((p) => [
        p,
        Array.from({ length: 10 }, (_, o) => rec(p, o, o * 10 + p * 5, "x".repeat(p === 0 ? 120 : 200))),
      ]),
    );
    const { client, calls } = fakeClient(two);
    const out = await readMessages(
      client,
      req({ from: { kind: "latest" }, limit: 5 }),
      { resultByteBudget: 650, cellLimit: 1000 },
      signal,
    );
    // Partition 0's whole window is held, 600 bytes. Partition 1's first record would take the place of
    // 0/5 and bring the rows held to 680, past 650, so the read stops there.
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/5", "0/6", "0/7", "0/8", "0/9"]);
    expect(calls.map(([p, o]) => `${p}@${o}`)).toEqual(["0@5", "0@7", "0@9", "1@5"]);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 5 of partition 1, at the result budget of 650 bytes of record data; narrow it with a partition, an offset or a smaller limit",
    ]);
    // Control: the newest five messages of the topic, which an unbounded read answers, are mostly partition 1's.
    const roomy = await readMessages(client, req({ from: { kind: "latest" }, limit: 5 }), LIMITS, signal);
    expect(roomy.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["1/7", "0/8", "1/8", "0/9", "1/9"]);
  });

  test("a latest read can be stopped although the rows an unbounded read answers would fit: the rows it held early would have been displaced by rows it never read (the stated limit)", async () => {
    // Partition 0, read first, holds five old 200-byte records; partition 1 five newer 10-byte ones.
    const { client, calls } = fakeClient({
      0: Array.from({ length: 5 }, (_, o) => rec(0, o, o, "b".repeat(200))),
      1: Array.from({ length: 5 }, (_, o) => rec(1, o, 100 + o, "s".repeat(10))),
    });
    const out = await readMessages(
      client,
      req({ from: { kind: "latest" }, limit: 5 }),
      { resultByteBudget: 650, cellLimit: 1000 },
      signal,
    );
    // Three of partition 0's rows fill 600 of the 650 bytes, and the fourth stops the read.
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "0/1", "0/2"]);
    expect(calls.map(([p, o]) => `${p}@${o}`)).toEqual(["0@0", "0@2"]);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 3 of partition 0, at the result budget of 650 bytes of record data, and did not read partition 1; narrow it with a partition, an offset or a smaller limit",
    ]);
    // Control: the unbounded read answers partition 1's five rows, 50 bytes, which the budget would have held.
    const roomy = await readMessages(client, req({ from: { kind: "latest" }, limit: 5 }), LIMITS, signal);
    expect(roomy.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["1/0", "1/1", "1/2", "1/3", "1/4"]);
    expect(roomy.rows.reduce((sum, r) => sum + String(r.value).length, 0)).toBe(50);
  });

  test("the budget warning names only the later partitions with offsets to read, never one whose start is its end", async () => {
    // Partitions 1 and 3 are empty (their earliest offset is their end), and partition 2 holds one record.
    const sparse = {
      0: [rec(0, 0, 1, "a".repeat(600)), rec(0, 1, 2, "b".repeat(600)), rec(0, 2, 3, "c".repeat(600))],
      1: [],
      2: [rec(2, 0, 4, "d".repeat(10))],
      3: [],
    };
    const { client, calls } = fakeClient(sparse, {}, undefined, 1);
    const tight = { resultByteBudget: 1300, cellLimit: 1000 };
    const warning =
      "The read stopped before offset 2 of partition 0, at the result budget of 1,300 bytes of record data, and did not read partition 2; narrow it with a partition, an offset or a smaller limit";
    const earliest = await readMessages(client, req({ from: { kind: "earliest" } }), tight, signal);
    expect(earliest.warnings.map((w) => w.message)).toEqual([warning]);
    const latest = await readMessages(client, req({ from: { kind: "latest" } }), tight, signal);
    expect(latest.warnings.map((w) => w.message)).toEqual([warning]);
    // Control: with room for every record, the empty partitions are never fetched either.
    calls.length = 0;
    const whole = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal);
    expect(whole.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "0/1", "0/2", "2/0"]);
    expect(calls.map(([p]) => p)).toEqual([0, 0, 0, 2]);
    expect(whole.warnings).toEqual([]);
  });

  test("a later partition whose offsets hold no record is still named as unread: only reading it could tell", async () => {
    // Partition 1's two offsets are transaction markers: a fetch there answers no record and moves past them.
    const base = fakeClient(
      { 0: [rec(0, 0, 1, "a".repeat(600)), rec(0, 1, 2, "b".repeat(600)), rec(0, 2, 3, "c".repeat(600))], 1: [] },
      {
        offsets: async (_t, at) =>
          new Map([
            [0, at === "earliest" ? n(0) : n(3)],
            [1, at === "earliest" ? n(0) : n(2)],
          ]),
      },
      undefined,
      1,
    );
    const fetched: number[] = [];
    const client: ReadClient = {
      ...base.client,
      fetch: async (topic, partition, offset, fetchSignal) => {
        fetched.push(partition);
        return partition === 1
          ? { records: [], nextOffset: n(2) }
          : base.client.fetch(topic, partition, offset, fetchSignal);
      },
    };
    const tight = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1300, cellLimit: 1000 },
      signal,
    );
    expect(tight.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 2 of partition 0, at the result budget of 1,300 bytes of record data, and did not read partition 1; narrow it with a partition, an offset or a smaller limit",
    ]);
    expect(fetched).toEqual([0, 0, 0]);
    // Control: read whole, partition 1 is fetched once and answers no row and no warning.
    fetched.length = 0;
    const whole = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal);
    expect(whole.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "0/1", "0/2"]);
    expect(fetched).toEqual([0, 0, 0, 1]);
    expect(whole.warnings).toEqual([]);
  });

  test("the budget counts record bytes, not the cut cell: a record larger than the budget is still one row", async () => {
    const huge = { 0: [rec(0, 0, 1, "h".repeat(5000)), rec(0, 1, 2, "i".repeat(5000))] };
    const { client } = fakeClient(huge);
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 100, cellLimit: 10 },
      signal,
    );
    expect(out.rows.map((r) => r.offset)).toEqual(["0"]);
    expect(out.rows[0].value).toBe("h".repeat(10));
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 1 of partition 0, at the result budget of 100 bytes of record data; narrow it with a partition, an offset or a smaller limit",
      "1 cell(s) were cut at 10 characters",
    ]);
  });

  test("the budget counts keys and header names and values, not only the value", async () => {
    const withHeaders = (offset: number): KafkaRecord => ({
      ...rec(0, offset, offset + 1, "v".repeat(10)),
      key: enc("k".repeat(10)),
      headers: [
        [enc("h".repeat(10)), enc("x".repeat(10))],
        [enc("n".repeat(10)), null],
      ],
    });
    const { client } = fakeClient({ 0: [withHeaders(0), withHeaders(1)] });
    // 50 bytes a record: a budget of 99 holds one, and 100 holds both.
    const tight = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 99, cellLimit: 1000 },
      signal,
    );
    expect(tight.rows.map((r) => r.offset)).toEqual(["0"]);
    const exact = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 100, cellLimit: 1000 },
      signal,
    );
    expect(exact.rows.map((r) => r.offset)).toEqual(["0", "1"]);
    expect(exact.wasLimited).toBe(false);
  });

  test("a tombstone's missing value and a keyless record's missing key count no bytes, and a tombstone is a row", async () => {
    // Two tombstones of a compacted topic (a 10-byte key, no value) and one keyless record (a 10-byte value).
    const tombstone = (offset: number): KafkaRecord => ({
      ...rec(0, offset, offset + 1),
      key: enc("k".repeat(10)),
      value: null,
    });
    const { client } = fakeClient({ 0: [tombstone(0), tombstone(1), rec(0, 2, 3, "v".repeat(10))] });
    // 10 bytes a record: a budget of 30 holds all three, and 29 only the two tombstones.
    const fits = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 30, cellLimit: 100 },
      signal,
    );
    expect(fits.rows.map((r) => [r.offset, r.key, r.value, r.value_encoding])).toEqual([
      ["0", "k".repeat(10), null, "null"],
      ["1", "k".repeat(10), null, "null"],
      ["2", null, "v".repeat(10), "text"],
    ]);
    expect(fits.wasLimited).toBe(false);
    expect(fits.warnings).toEqual([]);
    const tight = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 29, cellLimit: 100 },
      signal,
    );
    expect(tight.rows.map((r) => r.offset)).toEqual(["0", "1"]);
    expect(tight.warnings.map((w) => w.message)).toEqual([
      "The read stopped before offset 2 of partition 0, at the result budget of 29 bytes of record data; narrow it with a partition, an offset or a smaller limit",
    ]);
  });

  test("a header with no name counts only its value, and one with no value only its name", async () => {
    const { client } = fakeClient({
      0: [
        { ...rec(0, 0, 1, "v".repeat(10)), headers: [[null, enc("x".repeat(10))]] },
        { ...rec(0, 1, 2, "w".repeat(10)), headers: [[enc("h".repeat(10)), null]] },
      ],
    });
    // 20 bytes a record: a budget of 40 holds both, and 39 only the first.
    const fits = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 40, cellLimit: 100 },
      signal,
    );
    expect(fits.rows.map((r) => [r.offset, r.headers])).toEqual([
      ["0", { null: "x".repeat(10) }],
      ["1", { ["h".repeat(10)]: null }],
    ]);
    expect(fits.wasLimited).toBe(false);
    const tight = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 39, cellLimit: 100 },
      signal,
    );
    expect(tight.rows.map((r) => r.offset)).toEqual(["0"]);
    expect(tight.wasLimited).toBe(true);
  });

  test("a truncated cell is warned about", async () => {
    const { client } = fakeClient({ 0: [rec(0, 0, 1, "x".repeat(50))] });
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1e6, cellLimit: 10 },
      signal,
    );
    expect(out.warnings.map((w) => w.message).join()).toContain("10 characters");
    expect(out.wasLimited).toBe(true);
  });

  test("the cell warning counts every cut cell of a row: a key and a value cut in one record are two", async () => {
    const { client } = fakeClient({ 0: [{ ...rec(0, 0, 1, "v".repeat(50)), key: enc("k".repeat(50)) }] });
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1e6, cellLimit: 10 },
      signal,
    );
    expect(out.warnings.map((w) => w.message)).toEqual(["2 cell(s) were cut at 10 characters"]);
  });

  test("the cell warning counts the rows the result returns, never a cut cell in a row the merge left out", async () => {
    // Partition 0's one record is the older and is cut at 10 characters; partition 1's is the newer and whole.
    const { client } = fakeClient({ 0: [rec(0, 0, 10, "x".repeat(50))], 1: [rec(1, 0, 20, "y")] });
    const limits = { resultByteBudget: 1e6, cellLimit: 10 };
    const newest = await readMessages(client, req({ from: { kind: "latest" }, limit: 1 }), limits, signal);
    expect(newest.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["1/0"]);
    expect(newest.warnings).toEqual([]);
    // Control: when the cut row is returned, its cell is warned about.
    const both = await readMessages(client, req({ from: { kind: "latest" }, limit: 2 }), limits, signal);
    expect(both.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "1/0"]);
    expect(both.warnings.map((w) => w.message)).toEqual(["1 cell(s) were cut at 10 characters"]);
  });

  test("the cell warning sums the cut cells of every row the result returns, across partitions", async () => {
    // Partition 0's two records cut one cell each, and partition 1's one record two: its key and its value.
    const { client } = fakeClient({
      0: [rec(0, 0, 1, "x".repeat(50)), rec(0, 1, 2, "y".repeat(50))],
      1: [{ ...rec(1, 0, 3, "z".repeat(50)), key: enc("k".repeat(50)) }],
    });
    const out = await readMessages(
      client,
      req({ from: { kind: "earliest" } }),
      { resultByteBudget: 1e6, cellLimit: 10 },
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "0/1", "1/0"]);
    expect(out.warnings.map((w) => w.message)).toEqual(["4 cell(s) were cut at 10 characters"]);
  });

  test("hitting the row limit before the log end sets wasLimited", async () => {
    const { client } = fakeClient(log);
    expect((await readMessages(client, req({ from: { kind: "earliest" }, limit: 1 }), LIMITS, signal)).wasLimited).toBe(
      true,
    );
    expect(
      (await readMessages(client, req({ from: { kind: "earliest" }, limit: 50 }), LIMITS, signal)).wasLimited,
    ).toBe(false);
  });

  test("the row limit stops a partition's fetches once it has read limit records", async () => {
    const { client, calls } = fakeClient(
      { 0: Array.from({ length: 5 }, (_, i) => rec(0, i, i + 1)) },
      {},
      undefined,
      1,
    );
    const out = await readMessages(client, req({ from: { kind: "earliest" }, limit: 2 }), LIMITS, signal);
    expect(out.rows.map((r) => r.offset)).toEqual(["0", "1"]);
    expect(calls).toEqual([
      [0, n(0)],
      [0, n(1)],
    ]);
    expect(out.wasLimited).toBe(true);
  });

  test("the row limit takes each partition's first limit records in log order, however many one fetch answers", async () => {
    // Offsets 2 to 4 carry timestamps older than offsets 0 and 1: a producer's CreateTime need not follow the log.
    const outOfOrder = { 0: [rec(0, 0, 50), rec(0, 1, 60), rec(0, 2, 10), rec(0, 3, 20), rec(0, 4, 30)] };
    const oneAFetch = fakeClient(outOfOrder, {}, undefined, 1);
    const allAtOnce = fakeClient(outOfOrder, {}, undefined, 100);
    const reads = await Promise.all(
      [oneAFetch, allAtOnce].map(({ client }) =>
        readMessages(client, req({ from: { kind: "earliest" }, limit: 2 }), LIMITS, signal),
      ),
    );
    expect(reads.map((out) => out.rows.map((r) => r.offset))).toEqual([
      ["0", "1"],
      ["0", "1"],
    ]);
    expect(reads.map((out) => out.wasLimited)).toEqual([true, true]);
    expect(allAtOnce.calls).toEqual([[0, n(0)]]);
  });

  test("a fetch that answers the whole partition at once still marks the rows it left unread", async () => {
    const whole = { 0: Array.from({ length: 12 }, (_, i) => rec(0, i, i + 1)) };
    const { client } = fakeClient(whole, {}, undefined, 100);
    const cut = await readMessages(
      client,
      req({ partition: 0, from: { kind: "offset", offset: n(5) }, limit: 2 }),
      LIMITS,
      signal,
    );
    expect(cut.rows.map((r) => r.offset)).toEqual(["5", "6"]);
    expect(cut.wasLimited).toBe(true);
    const all = await readMessages(
      client,
      req({ partition: 0, from: { kind: "earliest" }, limit: 12 }),
      LIMITS,
      signal,
    );
    expect(all.wasLimited).toBe(false);
  });

  test("the limit landing on a fetch boundary before the end is a cut too", async () => {
    const { client } = fakeClient({ 0: [rec(0, 0, 1), rec(0, 1, 2), rec(0, 2, 3)] });
    expect(
      (await readMessages(client, req({ partition: 0, from: { kind: "earliest" }, limit: 2 }), LIMITS, signal))
        .wasLimited,
    ).toBe(true);
  });

  test("a record a fetch answers at or past the end the read planned is never a row and never a cut", async () => {
    // Offsets 3 and 4 arrived after the latest offset, 3, was read, and one fetch answers all five.
    const base = fakeClient(
      { 0: Array.from({ length: 5 }, (_, i) => rec(0, i, i + 1)) },
      { offsets: async (_t, at) => new Map([[0, at === "earliest" ? n(0) : n(3)]]) },
      undefined,
      100,
    );
    const answered: string[][] = [];
    const client: ReadClient = {
      ...base.client,
      fetch: async (topic, partition, offset, fetchSignal) => {
        const answer = await base.client.fetch(topic, partition, offset, fetchSignal);
        answered.push(answer.records.map((r) => String(r.offset)));
        return answer;
      },
    };
    const earliest = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal);
    expect(earliest.rows.map((r) => r.offset)).toEqual(["0", "1", "2"]);
    expect(earliest.wasLimited).toBe(false);
    // A latest read of limit 3 reads its whole window, 0 to 2: nothing below the end is left unread.
    const latest = await readMessages(client, req({ from: { kind: "latest" }, limit: 3 }), LIMITS, signal);
    expect(latest.rows.map((r) => r.offset)).toEqual(["0", "1", "2"]);
    expect(latest.wasLimited).toBe(false);
    expect(latest.warnings).toEqual([]);
    // Control: each read's one fetch did answer the two records past the end.
    expect(answered).toEqual([
      ["0", "1", "2", "3", "4"],
      ["0", "1", "2", "3", "4"],
    ]);
  });

  test("Review Focus 1: a topic with a leaderless partition is refused naming the partition, and nothing is read", async () => {
    const { client, calls, offsetCalls } = fakeClient(log, {}, { 1: -1 });
    const error = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("unreadable-topic");
    expect(error.message).toContain("partition 1");
    expect(calls).toEqual([]);
    expect(offsetCalls).toEqual([]);
  });

  test("a partition led by broker 0 has a leader: node 0 is a broker id, only -1 means none", async () => {
    // Redpanda's single broker is node 0 (spec 8).
    const { client } = fakeClient(log, {}, { 0: 0, 1: 0 });
    const out = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal);
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "1/0", "0/1", "1/1", "0/2"]);
  });

  test("a partition an offsets answer leaves out is refused by name, never read from an invented offset 0", async () => {
    // The earliest answer leaves out partition 1, and the latest answer leaves out partition 0.
    const { client, calls } = fakeClient(log, {
      offsets: async (_t, at) => new Map<number, bigint>(at === "earliest" ? [[0, n(0)]] : [[1, n(2)]]),
    });
    const whole = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal).catch((e) => e);
    expect(whole).toBeInstanceOf(KafkaError);
    expect(whole.category).toBe("unreadable-topic");
    expect(whole.message).toBe(
      'Topic "orders" cannot be read: the broker reported no earliest offset for partition 1, and no latest offset for partition 0; run the read again, or name a partition it reported offsets for',
    );
    // A partition read by name is refused for its own gap only.
    const named = await readMessages(client, req({ partition: 1, from: { kind: "latest" } }), LIMITS, signal).catch(
      (e) => e,
    );
    expect(named.message).toBe(
      'Topic "orders" cannot be read: the broker reported no earliest offset for partition 1; run the read again, or name a partition it reported offsets for',
    );
    expect(calls).toEqual([]);
  });

  test("a partition read by name is read when the offsets answers leave out only other partitions", async () => {
    const { client } = fakeClient(log, {
      offsets: async (_t, at) => new Map<number, bigint>([[0, at === "earliest" ? n(0) : n(3)]]),
    });
    const out = await readMessages(client, req({ partition: 0, from: { kind: "earliest" } }), LIMITS, signal);
    expect(out.rows.map((r) => r.offset)).toEqual(["0", "1", "2"]);
    expect(out.warnings).toEqual([]);
  });

  test("a timestamp answer that leaves out a partition is refused by name, never read as past the end", async () => {
    const { client, calls } = fakeClient(log, {
      offsetsForTimestamp: async () => new Map<number, bigint>([[0, n(1)]]),
    });
    const error = await readMessages(
      client,
      req({ from: { kind: "timestamp", timestampMs: n(25), iso: "x" } }),
      LIMITS,
      signal,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("unreadable-topic");
    expect(error.message).toBe(
      'Topic "orders" cannot be read: the broker reported no timestamp offset for partition 1; run the read again, or name a partition it reported offsets for',
    );
    expect(calls).toEqual([]);
  });

  test("the end is read after every start, so a record that arrives while the read is positioned is in it", async () => {
    // Offset 1 of partition 0 arrives while the timestamp is looked up, and it is the first record at or after it.
    let arrived = false;
    const reads: string[] = [];
    const { client } = fakeClient(
      { 0: [rec(0, 0, 10), rec(0, 1, 20)] },
      {
        offsets: async (_t, at) => {
          reads.push(at);
          return new Map<number, bigint>([[0, at === "earliest" ? n(0) : arrived ? n(2) : n(1)]]);
        },
        offsetsForTimestamp: async () => {
          reads.push("timestamp");
          arrived = true;
          return new Map<number, bigint>([[0, n(1)]]);
        },
      },
    );
    const out = await readMessages(
      client,
      req({ from: { kind: "timestamp", timestampMs: n(15), iso: "x" } }),
      LIMITS,
      signal,
    );
    expect(reads).toEqual(["earliest", "timestamp", "latest"]);
    expect(out.rows.map((r) => r.offset)).toEqual(["1"]);
    expect(out.warnings).toEqual([]);
  });

  test("Review Focus 2: a fetch that answers no user record but advances (a control batch) is followed; one with no progress stops the loop", async () => {
    let fetches = 0;
    const { client } = fakeClient(
      { 0: [rec(0, 0, 1), rec(0, 5, 2)] },
      {
        fetch: async (_t, _p, offset) => {
          fetches++;
          if (offset === n(0)) return { records: [rec(0, 0, 1)], nextOffset: n(3) }; // gap: 1 and 2 were markers
          if (offset === n(3)) return { records: [], nextOffset: n(5) }; // a control batch only, dropped by the adapter
          if (offset === n(5)) return { records: [rec(0, 5, 2)], nextOffset: n(6) };
          return { records: [], nextOffset: offset }; // no progress
        },
        offsets: async (_t, at) => new Map([[0, at === "earliest" ? n(0) : n(7)]]),
      },
    );
    const out = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal);
    expect(out.rows.map((r) => r.offset)).toEqual(["0", "5"]);
    expect(fetches).toBe(4);
  });

  test("a fetch that makes no progress below the end stops that partition, never silently: the result says where", async () => {
    const base = fakeClient(log);
    const client: ReadClient = {
      ...base.client,
      fetch: async (topic, partition, offset, fetchSignal) =>
        partition === 0 && offset === n(2)
          ? { records: [], nextOffset: offset }
          : base.client.fetch(topic, partition, offset, fetchSignal),
    };
    const out = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal);
    // Partition 0 stopped at offset 2, below its end at 3; partition 1 was still read to its end.
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/0", "1/0", "0/1", "1/1"]);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "The broker answered no records for partition 0 at offset 2, below its end at 3, so the read stopped there; run it again",
    ]);
    expect(out.wasLimited).toBe(true);
  });

  test("an aborted signal stops before the next fetch", async () => {
    const controller = new AbortController();
    const { client, calls } = fakeClient(log);
    controller.abort();
    const error = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, controller.signal).catch(
      (e) => e,
    );
    expect(error.category).toBe("timeout");
    expect(calls.length).toBe(0);
  });

  test("a signal aborted during the read stops it before the next fetch, and every fetch gets the read's signal", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const base = fakeClient(log);
    const client: ReadClient = {
      ...base.client,
      fetch: async (topic, partition, offset, fetchSignal) => {
        seen.push(fetchSignal);
        const answer = await base.client.fetch(topic, partition, offset, fetchSignal);
        controller.abort();
        return answer;
      },
    };
    const error = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, controller.signal).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("timeout");
    // By identity: toEqual cannot tell two AbortSignals apart.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(controller.signal);
  });

  test("every fetch of a read gets the read's own signal, the one its time limit aborts", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const base = fakeClient(log);
    const client: ReadClient = {
      ...base.client,
      fetch: async (topic, partition, offset, fetchSignal) => {
        seen.push(fetchSignal);
        return base.client.fetch(topic, partition, offset, fetchSignal);
      },
    };
    await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, controller.signal);
    // Partition 0's three records take two fetches, and partition 1's two take one.
    expect(seen).toHaveLength(3);
    expect(seen.every((fetchSignal) => fetchSignal === controller.signal)).toBe(true);
  });
});

/**
 * readMessages against a reference of spec 5.1 and 5.4 over generated logs. The reference keeps no
 * state between records: each decision is made again from every record read so far, sorted afresh,
 * so it shares none of the merge's incremental bookkeeping, and it counts a record's bytes on its own.
 * It takes the result order from compareRecords, the row shape from shapeRecord and the warning texts
 * from readWarnings, whose own tests pin them: what it decides is which records are rows, what the rows
 * hold, which warnings are owed, whether the read is limited, and which fetches the read makes.
 */
describe("readMessages against a reference of spec 5.1 and 5.4", () => {
  const READS = 3000;
  /** Each rule the reference states, which the generated reads must each meet often enough to test it. */
  const RULES = [
    "the read was complete",
    "the merge left a read record out",
    "the row limit left a partition's record unread inside a fetch",
    "the row limit stopped a partition before its end",
    "the budget stopped the read in the first partition read",
    "the budget stopped the read in a later partition",
    "a fetch made no progress",
    "a fetch answered records past the end",
    "a timestamp lay past a partition's end",
    "cells were cut in more than one row",
    "a row has no key",
    "a row has no value",
    "a row has a header with no name",
    "a row has a header with no value",
  ] as const;
  type Rule = (typeof RULES)[number];

  interface Scenario {
    readonly label: string;
    /** The partitions in the order the metadata lists them. */
    readonly order: readonly number[];
    readonly log: Readonly<Record<number, readonly KafkaRecord[]>>;
    readonly earliest: Readonly<Record<number, bigint>>;
    readonly latest: Readonly<Record<number, bigint>>;
    readonly request: ReadRequest;
    readonly limits: ReadLimits;
    readonly perFetch: number;
  }

  /** Park and Miller's generator: exact in doubles, so every run draws the same reads. */
  function draws(seed: number) {
    let state = seed;
    const next = () => {
      state = (state * 48271) % 2147483647;
      return state / 2147483647;
    };
    const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
    const chance = (p: number) => next() < p;
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
    return { int, chance, pick };
  }

  const filled = (length: number, fill: string) => enc(fill.repeat(length));

  function scenario(index: number): Scenario {
    const { int, chance, pick } = draws(20260925 + index * 7919);
    const partitions = int(1, 4);
    const monotonic = chance(0.6);
    const sizes = pick(["uniform", "mixed", "big first"] as const);
    const log: Record<number, KafkaRecord[]> = {};
    const earliest: Record<number, bigint> = {};
    const latest: Record<number, bigint> = {};
    for (let p = 0; p < partitions; p++) {
      const first = int(0, 3);
      let offset = first;
      let timestamp = int(0, 5);
      log[p] = Array.from({ length: chance(0.12) ? 0 : int(1, 7) }, () => {
        timestamp = monotonic ? timestamp + int(0, 3) : int(0, 20);
        const valueLength =
          sizes === "uniform" ? 20 : sizes === "mixed" ? int(0, 60) : p === 0 ? int(40, 80) : int(0, 6);
        const record: KafkaRecord = {
          partition: p,
          offset: n(offset),
          timestamp: n(timestamp),
          key: chance(0.35) ? null : filled(int(0, 12), "k"),
          value: chance(0.15) ? null : filled(valueLength, "v"),
          headers: Array.from(
            { length: chance(0.6) ? 0 : int(1, 2) },
            () => [chance(0.15) ? null : filled(int(1, 6), "h"), chance(0.3) ? null : filled(int(0, 8), "x")] as const,
          ),
        };
        // A gap: an offset that compaction removed, or that a transaction marker took.
        offset += chance(0.25) ? 2 : 1;
        return record;
      });
      earliest[p] = n(first);
      // The latest offset the read is given: the log's end; past it, over offsets a fetch answers
      // nothing for; or before it, when records arrived after the latest offset was read.
      const records = log[p];
      const end = records.length === 0 ? first : Number(records[records.length - 1].offset) + 1;
      const shift = chance(0.7) ? 0 : chance(0.5) ? int(1, 2) : -int(1, 2);
      latest[p] = n(Math.max(first, end + shift));
    }
    const order = Array.from({ length: partitions }, (_, p) => p);
    if (chance(0.25)) order.reverse();
    const named = int(0, partitions - 1);
    const kind = pick(["earliest", "latest", "latest", "offset", "timestamp"] as const);
    const partition = kind === "offset" || chance(0.25) ? named : undefined;
    const from: ReadStart =
      kind === "offset"
        ? { kind, offset: n(int(Number(earliest[named]), Number(latest[named]))) }
        : kind === "timestamp"
          ? { kind, timestampMs: n(int(0, 25)), iso: "x" }
          : { kind };
    const limit = int(1, 6);
    const limits = {
      resultByteBudget: chance(0.35) ? 1_000_000 : int(5, 220),
      cellLimit: chance(0.5) ? 1000 : int(3, 15),
    };
    const perFetch = pick([1, 2, 3, 100]);
    const where = partition === undefined ? "" : ` of partition ${partition}`;
    return {
      label: `read ${index}: ${kind}${where}, limit ${limit}, ${perFetch} a fetch, budget ${limits.resultByteBudget}, cells ${limits.cellLimit}`,
      order,
      log,
      earliest,
      latest,
      request: { topic: "orders", ...(partition === undefined ? {} : { partition }), from, limit },
      limits,
      perFetch,
    };
  }

  /** The fake broker: a fetch answers up to `perFetch` records from the offset asked for, and nothing past the log. */
  function fetchFrom(s: Scenario, partition: number, offset: bigint): KafkaFetchResult {
    const records = s.log[partition].filter((r) => r.offset >= offset).slice(0, s.perFetch);
    return { records, nextOffset: records.length === 0 ? offset : records[records.length - 1].offset + n(1) };
  }

  function clientOf(s: Scenario, fetches: string[]): ReadClient {
    const topic: KafkaTopicMetadata = {
      name: "orders",
      id: "id-1",
      partitions: s.order.map((partition) => ({
        partition,
        leader: 1,
        leaderEpoch: 0,
        replicas: [1],
        isr: [1],
        offlineReplicas: [],
      })),
    };
    return {
      metadata: async () => ({ clusterId: "c", controllerId: 1, brokers: [], topics: [topic] }),
      offsets: async (_t, at) => new Map(s.order.map((p) => [p, at === "earliest" ? s.earliest[p] : s.latest[p]])),
      offsetsForTimestamp: async (_t, ts) =>
        new Map(s.order.map((p) => [p, s.log[p].find((r) => r.timestamp >= ts)?.offset ?? n(-1)])),
      fetch: async (_t, partition, offset) => {
        fetches.push(`${partition}@${offset}`);
        return fetchFrom(s, partition, offset);
      },
    };
  }

  /** Where spec 5.1 starts a partition's read; undefined when no message at or after the timestamp lies below the end. */
  function startOf(s: Scenario, partition: number, end: bigint): bigint | undefined {
    const { from, limit } = s.request;
    const first = s.earliest[partition];
    switch (from.kind) {
      case "earliest":
        return first;
      case "latest":
        return end - n(limit) > first ? end - n(limit) : first;
      case "offset":
        return from.offset;
      case "timestamp": {
        const instant = from.timestampMs;
        const at = s.log[partition].find((r) => r.timestamp >= instant)?.offset;
        return at === undefined || at >= end ? undefined : at;
      }
    }
  }

  /** What spec 5.1 and 5.4 say the read answers, warns and fetches; `saw` is told each rule the read meets. */
  function reference(s: Scenario, saw: (rule: Rule) => void) {
    const { request, limits } = s;
    const plans: { partition: number; start: bigint; end: bigint }[] = [];
    const pastEnd: number[] = [];
    for (const partition of s.order.filter((p) => request.partition === undefined || p === request.partition)) {
      const end = s.latest[partition];
      const start = startOf(s, partition, end);
      if (start === undefined) pastEnd.push(partition);
      else if (start < end) plans.push({ partition, start, end });
    }
    // Spec 5.2 and 5.4: the rows a read answers of the records it has read, and the bytes they hold.
    const answerOf = (records: readonly KafkaRecord[]) => {
      const sorted = [...records].sort(compareRecords);
      return request.from.kind === "latest" ? sorted.slice(-request.limit) : sorted.slice(0, request.limit);
    };
    const size = (bytes: Uint8Array | null) => (bytes === null ? 0 : bytes.byteLength);
    const bytesOf = (records: readonly KafkaRecord[]) =>
      records.reduce(
        (sum, r) =>
          sum +
          size(r.key) +
          size(r.value) +
          r.headers.reduce((all, [name, value]) => all + size(name) + size(value), 0),
        0,
      );
    const read: KafkaRecord[] = [];
    const fetches: string[] = [];
    const stoppedShort: { partition: number; at: bigint; end: bigint }[] = [];
    let budgetStop: { partition: number; at: bigint; unread: number[] } | undefined;
    let unfinished = false;
    // Spec 5.4: a partition is fetched from its start, each fetch from where the one before it ended,
    // until it has given `limit` records or reached its end, or a fetch makes no progress; the budget
    // stops the whole read. Answers whether the budget stopped it.
    const readPartition = (plan: (typeof plans)[number], index: number): boolean => {
      let position = plan.start;
      let taken = 0;
      while (position < plan.end && taken < request.limit) {
        fetches.push(`${plan.partition}@${position}`);
        const answer = fetchFrom(s, plan.partition, position);
        if (answer.records.some((r) => r.offset >= plan.end)) saw("a fetch answered records past the end");
        for (const record of answer.records.filter((r) => r.offset < plan.end)) {
          if (taken === request.limit) {
            saw("the row limit left a partition's record unread inside a fetch");
            unfinished = true;
            break;
          }
          // The rows held are the answer of the records read so far. A record that would be one of them
          // stops the read when they would then pass the budget, unless it is the read's first record.
          const next = answerOf([...read, record]);
          if (read.length > 0 && next.includes(record) && bytesOf(next) > limits.resultByteBudget) {
            saw(
              index === 0
                ? "the budget stopped the read in the first partition read"
                : "the budget stopped the read in a later partition",
            );
            const unread = plans.slice(index + 1).map((later) => later.partition);
            budgetStop = { partition: plan.partition, at: record.offset, unread };
            return true;
          }
          read.push(record);
          taken++;
        }
        if (answer.nextOffset <= position) {
          saw("a fetch made no progress");
          stoppedShort.push({ partition: plan.partition, at: position, end: plan.end });
          return false;
        }
        position = answer.nextOffset;
      }
      if (taken === request.limit && position < plan.end) {
        saw("the row limit stopped a partition before its end");
        unfinished = true;
      }
      return false;
    };
    for (const [index, plan] of plans.entries()) {
      if (readPartition(plan, index)) break;
    }
    const answer = answerOf(read);
    const shaped = answer.map((record) => shapeRecord(record, limits));
    const truncatedCells = shaped.reduce((sum, entry) => sum + entry.truncatedCells, 0);
    const wasLimited =
      budgetStop !== undefined ||
      stoppedShort.length > 0 ||
      truncatedCells > 0 ||
      answer.length < read.length ||
      unfinished;
    if (answer.length < read.length) saw("the merge left a read record out");
    if (pastEnd.length > 0) saw("a timestamp lay past a partition's end");
    if (shaped.filter((entry) => entry.truncatedCells > 0).length > 1) saw("cells were cut in more than one row");
    if (answer.some((r) => r.key === null)) saw("a row has no key");
    if (answer.some((r) => r.value === null)) saw("a row has no value");
    if (answer.some((r) => r.headers.some(([name]) => name === null))) saw("a row has a header with no name");
    if (answer.some((r) => r.headers.some(([, value]) => value === null))) saw("a row has a header with no value");
    if (!wasLimited) saw("the read was complete");
    return {
      rows: shaped.map((entry) => entry.row),
      warnings: readWarnings({ pastEnd, stoppedShort, budgetStop, truncatedCells, limits }),
      wasLimited,
      fetches,
    };
  }

  test("every generated read answers the reference's rows, warnings and limited flag, through the reference's fetches", async () => {
    const scenarios = Array.from({ length: READS }, (_, index) => scenario(index));
    const reads = await Promise.all(
      scenarios.map(async (s) => {
        const fetches: string[] = [];
        const out = await readMessages(clientOf(s, fetches), s.request, s.limits, signal);
        return { read: s.label, rows: out.rows, warnings: out.warnings, wasLimited: out.wasLimited, fetches };
      }),
    );
    const met = new Map<Rule, number>();
    const saw = (rule: Rule) => met.set(rule, (met.get(rule) ?? 0) + 1);
    scenarios.forEach((s, index) => {
      expect(reads[index]).toEqual({ read: s.label, ...reference(s, saw) });
    });
    // The generator's own check: every rule the reference states was met by enough reads to test it.
    expect(RULES.filter((rule) => (met.get(rule) ?? 0) < 20)).toEqual([]);
  });
});

describe("startOffset and readWarnings, the pure rules", () => {
  test("latest backs off limit from the end, never before the earliest", () => {
    expect(startOffset({ kind: "latest" }, 0, n(0), n(100), 50, undefined)).toBe(n(50));
    expect(startOffset({ kind: "latest" }, 0, n(80), n(100), 50, undefined)).toBe(n(80));
  });

  test("an offset outside the range carries the range; a timestamp past the end starts nowhere", () => {
    expect(() => startOffset({ kind: "offset", offset: n(101) }, 3, n(0), n(100), 5, undefined)).toThrow(
      /partition 3's range 0 to 100/,
    );
    expect(startOffset({ kind: "timestamp", timestampMs: n(1), iso: "x" }, 0, n(0), n(9), 5, n(-1))).toBeUndefined();
    expect(startOffset({ kind: "timestamp", timestampMs: n(1), iso: "x" }, 0, n(0), n(9), 5, n(4))).toBe(n(4));
  });

  test("an offset at either end of the range is a start: the earliest offset, and the end", () => {
    // The earliest offset of a trimmed partition is the first row's offset an earliest read shows (spec 6.4).
    expect(startOffset({ kind: "offset", offset: n(1200) }, 0, n(1200), n(1500), 5, undefined)).toBe(n(1200));
    expect(startOffset({ kind: "offset", offset: n(1500) }, 0, n(1200), n(1500), 5, undefined)).toBe(n(1500));
    // Controls: one offset past either end is refused.
    expect(
      thrown(() => startOffset({ kind: "offset", offset: n(1199) }, 0, n(1200), n(1500), 5, undefined)).message,
    ).toBe("Offset 1199 is outside partition 0's range 1200 to 1500");
    expect(
      thrown(() => startOffset({ kind: "offset", offset: n(1501) }, 0, n(1200), n(1500), 5, undefined)).message,
    ).toBe("Offset 1501 is outside partition 0's range 1200 to 1500");
  });

  test("a timestamp offset of 0 is a start, on a partition whose log begins at 0", () => {
    expect(startOffset({ kind: "timestamp", timestampMs: n(1), iso: "x" }, 0, n(0), n(9), 5, n(0))).toBe(n(0));
  });

  test("a timestamp offset at or past the end this read stops at starts nowhere", () => {
    const at = { kind: "timestamp", timestampMs: n(1), iso: "x" } as const;
    expect(startOffset(at, 0, n(0), n(9), 5, n(9))).toBeUndefined();
    expect(startOffset(at, 0, n(0), n(9), 5, n(12))).toBeUndefined();
    // Control: the last offset below the end is a start.
    expect(startOffset(at, 0, n(0), n(9), 5, n(8))).toBe(n(8));
  });

  test("a timestamp read with no offset from the broker is refused by name, never taken for past the end", () => {
    const error = thrown(() =>
      startOffset({ kind: "timestamp", timestampMs: n(1), iso: "x" }, 2, n(0), n(9), 5, undefined),
    );
    expect(error.category).toBe("unreadable-topic");
    expect(error.message).toBe("The broker reported no timestamp offset for partition 2; run the read again");
  });

  test("each truncation is said, in this order", () => {
    const warnings = readWarnings({
      pastEnd: [2],
      stoppedShort: [{ partition: 0, at: n(6), end: n(7) }],
      budgetStop: { partition: 1, at: n(4), unread: [3] },
      truncatedCells: 3,
      limits: { resultByteBudget: 1024, cellLimit: 10 },
    });
    expect(warnings.map((w) => w.message)).toEqual([
      "No message at or after the timestamp on partition 2",
      "The broker answered no records for partition 0 at offset 6, below its end at 7, so the read stopped there; run it again",
      "The read stopped before offset 4 of partition 1, at the result budget of 1,024 bytes of record data, and did not read partition 3; narrow it with a partition, an offset or a smaller limit",
      "3 cell(s) were cut at 10 characters",
    ]);
    expect(
      readWarnings({ pastEnd: [], stoppedShort: [], budgetStop: undefined, truncatedCells: 0, limits: LIMITS }),
    ).toEqual([]);
  });

  test("the budget warning names the offset and partition it stopped before, and every partition it did not read", () => {
    const budgetWarning = (unread: number[]) =>
      readWarnings({
        pastEnd: [],
        stoppedShort: [],
        budgetStop: { partition: 0, at: n(7), unread },
        truncatedCells: 0,
        limits: { resultByteBudget: 250, cellLimit: 10 },
      }).map((w) => w.message);
    expect(budgetWarning([])).toEqual([
      "The read stopped before offset 7 of partition 0, at the result budget of 250 bytes of record data; narrow it with a partition, an offset or a smaller limit",
    ]);
    expect(budgetWarning([2, 5])).toEqual([
      "The read stopped before offset 7 of partition 0, at the result budget of 250 bytes of record data, and did not read partition 2, 5; narrow it with a partition, an offset or a smaller limit",
    ]);
  });

  test("the past-end warning names every partition it applies to", () => {
    const warnings = readWarnings({
      pastEnd: [1, 3],
      stoppedShort: [],
      budgetStop: undefined,
      truncatedCells: 0,
      limits: LIMITS,
    });
    expect(warnings.map((w) => w.message)).toEqual(["No message at or after the timestamp on partition 1, 3"]);
  });

  test("the cell limit is written with thousands separators, as the budget is", () => {
    const warnings = readWarnings({
      pastEnd: [],
      stoppedShort: [],
      budgetStop: undefined,
      truncatedCells: 2,
      limits: { resultByteBudget: 8 * 1024 * 1024, cellLimit: 64 * 1024 },
    });
    expect(warnings.map((w) => w.message)).toEqual(["2 cell(s) were cut at 65,536 characters"]);
  });

  test("every partition that stopped short is named with the offset it stopped at and its end", () => {
    const warnings = readWarnings({
      pastEnd: [],
      stoppedShort: [
        { partition: 0, at: n(6), end: n(7) },
        { partition: 2, at: n(10), end: n(12) },
      ],
      budgetStop: undefined,
      truncatedCells: 0,
      limits: LIMITS,
    });
    expect(warnings.map((w) => w.message)).toEqual([
      "The broker answered no records for partition 0 at offset 6, below its end at 7, and for partition 2 at offset 10, below its end at 12, so the read stopped there; run it again",
    ]);
  });
});
