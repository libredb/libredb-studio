import { describe, expect, test } from "bun:test";
import { KafkaError } from "@/lib/db/providers/stream/kafka/client";
import { computeLag, type GroupClient, readGroupSource } from "@/lib/db/providers/stream/kafka/groups";

const n = (value: number) => BigInt(value);

/** A listed group's source whose two parts both answered, as their answers; a refused part fails the test. */
function answered(source: Awaited<ReturnType<typeof readGroupSource>>) {
  if (source === undefined) throw new Error("the group's source answered undefined");
  if (!("answer" in source.group) || !("answer" in source.lag)) {
    throw new Error(`a part of the group's source was refused: ${JSON.stringify(source)}`);
  }
  return { group: source.group.answer, lag: source.lag.answer };
}

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

  test("a commit past the log end is a negative lag, as kafka-consumer-groups.sh prints it, never 0 and never null", () => {
    // Measured on the scratch broker: committed 100 on a partition whose log end is 3 prints LAG -97.
    const rows = computeLag(
      [{ topic: "orders", partition: 0, offset: n(100) }],
      new Map([["orders", new Map([[0, n(3)]])]]),
    );
    expect(rows).toEqual([{ topic: "orders", partition: 0, committedOffset: "100", latestOffset: "3", lag: "-97" }]);
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

  test("a topic the group is assigned and never committed on gives a row for every partition the latest answer names, not only the assigned ones", () => {
    // Assigned partition 0 of the two-partition events, with no commit: a partition added
    // before the rebalance, or a group's first moments on a topic (spec 4.3).
    const rows = computeLag(
      [],
      new Map([
        [
          "events",
          new Map([
            [0, n(5)],
            [1, n(7)],
          ]),
        ],
      ]),
      [{ topic: "events", partitions: [0] }],
    );
    expect(rows).toEqual([
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
    const source = answered(await readGroupSource(client(), "lag-kip848"));
    expect(source.group.protocolOrAssignor).toBe("uniform");
    expect(source.lag[0].lag).toBe("23");
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
    expect(answered(source).lag).toEqual([
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
    const { lag } = answered(source);
    expect(lag.map((r) => [`${r.topic}/${r.partition}`, r.latestOffset])).toEqual([
      ["orders/0", "4"],
      ["orders/1", "6"],
      ["orders/2", null],
      ["payments/0", null],
      ["payments/1", null],
    ]);
    for (const row of lag.slice(3)) {
      expect(row.note).toContain('Topic "payments" has no leader for partition 1');
    }
  });

  test("every member's assignment is read: each member's topic with no commit is read and gives its rows", async () => {
    const reads: string[] = [];
    const member = (memberId: string, assignment: Array<{ topic: string; partitions: number[] }>) => ({
      memberId,
      clientId: memberId,
      clientHost: "/10.0.0.1",
      assignment,
    });
    const source = await readGroupSource(
      client({
        describeGroup: async (listing) => ({
          groupId: listing.groupId,
          groupType: listing.groupType,
          state: "Stable",
          protocolOrAssignor: "range",
          // The first member holds nothing; the second and the third each hold a topic the group
          // never committed on; the committed topic is no member's.
          members: [
            member("m-1", []),
            member("m-2", [{ topic: "events", partitions: [0, 1] }]),
            member("m-3", [{ topic: "audit", partitions: [0] }]),
          ],
        }),
        committedOffsets: async () => [{ topic: "orders", partition: 0, offset: n(1) }],
        offsets: async (topic, at) => {
          reads.push(`${topic}@${at}`);
          return topic === "events"
            ? new Map([
                [0, n(5)],
                [1, n(7)],
              ])
            : new Map([[0, n(7)]]);
        },
      }),
      "lag-classic",
    );
    expect(reads.sort()).toEqual(["audit@high-watermark", "events@high-watermark", "orders@high-watermark"]);
    expect(answered(source).lag.map((r) => [`${r.topic}/${r.partition}`, r.lag, r.note ?? null])).toEqual([
      ["audit/0", null, "no committed offset"],
      ["events/0", null, "no committed offset"],
      ["events/1", null, "no committed offset"],
      ["orders/0", "6", null],
    ]);
  });

  test("a group not in the listing answers undefined, because describeGroups says Dead for anything (M-E)", async () => {
    expect(await readGroupSource(client(), "no-such-group")).toBeUndefined();
  });

  test("a group the listing does not hold is decided by the listing alone: nothing is sent toward a group coordinator", async () => {
    // On a broker that never held a group, a FindCoordinator for any name creates
    // __consumer_offsets (spec Appendix B), so the listing is read first and alone (spec 3.6 K4, 4.3).
    const calls: string[] = [];
    const base = client();
    const recording: GroupClient = {
      listGroups: async () => {
        calls.push("listGroups");
        return base.listGroups();
      },
      describeGroup: async (listing) => {
        calls.push("describeGroup");
        return base.describeGroup(listing);
      },
      committedOffsets: async (groupId) => {
        calls.push("committedOffsets");
        return base.committedOffsets(groupId);
      },
      offsets: async (topic, at) => {
        calls.push("offsets");
        return base.offsets(topic, at);
      },
    };
    expect(await readGroupSource(recording, "no-such-group")).toBeUndefined();
    expect(calls).toEqual(["listGroups"]);
    // The control: a listed group is described and read, and only after the listing answered.
    calls.length = 0;
    expect(answered(await readGroupSource(recording, "lag-classic")).group.groupId).toBe("lag-classic");
    expect(calls[0]).toBe("listGroups");
    expect([...calls].sort()).toEqual(["committedOffsets", "describeGroup", "listGroups", "offsets"]);
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
    expect(answered(source).lag).toEqual([
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

  test("an assigned topic the principal may not describe keeps its rows, with no committed or latest offset and the broker's refusal as the reason, and the source still settles", async () => {
    // A principal with Describe on a classic group and not on a topic a member is assigned, as
    // measured on Apache Kafka 4.3.1: DescribeGroups answers the member's assignment, OffsetFetch
    // leaves that topic's committed offsets out, and its high watermark is refused
    // (docs/ADDING_A_PROVIDER.md, a refusal is an answer; spec 4.3, such a topic keeps its rows).
    const denied = "The broker denied access to this topic";
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
              assignment: [{ topic: "payments", partitions: [0, 1] }],
            },
          ],
        }),
        offsets: async (topic) => {
          if (topic === "payments") throw new KafkaError("authorization", denied);
          return new Map([[0, n(24)]]);
        },
      }),
      "lag-classic",
    );
    const { lag } = answered(source);
    expect(lag.map((r) => [`${r.topic}/${r.partition}`, r.committedOffset, r.latestOffset, r.lag])).toEqual([
      ["orders/0", "1", "24", "23"],
      ["payments/0", null, null, null],
      ["payments/1", null, null, null],
    ]);
    for (const row of lag.slice(1)) expect(row.note).toContain(denied);
  });

  test("a failure that is no refusal fails the source as itself, at a topic's offsets, the description and the committed offsets alike, and so does a refusal of the listing", async () => {
    const failures = [
      new KafkaError("protocol", "The request to the broker failed (UNKNOWN_SERVER_ERROR)"),
      new KafkaError("network", "The broker could not be reached (connection-lost)"),
      new TypeError("a defect, not a refusal"),
      // Not a KafkaError, whatever it carries: only the domain's own refusal is an answer.
      Object.assign(new Error("carries the category only"), { category: "authorization" }),
    ];
    const outcomes = await Promise.all(
      (["offsets", "describeGroup", "committedOffsets"] as const).flatMap((read) =>
        failures.map((failure) =>
          readGroupSource(
            client({
              [read]: async () => {
                throw failure;
              },
            }),
            "lag-classic",
          ).then(
            () => "answered",
            (error) => error === failure,
          ),
        ),
      ),
    );
    expect(outcomes).toEqual(Array.from({ length: 3 * failures.length }, () => true));
    // The listing decides the group exists (spec 4.3), so its refusal is the source's own.
    const listingRefused = new KafkaError("authorization", "The broker denied access to this group");
    const refused = await readGroupSource(
      client({
        listGroups: async () => {
          throw listingRefused;
        },
      }),
      "lag-classic",
    ).catch((error) => error);
    expect(refused).toBe(listingRefused);
  });
});

describe("readGroupSource, a part whose own read the broker refuses (spec 4.4)", () => {
  // docs/ADDING_A_PROVIDER.md: a refusal and an absence are different answers, and must not arrive as
  // one. Measured on Apache Kafka 4.3.1 with StandardAuthorizer: a consumer-protocol group whose member
  // holds a topic the principal may not describe is refused whole by ConsumerGroupDescribe
  // (TOPIC_AUTHORIZATION_FAILED, no members) while OffsetFetch answers the committed offsets the
  // principal may read, and a principal that lists groups by its Describe on the cluster alone is
  // refused both reads of every group (GROUP_AUTHORIZATION_FAILED).
  const TOPIC_REFUSAL = "The broker denied access to this topic";
  const GROUP_REFUSAL = "The broker denied access to this group";
  const listing = { groupId: "billing", state: "Stable", groupType: "consumer" as const, protocolType: "consumer" };
  const description = {
    groupId: "billing",
    groupType: "consumer" as const,
    state: "Stable",
    protocolOrAssignor: "uniform",
    members: [
      {
        memberId: "m-1",
        clientId: "c-1",
        clientHost: "/10.0.0.1",
        assignment: [
          { topic: "orders", partitions: [0, 1] },
          { topic: "events", partitions: [0] },
        ],
      },
    ],
  };
  const refusedWith = (message: string) => async (): Promise<never> => {
    throw new KafkaError("authorization", message);
  };
  /** A client over one listed group, recording each high watermark it is asked for. */
  const recording = (over: Partial<GroupClient> = {}) => {
    const reads: string[] = [];
    const client: GroupClient = {
      listGroups: async () => [listing],
      describeGroup: async () => description,
      committedOffsets: async () => [{ topic: "orders", partition: 0, offset: n(1) }],
      offsets: async (topic, at) => {
        reads.push(`${topic}@${at}`);
        return new Map([
          [0, n(24)],
          [1, n(12)],
        ]);
      },
      ...over,
    };
    return { client, reads };
  };

  test("a description the broker refuses is the group part's refusal, and the lag is the committed offsets' alone, with no assignment", async () => {
    const { client, reads } = recording({ describeGroup: refusedWith(TOPIC_REFUSAL) });
    const source = await readGroupSource(client, "billing");
    expect(source?.group).toEqual({ refused: TOPIC_REFUSAL });
    // Every partition of the committed topic, each to its high watermark; the assigned-only topic is
    // not known, since the refused description holds no assignment.
    expect(source?.lag).toEqual({
      answer: [
        { topic: "orders", partition: 0, committedOffset: "1", latestOffset: "24", lag: "23" },
        {
          topic: "orders",
          partition: 1,
          committedOffset: null,
          latestOffset: "12",
          lag: null,
          note: "no committed offset",
        },
      ],
    });
    expect(reads).toEqual(["orders@high-watermark"]);
    // The control: the description answered, its assigned-only topic is read and has its rows.
    const control = recording();
    const whole = answered(await readGroupSource(control.client, "billing"));
    expect(whole.group).toBe(description);
    expect(control.reads.sort()).toEqual(["events@high-watermark", "orders@high-watermark"]);
    expect(whole.lag.map((row) => `${row.topic}/${row.partition}`)).toEqual([
      "events/0",
      "events/1",
      "orders/0",
      "orders/1",
    ]);
  });

  test("committed offsets the broker refuses are the lag part's refusal, beside the description as the client answered it, and no high watermark is read", async () => {
    const { client, reads } = recording({ committedOffsets: refusedWith(GROUP_REFUSAL) });
    const source = await readGroupSource(client, "billing");
    expect(source?.lag).toEqual({ refused: GROUP_REFUSAL });
    // The description is handed on as the client answered it, the very object.
    if (source === undefined || !("answer" in source.group)) throw new Error("the description was not answered");
    expect(source.group.answer).toBe(description);
    // Lag with no committed offset read would show every assigned partition as "no committed
    // offset", which the broker never said, so no high watermark is read for it.
    expect(reads).toEqual([]);
  });

  test("a group both of whose reads the broker refuses answers two refusals, each in its own read's words", async () => {
    const { client, reads } = recording({
      describeGroup: refusedWith(TOPIC_REFUSAL),
      committedOffsets: refusedWith(GROUP_REFUSAL),
    });
    expect(await readGroupSource(client, "billing")).toEqual({
      group: { refused: TOPIC_REFUSAL },
      lag: { refused: GROUP_REFUSAL },
    });
    expect(reads).toEqual([]);
  });

  test("a refused part never hides the other read's failure: the source fails with it", async () => {
    const failure = new KafkaError("network", "The broker could not be reached (connection-lost)");
    const failing = async (): Promise<never> => {
      throw failure;
    };
    const outcomes = await Promise.all([
      readGroupSource(
        recording({ describeGroup: refusedWith(TOPIC_REFUSAL), committedOffsets: failing }).client,
        "billing",
      ).catch((error) => error),
      readGroupSource(
        recording({ describeGroup: failing, committedOffsets: refusedWith(GROUP_REFUSAL) }).client,
        "billing",
      ).catch((error) => error),
    ]);
    expect(outcomes).toEqual([failure, failure]);
    expect(outcomes.every((error) => error === failure)).toBe(true);
  });
});
