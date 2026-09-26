import { describe, expect, test } from "bun:test";
import { KafkaError } from "@/lib/db/providers/stream/kafka/client";
import { computeLag, type GroupClient, readGroupSource } from "@/lib/db/providers/stream/kafka/groups";

const n = (value: number) => BigInt(value);

describe("computeLag", () => {
  test("latest minus committed, equal to kafka-consumer-groups.sh for the M-E fixture", () => {
    const latest = new Map([
      [
        "orders",
        new Map([
          [0, n(24)],
          [1, n(12)],
          [2, n(24)],
        ]),
      ],
    ]);
    const rows = computeLag(
      [
        { topic: "orders", partition: 0, offset: n(0) },
        { topic: "orders", partition: 1, offset: n(0) },
        { topic: "orders", partition: 2, offset: n(10) },
      ],
      latest,
    );
    expect(rows.map((r) => r.lag)).toEqual(["24", "12", "14"]);
  });

  test("no committed offset is null lag with a note, never 0 and never the whole log", () => {
    const rows = computeLag(
      [{ topic: "orders", partition: 1, offset: n(-1) }],
      new Map([["orders", new Map([[1, n(12)]])]]),
    );
    expect(rows[0]).toEqual({
      topic: "orders",
      partition: 1,
      committedOffset: null,
      latestOffset: "12",
      lag: null,
      note: "no committed offset",
    });
  });

  test("a partition of a committed topic that the group never committed on is a row too", () => {
    const rows = computeLag(
      [{ topic: "lag-partial", partition: 0, offset: n(1) }],
      new Map([
        [
          "lag-partial",
          new Map([
            [0, n(1)],
            [1, n(0)],
          ]),
        ],
      ]),
    );
    expect(rows).toEqual([
      { topic: "lag-partial", partition: 0, committedOffset: "1", latestOffset: "1", lag: "0" },
      {
        topic: "lag-partial",
        partition: 1,
        committedOffset: null,
        latestOffset: "0",
        lag: null,
        note: "no committed offset",
      },
    ]);
  });

  test("an assigned partition with no commit is a row, and one the broker gave no latest offset for says so", () => {
    const rows = computeLag([{ topic: "a", partition: 3, offset: n(5) }], new Map([["b", new Map([[0, n(7)]])]]), [
      { topic: "b", partitions: [0] },
    ]);
    expect(rows).toEqual([
      {
        topic: "a",
        partition: 3,
        committedOffset: "5",
        latestOffset: null,
        lag: null,
        note: "the broker reported no latest offset for this partition",
      },
      { topic: "b", partition: 0, committedOffset: null, latestOffset: "7", lag: null, note: "no committed offset" },
    ]);
  });

  test("the assignment alone gives rows: an assigned partition the latest answer leaves out, and every assigned partition of a topic whose offsets were not read", () => {
    const leaderless = 'Topic "payments" has no leader for partition 1';
    const rows = computeLag(
      [],
      // The latest answer names partition 0 of b only; payments has no latest answer at all.
      new Map([["b", new Map([[0, n(7)]])]]),
      [
        { topic: "b", partitions: [0, 1] },
        { topic: "payments", partitions: [0, 1] },
      ],
      new Map([["payments", leaderless]]),
    );
    expect(rows.map((r) => `${r.topic}/${r.partition}`)).toEqual(["b/0", "b/1", "payments/0", "payments/1"]);
    expect(rows[1]).toMatchObject({ topic: "b", partition: 1, committedOffset: null, latestOffset: null, lag: null });
    expect(rows[1].note).toContain("no committed offset");
    for (const row of rows.slice(2)) {
      expect(row).toMatchObject({ topic: "payments", committedOffset: null, latestOffset: null, lag: null });
      expect(row.note).toContain(leaderless);
    }
  });

  test("a topic whose latest offsets were not readable keeps its rows, with the reason", () => {
    const rows = computeLag(
      [{ topic: "__consumer_offsets", partition: 4, offset: n(9) }],
      new Map(),
      [],
      new Map([["__consumer_offsets", "internal"]]),
    );
    expect(rows).toEqual([
      {
        topic: "__consumer_offsets",
        partition: 4,
        committedOffset: "9",
        latestOffset: null,
        lag: null,
        note: "latest offset not read: internal",
      },
    ]);
  });

  test("rows are sorted by topic then partition", () => {
    const latest = new Map([
      ["b", new Map([[0, n(1)]])],
      [
        "a",
        new Map([
          [1, n(1)],
          [0, n(1)],
        ]),
      ],
    ]);
    const rows = computeLag(
      [
        { topic: "b", partition: 0, offset: n(0) },
        { topic: "a", partition: 1, offset: n(0) },
        { topic: "a", partition: 0, offset: n(0) },
      ],
      latest,
    );
    expect(rows.map((r) => `${r.topic}/${r.partition}`)).toEqual(["a/0", "a/1", "b/0"]);
  });
});

