/**
 * The k-way merge of per-shard answers and its exactness bound (SB1-7.5), and the choice of one answer among the shards
 * for a comparison get (SB1-7.6).
 *
 * The merge is checked against the sorted truth under adversarial interleavings: random partitions of the J4 keyset,
 * each shard cut at a random point, so a page that shows a key past a cut shard's last key, or skips one below it,
 * fails here under either order.
 */
import { describe, expect, test } from "bun:test";
import type { OxiaComparison, OxiaRecord, OxiaShard } from "@/lib/db/providers/keyvalue/oxia/client";
import {
  goPathEscape,
  mergePage,
  mergeRecords,
  type ShardAnswer,
  type ShardKeys,
  selectComparison,
} from "@/lib/db/providers/keyvalue/oxia/merge";
import { type KeyOrder, keyComparator } from "@/lib/db/providers/keyvalue/oxia/order";
import { j4Keyset, sortedKeys, splitByPosition } from "../../../helpers/oxia-keyset";

/** The keyset helper's generator, seeded 7, so every random case is the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const shard = (id: string): OxiaShard => ({
  id,
  minHash: 0,
  maxHash: 0,
  leader: { host: "h", port: 1, address: "h:1", bootstrap: true },
});
const ok = (key: string, secondaryIndexKey?: string): OxiaRecord => ({
  status: "OK",
  key,
  ...(secondaryIndexKey === undefined ? {} : { secondaryIndexKey }),
});
const miss: OxiaRecord = { status: "KEY_NOT_FOUND" };

type PageResult = ReturnType<typeof mergePage>;

/** What a page must be, computed from the sorted truth alone (`rank` is each key's position in it). */
function expectedPage(
  shards: readonly ShardKeys[],
  truth: readonly string[],
  rank: ReadonlyMap<string, number>,
  count: number,
): PageResult {
  const incomplete = shards.filter((s) => !s.complete);
  if (incomplete.some((s) => s.keys.length === 0)) return { stalled: true };
  const bounds = incomplete.map((s) => rank.get(s.keys.at(-1) as string) as number);
  const eligible = bounds.length === 0 ? truth : truth.slice(0, Math.min(...bounds) + 1);
  return { keys: eligible.slice(0, count), more: incomplete.length > 0 || eligible.length > count };
}

/** One adversarial run: each key of the truth to a random shard, each shard cut after a random number of its keys. */
function randomShards(truth: readonly string[], random: () => number): ShardKeys[] {
  const count = 1 + Math.floor(random() * 8);
  const lists: string[][] = Array.from({ length: count }, () => []);
  for (const key of truth) lists[Math.floor(random() * count)].push(key);
  return lists.map((keys) => {
    const cut = Math.floor(random() * (keys.length + 1));
    return { keys: keys.slice(0, cut), complete: cut === keys.length };
  });
}

const COUNTS = [1, 7, 50, 500];
const ORDERS: readonly KeyOrder[] = ["hierarchical", "natural"];

function rankOf(truth: readonly string[]): Map<string, number> {
  return new Map(truth.map((key, i) => [key, i]));
}

