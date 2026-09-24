/**
 * Resolves each partition's start offset and runs the bounded fetch loop (spec 5.1,
 * 5.4). `maxBytes` does not bound a response (measured M-G: a 1024-byte limit still
 * returned a 900,000-byte record), so the bounds here are the provider's own: the row
 * limit, a budget over the record bytes the result holds, and a per-cell limit.
 *
 * Each record is shaped once, as it arrives, and only its row is kept: no record's
 * buffers outlive the fetch that brought them (spec K5).
 *
 * The read holds, at every point, only the rows it would answer if it ended there: at most
 * `limit`, the first in result order, or the last for "latest". A row that falls out of them
 * can never be chosen again, since later records only add rows to choose from, so it is
 * dropped as it falls out, and a record that would sort past them is never shaped. The
 * budget counts the record bytes of the rows held, which are the bytes the result holds,
 * never a row the merge dropped (spec 5.4, K5).
 *
 * The partitions are read one after another, each forward from its start, so the budget
 * stops a read inside one partition and the partitions after it are never fetched, whatever
 * the `from` form; the budget's warning names the offset it stopped before and the
 * partitions it did not read.
 *
 * No offset is ever invented. A partition that an offsets answer leaves out has no offset
 * to start or end at, so the read is refused naming it before any fetch, and a fetch that
 * makes no progress below a partition's end stops that partition, never spins, and the
 * result says where it stopped.
 */
import { BIGINT_ZERO, KafkaError, type KafkaReadClient, type KafkaRecord, type KafkaTopicMetadata } from "./client";
import type { ReadRequest, ReadStart } from "./request";
import { compareRecords, type RecordOrder, shapeRecord } from "./results";

/** Record bytes (keys, values, header names and values, after decompression) across the whole result; set in the live pass (KM2). */
export const KAFKA_RESULT_BYTE_BUDGET = 8 * 1024 * 1024;
/** Rendered characters in one cell; set in the live pass (KM2). */
export const KAFKA_CELL_LIMIT = 64 * 1024;

export type ReadClient = Pick<KafkaReadClient, "metadata" | "offsets" | "offsetsForTimestamp" | "fetch">;

export interface ReadLimits {
  readonly resultByteBudget: number;
  readonly cellLimit: number;
}

export interface ReadOutcome {
  readonly rows: Record<string, unknown>[];
  readonly warnings: { message: string }[];
  readonly wasLimited: boolean;
}

interface PartitionPlan {
  readonly partition: number;
  readonly start: bigint;
  readonly end: bigint;
}

/** A partition whose fetch at `at` made no progress, below the `end` it was being read to. */
interface StoppedShort {
  readonly partition: number;
  readonly at: bigint;
  readonly end: bigint;
}

/**
 * Where the result budget stopped a read: before the record at `at` in `partition`. The
 * partitions are read one after another, so the ones after it, `unread`, were never fetched.
 */
interface BudgetStop {
  readonly partition: number;
  readonly at: bigint;
  readonly unread: readonly number[];
}

/** A shaped row, the three fields it is ordered by, and its record's bytes; the record itself is not kept. */
interface Collected extends RecordOrder {
  readonly row: Record<string, unknown>;
  readonly truncatedCells: number;
  /** The record bytes the row stands for, which the result budget counts while the row is held. */
  readonly bytes: number;
}

/**
 * The rows the result would answer if the read ended now, in result order (spec 5.2): at most
 * `limit` of the records read so far, the first in that order, or for "latest" the last
 * (spec 5.1). `bytes` is what they hold, which is what the result budget counts (spec 5.4).
 */
interface HeldRows {
  readonly limit: number;
  /** "latest" keeps the last `limit` rows in result order; every other form keeps the first. */
  readonly keepLast: boolean;
  readonly rows: Collected[];
  bytes: number;
  /** Whether the merge left a row out: one that fell out of the rows held, or never came in. */
  dropped: boolean;
}

