/**
 * One parsed Oxia command run over the walks, on the shared fake (SB2-5.1 to SB2-5.3, SB2-5.5): each verb's wire
 * calls and arguments, the two --limit defaults, the comparison get's value read and its miss, both range-scan stops
 * as results with rows, a run cancelled before it began, and the caller's row bound.
 *
 * The surface is built here over the fake, as index.ts builds it over the limited client: one snapshot, and a fixed
 * verdict, so the calls asserted are the command's own. Cancelling a run in flight, the deadline and a repeated
 * queryId are the run registry's, held by provider.test.ts (T21).
 */
import { describe, expect, test } from "bun:test";
import type { OxiaCallOptions, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { type ParsedOxiaCommand, parseOxiaCommand } from "@/lib/db/providers/keyvalue/oxia/commands";
import { OXIA_CELL_LIMIT, OXIA_MAX_LIMIT, OXIA_RUN_BYTE_BUDGET } from "@/lib/db/providers/keyvalue/oxia/constants";
import { OxiaError, receiveCapNotice, runBudgetNotice } from "@/lib/db/providers/keyvalue/oxia/errors";
import { executeOxiaCommand, type OxiaExecutionContext } from "@/lib/db/providers/keyvalue/oxia/execute";
import type { KeyOrder, OrderVerdict } from "@/lib/db/providers/keyvalue/oxia/order";
import { oxiaResult } from "@/lib/db/providers/keyvalue/oxia/results";
import { shardFor } from "@/lib/db/providers/keyvalue/oxia/routing";
import type { OxiaSurface } from "@/lib/db/providers/keyvalue/oxia/walks";
import {
  createFakeOxiaClient,
  type FakeOxiaCall,
  type FakeOxiaClient,
  type FakeOxiaRecord,
} from "../../../helpers/oxia-fake-client";
import { j4Keyset, sortedKeys } from "../../../helpers/oxia-keyset";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const MIB = 1024 * 1024;
const HIERARCHICAL: OrderVerdict = { order: "hierarchical", learnedBy: "ceiling-probe" };

function callOptions(signal: AbortSignal = new AbortController().signal): OxiaCallOptions {
  return { signal, deadline: Date.now() + 10_000 };
}

function contextOf(call: OxiaCallOptions = callOptions()): OxiaExecutionContext {
  return {
    bounds: {
      rowLimit: OXIA_MAX_LIMIT,
      byteBudget: OXIA_RUN_BYTE_BUDGET,
      cellLimit: OXIA_CELL_LIMIT,
      queryTimeoutMs: 10_000,
    },
    call,
    namespace: "default",
  };
}

/** A surface over the fake: its snapshot read once, and the verdict the test names, counted when read. */
function surfaceOver(fake: FakeOxiaClient, verdict: OrderVerdict = HIERARCHICAL) {
  let snapshot: OxiaSnapshot | undefined;
  let orderReads = 0;
  const surface: OxiaSurface = {
    client: fake,
    snapshot: async (call) => {
      snapshot ??= await fake.getSnapshot(call);
      return snapshot;
    },
    order: async () => {
      orderReads += 1;
      return verdict;
    },
  };
  return { surface, orderReads: () => orderReads };
}

function parse(text: string): ParsedOxiaCommand {
  const parsed = parseOxiaCommand(text, {});
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  return parsed.parsed;
}

/** The calls the command made: every call but the snapshot read. */
const dataCalls = (fake: FakeOxiaClient): FakeOxiaCall[] =>
  fake.calls.filter((call) => call.rpc !== "GetShardAssignments");

const fakeOf = (records: readonly FakeOxiaRecord[]): FakeOxiaClient =>
  createFakeOxiaClient({ order: "hierarchical", records });

/** Keys k000 to k(n-1): no `/`, so both orders sort them alike. */
const flatKeys = (n: number): FakeOxiaRecord[] =>
  Array.from({ length: n }, (_, index) => ({ key: `k${String(index).padStart(3, "0")}`, value: utf8("v") }));

describe("get", () => {
  test("equal: one EQUAL Read with the value on the key's shard, the asked key in the answer, and no order read", async () => {
    const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
    const { surface, orderReads } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("get /a"), contextOf());
    const snapshot = await surface.snapshot(callOptions());

    expect(outcome).toMatchObject({ kind: "get", namespace: "default", answer: { key: "/a" } });
    expect("verdict" in outcome).toBe(false);
    expect(orderReads()).toBe(0);
    expect(dataCalls(fake)).toEqual([
      expect.objectContaining({
        rpc: "Read",
        shard: shardFor(snapshot, "/a").id,
        gets: [expect.objectContaining({ key: "/a", includeValue: true, comparison: "EQUAL" })],
      }),
    ]);
  });

  test("equal with -p: the Read goes to the shard the partition key routes to", async () => {
    const fake = fakeOf([{ key: "/a", value: utf8("1"), partitionKey: "pk" }]);
    const { surface } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("get -p pk /a"), contextOf());
    const snapshot = await surface.snapshot(callOptions());

    expect(outcome).toMatchObject({ answer: { key: "/a" } });
    expect(dataCalls(fake).map((call) => call.shard)).toEqual([shardFor(snapshot, "/a", "pk").id]);
  });

  test("a miss on every shard is an undefined answer, never an error (O11)", async () => {
    const { surface } = surfaceOver(fakeOf([{ key: "/a" }]));
    const outcome = await executeOxiaCommand(surface, parse("get /none"), contextOf());
    expect(outcome).toMatchObject({ kind: "get", answer: undefined });
  });

  test("a comparison: a fan-out without values, then one EQUAL get on the winner's shard, under the order read", async () => {
    const fake = fakeOf([
      { key: "/a", value: utf8("1") },
      { key: "/c", value: utf8("3") },
    ]);
    const { surface, orderReads } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("get -t floor /b"), contextOf());
    const snapshot = await surface.snapshot(callOptions());

    expect(outcome).toMatchObject({ kind: "get", answer: { key: "/a" }, verdict: HIERARCHICAL });
    expect(orderReads()).toBe(1);
    const calls = dataCalls(fake);
    const fanOut = calls.slice(0, -1);
    expect(new Set(fanOut.map((call) => call.shard))).toEqual(new Set(snapshot.shards.map((shard) => shard.id)));
    for (const call of fanOut) {
      expect(call).toMatchObject({ rpc: "Read", gets: [{ key: "/b", comparison: "FLOOR", includeValue: false }] });
    }
    expect(calls.at(-1)).toMatchObject({
      rpc: "Read",
      shard: shardFor(snapshot, "/a").id,
      gets: [{ key: "/a", comparison: "EQUAL", includeValue: true }],
    });
  });

  test("the winner gone before its value is read fails as record-changed", async () => {
    const fake = fakeOf([{ key: "/a", value: utf8("1") }]);
    fake.onCall((call) => {
      if (call.gets?.[0]?.comparison === "EQUAL") fake.remove("/a");
    });
    const { surface } = surfaceOver(fake);
    const run = executeOxiaCommand(surface, parse("get -t floor /b"), contextOf());
    await expect(run).rejects.toBeInstanceOf(OxiaError);
    await expect(run).rejects.toMatchObject({ category: "record-changed" });
  });

  test("an --index get answers the primary key and the winner's secondary key", async () => {
    const fake = fakeOf([{ key: "/users/1", value: utf8("{}"), secondaryIndexes: { "by-email": "a@x" } }]);
    const { surface } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("get --index by-email a@x"), contextOf());

    expect(outcome).toMatchObject({ answer: { key: "/users/1", secondaryIndexKey: "a@x" }, verdict: HIERARCHICAL });
    expect(dataCalls(fake)[0]).toMatchObject({
      rpc: "Read",
      gets: [{ key: "a@x", comparison: "EQUAL", includeValue: false, secondaryIndexName: "by-email" }],
    });
  });
});

