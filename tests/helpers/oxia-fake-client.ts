/**
 * The one in-memory `OxiaClient` the unit tests of the walks, execute, key-scan, objects and the provider run over
 * (SB1-8.6, the reconciliation's cross-part ruling).
 *
 * It stands above the adapter, so it answers as `createGrpcOxiaClient` answers: an EQUAL answer carries the asked key,
 * a Read is all or nothing, and a stream honours `maxReceivedBytes` as SB1-3.3 1a states (the message that crosses the
 * limit is delivered, then the stream ends truncated); a Read's stream takes its call's limit, or the run budget
 * without one (ruling R24). Records are placed by the server's own routing (`shardFor`) and
 * sorted by the namespace's encoder, so every range, comparison and index answer follows the order a server of that
 * kind stores. It imports no gRPC module.
 *
 * The index gets follow the fake's own model, documented at `indexGet`, monotone so that a selection across shards
 * equals one shard holding every entry; it is not a port of the server's `doSecondaryGet`, whose behaviour the
 * recorded captures hold.
 */
import type {
  OxiaCallOptions,
  OxiaClient,
  OxiaGet,
  OxiaHealth,
  OxiaInt64,
  OxiaLeader,
  OxiaRange,
  OxiaRecord,
  OxiaRpc,
  OxiaShard,
  OxiaSnapshot,
  OxiaStream,
  OxiaStreamOptions,
  OxiaVersion,
} from "@/lib/db/providers/keyvalue/oxia/client";
import {
  OXIA_INTERNAL_PREFIX,
  OXIA_READ_BATCH_GETS,
  OXIA_RECEIVE_CAP_BYTES,
  OXIA_RUN_BYTE_BUDGET,
} from "@/lib/db/providers/keyvalue/oxia/constants";
import { OxiaError } from "@/lib/db/providers/keyvalue/oxia/errors";
import { goPathEscape } from "@/lib/db/providers/keyvalue/oxia/merge";
import { compareBytes, encodeHierarchical, encodeNatural, type KeyOrder } from "@/lib/db/providers/keyvalue/oxia/order";
import { shardFor } from "@/lib/db/providers/keyvalue/oxia/routing";

export interface FakeOxiaRecord {
  readonly key: string;
  /** Default: an empty value. Never copied, so many records may share one buffer. */
  readonly value?: Uint8Array;
  /** Routes the record instead of its key. */
  readonly partitionKey?: string;
  /** Present for an ephemeral record. */
  readonly sessionId?: OxiaInt64;
  readonly clientIdentity?: string;
  /** Index name to secondary key. */
  readonly secondaryIndexes?: Readonly<Record<string, string>>;
}

export interface FakeOxiaOptions {
  readonly order: KeyOrder;
  readonly records: readonly FakeOxiaRecord[];
  /** Default 3; equal hash ranges covering 0 to 4294967295. */
  readonly shards?: number;
  /** Default "default". */
  readonly namespace?: string;
  /** Default "localhost:6648", the bootstrap authority. */
  readonly leader?: string;
  /** Serialized bytes one List or RangeScan message holds before the next begins; default 2 MiB. */
  readonly chunkBytes?: number;
  /** Default OXIA_RECEIVE_CAP_BYTES. */
  readonly receiveCapBytes?: number;
}

export interface FakeOxiaCall {
  readonly rpc: OxiaRpc;
  readonly shard?: OxiaInt64;
  readonly gets?: readonly OxiaGet[];
  readonly range?: OxiaRange;
  readonly maxReceivedBytes?: number;
}

export interface FakeOxiaClient extends OxiaClient {
  /** Every call in the order it began. */
  readonly calls: readonly FakeOxiaCall[];
  /** Serialized bytes delivered over every call. */
  readonly receivedBytes: number;
  /** The most calls in flight at once. */
  readonly peakInFlight: number;
  /** Streams opened and not yet ended or cancelled. */
  readonly openStreams: number;
  readonly closed: boolean;
  put(record: FakeOxiaRecord): void;
  remove(key: string): void;
  /** The next call that matches fails with `error`, once; `after` runs it after that many messages of a stream. */
  failNext(match: { readonly rpc: OxiaRpc; readonly shard?: OxiaInt64 }, error: Error, after?: number): void;
  /** Runs before a Read answers and before a stream's first message, so a test can change records or hold a call. */
  onCall(hook: (call: FakeOxiaCall) => void | Promise<void>): void;
  /** Replaces the map the next getSnapshot answers (a split, a moved leader), and routes every record again. */
  setSnapshot(snapshot: OxiaSnapshot): void;
}

