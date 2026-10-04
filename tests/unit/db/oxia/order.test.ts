/**
 * The Oxia key order (SB1-7.1 to SB1-7.4, SB1-8.1, SB1-8.2): both server encoders, the order probe's decisions, the
 * children, root and prefix ranges, and the discovery probes.
 *
 * The vectors are the J4 keyspace prototype's, measured against real 0.16.10 servers of both orders, and the range
 * properties are checked over the prototype's whole keyset, so a port that differs from the prototype on any key fails.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OxiaRange } from "@/lib/db/providers/keyvalue/oxia/client";
import {
  childrenRange,
  compareBytes,
  decideFromList,
  decideFromPairs,
  decideFromProbe,
  type DiscoveryProbe,
  encodeHierarchical,
  encodeNatural,
  hasLoneSurrogate,
  hierarchicalLevel,
  isRootFlat,
  type KeyOrder,
  keyComparator,
  lowerAtLevel,
  maxLevel,
  naturalChildrenRange,
  naturalPrefixEnd,
  nextDiscoveryProbe,
  ORDER_PROBE_GETS,
  type OrderVerdict,
  type PrefixBand,
  type ProbeStep,
  prefixBands,
  ROOT_FLAT_RANGE,
  topNode,
  verdictIsProvisional,
} from "@/lib/db/providers/keyvalue/oxia/order";
import { blindSpotKeyset, j4Keyset, pulsarKeyset, sortedKeys, splitByPosition } from "../../../helpers/oxia-keyset";

interface EncoderVector {
  readonly key: string;
  readonly hierarchical: string;
  readonly natural: string;
}

interface ChildrenVector {
  readonly p: string;
  readonly start: string;
  readonly end: string;
  readonly extraGets: readonly string[];
}

interface OrderVectors {
  readonly provenance: string;
  readonly encoders: readonly EncoderVector[];
  readonly serverOrder: Readonly<Record<string, readonly string[]>>;
  readonly ranges: {
    readonly children: readonly ChildrenVector[];
    readonly bands: Readonly<Record<string, readonly PrefixBand[]>>;
    readonly lowerAtLevel: readonly { readonly x: string; readonly level: number; readonly bound: string }[];
    readonly naturalPrefixEnd: readonly { readonly x: string; readonly end: string }[];
  };
}

const VECTORS: OrderVectors = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/oxia/order-vectors.json"), "utf8"),
);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const encoderOf = (order: KeyOrder) => (order === "hierarchical" ? encodeHierarchical : encodeNatural);

/** The keys of `sorted` (encoded alongside) in [start, end) by the order's encoder; "" is unbounded at either end. */
function inRange(
  sorted: readonly string[],
  encoded: readonly Uint8Array[],
  order: KeyOrder,
  start: string,
  end: string,
): string[] {
  const encode = encoderOf(order);
  const low = start === "" ? undefined : encode(start);
  const high = end === "" ? undefined : encode(end);
  return sorted.filter(
    (_, i) =>
      (low === undefined || compareBytes(encoded[i], low) >= 0) &&
      (high === undefined || compareBytes(encoded[i], high) < 0),
  );
}

function strictlyIncreasing(keys: readonly string[], order: KeyOrder): boolean {
  const cmp = keyComparator(order);
  return keys.every((key, i) => i === 0 || cmp(keys[i - 1], key) < 0);
}

/** The order probe's pipeline over a model namespace, the way walks.ts calls the decisions (SB1-7.2). */
function decide(keys: readonly string[], order: KeyOrder): OrderVerdict {
  const encode = encoderOf(order);
  const shards = splitByPosition(keys, 3, order);
  const encodedShards = shards.map((shard) => shard.map(encode));
  const ceilingKey = encode(ORDER_PROBE_GETS[0].key);
  const floorKey = encode(ORDER_PROBE_GETS[1].key);
  const answers = shards.map((shard, s) => ({
    ceiling: shard.find((_, i) => compareBytes(encodedShards[s][i], ceilingKey) >= 0),
    floor: shard.findLast((_, i) => compareBytes(encodedShards[s][i], floorKey) <= 0),
  }));
  const listStep = (key: string, range: OxiaRange): OrderVerdict => {
    const s = shards.findIndex((shard) => shard.includes(key));
    const listed = inRange(shards[s], encodedShards[s], order, range.startInclusive, range.endExclusive);
    return decideFromList(key, listed);
  };
  const step = decideFromProbe(answers);
  if (step.kind === "verdict") return step.verdict;
  if (step.kind === "list") return listStep(step.key, step.range);
  const sampled = decideFromPairs(shards.map((shard) => shard.slice(0, 100)));
  if ("kind" in sampled) return listStep(sampled.key, sampled.range);
  return sampled;
}