describe("readGroupSource", () => {
  const client = (over: Partial<GroupClient> = {}): GroupClient => ({
    listGroups: async () => [
      { groupId: "lag-kip848", state: "Empty", groupType: "consumer", protocolType: "consumer" },
      { groupId: "lag-classic", state: "Empty", groupType: "classic", protocolType: "consumer" },
    ],
    describeGroup: async (listing) => ({
      groupId: listing.groupId,
      groupType: listing.groupType,
      state: listing.state,
      protocolOrAssignor: listing.groupType === "consumer" ? "uniform" : "",
      members: [],
    }),
    committedOffsets: async () => [{ topic: "orders", partition: 0, offset: n(1) }],
    offsets: async () => new Map([[0, n(24)]]),
    ...over,
  });

  test("existence comes from the listing, and the description is dispatched with the listing", async () => {
    const source = await readGroupSource(client(), "lag-kip848");
    expect(source?.group.protocolOrAssignor).toBe("uniform");
    expect(source?.lag[0].lag).toBe("23");
  });

  test("lag is measured against the high watermark", async () => {
    const positions: string[] = [];
    await readGroupSource(
      client({ offsets: async (_t, at) => (positions.push(at), new Map([[0, n(24)]])) }),
      "lag-classic",
    );
    expect(positions).toEqual(["high-watermark"]);
  });

  test("a member's assigned topic with no commit yet is read and gives a row per assigned partition", async () => {
    const reads: string[] = [];
    const source = await readGroupSource(
      client({
        describeGroup: async (listing) => ({
          groupId: listing.groupId,
          groupType: listing.groupType,
          state: "Stable",
          protocolOrAssignor: "range",
          members: [
            {
              memberId: "m-1",
              clientId: "c-1",
              clientHost: "/10.0.0.1",
              assignment: [{ topic: "events", partitions: [0, 1] }],
            },
          ],
        }),
        committedOffsets: async () => [],
        offsets: async (topic, at) => (
          reads.push(`${topic}@${at}`),
          new Map([
            [0, n(5)],
            [1, n(7)],
          ])
        ),
      }),
      "lag-classic",
    );
    expect(reads).toEqual(["events@high-watermark"]);
    expect(source?.lag).toEqual([
      {
        topic: "events",
        partition: 0,
        committedOffset: null,
        latestOffset: "5",
        lag: null,
        note: "no committed offset",
      },
      {
        topic: "events",
        partition: 1,
        committedOffset: null,
        latestOffset: "7",
        lag: null,
        note: "no committed offset",
      },
    ]);
  });

  test("a member's assigned topic with a leaderless partition keeps a row per assigned partition, and an assigned partition the latest answer leaves out is a row", async () => {
    const source = await readGroupSource(
      client({
        describeGroup: async (listing) => ({
          groupId: listing.groupId,
          groupType: listing.groupType,
          state: "Stable",
          protocolOrAssignor: "range",
          members: [
            {
              memberId: "m-1",
              clientId: "c-1",
              clientHost: "/10.0.0.1",
              assignment: [
                { topic: "payments", partitions: [0, 1] },
                { topic: "orders", partitions: [2] },
              ],
            },
          ],
        }),
        committedOffsets: async () => [],
        offsets: async (topic) => {
          if (topic === "payments") {
            throw new KafkaError("unreadable-topic", 'Topic "payments" has no leader for partition 1');
          }
          return new Map([
            [0, n(4)],
            [1, n(6)],
          ]);
        },
      }),
      "lag-classic",
    );
    expect(source?.lag.map((r) => [`${r.topic}/${r.partition}`, r.latestOffset])).toEqual([
      ["orders/0", "4"],
      ["orders/1", "6"],
      ["orders/2", null],
      ["payments/0", null],
      ["payments/1", null],
    ]);
    for (const row of source?.lag.slice(3) ?? []) {
      expect(row.note).toContain('Topic "payments" has no leader for partition 1');
    }
  });

  test("a group not in the listing answers undefined, because describeGroups says Dead for anything (M-E)", async () => {
    expect(await readGroupSource(client(), "no-such-group")).toBeUndefined();
  });

  test("a committed internal topic keeps its rows with the reason, and the source still settles", async () => {
    const source = await readGroupSource(
      client({
        committedOffsets: async () => [{ topic: "__consumer_offsets", partition: 0, offset: n(3) }],
        offsets: async (topic) => {
          throw new KafkaError("unreadable-topic", `Topic ${JSON.stringify(topic)} is internal to Kafka`);
        },
      }),
      "lag-classic",
    );
    expect(source?.lag).toEqual([
      {
        topic: "__consumer_offsets",
        partition: 0,
        committedOffset: "3",
        latestOffset: null,
        lag: null,
        note: 'latest offset not read: Topic "__consumer_offsets" is internal to Kafka',
      },
    ]);
  });

  test("any other failure reading offsets propagates", async () => {
    const failing = client({
      offsets: async () => {
        throw new KafkaError("network", "down");
      },
    });
    expect((await readGroupSource(failing, "lag-classic").catch((e) => e)).category).toBe("network");
  });
});
