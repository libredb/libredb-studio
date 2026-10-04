/**
 * The Oxia provider's walks, the only module that sequences calls over `OxiaClient` (SB1-12 R1): the order probe, the
 * Keys panel's cursor pages, the console's list and range-scan walks, point and comparison reads, folder discovery,
 * and the client wrapper that takes one engine permit per shard call.
 *
 * Every page is exact under the merge bound because a walk merges only keys it read (SB1-7.10): a stream cut for any
 * reason (its count, its byte limit, its kept-bytes share, a cancel) is an incomplete shard, and `merge.ts` emits
 * nothing above an incomplete shard's last key. Every byte bound is read from `constants.ts`. A walk keeps at most
 * eight calls in flight through its own pool, and `limitedOxiaClient` takes one permit per call, so no pool slot waits
 * for a permit while it holds one (SB1-9.1).
 *
 * A console walk that merges across shards keeps its keys under the run budget's share, round after round, and a walk
 * over records reads the values of those keys afterwards, in key order, one Read at a time (ruling R23), so a run keeps
 * at most its budget plus one key per shard whatever the shard count. A round reads only the shards whose frontier the
 * last merge reached; the others keep the keys it did not reach (ruling R25).
 *
 * No walk takes a limiter and no walk reads the order itself: callers pass the limited client and the verdict.
 */
import { QueryError } from "@/lib/db/errors";
import type { LimiterTicket, ProviderLimiter } from "@/lib/db/utils/bounded-limiter";
import type {
  OxiaCallOptions,
  OxiaClient,
  OxiaComparison,
  OxiaGet,
  OxiaKeysAnswer,
  OxiaRange,
  OxiaRecord,
  OxiaRecordView,
  OxiaRecordsAnswer,
  OxiaRpc,
  OxiaShard,
  OxiaSnapshot,
  OxiaStream,
  OxiaStreamOptions,
  OxiaVersion,
} from "./client";
import {
  OXIA_DISCOVERY_DEADLINE_MS,
  OXIA_DISCOVERY_MAX_CALLS,
  OXIA_DISCOVERY_MAX_ROUNDS,
  OXIA_MAX_SHARD_STREAMS,
  OXIA_ORDER_PROBE_BYTES,
  OXIA_ORDER_SAMPLE_KEYS,
  OXIA_PAGE_KEPT_BYTES,
  OXIA_PAGE_STREAM_BYTES,
  OXIA_READ_BATCH_GETS,
  OXIA_RUN_BYTE_BUDGET,
  OXIA_TYPE,
} from "./constants";
import { OXIA_STALLED_PAGE_SENTENCE, OxiaError } from "./errors";
import { mergePage, selectComparison } from "./merge";
import {
  childrenRange,
  decideFromList,
  decideFromPairs,
  decideFromProbe,
  hierarchicalLevel,
  type KeyOrder,
  keyComparator,
  maxLevel,
  naturalChildrenRange,
  naturalPrefixEnd,
  nextDiscoveryProbe,
  ORDER_PROBE_GETS,
  type OrderVerdict,
  prefixBands,
  topNode,
} from "./order";
import { shardFor } from "./routing";

/** What index.ts hands execute.ts, key-scan.ts, objects.ts and monitoring-reads.ts. */
export interface OxiaSurface {
  /** Already limited (limitedOxiaClient): every call takes one permit. */
  readonly client: OxiaClient;
  /** The validated, admitted snapshot under the brief cache (SB1-5.3). */
  snapshot(call: OxiaCallOptions): Promise<OxiaSnapshot>;
  /** The order verdict: a decided one is kept for the provider's life; `empty` and `assumed` are probed again on every call (SB1-7.2). */
  order(call: OxiaCallOptions): Promise<OrderVerdict>;
}

export interface OxiaConsoleAsk {
  readonly range: OxiaRange;
  readonly partitionKey?: string;
  readonly index?: string;
  readonly limit: number;
}

/** A key read wherever it is stored: its record, or the number of shards holding it when that is not one (ruling R33). */
export type KeyAnywhere = { readonly record: OxiaRecordView } | { readonly holders: number };

export interface DiscoveryResult {
  /** Representative keys, one per top-level node, in the order found. */
  readonly representatives: readonly string[];
  readonly complete: boolean;
  readonly rounds: number;
  readonly calls: number;
}

/** The Keys panel's cursor page over the whole namespace. */
interface FullWalkAsk {
  readonly cursor?: string;
  readonly count: number;
}

/** A Keys panel page under one node. */
interface ChildrenAsk {
  readonly parent: string;
  readonly cursor?: string;
  readonly count: number;
}

/** A Keys panel page of the keys that begin with a prefix. */
interface PrefixWalkAsk {
  readonly prefix: string;
  readonly cursor?: string;
  readonly count: number;
  readonly partitionKey?: string;
}

/** A console `--prefix` walk. */
interface PrefixConsoleAsk {
  readonly prefix: string;
  readonly partitionKey?: string;
  readonly limit: number;
}

/** One point read: an EQUAL get routed by its key or its partition key. */
interface PointGet {
  readonly key: string;
  readonly partitionKey?: string;
  readonly includeValue: boolean;
}

/** One comparison get: the fan-out, then the winner's value. */
interface ComparisonAsk {
  readonly key: string;
  readonly comparison: OxiaComparison;
  readonly partitionKey?: string;
  readonly index?: string;
  readonly includeValue: boolean;
}

/** One shard's read of a range: the items kept, whether its end was reached, whether the receive cap cut it. */
interface ShardItems<T> {
  readonly items: readonly T[];
  readonly complete: boolean;
  readonly receiveCap: boolean;
}

/** What one stream read keeps: after the cursor, by `keep`, up to `limit` items and `share` kept key bytes. */
interface StreamAsk {
  readonly cursor?: string;
  readonly keep: (key: string) => boolean;
  readonly limit: number;
  readonly share: number;
  readonly streamBytes: number;
}

type Merged = { readonly items: readonly string[]; readonly more: boolean } | { readonly stalled: true };

/** A shard's keys that an earlier round read and the merge has not reached yet, with their bytes, counted once. */
type Frontier = ShardItems<string> & { readonly bytes: number };

/** Each shard of a range's rounds, in the round's shard order: its frontier, or undefined when the next round reads it (ruling R25). */
type Frontiers = (Frontier | undefined)[];

/** A group's values in ask order, or, when the receive cap cut its Read, how many of its gets to read next. */
type GroupRead = readonly (OxiaRecordView | undefined)[] | number;

/** A walk's reader of one kind: keys over List, or an index walk's records over RangeScan. */
interface Source<T> {
  read(shard: OxiaShard, range: OxiaRange, ask: StreamAsk): Promise<ShardItems<T>>;
  /** The bytes an item costs the run budget. */
  sizeOf(item: T): number;
}

/** The key reader, which also merges its shards' keys under the bound. */
interface KeySource extends Source<string> {
  merge(shards: readonly ShardItems<string>[], count: number): Merged;
}