describe("list", () => {
  test("bounds: one List per shard over [MIN, MAX) under the console's 8 MiB stream limit", async () => {
    const records = ["/a", "/b", "/m", "/z"].map((key) => ({ key }));
    const fake = fakeOf(records);
    const { surface } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("list /b /z"), contextOf());

    expect(outcome).toMatchObject({ kind: "list", answer: { keys: ["/b", "/m"], more: false }, verdict: HIERARCHICAL });
    const calls = dataCalls(fake);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatchObject({
        rpc: "List",
        range: { startInclusive: "/b", endExclusive: "/z" },
        maxReceivedBytes: OXIA_RUN_BYTE_BUDGET,
      });
    }
  });

  test("the default --limit is 500: 600 keys answer 500, and more follow", async () => {
    const { surface } = surfaceOver(fakeOf(flatKeys(600)));
    const outcome = await executeOxiaCommand(surface, parse("list"), contextOf());
    expect(outcome.kind === "list" && [outcome.answer.keys.length, outcome.answer.more]).toEqual([500, true]);
  });

  test("--prefix walks every key beginning with it, in the namespace's order, with no RangeScan", async () => {
    const keys = ["/a/1", "/a/2", "/a/b/3", "/a//4", "/b/1", "/a"];
    const fake = fakeOf(keys.map((key) => ({ key })));
    const { surface } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("list --prefix /a/"), contextOf());

    const truth = sortedKeys(
      keys.filter((key) => key.startsWith("/a/")),
      "hierarchical",
    );
    expect(outcome).toMatchObject({ kind: "list", answer: { keys: [...truth] } });
    expect(dataCalls(fake).some((call) => call.rpc === "RangeScan")).toBe(false);
  });

  // 1.4 s alone with coverage, over the 1 s line of ruling R36, so it carries its own timeout.
  test("--prefix runs under the console's 8 MiB run budget: it stops with N5b, never the Keys panel's sentence", async () => {
    // 200 keys of 64 KiB under /p/ on 3 shards: 12.5 MiB of key bytes, past the run budget.
    const keys = Array.from(
      { length: 200 },
      (_, index) => `/p/${String(index).padStart(3, "0")}${"x".repeat(64 * 1024)}`,
    );
    const fake = fakeOf(keys.map((key) => ({ key })));
    const { surface } = surfaceOver(fake);
    const parsed = parse("list --prefix /p/");
    const outcome = await executeOxiaCommand(surface, parsed, contextOf());

    expect(outcome).toMatchObject({ kind: "list", answer: { more: true, stoppedBy: "bytes" } });
    const kept = outcome.kind === "list" ? outcome.answer.keys : [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(sortedKeys(keys, "hierarchical").slice(0, kept.length));
    for (const call of dataCalls(fake).filter((each) => each.rpc === "List"))
      expect(call.maxReceivedBytes).toBe(OXIA_RUN_BYTE_BUDGET);
    expect(oxiaResult(outcome, parsed, OXIA_CELL_LIMIT, 1).warnings?.map((warning) => warning.message)).toContain(
      runBudgetNotice("list", kept.length),
    );
  }, 30_000);

  test("-p reads the one shard the partition key routes to", async () => {
    const fake = fakeOf([
      { key: "/a", partitionKey: "pk" },
      { key: "/b", partitionKey: "pk" },
    ]);
    const { surface } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("list -p pk"), contextOf());
    const snapshot = await surface.snapshot(callOptions());

    expect(outcome).toMatchObject({ answer: { keys: ["/a", "/b"], shardsRead: 1 } });
    for (const call of dataCalls(fake)) expect(call.shard).toBe(shardFor(snapshot, "", "pk").id);
  });

  test("--index lists over the index, its name set by the walk on every List", async () => {
    const fake = fakeOf([{ key: "/users/1", secondaryIndexes: { "by-email": "a@x" } }]);
    const { surface } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("list --index by-email a b"), contextOf());

    expect(outcome).toMatchObject({ answer: { keys: ["/users/1"] } });
    for (const call of dataCalls(fake)) expect(call.range).toMatchObject({ secondaryIndexName: "by-email" });
  });
});

