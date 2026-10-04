/**
 * The Oxia walks (SB1-7.2, SB1-7.6 to SB1-7.8, SB1-8, SB1-9) and the shared in-memory client they run over.
 *
 * The first describe holds the fake's own rules, so a walk test that passes is not passing over a fake that answers
 * what no server would. The walks are then checked against the sorted truth of the same key sets the order and merge
 * tests use: every page of every size, both orders, and the namespaces built to hide keys.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type {
  OxiaCallOptions,
  OxiaClient,
  OxiaComparison,
  OxiaKeysAnswer,
  OxiaShard,
  OxiaSnapshot,
  OxiaStream,
} from "@/lib/db/providers/keyvalue/oxia/client";
import {
  OXIA_DISCOVERY_DEADLINE_MS,
  OXIA_DISCOVERY_MAX_CALLS,
  OXIA_LIMITER_OPTIONS,
  OXIA_ORDER_PROBE_BYTES,
  OXIA_PAGE_KEPT_BYTES,
  OXIA_RECEIVE_CAP_BYTES,
  OXIA_RUN_BYTE_BUDGET,
} from "@/lib/db/providers/keyvalue/oxia/constants";
import {
  OXIA_STALLED_PAGE_SENTENCE,
  OxiaError,
  recordChangedSentence,
  toProviderError,
} from "@/lib/db/providers/keyvalue/oxia/errors";
import { goPathEscape } from "@/lib/db/providers/keyvalue/oxia/merge";
import { type KeyOrder, keyComparator, topNode, verdictIsProvisional } from "@/lib/db/providers/keyvalue/oxia/order";
import { shardFor } from "@/lib/db/providers/keyvalue/oxia/routing";
import {
  childrenPage,
  comparisonGet,
  detectKeyOrder,
  discoverTopNodes,
  fullWalkPage,
  limitedOxiaClient,
  listRange,
  prefixListPage,
  prefixScanPage,
  prefixWalkPage,
  rangeScanPage,
  readDepth,
  readKeys,
} from "@/lib/db/providers/keyvalue/oxia/walks";
import { engineLimiter, LimiterFullError } from "@/lib/db/utils/bounded-limiter";
import { createFakeOxiaClient, type FakeOxiaOptions, type FakeOxiaRecord } from "../../../helpers/oxia-fake-client";
import { blindSpotKeyset, j4Keyset, pulsarKeyset, sortedKeys } from "../../../helpers/oxia-keyset";

const ORDERS: readonly KeyOrder[] = ["hierarchical", "natural"];
const MIB = 1024 * 1024;

/** A call that ends in `ms`, under `signal`. */
const callOf = (ms = 10_000, signal = new AbortController().signal) => ({ signal, deadline: Date.now() + ms });

/** Every message of a stream, read one after another to its end. */
async function drain<T>(stream: OxiaStream<T>): Promise<(readonly T[])[]> {
  const messages: (readonly T[])[] = [];
  // oxlint-disable-next-line no-await-in-loop -- one reader: each read waits for the one before it.
  for (let message = await stream.next(); message !== undefined; message = await stream.next()) messages.push(message);
  return messages;
}

/** Every key of one shard, read with one List over the whole range. */
async function listShard(client: OxiaClient, shard: OxiaShard): Promise<string[]> {
  const stream = client.list(shard, { startInclusive: "", endExclusive: "" }, { ...callOf(), maxReceivedBytes: 1e12 });
  return (await drain(stream)).flat();
}

/** The keys of a shard under the model of a comparison get: the encoder's order over that shard's own keys. */
function modelGet(
  keys: readonly string[],
  key: string,
  comparison: OxiaComparison,
  order: KeyOrder,
): string | undefined {
  const cmp = keyComparator(order);
  const sorted = sortedKeys(keys, order);
  switch (comparison) {
    case "EQUAL":
      return sorted.find((candidate) => cmp(candidate, key) === 0);
    case "CEILING":
      return sorted.find((candidate) => cmp(candidate, key) >= 0);
    case "HIGHER":
      return sorted.find((candidate) => cmp(candidate, key) > 0);
    case "FLOOR":
      return sorted.findLast((candidate) => cmp(candidate, key) <= 0);
    case "LOWER":
      return sorted.findLast((candidate) => cmp(candidate, key) < 0);
  }
}

/** A promise that settles to the rejection, so a test can inspect what a call failed with. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("The call answered instead of failing");
}

/** The varint length of n, as protobuf writes a length prefix. */
const varint = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : n < 0x200000 ? 3 : 4);
const listCost = (key: string) => Buffer.byteLength(key) + 1 + varint(Buffer.byteLength(key));