/** How a walk is bounded: the Keys panel's pages or the console's runs. */
interface WalkMode {
  /** The per-stream received limit. */
  readonly streamBytes: number;
  /** The page's kept-bytes budget, shared out across the shards of each round. */
  readonly keptBytes: number;
  /** The run budget over the kept items' bytes, checked after each item is kept. */
  readonly runBytes: number;
  /** A page that cannot progress throws the stalled sentence; a console run ends there instead (SB1-9.3a). */
  readonly stallThrows: boolean;
  /** A console run reads on from its last kept key while its range has more and it has room (ruling R23). */
  readonly readsOn: boolean;
}

interface Walk<T> {
  readonly source: Source<T>;
  readonly mode: WalkMode;
}

/** A walk over keys; over records, the keys come first and `values` reads theirs after them (ruling R23). */
interface KeyWalk extends Walk<string> {
  readonly source: KeySource;
  readonly order: KeyOrder;
  readonly values?: Values;
}

/** The second phase of a console walk over records (ruling R23): the values of its kept keys, in key order. */
interface Values {
  readonly client: OxiaClient;
  readonly call: OxiaCallOptions;
  /** The records answered; the key walk asks one key more, to know whether more exist. */
  readonly limit: number;
  readonly records: OxiaRecordView[];
  /** The first kept key whose value is not read yet. */
  next: number;
}

/** A key the walk found with a get, and the shard that answered it (ruling R32). */
interface Found {
  readonly key: string;
  readonly shard: OxiaShard;
}

/** One round: every shard reads one range, plus a shard that holds the round's extra keys, complete. */
interface Round {
  readonly shards: readonly OxiaShard[];
  readonly range: OxiaRange;
  readonly cursor?: string;
  readonly keep: (key: string) => boolean;
  readonly extra: readonly Found[];
  readonly count: number;
}

/** A walk's answer as it grows, round by round. */
interface Run<T> {
  readonly items: T[];
  /** A key walk's shard that listed or answered each kept key, by position (ruling R32). */
  readonly homes: OxiaShard[];
  spent: number;
  more: boolean;
  /** The run budget, or a console stall, ended it. */
  stopped: boolean;
  receiveCap: boolean;
}

/** One shard's answers to the order probe's two gets. */
interface ProbeAnswer {
  readonly shard: OxiaShard;
  readonly ceiling?: string;
  readonly floor?: string;
}

/** One shard's first message of the order probe's pair sample. */
interface ShardSample {
  readonly shard: OxiaShard;
  readonly keys: readonly string[];
  readonly slashed?: string;
  readonly last?: string;
  readonly ended: boolean;
}

/** One shard's reading on past its sample (SB1-7.2 step 6). */
interface ReadOn {
  readonly shard: OxiaShard;
  readonly slashed?: string;
  readonly ended: boolean;
}

/** The order probe's shared state: the bytes every stream received, and whether a key with "/" turned up. */
interface OrderProbe {
  received: number;
  found: boolean;
}

/** Discovery's counts and its representatives, kept across a deadline that ends it. */
interface Discovery {
  rounds: number;
  calls: number;
  readonly found: Map<string, string>;
  readonly deadline: number;
}

const PAGE_MODE: WalkMode = {
  streamBytes: OXIA_PAGE_STREAM_BYTES,
  keptBytes: OXIA_PAGE_KEPT_BYTES,
  runBytes: Number.POSITIVE_INFINITY,
  stallThrows: true,
  readsOn: false,
};

const CONSOLE_MODE: WalkMode = {
  streamBytes: OXIA_RUN_BYTE_BUDGET,
  keptBytes: OXIA_RUN_BYTE_BUDGET,
  runBytes: OXIA_RUN_BYTE_BUDGET,
  stallThrows: false,
  readsOn: true,
};

const always = () => true;

/** UTF-8 length by a loop over UTF-16 code units, with no encoder allocation. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const pair = unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;
    if (pair) i++;
  }
  return bytes;
}

/**
 * Runs `work` over `items` with at most OXIA_MAX_SHARD_STREAMS in flight, answering in item order. On the first
 * failure it starts no new item and rethrows that failure once the running ones settle.
 */
async function pool<I, O>(items: readonly I[], work: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const runner = async () => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one slot of the pool: its next shard waits for its last.
        out[index] = await work(items[index]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(OXIA_MAX_SHARD_STREAMS, items.length) }, runner));
  if (failure !== undefined) throw failure.error;
  return out;
}

/** The one shard of a partition key, else every shard. */
function shardsOf(snapshot: OxiaSnapshot, partitionKey: string | undefined): readonly OxiaShard[] {
  return partitionKey === undefined ? snapshot.shards : [shardFor(snapshot, "", partitionKey)];
}

/** Runs one of merge.ts's pure steps: its server-defect RangeError is a malformed answer of `rpc`. */
function guard<T>(rpc: OxiaRpc, step: () => T): T {
  try {
    return step();
  } catch (error) {
    throw error instanceof RangeError ? new OxiaError("malformed", { rpc }) : error;
  }
}

const isReceiveCap = (error: unknown) => error instanceof OxiaError && error.category === "receive-cap";
const okKey = (record: OxiaRecord | undefined) => (record?.status === "OK" ? record.key : undefined);
const equalGet = (key: string, includeValue: boolean): OxiaGet => ({ key, comparison: "EQUAL", includeValue });

/**
 * Reads one stream message by message: drops the cursor, keeps an item when `keep` accepts its key while fewer than
 * `limit` are kept and the kept key bytes stay within `share` (the first kept item always), and stops as soon as it
 * would keep one more. Complete only when the server ended the stream and nothing was left unread; the stream is
 * cancelled in every case.
 */
async function readStream<R>(
  stream: OxiaStream<R>,
  keyOf: (item: R) => string,
  ask: StreamAsk,
  stopsAtReceiveCap: boolean,
): Promise<ShardItems<R>> {
  const items: R[] = [];
  let kept = 0;
  try {
    for (;;) {
      let message: readonly R[] | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one reader: each message waits for the one before it.
        message = await stream.next();
      } catch (error) {
        if (stopsAtReceiveCap && isReceiveCap(error)) return { items, complete: false, receiveCap: true };
        throw error;
      }
      if (message === undefined) return { items, complete: !stream.truncated, receiveCap: false };
      for (const item of message) {
        const key = keyOf(item);
        if (key === ask.cursor || !ask.keep(key)) continue;
        const bytes = utf8Length(key);
        if (items.length >= ask.limit || (items.length > 0 && kept + bytes > ask.share)) {
          return { items, complete: false, receiveCap: false };
        }
        items.push(item);
        kept += bytes;
      }
    }
  } finally {
    stream.cancel();
  }
}

function keySource(client: OxiaClient, order: KeyOrder, call: OxiaCallOptions): KeySource {
  return {
    read: (shard, range, ask) =>
      readStream(client.list(shard, range, { ...call, maxReceivedBytes: ask.streamBytes }), (key) => key, ask, false),
    merge(shards, count) {
      const merged = guard("List", () =>
        mergePage(
          shards.map((shard) => ({ keys: shard.items, complete: shard.complete })),
          order,
          count,
        ),
      );
      return "stalled" in merged ? merged : { items: merged.keys, more: merged.more };
    },
    sizeOf: utf8Length,
  };
}