describe("range-scan", () => {
  test("bounds: keys by List on every shard under the 8 MiB stream limit, then their values by EQUAL Reads (R23), and the default --limit of 100", async () => {
    const fake = fakeOf(flatKeys(600));
    const { surface } = surfaceOver(fake);
    const outcome = await executeOxiaCommand(surface, parse("range-scan"), contextOf());
    const snapshot = await surface.snapshot(callOptions());

    expect(outcome.kind === "range-scan" && [outcome.answer.records.length, outcome.answer.more]).toEqual([100, true]);
    const calls = dataCalls(fake);
    const lists = calls.filter((call) => call.rpc === "List");
    expect(new Set(lists.map((call) => call.shard))).toEqual(new Set(snapshot.shards.map((shard) => shard.id)));
    for (const call of lists) {
      expect(call).toMatchObject({
        range: { startInclusive: "", endExclusive: "" },
        maxReceivedBytes: OXIA_RUN_BYTE_BUDGET,
      });
    }
    const reads = calls.filter((call) => call.rpc === "Read");
    expect(lists.length + reads.length).toBe(calls.length);
    expect(calls.findIndex((call) => call.rpc === "Read")).toBeGreaterThanOrEqual(lists.length);
    for (const call of reads) {
      for (const get of call.gets ?? []) expect(get).toMatchObject({ comparison: "EQUAL", includeValue: true });
    }
    expect(reads.flatMap((call) => call.gets ?? []).map((get) => get.key)).toEqual(flatKeys(100).map(({ key }) => key));
  });

  test("--prefix scans every record beginning with it, in the namespace's order", async () => {
    const keys = ["/a/1", "/a/b/2", "/b/1"];
    const { surface } = surfaceOver(fakeOf(keys.map((key) => ({ key, value: utf8(key) }))));
    const outcome = await executeOxiaCommand(surface, parse("range-scan --prefix /a/"), contextOf());

    expect(outcome.kind === "range-scan" && outcome.answer.records.map((record) => record.key)).toEqual([
      ...sortedKeys(["/a/1", "/a/b/2"], "hierarchical"),
    ]);
  });

  test("the run budget stops the scan with the rows kept: a 10 MiB record is kept as the last row (F10)", async () => {
    const fake = fakeOf([
      { key: "/p/a", value: new Uint8Array(1024), partitionKey: "pk" },
      { key: "/p/b", value: new Uint8Array(10 * MIB), partitionKey: "pk" },
      { key: "/p/c", value: new Uint8Array(1024), partitionKey: "pk" },
    ]);
    const { surface } = surfaceOver(fake);
    const parsed = parse("range-scan -p pk");
    const outcome = await executeOxiaCommand(surface, parsed, contextOf());

    expect(outcome.kind === "range-scan" && outcome.answer.records.map((record) => record.key)).toEqual([
      "/p/a",
      "/p/b",
    ]);
    expect(outcome).toMatchObject({ answer: { stoppedBy: "bytes" } });
    const result = oxiaResult(outcome, parsed, OXIA_CELL_LIMIT, 1);
    expect(result.rowCount).toBe(2);
    expect(result.warnings?.map((warning) => warning.message)).toContain(runBudgetNotice("range-scan", 2));
  });

  test("the receive cap stops the scan with the rows read before it, as a result and not an error", async () => {
    const fake = fakeOf([
      { key: "/p/a", value: new Uint8Array(1024), partitionKey: "pk" },
      { key: "/p/b", value: new Uint8Array(17 * MIB), partitionKey: "pk" },
      { key: "/p/c", value: new Uint8Array(1024), partitionKey: "pk" },
    ]);
    const { surface } = surfaceOver(fake);
    const parsed = parse("range-scan -p pk");
    const outcome = await executeOxiaCommand(surface, parsed, contextOf());

    expect(outcome.kind === "range-scan" && outcome.answer.records.map((record) => record.key)).toEqual(["/p/a"]);
    expect(outcome).toMatchObject({ answer: { stoppedBy: "receive-cap" } });
    expect(oxiaResult(outcome, parsed, OXIA_CELL_LIMIT, 1).warnings?.map((warning) => warning.message)).toContain(
      receiveCapNotice(1),
    );
  });
});