describe("the shared fake", () => {
  test("its snapshot splits the hash space evenly, as the server's GenerateShards does", async () => {
    const fake = createFakeOxiaClient({ order: "natural", records: [] });
    const snapshot = await fake.getSnapshot(callOf());
    expect(snapshot.namespace).toBe("default");
    expect(snapshot.shards.map((shard) => [shard.id, shard.minHash, shard.maxHash])).toEqual([
      ["0", 0, 1431655765],
      ["1", 1431655766, 2863311531],
      ["2", 2863311532, 4294967295],
    ]);
    expect(snapshot.shards[0].leader).toEqual({
      host: "localhost",
      port: 6648,
      address: "localhost:6648",
      bootstrap: true,
    });
    const wide = await createFakeOxiaClient({ order: "natural", records: [], shards: 1_024 }).getSnapshot(callOf());
    expect(wide.shards).toHaveLength(1_024);
    expect(wide.shards[0].minHash).toBe(0);
    expect(wide.shards[1_023].maxHash).toBe(4294967295);
    wide.shards.slice(1).forEach((shard, i) => {
      expect(shard.minHash).toBe(wide.shards[i].maxHash + 1);
    });
    const named = createFakeOxiaClient({
      order: "natural",
      records: [],
      namespace: "ns",
      leader: "oxia-0.example:7000",
    });
    const other = await named.getSnapshot(callOf());
    expect(other.namespace).toBe("ns");
    expect(other.shards[2].leader.address).toBe("oxia-0.example:7000");
  });

  for (const order of ORDERS) {
    test(`every record is on the shard shardFor names, by its key or its partition key (${order})`, async () => {
      const fake = createFakeOxiaClient({ order, records: j4Keyset().map((key) => ({ key })) });
      const snapshot = await fake.getSnapshot(callOf());
      const listed = await Promise.all(snapshot.shards.map((shard) => listShard(fake, shard)));
      snapshot.shards.forEach((shard, i) => {
        const truth = j4Keyset().filter((key) => shardFor(snapshot, key).id === shard.id);
        expect(listed[i]).toEqual([...sortedKeys(truth, order)]);
      });
      fake.put({ key: "/t/x", partitionKey: "tenant-a" });
      const home = shardFor(snapshot, "", "tenant-a");
      expect(await listShard(fake, home)).toContain("/t/x");
    });

    // About 2 s alone with coverage and four times that beside a full parallel run, so it carries its own timeout.
    test(`gets answer by the encoder over the shard's own keys (${order})`, async () => {
      const fake = createFakeOxiaClient({
        order,
        records: j4Keyset().map((key) => ({ key, value: Uint8Array.of(1) })),
      });
      const snapshot = await fake.getSnapshot(callOf());
      const asked = j4Keyset().filter((_, i) => i % 60 === 0);
      expect(asked.length).toBeGreaterThanOrEqual(50);
      const comparisons: OxiaComparison[] = ["FLOOR", "CEILING", "LOWER", "HIGHER"];
      const pairs = snapshot.shards.flatMap((shard) => asked.map((key) => ({ shard, key })));
      const answered = await Promise.all(
        pairs.map(({ shard, key }) =>
          fake.read(
            shard,
            comparisons.map((comparison) => ({ key, comparison, includeValue: false })),
            callOf(),
          ),
        ),
      );
      pairs.forEach(({ shard, key }, p) => {
        const own = j4Keyset().filter((candidate) => shardFor(snapshot, candidate).id === shard.id);
        answered[p].forEach((answer, i) => {
          expect(answer.key).toBe(modelGet(own, key, comparisons[i], order));
          expect(answer.status).toBe(answer.key === undefined ? "KEY_NOT_FOUND" : "OK");
          expect(answer.value).toBeUndefined();
        });
      });
      const key = asked[0];
      const [equal] = await fake.read(
        shardFor(snapshot, key),
        [{ key, comparison: "EQUAL", includeValue: true }],
        callOf(),
      );
      expect(equal.key).toBe(key);
      expect(equal.value).toEqual(Uint8Array.of(1));
      const [missing] = await fake.read(
        shardFor(snapshot, "no such key"),
        [{ key: "no such key", comparison: "EQUAL", includeValue: true }],
        callOf(),
      );
      expect(missing).toEqual({ status: "KEY_NOT_FOUND" });
    }, 30_000);
  }

  test("versions count per shard, and a replace keeps the creation time", async () => {
    const fake = createFakeOxiaClient({ order: "natural", records: [] });
    const snapshot = await fake.getSnapshot(callOf());
    const get = async (key: string) =>
      (await fake.read(shardFor(snapshot, key), [{ key, comparison: "EQUAL", includeValue: false }], callOf()))[0];
    fake.put({ key: "a" });
    const first = (await get("a")).version;
    fake.put({ key: "a", sessionId: "7", clientIdentity: "me" });
    const second = (await get("a")).version;
    expect(Number(second?.versionId)).toBeGreaterThan(Number(first?.versionId));
    expect(first?.modificationsCount).toBe("0");
    expect(second?.modificationsCount).toBe("1");
    expect(second?.createdTimestamp).toBe(first?.createdTimestamp);
    expect(Number(second?.modifiedTimestamp)).toBeGreaterThan(Number(first?.modifiedTimestamp));
    expect(first?.sessionId).toBeUndefined();
    expect(second?.sessionId).toBe("7");
    expect(second?.clientIdentity).toBe("me");
    fake.remove("a");
    expect((await get("a")).status).toBe("KEY_NOT_FOUND");
    fake.remove("a");
    expect(() => fake.put({ key: "__oxia/x" })).toThrow(new RangeError("The fake stores no internal key"));
  });

  test("streams arrive in chunks, honour the received limit, and cancel", async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `key-${String(i).padStart(2, "0")}`);
    const fake = createFakeOxiaClient({
      order: "natural",
      records: keys.map((key) => ({ key })),
      shards: 1,
      chunkBytes: 64,
    });
    const [shard] = (await fake.getSnapshot(callOf())).shards;
    const stream = fake.list(shard, { startInclusive: "", endExclusive: "" }, { ...callOf(), maxReceivedBytes: 1e9 });
    const messages = await drain(stream);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.flat()).toEqual(keys);
    const cost = keys.reduce((sum, key) => sum + listCost(key), 0);
    expect(stream.receivedBytes).toBe(cost);
    expect(fake.receivedBytes).toBe(cost);
    expect(stream.truncated).toBe(false);
    expect(fake.openStreams).toBe(0);

    const limited = fake.list(shard, { startInclusive: "", endExclusive: "" }, { ...callOf(), maxReceivedBytes: 100 });
    const got = (await drain(limited)).flat();
    expect(limited.truncated).toBe(true);
    // Eight keys of 8 bytes fill each 64-byte message: the second one crosses 100 and is still delivered.
    expect(limited.receivedBytes).toBe(128);
    expect(got).toEqual(keys.slice(0, 16));

    const cancelled = fake.list(
      shard,
      { startInclusive: "key-05", endExclusive: "key-10" },
      { ...callOf(), maxReceivedBytes: 1e9 },
    );
    expect(await cancelled.next()).toEqual(["key-05", "key-06", "key-07", "key-08", "key-09"]);
    expect(fake.openStreams).toBe(1);
    cancelled.cancel();
    cancelled.cancel();
    expect(cancelled.truncated).toBe(true);
    expect(fake.openStreams).toBe(0);
    expect(await cancelled.next()).toBeUndefined();
    const scanned = fake.rangeScan(
      shard,
      { startInclusive: "key-18", endExclusive: "" },
      { ...callOf(), maxReceivedBytes: 1e9 },
    );
    const records = await scanned.next();
    expect(records?.map((record) => [record.key, record.value?.length, record.version?.versionId])).toEqual([
      ["key-18", 0, "19"],
    ]);
    expect(await scanned.next()).toEqual([expect.objectContaining({ key: "key-19" })]);
    expect(await scanned.next()).toBeUndefined();
    expect(scanned.truncated).toBe(false);
  });

  test("the receive cap fails a Read with the answers before it, and a RangeScan at the record", async () => {
    const small = Uint8Array.of(1);
    const fake = createFakeOxiaClient({
      order: "natural",
      shards: 1,
      receiveCapBytes: 1_024,
      records: [
        { key: "a", value: small },
        { key: "b", value: new Uint8Array(2_048) },
        { key: "c", value: small },
      ],
    });
    const [shard] = (await fake.getSnapshot(callOf())).shards;
    const gets = ["a", "b", "c"].map((key) => ({ key, comparison: "EQUAL" as const, includeValue: true }));
    const error = await failure(fake.read(shard, gets, callOf()));
    expect(error).toBeInstanceOf(OxiaError);
    expect(error).toMatchObject({ category: "receive-cap", rpc: "Read", answered: 1, shardId: "0" });
    const scan = fake.rangeScan(
      shard,
      { startInclusive: "", endExclusive: "" },
      { ...callOf(), maxReceivedBytes: 1e9 },
    );
    expect((await scan.next())?.map((record) => record.key)).toEqual(["a"]);
    expect(await failure(scan.next())).toMatchObject({ category: "receive-cap", rpc: "RangeScan", shardId: "0" });
    expect(fake.openStreams).toBe(0);

    const value = new Uint8Array(3 * MIB);
    const big = createFakeOxiaClient({
      order: "natural",
      shards: 1,
      records: ["w", "x", "y", "z"].map((key) => ({ key, value })),
    });
    const [only] = (await big.getSnapshot(callOf())).shards;
    const four = ["w", "x", "y", "z"].map((key) => ({ key, comparison: "EQUAL" as const, includeValue: true }));
    expect(await failure(big.read(only, four, callOf()))).toMatchObject({ category: "receive-cap", answered: 3 });
    expect(await failure(big.read(only, [], callOf()))).toEqual(new RangeError("A Read sends 1 to 1,000 gets"));
    const many = Array.from({ length: 1_001 }, () => four[0]);
    expect(await failure(big.read(only, many, callOf()))).toEqual(new RangeError("A Read sends 1 to 1,000 gets"));
  });

  test("a Read honours its call's received-bytes limit, and records it (ruling R24)", async () => {
    // One record per message, each 133 bytes (a 1-byte key, 100 bytes of value, the version fields).
    const keys = ["w", "x", "y", "z"];
    const fake = createFakeOxiaClient({
      order: "natural",
      shards: 1,
      chunkBytes: 1,
      records: keys.map((key) => ({ key, value: new Uint8Array(100) })),
    });
    const [shard] = (await fake.getSnapshot(callOf())).shards;
    const gets = keys.map((key) => ({ key, comparison: "EQUAL" as const, includeValue: true }));
    const cut = await failure(fake.read(shard, gets, { ...callOf(), maxReceivedBytes: 200 }));
    expect(cut).toMatchObject({ category: "receive-cap", rpc: "Read", answered: 2, shardId: "0" });
    expect(fake.calls.at(-1)).toEqual({ rpc: "Read", shard: "0", gets, maxReceivedBytes: 200 });
    // The message that crosses the limit is delivered, so a Read whose last answer crosses it answers every get.
    const two = await fake.read(shard, gets.slice(0, 2), { ...callOf(), maxReceivedBytes: 200 });
    expect(two.map((record) => record.key)).toEqual(["w", "x"]);
    // Without a limit, the run budget is the Read's.
    expect((await fake.read(shard, gets, callOf())).length).toBe(4);
    expect(fake.calls.at(-1)).toEqual({ rpc: "Read", shard: "0", gets });
  });

  test("a hook runs before a Read answers, and failNext fails a stream after its messages", async () => {
    const keys = Array.from({ length: 300 }, (_, i) => `k${i}`);
    const fake = createFakeOxiaClient({ order: "natural", records: keys.map((key) => ({ key })), chunkBytes: 64 });
    const snapshot = await fake.getSnapshot(callOf());
    const shard = shardFor(snapshot, "k1");
    fake.onCall((call) => {
      if (call.rpc === "Read") fake.remove("k1");
    });
    const [answer] = await fake.read(shard, [{ key: "k1", comparison: "EQUAL", includeValue: false }], callOf());
    expect(answer.status).toBe("KEY_NOT_FOUND");
    fake.onCall(() => undefined);
    const planted = new Error("planted");
    const one = snapshot.shards[1];
    fake.failNext({ rpc: "List", shard: "1" }, planted, 1);
    const other = fake.list(
      snapshot.shards[0],
      { startInclusive: "", endExclusive: "" },
      { ...callOf(), maxReceivedBytes: 1e9 },
    );
    expect(await other.next()).toBeDefined();
    other.cancel();
    const stream = fake.list(one, { startInclusive: "", endExclusive: "" }, { ...callOf(), maxReceivedBytes: 1e9 });
    expect(await stream.next()).toBeDefined();
    expect(await failure(stream.next())).toBe(planted);
    expect(fake.openStreams).toBe(0);
  });

  test("signals, deadlines, a replaced map and close", async () => {
    const fake = createFakeOxiaClient({ order: "natural", records: [{ key: "a" }] });
    const snapshot = await fake.getSnapshot(callOf());
    const get = [{ key: "a", comparison: "EQUAL" as const, includeValue: false }];
    const controller = new AbortController();
    controller.abort();
    const shard = shardFor(snapshot, "a");
    expect(await failure(fake.read(shard, get, callOf(10_000, controller.signal)))).toMatchObject({
      category: "cancelled",
      unsent: true,
      rpc: "Read",
    });
    const stream = fake.list(
      shard,
      { startInclusive: "", endExclusive: "" },
      {
        ...callOf(10_000, controller.signal),
        maxReceivedBytes: 1e9,
      },
    );
    expect(await failure(stream.next())).toMatchObject({ category: "cancelled", unsent: true, rpc: "List" });
    const pending = new AbortController();
    fake.onCall(() => pending.abort());
    expect(await failure(fake.read(shard, get, callOf(10_000, pending.signal)))).toMatchObject({
      category: "cancelled",
    });
    expect(await failure(fake.read(shard, get, callOf(10_000, pending.signal)))).toMatchObject({ unsent: true });
    const late = new AbortController();
    const scan = fake.rangeScan(
      shard,
      { startInclusive: "", endExclusive: "" },
      {
        ...callOf(10_000, late.signal),
        maxReceivedBytes: 1e9,
      },
    );
    fake.onCall(() => late.abort());
    const lateError = await failure(scan.next());
    expect(lateError).toMatchObject({ category: "cancelled", rpc: "RangeScan" });
    expect((lateError as OxiaError).unsent).toBeUndefined();
    fake.onCall(() => undefined);
    expect(await failure(fake.read(shard, get, callOf(-1)))).toMatchObject({ category: "deadline-exceeded" });
    expect(await failure(fake.getSnapshot(callOf(-1)))).toMatchObject({ category: "deadline-exceeded" });
    const past = fake.list(shard, { startInclusive: "", endExclusive: "" }, { ...callOf(-1), maxReceivedBytes: 1e9 });
    expect(await failure(past.next())).toMatchObject({ category: "deadline-exceeded", rpc: "List", shardId: shard.id });
    expect(await failure(fake.health(callOf(10_000, controller.signal)))).toMatchObject({ category: "cancelled" });
    expect(await fake.health(callOf())).toBe("SERVING");

    const two = createFakeOxiaClient({ order: "natural", records: [], shards: 2 });
    fake.setSnapshot(await two.getSnapshot(callOf()));
    const moved = await fake.getSnapshot(callOf());
    expect(moved.shards).toHaveLength(2);
    expect((await listShard(fake, shardFor(moved, "a"))).includes("a")).toBe(true);
    expect(await failure(fake.read(snapshot.shards[2], get, callOf()))).toMatchObject({
      category: "shard-not-found",
      shardId: "2",
    });
    const gone = fake.list(
      snapshot.shards[2],
      { startInclusive: "", endExclusive: "" },
      { ...callOf(), maxReceivedBytes: 1 },
    );
    expect(await failure(gone.next())).toMatchObject({ category: "shard-not-found", rpc: "List" });

    expect(fake.closed).toBe(false);
    fake.close();
    expect(fake.closed).toBe(true);
    const refused = await Promise.all(
      [
        fake.getSnapshot(callOf()),
        fake.read(moved.shards[0], get, callOf()),
        fake.health(callOf()),
        fake
          .list(moved.shards[0], { startInclusive: "", endExclusive: "" }, { ...callOf(), maxReceivedBytes: 1 })
          .next(),
      ].map(failure),
    );
    for (const error of refused) expect(error).toMatchObject({ category: "closed" });
  });

  test("the index model: one shard's index gets, List and RangeScan", async () => {
    const fake = createFakeOxiaClient({
      order: "natural",
      shards: 1,
      records: [
        { key: "p1", secondaryIndexes: { i: "s" } },
        { key: "p2", secondaryIndexes: { i: "s" } },
        { key: "p3", secondaryIndexes: { i: "t" } },
        { key: "p4" },
      ],
    });
    const [shard] = (await fake.getSnapshot(callOf())).shards;
    const get = async (key: string, comparison: OxiaComparison) =>
      (await fake.read(shard, [{ key, comparison, includeValue: false, secondaryIndexName: "i" }], callOf()))[0];
    expect(await get("s", "EQUAL")).toMatchObject({ status: "OK", key: "p1", secondaryIndexKey: "s" });
    expect((await get("s0", "CEILING")).key).toBe("p3");
    expect((await get("s", "HIGHER")).key).toBe("p3");
    expect((await get("t", "LOWER")).key).toBe("p2");
    expect((await get("s", "FLOOR")).key).toBe("p2");
    expect(await get("u", "EQUAL")).toEqual({ status: "KEY_NOT_FOUND" });
    expect(await get("a", "LOWER")).toEqual({ status: "KEY_NOT_FOUND" });
    const range = { startInclusive: "s", endExclusive: "t", secondaryIndexName: "i" };
    const ranged = fake.list(shard, range, { ...callOf(), maxReceivedBytes: 1e9 });
    expect(await ranged.next()).toEqual(["p1", "p2"]);
    expect(await ranged.next()).toBeUndefined();
    const all = fake.list(
      shard,
      { startInclusive: "", endExclusive: "", secondaryIndexName: "i" },
      {
        ...callOf(),
        maxReceivedBytes: 1e9,
      },
    );
    expect(await all.next()).toEqual(["p1", "p2", "p3"]);
    const scan = fake.rangeScan(shard, range, { ...callOf(), maxReceivedBytes: 1e9 });
    expect((await scan.next())?.map((record) => record.key)).toEqual(["p1", "p2"]);
    expect(goPathEscape("p1")).toBe("p1");
  });

  test("peakInFlight counts calls held at once, and values are never copied", async () => {
    const fake = createFakeOxiaClient({ order: "natural", records: [{ key: "a" }] });
    const snapshot = await fake.getSnapshot(callOf());
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.onCall(() => gate);
    const get = [{ key: "a", comparison: "EQUAL" as const, includeValue: false }];
    const reads = Array.from({ length: 20 }, () => fake.read(shardFor(snapshot, "a"), get, callOf()));
    await Bun.sleep(5);
    open();
    await Promise.all(reads);
    expect(fake.peakInFlight).toBe(20);

    const value = new Uint8Array(15 * MIB);
    const records = Array.from({ length: 1_024 }, (_, i) => ({ key: `r${i}`, value }));
    const wide = createFakeOxiaClient({ order: "natural", shards: 1_024, records });
    const wideSnapshot = await wide.getSnapshot(callOf());
    const read = async (key: string) =>
      (await wide.read(shardFor(wideSnapshot, key), [{ key, comparison: "EQUAL", includeValue: true }], callOf()))[0];
    const first = await read("r0");
    const last = await read("r1023");
    expect(first.value).toBe(value);
    expect(last.value).toBe(first.value as Uint8Array);
  });

  test("failNext fails the next snapshot and health call once (ruling R10)", async () => {
    const fake = createFakeOxiaClient({ order: "natural", records: [] });
    const planted = new OxiaError("unavailable", { rpc: "GetShardAssignments" });
    fake.failNext({ rpc: "GetShardAssignments" }, planted);
    expect(await failure(fake.getSnapshot(callOf()))).toBe(planted);
    expect((await fake.getSnapshot(callOf())).shards).toHaveLength(3);
    const unhealthy = new OxiaError("unavailable", { rpc: "Health/Check" });
    fake.failNext({ rpc: "Health/Check" }, unhealthy);
    expect(await failure(fake.health(callOf()))).toBe(unhealthy);
    expect(await fake.health(callOf())).toBe("SERVING");
    const readFailure = new OxiaError("unavailable", { rpc: "Read" });
    fake.failNext({ rpc: "Read" }, readFailure);
    const snapshot = await fake.getSnapshot(callOf());
    expect(
      await failure(fake.read(snapshot.shards[0], [{ key: "a", comparison: "EQUAL", includeValue: false }], callOf())),
    ).toBe(readFailure);
    expect(fake.calls.map((call) => call.rpc)).toEqual([
      "GetShardAssignments",
      "GetShardAssignments",
      "Health/Check",
      "Health/Check",
      "GetShardAssignments",
      "Read",
    ]);
  });

  test("a deadline carries the shard and its leader (ruling R10)", async () => {
    const fake = createFakeOxiaClient({ order: "natural", records: [{ key: "a" }], leader: "oxia-2.example:6648" });
    const snapshot = await fake.getSnapshot(callOf());
    fake.onCall(() => Bun.sleep(30));
    const shard = shardFor(snapshot, "a");
    const error = await failure(fake.read(shard, [{ key: "a", comparison: "EQUAL", includeValue: false }], callOf(10)));
    expect(error).toBeInstanceOf(OxiaError);
    expect(error).toMatchObject({
      category: "deadline-exceeded",
      rpc: "Read",
      shardId: shard.id,
      leader: shard.leader.address,
    });
    expect(OXIA_RECEIVE_CAP_BYTES).toBe(16 * MIB);
  });
});

// -- the walks -------------------------------------------------------------------------------------------------------

/** A fake over `keys` (or full records) and its snapshot. */
async function fakeOf(order: KeyOrder, keys: readonly (string | FakeOxiaRecord)[], more?: Partial<FakeOxiaOptions>) {
  const records = keys.map((key) => (typeof key === "string" ? { key } : key));
  const fake = createFakeOxiaClient({ order, records, ...more });
  return { fake, snapshot: await fake.getSnapshot(callOf()) };
}