function recordView(record: OxiaRecord, shard: OxiaShard): OxiaRecordView {
  return {
    key: record.key as string,
    ...(record.value === undefined ? {} : { value: record.value }),
    version: record.version as OxiaVersion,
    shard: shard.id,
  };
}

/** An index walk's records: RangeScan, whose receive cap ends that shard's read as a stop. */
function recordSource(client: OxiaClient, call: OxiaCallOptions): Source<OxiaRecordView> {
  return {
    async read(shard, range, ask) {
      const stream = client.rangeScan(shard, range, { ...call, maxReceivedBytes: ask.streamBytes });
      const read = await readStream(stream, (record) => record.key as string, ask, true);
      return { ...read, items: read.items.map((record) => recordView(record, shard)) };
    },
    sizeOf: (view) => utf8Length(view.key) + (view.value?.length ?? 0),
  };
}

const newRun = <T>(): Run<T> => ({ items: [], homes: [], spent: 0, more: false, stopped: false, receiveCap: false });

/** Ends a run that the run budget or a console stall stopped: more may exist. */
function stop<T>(run: Run<T>): false {
  run.stopped = true;
  run.more = true;
  return false;
}

/**
 * Appends a merged answer to the run under the run budget, checked after each item is kept, so a run always makes
 * progress: reaching it ends the run with `more`. Answers whether the walk goes on to its next round.
 */
function absorb<T>(run: Run<T>, merged: { readonly items: readonly T[]; readonly more: boolean }, walk: Walk<T>) {
  for (const item of merged.items) {
    run.items.push(item);
    run.spent += walk.source.sizeOf(item);
    if (run.spent >= walk.mode.runBytes) return stop(run);
  }
  run.more = merged.more;
  return !merged.more;
}

/** The kept key bytes of the shards whose frontier stands. */
function heldBytes(frontiers: Frontiers): number {
  let bytes = 0;
  for (const shard of frontiers) bytes += shard?.bytes ?? 0;
  return bytes;
}

/**
 * The frontiers a round starts from. When the run's kept keys and the standing shards' keys pass the budget, a standing
 * shard that holds more than one key is read again with the round's share, and one that holds a single key keeps it,
 * so a round never holds more than the budget plus one key per shard (ruling R23) however long its shards stood.
 */
function trimmed(frontiers: Frontiers, spent: number, budget: number): Frontiers {
  if (spent + heldBytes(frontiers) <= budget) return frontiers;
  return frontiers.map((shard) => (shard !== undefined && shard.items.length > 1 ? undefined : shard));
}

/** What each shard still holds after a merge: its keys the merge did not answer, or undefined when it must be read. */
function standing(shards: readonly (ShardItems<string> | Frontier)[], answered: readonly string[]): Frontiers {
  const emitted = new Set(answered);
  return shards.map((shard) => {
    // The merge answers each shard's least keys, so what it did not answer is the rest of that shard's keys.
    const at = shard.items.findIndex((key) => !emitted.has(key));
    if (at === 0 && "bytes" in shard) return shard;
    const left = at < 0 ? [] : shard.items.slice(at);
    const bytes = left.reduce((sum, key) => sum + utf8Length(key), 0);
    return left.length > 0 || shard.complete ? { ...shard, items: left, bytes } : undefined;
  });
}

/**
 * One round of a walk: the shards whose frontier the last merge reached, in parallel, each with an even share of what
 * the budget has left beside the keys the other shards still hold; then every shard's keys, merged under the bound,
 * kept under the budgets (ruling R25). A shard keeps the keys the merge did not reach for the next round of the same
 * range, in `frontiers`, and is read again only once it has none left and its end is not reached.
 */
async function round(walk: KeyWalk, ask: Round, run: Run<string>, frontiers: Frontiers = []): Promise<boolean> {
  const remaining = ask.count - run.items.length;
  const held = trimmed(frontiers, run.spent, walk.mode.keptBytes);
  const reading = ask.shards.filter((_, i) => held[i] === undefined);
  // A page's kept-bytes budget spans its rounds: a prefix page's later bands share what the earlier ones left.
  const share = Math.floor((walk.mode.keptBytes - run.spent - heldBytes(held)) / reading.length);
  const select = {
    cursor: ask.cursor,
    keep: ask.keep,
    limit: remaining + 1,
    share,
    streamBytes: walk.mode.streamBytes,
  };
  const reads = await pool(reading, (shard) => walk.source.read(shard, ask.range, select));
  run.receiveCap ||= reads.some((read) => read.receiveCap);
  let read = 0;
  const shards = ask.shards.map((_, i) => held[i] ?? reads[read++]);
  const extra = ask.extra.map((found) => found.key);
  const merged = walk.source.merge([...shards, { items: extra, complete: true, receiveCap: false }], remaining);
  if (!("stalled" in merged)) {
    frontiers.splice(0, frontiers.length, ...standing(shards, merged.items));
    const homes = homesOf(
      [...shards.map((shard) => shard.items), extra],
      (input, at) => ask.shards[input] ?? ask.extra[at].shard,
      merged.items,
    );
    const before = run.items.length;
    const goes = absorb(run, merged, walk);
    for (let i = 0; i < run.items.length - before; i++) run.homes.push(homes[i]);
    return goes;
  }
  if (walk.mode.stallThrows) throw new QueryError(OXIA_STALLED_PAGE_SENTENCE, OXIA_TYPE);
  return stop(run);
}

/**
 * The shard each merged key is read on (rulings R32 and R38). The merge answers each input's least keys in order, and
 * a key once however many inputs hold it, so a key answered is the next one of every input whose answered keys hold
 * it; of those inputs' shards, the lowest id.
 */
function homesOf(
  inputs: readonly (readonly string[])[],
  home: (input: number, at: number) => OxiaShard,
  answered: readonly string[],
): OxiaShard[] {
  const emitted = new Set(answered);
  const holders = new Map<string, number[]>();
  inputs.forEach((items, input) => {
    for (const key of items) {
      if (!emitted.has(key)) break;
      const at = holders.get(key);
      if (at === undefined) holders.set(key, [input]);
      else at.push(input);
    }
  });
  const next = inputs.map(() => 0);
  return answered.map((key) => lowest((holders.get(key) as number[]).map((input) => home(input, next[input]++))));
}

/** The shard of the lowest id among `shards`, which holds at least one. */
const lowest = (shards: readonly OxiaShard[]): OxiaShard => [...shards].sort(byShardId)[0];

/** The kept keys from `values.next` up to `end` that the same shard listed, at most `most` gets: the next group. */
function nextGroup(values: Values, run: Run<string>, end: number, most: number): readonly string[] {
  const shard = run.homes[values.next];
  let to = values.next + 1;
  while (to < end && to - values.next < most && run.homes[to] === shard) to++;
  return run.items.slice(values.next, to);
}