/**
 * Where one partition's read starts (spec 5.1): its earliest offset; for "latest", `limit`
 * before its end, never before its earliest; the caller's offset, which must lie in
 * [earliest, end]; or the first offset at or after the timestamp. Undefined when no message
 * at or after the timestamp lies below the end, which contributes no rows: the broker answers
 * -1 past the log end, and an offset at or past `end` lies past the end this read stops at.
 * A timestamp read the broker gave no offset for is refused, never taken for past the end,
 * which would say something the broker did not. Pure.
 */
export function startOffset(
  from: ReadStart,
  partition: number,
  earliest: bigint,
  end: bigint,
  limit: number,
  atTimestamp: bigint | undefined,
): bigint | undefined {
  switch (from.kind) {
    case "earliest":
      return earliest;
    case "latest": {
      const back = end - BigInt(limit);
      return back > earliest ? back : earliest;
    }
    case "offset":
      if (from.offset < earliest || from.offset > end) {
        throw new KafkaError(
          "offset-out-of-range",
          `Offset ${from.offset} is outside partition ${partition}'s range ${earliest} to ${end}`,
          {
            validRange: { earliest, latest: end },
          },
        );
      }
      return from.offset;
    case "timestamp":
      if (atTimestamp === undefined) {
        throw new KafkaError(
          "unreadable-topic",
          `The broker reported no timestamp offset for partition ${partition}; run the read again`,
        );
      }
      return atTimestamp < BIGINT_ZERO || atTimestamp >= end ? undefined : atTimestamp;
  }
}

/** The warnings a read owes its reader (spec 5.4): every truncation says what was cut. Pure. */
export function readWarnings(input: {
  readonly pastEnd: readonly number[];
  readonly stoppedShort: readonly StoppedShort[];
  readonly budgetStop: BudgetStop | undefined;
  readonly truncatedCells: number;
  readonly limits: ReadLimits;
}): { message: string }[] {
  const warnings: { message: string }[] = [];
  if (input.pastEnd.length > 0) {
    warnings.push({ message: `No message at or after the timestamp on partition ${input.pastEnd.join(", ")}` });
  }
  if (input.stoppedShort.length > 0) {
    const where = input.stoppedShort.map(
      (s) => `for partition ${s.partition} at offset ${s.at}, below its end at ${s.end}`,
    );
    warnings.push({
      message: `The broker answered no records ${where.join(", and ")}, so the read stopped there; run it again`,
    });
  }
  if (input.budgetStop !== undefined) {
    const { partition, at, unread } = input.budgetStop;
    const budget = input.limits.resultByteBudget.toLocaleString("en-US");
    const skipped = unread.length > 0 ? `, and did not read partition ${unread.join(", ")}` : "";
    warnings.push({
      message: `The read stopped before offset ${at} of partition ${partition}, at the result budget of ${budget} bytes of record data${skipped}; narrow it with a partition, an offset or a smaller limit`,
    });
  }
  if (input.truncatedCells > 0) {
    warnings.push({
      message: `${input.truncatedCells} cell(s) were cut at ${input.limits.cellLimit.toLocaleString("en-US")} characters`,
    });
  }
  return warnings;
}

/** The bytes one record holds after decompression, which is what the result budget counts. */
function recordBytes(record: KafkaRecord): number {
  let bytes = (record.key?.byteLength ?? 0) + (record.value?.byteLength ?? 0);
  for (const [name, value] of record.headers) bytes += (name?.byteLength ?? 0) + (value?.byteLength ?? 0);
  return bytes;
}

/** Where `order` goes among rows in result order: after every row that sorts before it. */
function insertionIndex(rows: readonly RecordOrder[], order: RecordOrder): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareRecords(rows[middle], order) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Offers one record to the rows held. When they are full, the row at their far end leaves as
 * the record comes in, and a record that would sort past that end is the one the merge drops:
 * it is never shaped and never counted. Answers false, holding nothing, when the rows held
 * would then pass the result budget; the read's first record is always held, however large,
 * so an oversized record still answers one row, cut at the cell limit (spec 5.4).
 */