/** The server's List and RangeScan message size (the fake's default chunk). */
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
/** A record's version fields in a message: a fixed stand-in for their serialized size. */
const VERSION_BYTES = 32;
/** The epoch the fake's timestamps count from: 2025-10-04, so they read as recent dates. */
const EPOCH_MS = 1_759_536_000_000;
const READ_BATCH_SENTENCE = "A Read sends 1 to 1,000 gets";

/** One stored record with its encoded key and its version. */
interface Stored {
  readonly key: string;
  readonly encoded: Uint8Array;
  readonly record: FakeOxiaRecord;
  readonly version: OxiaVersion;
}

/** One index entry as the server stores it: `__oxia/idx/<name>/<secondary key>\x01<escaped primary key>`. */
interface IndexEntry {
  readonly encoded: Uint8Array;
  readonly secondaryKey: string;
  readonly stored: Stored;
}

/** One shard's records, sorted by the encoder, replaced (never mutated) on a change so open streams keep theirs. */
interface ShardStore {
  entries: readonly Stored[];
  counter: number;
  indexes: Map<string, readonly IndexEntry[]>;
}

interface PendingFailure {
  readonly rpc: OxiaRpc;
  readonly shard?: OxiaInt64;
  readonly error: Error;
  readonly after: number;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const varintLength = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : n < 0x200000 ? 3 : 4);
/** A key's cost in a List message: the key, its field tag and its length prefix. */
const keyCost = (key: string) => byteLength(key) + 1 + varintLength(byteLength(key));
/** A record's cost in a Read or RangeScan message. */
const recordCost = (record: OxiaRecord) => byteLength(record.key ?? "") + (record.value?.length ?? 0) + VERSION_BYTES;

function parseLeader(text: string): OxiaLeader {
  const colon = text.lastIndexOf(":");
  return { host: text.slice(0, colon), port: Number(text.slice(colon + 1)), address: text, bootstrap: true };
}

/** The server's even split (`GenerateShards`): equal buckets, the last one ending at 0xffffffff. */
function evenSnapshot(count: number, namespace: string, leader: OxiaLeader): OxiaSnapshot {
  const bucket = Math.floor(0xffffffff / count) + 1;
  const shards = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    minHash: i * bucket,
    maxHash: i === count - 1 ? 0xffffffff : (i + 1) * bucket - 1,
    leader,
  }));
  return { namespace, shards, readAt: Date.now() };
}

/** The first position whose encoded key is at or above `encoded` (`strict`: above it). */
function bound<T extends { readonly encoded: Uint8Array }>(items: readonly T[], encoded: Uint8Array, strict: boolean) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const sign = compareBytes(items[middle].encoded, encoded);
    if (sign < 0 || (strict && sign === 0)) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The end of a message that starts at `from`: items until the next would pass `chunkBytes`, and at least one. */
function messageEnd<T>(items: readonly T[], from: number, cost: (item: T) => number, chunkBytes: number, cap: number) {
  let end = from + 1;
  let bytes = cost(items[from]);
  while (end < items.length) {
    const next = cost(items[end]);
    if (next > cap || bytes + next > chunkBytes) break;
    bytes += next;
    end++;
  }
  return { end, bytes };
}