/**
 * One Read of a group's values. A receive-cap failure answers how many gets arrived before it (C13) instead of
 * resuming, so the caller reads those as the next group (one get when none arrived: a group is never empty) and checks
 * the run budget before reading on; a single get takes `readBatch`, which answers it withheld when it alone passes the
 * cap.
 */
async function readGroup(
  values: Values,
  shard: OxiaShard,
  group: readonly string[],
  call: OxiaCallOptions,
): Promise<GroupRead> {
  if (group.length === 1) return readBatch(values.client, shard, [{ key: group[0], includeValue: true }], call);
  try {
    const answers = await values.client.read(
      shard,
      group.map((key) => equalGet(key, true)),
      call,
    );
    return answers.map((answer, i) => pointView(group[i], answer, shard, false));
  } catch (error) {
    if (!isReceiveCap(error)) throw error;
    const answered = (error as OxiaError).answered ?? 0;
    // Every get answered and still cut is a server defect, as in readBatch.
    if (answered >= group.length) throw new OxiaError("malformed", { rpc: "Read" });
    return answered;
  }
}

/**
 * A value Read's call: its received-bytes limit is what the run budget has left (ruling R24), and at least one byte, a
 * stream limit being a whole positive number, so a run whose keys reached the budget still reads the one record that
 * keeps it.
 */
function valuesCall(values: Values, run: Run<string>): OxiaCallOptions {
  return { ...values.call, maxReceivedBytes: Math.max(1, OXIA_RUN_BYTE_BUDGET - run.spent) };
}

/**
 * The second phase (ruling R23): the values of the kept keys not read yet, within the answer's limit, one group after
 * another in key order. A record is kept while the run's kept key and value bytes are under the run budget, checked
 * after each; a key found gone is left out (a concurrent delete); a value over the receive cap ends the answer there.
 * Each Read receives at most what the budget has left (ruling R24): a group whose Read that limit or the receive cap
 * cuts is read again as the gets that arrived, and the budget decides before the rest is read. Answers whether the walk
 * goes on.
 */
async function readValues(values: Values, run: Run<string>): Promise<boolean> {
  const end = Math.min(run.items.length, values.limit);
  let most = OXIA_READ_BATCH_GETS;
  while (values.next < end) {
    const group = nextGroup(values, run, end, most);
    // oxlint-disable-next-line no-await-in-loop -- one group at a time, so a run holds one Read's answer at once.
    const views = await readGroup(values, run.homes[values.next], group, valuesCall(values, run));
    if (typeof views === "number") {
      most = views;
      continue;
    }
    most = OXIA_READ_BATCH_GETS;
    values.next += group.length;
    for (const view of views) {
      if (view === undefined) continue;
      if (view.withheld === true) {
        run.receiveCap = true;
        return stop(run);
      }
      values.records.push(view);
      run.spent += view.value?.length ?? 0;
      if (run.spent >= OXIA_RUN_BYTE_BUDGET) return stop(run);
    }
  }
  return true;
}

/**
 * The rounds of one range: a page reads one; a console run reads on from its last kept key while the range has more
 * and the run has room, each round's share what the run has left, and a run over records reads the new keys' values
 * after each round (ruling R23). Answers whether the walk goes on past this range.
 */
async function rounds(walk: KeyWalk, ask: Round, run: Run<string>): Promise<boolean> {
  let at = ask;
  const frontiers: Frontiers = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each round resumes from the last key the one before it kept.
    const complete = await round(walk, at, run, frontiers);
    // oxlint-disable-next-line no-await-in-loop -- the values of a round's keys are read before the next round.
    if (walk.values !== undefined && !(await readValues(walk.values, run))) return false;
    if (complete) return true;
    if (!walk.mode.readsOn || run.stopped || run.items.length >= ask.count) return false;
    const cursor = run.items[run.items.length - 1];
    const range = { ...ask.range, startInclusive: startAt(walk.order, cursor, ask.range.startInclusive) };
    const after = afterCursor(walk.order, cursor);
    at = { ...ask, range, cursor, extra: ask.extra.filter((found) => after(found.key)) };
  }
}

/** A shard id's place in ascending order: ids are decimal integers, so the shorter one is the smaller. */
const byShardId = (a: OxiaShard, b: OxiaShard) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * An index walk: the shards one after another in ascending id order, each answer concatenated, never merged, since
 * an index lists primary keys in its own order. Answers the number of shards read.
 */
async function concatenated<T>(
  walk: Walk<T>,
  shards: readonly OxiaShard[],
  range: OxiaRange,
  limit: number,
  run: Run<T>,
) {
  let read = 0;
  for (const shard of [...shards].sort(byShardId)) {
    if (run.items.length >= limit) {
      run.more = true;
      break;
    }
    read++;
    const remaining = limit - run.items.length;
    const select = {
      keep: always,
      limit: remaining + 1,
      share: Number.POSITIVE_INFINITY,
      streamBytes: walk.mode.streamBytes,
    };
    // oxlint-disable-next-line no-await-in-loop -- an index walk reads its shards one after another, in id order.
    const got = await walk.source.read(shard, range, select);
    run.receiveCap ||= got.receiveCap;
    const more = !got.complete || got.items.length > remaining;
    if (!absorb(run, { items: got.items.slice(0, remaining), more }, walk)) break;
  }
  return read;
}

/** The start of a range resumed at the cursor: the cursor when it is above the range's own start, else that start. */
function startAt(order: KeyOrder, cursor: string | undefined, start: string): string {
  return cursor !== undefined && keyComparator(order)(cursor, start) > 0 ? cursor : start;
}

/** Whether a key lies after the cursor (every key does when there is none). */
function afterCursor(order: KeyOrder, cursor: string | undefined): (key: string) => boolean {
  const cmp = keyComparator(order);
  return (key) => cursor === undefined || cmp(key, cursor) > 0;
}

/**
 * The prefix walk (SB1-7.4, SB1-7.8): under natural one range, under hierarchical one band per level from the
 * prefix's own to the depth bound, bands one after another and the shards of a band in parallel. Every band's extra
 * keys are read in one `readKeys` at the start, without values; a band's join it only when that band is read, and a
 * walk over records reads their values with that band's keys, so no value of a band the walk never reaches is held.
 * The page's kept-bytes budget spans the bands: a page that has spent it ends before the next band. Answers the number
 * of shards read.
 */