describe("mergePage (SB1-7.5)", () => {
  test("complete shards merge in the order's sequence", () => {
    const shards = [
      { keys: ["a", "c"], complete: true },
      { keys: ["b"], complete: true },
    ];
    expect(mergePage(shards, "natural", 10)).toEqual({ keys: ["a", "b", "c"], more: false });
    expect(mergePage(shards, "natural", 2)).toEqual({ keys: ["a", "b"], more: true });
  });

  test("an incomplete shard bounds the page at its last key", () => {
    const shards = [
      { keys: ["a", "d"], complete: false },
      { keys: ["b", "c", "e", "f"], complete: true },
    ];
    expect(mergePage(shards, "natural", 10)).toEqual({ keys: ["a", "b", "c", "d"], more: true });
  });

  test("the least last key of the incomplete shards is the bound", () => {
    const shards = [
      { keys: ["a", "m"], complete: false },
      { keys: ["b", "k"], complete: false },
      { keys: ["c", "l", "n"], complete: true },
    ];
    expect(mergePage(shards, "natural", 10)).toEqual({ keys: ["a", "b", "c", "k"], more: true });
  });

  test("an incomplete shard with no key stalls the page", () => {
    expect(
      mergePage(
        [
          { keys: [], complete: false },
          { keys: ["a"], complete: true },
        ],
        "natural",
        10,
      ),
    ).toEqual({ stalled: true });
    expect(
      mergePage(
        [
          { keys: [], complete: true },
          { keys: ["a"], complete: true },
        ],
        "natural",
        10,
      ),
    ).toEqual({ keys: ["a"], more: false });
  });

  test("a key listed twice by one shard is a defect", () => {
    expect(() => mergePage([{ keys: ["a", "a"], complete: true }], "natural", 10)).toThrow(
      new RangeError("A shard listed one key twice"),
    );
  });

  test("the order decides the sequence", () => {
    const shards = [
      { keys: ["/x"], complete: true },
      { keys: ["a"], complete: true },
    ];
    expect(mergePage(shards, "hierarchical", 10)).toEqual({ keys: ["a", "/x"], more: false });
    expect(mergePage(shards, "natural", 10)).toEqual({ keys: ["/x", "a"], more: false });
  });

  test("keys ending in // beside their U+0000 sibling", () => {
    const keys = ["/a/", "/a//", "/a//\u0000", "/a///", "/a/b", "/b"];
    let pages = 0;
    for (const order of ORDERS) {
      const truth = sortedKeys(keys, order);
      const rank = rankOf(truth);
      for (let mask = 0; mask < 2 ** truth.length; mask++) {
        const lists: [string[], string[]] = [[], []];
        truth.forEach((key, i) => {
          lists[(mask >> i) & 1].push(key);
        });
        for (let cut0 = 0; cut0 <= lists[0].length; cut0++) {
          for (let cut1 = 0; cut1 <= lists[1].length; cut1++) {
            const shards = [
              { keys: lists[0].slice(0, cut0), complete: cut0 === lists[0].length },
              { keys: lists[1].slice(0, cut1), complete: cut1 === lists[1].length },
            ];
            for (const count of [1, 3, 6]) {
              expect(mergePage(shards, order, count)).toEqual(expectedPage(shards, truth, rank, count));
              pages++;
            }
          }
        }
      }
    }
    expect(pages).toBeGreaterThan(1_000);
  });

  for (const order of ORDERS) {
    test(`adversarial interleavings, ${order}`, () => {
      const truth = sortedKeys(j4Keyset(), order);
      const rank = rankOf(truth);
      const random = rng(7);
      for (let run = 0; run < 500; run++) {
        const shards = randomShards(truth, random);
        const count = COUNTS[Math.floor(random() * COUNTS.length)];
        const result = mergePage(shards, order, count);
        expect(result).toEqual(expectedPage(shards, truth, rank, count));
        if ("keys" in result) expect(new Set(result.keys).size).toBe(result.keys.length);
      }
    });
  }

  test("many shards", () => {
    const shards = splitByPosition(j4Keyset(), 1_024, "hierarchical").map((keys) => ({ keys, complete: true }));
    expect(mergePage(shards, "hierarchical", 500)).toEqual({
      keys: sortedKeys(j4Keyset(), "hierarchical").slice(0, 500),
      more: true,
    });
  });
});