/** The 600 keys "-k0000" to "-k0599" of the CE namespaces. */
const DASH_KEYS = Array.from({ length: 600 }, (_, i) => `-k${String(i).padStart(4, "0")}`);
const CE1 = [...DASH_KEYS, "/a/b", "/a/bb", "/a/c", "/b", "/b/x"];
const CE2 = [...DASH_KEYS, "/a/-x", "/a/b/", "/a/.y"];
const FLAT = ["config", "feature-flag.dark-mode", "user:42", "zz-last-flat", "a", "b", "c"];

/** The 200 prefixes of the band properties: never empty, never splitting a surrogate pair. */
function prefixes(): string[] {
  const keys = j4Keyset();
  return Array.from({ length: 200 }, (_, i) => {
    const points = [...keys[(i * 15) % keys.length]];
    return points.slice(0, (i % points.length) + 1).join("");
  });
}

const EDGE_PREFIXES = [
  "\u0000",
  "\u0000\u0000",
  "/",
  "//",
  "/a//",
  "/p/\u{10FFFF}",
  "\u{10FFFF}",
  "/bulk/",
  "/p",
  "a",
  "x/",
];

describe("the keyset helper is the prototype's", () => {
  test("j4Keyset is the prototype's ALL", () => {
    expect(j4Keyset()).toHaveLength(3_059);
    expect(sha256(j4Keyset())).toBe("c6ee1b99ab3fc9471310e6f5e1b5a4487112d42e557eb3101581844c95b65024");
  });

  test("the comparator sorts the keyset as the prototype's does, under both orders", () => {
    expect(sha256(sortedKeys(j4Keyset(), "hierarchical"))).toBe(
      "aeebbd6410b6dbef98a094a0cfb8cd9de5478b0ba7aa80e3da673d9531d9464e",
    );
    expect(sha256(sortedKeys(j4Keyset(), "natural"))).toBe(
      "4eb0c07543bc65d7c16e9982a5a23042193e05c81af0ae8577cf22f8917a4ca8",
    );
  });

  test("the Pulsar set holds 75 keys before the bulk", () => {
    expect(pulsarKeyset(15_000)).toHaveLength(15_075);
    expect(pulsarKeyset(0)).toHaveLength(75);
  });

  test("the blind-spot set", () => {
    const keys = blindSpotKeyset(1_000);
    expect(keys).toHaveLength(1_013);
    expect(keys[0]).toBe("!0000");
    expect(keys.at(-1)).toBe(".z9");
  });

  test("splitByPosition deals keys by position and sorts each shard", () => {
    expect(splitByPosition(["c", "a", "b", "d"], 2, "natural")).toEqual([
      ["b", "c"],
      ["a", "d"],
    ]);
  });
});