async function bandWalk(
  walk: KeyWalk,
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  ask: PrefixWalkAsk,
  call: OxiaCallOptions,
  run: Run<string>,
): Promise<number> {
  const order = walk.order;
  const shards = shardsOf(snapshot, ask.partitionKey);
  if (order === "natural") {
    const range = {
      startInclusive: startAt(order, ask.cursor, ask.prefix),
      endExclusive: naturalPrefixEnd(ask.prefix),
    };
    await rounds(walk, { shards, range, cursor: ask.cursor, keep: always, extra: [], count: ask.count }, run);
    return shards.length;
  }
  const bands = prefixBands(ask.prefix, await readDepth(client, { ...snapshot, shards }, call));
  const gets = bands.flatMap((band) => band.extraGets);
  const holders = await holdersOf(client, shards, gets, call);
  // A key several shards hold is read on the lowest id among them (ruling R38).
  const found = new Map(gets.map((key, i) => [key, [...holders[i]].sort((a, b) => byShardId(a.shard, b.shard))[0]]));
  const after = afterCursor(order, ask.cursor);
  const level = ask.cursor === undefined ? 0 : hierarchicalLevel(ask.cursor);
  for (const band of bands) {
    if (band.level < level) continue;
    if (run.items.length >= ask.count || run.spent >= walk.mode.keptBytes) {
      run.more = true;
      break;
    }
    const extra = band.extraGets.flatMap((key) => {
      const held = found.get(key);
      return held !== undefined && key.startsWith(ask.prefix) && after(key) ? [held] : [];
    });
    const keep = (key: string) => key.startsWith(ask.prefix) && hierarchicalLevel(key) === band.level && after(key);
    const range = { startInclusive: startAt(order, ask.cursor, band.start), endExclusive: band.end };
    // oxlint-disable-next-line no-await-in-loop -- bands one after another: a deeper band holds only keys above the last.
    if (!(await rounds(walk, { shards, range, cursor: ask.cursor, keep, extra, count: ask.count }, run))) break;
  }
  return shards.length;
}

function keysAnswer(run: Run<string>, shardsRead: number, indexConcatenated: boolean): OxiaKeysAnswer {
  return {
    keys: run.items,
    more: run.more,
    ...(run.stopped ? { stoppedBy: "bytes" as const } : {}),
    ...(indexConcatenated ? { indexConcatenated: true as const } : {}),
    shardsRead,
  };
}

/** A records answer: an index walk's run, or a two-phase run's records with its key run's stops (ruling R23). */
function recordsAnswer(run: Run<OxiaRecordView>, shardsRead: number, indexConcatenated: boolean): OxiaRecordsAnswer {
  const stoppedBy = run.receiveCap ? "receive-cap" : run.stopped ? "bytes" : undefined;
  return {
    records: run.items,
    more: run.more,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
    ...(indexConcatenated ? { indexConcatenated: true as const } : {}),
    shardsRead,
  };
}

// -- the limited client ----------------------------------------------------------------------------------------------

/** The permit wait's signal: the call's own, or its deadline, whichever comes first (ruling R2). */
function waitSignal(call: OxiaCallOptions): AbortSignal {
  return AbortSignal.any([call.signal, AbortSignal.timeout(Math.max(0, call.deadline - Date.now()))]);
}

async function withPermit<T>(limiter: ProviderLimiter, call: OxiaCallOptions, run: () => Promise<T>): Promise<T> {
  const ticket = await limiter.acquire(waitSignal(call));
  try {
    return await run();
  } finally {
    ticket.release();
  }
}

/**
 * A stream that takes its permit on its first `next()`, then opens the inner one; the permit goes back once, when the
 * stream ends, fails or is cancelled. A cancel before the first `next()` opens nothing and takes nothing; a cancel
 * while the permit is awaited hands it back as soon as it is granted.
 */
function lazyStream<T>(limiter: ProviderLimiter, call: OxiaStreamOptions, open: () => OxiaStream<T>): OxiaStream<T> {
  let inner: OxiaStream<T> | undefined;
  let ticket: LimiterTicket | undefined;
  let opening: Promise<OxiaStream<T> | undefined> | undefined;
  let cancelled = false;
  const start = async () => {
    const granted = await limiter.acquire(waitSignal(call));
    if (cancelled) {
      granted.release();
      return undefined;
    }
    ticket = granted;
    inner = open();
    return inner;
  };
  return {
    async next() {
      if (cancelled) return undefined;
      opening ??= start();
      const stream = await opening;
      if (stream === undefined) return undefined;
      try {
        const message = await stream.next();
        if (message === undefined) ticket?.release();
        return message;
      } catch (error) {
        ticket?.release();
        throw error;
      }
    },
    get receivedBytes() {
      return inner?.receivedBytes ?? 0;
    },
    get truncated() {
      return inner?.truncated ?? cancelled;
    },
    cancel() {
      cancelled = true;
      inner?.cancel();
      ticket?.release();
    },
  };
}

/**
 * One permit per call (SB1-9.1): acquired immediately before the call, released when it ends in any way. The wait
 * ends at the call's signal or at its deadline, whichever comes first (ruling R2).
 */
export function limitedOxiaClient(client: OxiaClient, limiter: ProviderLimiter): OxiaClient {
  return {
    getSnapshot: (call) => withPermit(limiter, call, () => client.getSnapshot(call)),
    read: (shard, gets, call) => withPermit(limiter, call, () => client.read(shard, gets, call)),
    list: (shard, range, call) => lazyStream(limiter, call, () => client.list(shard, range, call)),
    rangeScan: (shard, range, call) => lazyStream(limiter, call, () => client.rangeScan(shard, range, call)),
    health: (call) => withPermit(limiter, call, () => client.health(call)),
    close: () => client.close(),
  };
}

// -- the order probe -------------------------------------------------------------------------------------------------

/** The decisive List of a key holding "/" (SB1-7.2 step 3): its first message only, on the key's shard. */
async function listStep(
  client: OxiaClient,
  shard: OxiaShard,
  key: string,
  call: OxiaCallOptions,
): Promise<OrderVerdict> {
  // A one-key sample tells no pair, so order.ts answers that key's decisive range.
  const { range } = decideFromPairs([[key]]) as { readonly range: OxiaRange };
  const stream = client.list(shard, range, { ...call, maxReceivedBytes: OXIA_PAGE_STREAM_BYTES });
  try {
    return decideFromList(key, (await stream.next()) ?? []);
  } finally {
    stream.cancel();
  }
}

/** One shard's first message of a List over the whole range (SB1-7.2 step 5). */
async function sampleShard(client: OxiaClient, shard: OxiaShard, call: OxiaCallOptions, probe: OrderProbe) {
  const range = { startInclusive: "", endExclusive: "" };
  const stream = client.list(shard, range, { ...call, maxReceivedBytes: OXIA_PAGE_STREAM_BYTES });
  try {
    const message = await stream.next();
    probe.received += stream.receivedBytes;
    if (message === undefined) return { shard, keys: [], ended: true };
    return {
      shard,
      keys: message.slice(0, OXIA_ORDER_SAMPLE_KEYS),
      slashed: message.find((key) => key.includes("/")),
      last: message[message.length - 1],
      ended: false,
    } satisfies ShardSample;
  } finally {
    stream.cancel();
  }
}

/**
 * Reads one shard on from its sample's last key (SB1-7.2 step 6), message by message, until a key holding "/" is
 * found in any shard, the stream ends, or the probe's received bytes reach OXIA_ORDER_PROBE_BYTES.
 */