/** Pages a walk until `more` is false, threading the last key as the cursor; every key it returned, in order. */
async function walkAll(page: (cursor: string | undefined) => Promise<OxiaKeysAnswer>, count: number) {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 200_000; pages++) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the cursor the one before it wrote.
    const answer = await page(cursor);
    if (answer.keys.length > count) throw new Error(`A page held ${answer.keys.length} keys, more than ${count}`);
    keys.push(...answer.keys);
    if (!answer.more) return keys;
    cursor = answer.keys.length > 0 ? answer.keys[answer.keys.length - 1] : cursor;
  }
  throw new Error("The walk did not end");
}

/** The engine key of one test's limiter: `engineLimiter` shares one table per key in the process. */
let limiterKeys = 0;
const limiterFactory = () => engineLimiter(`oxia-walks-test-${limiterKeys++}`, OXIA_LIMITER_OPTIONS);

/** A gate an `onCall` hook holds calls at, counting them while they wait. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { held: 0, peak: 0 };
  return {
    state,
    open,
    hold: async () => {
      state.held++;
      state.peak = Math.max(state.peak, state.held);
      await opened;
      state.held--;
    },
  };
}

/** Polls until `ready` or a second has passed. */
async function until(ready: () => boolean): Promise<void> {
  const end = Date.now() + 1_000;
  // oxlint-disable-next-line no-await-in-loop -- a poll: each check waits for the one before it.
  while (!ready() && Date.now() < end) await Bun.sleep(2);
}

const ERROR_CONNECTION = {
  host: "localhost",
  port: 6648,
  sentAuthority: "localhost:6648",
  loopback: true,
  tunnelled: false,
  runtimeReportsTlsCause: true,
  receiveCapBytes: OXIA_RECEIVE_CAP_BYTES,
  timeoutMs: 10_000,
  namespace: "default",
  listsDataServers: false,
};

const FLAT = ["config", "feature-flag.dark-mode", "user:42", "zz-last-flat", "a", "b", "c"];

describe("detectKeyOrder (SB1-7.2)", () => {
  for (const order of ORDERS) {
    test(`the J4 keyset is decided ${order} by the decisive List`, async () => {
      const { fake, snapshot } = await fakeOf(order, j4Keyset());
      expect(await detectKeyOrder(fake, snapshot, callOf())).toEqual({ order, learnedBy: "decisive-list" });
    });
  }

  test("flat keys: natural by the ceiling probe, hierarchical assumed after every shard ended", async () => {
    const natural = await fakeOf("natural", FLAT);
    expect(await detectKeyOrder(natural.fake, natural.snapshot, callOf())).toEqual({
      order: "natural",
      learnedBy: "ceiling-probe",
    });
    const hierarchical = await fakeOf("hierarchical", FLAT);
    const verdict = await detectKeyOrder(hierarchical.fake, hierarchical.snapshot, callOf());
    expect(verdict).toEqual({ order: "hierarchical", learnedBy: "assumed" });
    expect(verdict.exhausted).toBeUndefined();
    expect(verdictIsProvisional(verdict)).toBe(true);
  });

  test("an empty namespace is three Reads and no List", async () => {
    const { fake, snapshot } = await fakeOf("natural", []);
    expect(await detectKeyOrder(fake, snapshot, callOf())).toEqual({ order: "hierarchical", learnedBy: "empty" });
    expect(fake.calls.filter((call) => call.rpc === "Read")).toHaveLength(3);
    expect(fake.calls.filter((call) => call.rpc === "List")).toHaveLength(0);
  });

  test("a telling pair in the sample decides, and a sampled key with / runs the decisive List", async () => {
    const paired = await fakeOf("natural", ["!a/b", "#c", ".z"], { shards: 1 });
    expect(await detectKeyOrder(paired.fake, paired.snapshot, callOf())).toEqual({
      order: "natural",
      learnedBy: "pair-sample",
    });
    // 99 flat keys, then the only key with "/" as the sample's hundredth, then a flat key above it: no pair tells.
    const flat = Array.from({ length: 99 }, (_, i) => `!${String(i).padStart(3, "0")}`);
    const sampled = await fakeOf("natural", [...flat, "!a/b", ".z"], { shards: 1 });
    expect(await detectKeyOrder(sampled.fake, sampled.snapshot, callOf())).toEqual({
      order: "natural",
      learnedBy: "decisive-list",
    });
  });

  for (const chunkBytes of [undefined, 256]) {
    test(`the blind spot (F2) is decided natural, and its walks find the keys (chunk ${chunkBytes ?? "default"})`, async () => {
      const keys = blindSpotKeyset(1_000);
      const { fake, snapshot } = await fakeOf("natural", keys, chunkBytes === undefined ? {} : { chunkBytes });
      for (const shard of snapshot.shards) {
        const own = keys.filter((key) => shardFor(snapshot, key).id === shard.id);
        expect(own.some((key) => key.startsWith(".z"))).toBe(true);
        expect(own.filter((key) => key.startsWith("!")).length).toBeGreaterThanOrEqual(100);
      }
      expect(await detectKeyOrder(fake, snapshot, callOf())).toEqual({ order: "natural", learnedBy: "decisive-list" });
      if (chunkBytes !== undefined) {
        // The read-on path ran: a List resumed from a shard's last sampled key.
        expect(fake.calls.some((call) => call.rpc === "List" && call.range?.startInclusive.startsWith("!"))).toBe(true);
      }
      const truth = sortedKeys(keys, "natural");
      const children = await walkAll(
        (cursor) => childrenPage(fake, snapshot, "natural", { parent: "#svc", cursor, count: 7 }, callOf()),
        7,
      );
      expect(children).toEqual(truth.filter((key) => key.startsWith("#svc/") && key.indexOf("/", 5) === -1));
      expect(children.length).toBeGreaterThan(0);
      const prefixed = await walkAll(
        (cursor) => prefixWalkPage(fake, snapshot, "natural", { prefix: "#svc/", cursor, count: 7 }, callOf()),
        7,
      );
      expect(prefixed).toEqual(truth.filter((key) => key.startsWith("#svc/")));
      expect(prefixed).toHaveLength(3);
    });
  }

  test("the probe's byte cap ends the reading: hierarchical, assumed, exhausted", async () => {
    const keys = Array.from({ length: 30_000 }, (_, i) => `!${String(i).padStart(6, "0")}${"x".repeat(1024)}`);
    keys.push("#svc/a", "#svc/a/x", "#svc/b", ...Array.from({ length: 10 }, (_, i) => `.z${i}`));
    const { fake, snapshot } = await fakeOf("natural", keys);
    const before = fake.receivedBytes;
    const verdict = await detectKeyOrder(fake, snapshot, callOf());
    expect(verdict).toEqual({ order: "hierarchical", learnedBy: "assumed", exhausted: true });
    const received = fake.receivedBytes - before;
    expect(received).toBeGreaterThanOrEqual(OXIA_ORDER_PROBE_BYTES);
    expect(received).toBeLessThanOrEqual(OXIA_ORDER_PROBE_BYTES + 8 * 2 * MIB);
    expect(verdictIsProvisional(verdict)).toBe(true);
  }, 30_000);

  test("a stream cut by its own limit before a key with / is the cap too", async () => {
    // One shard of 3 KiB flat keys: the sample's message and the read-on stream's 4 MiB limit come before the 8 MiB
    // total, so the stream's own cut ends the reading.
    const keys = Array.from({ length: 3_000 }, (_, i) => `!${String(i).padStart(5, "0")}${"y".repeat(3 * 1024)}`);
    const { fake, snapshot } = await fakeOf("natural", [...keys, "#a/b", ".z"], { shards: 1 });
    expect(await detectKeyOrder(fake, snapshot, callOf())).toEqual({
      order: "hierarchical",
      learnedBy: "assumed",
      exhausted: true,
    });
  });

  test("a probe failure propagates as the client's OxiaError", async () => {
    const { fake, snapshot } = await fakeOf("natural", FLAT);
    const planted = new OxiaError("unavailable", { rpc: "Read", shardId: "1" });
    fake.failNext({ rpc: "Read", shard: "1" }, planted);
    expect(await failure(detectKeyOrder(fake, snapshot, callOf()))).toBe(planted);
  });
});

/** The children of node `p` in the truth: keys `p + "/" + s`, s holding no "/". */
const childrenIn = (truth: readonly string[], p: string) =>
  truth.filter((key) => key.startsWith(`${p}/`) && key.indexOf("/", p.length + 1) === -1);

/** The 200 prefixes of T06's band properties: never empty, never splitting a surrogate pair. */
function prefixes(): string[] {
  const keys = j4Keyset();
  return Array.from({ length: 200 }, (_, i) => {
    const points = [...keys[(i * 15) % keys.length]];
    return points.slice(0, (i % points.length) + 1).join("");
  });
}