describe("encoders and comparator (SB1-7.1)", () => {
  test("every encoder vector", () => {
    expect(VECTORS.encoders).toHaveLength(20);
    for (const row of VECTORS.encoders) {
      expect({
        key: row.key,
        hierarchical: hex(encodeHierarchical(row.key)),
        natural: hex(encodeNatural(row.key)),
      }).toEqual(row);
    }
    const keys = VECTORS.encoders.map((row) => row.key);
    for (const key of ["//", "/a//", "x//y", "/a\u0000", "__oxia/session/x", "/p/\u{10FFFF}"]) {
      expect(keys).toContain(key);
    }
  });

  test("compareBytes is Go's bytes.Compare", () => {
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(-1);
    expect(compareBytes(new Uint8Array([1, 0]), new Uint8Array([1]))).toBe(1);
    expect(compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(0);
    expect(compareBytes(new Uint8Array([2]), new Uint8Array([1, 255]))).toBe(1);
    expect(compareBytes(new Uint8Array([1, 255]), new Uint8Array([2]))).toBe(-1);
  });

  test("each server's List order is increasing under its own order, and the two sets tell the orders apart", () => {
    const hierarchical = VECTORS.serverOrder["hierarchical_j4-2_shard0"];
    const natural = VECTORS.serverOrder["natural_j4-1_shard0"];
    expect(hierarchical).toHaveLength(200);
    expect(natural).toHaveLength(200);
    expect(strictlyIncreasing(hierarchical, "hierarchical")).toBe(true);
    expect(strictlyIncreasing(natural, "natural")).toBe(true);
    // The hierarchical server's first 200 keys are all on level 0, where the two encoders agree, so that sequence is
    // increasing under natural too; the natural server's sequence is what natural sorting alone produces.
    expect(hierarchical.every((key) => hierarchicalLevel(key) === 0)).toBe(true);
    expect(strictlyIncreasing(hierarchical, "natural")).toBe(true);
    expect(strictlyIncreasing(natural, "hierarchical")).toBe(false);
  });

  test("CompareWithSlash order is not produced (R02's example row)", () => {
    const input = ["a", "a-b", "b", "z", "/x", "__oxia/idx/i/k", "a/", "a/b", "a/z", "a/b/c", "b/c"];
    const hierarchical = ["a", "a-b", "b", "z", "a/", "a/b", "a/z", "b/c", "/x", "a/b/c", "__oxia/idx/i/k"];
    const natural = ["/x", "a", "a-b", "a/", "a/b", "a/b/c", "a/z", "b", "b/c", "z", "__oxia/idx/i/k"];
    expect(sortedKeys(input, "hierarchical")).toEqual(hierarchical);
    expect(sortedKeys(input, "natural")).toEqual(natural);
    expect(hierarchical).not.toEqual(input);
    expect(natural).not.toEqual(input);
  });

  test("hierarchicalLevel", () => {
    const levels: readonly [string, number][] = [
      ["", 0],
      ["a", 0],
      ["/", 1],
      ["//", 1],
      ["/a//", 2],
      ["x//y", 2],
      ["/a/b/", 3],
      ["__oxia/session/x", 2],
      ["/".repeat(0x8000), 32_767],
    ];
    for (const [key, level] of levels) expect(hierarchicalLevel(key)).toBe(level);
  });
});

describe("the order probe's decisions (SB1-7.2)", () => {
  test("the two probe gets", () => {
    expect(ORDER_PROBE_GETS).toEqual([
      { key: "/", comparison: "CEILING", includeValue: false },
      { key: "/".repeat(0x8000), comparison: "FLOOR", includeValue: false },
    ]);
    expect(Object.isFrozen(ORDER_PROBE_GETS)).toBe(true);
  });

  test("decideFromProbe: a CEILING answer without / is natural", () => {
    expect(decideFromProbe([{ ceiling: "/a/b" }, { ceiling: "a" }])).toEqual({
      kind: "verdict",
      verdict: { order: "natural", learnedBy: "ceiling-probe" },
    });
  });

  test("decideFromProbe: the first answered key with / is listed", () => {
    expect(decideFromProbe([{ floor: "flat" }, { ceiling: "/b", floor: "/z/y" }])).toEqual({
      kind: "list",
      key: "/b",
      range: { startInclusive: "/b", endExclusive: "0" },
    });
    expect(decideFromProbe([{ floor: "app/x/y" }])).toEqual({
      kind: "list",
      key: "app/x/y",
      range: { startInclusive: "app/x/y", endExclusive: "app0" },
    });
  });

  test("decideFromProbe: no answer at all is an empty namespace", () => {
    const empty: ProbeStep = { kind: "verdict", verdict: { order: "hierarchical", learnedBy: "empty" } };
    expect(decideFromProbe([{}, {}, {}])).toEqual(empty);
    expect(decideFromProbe([])).toEqual(empty);
  });

  test("decideFromProbe: only answers without / ask for the sample", () => {
    expect(decideFromProbe([{ floor: "flat" }, {}])).toEqual({ kind: "sample" });
  });

  test("decideFromList", () => {
    expect(decideFromList("/b", ["/b"])).toEqual({ order: "natural", learnedBy: "decisive-list" });
    expect(decideFromList("/b", [])).toEqual({ order: "hierarchical", learnedBy: "decisive-list" });
    expect(decideFromList("/b", ["/c"])).toEqual({ order: "hierarchical", learnedBy: "decisive-list" });
  });

  test("decideFromPairs", () => {
    expect(decideFromPairs([["zz-last-flat", "/ab"]])).toEqual({ order: "hierarchical", learnedBy: "pair-sample" });
    expect(decideFromPairs([["/x", "a"]])).toEqual({ order: "natural", learnedBy: "pair-sample" });
    expect(
      decideFromPairs([
        ["a", "b"],
        ["c", "x/y"],
      ]),
    ).toEqual({ kind: "list", key: "x/y", range: { startInclusive: "x/y", endExclusive: "x0" } });
    const assumed: OrderVerdict = { order: "hierarchical", learnedBy: "assumed" };
    expect(decideFromPairs([["a", "b"], ["c"]])).toEqual(assumed);
    expect(decideFromPairs([])).toEqual(assumed);
  });

  const namespaces: readonly [string, readonly string[], KeyOrder, OrderVerdict][] = [
    ["j4", j4Keyset(), "hierarchical", { order: "hierarchical", learnedBy: "decisive-list" }],
    ["j4", j4Keyset(), "natural", { order: "natural", learnedBy: "decisive-list" }],
    ["CE1", CE1, "natural", { order: "natural", learnedBy: "decisive-list" }],
    ["CE1", CE1, "hierarchical", { order: "hierarchical", learnedBy: "decisive-list" }],
    ["CE2", CE2, "natural", { order: "natural", learnedBy: "decisive-list" }],
    ["flat", FLAT, "natural", { order: "natural", learnedBy: "ceiling-probe" }],
    ["flat", FLAT, "hierarchical", { order: "hierarchical", learnedBy: "assumed" }],
    ["empty", [], "natural", { order: "hierarchical", learnedBy: "empty" }],
    ["empty", [], "hierarchical", { order: "hierarchical", learnedBy: "empty" }],
    ["pulsar", pulsarKeyset(100), "natural", { order: "natural", learnedBy: "decisive-list" }],
    ["pulsar", pulsarKeyset(100), "hierarchical", { order: "hierarchical", learnedBy: "decisive-list" }],
    ["blind spot", blindSpotKeyset(1_000), "hierarchical", { order: "hierarchical", learnedBy: "decisive-list" }],
    // The blind spot: the sample cannot decide, and walks.ts reads on (SB1-7.2 step 6, T15's test).
    ["blind spot", blindSpotKeyset(1_000), "natural", { order: "hierarchical", learnedBy: "assumed" }],
  ];
  for (const [name, keys, order, verdict] of namespaces) {
    test(`the ${name} namespace, ${order}`, () => {
      expect(decide(keys, order)).toEqual(verdict);
    });
  }

  test("verdictIsProvisional", () => {
    expect(verdictIsProvisional({ order: "hierarchical", learnedBy: "assumed" })).toBe(true);
    expect(verdictIsProvisional({ order: "hierarchical", learnedBy: "assumed", exhausted: true })).toBe(true);
    expect(verdictIsProvisional({ order: "hierarchical", learnedBy: "empty" })).toBe(true);
    expect(verdictIsProvisional({ order: "natural", learnedBy: "ceiling-probe" })).toBe(false);
    expect(verdictIsProvisional({ order: "natural", learnedBy: "decisive-list" })).toBe(false);
    expect(verdictIsProvisional({ order: "hierarchical", learnedBy: "pair-sample" })).toBe(false);
  });

  test("maxLevel", () => {
    expect(maxLevel([])).toBe(0);
    expect(maxLevel([undefined, undefined])).toBe(0);
    expect(maxLevel(["/a/b", undefined, "x"])).toBe(2);
    expect(maxLevel(["/deep/1/2/3/4/5/6/7/8/9"])).toBe(10);
  });
});

describe("children, root and prefix ranges (SB1-7.3, SB1-7.4)", () => {
  const hierarchicalTruth = sortedKeys(j4Keyset(), "hierarchical");
  const hierarchicalEncoded = hierarchicalTruth.map(encodeHierarchical);
  const naturalTruth = sortedKeys(j4Keyset(), "natural");
  const naturalEncoded = naturalTruth.map(encodeNatural);
  const present = new Set(j4Keyset());
  const nodes = [...new Set(["", ...j4Keyset().map((key) => key.slice(0, Math.max(0, key.lastIndexOf("/"))))])];
  const childrenOf = (p: string) =>
    j4Keyset()
      .filter((key) => key.startsWith(`${p}/`) && !key.slice(p.length + 1).includes("/"))
      .sort();

  test("every children vector", () => {
    for (const row of VECTORS.ranges.children) {
      expect({ p: row.p, ...childrenRange(row.p) }).toEqual(row);
    }
  });

  test("childrenRange is exact over the J4 keyset under hierarchical, for every node", () => {
    expect(nodes.length).toBeGreaterThan(100);
    for (const p of nodes) {
      const range = childrenRange(p);
      const read = inRange(hierarchicalTruth, hierarchicalEncoded, "hierarchical", range.start, range.end);
      const got = [...read, ...range.extraGets.filter((key) => present.has(key))].sort();
      expect({ p, keys: got }).toEqual({ p, keys: childrenOf(p) });
    }
  });

  test("naturalChildrenRange is exact over the J4 keyset under natural", () => {
    for (const p of [...new Set(["/a", "/a/", "", "x/", ...nodes])]) {
      const range = naturalChildrenRange(p);
      expect(range.start).toBe(`${p}/`);
      expect(range.end).toBe(`${p}0`);
      const got = inRange(naturalTruth, naturalEncoded, "natural", range.start, range.end).filter(range.keep).sort();
      expect({ p, keys: got }).toEqual({ p, keys: childrenOf(p) });
    }
  });

  test("the root level", () => {
    expect(ROOT_FLAT_RANGE).toEqual({ start: "", end: "\u0000/" });
    const read = inRange(
      hierarchicalTruth,
      hierarchicalEncoded,
      "hierarchical",
      ROOT_FLAT_RANGE.start,
      ROOT_FLAT_RANGE.end,
    );
    expect(read.filter(isRootFlat).sort()).toEqual(
      j4Keyset()
        .filter((key) => !key.includes("/"))
        .sort(),
    );
    expect(isRootFlat("a")).toBe(true);
    expect(isRootFlat("a/b")).toBe(false);
    expect(isRootFlat("/")).toBe(false);
  });

  test("every band, lowerAtLevel and naturalPrefixEnd vector", () => {
    const levels: Readonly<Record<string, number>> = { "/bulk/": 6, "/p": 4, "/a//": 5 };
    expect(Object.keys(VECTORS.ranges.bands).sort()).toEqual(Object.keys(levels).sort());
    for (const [x, bands] of Object.entries(VECTORS.ranges.bands)) expect(prefixBands(x, levels[x])).toEqual(bands);
    for (const row of VECTORS.ranges.lowerAtLevel) expect(lowerAtLevel(row.x, row.level)).toBe(row.bound);
    for (const row of VECTORS.ranges.naturalPrefixEnd) expect(naturalPrefixEnd(row.x)).toBe(row.end);
    expect(naturalPrefixEnd("\u{10FFFF}\u{10FFFF}")).toBe("");
  });

  test("lowerAtLevel steps over the surrogates", () => {
    expect(lowerAtLevel("a\uE000", 1)).toBe("a\uD7FF/");
  });

  test("the raised bounds step over / and the surrogates", () => {
    expect(prefixBands("a.", 0)).toEqual([{ level: 0, start: "a.", end: "a0", extraGets: [] }]);
    expect(prefixBands("a\uD7FF", 0)).toEqual([{ level: 0, start: "a\uD7FF", end: "a\uE000", extraGets: [] }]);
    expect(naturalPrefixEnd("a\uD7FF")).toBe("a\uE000");
  });

  test("the bands of a prefix read exactly the keys that begin with it, in order (hierarchical)", () => {
    const top = maxLevel(j4Keyset());
    expect(top).toBe(10);
    const cmp = keyComparator("hierarchical");
    for (const x of [...prefixes(), ...EDGE_PREFIXES]) {
      const got: string[] = [];
      for (const band of prefixBands(x, top)) {
        const part = new Set(
          inRange(hierarchicalTruth, hierarchicalEncoded, "hierarchical", band.start, band.end).filter(
            (key) => key.startsWith(x) && hierarchicalLevel(key) === band.level,
          ),
        );
        for (const key of band.extraGets) if (present.has(key) && key.startsWith(x)) part.add(key);
        got.push(...[...part].sort(cmp));
      }
      expect({ x, keys: got }).toEqual({ x, keys: hierarchicalTruth.filter((key) => key.startsWith(x)) });
    }
  });

  test("the natural prefix range reads exactly the keys that begin with it", () => {
    for (const x of [...prefixes(), ...EDGE_PREFIXES]) {
      const got = inRange(naturalTruth, naturalEncoded, "natural", x, naturalPrefixEnd(x));
      expect({ x, keys: got }).toEqual({ x, keys: naturalTruth.filter((key) => key.startsWith(x)) });
    }
  });
});

describe("discovery probes (SB1-8.1, SB1-8.2)", () => {
  const rows: readonly [string, string | undefined, string, string, DiscoveryProbe["comparison"]][] = [
    ["/a", undefined, "//", "/a", "HIGHER"],
    ["/a/b", "/a", "/a//", "/a0", "CEILING"],
    ["a/b", "a", "a//", "a0", "CEILING"],
    ["//x", "/", "///", "/0", "CEILING"],
    ["svc//", "svc", "svc//", "svc0", "CEILING"],
    ["/x//y", "/x", "/x///", "/x0", "CEILING"],
    ["\u0000a/b", "\u0000a", "\u0000a//", "\u0000a0", "CEILING"],
    ["/\u{10FFFF}/x", "/\u{10FFFF}", "/\u{10FFFF}//", "/\u{10FFFF}0", "CEILING"],
    ["/a/b/c/d", "/a", "/a////", "/a0", "CEILING"],
    ["flat", undefined, "/", "flat", "HIGHER"],
  ];
  for (const [key, top, hierarchicalKey, naturalKey, naturalComparison] of rows) {
    test(`the probes after ${JSON.stringify(key)}`, () => {
      expect(topNode(key)).toBe(top);
      expect(nextDiscoveryProbe(key, "hierarchical")).toEqual({ key: hierarchicalKey, comparison: "HIGHER" });
      expect(nextDiscoveryProbe(key, "natural")).toEqual({ key: naturalKey, comparison: naturalComparison });
    });
  }

  test("the top nodes of the Pulsar and J4 sets", () => {
    const tops = (keys: readonly string[]) => [
      ...new Set(keys.map(topNode).filter((node): node is string => node !== undefined)),
    ];
    expect(tops(pulsarKeyset(15_000))).toEqual([
      "/admin",
      "/loadbalance",
      "/managed-ledgers",
      "/namespace",
      "/schemas",
      "/ledgers",
      "/stream",
      "/orphan",
      "orphan-flat",
      "/bulk",
      "app",
      "svc",
      "/x",
    ]);
    expect(tops(j4Keyset())).toHaveLength(872);
  });
});

describe("hasLoneSurrogate (SB1-4.9)", () => {
  test("whole text and pairs are not lone", () => {
    for (const text of ["", "abc", "\u{1F600}", "/p/\u{10FFFF}"]) expect(hasLoneSurrogate(text)).toBe(false);
  });

  test("a lone or reversed surrogate is", () => {
    for (const text of ["\uD800", "a\uDC00", "\uD83D", "\uDE00\uD83D", "x\uD83Dy"]) {
      expect(hasLoneSurrogate(text)).toBe(true);
    }
  });

  test("no J4 key holds one", () => {
    expect(j4Keyset().filter(hasLoneSurrogate)).toEqual([]);
  });
});