describe("mergeRecords (SB1-7.5, B-2)", () => {
  test("a shard cut by bytes beside a complete one ends at the cut shard's last key", () => {
    const cut = { records: [{ key: "k001" }, { key: "k003" }], complete: false };
    const whole = {
      records: Array.from({ length: 100 }, (_, i) => ({ key: `k${String(2 * i).padStart(3, "0")}` })),
      complete: true,
    };
    const result = mergeRecords([cut, whole], "natural", 50);
    expect(result).toEqual({
      records: [{ key: "k000" }, { key: "k001" }, { key: "k002" }, { key: "k003" }],
      more: true,
    });
  });

  for (const order of ORDERS) {
    test(`the same property as mergePage, over records, ${order}`, () => {
      const truth = sortedKeys(j4Keyset(), order);
      const rank = rankOf(truth);
      const random = rng(7);
      for (let run = 0; run < 100; run++) {
        const shards = randomShards(truth, random);
        const count = COUNTS[Math.floor(random() * COUNTS.length)];
        const wrapped = shards.map((s) => ({
          records: s.keys.map((key) => ({ key, value: key.length })),
          complete: s.complete,
        }));
        const result = mergeRecords(wrapped, order, count);
        const expected = expectedPage(shards, truth, rank, count);
        if ("stalled" in expected) {
          expect(result).toEqual({ stalled: true });
          continue;
        }
        if (!("records" in result)) throw new Error("the merge stalled where the truth does not");
        expect({ keys: result.records.map((record) => record.key), more: result.more }).toEqual({
          keys: [...expected.keys],
          more: expected.more,
        });
        const passed = new Map(wrapped.flatMap((s) => s.records).map((record) => [record.key, record]));
        for (const record of result.records) expect(record).toBe(passed.get(record.key) as (typeof result.records)[0]);
      }
    });
  }

  test("a stalled shard and a duplicate", () => {
    expect(
      mergeRecords(
        [
          { records: [], complete: false },
          { records: [{ key: "a" }], complete: true },
        ],
        "natural",
        10,
      ),
    ).toEqual({ stalled: true });
    expect(() => mergeRecords([{ records: [{ key: "a" }, { key: "a" }], complete: true }], "natural", 10)).toThrow(
      new RangeError("A shard listed one key twice"),
    );
  });
});

/** The comparison a server answers over a sorted key list (`undefined` for a miss). */
function modelComparison(sorted: readonly string[], key: string, comparison: OxiaComparison, order: KeyOrder) {
  const cmp = keyComparator(order);
  if (comparison === "FLOOR") return sorted.findLast((k) => cmp(k, key) <= 0);
  if (comparison === "LOWER") return sorted.findLast((k) => cmp(k, key) < 0);
  if (comparison === "CEILING") return sorted.find((k) => cmp(k, key) >= 0);
  return sorted.find((k) => cmp(k, key) > 0);
}