function hold(held: HeldRows, record: KafkaRecord, limits: ReadLimits): boolean {
  const at = insertionIndex(held.rows, record);
  const full = held.rows.length === held.limit;
  if (full && at === (held.keepLast ? 0 : held.limit)) {
    held.dropped = true;
    return true;
  }
  const leaving = full ? held.rows[held.keepLast ? 0 : held.limit - 1] : undefined;
  const bytes = recordBytes(record);
  if (held.rows.length > 0 && held.bytes - (leaving?.bytes ?? 0) + bytes > limits.resultByteBudget) return false;
  const shaped = shapeRecord(record, limits);
  held.rows.splice(at, 0, {
    partition: record.partition,
    offset: record.offset,
    timestamp: record.timestamp,
    row: shaped.row,
    truncatedCells: shaped.truncatedCells,
    bytes,
  });
  held.bytes += bytes;
  if (leaving !== undefined) {
    held.rows.splice(held.rows.indexOf(leaving), 1);
    held.bytes -= leaving.bytes;
    held.dropped = true;
  }
  return true;
}

export async function readMessages(
  client: ReadClient,
  request: ReadRequest,
  limits: ReadLimits,
  signal: AbortSignal,
): Promise<ReadOutcome> {
  const metadata = await client.metadata([request.topic]);
  const topic = metadata.topics.find((t) => t.name === request.topic);
  if (topic === undefined)
    throw new KafkaError("unknown-topic", `Topic ${JSON.stringify(request.topic)} does not exist`);

  const { plans, pastEnd } = await planPartitions(client, topic, request);

  // Up to `limit` records of each partition, merged as they arrive: the first (or, for
  // "latest", the last) `limit` records overall are among each partition's first (or last)
  // `limit`, and the rows held are the first (or last) `limit` of those read so far.
  const held: HeldRows = {
    limit: request.limit,
    keepLast: request.from.kind === "latest",
    rows: [],
    bytes: 0,
    dropped: false,
  };
  const stoppedShort: StoppedShort[] = [];
  let budgetStop: BudgetStop | undefined;
  let partitionCut = false;
  for (const [index, plan] of plans.entries()) {
    let position = plan.start;
    let taken = 0;
    while (position < plan.end && taken < request.limit && budgetStop === undefined) {
      if (signal.aborted) throw new KafkaError("timeout", "The read ran past its time limit and was stopped");
      // oxlint-disable-next-line no-await-in-loop -- each fetch starts where the one before it ended.
      const { records, nextOffset } = await client.fetch(topic, plan.partition, position, signal);
      for (const record of records) {
        if (record.offset >= plan.end) break;
        if (taken >= request.limit) {
          // A record below the end is left unread, whatever the loop does next.
          partitionCut = true;
          break;
        }
        // The budget stops the whole read here: no later record of this partition, and no
        // later partition.
        if (!hold(held, record, limits)) {
          const unread = plans.slice(index + 1).map((later) => later.partition);
          budgetStop = { partition: plan.partition, at: record.offset, unread };
          break;
        }
        taken++;
      }
      if (nextOffset <= position) {
        // No progress below the end: the broker answered nothing there. Stop rather than
        // spin, and say where, because the offsets from here to the end were not read.
        stoppedShort.push({ partition: plan.partition, at: position, end: plan.end });
        break;
      }
      position = nextOffset;
    }
    // The limit landed on the last record of a fetch that stopped short of the partition's end.
    if (taken >= request.limit && position < plan.end) partitionCut = true;
  }

  const truncatedCells = held.rows.reduce((sum, entry) => sum + entry.truncatedCells, 0);
  return {
    rows: held.rows.map((entry) => entry.row),
    warnings: readWarnings({ pastEnd, stoppedShort, budgetStop, truncatedCells, limits }),
    wasLimited:
      budgetStop !== undefined || truncatedCells > 0 || held.dropped || partitionCut || stoppedShort.length > 0,
  };
}