async function readOn(
  client: OxiaClient,
  shard: OxiaShard,
  last: string,
  call: OxiaCallOptions,
  probe: OrderProbe,
): Promise<ReadOn> {
  const range = { startInclusive: last, endExclusive: "" };
  const stream = client.list(shard, range, { ...call, maxReceivedBytes: OXIA_PAGE_STREAM_BYTES });
  let counted = 0;
  try {
    while (!probe.found && probe.received < OXIA_ORDER_PROBE_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- one reader: each message waits for the one before it.
      const message = await stream.next();
      probe.received += stream.receivedBytes - counted;
      counted = stream.receivedBytes;
      if (message === undefined) return { shard, ended: !stream.truncated };
      const slashed = message.find((key) => key.includes("/"));
      if (slashed !== undefined) {
        probe.found = true;
        return { shard, slashed, ended: false };
      }
    }
    return { shard, ended: false };
  } finally {
    stream.cancel();
  }
}

/** SB1-7.2: the order probe's calls over `order.ts`'s decisions. */
export async function detectKeyOrder(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  call: OxiaCallOptions,
): Promise<OrderVerdict> {
  const answers = await pool(snapshot.shards, async (shard): Promise<ProbeAnswer> => {
    const [ceiling, floor] = await client.read(shard, ORDER_PROBE_GETS, call);
    return { shard, ceiling: okKey(ceiling), floor: okKey(floor) };
  });
  const step = decideFromProbe(answers);
  if (step.kind === "verdict") return step.verdict;
  // Every read of a key the probe saw goes to the shard that answered it: a partition key may store it off its hash's.
  if (step.kind === "list") {
    const answered = answers.find((answer) => answer.ceiling === step.key || answer.floor === step.key);
    return listStep(client, (answered as ProbeAnswer).shard, step.key, call);
  }
  const probe: OrderProbe = { received: 0, found: false };
  const samples: readonly ShardSample[] = await pool(snapshot.shards, (shard) =>
    sampleShard(client, shard, call, probe),
  );
  const decided = decideFromPairs(samples.map((sample) => sample.keys));
  if ("kind" in decided) {
    const sampled = samples.find((sample) => sample.keys.includes(decided.key)) as ShardSample;
    return listStep(client, sampled.shard, decided.key, call);
  }
  if (decided.learnedBy === "pair-sample") return decided;
  const seen = samples.find((sample) => sample.slashed !== undefined);
  if (seen !== undefined) return listStep(client, seen.shard, seen.slashed as string, call);
  const open = snapshot.shards.flatMap((shard, i) =>
    samples[i].ended ? [] : [{ shard, last: samples[i].last as string }],
  );
  const outcomes = await pool(open, ({ shard, last }) => readOn(client, shard, last, call, probe));
  const found = outcomes.find((outcome) => outcome.slashed !== undefined);
  if (found !== undefined) return listStep(client, found.shard, found.slashed as string, call);
  if (outcomes.every((outcome) => outcome.ended)) return { order: "hierarchical", learnedBy: "assumed" };
  return { order: "hierarchical", learnedBy: "assumed", exhausted: true };
}

/** SB1-7.7: the greatest level among each shard's FLOOR of the deepest probe key. */
export async function readDepth(client: OxiaClient, snapshot: OxiaSnapshot, call: OxiaCallOptions): Promise<number> {
  const floors = await pool(snapshot.shards, async (shard) => {
    const [floor] = await client.read(shard, [ORDER_PROBE_GETS[1]], call);
    return okKey(floor);
  });
  return maxLevel(floors);
}

// -- the Keys panel's pages ------------------------------------------------------------------------------------------

const pageWalk = (client: OxiaClient, order: KeyOrder, call: OxiaCallOptions): KeyWalk => ({
  source: keySource(client, order, call),
  mode: PAGE_MODE,
  order,
});

/** The Keys panel's cursor page: no bounds, no partition key, no index. `cursor` is the decoded last key, resumed inclusive with the equal key dropped. */
export async function fullWalkPage(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: FullWalkAsk,
  call: OxiaCallOptions,
): Promise<OxiaKeysAnswer> {
  const run = newRun<string>();
  const range = { startInclusive: ask.cursor ?? "", endExclusive: "" };
  const shards = snapshot.shards;
  await round(
    pageWalk(client, order, call),
    { shards, range, cursor: ask.cursor, keep: always, extra: [], count: ask.count },
    run,
  );
  return keysAnswer(run, shards.length, false);
}

/** Every key beginning with `prefix`: bands under hierarchical (reads the depth itself), one range under natural. */
export async function prefixWalkPage(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: PrefixWalkAsk,
  call: OxiaCallOptions,
): Promise<OxiaKeysAnswer> {
  const run = newRun<string>();
  const shardsRead = await bandWalk(pageWalk(client, order, call), client, snapshot, ask, call, run);
  return keysAnswer(run, shardsRead, false);
}

/** The direct children of one node (SB1-7.3), paged as the full walk, with the extra get of a node ending in "/". */
export async function childrenPage(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: ChildrenAsk,
  call: OxiaCallOptions,
): Promise<OxiaKeysAnswer> {
  const children =
    order === "hierarchical"
      ? { ...childrenRange(ask.parent), keep: always }
      : { ...naturalChildrenRange(ask.parent), extraGets: [] };
  const after = afterCursor(order, ask.cursor);
  const holders = await holdersOf(client, snapshot.shards, children.extraGets, call);
  const extra = holders.flatMap(([held]) => (held !== undefined && after(held.key) ? [held] : []));
  const range = { startInclusive: startAt(order, ask.cursor, children.start), endExclusive: children.end };
  const run = newRun<string>();
  const shards = snapshot.shards;
  await round(
    pageWalk(client, order, call),
    { shards, range, cursor: ask.cursor, keep: children.keep, extra, count: ask.count },
    run,
  );
  return keysAnswer(run, shards.length, false);
}

// -- point and comparison reads --------------------------------------------------------------------------------------

function pointView(key: string, answer: OxiaRecord, shard: OxiaShard, withheld: boolean): OxiaRecordView | undefined {
  if (answer.status !== "OK") return undefined;
  return {
    key,
    ...(answer.value === undefined ? {} : { value: answer.value }),
    ...(withheld ? { withheld: true as const } : {}),
    version: answer.version as OxiaVersion,
    shard: shard.id,
  };
}

/**
 * One batch of EQUAL gets on one shard, with the C13 resume: a receive-cap failure with `answered = n` reads the first
 * n gets again as one batch (the seam returns nothing of a failed call; they arrived within the limit before), then
 * each later get alone; a single get that meets the cap is read once more without its value and answered withheld.
 */
async function readBatch(
  client: OxiaClient,
  shard: OxiaShard,
  gets: readonly PointGet[],
  call: OxiaCallOptions,
): Promise<(OxiaRecordView | undefined)[]> {
  try {
    const answers = await client.read(
      shard,
      gets.map((get) => equalGet(get.key, get.includeValue)),
      call,
    );
    return answers.map((answer, i) => pointView(gets[i].key, answer, shard, false));
  } catch (error) {
    if (!isReceiveCap(error)) throw error;
    if (gets.length === 1) {
      const [answer] = await client.read(shard, [equalGet(gets[0].key, false)], call);
      return [pointView(gets[0].key, answer, shard, true)];
    }
    const answered = (error as OxiaError).answered ?? 0;
    // More answers than gets is a server defect; read again, the same batch would fail the same way without end.
    if (answered >= gets.length) throw new OxiaError("malformed", { rpc: "Read" });
    const head = answered > 0 ? await readBatch(client, shard, gets.slice(0, answered), call) : [];
    const tail: (OxiaRecordView | undefined)[] = [];
    for (const get of gets.slice(answered)) {
      // oxlint-disable-next-line no-await-in-loop -- one get per Read, each after the one before (C13).
      tail.push(...(await readBatch(client, shard, [get], call)));
    }
    return [...head, ...tail];
  }
}