describe("what each walk is handed", () => {
  for (const order of ["hierarchical", "natural"] as const satisfies readonly KeyOrder[]) {
    const verdict: OrderVerdict = { order, learnedBy: "ceiling-probe" };
    // Only keys with "/": the first 500 of j4's keys in hierarchical order hold none, and sort alike in both orders.
    const keys = j4Keyset().filter((key) => key.includes("/"));
    const truth = sortedKeys(keys, order);
    const surfaceIn = () =>
      surfaceOver(createFakeOxiaClient({ order, records: keys.map((key) => ({ key, value: utf8("v") })) }), verdict);

    test(`list bounds merges the shards in the ${order} order the surface reads`, async () => {
      const outcome = await executeOxiaCommand(surfaceIn().surface, parse("list"), contextOf());
      expect(outcome.kind === "list" && outcome.answer.keys).toEqual(truth.slice(0, OXIA_MAX_LIMIT));
    });

    test(`range-scan bounds merges the shards in the ${order} order the surface reads`, async () => {
      const outcome = await executeOxiaCommand(surfaceIn().surface, parse("range-scan --limit 500"), contextOf());
      expect(outcome.kind === "range-scan" && outcome.answer.records.map((record) => record.key)).toEqual(
        truth.slice(0, OXIA_MAX_LIMIT),
      );
    });

    test(`a floor get picks the winner across shards in the ${order} order the surface reads`, async () => {
      // "/lz" beside keys on other shards that floor /m in one order only: zN (hierarchical), /l/N (natural).
      const snapshot = await createFakeOxiaClient({ order, records: [] }).getSnapshot(callOptions());
      const elsewhere = (family: (index: number) => string) => {
        const index = Array.from({ length: 64 }, (_, each) => each).find(
          (each) => shardFor(snapshot, family(each)).id !== shardFor(snapshot, "/lz").id,
        );
        return family(index as number);
      };
      const floorKeys = ["/lz", elsewhere((index) => `z${index}`), elsewhere((index) => `/l/${index}`)];
      const fake = createFakeOxiaClient({ order, records: floorKeys.map((key) => ({ key, value: utf8("v") })) });
      const outcome = await executeOxiaCommand(
        surfaceOver(fake, verdict).surface,
        parse("get -t floor /m"),
        contextOf(),
      );
      // In either order /lz is the floor of /m; the other order would pick the other shard's answer.
      expect(outcome).toMatchObject({ kind: "get", answer: { key: "/lz" } });
    });
  }

  for (const comparison of ["floor", "ceiling", "lower", "higher"] as const) {
    test(`get -t ${comparison} asks every shard for ${comparison.toUpperCase()}`, async () => {
      const fake = fakeOf([{ key: "/a" }, { key: "/b" }, { key: "/c" }]);
      const { surface } = surfaceOver(fake);
      await executeOxiaCommand(surface, parse(`get -t ${comparison} /b`), contextOf());
      const fanOut = dataCalls(fake).filter((call) => call.gets?.[0]?.includeValue === false);
      expect(fanOut.length).toBeGreaterThan(0);
      for (const call of fanOut) expect(call.gets).toMatchObject([{ key: "/b", comparison: comparison.toUpperCase() }]);
    });
  }

  for (const text of ["get -t floor -p pk /b", "list --prefix /a -p pk", "range-scan --prefix /a -p pk"]) {
    test(`${text} reads only the shard the partition key routes to`, async () => {
      const fake = fakeOf([
        { key: "/a1", value: utf8("1"), partitionKey: "pk" },
        { key: "/a2", value: utf8("2"), partitionKey: "pk" },
      ]);
      const { surface } = surfaceOver(fake);
      await executeOxiaCommand(surface, parse(text), contextOf());
      const snapshot = await surface.snapshot(callOptions());

      expect(snapshot.shards.length).toBeGreaterThan(1);
      expect(dataCalls(fake).length).toBeGreaterThan(0);
      for (const call of dataCalls(fake)) expect(call.shard).toBe(shardFor(snapshot, "", "pk").id);
    });
  }
});

describe("the run's own refusals", () => {
  test("a run whose signal is already aborted sends nothing and fails with the signal's reason", async () => {
    const fake = fakeOf([{ key: "/a" }]);
    const { surface } = surfaceOver(fake);
    const controller = new AbortController();
    const reason = new Error("cancelled before it began");
    controller.abort(reason);

    await expect(executeOxiaCommand(surface, parse("get /a"), contextOf(callOptions(controller.signal)))).rejects.toBe(
      reason,
    );
    expect(fake.calls).toEqual([]);
  });

  test("a command past the caller's row bound is a defect, refused before any call", async () => {
    const fake = fakeOf([{ key: "/a" }]);
    const { surface } = surfaceOver(fake);
    const parsed: ParsedOxiaCommand = {
      command: { kind: "list", range: { kind: "bounds", min: "", max: "" }, limit: OXIA_MAX_LIMIT + 1 },
      matched: [],
      line: 1,
    };

    await expect(executeOxiaCommand(surface, parsed, contextOf())).rejects.toThrow(
      "A command asked for 501 rows, past the 500 a result holds: the parser bounds --limit",
    );
    expect(fake.calls).toEqual([]);
  });
});
