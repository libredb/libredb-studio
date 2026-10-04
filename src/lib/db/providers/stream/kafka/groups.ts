/**
 * Consumer groups and lag (spec 4.3). Existence comes from the listing: the classic
 * DescribeGroups call answers "Dead" for a name that does not exist rather than an
 * error (measured M-E), so describing first would invent a group.
 */
import {
  BIGINT_ZERO,
  KafkaError,
  type KafkaCommittedOffset,
  type KafkaGroupDescription,
  type KafkaReadClient,
  type PartRead,
  partRead,
} from "./client";

export interface LagRow {
  readonly topic: string;
  readonly partition: number;
  readonly committedOffset: string | null;
  readonly latestOffset: string | null;
  readonly lag: string | null;
  /** Why a figure is missing, in words: "no committed offset", or why the latest offset was not read. */
  readonly note?: string;
}

const NO_COMMITTED_OFFSET = "no committed offset";

/**
 * Lag per partition (spec 4.3): the high watermark minus the committed offset, for every
 * partition of each topic the group has committed on or is assigned. A partition with no
 * committed offset is a row with lag null and a note, never 0 and never the whole log. A
 * topic whose latest offsets could not be read (`unreadable`, topic to reason) keeps its
 * rows, with no latest offset and the reason. Pure.
 */
export function computeLag(
  committed: readonly KafkaCommittedOffset[],
  latest: ReadonlyMap<string, ReadonlyMap<number, bigint>>,
  assigned: ReadonlyArray<{ readonly topic: string; readonly partitions: readonly number[] }> = [],
  unreadable: ReadonlyMap<string, string> = new Map(),
): LagRow[] {
  const rows = new Map<string, { topic: string; partition: number; committed?: bigint }>();
  const add = (topic: string, partition: number, offset?: bigint) => {
    const key = `${topic}/${partition}`;
    const existing = rows.get(key);
    if (existing === undefined) rows.set(key, { topic, partition, committed: offset });
    else if (offset !== undefined) existing.committed = offset;
  };
  for (const entry of committed)
    add(entry.topic, entry.partition, entry.offset < BIGINT_ZERO ? undefined : entry.offset);
  for (const { topic, partitions } of assigned) for (const partition of partitions) add(topic, partition);
  for (const topic of new Set([...committed.map((c) => c.topic), ...assigned.map((a) => a.topic)])) {
    for (const partition of latest.get(topic)?.keys() ?? []) add(topic, partition);
  }
  return [...rows.values()]
    .map(({ topic, partition, committed: offset }): LagRow => {
      const committedOffset = offset === undefined ? null : offset.toString();
      const reason = unreadable.get(topic);
      if (reason !== undefined) {
        return {
          topic,
          partition,
          committedOffset,
          latestOffset: null,
          lag: null,
          note: `latest offset not read: ${reason}`,
        };
      }
      const end = latest.get(topic)?.get(partition);
      const latestOffset = end === undefined ? null : end.toString();
      if (offset === undefined)
        return { topic, partition, committedOffset, latestOffset, lag: null, note: NO_COMMITTED_OFFSET };
      if (end === undefined) {
        return {
          topic,
          partition,
          committedOffset,
          latestOffset,
          lag: null,
          note: "the broker reported no latest offset for this partition",
        };
      }
      return { topic, partition, committedOffset, latestOffset, lag: (end - offset).toString() };
    })
    .sort((a, b) => (a.topic === b.topic ? a.partition - b.partition : a.topic < b.topic ? -1 : 1));
}

export type GroupClient = Pick<KafkaReadClient, "listGroups" | "describeGroup" | "committedOffsets" | "offsets">;

/**
 * A listed group's two parts (spec 4.4), each as its own read came to: the description, and the lag
 * over the committed offsets. The broker's refusal of either read is that part's answer and the other
 * part is kept: Apache Kafka 4.3.1 refuses a consumer-protocol group's description whole while a
 * member holds a topic the principal may not describe, and still answers its committed offsets, and a
 * principal that lists groups by its Describe on the cluster alone is refused both (measured). The
 * listing decides the group exists, so its refusal, and every failure that is no refusal, still raise.
 */
export async function readGroupSource(
  client: GroupClient,
  groupId: string,
): Promise<{ group: PartRead<KafkaGroupDescription>; lag: PartRead<LagRow[]> } | undefined> {
  const listing = (await client.listGroups()).find((g) => g.groupId === groupId);
  if (listing === undefined) return undefined;
  const [group, committedRead] = await Promise.all([
    partRead(() => client.describeGroup(listing)),
    partRead(() => client.committedOffsets(groupId)),
  ]);
  // Lag with no committed offset read would call every assigned partition uncommitted, which the
  // broker never said: the lag part is the refusal, and no high watermark is read for it.
  if ("refused" in committedRead) return { group, lag: committedRead };
  const committed = committedRead.answer;
  // A refused description holds no assignment: the rows are the committed topics' alone.
  const assigned = "answer" in group ? group.answer.members.flatMap((member) => member.assignment) : [];
  const topics = [...new Set([...committed.map((c) => c.topic), ...assigned.map((a) => a.topic)])];
  const latest = new Map<string, ReadonlyMap<number, bigint>>();
  const unreadable = new Map<string, string>();
  await Promise.all(
    topics.map(async (topic) => {
      try {
        // The high watermark, which is what kafka-consumer-groups.sh measures lag against.
        latest.set(topic, await client.offsets(topic, "high-watermark"));
      } catch (error) {
        // An internal topic, one with a leaderless partition, or an assigned one the principal may
        // not describe, whose refusal is an answer (docs/ADDING_A_PROVIDER.md): its rows stay,
        // without a latest offset and with the reason. Anything else fails the source.
        const keepsRows =
          error instanceof KafkaError && (error.category === "unreadable-topic" || error.category === "authorization");
        if (!keepsRows) throw error;
        unreadable.set(topic, error.message);
      }
    }),
  );
  return { group, lag: { answer: computeLag(committed, latest, assigned, unreadable) } };
}