/** EQUAL gets, routed by key or partition key, batched per shard, with the C13 resume; answers in ask order, undefined for a miss. */
export async function readKeys(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  gets: readonly PointGet[],
  call: OxiaCallOptions,
): Promise<readonly (OxiaRecordView | undefined)[]> {
  const byShard = new Map<OxiaShard, number[]>();
  gets.forEach((get, i) => {
    const shard = shardFor(snapshot, get.key, get.partitionKey);
    const at = byShard.get(shard);
    if (at === undefined) byShard.set(shard, [i]);
    else at.push(i);
  });
  const batches = [...byShard].flatMap(([shard, at]) =>
    Array.from({ length: Math.ceil(at.length / OXIA_READ_BATCH_GETS) }, (_, c) => ({
      shard,
      at: at.slice(c * OXIA_READ_BATCH_GETS, (c + 1) * OXIA_READ_BATCH_GETS),
    })),
  );
  const answers = new Array<OxiaRecordView | undefined>(gets.length);
  await pool(batches, async ({ shard, at }) => {
    const views = await readBatch(
      client,
      shard,
      at.map((i) => gets[i]),
      call,
    );
    at.forEach((i, j) => {
      answers[i] = views[j];
    });
  });
  return answers;
}

/**
 * EQUAL gets asking no value of keys whose shard is not known, each sent to every shard of `shards` (ruling R32): a
 * key written with a partition key lives on that key's shard, not on its own hash's. Answers each key's holders in
 * shard order, none for a key no shard holds; no call when there is no key.
 */
async function holdersOf(
  client: OxiaClient,
  shards: readonly OxiaShard[],
  keys: readonly string[],
  call: OxiaCallOptions,
): Promise<Found[][]> {
  const holders = keys.map((): Found[] => []);
  if (keys.length === 0) return holders;
  const batches = shards.flatMap((shard) =>
    Array.from({ length: Math.ceil(keys.length / OXIA_READ_BATCH_GETS) }, (_, c) => ({
      shard,
      from: c * OXIA_READ_BATCH_GETS,
    })),
  );
  const answers = await pool(batches, ({ shard, from }) =>
    readBatch(
      client,
      shard,
      keys.slice(from, from + OXIA_READ_BATCH_GETS).map((key) => ({ key, includeValue: false })),
      call,
    ),
  );
  batches.forEach(({ shard, from }, b) => {
    answers[b].forEach((view, j) => {
      if (view !== undefined) holders[from + j].push({ key: view.key, shard });
    });
  });
  return holders;
}

/**
 * One key read wherever it is stored (ruling R33): with its value on the shard its own hash names, then, on a miss, an
 * existence check asking no value on every other shard, and the value on the one shard that holds it. Answers that
 * record, or how many shards hold the key when that is not one: none, or several under different partition keys.
 */
export async function readKeyAnywhere(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  key: string,
  call: OxiaCallOptions,
): Promise<KeyAnywhere> {
  const home = shardFor(snapshot, key);
  const [own] = await readBatch(client, home, [{ key, includeValue: true }], call);
  if (own !== undefined) return { record: own };
  const others = snapshot.shards.filter((shard) => shard !== home);
  const [holders] = await holdersOf(client, others, [key], call);
  if (holders.length !== 1) return { holders: holders.length };
  const [held] = await readBatch(client, holders[0].shard, [{ key, includeValue: true }], call);
  // Gone between the check and the read: a concurrent delete, answered as a key no shard holds.
  return held === undefined ? { holders: 0 } : { record: held };
}

/** SB1-7.6: fan-out without values, selection, then one EQUAL get on the winner's shard. Also every `--index` get, EQUAL included. */
export async function comparisonGet(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: ComparisonAsk,
  call: OxiaCallOptions,
): Promise<OxiaRecordView | undefined> {
  if (ask.key === "" && ask.comparison !== "EQUAL") {
    throw new RangeError("A comparison get of the empty key is refused before any call");
  }
  if (ask.comparison === "EQUAL" && ask.index === undefined) {
    throw new RangeError("An EQUAL get without an index is a point read: use readKeys");
  }
  const get: OxiaGet = {
    key: ask.key,
    comparison: ask.comparison,
    includeValue: false,
    ...(ask.index === undefined ? {} : { secondaryIndexName: ask.index }),
  };
  const answers = await pool(shardsOf(snapshot, ask.partitionKey), async (shard) => ({
    shard,
    record: (await client.read(shard, [get], call))[0],
  }));
  const winner = guard("Read", () => selectComparison(ask.comparison, answers, order, ask.index));
  if (winner === undefined) return undefined;
  const key = winner.record.key as string;
  const [view] = await readBatch(client, winner.shard, [{ key, includeValue: ask.includeValue }], call);
  if (view === undefined) throw new OxiaError("record-changed", { rpc: "Read", shardId: winner.shard.id });
  return ask.index === undefined ? view : { ...view, secondaryIndexKey: winner.record.secondaryIndexKey };
}

// -- the console walks -----------------------------------------------------------------------------------------------

const consoleWalk = (client: OxiaClient, order: KeyOrder, call: OxiaCallOptions, values?: Values): KeyWalk => ({
  source: keySource(client, order, call),
  mode: CONSOLE_MODE,
  order,
  ...(values === undefined ? {} : { values }),
});

function newValues(client: OxiaClient, limit: number, call: OxiaCallOptions): Values {
  return { client, call, limit, records: [], next: 0 };
}

/** A two-phase run's answer: its records, with `more` true when its key walk read a key past the limit. */
function scanAnswer(run: Run<string>, values: Values, shardsRead: number): OxiaRecordsAnswer {
  const more = run.more || run.items.length > values.limit;
  return recordsAnswer({ ...run, items: values.records, more }, shardsRead, false);
}

/** An index walk's range: the console's range over the index's entries. */
const indexRange = (ask: OxiaConsoleAsk, index: string): OxiaRange => ({ ...ask.range, secondaryIndexName: index });

/** The console's range-scan walk: records, never raising for a stop (SB1-9.3a). */
export async function rangeScanPage(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: OxiaConsoleAsk,
  call: OxiaCallOptions,
): Promise<OxiaRecordsAnswer> {
  const shards = shardsOf(snapshot, ask.partitionKey);
  if (ask.index !== undefined) {
    const run = newRun<OxiaRecordView>();
    const walk = { source: recordSource(client, call), mode: CONSOLE_MODE };
    const shardsRead = await concatenated(walk, shards, indexRange(ask, ask.index), ask.limit, run);
    return recordsAnswer(run, shardsRead, shardsRead > 1);
  }
  const values = newValues(client, ask.limit, call);
  const run = newRun<string>();
  const range = { shards, range: ask.range, keep: always, extra: [], count: ask.limit + 1 };
  await rounds(consoleWalk(client, order, call, values), range, run);
  return scanAnswer(run, values, shards.length);
}