describe("pages against the sorted truth (SB1-7.8)", () => {
  for (const order of ORDERS) {
    for (const [name, keys] of [
      ["J4", j4Keyset()],
      ["Pulsar", pulsarKeyset(2_000)],
    ] as const) {
      test(`fullWalkPage over the ${name} keyset, pages of 1, 7 and 500 (${order})`, async () => {
        const { fake, snapshot } = await fakeOf(order, keys);
        const truth = sortedKeys(keys, order);
        for (const count of [1, 7, 500]) {
          const pages: OxiaKeysAnswer[] = [];
          // oxlint-disable-next-line no-await-in-loop -- one page size after the other, over the same fake.
          const walked = await walkAll(async (cursor) => {
            const answer = await fullWalkPage(fake, snapshot, order, { cursor, count }, callOf());
            pages.push(answer);
            return answer;
          }, count);
          expect(walked).toEqual([...truth]);
          expect(pages[pages.length - 1].more).toBe(false);
          expect(pages.every((page) => page.shardsRead === 3)).toBe(true);
        }
      }, 120_000);
    }

    test(`childrenPage over every node of the J4 keyset, pages of 7 (${order})`, async () => {
      const { fake, snapshot } = await fakeOf(order, j4Keyset());
      const truth = sortedKeys(j4Keyset(), order);
      const nodes = new Set([
        "",
        ...j4Keyset()
          .filter((key) => key.includes("/"))
          .map((key) => key.slice(0, key.lastIndexOf("/"))),
      ]);
      const walked = await Promise.all(
        [...nodes].map(async (parent) => ({
          parent,
          keys: await walkAll(
            (cursor) => childrenPage(fake, snapshot, order, { parent, cursor, count: 7 }, callOf()),
            7,
          ),
        })),
      );
      for (const { parent, keys } of walked)
        expect({ parent, keys }).toEqual({ parent, keys: childrenIn(truth, parent) });
    }, 120_000);

    test(`prefixWalkPage over T06's 200 prefixes, pages of 1 and 7 (${order})`, async () => {
      const { fake, snapshot } = await fakeOf(order, j4Keyset());
      const truth = sortedKeys(j4Keyset(), order);
      for (const count of [1, 7]) {
        // oxlint-disable-next-line no-await-in-loop -- one page size after the other, over the same fake.
        const walked = await Promise.all(
          [...new Set([...prefixes(), "\u0000"])].map(async (prefix) => ({
            prefix,
            keys: await walkAll(
              (cursor) => prefixWalkPage(fake, snapshot, order, { prefix, cursor, count }, callOf()),
              count,
            ),
          })),
        );
        for (const { prefix, keys } of walked) {
          expect({ prefix, keys }).toEqual({ prefix, keys: truth.filter((key) => key.startsWith(prefix)) });
          expect(new Set(keys).size).toBe(keys.length);
        }
      }
    }, 300_000);

    test(`prefixWalkPage with a partition key reads its one shard (${order})`, async () => {
      const tenant = ["/t/a", "/t/b", "/t/c/d"].map((key) => ({ key, partitionKey: "tenant-a" }));
      const { fake, snapshot } = await fakeOf(order, [...j4Keyset(), ...tenant]);
      const home = shardFor(snapshot, "", "tenant-a").id;
      const before = fake.calls.length;
      const answer = await prefixWalkPage(
        fake,
        snapshot,
        order,
        { prefix: "/t/", count: 7, partitionKey: "tenant-a" },
        callOf(),
      );
      expect(answer).toEqual({ keys: sortedKeys(["/t/a", "/t/b", "/t/c/d"], order), more: false, shardsRead: 1 });
      expect(fake.calls.slice(before).every((call) => call.shard === home)).toBe(true);
    });
  }

  test("the inclusive cursor misses no key ending in // (J4 2, K2)", async () => {
    const keys = ["/a//", "/a/b//", "/p//", "x//y", "/a", "/a/b", "/p", "/p/x", "x/", "x"];
    const { fake, snapshot } = await fakeOf("hierarchical", keys);
    const walked = await walkAll(
      (cursor) => fullWalkPage(fake, snapshot, "hierarchical", { cursor, count: 1 }, callOf()),
      1,
    );
    expect(walked).toEqual([...sortedKeys(keys, "hierarchical")]);
  });

  test("a page that cannot progress within the 4 MiB stream limit throws the stalled sentence", async () => {
    const big = `k${"x".repeat(4.5 * MIB)}`;
    const { fake, snapshot } = await fakeOf("natural", ["a", "b", big], { shards: 1 });
    const first = await fullWalkPage(fake, snapshot, "natural", { count: 10 }, callOf());
    expect(first).toEqual({ keys: ["a", "b", big], more: true, shardsRead: 1 });
    const error = await failure(fullWalkPage(fake, snapshot, "natural", { cursor: big, count: 10 }, callOf()));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toBe(OXIA_STALLED_PAGE_SENTENCE);
    expect((error as QueryError).provider as string).toBe("oxia");
  });

  test("a page on 1,024 shards keeps at most 16 MiB plus one key per shard (B-1)", async () => {
    const keys = Array.from({ length: 10_240 }, (_, i) => `${"k".repeat(4_090)}${String(i).padStart(6, "0")}`);
    const { fake, snapshot } = await fakeOf("natural", keys, { shards: 1_024, chunkBytes: 1 });
    const deltas: number[] = [];
    const walked = await walkAll(async (cursor) => {
      const before = fake.receivedBytes;
      const answer = await fullWalkPage(fake, snapshot, "natural", { cursor, count: 500 }, callOf());
      deltas.push(fake.receivedBytes - before);
      return answer;
    }, 500);
    expect(walked).toEqual([...sortedKeys(keys, "natural")]);
    for (const delta of deltas) expect(delta).toBeLessThanOrEqual(OXIA_PAGE_KEPT_BYTES + 1_024 * (4_096 + 8));
  }, 120_000);

  test("a prefix page keeps at most 16 MiB of keys across its bands, plus one key per shard (B-1)", async () => {
    // Six bands of 66 keys of 60 KiB on one shard: each band fits its 4 MiB stream, all six together pass 16 MiB.
    const pad = "x".repeat(60 * 1024);
    const keys: string[] = [];
    for (let level = 2; level <= 7; level++) {
      for (let i = 0; i < 66; i++) keys.push(`/p/${String(i).padStart(3, "0")}${"/a".repeat(level - 2)}${pad}`);
    }
    const { fake, snapshot } = await fakeOf("hierarchical", keys, { shards: 1 });
    const kept: number[] = [];
    const walked = await walkAll(async (cursor) => {
      const ask = { prefix: "/p/", cursor, count: 500 };
      const answer = await prefixWalkPage(fake, snapshot, "hierarchical", ask, callOf());
      kept.push(answer.keys.reduce((bytes, key) => bytes + Buffer.byteLength(key), 0));
      return answer;
    }, 500);
    expect(walked).toEqual([...sortedKeys(keys, "hierarchical")]);
    expect(kept.length).toBeGreaterThan(1);
    const longest = Math.max(...keys.map((key) => Buffer.byteLength(key)));
    for (const bytes of kept) expect(bytes).toBeLessThanOrEqual(OXIA_PAGE_KEPT_BYTES + longest);
  }, 30_000);

  test("a prefix page that has spent its budget ends before its next band (B-1)", async () => {
    // Five bands of 52 keys bring the page to 1 KiB under 16 MiB; the sixth band's one key of 64 KiB is kept as its
    // shard's first key, which spends the budget, so the seventh band's key waits for the next page.
    const sized = (head: string, bytes: number) => head + "x".repeat(bytes - head.length);
    const target = OXIA_PAGE_KEPT_BYTES - 1_024;
    const each = Math.floor(target / 260);
    const keys: string[] = [];
    for (let level = 2; level <= 6; level++) {
      for (let i = 0; i < 52; i++) {
        const bytes = each + (level === 2 && i === 0 ? target - 260 * each : 0);
        keys.push(sized(`/p/${String(i).padStart(3, "0")}${"/a".repeat(level - 2)}`, bytes));
      }
    }
    keys.push(sized(`/p/000${"/a".repeat(5)}`, 65_536), sized(`/p/000${"/a".repeat(6)}`, 65_536));
    const { fake, snapshot } = await fakeOf("hierarchical", keys, { shards: 1 });
    const first = await prefixWalkPage(fake, snapshot, "hierarchical", { prefix: "/p/", count: 500 }, callOf());
    expect(first.keys).toHaveLength(261);
    expect(first.keys.reduce((bytes, key) => bytes + Buffer.byteLength(key), 0)).toBe(target + 65_536);
    expect(first.more).toBe(true);
    const cursor = first.keys[first.keys.length - 1];
    const next = await prefixWalkPage(fake, snapshot, "hierarchical", { prefix: "/p/", cursor, count: 500 }, callOf());
    expect(next).toEqual({ keys: [keys[keys.length - 1]], more: false, shardsRead: 1 });
  }, 30_000);

  test("a shard that lists one key twice is a malformed answer", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a", "b", "c"]);
    const twice: OxiaClient = {
      ...fake,
      list(shard, range, call) {
        const inner = fake.list(shard, range, call);
        return {
          next: async () => {
            const message = await inner.next();
            return message === undefined ? undefined : [...message, ...message];
          },
          get receivedBytes() {
            return inner.receivedBytes;
          },
          get truncated() {
            return inner.truncated;
          },
          cancel: () => inner.cancel(),
        };
      },
    };
    const error = await failure(fullWalkPage(twice, snapshot, "natural", { count: 10 }, callOf()));
    expect(error).toMatchObject({ category: "malformed", rpc: "List" });
  });
});

describe("readKeys (SB1-9.3, C13)", () => {
  test("answers in ask order across shards, undefined for a miss, the value only when asked", async () => {
    const records = ["a", "b", "c", "d", "e", "f"].map((key) => ({ key, value: new TextEncoder().encode(key) }));
    const { fake, snapshot } = await fakeOf("natural", records);
    const answers = await readKeys(
      fake,
      snapshot,
      [
        { key: "f", includeValue: true },
        { key: "nope", includeValue: true },
        { key: "a", includeValue: false },
        { key: "c", includeValue: true },
      ],
      callOf(),
    );
    expect(answers[1]).toBeUndefined();
    expect(answers.map((answer) => answer?.key)).toEqual(["f", undefined, "a", "c"]);
    expect(answers.map((answer) => answer?.shard)).toEqual(
      ["f", "nope", "a", "c"].map((key, i) => (i === 1 ? undefined : shardFor(snapshot, key).id)),
    );
    expect(answers[0]?.value).toEqual(new TextEncoder().encode("f"));
    expect(answers[2]?.value).toBeUndefined();
    expect(answers[2]?.version.versionId).toBeDefined();
  });

  test("2,500 gets on one shard are three Reads of 1,000, 1,000 and 500", async () => {
    const keys = Array.from({ length: 2_500 }, (_, i) => `k${i}`);
    const { fake, snapshot } = await fakeOf("natural", keys, { shards: 1 });
    const answers = await readKeys(
      fake,
      snapshot,
      keys.map((key) => ({ key, includeValue: false })),
      callOf(),
    );
    expect(answers.map((answer) => answer?.key)).toEqual(keys);
    expect(fake.calls.filter((call) => call.rpc === "Read").map((call) => call.gets?.length)).toEqual([
      1_000, 1_000, 500,
    ]);
  });

  test("a receive-cap batch is read again up to its answered gets, then one by one", async () => {
    const value = new Uint8Array(3 * MIB);
    const keys = ["v1", "v2", "v3", "v4", "v5"];
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value })),
      { shards: 1 },
    );
    const answers = await readKeys(
      fake,
      snapshot,
      keys.map((key) => ({ key, includeValue: true })),
      callOf(),
    );
    expect(answers.map((answer) => answer?.value)).toEqual(keys.map(() => value));
    expect(fake.calls.filter((call) => call.rpc === "Read").map((call) => call.gets?.length)).toEqual([5, 3, 1, 1]);
  });

  test("a value over the receive cap is withheld, with its version", async () => {
    const value = new Uint8Array(17 * MIB);
    const { fake, snapshot } = await fakeOf("natural", [{ key: "huge", value }]);
    const [answer] = await readKeys(fake, snapshot, [{ key: "huge", includeValue: true }], callOf());
    expect(answer).toEqual({
      key: "huge",
      withheld: true,
      version: expect.objectContaining({ versionId: "1" }),
      shard: shardFor(snapshot, "huge").id,
    });
    expect(fake.calls.filter((call) => call.rpc === "Read").map((call) => call.gets?.[0].includeValue)).toEqual([
      true,
      false,
    ]);
  });

  test("a receive-cap failure that counts every get answered is malformed, not read again", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a", "b"], { shards: 1 });
    for (const extra of [0, 1]) {
      let reads = 0;
      const claims: OxiaClient = {
        ...fake,
        read: async (shard, gets) => {
          reads++;
          if (reads > 10) throw new Error("The resume read the batch again without end");
          throw new OxiaError("receive-cap", { rpc: "Read", answered: gets.length + extra, shardId: shard.id });
        },
      };
      const gets = [
        { key: "a", includeValue: true },
        { key: "b", includeValue: true },
      ];
      // oxlint-disable-next-line no-await-in-loop -- each claim runs on its own counter, one after the other.
      expect(await failure(readKeys(claims, snapshot, gets, callOf()))).toMatchObject({
        category: "malformed",
        rpc: "Read",
      });
      expect(reads).toBe(1);
    }
  });

  test("a failure that is not the receive cap propagates", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a"]);
    const planted = new OxiaError("unavailable", { rpc: "Read" });
    fake.failNext({ rpc: "Read" }, planted);
    expect(await failure(readKeys(fake, snapshot, [{ key: "a", includeValue: true }], callOf()))).toBe(planted);
  });
});