describe("selectComparison (SB1-7.6)", () => {
  test("without an index: the greatest for FLOOR and LOWER, the least for CEILING and HIGHER", () => {
    const slash = { shard: shard("1"), record: ok("/b") };
    const flat = { shard: shard("2"), record: ok("a") };
    const answers = [slash, flat, { shard: shard("3"), record: miss }];
    expect(selectComparison("FLOOR", answers, "hierarchical")).toBe(slash);
    expect(selectComparison("LOWER", answers, "hierarchical")).toBe(slash);
    expect(selectComparison("CEILING", answers, "hierarchical")).toBe(flat);
    expect(selectComparison("HIGHER", answers, "hierarchical")).toBe(flat);
    expect(selectComparison("FLOOR", answers, "natural")).toBe(flat);
    expect(selectComparison("CEILING", answers, "natural")).toBe(slash);
  });

  test("every shard missed is a miss, not an error", () => {
    const answers = [
      { shard: shard("1"), record: miss },
      { shard: shard("2"), record: miss },
    ];
    for (const comparison of ["FLOOR", "CEILING", "LOWER", "HIGHER"] as const) {
      expect(selectComparison(comparison, answers, "natural")).toBeUndefined();
    }
    for (const comparison of ["EQUAL", "FLOOR", "CEILING", "LOWER", "HIGHER"] as const) {
      expect(selectComparison(comparison, answers, "natural", "i")).toBeUndefined();
    }
  });

  test("an EQUAL get without an index is never selected across shards", () => {
    expect(() => selectComparison("EQUAL", [{ shard: shard("1"), record: ok("a") }], "natural")).toThrow(RangeError);
  });

  for (const order of ORDERS) {
    test(`the J4 comparison probes against the truth, ${order}`, () => {
      const truth = sortedKeys(j4Keyset(), order);
      const shards = splitByPosition(j4Keyset(), 3, order);
      const probes = [
        "/b/d",
        "/a/b/c/d",
        "/zz",
        "/a/b",
        "flat",
        "/a/b/c",
        "/",
        "zzzz",
        "/z/z/z/z/z/z/z/z",
        truth[0],
        truth.at(-1) as string,
        ...j4Keyset().filter((_, i) => i % 30 === 0),
      ];
      for (const probe of probes) {
        for (const comparison of ["FLOOR", "CEILING", "LOWER", "HIGHER"] as const) {
          const answers: ShardAnswer[] = shards.map((keys, i) => {
            const key = modelComparison(keys, probe, comparison, order);
            return { shard: shard(String(i)), record: key === undefined ? miss : ok(key) };
          });
          const selected = selectComparison(comparison, answers, order);
          expect({ probe, comparison, key: selected?.record.key }).toEqual({
            probe,
            comparison,
            key: modelComparison(truth, probe, comparison, order),
          });
        }
      }
    });
  }

  test("with an index: the same secondary key on two shards picks by the escaped primary key", () => {
    const slashed = { shard: shard("1"), record: ok("a/b", "s") };
    const dashed = { shard: shard("2"), record: ok("a-c", "s") };
    const answers = [slashed, dashed];
    expect(selectComparison("CEILING", answers, "natural", "i")).toBe(slashed);
    expect(selectComparison("EQUAL", answers, "natural", "i")).toBe(slashed);
    expect(selectComparison("FLOOR", answers, "natural", "i")).toBe(dashed);
  });

  test("with an index: the hierarchical encoder over the whole entry, not CompareWithSlash", () => {
    const z = { shard: shard("1"), record: ok("p1", "z") };
    const ab = { shard: shard("2"), record: ok("p2", "a/b") };
    expect(selectComparison("CEILING", [z, ab], "hierarchical", "i")).toBe(z);
    expect(selectComparison("FLOOR", [z, ab], "hierarchical", "i")).toBe(ab);
  });

  test("with an index under natural: the separator decides", () => {
    const plain = { shard: shard("1"), record: ok("p", "a") };
    const nul = { shard: shard("2"), record: ok("q", "a\u0000") };
    expect(selectComparison("CEILING", [plain, nul], "natural", "i")).toBe(nul);
  });

  test("an index answer without a secondary key is a defect", () => {
    expect(() => selectComparison("CEILING", [{ shard: shard("1"), record: ok("p") }], "natural", "i")).toThrow(
      new RangeError("An index answer carries no secondary key"),
    );
  });

  test("an OK answer without a key is a defect", () => {
    const keyless = { shard: shard("1"), record: { status: "OK" } as const };
    expect(() => selectComparison("CEILING", [keyless], "natural")).toThrow(
      new RangeError("An OK answer carries no key"),
    );
    const indexed = { shard: shard("1"), record: { status: "OK", secondaryIndexKey: "s" } as const };
    expect(() => selectComparison("CEILING", [indexed], "natural", "i")).toThrow(
      new RangeError("An OK answer carries no key"),
    );
  });
});

describe("goPathEscape (Go's url.PathEscape)", () => {
  test("Go's escapes", () => {
    const cases: readonly [string, string][] = [
      ["/", "%2F"],
      [";", "%3B"],
      [",", "%2C"],
      ["?", "%3F"],
      [" ", "%20"],
      ["ü", "%C3%BC"],
      ["$&+:=@", "$&+:=@"],
      ["AZaz09-_.~", "AZaz09-_.~"],
      ["%", "%25"],
      ["\u0000", "%00"],
      ["\u{1F600}", "%F0%9F%98%80"],
    ];
    for (const [text, escaped] of cases) expect(goPathEscape(text)).toBe(escaped);
  });
});