/**
 * One answer's offset for each wanted partition, in order, and the partitions it left out:
 * a partition the answer does not name has no offset there, and none is invented for it.
 * When it leaves none out, `offsets[i]` is the offset of `wanted[i]`.
 */
function offsetsOf(
  answer: ReadonlyMap<number, bigint>,
  wanted: readonly number[],
): { offsets: bigint[]; left: number[] } {
  const offsets: bigint[] = [];
  const left: number[] = [];
  for (const partition of wanted) {
    const offset = answer.get(partition);
    if (offset === undefined) left.push(partition);
    else offsets.push(offset);
  }
  return { offsets, left };
}

async function planPartitions(
  client: ReadClient,
  topic: KafkaTopicMetadata,
  request: ReadRequest,
): Promise<{ plans: PartitionPlan[]; pastEnd: number[] }> {
  const count = topic.partitions.length;
  if (request.partition !== undefined && request.partition >= count) {
    const held = count === 0 ? "no partitions" : `partitions 0 to ${count - 1}`;
    throw new KafkaError(
      "invalid-request",
      `Topic ${JSON.stringify(topic.name)} has ${held}; partition ${request.partition} does not exist`,
    );
  }
  // Review Focus 1: the client reads a topic's offsets as a whole, and its reads fail while
  // any partition has no leader, so no partition of this topic can be planned (spec 4.1).
  const leaderless = topic.partitions.filter((p) => p.leader < 0).map((p) => p.partition);
  if (leaderless.length > 0) {
    throw new KafkaError(
      "unreadable-topic",
      `Topic ${JSON.stringify(topic.name)} has no leader for partition ${leaderless.join(", ")}; the client reads a topic's offsets as a whole, so the topic cannot be read until every partition has a leader`,
    );
  }
  const wanted = topic.partitions
    .map((p) => p.partition)
    .filter((partition) => request.partition === undefined || partition === request.partition);
  // The end is read last, after every start: a record written while the read is positioned
  // then lies inside it, and the first offset at a timestamp lies below the end.
  const earliest = offsetsOf(await client.offsets(topic.name, "earliest"), wanted);
  const byTimestamp =
    request.from.kind === "timestamp"
      ? offsetsOf(await client.offsetsForTimestamp(topic.name, request.from.timestampMs), wanted)
      : undefined;
  const latest = offsetsOf(await client.offsets(topic.name, "latest"), wanted);

  const answers: ReadonlyArray<readonly [string, readonly number[]]> = [
    ["earliest", earliest.left],
    ["timestamp", byTimestamp?.left ?? []],
    ["latest", latest.left],
  ];
  const gaps = answers
    .filter(([, left]) => left.length > 0)
    .map(([answer, left]) => `no ${answer} offset for partition ${left.join(", ")}`);
  if (gaps.length > 0) {
    throw new KafkaError(
      "unreadable-topic",
      `Topic ${JSON.stringify(topic.name)} cannot be read: the broker reported ${gaps.join(", and ")}; run the read again, or name a partition it reported offsets for`,
    );
  }

  const plans: PartitionPlan[] = [];
  const pastEnd: number[] = [];
  wanted.forEach((partition, index) => {
    const end = latest.offsets[index];
    const start = startOffset(
      request.from,
      partition,
      earliest.offsets[index],
      end,
      request.limit,
      byTimestamp?.offsets[index],
    );
    if (start === undefined) pastEnd.push(partition);
    // A partition with no offset from its start to its end holds nothing to read, so it has
    // no plan: it is never fetched, and never named as a partition a read left unread.
    else if (start < end) plans.push({ partition, start, end });
  });
  return { plans, pastEnd };
}