describe("comparisonGet (SB1-7.6)", () => {
  const SIDES: readonly OxiaComparison[] = ["FLOOR", "CEILING", "LOWER", "HIGHER"];

  for (const order of ORDERS) {
    test(`without an index, every answer equals the model over the whole truth (${order})`, async () => {
      const { fake, snapshot } = await fakeOf(order, j4Keyset());
      const asked = j4Keyset().filter((_, i) => i % 30 === 0);
      const answers = await Promise.all(
        asked.flatMap((key) =>
          SIDES.map(async (comparison) => ({
            key,
            comparison,
            got: (await comparisonGet(fake, snapshot, order, { key, comparison, includeValue: false }, callOf()))?.key,
          })),
        ),
      );
      for (const { key, comparison, got } of answers) {
        expect({ key, comparison, got }).toEqual({
          key,
          comparison,
          got: modelGet(j4Keyset(), key, comparison, order),
        });
      }
    }, 60_000);

    test(`with an index over 3 shards it answers as one shard holding every entry (${order})`, async () => {
      const records = Array.from({ length: 40 }, (_, i) => ({
        key: `p${i}`,
        value: Uint8Array.of(i),
        secondaryIndexes: { i: `s${String(i % 20).padStart(2, "0")}` },
      }));
      const three = await fakeOf(order, records);
      const one = await fakeOf(order, records, { shards: 1 });
      const keys = [...Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(2, "0")}`), "s", "s05x", "t"];
      for (const comparison of ["EQUAL", ...SIDES] as const) {
        const asks = keys.map((key) => ({ key, comparison, index: "i", includeValue: true }));
        // oxlint-disable-next-line no-await-in-loop -- one comparison after the other, so a failure names it.
        const [spread, single] = await Promise.all([
          Promise.all(asks.map((ask) => comparisonGet(three.fake, three.snapshot, order, ask, callOf()))),
          Promise.all(asks.map((ask) => comparisonGet(one.fake, one.snapshot, order, ask, callOf()))),
        ]);
        expect(spread.map((answer) => [answer?.key, answer?.secondaryIndexKey])).toEqual(
          single.map((answer) => [answer?.key, answer?.secondaryIndexKey]),
        );
        const found = spread.filter((answer) => answer !== undefined);
        expect(found.length).toBeGreaterThan(0);
        // oxlint-disable-next-line no-await-in-loop -- one comparison after the other, so a failure names it.
        const own = await readKeys(
          three.fake,
          three.snapshot,
          found.map((answer) => ({ key: answer.key, includeValue: true })),
          callOf(),
        );
        found.forEach((answer, i) => {
          expect(answer.value).toEqual(own[i]?.value as Uint8Array);
          expect(answer.version).toEqual(own[i]?.version as never);
          expect(answer.secondaryIndexKey).toBeDefined();
        });
      }
    });
  }

  test("the fan-out asks no value, and exactly one value-bearing Read follows on the winner's shard (B-1)", async () => {
    const value = new Uint8Array(15 * MIB);
    const records = Array.from({ length: 1_024 }, (_, i) => ({ key: `r${String(i).padStart(4, "0")}`, value }));
    const { fake, snapshot } = await fakeOf("natural", records, { shards: 1_024 });
    const answer = await comparisonGet(
      fake,
      snapshot,
      "natural",
      { key: "r0500x", comparison: "CEILING", includeValue: true },
      callOf(),
    );
    expect(answer?.key).toBe("r0501");
    expect(answer?.value).toBe(value);
    const reads = fake.calls.filter((call) => call.rpc === "Read");
    expect(reads).toHaveLength(1_025);
    expect(reads.slice(0, 1_024).every((call) => call.gets?.[0].includeValue === false)).toBe(true);
    expect(reads[1_024].gets).toEqual([{ key: "r0501", comparison: "EQUAL", includeValue: true }]);
    expect(reads[1_024].shard).toBe(shardFor(snapshot, "r0501").id);
    expect(answer?.shard).toBe(shardFor(snapshot, "r0501").id);
  });

  test("the winner deleted between the reads is record-changed", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a", "b", "c"]);
    fake.onCall((call) => {
      if (call.gets?.[0].comparison === "EQUAL") fake.remove("b");
    });
    const error = await failure(
      comparisonGet(fake, snapshot, "natural", { key: "a", comparison: "HIGHER", includeValue: true }, callOf()),
    );
    expect(error).toMatchObject({ category: "record-changed", rpc: "Read", shardId: shardFor(snapshot, "b").id });
    const worded = toProviderError(error, { operation: "get", connection: ERROR_CONNECTION });
    expect(worded.message).toBe(recordChangedSentence("get"));
  });

  test("a winner over the receive cap is answered withheld; a miss everywhere is undefined", async () => {
    const { fake, snapshot } = await fakeOf("natural", [{ key: "b", value: new Uint8Array(17 * MIB) }, "a"]);
    const answer = await comparisonGet(
      fake,
      snapshot,
      "natural",
      { key: "a", comparison: "HIGHER", includeValue: true },
      callOf(),
    );
    expect(answer).toEqual({
      key: "b",
      withheld: true,
      version: expect.objectContaining({ versionId: "1" }),
      shard: shardFor(snapshot, "b").id,
    });
    expect(
      await comparisonGet(fake, snapshot, "natural", { key: "b", comparison: "HIGHER", includeValue: true }, callOf()),
    ).toBeUndefined();
  });

  test("the empty key and an EQUAL get without an index are refused before any call (F8)", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a"]);
    const before = fake.calls.length;
    expect(
      await failure(
        comparisonGet(fake, snapshot, "natural", { key: "", comparison: "FLOOR", includeValue: false }, callOf()),
      ),
    ).toEqual(new RangeError("A comparison get of the empty key is refused before any call"));
    expect(
      await failure(
        comparisonGet(fake, snapshot, "natural", { key: "a", comparison: "EQUAL", includeValue: false }, callOf()),
      ),
    ).toEqual(new RangeError("An EQUAL get without an index is a point read: use readKeys"));
    expect(fake.calls.length).toBe(before);
  });

  test("a malformed fan-out answer is OxiaError malformed", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a", "b"]);
    const keyless: OxiaClient = {
      ...fake,
      read: async (shard, gets, call) =>
        (await fake.read(shard, gets, call)).map((record) => ({ status: record.status, version: record.version })),
    };
    expect(
      await failure(
        comparisonGet(keyless, snapshot, "natural", { key: "a", comparison: "CEILING", includeValue: false }, callOf()),
      ),
    ).toMatchObject({ category: "malformed", rpc: "Read" });
  });

  test("with a partition key one shard is asked", async () => {
    const tenant = ["t1", "t2", "t3"].map((key) => ({ key, partitionKey: "tenant-a" }));
    const { fake, snapshot } = await fakeOf("natural", [...tenant, "a", "z"]);
    const answer = await comparisonGet(
      fake,
      snapshot,
      "natural",
      { key: "t1", comparison: "HIGHER", includeValue: false, partitionKey: "tenant-a" },
      callOf(),
    );
    expect(answer?.key).toBe("t2");
    const reads = fake.calls.filter((call) => call.rpc === "Read");
    expect(reads).toHaveLength(2);
    expect(new Set(reads.map((call) => call.shard))).toEqual(new Set([shardFor(snapshot, "", "tenant-a").id]));
  });
});

/** The truth's keys in [start, end) under the order ("" unbounded at either end). */
function inRange(truth: readonly string[], order: KeyOrder, start: string, end: string): string[] {
  const cmp = keyComparator(order);
  return truth.filter((key) => (start === "" || cmp(key, start) >= 0) && (end === "" || cmp(key, end) < 0));
}

const ALL = { startInclusive: "", endExclusive: "" };

describe("the console walks (consistency rulings 7, 8; SB1-9.3a)", () => {
  for (const order of ORDERS) {
    test(`listRange answers the truth's keys in the range (${order})`, async () => {
      const { fake, snapshot } = await fakeOf(order, j4Keyset());
      const truth = inRange(sortedKeys(j4Keyset(), order), order, "a", "z");
      const range = { startInclusive: "a", endExclusive: "z" };
      // Under hierarchical sorting [a, z) is level 0 alone, 257 keys of the J4 keyset, so the limit is 200 for both.
      expect(truth.length).toBeGreaterThan(200);
      expect(await listRange(fake, snapshot, order, { range, limit: 200 }, callOf())).toEqual({
        keys: truth.slice(0, 200),
        more: true,
        shardsRead: 3,
      });
      expect(await listRange(fake, snapshot, order, { range, limit: 5_000 }, callOf())).toEqual({
        keys: truth,
        more: false,
        shardsRead: 3,
      });
    });

    test(`prefixScanPage answers the truth's records under the prefix, with values (${order})`, async () => {
      const keys = pulsarKeyset(2_000);
      const records = keys.map((key) => ({ key, value: new TextEncoder().encode(key) }));
      const { fake, snapshot } = await fakeOf(order, records);
      const truth = sortedKeys(keys, order).filter((key) => key.startsWith("/bulk/"));
      const answer = await prefixScanPage(fake, snapshot, order, { prefix: "/bulk/", limit: 100 }, callOf());
      expect(answer.records.map((record) => record.key)).toEqual(truth.slice(0, 100));
      expect(answer.records.map((record) => new TextDecoder().decode(record.value))).toEqual(truth.slice(0, 100));
      expect(answer.more).toBe(true);
      expect(answer.stoppedBy).toBeUndefined();
      const all = await prefixScanPage(fake, snapshot, order, { prefix: "/bulk/", limit: 5_000 }, callOf());
      expect(all.records.map((record) => record.key)).toEqual(truth);
      expect(all.more).toBe(false);
      // "svc//" is the extra key of the prefix "svc/" under hierarchical sorting, read with its value.
      const extra = await prefixScanPage(fake, snapshot, order, { prefix: "svc/", limit: 10 }, callOf());
      expect(extra.records.map((record) => [record.key, new TextDecoder().decode(record.value)])).toEqual([
        ["svc//", "svc//"],
      ]);

      const value = new Uint8Array(MIB);
      const heavy = await fakeOf(
        order,
        keys.slice(0, 200).map((key) => ({ key: `/heavy/${key}`, value })),
      );
      const stopped = await prefixScanPage(
        heavy.fake,
        heavy.snapshot,
        order,
        { prefix: "/heavy/", limit: 100 },
        callOf(),
      );
      expect(stopped.records).toHaveLength(8);
      expect(stopped.stoppedBy).toBe("bytes");
      expect(stopped.more).toBe(true);
    });

    test(`prefixListPage answers the truth's keys, and stops at the run budget (${order}; ruling R5)`, async () => {
      const keys = pulsarKeyset(2_000);
      const { fake, snapshot } = await fakeOf(order, keys);
      const truth = sortedKeys(keys, order).filter((key) => key.startsWith("/bulk/"));
      expect(await prefixListPage(fake, snapshot, order, { prefix: "/bulk/", limit: 100 }, callOf())).toEqual({
        keys: truth.slice(0, 100),
        more: true,
        shardsRead: 3,
      });
      const wide = Array.from({ length: 200 }, (_, i) => `p/${String(i).padStart(3, "0")}${"x".repeat(65_536 - 5)}`);
      const heavy = await fakeOf(order, wide);
      const stopped = await prefixListPage(heavy.fake, heavy.snapshot, order, { prefix: "p/", limit: 500 }, callOf());
      expect(stopped.keys).toEqual(sortedKeys(wide, order).slice(0, 128));
      expect(stopped.stoppedBy).toBe("bytes");
      expect(stopped.more).toBe(true);
      const big = `k${"x".repeat(4.5 * MIB)}`;
      const stall = await fakeOf(order, ["a", "b", big], { shards: 1 });
      expect(await prefixListPage(stall.fake, stall.snapshot, order, { prefix: "k", limit: 10 }, callOf())).toEqual({
        keys: [big],
        more: false,
        shardsRead: 1,
      });
      const error = await failure(
        prefixWalkPage(stall.fake, stall.snapshot, order, { prefix: "k", cursor: big, count: 10 }, callOf()),
      );
      expect((error as QueryError).message).toBe(OXIA_STALLED_PAGE_SENTENCE);
    }, 30_000);
  }

  test("prefixScanPage reads a band's extra value only when that band is read (B-1)", async () => {
    // Twenty bands, each with one extra key of 15 MiB (one shared buffer): the first one read fills the run budget.
    const value = new Uint8Array(15 * MIB);
    const records = Array.from({ length: 20 }, (_, m) => ({ key: `/p${"/".repeat(m + 2)}`, value }));
    const { fake, snapshot } = await fakeOf("hierarchical", records, { shards: 1 });
    const answer = await prefixScanPage(fake, snapshot, "hierarchical", { prefix: "/p", limit: 5 }, callOf());
    expect(answer.records.map((record) => [record.key, record.value?.length])).toEqual([["/p//", 15 * MIB]]);
    expect(answer.stoppedBy).toBe("bytes");
    expect(answer.more).toBe(true);
    expect(fake.receivedBytes).toBeLessThanOrEqual(OXIA_RUN_BYTE_BUDGET + OXIA_RECEIVE_CAP_BYTES);
  });

  test("listRange stops when the kept key bytes reach 8 MiB", async () => {
    const keys = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(65_536 - 3)}`);
    const { fake, snapshot } = await fakeOf("natural", keys);
    const answer = await listRange(fake, snapshot, "natural", { range: ALL, limit: 500 }, callOf());
    expect(answer).toEqual({
      keys: sortedKeys(keys, "natural").slice(0, OXIA_RUN_BYTE_BUDGET / 65_536),
      more: true,
      stoppedBy: "bytes",
      shardsRead: 3,
    });
  });

  test("rangeScanPage on 64 shards keeps at most 8 MiB of keys and values plus one key per shard (ruling R23)", async () => {
    // The review's probe (F5): 64 shards, 12 records of 1 MiB on each (one shared buffer), limit 100.
    const value = new Uint8Array(MIB);
    const { snapshot: map } = await fakeOf("natural", [], { shards: 64 });
    const placed = new Map<string, number>();
    const keys: string[] = [];
    for (let i = 0; keys.length < 64 * 12; i++) {
      const key = `r${String(i).padStart(5, "0")}`;
      const id = shardFor(map, key).id;
      if ((placed.get(id) ?? 0) === 12) continue;
      placed.set(id, (placed.get(id) ?? 0) + 1);
      keys.push(key);
    }
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value })),
      { shards: 64 },
    );
    const answer = await rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    expect(answer.records.map((record) => record.key)).toEqual(keys.slice(0, 8));
    expect(answer.records.every((record) => record.value?.length === MIB)).toBe(true);
    expect(answer.stoppedBy).toBe("bytes");
    expect(answer.more).toBe(true);
    // The fake counts what every call delivered: 8 MiB of values, every key once (its List framing, and for a record
    // read its Read answer's key and version fields), plus one key per shard.
    const perKey = listCost(keys[0]) + Buffer.byteLength(keys[0]) + 32;
    expect(fake.receivedBytes).toBeLessThanOrEqual(OXIA_RUN_BYTE_BUDGET + (keys.length + 64) * perKey);
  });

  test("listRange on 64 shards keeps at most 8 MiB of keys plus one key per shard in every round (rulings R23, R25)", async () => {
    // 640 keys of 64 KiB (40 MiB), one key per message. A round's shards read from its cursor; a shard that is not
    // read keeps the keys of its last read that the merge has not reached. So at each round's merge the walk holds the
    // keys it answered (those up to the cursor) and, of every shard's last read, the keys past the cursor it kept: all
    // of them when the server ended the stream, all but the last otherwise, the last being the one past its share.
    const keys = Array.from({ length: 640 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(65_536 - 3)}`);
    const { fake, snapshot } = await fakeOf("natural", keys, { shards: 64, chunkBytes: 1 });
    const truth = sortedKeys(keys, "natural");
    const lastRead = new Map<string, { readonly keys: string[]; ended: boolean }>();
    const cursors: string[] = [];
    const held: number[] = [];
    const holding = (cursor: string) => {
      const answered = truth.filter((key) => cursor !== "" && key <= cursor).length;
      const kept = [...lastRead.values()].flatMap((read) => (read.ended ? read.keys : read.keys.slice(0, -1)));
      return (answered + kept.filter((key) => key > cursor).length) * 65_536;
    };
    const client: OxiaClient = {
      ...fake,
      list(shard, range, call) {
        if (cursors.at(-1) !== range.startInclusive) {
          if (cursors.length > 0) held.push(holding(cursors.at(-1) as string));
          cursors.push(range.startInclusive);
        }
        const read = { keys: [] as string[], ended: false };
        lastRead.set(shard.id, read);
        const inner = fake.list(shard, range, call);
        return {
          async next() {
            const message = await inner.next();
            if (message === undefined) read.ended = !inner.truncated;
            else read.keys.push(...message);
            return message;
          },
          get receivedBytes() {
            return inner.receivedBytes;
          },
          get truncated() {
            return inner.truncated;
          },
          cancel: () => inner.cancel(),
        };
      },
    };
    const answer = await listRange(client, snapshot, "natural", { range: ALL, limit: 5_000 }, callOf());
    held.push(holding(cursors.at(-1) as string));
    expect(answer).toEqual({
      keys: truth.slice(0, OXIA_RUN_BYTE_BUDGET / 65_536),
      more: true,
      stoppedBy: "bytes",
      shardsRead: 64,
    });
    expect(held.length).toBeGreaterThan(1);
    expect(Math.max(...held)).toBeLessThanOrEqual(OXIA_RUN_BYTE_BUDGET + 64 * 65_536);
  }, 60_000);

  test("a shard the merge answers in part keeps only the rest of its keys for the next round (ruling R25)", async () => {
    // Two shards: one of small keys, one of 3 MiB keys that sort between them. Each round reads one large key, whose
    // shard the merge then reaches, while the small keys' shard stands and is answered up to that key, in part.
    const { snapshot: map } = await fakeOf("natural", [], { shards: 2 });
    const small = Array.from({ length: 400 }, (_, i) => `k${String(i).padStart(3, "0")}`)
      .filter((key) => shardFor(map, key).id === "1")
      .slice(0, 150);
    const large = [50, 70, 90, 110].map(
      (at) =>
        [..."abcdefghij"]
          .map((fill) => `${small[at]}${fill.repeat(3 * MIB)}`)
          .find((key) => shardFor(map, key).id === "0") as string,
    );
    const { fake, snapshot } = await fakeOf("natural", [...small, ...large], { shards: 2 });
    const answer = await listRange(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    const truth = sortedKeys([...small, ...large], "natural");
    expect(answer).toEqual({
      keys: truth.slice(0, truth.indexOf(large[2]) + 1),
      more: true,
      stoppedBy: "bytes",
      shardsRead: 2,
    });
    // The large keys' shard is read once a round; the small keys' shard once, its frontier standing after.
    const lists = fake.calls.filter((call) => call.rpc === "List").map((call) => call.shard);
    expect(lists).toEqual(["0", "1", "0", "0"]);
  });

  test("a round reads only the shards whose frontier the last merge reached (ruling R25)", async () => {
    // The re-review's observation: 1,024 shards, keys of 9 KiB, limit 500. Each shard's share of the first round holds
    // one key, and the merge answers one key a round; re-reading every shard made 1,024 List calls a round.
    const keys = Array.from({ length: 2_048 }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(9 * 1024 - 4)}`);
    const { fake, snapshot } = await fakeOf("natural", keys, { shards: 1_024 });
    const answer = await listRange(fake, snapshot, "natural", { range: ALL, limit: 500 }, callOf(60_000));
    expect(answer).toEqual({ keys: sortedKeys(keys, "natural").slice(0, 500), more: true, shardsRead: 1_024 });
    expect(fake.calls.filter((call) => call.rpc === "List").length).toBeLessThanOrEqual(1_024 + 500);
  }, 60_000);

  test("rangeScanPage leaves out a key deleted between its keys and its values (ruling R23)", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value: Uint8Array.of(1) })),
    );
    fake.onCall((call) => {
      if (call.rpc === "Read") fake.remove("k3");
    });
    const answer = await rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    expect(answer.records.map((record) => record.key)).toEqual(keys.filter((key) => key !== "k3"));
    expect(answer.more).toBe(false);
    expect(answer.stoppedBy).toBeUndefined();
  });

  test("rangeScanPage reads values one group at a time: a shard's consecutive keys, at most 1,000 per Read (ruling R23)", async () => {
    const keys = Array.from({ length: 2_500 }, (_, i) => `k${String(i).padStart(4, "0")}`);
    const { fake, snapshot } = await fakeOf("natural", keys, { shards: 1 });
    const answer = await rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 2_400 }, callOf());
    expect(answer.records.map((record) => record.key)).toEqual(keys.slice(0, 2_400));
    expect(answer.more).toBe(true);
    const reads = fake.calls.filter((call) => call.rpc === "Read").map((call) => call.gets?.length);
    expect(reads).toEqual([1_000, 1_000, 400]);
    expect(fake.peakInFlight).toBe(1);
  });

  test("a group's Read cut by its limit reads the gets that arrived, then the budget is checked before any more (ruling R23)", async () => {
    // One shard of 40 records of 1 MiB: the first Read of the group passes the 8 MiB Read limit after 8 answers. The
    // C13 resume of readKeys would read the 32 others one by one and hold all 40 MiB to answer 8 records.
    const value = new Uint8Array(MIB);
    const keys = Array.from({ length: 40 }, (_, i) => `r${String(i).padStart(2, "0")}`);
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value, partitionKey: "p" })),
      { shards: 64 },
    );
    let answered = 0;
    const client: OxiaClient = {
      ...fake,
      async read(shard, gets, call) {
        const answers = await fake.read(shard, gets, call);
        answered += answers.reduce((sum, answer) => sum + (answer.value?.length ?? 0), 0);
        return answers;
      },
    };
    const ask = { range: ALL, partitionKey: "p", limit: 100 };
    const answer = await rangeScanPage(client, snapshot, "natural", ask, callOf());
    expect(answer.records.map((record) => record.key)).toEqual(keys.slice(0, 8));
    expect(answer.stoppedBy).toBe("bytes");
    expect(answer.more).toBe(true);
    expect(fake.calls.filter((call) => call.rpc === "Read").map((call) => call.gets?.length)).toEqual([40, 8]);
    expect(answered).toBeLessThanOrEqual(OXIA_RUN_BYTE_BUDGET);
  });

  test("each value Read is limited to what the run budget has left, so a run holds at most 8 MiB plus one record (ruling R24)", async () => {
    // The re-review's probe (G2): a 7 MiB record on shard 0, then twenty records of 1 MiB on shard 1, limit 100.
    const { snapshot: map } = await fakeOf("natural", []);
    const first = Array.from({ length: 50 }, (_, i) => `a${i}`).find((key) => shardFor(map, key).id === "0") as string;
    const rest = sortedKeys(
      Array.from({ length: 200 }, (_, i) => `b${String(i).padStart(3, "0")}`).filter(
        (key) => shardFor(map, key).id === "1",
      ),
      "natural",
    ).slice(0, 20);
    const one = new Uint8Array(MIB);
    const { fake, snapshot } = await fakeOf("natural", [
      { key: first, value: new Uint8Array(7 * MIB) },
      ...rest.map((key) => ({ key, value: one })),
    ]);
    const reads: { readonly key: string; readonly received: number }[] = [];
    const client: OxiaClient = {
      ...fake,
      async read(shard, gets, call) {
        const before = fake.receivedBytes;
        try {
          return await fake.read(shard, gets, call);
        } finally {
          reads.push({ key: gets[0].key, received: fake.receivedBytes - before });
        }
      },
    };
    const answer = await rangeScanPage(client, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    expect(answer.records.map((record) => record.key)).toEqual([first, rest[0]]);
    expect(answer.stoppedBy).toBe("bytes");
    expect(answer.more).toBe(true);
    // What the run holds at each Read: the values it kept below that Read's first key, plus what the Read received.
    const cmp = keyComparator("natural");
    const held = reads.map(
      (read) =>
        answer.records
          .filter((record) => cmp(record.key, read.key) < 0)
          .reduce((sum, record) => sum + (record.value?.length ?? 0), 0) + read.received,
    );
    expect(Math.max(...held)).toBeLessThanOrEqual(OXIA_RUN_BYTE_BUDGET + MIB + Buffer.byteLength(rest[0]) + 32);
    const keyBytes = [first, ...rest].reduce((sum, key) => sum + Buffer.byteLength(key), 0);
    const limits = fake.calls
      .filter((call) => call.rpc === "Read")
      .map((call) => [call.gets?.length, call.maxReceivedBytes]);
    expect(limits).toEqual([
      [1, OXIA_RUN_BYTE_BUDGET - keyBytes],
      [20, OXIA_RUN_BYTE_BUDGET - keyBytes - 7 * MIB],
      [1, OXIA_RUN_BYTE_BUDGET - keyBytes - 7 * MIB],
    ]);
  });

  test("a run whose keys reach the budget reads its last record under a one-byte limit, never a smaller one (ruling R24)", async () => {
    const keys = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(100 * 1024 - 3)}`);
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value: Uint8Array.of(1) })),
    );
    const ask = { range: ALL, limit: 100 };
    const answer = await rangeScanPage(fake, snapshot, "natural", ask, callOf());
    const listed = await listRange(fake, snapshot, "natural", ask, callOf());
    expect(listed.stoppedBy).toBe("bytes");
    // Once the keys reach the budget, the record that reaches it with them ends the answer: the records are the keys
    // of the rounds before, plus that one.
    const records = answer.records.map((record) => record.key);
    expect(records.length).toBeGreaterThan(0);
    expect(records).toEqual(listed.keys.slice(0, records.length));
    expect(answer.stoppedBy).toBe("bytes");
    const limits = fake.calls.filter((call) => call.rpc === "Read").map((call) => call.maxReceivedBytes as number);
    expect(limits.at(-1)).toBe(1);
    expect(limits.every((limit) => Number.isInteger(limit) && limit >= 1)).toBe(true);
  });

  test("a group's Read cut before its first answer reads that get alone, withheld when it passes the cap (ruling R23)", async () => {
    const keys = ["a", "b", "c"];
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value: key === "b" ? new Uint8Array(17 * MIB) : Uint8Array.of(1) })),
      { shards: 1 },
    );
    const answer = await rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    expect(answer.records.map((record) => record.key)).toEqual(["a"]);
    expect(answer.stoppedBy).toBe("receive-cap");
    expect(answer.more).toBe(true);
    const reads = fake.calls.filter((call) => call.rpc === "Read").map((call) => call.gets?.map((get) => get.key));
    expect(reads).toEqual([["a", "b", "c"], ["a"], ["b", "c"], ["b"], ["b"]]);
  });

  test("a server that fails a group's Read again shrinks the group to what arrived, never past it (ruling R23)", async () => {
    const keys = Array.from({ length: 6 }, (_, i) => `k${i}`);
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value: Uint8Array.of(1) })),
      { shards: 1 },
    );
    const cut = (answered: number) => new OxiaError("receive-cap", { rpc: "Read", shardId: "0", answered });
    fake.failNext({ rpc: "Read" }, cut(4));
    fake.failNext({ rpc: "Read" }, cut(2));
    const answer = await rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    expect(answer.records.map((record) => record.key)).toEqual(keys);
    const reads = fake.calls.filter((call) => call.rpc === "Read").map((call) => call.gets?.length);
    expect(reads).toEqual([6, 4, 2, 4]);
    fake.failNext({ rpc: "Read" }, cut(6));
    const error = await failure(rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf()));
    expect(error).toBeInstanceOf(OxiaError);
    expect((error as OxiaError).category).toBe("malformed");
  });

  test("rangeScanPage stops at the run budget, and keeps one record between 8 and 16 MiB as the only row", async () => {
    const value = new Uint8Array(MIB);
    const keys = Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(2, "0")}`);
    const { fake, snapshot } = await fakeOf(
      "natural",
      keys.map((key) => ({ key, value })),
    );
    const answer = await rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    expect(answer.records.map((record) => record.key)).toEqual(keys.slice(0, 8));
    expect(answer.stoppedBy).toBe("bytes");
    expect(answer.more).toBe(true);
    expect(answer.records[0]).toEqual({
      key: "r00",
      value,
      version: expect.objectContaining({ versionId: expect.any(String) }),
      shard: shardFor(snapshot, "r00").id,
    });
    const large = await fakeOf("natural", [{ key: "a", value: new Uint8Array(12 * MIB) }, "b", "c", "d", "e"]);
    const single = await rangeScanPage(large.fake, large.snapshot, "natural", { range: ALL, limit: 100 }, callOf());
    expect(single.records.map((record) => record.key)).toEqual(["a"]);
    expect(single.stoppedBy).toBe("bytes");
    expect(single.more).toBe(true);
  });

  test("rangeScanPage over a value past the receive cap ends before it, unless the budget ends it first (ruling R23)", async () => {
    // The values are read in key order after the keys, so the answer is every record below the large one, cut by the
    // budget when that comes first, and the large one is never answered.
    const keys = Array.from({ length: 60 }, (_, i) => `k${String(i).padStart(2, "0")}`);
    const probe = await fakeOf("natural", keys);
    const onOne = keys.filter((key) => shardFor(probe.snapshot, key).id === "1");
    const cmp = keyComparator("natural");
    for (const [position, value] of [
      [2, new Uint8Array(0)],
      [4, new Uint8Array(MIB)],
    ] as const) {
      const big = onOne[position];
      const records = keys.map((key) => ({ key, value: key === big ? new Uint8Array(17 * MIB) : value }));
      // oxlint-disable-next-line no-await-in-loop -- two namespaces, one after the other.
      const { fake, snapshot } = await fakeOf("natural", records);
      // oxlint-disable-next-line no-await-in-loop -- two namespaces, one after the other.
      const answer = await rangeScanPage(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf());
      const below = keys.filter((key) => cmp(key, big) < 0);
      if (value.length === 0) {
        expect(answer.records.map((record) => record.key)).toEqual(below);
        expect(answer.stoppedBy).toBe("receive-cap");
      } else {
        expect(below.length).toBeGreaterThan(8);
        expect(answer.records.map((record) => record.key)).toEqual(below.slice(0, 8));
        expect(answer.stoppedBy).toBe("bytes");
      }
      expect(answer.more).toBe(true);
    }
  });

  test("a partition key reads one shard", async () => {
    const tenant = ["t1", "t2", "t3"].map((key) => ({ key, partitionKey: "tenant-a", value: Uint8Array.of(7) }));
    const { fake, snapshot } = await fakeOf("natural", [...tenant, ...FLAT]);
    const home = shardFor(snapshot, "", "tenant-a");
    const own = FLAT.filter((key) => shardFor(snapshot, key).id === home.id);
    const truth = sortedKeys([...own, "t1", "t2", "t3"], "natural");
    const ask = { range: ALL, limit: 100, partitionKey: "tenant-a" };
    const before = fake.calls.length;
    const scanned = await rangeScanPage(fake, snapshot, "natural", ask, callOf());
    expect(scanned.records.map((record) => record.key)).toEqual([...truth]);
    expect(scanned.shardsRead).toBe(1);
    expect(await listRange(fake, snapshot, "natural", ask, callOf())).toEqual({
      keys: truth,
      more: false,
      shardsRead: 1,
    });
    expect(fake.calls.slice(before).every((call) => call.shard === home.id)).toBe(true);
  });

  test("with an index the shards are concatenated in id order, not merged", async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, secondaryIndexes: { i: `s${29 - i}` } }));
    const { fake, snapshot } = await fakeOf("natural", records);
    const entry = (record: (typeof records)[number]) => `${record.secondaryIndexes.i}\u0001${goPathEscape(record.key)}`;
    const expected = ["0", "1", "2"].flatMap((id) =>
      records
        .filter((record) => shardFor(snapshot, record.key).id === id)
        .sort((a, b) => keyComparator("natural")(entry(a), entry(b)))
        .map((record) => record.key),
    );
    const listed = await listRange(fake, snapshot, "natural", { range: ALL, index: "i", limit: 500 }, callOf());
    expect(listed).toEqual({ keys: expected, more: false, indexConcatenated: true, shardsRead: 3 });
    const scanned = await rangeScanPage(fake, snapshot, "natural", { range: ALL, index: "i", limit: 500 }, callOf());
    expect(scanned.records.map((record) => record.key)).toEqual(expected);
    expect(scanned.indexConcatenated).toBe(true);
    expect(scanned.shardsRead).toBe(3);
    const ranges = fake.calls.filter((call) => call.rpc === "List" || call.rpc === "RangeScan");
    expect(ranges.every((call) => call.range?.secondaryIndexName === "i")).toBe(true);
    const short = await listRange(fake, snapshot, "natural", { range: ALL, index: "i", limit: 5 }, callOf());
    expect(short).toEqual({ keys: expected.slice(0, 5), more: true, shardsRead: 1 });
    const firstShard = expected.filter((key) => shardFor(snapshot, key).id === "0").length;
    const exact = await listRange(fake, snapshot, "natural", { range: ALL, index: "i", limit: firstShard }, callOf());
    expect(exact).toEqual({ keys: expected.slice(0, firstShard), more: true, shardsRead: 1 });
  });

  test("an index walk whose last shard holds one entry more than the limit answers more", async () => {
    const records = ["p0", "p1", "p2"].map((key, i) => ({ key, secondaryIndexes: { i: `s${i}` } }));
    const { fake, snapshot } = await fakeOf("natural", records, { shards: 1 });
    const ask = { range: ALL, index: "i", limit: 2 };
    expect(await listRange(fake, snapshot, "natural", ask, callOf())).toEqual({
      keys: ["p0", "p1"],
      more: true,
      shardsRead: 1,
    });
    const scanned = await rangeScanPage(fake, snapshot, "natural", ask, callOf());
    expect(scanned.records.map((record) => record.key)).toEqual(["p0", "p1"]);
    expect(scanned.more).toBe(true);
    expect(await listRange(fake, snapshot, "natural", { ...ask, limit: 3 }, callOf())).toEqual({
      keys: ["p0", "p1", "p2"],
      more: false,
      shardsRead: 1,
    });
  });

  test("an index walk stops at the run budget and at a receive cap", async () => {
    const heavy = new Uint8Array(3 * MIB);
    const records = Array.from({ length: 12 }, (_, i) => ({
      key: `p${i}`,
      value: heavy,
      secondaryIndexes: { i: `s${i}` },
    }));
    const { fake, snapshot } = await fakeOf("natural", records);
    const scanned = await rangeScanPage(fake, snapshot, "natural", { range: ALL, index: "i", limit: 500 }, callOf());
    expect(scanned.records).toHaveLength(3);
    expect(scanned.stoppedBy).toBe("bytes");
    expect(scanned.more).toBe(true);
    const capped = await fakeOf("natural", [
      { key: "huge", value: new Uint8Array(17 * MIB), secondaryIndexes: { i: "x" } },
      ...FLAT.map((key) => ({ key, secondaryIndexes: { i: key } })),
    ]);
    const onCap = await rangeScanPage(
      capped.fake,
      capped.snapshot,
      "natural",
      { range: ALL, index: "i", limit: 500 },
      callOf(),
    );
    expect(onCap.stoppedBy).toBe("receive-cap");
    expect(onCap.more).toBe(true);
  });

  test("a merge stall answers no records and never throws", async () => {
    // Shard 1's List is cut before its first key, so nothing can be answered under the merge bound.
    const { fake, snapshot } = await fakeOf("natural", j4Keyset());
    const cut: OxiaStream<string> = {
      next: () => Promise.resolve(undefined),
      receivedBytes: 0,
      truncated: true,
      cancel: () => undefined,
    };
    const client: OxiaClient = {
      ...fake,
      list: (shard, range, options) => (shard.id === "1" ? cut : fake.list(shard, range, options)),
    };
    expect(await rangeScanPage(client, snapshot, "natural", { range: ALL, limit: 100 }, callOf())).toEqual({
      records: [],
      more: true,
      stoppedBy: "bytes",
      shardsRead: 3,
    });
  });

  test("a List receive cap is not a stop: it propagates", async () => {
    const { fake, snapshot } = await fakeOf("natural", j4Keyset());
    const planted = new OxiaError("receive-cap", { rpc: "List", shardId: "1" });
    fake.failNext({ rpc: "List", shard: "1" }, planted, 0);
    expect(await failure(listRange(fake, snapshot, "natural", { range: ALL, limit: 100 }, callOf()))).toBe(planted);
  });
});

describe("discoverTopNodes (SB1-8)", () => {
  /** The distinct top-level nodes of the keys. */
  const nodesOf = (keys: readonly string[]) =>
    new Set(keys.map((key) => topNode(key)).filter((node) => node !== undefined));

  for (const [order, rounds, calls] of [
    ["hierarchical", 35, 53],
    ["natural", 27, 40],
  ] as const) {
    test(`the Pulsar-shaped set: every node, ${rounds} rounds and ${calls} calls (${order})`, async () => {
      const keys = pulsarKeyset(15_000);
      const { fake, snapshot } = await fakeOf(order, keys);
      const result = await discoverTopNodes(fake, snapshot, order, callOf());
      expect(new Set(result.representatives.map((key) => topNode(key)))).toEqual(nodesOf(keys));
      expect(nodesOf(keys).size).toBe(13);
      expect(result.representatives).toHaveLength(13);
      expect(result.complete).toBe(true);
      expect(Math.abs(result.rounds - rounds)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.calls - calls)).toBeLessThanOrEqual(3);
    });
  }

  for (const [order, representatives, calls] of [
    ["hierarchical", 255, 285],
    ["natural", 98, 273],
  ] as const) {
    test(`the J4 keyset is capped at 256 rounds (${order})`, async () => {
      const { fake, snapshot } = await fakeOf(order, j4Keyset());
      const result = await discoverTopNodes(fake, snapshot, order, callOf());
      const truth = nodesOf(j4Keyset());
      const found = result.representatives.map((key) => topNode(key));
      expect(result.complete).toBe(false);
      expect(result.rounds).toBe(256);
      expect(result.representatives).toHaveLength(representatives);
      expect(result.calls).toBe(calls);
      expect(new Set(found).size).toBe(found.length);
      for (const node of found) expect(truth.has(node as string)).toBe(true);
    });
  }

  test("the call cap: 1,024 shards never pass 2,048 calls", async () => {
    for (const order of ORDERS) {
      // oxlint-disable-next-line no-await-in-loop -- one order after the other.
      const { fake, snapshot } = await fakeOf(order, [...pulsarKeyset(100), "\u0000a/b"], { shards: 1_024 });
      // oxlint-disable-next-line no-await-in-loop -- one order after the other.
      const result = await discoverTopNodes(fake, snapshot, order, callOf());
      expect(result.calls).toBeLessThanOrEqual(OXIA_DISCOVERY_MAX_CALLS);
      expect(fake.calls.filter((call) => call.rpc === "Read")).toHaveLength(result.calls);
      if (order === "hierarchical") expect(result.complete).toBe(false);
    }
  }, 30_000);

  test("the deadline cap ends discovery within its 3 s", async () => {
    const { fake, snapshot } = await fakeOf("hierarchical", j4Keyset());
    fake.onCall(() => Bun.sleep(20));
    const started = Date.now();
    const result = await discoverTopNodes(fake, snapshot, "hierarchical", callOf());
    expect(result.complete).toBe(false);
    expect(Date.now() - started).toBeLessThanOrEqual(OXIA_DISCOVERY_DEADLINE_MS + 500);
  }, 30_000);

  test("a deadline-exceeded call ends discovery capped; any other failure propagates", async () => {
    const { fake, snapshot } = await fakeOf("hierarchical", pulsarKeyset(100));
    fake.onCall(() => Bun.sleep(80));
    const result = await discoverTopNodes(fake, snapshot, "hierarchical", callOf(40));
    expect(result).toEqual({ representatives: [], complete: false, rounds: 1, calls: 3 });
    fake.onCall(() => undefined);
    const planted = new OxiaError("unavailable", { rpc: "Read" });
    fake.failNext({ rpc: "Read" }, planted);
    expect(await failure(discoverTopNodes(fake, snapshot, "hierarchical", callOf()))).toBe(planted);
  });

  test("the backward chain finds the nodes below \\u0000/", async () => {
    const keys = ["\u0000a/b", "\u0000b/c", "/x/y"];
    const { fake, snapshot } = await fakeOf("hierarchical", keys);
    const result = await discoverTopNodes(fake, snapshot, "hierarchical", callOf());
    expect(new Set(result.representatives.map((key) => topNode(key)))).toEqual(new Set(["\u0000a", "\u0000b", "/x"]));
    expect(result.complete).toBe(true);
  });
});

/** A client that counts its own calls in flight, over `inner`. */
function counted(inner: OxiaClient) {
  const state = { inFlight: 0, peak: 0 };
  const client: OxiaClient = {
    ...inner,
    async read(shard, gets, call) {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        return await inner.read(shard, gets, call);
      } finally {
        state.inFlight--;
      }
    },
  };
  return { client, state };
}

/** Keys that fall on `count` different shards of the snapshot, one each. */
function spread(snapshot: OxiaSnapshot, count: number, tag: string): string[] {
  const seen = new Map<string, string>();
  for (let i = 0; seen.size < count; i++) {
    const key = `${tag}-${i}`;
    const id = shardFor(snapshot, key).id;
    if (!seen.has(id)) seen.set(id, key);
  }
  return [...seen.values()];
}

describe("the limited client (SB1-9.1)", () => {
  test("a walk and a comparison get over 1,024 shards keep at most four calls in flight", async () => {
    const keys = Array.from({ length: 3_000 }, (_, i) => `k${i}`);
    const { fake, snapshot } = await fakeOf("natural", keys, { shards: 1_024 });
    const limited = limitedOxiaClient(fake, limiterFactory()());
    const page = await fullWalkPage(limited, snapshot, "natural", { count: 500 }, callOf());
    expect(page.keys).toEqual(sortedKeys(keys, "natural").slice(0, 500));
    const answer = await comparisonGet(
      limited,
      snapshot,
      "natural",
      { key: "k5", comparison: "CEILING", includeValue: true },
      callOf(),
    );
    expect(answer?.key).toBe("k5");
    expect(fake.peakInFlight).toBeLessThanOrEqual(4);
    expect((await limited.getSnapshot(callOf())).shards).toHaveLength(1_024);
    expect(await limited.health(callOf())).toBe("SERVING");
    limited.close();
    expect(fake.closed).toBe(true);
  }, 30_000);

  test("five providers keep at most 16 calls in flight, and each its own 4", async () => {
    const { fake, snapshot } = await fakeOf("natural", [], { shards: 1_024 });
    fake.onCall(() => Bun.sleep(5));
    const factory = limiterFactory();
    const providers = Array.from({ length: 5 }, () => counted(fake));
    await Promise.all(
      providers.map(({ client }, p) =>
        readKeys(
          limitedOxiaClient(client, factory()),
          snapshot,
          spread(snapshot, 40, `p${p}`).map((key) => ({ key, includeValue: false })),
          callOf(),
        ),
      ),
    );
    expect(fake.peakInFlight).toBeLessThanOrEqual(16);
    expect(fake.peakInFlight).toBeGreaterThan(4);
    for (const { state } of providers) expect(state.peak).toBeLessThanOrEqual(4);
  });

  test("a permit is released when a call fails and when a stream is cancelled, before or after it opened", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a", "b", "c"]);
    const limited = limitedOxiaClient(fake, limiterFactory()());
    const [shard] = snapshot.shards;
    const get = [{ key: "a", comparison: "EQUAL" as const, includeValue: false }];
    fake.failNext({ rpc: "Read" }, new OxiaError("unavailable", { rpc: "Read" }));
    expect(await failure(limited.read(shard, get, callOf()))).toMatchObject({ category: "unavailable" });
    const unopened = limited.list(shard, ALL, { ...callOf(), maxReceivedBytes: 1e9 });
    expect(unopened.receivedBytes).toBe(0);
    expect(unopened.truncated).toBe(false);
    unopened.cancel();
    expect(unopened.truncated).toBe(true);
    expect(await unopened.next()).toBeUndefined();
    const opened = limited.rangeScan(shard, ALL, { ...callOf(), maxReceivedBytes: 1e9 });
    expect(await opened.next()).toBeDefined();
    expect(opened.receivedBytes).toBeGreaterThan(0);
    opened.cancel();
    expect(opened.truncated).toBe(true);
    const ended = limited.list(shard, ALL, { ...callOf(), maxReceivedBytes: 1e9 });
    await drain(ended);
    fake.failNext({ rpc: "List" }, new OxiaError("unavailable", { rpc: "List" }), 0);
    const failing = limited.list(shard, ALL, { ...callOf(), maxReceivedBytes: 1e9 });
    expect(await failure(failing.next())).toMatchObject({ category: "unavailable" });
    expect(fake.calls.filter((call) => call.rpc === "List")).toHaveLength(2);

    const held = gate();
    fake.onCall(held.hold);
    const four = Array.from({ length: 4 }, () => limited.read(shard, get, callOf()));
    await until(() => held.state.held === 4);
    expect(held.state.held).toBe(4);
    // A stream cancelled while it waits for its permit opens nothing when the permit comes.
    const waiting = limited.list(shard, ALL, { ...callOf(), maxReceivedBytes: 1e9 });
    const pending = waiting.next();
    await Bun.sleep(5);
    waiting.cancel();
    held.open();
    await Promise.all(four);
    expect(await pending).toBeUndefined();
    expect(fake.calls.filter((call) => call.rpc === "List")).toHaveLength(2);
    const again = gate();
    fake.onCall(again.hold);
    const next = Array.from({ length: 4 }, () => limited.read(shard, get, callOf()));
    await until(() => again.state.held === 4);
    expect(again.state.held).toBe(4);
    again.open();
    await Promise.all(next);
  });

  test("a full queue refuses the 81st call before it is sent", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a"]);
    const held = gate();
    fake.onCall(held.hold);
    const factory = limiterFactory();
    const providers = Array.from({ length: 5 }, () => limitedOxiaClient(fake, factory()));
    const shard = shardFor(snapshot, "a");
    const get = [{ key: "a", comparison: "EQUAL" as const, includeValue: false }];
    const calls = Array.from({ length: 80 }, (_, i) => providers[i % 5].read(shard, get, callOf()));
    await until(() => held.state.held === 16);
    expect(held.state.held).toBe(16);
    const sent = fake.calls.length;
    expect(await failure(providers[0].read(shard, get, callOf()))).toBeInstanceOf(LimiterFullError);
    expect(fake.calls.length).toBe(sent);
    held.open();
    await Promise.all(calls);
    expect(fake.calls.length).toBe(sent + 64);
  });

  test("a permit wait ends at the call's deadline, and at its signal with the signal's reason (ruling R2)", async () => {
    const { fake, snapshot } = await fakeOf("natural", ["a"]);
    const limited = limitedOxiaClient(fake, limiterFactory()());
    const shard = shardFor(snapshot, "a");
    const get = [{ key: "a", comparison: "EQUAL" as const, includeValue: false }];
    const held = gate();
    fake.onCall(held.hold);
    const four = Array.from({ length: 4 }, () => limited.read(shard, get, callOf()));
    await until(() => held.state.held === 4);
    const sent = fake.calls.length;
    const started = Date.now();
    const timedOut = await failure(limited.read(shard, get, callOf(100)));
    const waited = Date.now() - started;
    expect(timedOut).toBeInstanceOf(DOMException);
    expect((timedOut as DOMException).name).toBe("TimeoutError");
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThanOrEqual(600);
    expect(fake.calls.length).toBe(sent);
    const controller = new AbortController();
    const reason = new Error("stopped by the user");
    const aborted = limited.read(shard, get, callOf(10_000, controller.signal));
    controller.abort(reason);
    expect(await failure(aborted)).toBe(reason);
    held.open();
    await Promise.all(four);
    const again = gate();
    fake.onCall(again.hold);
    const next = Array.from({ length: 4 }, () => limited.read(shard, get, callOf()));
    await until(() => again.state.held === 4);
    expect(again.state.held).toBe(4);
    again.open();
    await Promise.all(next);
  });
});

describe("cancellation and deadlines (SB1-9.4)", () => {
  test("an abort mid-walk rejects cancelled and leaves no stream open", async () => {
    const keys = Array.from({ length: 5_000 }, (_, i) => `k${i}`);
    const { fake, snapshot } = await fakeOf("natural", keys, { shards: 1_024 });
    const controller = new AbortController();
    let seen = 0;
    fake.onCall(() => {
      seen++;
      if (seen === 10) controller.abort();
    });
    const error = await failure(
      fullWalkPage(fake, snapshot, "natural", { count: 500 }, callOf(10_000, controller.signal)),
    );
    expect(error).toMatchObject({ category: "cancelled" });
    expect(fake.openStreams).toBe(0);
  });

  test("every call of every walk carries the walk's deadline and signal", async () => {
    const records = [...j4Keyset(), "/bulk/a", "/bulk/b"].map((key) => ({ key, secondaryIndexes: { i: key } }));
    for (const order of ORDERS) {
      // oxlint-disable-next-line no-await-in-loop -- one order after the other.
      const { fake, snapshot } = await fakeOf(order, records);
      const seen: OxiaCallOptions[] = [];
      const client: OxiaClient = {
        ...fake,
        read: (shard, gets, options) => {
          seen.push(options);
          return fake.read(shard, gets, options);
        },
        list: (shard, range, options) => {
          seen.push(options);
          return fake.list(shard, range, options);
        },
        rangeScan: (shard, range, options) => {
          seen.push(options);
          return fake.rangeScan(shard, range, options);
        },
      };
      const call = callOf();
      // oxlint-disable-next-line no-await-in-loop -- one order after the other.
      await Promise.all([
        detectKeyOrder(client, snapshot, call),
        readDepth(client, snapshot, call),
        fullWalkPage(client, snapshot, order, { count: 50 }, call),
        prefixWalkPage(client, snapshot, order, { prefix: "/a", count: 50 }, call),
        childrenPage(client, snapshot, order, { parent: "/a", count: 50 }, call),
        readKeys(client, snapshot, [{ key: "/a", includeValue: true }], call),
        comparisonGet(client, snapshot, order, { key: "/a", comparison: "CEILING", includeValue: true }, call),
        comparisonGet(
          client,
          snapshot,
          order,
          { key: "/a", comparison: "EQUAL", index: "i", includeValue: true },
          call,
        ),
        listRange(client, snapshot, order, { range: ALL, limit: 50 }, call),
        listRange(client, snapshot, order, { range: ALL, index: "i", limit: 50 }, call),
        rangeScanPage(client, snapshot, order, { range: ALL, limit: 50 }, call),
        prefixListPage(client, snapshot, order, { prefix: "/bulk/", limit: 50 }, call),
        prefixScanPage(client, snapshot, order, { prefix: "/bulk/", limit: 50 }, call),
      ]);
      expect(seen.length).toBeGreaterThan(30);
      for (const options of seen) {
        expect(options.signal).toBe(call.signal);
        expect(options.deadline).toBe(call.deadline);
      }
      seen.length = 0;
      // oxlint-disable-next-line no-await-in-loop -- one order after the other.
      await discoverTopNodes(client, snapshot, order, call);
      expect(seen.length).toBeGreaterThan(0);
      for (const options of seen) {
        expect(options.signal).toBe(call.signal);
        expect(options.deadline).toBeLessThanOrEqual(call.deadline);
      }
    }
  }, 30_000);
});

/** A partition key that stores `key` on the shard `on` (default: any shard) other than the one its own hash names. */
function offHome(snapshot: OxiaSnapshot, key: string, on?: OxiaShard): string {
  const home = shardFor(snapshot, key);
  for (let i = 0; i < 10_000; i++) {
    const shard = shardFor(snapshot, "", `pk-${i}`);
    if (shard !== home && (on === undefined || shard === on)) return `pk-${i}`;
  }
  throw new Error("No partition key routes the key off its own shard");
}

/** The first of `keys` whose own hash names a shard other than `shard`. */
const notOn = (snapshot: OxiaSnapshot, shard: OxiaShard, keys: readonly string[]) =>
  keys.find((key) => shardFor(snapshot, key) !== shard) as string;

describe("a record written with a partition key is read on the shard that holds it (ruling R32)", () => {
  test("the order probe lists a partition-keyed decisive key on the shard that answered it: natural", async () => {
    const shell = await fakeOf("natural", []);
    const first = shell.snapshot.shards[0];
    // The least key of shard 0, so its CEILING of "/" answers it, and stored there under a partition key.
    const decisive = notOn(
      shell.snapshot,
      first,
      Array.from({ length: 50 }, (_, i) => `/!${i}`),
    );
    const plain = Array.from({ length: 84 }, (_, i) => `/t${i}`);
    const keys = [{ key: decisive, partitionKey: offHome(shell.snapshot, decisive, first) }, ...plain];
    const { fake, snapshot } = await fakeOf("natural", keys);
    expect(await listShard(fake, first)).toContain(decisive);
    const verdict = await detectKeyOrder(fake, snapshot, callOf());
    expect(verdict).toEqual({ order: "natural", learnedBy: "decisive-list" });
    const truth = sortedKeys([decisive, ...plain], "natural");
    const walked = await walkAll(
      (cursor) => fullWalkPage(fake, snapshot, verdict.order, { cursor, count: 7 }, callOf()),
      7,
    );
    expect(walked).toEqual([...truth]);
  });

  for (const order of ORDERS) {
    test(`rangeScanPage and prefixScanPage without -p return a partition-keyed record (${order})`, async () => {
      const shell = await fakeOf(order, []);
      const tenant = ["/pk/a/1", "/pk/a/2", "/pk/a/3"];
      const partitionKey = offHome(shell.snapshot, "/pk/a/2");
      const records = [
        ...tenant.map((key) => ({ key, partitionKey, value: new TextEncoder().encode(key) })),
        ...["/x/1", "/x/2", "/y"].map((key) => ({ key, value: new TextEncoder().encode(key) })),
      ];
      const { fake, snapshot } = await fakeOf(order, records);
      const truth = sortedKeys(
        records.map((record) => record.key),
        order,
      );
      const scanned = await rangeScanPage(fake, snapshot, order, { range: ALL, limit: 100 }, callOf());
      expect(scanned.records.map((record) => [record.key, new TextDecoder().decode(record.value)])).toEqual(
        truth.map((key) => [key, key]),
      );
      expect(scanned.more).toBe(false);
      const prefixed = await prefixScanPage(fake, snapshot, order, { prefix: "/pk/", limit: 100 }, callOf());
      expect(prefixed.records.map((record) => record.key)).toEqual([...sortedKeys(tenant, order)]);
      const held = prefixed.records.find((record) => record.key === "/pk/a/2");
      expect(held?.shard).toBe(shardFor(snapshot, "", partitionKey).id);
    });
  }

  test("a partition-keyed node key ending in / is found by the children page and the prefix walks", async () => {
    const shell = await fakeOf("hierarchical", []);
    const records = [
      { key: "a//", partitionKey: offHome(shell.snapshot, "a//"), value: new TextEncoder().encode("node") },
      ...["a/", "a/b", "a//c"].map((key) => ({ key, value: new TextEncoder().encode(key) })),
    ];
    const { fake, snapshot } = await fakeOf("hierarchical", records);
    const children = await childrenPage(fake, snapshot, "hierarchical", { parent: "a/", count: 7 }, callOf());
    expect(children.keys).toEqual([...sortedKeys(["a//", "a//c"], "hierarchical")]);
    const walked = await prefixWalkPage(fake, snapshot, "hierarchical", { prefix: "a/", count: 7 }, callOf());
    expect(walked.keys).toContain("a//");
    const scanned = await prefixScanPage(fake, snapshot, "hierarchical", { prefix: "a/", limit: 10 }, callOf());
    const node = scanned.records.find((record) => record.key === "a//");
    expect(node === undefined ? undefined : new TextDecoder().decode(node.value)).toBe("node");
  });

  test("a floor get whose winner is partition-keyed reads it on the winner's shard (HASIM-B M11)", async () => {
    const shell = await fakeOf("natural", []);
    const records = [
      { key: "b", partitionKey: offHome(shell.snapshot, "b"), value: Uint8Array.of(7) },
      { key: "a", value: Uint8Array.of(1) },
      { key: "c", value: Uint8Array.of(3) },
    ];
    const { fake, snapshot } = await fakeOf("natural", records);
    const answer = await comparisonGet(
      fake,
      snapshot,
      "natural",
      { key: "bz", comparison: "FLOOR", includeValue: true },
      callOf(),
    );
    expect(answer?.key).toBe("b");
    expect(answer?.value).toEqual(Uint8Array.of(7));
  });

  test("an index get whose winner is partition-keyed reads it on the winner's shard (HASIM-B M11)", async () => {
    const shell = await fakeOf("natural", []);
    const records = [
      {
        key: "p1",
        partitionKey: offHome(shell.snapshot, "p1"),
        value: Uint8Array.of(9),
        secondaryIndexes: { i: "s1" },
      },
    ];
    const { fake, snapshot } = await fakeOf("natural", records);
    const answer = await comparisonGet(
      fake,
      snapshot,
      "natural",
      { key: "s1", comparison: "EQUAL", index: "i", includeValue: true },
      callOf(),
    );
    expect(answer?.key).toBe("p1");
    expect(answer?.value).toEqual(Uint8Array.of(9));
  });
});