export function createFakeOxiaClient(options: FakeOxiaOptions): FakeOxiaClient {
  const order = options.order;
  const encode = order === "hierarchical" ? encodeHierarchical : encodeNatural;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const cap = options.receiveCapBytes ?? OXIA_RECEIVE_CAP_BYTES;
  let snapshot = evenSnapshot(
    options.shards ?? 3,
    options.namespace ?? "default",
    parseLeader(options.leader ?? "localhost:6648"),
  );
  let stores = new Map<string, ShardStore>();
  const calls: FakeOxiaCall[] = [];
  const failures: PendingFailure[] = [];
  let hook: (call: FakeOxiaCall) => void | Promise<void> = () => undefined;
  let receivedBytes = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let openStreams = 0;
  let closed = false;

  const storeOf = (shardId: string) => stores.get(shardId);
  const leaderOf = (shardId: string) =>
    (snapshot.shards.find((shard) => shard.id === shardId) as OxiaShard).leader.address;

  function versionFor(store: ShardStore, record: FakeOxiaRecord, previous?: OxiaVersion): OxiaVersion {
    store.counter++;
    return {
      versionId: String(store.counter),
      modificationsCount: previous === undefined ? "0" : String(Number(previous.modificationsCount) + 1),
      createdTimestamp: previous?.createdTimestamp ?? String(EPOCH_MS + store.counter),
      modifiedTimestamp: String(EPOCH_MS + store.counter),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.clientIdentity === undefined ? {} : { clientIdentity: record.clientIdentity }),
    };
  }

  /** Routes every stored record (and the new ones, versioned in order) into fresh stores for the current snapshot. */
  function load(kept: readonly Stored[], added: readonly FakeOxiaRecord[]): void {
    const next = new Map<string, ShardStore>();
    const placed = new Map<string, Map<string, Stored>>();
    for (const shard of snapshot.shards) {
      next.set(shard.id, { entries: [], counter: stores.get(shard.id)?.counter ?? 0, indexes: new Map() });
      placed.set(shard.id, new Map());
    }
    const home = (record: FakeOxiaRecord) => shardFor(snapshot, record.key, record.partitionKey).id;
    for (const stored of kept) (placed.get(home(stored.record)) as Map<string, Stored>).set(stored.key, stored);
    for (const record of added) {
      if (record.key.startsWith(OXIA_INTERNAL_PREFIX)) throw new RangeError("The fake stores no internal key");
      const id = home(record);
      const shardRecords = placed.get(id) as Map<string, Stored>;
      const previous = shardRecords.get(record.key)?.version;
      const version = versionFor(next.get(id) as ShardStore, record, previous);
      shardRecords.set(record.key, { key: record.key, encoded: encode(record.key), record, version });
    }
    for (const [id, shardRecords] of placed) {
      (next.get(id) as ShardStore).entries = [...shardRecords.values()].sort((a, b) =>
        compareBytes(a.encoded, b.encoded),
      );
    }
    stores = next;
  }

  const allStored = () => [...stores.values()].flatMap((store) => store.entries);

  /** The sorted entries of one index on one shard, built on first use after a change. */
  function indexOf(store: ShardStore, name: string): readonly IndexEntry[] {
    const cached = store.indexes.get(name);
    if (cached !== undefined) return cached;
    const prefix = `${OXIA_INTERNAL_PREFIX}idx/${name}/`;
    const built = store.entries
      .filter((stored) => stored.record.secondaryIndexes?.[name] !== undefined)
      .map((stored) => {
        const secondaryKey = stored.record.secondaryIndexes?.[name] as string;
        return { encoded: encode(`${prefix}${secondaryKey}\u0001${goPathEscape(stored.key)}`), secondaryKey, stored };
      })
      .sort((a, b) => compareBytes(a.encoded, b.encoded));
    store.indexes.set(name, built);
    return built;
  }

  const okRecord = (stored: Stored, includeValue: boolean): OxiaRecord => ({
    status: "OK",
    key: stored.key,
    version: stored.version,
    ...(includeValue ? { value: stored.record.value ?? new Uint8Array(0) } : {}),
  });

  /**
   * The fake's model of an index get, with `low = prefix + key + "\x01"` and `high = prefix + key + "\x02"`: EQUAL
   * the first entry in [low, high), CEILING the first at or above low, HIGHER the first at or above high, FLOOR the
   * last below high, LOWER the last below low.
   */
  function indexGet(store: ShardStore, get: OxiaGet, name: string): OxiaRecord {
    const entries = indexOf(store, name);
    const prefix = `${OXIA_INTERNAL_PREFIX}idx/${name}/`;
    const low = bound(entries, encode(`${prefix}${get.key}\u0001`), false);
    const high = bound(entries, encode(`${prefix}${get.key}\u0002`), false);
    const position = {
      EQUAL: low < high ? low : -1,
      CEILING: low,
      HIGHER: high,
      FLOOR: high - 1,
      LOWER: low - 1,
    }[get.comparison];
    const entry = entries[position];
    if (entry === undefined) return { status: "KEY_NOT_FOUND" };
    return { ...okRecord(entry.stored, get.includeValue), secondaryIndexKey: entry.secondaryKey };
  }

  function answerGet(store: ShardStore, get: OxiaGet): OxiaRecord {
    if (get.secondaryIndexName !== undefined) return indexGet(store, get, get.secondaryIndexName);
    const { entries } = store;
    const encoded = encode(get.key);
    const at = bound(entries, encoded, false);
    const above = bound(entries, encoded, true);
    const position = {
      EQUAL: at < above ? at : -1,
      CEILING: at,
      HIGHER: above,
      FLOOR: above - 1,
      LOWER: at - 1,
    }[get.comparison];
    const stored = entries[position];
    return stored === undefined ? { status: "KEY_NOT_FOUND" } : okRecord(stored, get.includeValue);
  }

  /** The items of a range, in server order: primary keys or records, by the key or by an index's entries. */
  function rangeItems<T>(store: ShardStore, range: OxiaRange, item: (stored: Stored) => T): T[] {
    if (range.secondaryIndexName !== undefined) {
      const entries = indexOf(store, range.secondaryIndexName);
      const prefix = `${OXIA_INTERNAL_PREFIX}idx/${range.secondaryIndexName}/`;
      const from = bound(entries, encode(prefix + range.startInclusive), false);
      const to =
        range.endExclusive === "" ? entries.length : bound(entries, encode(prefix + range.endExclusive), false);
      return entries.slice(from, Math.max(from, to)).map((entry) => item(entry.stored));
    }
    const { entries } = store;
    const from = range.startInclusive === "" ? 0 : bound(entries, encode(range.startInclusive), false);
    const to = range.endExclusive === "" ? entries.length : bound(entries, encode(range.endExclusive), false);
    return entries.slice(from, Math.max(from, to)).map(item);
  }

  function takeFailure(rpc: OxiaRpc, shard?: OxiaInt64): PendingFailure | undefined {
    const index = failures.findIndex(
      (pending) => pending.rpc === rpc && (pending.shard === undefined || pending.shard === shard),
    );
    return index < 0 ? undefined : failures.splice(index, 1)[0];
  }

  function begin(call: FakeOxiaCall): void {
    calls.push(call);
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
  }

  /** The checks every call makes when it would answer: the session, the signal, then the deadline. */
  function settle(rpc: OxiaRpc, call: OxiaCallOptions, shardId?: string): void {
    if (closed) throw new OxiaError("closed", { rpc });
    if (call.signal.aborted) throw new OxiaError("cancelled", { rpc });
    const fields = shardId === undefined ? { rpc } : { rpc, shardId, leader: leaderOf(shardId) };
    if (Date.now() >= call.deadline) throw new OxiaError("deadline-exceeded", fields);
  }

  /** The checks a call makes at its start: the session, a signal aborted before it was sent, a planted failure. */
  function start(rpc: OxiaRpc, call: OxiaCallOptions, shard?: OxiaInt64): void {
    if (closed) throw new OxiaError("closed", { rpc });
    if (call.signal.aborted) throw new OxiaError("cancelled", { rpc, unsent: true });
    const planted = takeFailure(rpc, shard);
    if (planted !== undefined) throw planted.error;
  }

  async function unary<T>(rpc: OxiaRpc, call: OxiaCallOptions, answer: () => T): Promise<T> {
    begin({ rpc });
    try {
      start(rpc, call);
      await undefined;
      settle(rpc, call);
      return answer();
    } finally {
      inFlight--;
    }
  }

  async function read(shard: OxiaShard, gets: readonly OxiaGet[], call: OxiaCallOptions): Promise<OxiaRecord[]> {
    if (gets.length === 0 || gets.length > OXIA_READ_BATCH_GETS) throw new RangeError(READ_BATCH_SENTENCE);
    const limit = call.maxReceivedBytes ?? OXIA_RUN_BYTE_BUDGET;
    const recorded: FakeOxiaCall = {
      rpc: "Read",
      shard: shard.id,
      gets,
      ...(call.maxReceivedBytes === undefined ? {} : { maxReceivedBytes: call.maxReceivedBytes }),
    };
    begin(recorded);
    try {
      start("Read", call, shard.id);
      if (storeOf(shard.id) === undefined) throw new OxiaError("shard-not-found", { rpc: "Read", shardId: shard.id });
      await hook(recorded);
      settle("Read", call, shard.id);
      const store = storeOf(shard.id) as ShardStore;
      const answers = gets.map((get) => answerGet(store, get));
      let delivered = 0;
      let bytes = 0;
      while (delivered < answers.length) {
        if (recordCost(answers[delivered]) > cap) {
          throw new OxiaError("receive-cap", { rpc: "Read", answered: delivered, shardId: shard.id });
        }
        const message = messageEnd(answers, delivered, recordCost, chunkBytes, cap);
        delivered = message.end;
        bytes += message.bytes;
        receivedBytes += message.bytes;
        if (bytes >= limit && delivered < answers.length) {
          throw new OxiaError("receive-cap", { rpc: "Read", answered: delivered, shardId: shard.id });
        }
      }
      return answers;
    } finally {
      inFlight--;
    }
  }

  function stream<T>(
    rpc: "List" | "RangeScan",
    shard: OxiaShard,
    range: OxiaRange,
    call: OxiaStreamOptions,
    item: (stored: Stored) => T,
    cost: (item: T) => number,
  ): OxiaStream<T> {
    const recorded: FakeOxiaCall = { rpc, shard: shard.id, range, maxReceivedBytes: call.maxReceivedBytes };
    begin(recorded);
    openStreams++;
    const sentAborted = call.signal.aborted;
    const planted = closed || sentAborted ? undefined : takeFailure(rpc, shard.id);
    let items: readonly T[] | undefined;
    let position = 0;
    let messages = 0;
    let received = 0;
    let ended = false;
    let truncated = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      inFlight--;
      openStreams--;
    };
    const fail = (error: Error): never => {
      finish();
      throw error;
    };
    const deliver = async (): Promise<readonly T[] | undefined> => {
      if (closed) fail(new OxiaError("closed", { rpc }));
      if (items === undefined) {
        if (sentAborted) fail(new OxiaError("cancelled", { rpc, unsent: true }));
        if (storeOf(shard.id) === undefined) fail(new OxiaError("shard-not-found", { rpc, shardId: shard.id }));
        await hook(recorded);
        if (ended) return undefined;
        items = rangeItems(storeOf(shard.id) as ShardStore, range, item);
      }
      try {
        settle(rpc, call, shard.id);
      } catch (error) {
        fail(error as Error);
      }
      if (planted !== undefined && messages === planted.after) fail(planted.error);
      const all = items as readonly T[];
      if (position >= all.length) {
        finish();
        return undefined;
      }
      if (cost(all[position]) > cap) fail(new OxiaError("receive-cap", { rpc, shardId: shard.id }));
      const message = messageEnd(all, position, cost, chunkBytes, cap);
      const delivered = all.slice(position, message.end);
      position = message.end;
      messages++;
      received += message.bytes;
      receivedBytes += message.bytes;
      if (received >= call.maxReceivedBytes) {
        truncated = true;
        finish();
      }
      return delivered;
    };
    return {
      next: () => (ended ? Promise.resolve(undefined) : deliver()),
      get receivedBytes() {
        return received;
      },
      get truncated() {
        return truncated;
      },
      cancel() {
        if (ended) return;
        truncated = true;
        finish();
      },
    };
  }

  load([], options.records);

  return {
    get calls() {
      return calls;
    },
    get receivedBytes() {
      return receivedBytes;
    },
    get peakInFlight() {
      return peakInFlight;
    },
    get openStreams() {
      return openStreams;
    },
    get closed() {
      return closed;
    },
    getSnapshot: (call) => unary("GetShardAssignments", call, () => ({ ...snapshot, readAt: Date.now() })),
    health: (call) => unary<OxiaHealth>("Health/Check", call, () => "SERVING"),
    read,
    list: (shard, range, call) => stream("List", shard, range, call, (stored) => stored.key, keyCost),
    rangeScan: (shard, range, call) =>
      stream("RangeScan", shard, range, call, (stored) => okRecord(stored, true), recordCost),
    close() {
      closed = true;
    },
    put(record) {
      if (record.key.startsWith(OXIA_INTERNAL_PREFIX)) throw new RangeError("The fake stores no internal key");
      const id = shardFor(snapshot, record.key, record.partitionKey).id;
      const store = storeOf(id) as ShardStore;
      const encoded = encode(record.key);
      const at = bound(store.entries, encoded, false);
      const existing = store.entries[at]?.key === record.key ? store.entries[at] : undefined;
      const stored = { key: record.key, encoded, record, version: versionFor(store, record, existing?.version) };
      const entries = [...store.entries];
      entries.splice(at, existing === undefined ? 0 : 1, stored);
      store.entries = entries;
      store.indexes = new Map();
    },
    remove(key) {
      const encoded = encode(key);
      for (const store of stores.values()) {
        const at = bound(store.entries, encoded, false);
        if (store.entries[at]?.key !== key) continue;
        store.entries = store.entries.filter((_, i) => i !== at);
        store.indexes = new Map();
      }
    },
    failNext(match, error, after = 0) {
      failures.push({ rpc: match.rpc, shard: match.shard, error, after });
    },
    onCall(next) {
      hook = next;
    },
    setSnapshot(next) {
      const kept = allStored();
      snapshot = next;
      load(kept, []);
    },
  };
}