/** The console's list walk: keys, with the same ask. */
export async function listRange(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: OxiaConsoleAsk,
  call: OxiaCallOptions,
): Promise<OxiaKeysAnswer> {
  const shards = shardsOf(snapshot, ask.partitionKey);
  const run = newRun<string>();
  const walk = consoleWalk(client, order, call);
  if (ask.index !== undefined) {
    const shardsRead = await concatenated(walk, shards, indexRange(ask, ask.index), ask.limit, run);
    return keysAnswer(run, shardsRead, shardsRead > 1);
  }
  await rounds(walk, { shards, range: ask.range, keep: always, extra: [], count: ask.limit }, run);
  return keysAnswer(run, shards.length, false);
}

/** `list --prefix` in the console (ruling R5): the bands of prefixWalkPage under listRange's run budget, limits and stops. */
export async function prefixListPage(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: PrefixConsoleAsk,
  call: OxiaCallOptions,
): Promise<OxiaKeysAnswer> {
  const run = newRun<string>();
  const walk = consoleWalk(client, order, call);
  const shardsRead = await bandWalk(walk, client, snapshot, { ...ask, count: ask.limit }, call, run);
  return keysAnswer(run, shardsRead, false);
}

/** `range-scan --prefix`: the band walk of prefixWalkPage, keys then values, under rangeScanPage's budget and stops (decision D10, ruling R23). */
export async function prefixScanPage(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  ask: PrefixConsoleAsk,
  call: OxiaCallOptions,
): Promise<OxiaRecordsAnswer> {
  const values = newValues(client, ask.limit, call);
  const run = newRun<string>();
  const walk = consoleWalk(client, order, call, values);
  const shardsRead = await bandWalk(walk, client, snapshot, { ...ask, count: ask.limit + 1 }, call, run);
  return scanAnswer(run, values, shardsRead);
}

// -- folder discovery ------------------------------------------------------------------------------------------------

/** Round 1 (SB1-8.2, SB1-8.3): enter level 1 and, in the same Read, start the backward chain below it. */
const FIRST_HIERARCHICAL: readonly OxiaGet[] = [
  { key: "\u0000/", comparison: "CEILING", includeValue: false },
  { key: "\u0000/", comparison: "LOWER", includeValue: false },
];
const FIRST_NATURAL: readonly OxiaGet[] = [{ key: "", comparison: "CEILING", includeValue: false }];

/** The least (sign -1) or greatest (sign 1) of the keys by the order, undefined when there is none. */
function extreme(keys: readonly (string | undefined)[], order: KeyOrder, sign: number): string | undefined {
  const cmp = keyComparator(order);
  let chosen: string | undefined;
  for (const key of keys) if (key !== undefined && (chosen === undefined || cmp(key, chosen) * sign > 0)) chosen = key;
  return chosen;
}

/** Whether the next round would pass a cap: the rounds, the calls it would add, or discovery's own deadline. */
function capped(state: Discovery, asking: number): boolean {
  return (
    state.rounds + 1 > OXIA_DISCOVERY_MAX_ROUNDS ||
    state.calls + asking > OXIA_DISCOVERY_MAX_CALLS ||
    Date.now() >= state.deadline
  );
}

/** Records a key's top-level node; the first key seen for a node is its representative. */
function record(state: Discovery, key: string): void {
  const node = topNode(key);
  if (node !== undefined && !state.found.has(node)) state.found.set(node, key);
}

/** The skip-scan over the per-shard frontier, then the backward chain; answers whether it ran to its end uncapped. */
async function skipScan(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  call: OxiaCallOptions,
  state: Discovery,
): Promise<boolean> {
  const cmp = keyComparator(order);
  const send = (shards: readonly OxiaShard[], gets: readonly OxiaGet[]) => {
    state.rounds++;
    state.calls += shards.length;
    return pool(shards, (shard) => client.read(shard, gets, call));
  };
  const first = await send(snapshot.shards, order === "hierarchical" ? FIRST_HIERARCHICAL : FIRST_NATURAL);
  const frontier = first.map((answers) => okKey(answers[0]));
  for (let k = extreme(frontier, order, -1); k !== undefined; k = extreme(frontier, order, -1)) {
    const probe = nextDiscoveryProbe(k, order);
    const inclusive = probe.comparison === "CEILING";
    const stale = snapshot.shards.flatMap((shard, i) => {
      const at = frontier[i];
      return at !== undefined && (inclusive ? cmp(at, probe.key) < 0 : cmp(at, probe.key) <= 0) ? [i] : [];
    });
    if (capped(state, stale.length)) return false;
    record(state, k);
    const get = { key: probe.key, comparison: probe.comparison, includeValue: false };
    // oxlint-disable-next-line no-await-in-loop -- each round's probe is the key the round before it found.
    const answers = await send(
      stale.map((i) => snapshot.shards[i]),
      [get],
    );
    stale.forEach((shardIndex, j) => {
      frontier[shardIndex] = okKey(answers[j][0]);
    });
  }
  if (order === "natural") return true;
  for (
    let b = extreme(
      first.map((answers) => okKey(answers[1])),
      order,
      1,
    );
    b !== undefined;
  ) {
    if (hierarchicalLevel(b) === 0) break;
    record(state, b);
    if (capped(state, snapshot.shards.length)) return false;
    const get = { key: `${topNode(b) as string}/`, comparison: "LOWER" as const, includeValue: false };
    // oxlint-disable-next-line no-await-in-loop -- each step of the chain starts below the node the last one found.
    const answers = await send(snapshot.shards, [get]);
    b = extreme(
      answers.map((answer) => okKey(answer[0])),
      order,
      1,
    );
  }
  return true;
}

/**
 * Folder discovery (SB1-8.1 to SB1-8.5): one representative key per top-level node, by a skip-scan of comparison gets
 * with a per-shard frontier, capped by rounds, calls and its own deadline; a deadline-exceeded call is a cap too.
 */
export async function discoverTopNodes(
  client: OxiaClient,
  snapshot: OxiaSnapshot,
  order: KeyOrder,
  call: OxiaCallOptions,
): Promise<DiscoveryResult> {
  const deadline = Math.min(call.deadline, Date.now() + OXIA_DISCOVERY_DEADLINE_MS);
  const state: Discovery = { rounds: 0, calls: 0, found: new Map(), deadline };
  let complete = false;
  try {
    complete = await skipScan(client, snapshot, order, { signal: call.signal, deadline }, state);
  } catch (error) {
    if (!(error instanceof OxiaError && error.category === "deadline-exceeded")) throw error;
  }
  return { representatives: [...state.found.values()], complete, rounds: state.rounds, calls: state.calls };
}
