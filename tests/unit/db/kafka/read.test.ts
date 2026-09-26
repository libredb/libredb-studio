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
 * No read of a fake log here needs this many fetches: a read that makes more loops on a fetch that makes no
 * progress (Review Focus 2), and the fake fails it at once, where a loop over answers that never wait would
 * otherwise hold the event loop and hang the whole run.
 */
const FETCH_CEILING = 1000;
function spinGuarded(client: ReadClient): ReadClient {
  let fetches = 0;
  return {
    ...client,
    fetch: (topic, partition, offset, fetchSignal) => {
      fetches += 1;
      if (fetches > FETCH_CEILING) {
        throw new Error(`The read made more than ${FETCH_CEILING} fetches: it loops on a fetch that makes no progress`);
      }
      return client.fetch(topic, partition, offset, fetchSignal);
    },
  };
}

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
  return { client: spinGuarded(client), calls, offsetCalls };
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

  /**
   * Two partitions of offsets 0 to 9, and partition 1's log start moves to 6 as the read's first fetch of it is sent,
   * as retention or a deletion moves it: the broker refuses that fetch as out of range, in the adapter's words.
   */
  function trimmedLog(over: Partial<ReadClient> = {}) {
    const base = fakeClient({
      0: Array.from({ length: 10 }, (_, i) => rec(0, i, i * 2)),
      1: Array.from({ length: 10 }, (_, i) => rec(1, i, i * 2 + 1)),
    });
    const calls: string[] = [];
    let trimmed = false;
    const client: ReadClient = {
      ...base.client,
      offsets: async (topic, at) => {
        calls.push(`offsets ${at}`);
        const answer = await base.client.offsets(topic, at);
        if (trimmed && at === "earliest") answer.set(1, n(6));
        return answer;
      },
      fetch: async (topic, partition, offset, fetchSignal) => {
        calls.push(`fetch ${partition}@${offset}`);
        if (partition === 1) trimmed = true;
        if (partition === 1 && offset < n(6)) {
          throw new KafkaError("offset-out-of-range", "The offset is outside the partition's range", {
            apiId: "OFFSET_OUT_OF_RANGE",
          });
        }
        return base.client.fetch(topic, partition, offset, fetchSignal);
      },
      ...over,
    };
    return { client, calls };
  }

  test("a fetch the broker refuses as out of range is answered with the partition's range, read again once, and is never sent again", async () => {
    const { client, calls } = trimmedLog();
    const error = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("offset-out-of-range");
    expect(error.message).toBe(
      "The broker refused the fetch at offset 0 of partition 1 as out of range: the partition now holds 6 to its last stable offset 10, so its log moved after the read began; run the read again",
    );
    expect(error.detail).toEqual({ apiId: "OFFSET_OUT_OF_RANGE", validRange: { earliest: n(6), latest: n(10) } });
    expect(calls).toEqual([
      "offsets earliest",
      "offsets latest",
      "fetch 0@0",
      "fetch 0@2",
      "fetch 0@4",
      "fetch 0@6",
      "fetch 0@8",
      "fetch 1@0",
      "offsets earliest",
      "offsets latest",
    ]);
    // A latest read's window of partition 1 starts at 5, below the log start it moves to.
    const latest = trimmedLog();
    const windowed = await readMessages(
      latest.client,
      req({ from: { kind: "latest" }, limit: 5 }),
      LIMITS,
      signal,
    ).catch((e) => e);
    expect(windowed.message).toBe(
      "The broker refused the fetch at offset 5 of partition 1 as out of range: the partition now holds 6 to its last stable offset 10, so its log moved after the read began; run the read again",
    );
    expect(latest.calls.slice(-3)).toEqual(["fetch 1@5", "offsets earliest", "offsets latest"]);
  });

  test("a range read again that leaves the refused partition out is said, and no range is invented for it", async () => {
    const reads = await Promise.all(
      [["earliest"], ["latest"], ["earliest", "latest"]].map(async (missing) => {
        let planned = 0;
        const { client } = trimmedLog();
        const leaving: ReadClient = {
          ...client,
          offsets: async (topic, at) => {
            const answer = await client.offsets(topic, at);
            planned += 1;
            // The planning answers name both partitions; the answers read after the refusal leave partition 1 out.
            if (planned > 2 && missing.includes(at)) answer.delete(1);
            return answer;
          },
        };
        return readMessages(leaving, req({ from: { kind: "earliest" } }), LIMITS, signal).catch((e) => e);
      }),
    );
    expect(reads.map((error) => [error.category, error.message, error.detail])).toEqual(
      ["earliest", "latest", "earliest or latest"].map((missing) => [
        "offset-out-of-range",
        `The broker refused the fetch at offset 0 of partition 1 as out of range, and then reported no ${missing} offset for it; run the read again`,
        { apiId: "OFFSET_OUT_OF_RANGE" },
      ]),
    );
  });

  test("a fetch refused for any other reason is the read's refusal as it came, and reads no range", async () => {
    const refusal = new KafkaError("network", "The broker could not be reached (ECONNRESET)");
    const { client, calls } = trimmedLog({
      fetch: async () => {
        throw refusal;
      },
    });
    const error = await readMessages(client, req({ from: { kind: "earliest" } }), LIMITS, signal).catch((e) => e);
    expect(error).toBe(refusal);
    expect(calls).toEqual(["offsets earliest", "offsets latest"]);
  });

  /**
   * The offsets read again after a refused fetch, each held in turn: the earliest is the read's third offsets call and
   * the latest its fourth, after the two it planned from. The calls a read has made when the held one is out end so.
   */
  const REREAD_CALLS = [
    ["earliest", 3, ["fetch 1@0", "offsets earliest, held"]],
    ["latest", 4, ["fetch 1@0", "offsets earliest", "offsets latest, held"]],
  ] as const;

  test.each(
    REREAD_CALLS.flatMap(([held, at, last]) =>
      (["answer", "failure"] as const).map((how) => [held, how, at, last] as const),
    ),
  )(
    "the %s offsets read again after a refused fetch wait on the read's time limit as every planning call does, and nothing is asked once the %s comes",
    async (_held, how, at, last) => {
      const controller = new AbortController();
      let heldAsked: () => void = () => {};
      const asked = new Promise<void>((resolve) => {
        heldAsked = resolve;
      });
      let release: () => void = () => {};
      let answers = 0;
      const { client, calls } = trimmedLog();
      const holding: ReadClient = {
        ...client,
        offsets: (topic, which) => {
          answers += 1;
          if (answers < at) return client.offsets(topic, which);
          calls.push(`offsets ${which}, held`);
          heldAsked();
          // What the broker would answer now, which the fake writes down nowhere: partition 1's log starts at 6 since the
          // refusal, and both partitions end at 10. Or the client's own failure.
          const late = new Map<number, bigint>();
          late.set(0, which === "earliest" ? n(0) : n(10));
          late.set(1, which === "earliest" ? n(6) : n(10));
          return new Promise((resolve, reject) => {
            release = () => (how === "answer" ? resolve(late) : reject(new Error("the client's own timer")));
          });
        },
      };
      const read = readMessages(holding, req({ from: { kind: "earliest" } }), LIMITS, controller.signal).catch(
        (e) => e,
      );
      await asked;
      controller.abort();
      // At once: before a macrotask can run, while the held answer is still out.
      const settled = await Promise.race([
        read,
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 0)),
      ]);
      expect(settled).toBeInstanceOf(KafkaError);
      expect((settled as KafkaError).category).toBe("timeout");
      expect((settled as KafkaError).message).toBe("The read ran past its time limit and was stopped");
      expect(calls.slice(-last.length)).toEqual([...last]);
      const made = [...calls];
      // The held answer, or the failure, arrives later and goes nowhere: no offsets are read again, and the fetch is
      // not sent again.
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual(made);
    },
  );

  test("a refused fetch whose range read again still holds its offset is refused naming that range, and is never sent again", async () => {
    // The offsets read after the refusal put partition 1's log start back at 0, below the offset the broker refused,
    // as a log truncated and written again would: the read names that range and stops, and never fetches it again.
    const { client, calls } = trimmedLog();
    const holdsIt: ReadClient = {
      ...client,
      offsets: async (topic, at) => {
        const answer = await client.offsets(topic, at);
        if (at === "earliest") answer.set(1, n(0));
        return answer;
      },
    };
    const error = await readMessages(holdsIt, req({ from: { kind: "earliest" } }), LIMITS, signal).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("offset-out-of-range");
    expect(error.message).toBe(
      "The broker refused the fetch at offset 0 of partition 1 as out of range: the partition now holds 0 to its last stable offset 10, so its log moved after the read began; run the read again",
    );
    expect(error.detail).toEqual({ apiId: "OFFSET_OUT_OF_RANGE", validRange: { earliest: n(0), latest: n(10) } });
    expect(calls.slice(-3)).toEqual(["fetch 1@0", "offsets earliest", "offsets latest"]);
    expect(calls.filter((call) => call.startsWith("fetch 1@"))).toEqual(["fetch 1@0"]);
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
    expect(out.warnings.map((w) => w.message)).toEqual([
      "No message at or after the timestamp lies below the last stable offset, the end a read-committed read reaches, for partition 1 at 2",
    ]);
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

  test("a latest read of a partition holding more than limit records is limited, with no warning: the limit placed its window", async () => {
    // Offsets 0 to 11: the window of 5 is 7 to 11, and the limit, not the log, leaves 0 to 6 unread.
    const twelve = { 0: Array.from({ length: 12 }, (_, i) => rec(0, i, i + 1)) };
    const one = await readMessages(
      fakeClient(twelve).client,
      req({ from: { kind: "latest" }, limit: 5 }),
      LIMITS,
      signal,
    );
    expect(one.rows.map((r) => r.offset)).toEqual(["7", "8", "9", "10", "11"]);
    expect(one.wasLimited).toBe(true);
    expect(one.warnings).toEqual([]);
    // The same window beside an empty partition: the merge drops nothing, and the limit still left 0 to 6 unread.
    const beside = await readMessages(
      fakeClient({ ...twelve, 1: [] }).client,
      req({ from: { kind: "latest" }, limit: 5 }),
      LIMITS,
      signal,
    );
    expect(beside.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/7", "0/8", "0/9", "0/10", "0/11"]);
    expect(beside.wasLimited).toBe(true);
    expect(beside.warnings).toEqual([]);
    // One offset more than the limit: the window starts one above the earliest offset, and offset 0 is left unread.
    const six = await readMessages(
      fakeClient({ 0: Array.from({ length: 6 }, (_, i) => rec(0, i, i + 1)) }).client,
      req({ from: { kind: "latest" }, limit: 5 }),
      LIMITS,
      signal,
    );
    expect(six.rows.map((r) => r.offset)).toEqual(["1", "2", "3", "4", "5"]);
    expect(six.wasLimited).toBe(true);
  });

  test("an offset or a timestamp read that starts above the earliest offset and reads to the end is not limited: the caller placed its start", async () => {
    const twelve = { 0: Array.from({ length: 12 }, (_, i) => rec(0, i, i + 1)) };
    const reads = await Promise.all([
      readMessages(
        fakeClient(twelve).client,
        req({ partition: 0, from: { kind: "offset", offset: n(9) }, limit: 5 }),
        LIMITS,
        signal,
      ),
      readMessages(
        fakeClient(twelve).client,
        req({ from: { kind: "timestamp", timestampMs: n(10), iso: "x" }, limit: 5 }),
        LIMITS,
        signal,
      ),
    ]);
    expect(reads.map((out) => out.rows.map((r) => r.offset))).toEqual([
      ["9", "10", "11"],
      ["9", "10", "11"],
    ]);
    expect(reads.map((out) => out.wasLimited)).toEqual([false, false]);
  });

  test("a latest read whose window starts at its partition's earliest offset reads the whole partition and is not limited", async () => {
    // Five offsets under a limit of 5 and of 6, and a trimmed partition of offsets 3 to 7 under a limit of 5.
    const reads = await Promise.all([
      readMessages(
        fakeClient({ 0: Array.from({ length: 5 }, (_, i) => rec(0, i, i + 1)) }).client,
        req({ from: { kind: "latest" }, limit: 5 }),
        LIMITS,
        signal,
      ),
      readMessages(
        fakeClient({ 0: Array.from({ length: 5 }, (_, i) => rec(0, i, i + 1)) }).client,
        req({ from: { kind: "latest" }, limit: 6 }),
        LIMITS,
        signal,
      ),
      readMessages(
        fakeClient({ 0: Array.from({ length: 5 }, (_, i) => rec(0, i + 3, i + 1)) }).client,
        req({ from: { kind: "latest" }, limit: 5 }),
        LIMITS,
        signal,
      ),
    ]);
    expect(reads.map((out) => out.rows.map((r) => r.offset))).toEqual([
      ["0", "1", "2", "3", "4"],
      ["0", "1", "2", "3", "4"],
      ["3", "4", "5", "6", "7"],
    ]);
    expect(reads.map((out) => out.wasLimited)).toEqual([false, false, false]);
    expect(reads.map((out) => out.warnings)).toEqual([[], [], []]);
  });

  test("a latest window that holds only transaction markers, with records before it, answers no row and is limited", async () => {
    // Offsets 0 to 4 are records and 5 to 9 transaction markers: a fetch at 5 answers no record and moves past them.
    const base = fakeClient(
      { 0: Array.from({ length: 5 }, (_, i) => rec(0, i, i + 1)) },
      {
        offsets: async (_t, at) => new Map([[0, at === "earliest" ? n(0) : n(10)]]),
      },
    );
    const fetched: string[] = [];
    const client: ReadClient = {
      ...base.client,
      fetch: async (topic, partition, offset, fetchSignal) => {
        fetched.push(`${partition}@${offset}`);
        return offset >= n(5)
          ? { records: [], nextOffset: n(10) }
          : base.client.fetch(topic, partition, offset, fetchSignal);
      },
    };
    const out = await readMessages(client, req({ from: { kind: "latest" }, limit: 5 }), LIMITS, signal);
    expect(out.rows).toEqual([]);
    expect(fetched).toEqual(["0@5"]);
    expect(out.wasLimited).toBe(true);
    expect(out.warnings).toEqual([]);
    // Control: a window of 10 starts at the earliest offset, reads the five records and is not limited.
    const whole = await readMessages(client, req({ from: { kind: "latest" }, limit: 10 }), LIMITS, signal);
    expect(whole.rows.map((r) => r.offset)).toEqual(["0", "1", "2", "3", "4"]);
    expect(whole.wasLimited).toBe(false);
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

  test("Review Focus 1: a read that names a partition with a leader is refused too when another partition has none, before any offset is read", async () => {
    // The client reads a topic's offsets as a whole, so partition 1's missing leader fails a read of partition 0 as well.
    const { client, calls, offsetCalls } = fakeClient(log, {}, { 1: -1 });
    const error = await readMessages(client, req({ partition: 0, from: { kind: "earliest" } }), LIMITS, signal).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("unreadable-topic");
    expect(error.message).toBe(
      'Topic "orders" has no leader for partition 1; the client reads a topic\'s offsets as a whole, so the topic cannot be read until every partition has a leader',
    );
    expect(offsetCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("every call a read makes names the topic it reads, and every fetch gets the topic object the metadata answered", async () => {
    const base = fakeClient(log);
    const asked: unknown[] = [];
    const fetched: KafkaTopicMetadata[] = [];
    const client: ReadClient = {
      metadata: async (topics) => {
        asked.push(["metadata", topics]);
        return base.client.metadata(topics);
      },
      offsets: async (topic, at) => {
        asked.push([at, topic]);
        return base.client.offsets(topic, at);
      },
      offsetsForTimestamp: async (topic, timestampMs) => {
        asked.push(["timestamp", topic]);
        return base.client.offsetsForTimestamp(topic, timestampMs);
      },
      fetch: async (topic, partition, offset, fetchSignal) => {
        fetched.push(topic);
        return base.client.fetch(topic, partition, offset, fetchSignal);
      },
    };
    const out = await readMessages(
      client,
      req({ from: { kind: "timestamp", timestampMs: n(25), iso: "x" } }),
      LIMITS,
      signal,
    );
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/1", "1/1", "0/2"]);
    expect(asked).toEqual([
      ["metadata", ["orders"]],
      ["earliest", "orders"],
      ["timestamp", "orders"],
      ["latest", "orders"],
    ]);
    // By identity: the metadata's own object, never a copy or another topic's.
    const answered = (await base.client.metadata(["orders"])).topics[0];
    expect(fetched).toHaveLength(2);
    for (const topic of fetched) expect(topic).toBe(answered);
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
    // The lookup answers a macrotask after it is asked, so an end asked for before that answer came back is still 1.
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
          await new Promise((resolve) => setTimeout(resolve, 0));
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

  test("a timestamp lookup that found no message contributes none, even when one arrives before the end is read (the stated limit)", async () => {
    // The lookup answers past the log end, and then offset 1, at or after the instant, arrives: it lies below the end
    // the read stops at, but the lookup answered before it existed.
    let arrived = false;
    const { client, calls } = fakeClient(
      { 0: [rec(0, 0, 10), rec(0, 1, 20)] },
      {
        offsets: async (_t, at) => new Map<number, bigint>([[0, at === "earliest" ? n(0) : arrived ? n(2) : n(1)]]),
        offsetsForTimestamp: async () => {
          const answer = new Map<number, bigint>([[0, n(-1)]]);
          arrived = true;
          return answer;
        },
      },
    );
    const out = await readMessages(
      client,
      req({ from: { kind: "timestamp", timestampMs: n(15), iso: "x" } }),
      LIMITS,
      signal,
    );
    expect(out.rows).toEqual([]);
    expect(out.warnings.map((w) => w.message)).toEqual([
      "No message at or after the timestamp lies below the last stable offset, the end a read-committed read reaches, for partition 0 at 2",
    ]);
    expect(out.wasLimited).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an open transaction holds the last stable offset below the log end: the timestamp warning and the offset refusal name it as where a read-committed read ends", async () => {
    // Offsets 0 to 4 and 6 to 10 are plain records, and offset 5 an open transaction's: the last stable offset is 5,
    // while the log end, the high watermark a topic's source and a group's lag show, is 11. The broker's
    // read-committed lookup answers -1 for an instant whose first offset lies at or past the last stable offset.
    const records = [
      ...Array.from({ length: 5 }, (_, i) => rec(0, i, i + 1)),
      ...Array.from({ length: 5 }, (_, i) => rec(0, i + 6, i + 20)),
    ];
    const open = (stable: bigint) => {
      const asked: string[] = [];
      const fake = fakeClient(
        { 0: records },
        {
          offsets: async (_t, at) => {
            asked.push(at);
            return new Map([[0, at === "earliest" ? n(0) : at === "latest" ? stable : n(11)]]);
          },
          offsetsForTimestamp: async (_t, ts) => {
            asked.push("timestamp");
            const first = records.find((r) => r.timestamp >= ts)?.offset ?? n(-1);
            return new Map([[0, first < stable ? first : n(-1)]]);
          },
        },
      );
      return { ...fake, asked };
    };
    // The instant of offset 6, with the transaction open.
    const held = open(n(5));
    const byTime = await readMessages(
      held.client,
      req({ from: { kind: "timestamp", timestampMs: n(20), iso: "x" } }),
      LIMITS,
      signal,
    );
    expect(byTime.rows).toEqual([]);
    expect(byTime.warnings.map((w) => w.message)).toEqual([
      "No message at or after the timestamp lies below the last stable offset, the end a read-committed read reaches, for partition 0 at 5",
    ]);
    // The read's end is the last stable offset, never the log end.
    expect(held.asked).toEqual(["earliest", "timestamp", "latest"]);
    const byOffset = await readMessages(
      held.client,
      req({ partition: 0, from: { kind: "offset", offset: n(7) } }),
      LIMITS,
      signal,
    ).catch((e) => e);
    expect(byOffset).toBeInstanceOf(KafkaError);
    expect(byOffset.category).toBe("offset-out-of-range");
    expect(byOffset.message).toBe(
      "Offset 7 is outside partition 0's readable range, 0 to its last stable offset 5, the end a read-committed read reaches",
    );
    expect(byOffset.detail.validRange).toEqual({ earliest: n(0), latest: n(5) });
    expect(held.calls).toEqual([]);
    // Control: once the transaction ends, the last stable offset is the log end, and the same reads answer 6 to 10.
    const ended = open(n(11));
    const reads = await Promise.all([
      readMessages(ended.client, req({ from: { kind: "timestamp", timestampMs: n(20), iso: "x" } }), LIMITS, signal),
      readMessages(ended.client, req({ partition: 0, from: { kind: "offset", offset: n(7) } }), LIMITS, signal),
    ]);
    expect(reads.map((out) => out.rows.map((r) => r.offset))).toEqual([
      ["6", "7", "8", "9", "10"],
      ["7", "8", "9", "10"],
    ]);
    expect(reads.map((out) => out.warnings)).toEqual([[], []]);
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
    const client = spinGuarded({
      ...base.client,
      fetch: async (topic, partition, offset, fetchSignal) =>
        partition === 0 && offset === n(2)
          ? { records: [], nextOffset: offset }
          : base.client.fetch(topic, partition, offset, fetchSignal),
    });
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

  /**
   * A fake whose planning answers the test holds: the step named `held` answers only when the test releases it,
   * with the answer it would have given or with a failure, and every call is written down as it is made.
   */
  function heldPlanning(held: "metadata" | "earliest" | "timestamp" | "latest") {
    const base = fakeClient(log);
    const calls: string[] = [];
    let asked: () => void = () => {};
    const heldAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let release: (answer: "answer" | "failure") => void = () => {};
    const hold = <T>(step: typeof held, answer: () => Promise<T>): Promise<T> => {
      calls.push(step);
      if (step !== held) return answer();
      asked();
      return new Promise<T>((resolve, reject) => {
        release = (how) => (how === "answer" ? answer().then(resolve) : reject(new Error("the client's own timer")));
      });
    };
    const client: ReadClient = {
      metadata: (topics) => hold("metadata", () => base.client.metadata(topics)),
      offsets: (topic, at) => hold(at === "earliest" ? "earliest" : "latest", () => base.client.offsets(topic, at)),
      offsetsForTimestamp: (topic, ts) => hold("timestamp", () => base.client.offsetsForTimestamp(topic, ts)),
      fetch: (topic, partition, offset, fetchSignal) => {
        calls.push("fetch");
        return base.client.fetch(topic, partition, offset, fetchSignal);
      },
    };
    return { client, calls, heldAsked, release: (how: "answer" | "failure") => release(how) };
  }

  const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

  const PLANNING_CALLS = [
    ["metadata", ["metadata"]],
    ["earliest", ["metadata", "earliest"]],
    ["timestamp", ["metadata", "earliest", "timestamp"]],
    ["latest", ["metadata", "earliest", "timestamp", "latest"]],
  ] as const;

  test.each(
    PLANNING_CALLS.flatMap(([held, asked]) =>
      (["answer", "failure"] as const).map((how) => [held, how, asked] as const),
    ),
  )(
    "a read its time limit stops while the %s answer is out is answered at once, and makes no call after it, even once the %s comes",
    async (held, how, asked) => {
      const planning = heldPlanning(held);
      const controller = new AbortController();
      const read = readMessages(
        planning.client,
        req({ from: { kind: "timestamp", timestampMs: n(25), iso: "x" } }),
        LIMITS,
        controller.signal,
      ).then(
        () => "answered",
        (error: unknown) => error,
      );
      await planning.heldAsked;
      controller.abort();
      // At once: before a macrotask can run, while the held answer is still out.
      const settled = await Promise.race([read, macrotask().then(() => "still waiting")]);
      expect(settled).toBeInstanceOf(KafkaError);
      expect((settled as KafkaError).category).toBe("timeout");
      expect((settled as KafkaError).message).toBe("The read ran past its time limit and was stopped");
      expect(planning.calls).toEqual([...asked]);
      // The held answer, or the client's own failure, arrives later and goes nowhere: no later call is made.
      planning.release(how);
      await macrotask();
      await macrotask();
      expect(planning.calls).toEqual([...asked]);
    },
  );

  test("every listener a planning step puts on the read's signal is taken off once the step is answered", async () => {
    const controller = new AbortController();
    const listening = new Set<unknown>();
    let added = 0;
    const { addEventListener, removeEventListener } = controller.signal;
    controller.signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
      if (type === "abort") {
        added += 1;
        listening.add(listener);
      }
      return addEventListener.call(
        controller.signal,
        type,
        listener as EventListener,
        options as AddEventListenerOptions,
      );
    }) as AbortSignal["addEventListener"];
    controller.signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
      if (type === "abort") listening.delete(listener);
      return removeEventListener.call(
        controller.signal,
        type,
        listener as EventListener,
        options as EventListenerOptions,
      );
    }) as AbortSignal["removeEventListener"];
    const out = await readMessages(
      fakeClient(log).client,
      req({ from: { kind: "timestamp", timestampMs: n(25), iso: "x" } }),
      LIMITS,
      controller.signal,
    );
    expect(out.rows).toHaveLength(3);
    // The metadata, the earliest offsets, the lookup at the timestamp and the latest offsets.
    expect(added).toBe(4);
    expect(listening.size).toBe(0);
    // And once a step fails: the read is refused with the step's failure, and its listener is off too.
    const failing = fakeClient(log, {
      offsets: async () => {
        throw new KafkaError("network", "the broker could not be reached");
      },
    });
    const error = await readMessages(failing.client, req({}), LIMITS, controller.signal).catch((e) => e);
    expect(error.message).toBe("the broker could not be reached");
    expect(added).toBe(6);
    expect(listening.size).toBe(0);
  });

  test("a read whose time limit runs out while a planning call is being made is refused at once as well", async () => {
    const controller = new AbortController();
    const base = fakeClient(log);
    const client: ReadClient = {
      ...base.client,
      // The signal stops inside the call, before it returns its answer, which comes 50 ms later.
      metadata: (topics) => {
        controller.abort();
        return new Promise((resolve) => setTimeout(resolve, 50)).then(() => base.client.metadata(topics));
      },
    };
    const read = readMessages(client, req({}), LIMITS, controller.signal).catch((e) => e);
    const settled = await Promise.race([read, macrotask().then(() => "still waiting")]);
    expect(settled).toBeInstanceOf(KafkaError);
    expect((settled as KafkaError).category).toBe("timeout");
    expect(base.offsetCalls).toEqual([]);
  });

  test("a read whose time limit ran out before it started makes no call at all", async () => {
    const planning = heldPlanning("metadata");
    const error = await readMessages(
      planning.client,
      req({ from: { kind: "timestamp", timestampMs: n(25), iso: "x" } }),
      LIMITS,
      AbortSignal.abort(),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(KafkaError);
    expect(error.category).toBe("timeout");
    expect(planning.calls).toEqual([]);
  });

  test("a planning step that answers before the time limit leaves the read to go on, and its failure is the read's", async () => {
    // Control for the tests above: the same held steps, released before any abort, answer the read as usual.
    const planning = heldPlanning("latest");
    const controller = new AbortController();
    const read = readMessages(
      planning.client,
      req({ from: { kind: "timestamp", timestampMs: n(25), iso: "x" } }),
      LIMITS,
      controller.signal,
    );
    await planning.heldAsked;
    planning.release("answer");
    const out = await read;
    expect(out.rows.map((r) => `${r.partition}/${r.offset}`)).toEqual(["0/1", "1/1", "0/2"]);
    expect(planning.calls).toEqual(["metadata", "earliest", "timestamp", "latest", "fetch", "fetch"]);
    const failing = heldPlanning("earliest");
    const refused = readMessages(failing.client, req({}), LIMITS, new AbortController().signal).catch((e) => e);
    await failing.heldAsked;
    failing.release("failure");
    const error = await refused;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("the client's own timer");
    expect(failing.calls).toEqual(["metadata", "earliest"]);
  });
});

/**
 * readMessages against a reference of spec 5.1 and 5.4 over generated reads, through a fake that holds the seam's
 * contract (client.ts, KafkaReadClient). The reference keeps no state between records: each decision is made again
 * from every record read so far, sorted afresh, so it shares none of the merge's incremental bookkeeping, and it
 * counts a record's bytes on its own. It takes the result order from compareRecords, the row shape and a
 * timestamp's refusal from shapeRecord, and the warning texts from readWarnings, whose own tests pin them: what it
 * decides is which records are rows, what the rows hold, which warnings are owed, whether the read is limited,
 * which refusal the read meets, and every call the read makes to its client.
 *
 * The fake answers each call a macrotask after it is made, and writes the call into the read's trace when it is
 * made and again when it is answered or refused, with every argument: the topic it names, the position or the
 * instant, and for a fetch whether it got the very topic object the metadata answered and the read's own signal.
 * So which topic each call names, the order of the calls, and whether two were ever in flight at once are part of
 * what every generated read is compared with, not only its rows. It refuses as the adapter does: an internal topic,
 * a topic the cluster does not hold, the offsets of a topic with a leaderless partition, and a fetch whose offset the
 * log start has moved past. The read's time can run out before it starts, while a planning call is out, or as a fetch
 * is answered, and the trace is taken when the read is answered, so an answer the fake gives after that is not the
 * read's.
 */
describe("readMessages against a reference of spec 5.1 and 5.4, through the seam's contract", () => {
  const READS = 3000;
  /** The one topic the fake cluster holds, and an internal topic, which the client refuses (spec 4.1). */
  const TOPIC = "orders";
  const INTERNAL = "__consumer_offsets";
  /** The timestamps no date can show, one past each end of the Date range (spec 5.2). */
  const UNSHOWABLE = [BigInt("8640000000000001"), BigInt("-8640000000000001")];
  /** How the trace names the topic object the metadata answered, and the read's own signal. */
  const THE_TOPIC = "the metadata's topic";
  const THE_SIGNAL = "the read's signal";
  /** Each rule the reference states, which the generated reads must each meet often enough to test it. */
  const RULES = [
    "the read was complete",
    "the merge left a read record out",
    "the row limit left a partition's record unread inside a fetch",
    "the row limit stopped a partition before its end",
    "only a latest window the limit started above its earliest offset limited it",
    "a latest read took every window from its earliest offset",
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
    "the topic is internal",
    "the topic does not exist",
    "the read named a partition the topic does not have",
    "the read named a partition of a topic with no partitions",
    "a partition had no leader",
    "two partitions had no leader",
    "a read of a partition with a leader met another partition's missing leader",
    "an offsets answer left out a partition the read covers",
    "the timestamp answer left out a partition the read covers",
    "an answer left out two partitions the read covers",
    "two answers left out a partition the read covers",
    "an offsets answer left out only partitions the read does not cover",
    "an offset lay outside its partition's range",
    "the read's time ran out before it started",
    "the read's time ran out while the metadata was out",
    "the read's time ran out while the earliest offsets were out",
    "the read's time ran out while the timestamp lookup was out",
    "the read's time ran out while the latest offsets were out",
    "the read's time ran out before a fetch it still needed",
    "the read's time ran out after the last fetch it needed",
    "the broker refused a fetch as out of range",
    "a record no date can show came into the rows held",
    "the merge dropped a record no date can show as it arrived",
    "the budget stopped the read before a record no date can show",
  ] as const;
  type Rule = (typeof RULES)[number];

  interface Scenario {
    readonly label: string;
    /** The partitions in the order the metadata lists them. */
    readonly order: readonly number[];
    /** Each partition's leader; -1 is none (spec 4.1). */
    readonly leaders: Readonly<Record<number, number>>;
    readonly log: Readonly<Record<number, readonly KafkaRecord[]>>;
    /** The earliest and latest answers, which can leave a partition out (spec 5.1). */
    readonly earliest: ReadonlyMap<number, bigint>;
    readonly latest: ReadonlyMap<number, bigint>;
    /** The partitions the answer at a timestamp leaves out (spec 5.1). */
    readonly timestampLeftOut: readonly number[];
    readonly request: ReadRequest;
    readonly limits: ReadLimits;
    readonly perFetch: number;
    /** When the read's time runs out: before it starts (0), or as its n-th fetch is answered. */
    readonly abortAt: number | undefined;
    /** Or while one of the planning calls is out: its time runs out as that call is made, before it is answered. */
    readonly abortWhileAsked: PlanningStep | undefined;
    /**
     * The n-th fetch the broker refuses as out of range, because the partition's log start moved past the offset it
     * asks for after the read planned it; the earliest offset answered after that is the one past it (spec 5.6).
     */
    readonly refuseAt: number | undefined;
  }
  /** The calls a read makes before its first fetch, in the order it makes them (spec 5.1). */
  type PlanningStep = "metadata" | "earliest" | "timestamp" | "latest";

  /** The adapter's refusals, in words the read never writes itself, so a refusal passed on as it came is seen as such. */
  const internalTopic = () =>
    new KafkaError("unreadable-topic", `Topic "${INTERNAL}" is internal to Kafka and is not readable here`);
  const unknownTopic = () => new KafkaError("unknown-topic", "The topic does not exist");
  const leaderlessOffsets = (partitions: readonly number[]) =>
    new KafkaError("unreadable-topic", `The client read no offsets: no leader for partition ${partitions.join(", ")}`);
  /** The adapter's refusal of a fetch the broker answered with OFFSET_OUT_OF_RANGE, which names no range. */
  const fetchOutOfRange = () =>
    new KafkaError("offset-out-of-range", "The offset is outside the partition's range", {
      apiId: "OFFSET_OUT_OF_RANGE",
    });

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
    const partitions = chance(0.03) ? 0 : int(1, 4);
    const monotonic = chance(0.6);
    const sizes = pick(["uniform", "mixed", "big first"] as const);
    const log: Record<number, KafkaRecord[]> = {};
    const earliest = new Map<number, bigint>();
    const latest = new Map<number, bigint>();
    for (let p = 0; p < partitions; p++) {
      const first = int(0, 3);
      let offset = first;
      let timestamp = int(0, 5);
      log[p] = Array.from({ length: chance(0.12) ? 0 : int(1, 7) }, () => {
        timestamp = monotonic ? timestamp + int(0, 3) : int(0, 20);
        // Now and then a producer's clock that no date can show (spec 5.2), on a record large enough that the budget
        // often stops a read before it.
        const unshowable = chance(0.04);
        const valueLength = unshowable
          ? int(90, 200)
          : sizes === "uniform"
            ? 20
            : sizes === "mixed"
              ? int(0, 60)
              : p === 0
                ? int(40, 80)
                : int(0, 6);
        const record: KafkaRecord = {
          partition: p,
          offset: n(offset),
          timestamp: unshowable ? pick(UNSHOWABLE) : n(timestamp),
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
      earliest.set(p, n(first));
      // The latest offset the read is given: the log's end; past it, over offsets a fetch answers
      // nothing for; or before it, when records arrived after the latest offset was read.
      const records = log[p];
      const end = records.length === 0 ? first : Number(records[records.length - 1].offset) + 1;
      const shift = chance(0.7) ? 0 : chance(0.5) ? int(1, 2) : -int(1, 2);
      latest.set(p, n(Math.max(first, end + shift)));
    }
    const order = Array.from({ length: partitions }, (_, p) => p);
    if (chance(0.25)) order.reverse();
    const kind = pick(["earliest", "latest", "latest", "offset", "timestamp"] as const);
    // Now and then a partition the topic does not have (spec 5.1), and on a topic with no partitions any named one.
    const beyond = partitions === 0 ? kind === "offset" || chance(0.5) : chance(0.04);
    const partition = beyond
      ? partitions + int(0, 2)
      : partitions > 0 && (kind === "offset" || chance(0.35))
        ? int(0, partitions - 1)
        : undefined;
    // Node 0 is a broker id too (spec 8), and only -1 means no leader (Review Focus 1). A read that names a partition
    // the topic does not have meets that refusal alone: which of the two refusals comes first is no rule of the spec.
    const leaderless = !beyond && partitions > 0 && chance(0.1);
    const leaders: Record<number, number> = {};
    for (const p of order) leaders[p] = leaderless && chance(0.5) ? -1 : int(0, 2);
    if (leaderless && !order.some((p) => leaders[p] < 0)) leaders[pick(order)] = -1;
    // Now and then offsets answers that leave a partition out (spec 5.1).
    const holes = chance(0.15);
    const leftOut = () => holes && chance(0.35);
    const earliestAnswer = new Map([...earliest].filter(() => !leftOut()));
    const latestAnswer = new Map([...latest].filter(() => !leftOut()));
    const timestampLeftOut = order.filter(() => leftOut());
    const named = partition ?? 0;
    let from: ReadStart;
    if (kind === "offset") {
      const first = Number(earliest.get(named) ?? n(0));
      const end = Number(latest.get(named) ?? n(0));
      // Now and then an offset outside the partition's range (spec 5.6, its first row).
      const at = chance(0.8) ? int(first, end) : first > 0 && chance(0.5) ? int(0, first - 1) : end + int(1, 2);
      from = { kind, offset: n(at) };
    } else if (kind === "timestamp") {
      from = { kind, timestampMs: n(int(0, 25)), iso: "x" };
    } else {
      from = { kind };
    }
    const limit = int(1, 6);
    const limits = {
      resultByteBudget: chance(0.35) ? 1_000_000 : int(5, 220),
      cellLimit: chance(0.5) ? 1000 : int(3, 15),
    };
    const perFetch = pick([1, 2, 3, 100]);
    // Now and then a topic the client refuses: an internal one, or one the cluster does not hold (spec 4.1, 4.5).
    const topic = chance(0.02) ? INTERNAL : chance(0.02) ? "payments" : TOPIC;
    // Now and then the read's time runs out: before it starts, or as one of its first fetches is answered. Often
    // enough that the fetch-loop rules still meet their count beside the planning calls' draw below.
    const abortAt = chance(0.12) ? int(0, 3) : undefined;
    // Or while a planning call is out (spec 5.4), drawn last so that every draw above keeps its value, and more
    // often on a timestamp read, the one read that makes all four.
    const steps: readonly PlanningStep[] =
      kind === "timestamp" ? ["metadata", "earliest", "timestamp", "latest"] : ["metadata", "earliest", "latest"];
    const abortWhileAsked = chance(kind === "timestamp" ? 0.3 : 0.08) ? pick(steps) : undefined;
    // Now and then the log start moves past a fetch the read sends (spec 5.6), drawn after everything else too.
    const refuseAt = chance(0.1) ? int(1, 3) : undefined;
    const facets = [
      `read ${index}: ${kind}${partition === undefined ? "" : ` of partition ${partition}`} of ${topic}`,
      `limit ${limit}, ${perFetch} a fetch, budget ${limits.resultByteBudget}, cells ${limits.cellLimit}`,
      ...(leaderless ? [`leaders ${JSON.stringify(leaders)}`] : []),
      ...(holes ? ["answers that leave partitions out"] : []),
      ...(abortAt === undefined ? [] : [`time runs out at fetch ${abortAt}`]),
      ...(abortWhileAsked === undefined ? [] : [`time runs out while the ${abortWhileAsked} call is out`]),
      ...(refuseAt === undefined ? [] : [`the broker refuses fetch ${refuseAt} as out of range`]),
    ];
    return {
      label: facets.join(", "),
      order,
      leaders,
      log,
      earliest: earliestAnswer,
      latest: latestAnswer,
      timestampLeftOut,
      request: { topic, ...(partition === undefined ? {} : { partition }), from, limit },
      limits,
      perFetch,
      abortAt,
      abortWhileAsked,
      refuseAt,
    };
  }

  /** The fake broker's fetch: up to `perFetch` records from the offset asked for, and nothing past the log. */
  function fetchFrom(s: Scenario, partition: number, offset: bigint): KafkaFetchResult {
    const records = s.log[partition].filter((r) => r.offset >= offset).slice(0, s.perFetch);
    return { records, nextOffset: records.length === 0 ? offset : records[records.length - 1].offset + n(1) };
  }

  /** The fake broker's offset at an instant: its first record at or after it, or -1 past the log's end. */
  const offsetAt = (s: Scenario, partition: number, instant: bigint) =>
    s.log[partition].find((r) => r.timestamp >= instant)?.offset ?? n(-1);

  const fetchCall = (topic: string, partition: number, offset: bigint, fetchSignal: string) =>
    `fetch(${topic}, ${partition}@${offset}, ${fetchSignal})`;

  /** The fake client: the seam's contract (client.ts) over one topic, every call written into `trace`. */
  function clientOf(s: Scenario, controller: AbortController, trace: string[]): ReadClient {
    const topic: KafkaTopicMetadata = {
      name: TOPIC,
      id: "id-1",
      partitions: s.order.map((partition) => ({
        partition,
        leader: s.leaders[partition],
        leaderEpoch: 0,
        replicas: [1],
        isr: [1],
        offlineReplicas: [],
      })),
    };
    /**
     * Writes the call down, answers it a macrotask later, and writes down whether it was answered or refused. The
     * read's time runs out as the scenario's planning call is made, while its answer is still out.
     */
    const answer = async <T>(call: string, work: () => T, step?: PlanningStep): Promise<T> => {
      trace.push(call);
      if (step !== undefined && step === s.abortWhileAsked) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const value = work();
        trace.push(`${call}: answered`);
        return value;
      } catch (error) {
        trace.push(`${call}: refused`);
        throw error;
      }
    };
    /** The client refuses an internal topic and one the cluster does not hold (spec 4.1, 4.5). */
    const held = (name: string): KafkaTopicMetadata => {
      if (name === INTERNAL) throw internalTopic();
      if (name !== TOPIC) throw unknownTopic();
      return topic;
    };
    /** It reads a topic's offsets as a whole, and refuses them while any partition has no leader (spec 4.1). */
    const readable = (name: string): void => {
      const leaderless = held(name)
        .partitions.filter((p) => p.leader < 0)
        .map((p) => p.partition);
      if (leaderless.length > 0) throw leaderlessOffsets(leaderless);
    };
    let fetches = 0;
    /** Each partition's log start once it has moved past a fetch the broker refused. */
    const moved = new Map<number, bigint>();
    return {
      // Every non-internal topic when no name is given (client.ts).
      metadata: (names) =>
        answer(
          `metadata(${JSON.stringify(names)})`,
          () => ({
            clusterId: "c",
            controllerId: 1,
            brokers: [],
            topics: (names ?? [TOPIC]).map((name) => held(name)),
          }),
          "metadata",
        ),
      offsets: (name, at) =>
        answer(
          `offsets(${JSON.stringify(name)}, ${at})`,
          () => {
            readable(name);
            if (at !== "earliest") return new Map(s.latest);
            const answer = new Map(s.earliest);
            for (const [partition, start] of moved) answer.set(partition, start);
            return answer;
          },
          at === "earliest" ? "earliest" : "latest",
        ),
      offsetsForTimestamp: (name, timestampMs) =>
        answer(
          `offsetsForTimestamp(${JSON.stringify(name)}, ${timestampMs})`,
          () => {
            readable(name);
            const answered = s.order.filter((p) => !s.timestampLeftOut.includes(p));
            return new Map(answered.map((p) => [p, offsetAt(s, p, timestampMs)]));
          },
          "timestamp",
        ),
      fetch: (given, partition, offset, fetchSignal) =>
        answer(
          fetchCall(
            given === topic ? THE_TOPIC : JSON.stringify(given),
            partition,
            offset,
            fetchSignal === controller.signal ? THE_SIGNAL : "another signal",
          ),
          () => {
            fetches += 1;
            if (fetches > FETCH_CEILING) {
              throw new Error(
                `The read made more than ${FETCH_CEILING} fetches: it loops on a fetch that makes no progress`,
              );
            }
            // The read's time runs out as this fetch is answered.
            if (fetches === s.abortAt) controller.abort();
            // The log start has moved past the offset this fetch asks for, so the broker refuses it.
            if (fetches === s.refuseAt) {
              moved.set(partition, offset + n(1));
              throw fetchOutOfRange();
            }
            return fetchFrom(s, partition, offset);
          },
        ),
    };
  }

  /** What a refused read says, as the test compares it: its class, its category, its words and its detail. */
  function refusalOf(error: unknown) {
    if (error instanceof KafkaError) {
      return { kind: "KafkaError", category: error.category, message: error.message, detail: error.detail };
    }
    if (error instanceof QueryError) return { kind: "QueryError", message: error.message };
    throw error;
  }

  /** The refusal shapeRecord gives a record whose timestamp no date can show (spec 5.2). */
  function shapingRefusal(record: KafkaRecord, limits: ReadLimits): unknown {
    try {
      shapeRecord(record, limits);
    } catch (error) {
      return error;
    }
    throw new Error(`expected shapeRecord to refuse the record at offset ${record.offset}`);
  }

  /** An offset the reference plans from, which an answer it passed the gap check with always holds. */
  function answered(answer: ReadonlyMap<number, bigint>, partition: number): bigint {
    const offset = answer.get(partition);
    if (offset === undefined) throw new Error(`the reference planned partition ${partition}, which an answer left out`);
    return offset;
  }

  /** Where spec 5.1 starts a partition's read; undefined when no message at or after the timestamp lies below the end. */
  function startOf(s: Scenario, partition: number, first: bigint, end: bigint): bigint | undefined {
    const { from, limit } = s.request;
    switch (from.kind) {
      case "earliest":
        return first;
      case "latest":
        return end - n(limit) > first ? end - n(limit) : first;
      case "offset":
        return from.offset;
      case "timestamp": {
        const at = offsetAt(s, partition, from.timestampMs);
        return at < n(0) || at >= end ? undefined : at;
      }
    }
  }

  /** The read's refusal once its time limit stops it (spec 5.4). */
  const stoppedRead = () => new KafkaError("timeout", "The read ran past its time limit and was stopped");
  /** The rule each planning call meets when the read's time runs out while it is out. */
  const TIMED_OUT_WHILE: Readonly<Record<PlanningStep, Rule>> = {
    metadata: "the read's time ran out while the metadata was out",
    earliest: "the read's time ran out while the earliest offsets were out",
    timestamp: "the read's time ran out while the timestamp lookup was out",
    latest: "the read's time ran out while the latest offsets were out",
  };

  /** What spec 5.1 and 5.4 say the read answers or refuses, and the calls it makes; `saw` is told each rule it meets. */
  function reference(s: Scenario, saw: (rule: Rule) => void) {
    const { request, limits } = s;
    const trace: string[] = [];
    /** A call the read makes, and how the fake answered it, as the fake writes them down. */
    const called = (call: string, answer = "answered") => trace.push(call, `${call}: ${answer}`);
    const refused = (error: unknown) => ({ outcome: { refused: refusalOf(error) }, trace });
    /**
     * Spec 5.4: every step of a read waits on its signal, so a read whose time runs out while a planning call is out
     * is refused at once, before that call is answered, and makes no call after it.
     */
    const timedOut = (step: PlanningStep, call: string) => {
      trace.push(call);
      saw(TIMED_OUT_WHILE[step]);
      return refused(stoppedRead());
    };

    // Spec 5.4: a read whose time ran out before it started makes no call at all.
    if (s.abortAt === 0) {
      saw("the read's time ran out before it started");
      return refused(stoppedRead());
    }
    // Spec 4.1, 4.5: the read first asks for the metadata of the one topic it names. The client refuses an internal
    // topic and one the cluster does not hold, and the read passes that refusal on as it came.
    const metadata = `metadata(${JSON.stringify([request.topic])})`;
    if (s.abortWhileAsked === "metadata") return timedOut("metadata", metadata);
    if (request.topic !== TOPIC) {
      called(metadata, "refused");
      saw(request.topic === INTERNAL ? "the topic is internal" : "the topic does not exist");
      return refused(request.topic === INTERNAL ? internalTopic() : unknownTopic());
    }
    called(metadata);
    // A partition the topic does not have is refused from the metadata alone, before any offset is read.
    const count = s.order.length;
    if (request.partition !== undefined && request.partition >= count) {
      saw(
        count === 0
          ? "the read named a partition of a topic with no partitions"
          : "the read named a partition the topic does not have",
      );
      const has = count === 0 ? "no partitions" : `partitions 0 to ${count - 1}`;
      return refused(
        new KafkaError("invalid-request", `Topic "${TOPIC}" has ${has}; partition ${request.partition} does not exist`),
      );
    }
    // Review Focus 1: the client reads a topic's offsets as a whole, so a partition with no leader anywhere in the
    // topic refuses the read, whichever partition it names, before any offset is read.
    const leaderless = s.order.filter((p) => s.leaders[p] < 0);
    if (leaderless.length > 0) {
      saw("a partition had no leader");
      if (leaderless.length > 1) saw("two partitions had no leader");
      if (request.partition !== undefined && !leaderless.includes(request.partition)) {
        saw("a read of a partition with a leader met another partition's missing leader");
      }
      return refused(
        new KafkaError(
          "unreadable-topic",
          `Topic "${TOPIC}" has no leader for partition ${leaderless.join(", ")}; the client reads a topic's offsets as a whole, so the topic cannot be read until every partition has a leader`,
        ),
      );
    }
    const wanted = s.order.filter((p) => request.partition === undefined || p === request.partition);
    // The earliest offsets, then those at the timestamp, then the latest, each asked for only once the one before it
    // was answered: the end is read after every start (spec 5.1).
    const atTimestamp = request.from.kind === "timestamp";
    const earliestCall = `offsets("${TOPIC}", earliest)`;
    if (s.abortWhileAsked === "earliest") return timedOut("earliest", earliestCall);
    called(earliestCall);
    if (request.from.kind === "timestamp") {
      const lookup = `offsetsForTimestamp("${TOPIC}", ${request.from.timestampMs})`;
      if (s.abortWhileAsked === "timestamp") return timedOut("timestamp", lookup);
      called(lookup);
    }
    const latestCall = `offsets("${TOPIC}", latest)`;
    if (s.abortWhileAsked === "latest") return timedOut("latest", latestCall);
    called(latestCall);
    // Spec 5.1: a partition the read covers that an answer it uses leaves out is refused by name, before any
    // fetch, and a partition it does not cover may be left out.
    const answers: Array<[string, number[]]> = [
      ["earliest", wanted.filter((p) => !s.earliest.has(p))],
      ["timestamp", atTimestamp ? wanted.filter((p) => s.timestampLeftOut.includes(p)) : []],
      ["latest", wanted.filter((p) => !s.latest.has(p))],
    ];
    const gaps = answers.filter(([, left]) => left.length > 0);
    if (gaps.length > 0) {
      saw("an offsets answer left out a partition the read covers");
      if (gaps.some(([answer]) => answer === "timestamp"))
        saw("the timestamp answer left out a partition the read covers");
      if (gaps.some(([, left]) => left.length > 1)) saw("an answer left out two partitions the read covers");
      if (gaps.length > 1) saw("two answers left out a partition the read covers");
      const said = gaps.map(([answer, left]) => `no ${answer} offset for partition ${left.join(", ")}`).join(", and ");
      return refused(
        new KafkaError(
          "unreadable-topic",
          `Topic "${TOPIC}" cannot be read: the broker reported ${said}; run the read again, or name a partition it reported offsets for`,
        ),
      );
    }
    const unasked = (p: number) =>
      !s.earliest.has(p) || !s.latest.has(p) || (atTimestamp && s.timestampLeftOut.includes(p));
    if (s.order.some(unasked)) saw("an offsets answer left out only partitions the read does not cover");

    const plans: { partition: number; start: bigint; end: bigint }[] = [];
    const pastEnd: { partition: number; end: bigint }[] = [];
    // Spec 5.4: a "latest" window that starts above its partition's earliest offset was placed there by the limit,
    // not by the log, so the limit leaves the offsets below it unread.
    let windowCut = false;
    for (const partition of wanted) {
      const first = answered(s.earliest, partition);
      const end = answered(s.latest, partition);
      const { from } = request;
      // Spec 5.6: an offset outside the range a read-committed read reaches, from the earliest offset to the last
      // stable offset, is refused, carrying that range.
      if (from.kind === "offset" && (from.offset < first || from.offset > end)) {
        saw("an offset lay outside its partition's range");
        return refused(
          new KafkaError(
            "offset-out-of-range",
            `Offset ${from.offset} is outside partition ${partition}'s readable range, ${first} to its last stable offset ${end}, the end a read-committed read reaches`,
            { validRange: { earliest: first, latest: end } },
          ),
        );
      }
      const start = startOf(s, partition, first, end);
      if (start === undefined) pastEnd.push({ partition, end });
      else if (start < end) plans.push({ partition, start, end });
      if (from.kind === "latest" && start !== undefined && start > first) windowCut = true;
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
    const showable = (record: KafkaRecord) => !UNSHOWABLE.includes(record.timestamp);
    const read: KafkaRecord[] = [];
    const stoppedShort: { partition: number; at: bigint; end: bigint }[] = [];
    let budgetStop: { partition: number; at: bigint; unread: number[] } | undefined;
    let unfinished = false;
    let refusal: unknown;
    // Spec 5.4: the read's time limit is looked at before each fetch, and a fetch takes the read's signal itself.
    let timeRanOut = false;
    let fetches = 0;
    // Spec 5.4: a partition is fetched from its start, each fetch from where the one before it ended, until it has
    // given `limit` records or reached its end, or a fetch makes no progress; the budget stops the whole read.
    // Answers whether the read stopped there.
    const readPartition = (plan: (typeof plans)[number], index: number): boolean => {
      let position = plan.start;
      let taken = 0;
      while (position < plan.end && taken < request.limit) {
        if (timeRanOut) {
          saw("the read's time ran out before a fetch it still needed");
          refusal = new KafkaError("timeout", "The read ran past its time limit and was stopped");
          return true;
        }
        // One fetch at a time, with the topic object the metadata answered and the read's own signal (spec 3.5,
        // 3.6 K8).
        const fetch = fetchCall(THE_TOPIC, plan.partition, position, THE_SIGNAL);
        fetches += 1;
        if (fetches === s.abortAt) timeRanOut = true;
        if (fetches === s.refuseAt) {
          // Spec 5.6: the broker refused the fetch as out of range, its log start having moved past it. The
          // partition's offsets are read again, once, unless the read's time has run out, and the refusal names the
          // range they hold now; the fetch is never sent again.
          called(fetch, "refused");
          saw("the broker refused a fetch as out of range");
          if (timeRanOut) {
            refusal = stoppedRead();
            return true;
          }
          called(`offsets("${TOPIC}", earliest)`);
          called(`offsets("${TOPIC}", latest)`);
          const earliest = position + n(1);
          const latest = answered(s.latest, plan.partition);
          refusal = new KafkaError(
            "offset-out-of-range",
            `The broker refused the fetch at offset ${position} of partition ${plan.partition} as out of range: the partition now holds ${earliest} to its last stable offset ${latest}, so its log moved after the read began; run the read again`,
            { apiId: "OFFSET_OUT_OF_RANGE", validRange: { earliest, latest } },
          );
          return true;
        }
        called(fetch);
        const answer = fetchFrom(s, plan.partition, position);
        if (answer.records.some((r) => r.offset >= plan.end)) saw("a fetch answered records past the end");
        for (const record of answer.records.filter((r) => r.offset < plan.end)) {
          if (taken === request.limit) {
            saw("the row limit left a partition's record unread inside a fetch");
            unfinished = true;
            break;
          }
          // The rows held are the answer of the records read so far. A record that would be one of them stops the
          // read when they would then pass the budget, unless it is the read's first record.
          const next = answerOf([...read, record]);
          const held = next.includes(record);
          if (read.length > 0 && held && bytesOf(next) > limits.resultByteBudget) {
            saw(
              index === 0
                ? "the budget stopped the read in the first partition read"
                : "the budget stopped the read in a later partition",
            );
            if (!showable(record)) saw("the budget stopped the read before a record no date can show");
            const unread = plans.slice(index + 1).map((later) => later.partition);
            budgetStop = { partition: plan.partition, at: record.offset, unread };
            return true;
          }
          // Spec K5: a record is shaped as it comes into the rows held, never when the merge drops it as it arrives
          // or the budget stops the read before it, and one no date can show is refused there (spec 5.2).
          if (!showable(record) && !held) saw("the merge dropped a record no date can show as it arrived");
          if (!showable(record) && held) {
            saw("a record no date can show came into the rows held");
            refusal = shapingRefusal(record, limits);
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
    if (refusal !== undefined) return refused(refusal);
    if (timeRanOut) saw("the read's time ran out after the last fetch it needed");
    const answer = answerOf(read);
    const shaped = answer.map((record) => shapeRecord(record, limits));
    const truncatedCells = shaped.reduce((sum, entry) => sum + entry.truncatedCells, 0);
    const limitedOtherwise =
      budgetStop !== undefined ||
      stoppedShort.length > 0 ||
      truncatedCells > 0 ||
      answer.length < read.length ||
      unfinished;
    const wasLimited = limitedOtherwise || windowCut;
    if (windowCut && !limitedOtherwise)
      saw("only a latest window the limit started above its earliest offset limited it");
    if (request.from.kind === "latest" && !wasLimited) saw("a latest read took every window from its earliest offset");
    if (answer.length < read.length) saw("the merge left a read record out");
    if (pastEnd.length > 0) saw("a timestamp lay past a partition's end");
    if (shaped.filter((entry) => entry.truncatedCells > 0).length > 1) saw("cells were cut in more than one row");
    if (answer.some((r) => r.key === null)) saw("a row has no key");
    if (answer.some((r) => r.value === null)) saw("a row has no value");
    if (answer.some((r) => r.headers.some(([name]) => name === null))) saw("a row has a header with no name");
    if (answer.some((r) => r.headers.some(([, value]) => value === null))) saw("a row has a header with no value");
    if (!wasLimited) saw("the read was complete");
    return {
      outcome: {
        rows: shaped.map((entry) => entry.row),
        warnings: readWarnings({ pastEnd, stoppedShort, budgetStop, truncatedCells, limits }),
        wasLimited,
      },
      trace,
    };
  }

  test("every generated read answers or is refused as the reference says, through the calls it says, one at a time", async () => {
    const scenarios = Array.from({ length: READS }, (_, index) => scenario(index));
    const reads = await Promise.all(
      scenarios.map(async (s) => {
        const trace: string[] = [];
        const controller = new AbortController();
        if (s.abortAt === 0) controller.abort();
        // The trace as it stood when the read was answered: an answer the fake gives after that, to a call the read
        // stopped waiting on, is not the read's.
        const [outcome, calls] = await readMessages(
          clientOf(s, controller, trace),
          s.request,
          s.limits,
          controller.signal,
        ).then(
          (out) => [{ rows: out.rows, warnings: out.warnings, wasLimited: out.wasLimited }, [...trace]] as const,
          (error: unknown) => [{ refused: refusalOf(error) }, [...trace]] as const,
        );
        return { read: s.label, outcome, trace: calls };
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
    const refused = thrown(() => startOffset({ kind: "offset", offset: n(101) }, 3, n(0), n(100), 5, undefined));
    expect(refused.message).toBe(
      "Offset 101 is outside partition 3's readable range, 0 to its last stable offset 100, the end a read-committed read reaches",
    );
    expect(refused.detail.validRange).toEqual({ earliest: n(0), latest: n(100) });
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
    ).toBe(
      "Offset 1199 is outside partition 0's readable range, 1200 to its last stable offset 1500, the end a read-committed read reaches",
    );
    expect(
      thrown(() => startOffset({ kind: "offset", offset: n(1501) }, 0, n(1200), n(1500), 5, undefined)).message,
    ).toBe(
      "Offset 1501 is outside partition 0's readable range, 1200 to its last stable offset 1500, the end a read-committed read reaches",
    );
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
      pastEnd: [{ partition: 2, end: n(9) }],
      stoppedShort: [{ partition: 0, at: n(6), end: n(7) }],
      budgetStop: { partition: 1, at: n(4), unread: [3] },
      truncatedCells: 3,
      limits: { resultByteBudget: 1024, cellLimit: 10 },
    });
    expect(warnings.map((w) => w.message)).toEqual([
      "No message at or after the timestamp lies below the last stable offset, the end a read-committed read reaches, for partition 2 at 9",
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

  test("the past-end warning names every partition it applies to, each with the last stable offset it looked below", () => {
    const warnings = readWarnings({
      pastEnd: [
        { partition: 1, end: n(5) },
        { partition: 3, end: n(12) },
      ],
      stoppedShort: [],
      budgetStop: undefined,
      truncatedCells: 0,
      limits: LIMITS,
    });
    expect(warnings.map((w) => w.message)).toEqual([
      "No message at or after the timestamp lies below the last stable offset, the end a read-committed read reaches, for partition 1 at 5, and for partition 3 at 12",
    ]);
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
