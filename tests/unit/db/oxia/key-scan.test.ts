/**
 * The Keys panel over Oxia, on the shared fake (SB2-8.1, SB2-8.2, SB2-8.4): the declaration, each option refused
 * before any call, the three branches of a page, both cursor refusals of SB1-7.9, the first page's representatives
 * listed once, a capped discovery with no `skipped`, a prefix page with no discovery, no types and no total.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import type { OxiaCallOptions, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { OXIA_INTERNAL_KEY_SENTENCE } from "@/lib/db/providers/keyvalue/oxia/commands";
import {
  encodeOxiaCursor,
  OXIA_CURSOR_FOREIGN_REFUSAL,
  OXIA_CURSOR_ORDER_REFUSAL,
} from "@/lib/db/providers/keyvalue/oxia/cursor";
import {
  OXIA_CURSOR_KEY_TOO_LONG_SENTENCE,
  OXIA_KEY_SCAN,
  readOxiaKeyScanOptions,
  scanOxiaKeysPage,
} from "@/lib/db/providers/keyvalue/oxia/key-scan";
import type { KeyOrder, OrderVerdict } from "@/lib/db/providers/keyvalue/oxia/order";
import { discoverTopNodes, type OxiaSurface } from "@/lib/db/providers/keyvalue/oxia/walks";
import { createFakeOxiaClient, type FakeOxiaClient } from "../../../helpers/oxia-fake-client";
import { pulsarKeyset, sortedKeys } from "../../../helpers/oxia-keyset";

const call = (): OxiaCallOptions => ({ signal: new AbortController().signal, deadline: Date.now() + 10_000 });

function setup(keys: readonly string[], order: KeyOrder = "hierarchical") {
  const fake = createFakeOxiaClient({ order, records: keys.map((key) => ({ key })) });
  const verdict: OrderVerdict = { order, learnedBy: "ceiling-probe" };
  let snapshot: OxiaSnapshot | undefined;
  const surface: OxiaSurface = {
    client: fake,
    snapshot: async (options) => {
      snapshot ??= await fake.getSnapshot(options);
      return snapshot;
    },
    order: async () => verdict,
  };
  return { fake, surface };
}

const page = (surface: OxiaSurface, options: Partial<KeyScanOptions> = {}): Promise<KeyScanPage> =>
  scanOxiaKeysPage(surface, { cursor: "0", count: 500, ...options }, call());

/** Every page of a walk, followed by its cursor to "0". */
async function walkAll(surface: OxiaSurface, options: Partial<KeyScanOptions> = {}): Promise<KeyScanPage[]> {
  const pages: KeyScanPage[] = [];
  let cursor = "0";
  for (let round = 0; round < 10_000; round++) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the cursor the page before answered.
    const next = await page(surface, { ...options, cursor });
    pages.push(next);
    if (next.cursor === "0") return pages;
    cursor = next.cursor;
  }
  throw new Error("the walk did not end");
}

/**
 * Discovery's probes are CEILING, LOWER and HIGHER gets; a walk page's own Reads are EQUAL gets, and a hierarchical
 * prefix walk reads the depth with one FLOOR get per shard (SB1-7.7), which is no discovery.
 */
const discoveryProbes = (fake: FakeOxiaClient) =>
  fake.calls.filter(
    (entry) =>
      entry.rpc === "Read" && entry.gets?.some((get) => get.comparison !== "EQUAL" && get.comparison !== "FLOOR"),
  );

describe("OXIA_KEY_SCAN (SB2-8.1)", () => {
  test("etcd's counts, a / convention, an opaque cursor, a literal prefix and no total, frozen", () => {
    expect(OXIA_KEY_SCAN).toEqual({
      defaultCount: 500,
      maxCount: 1000,
      separator: "/",
      cursor: "opaque",
      pattern: "prefix",
      totalScope: "none",
    });
    expect(Object.isFrozen(OXIA_KEY_SCAN)).toBe(true);
  });
});

describe("the options, each refused before any call (SB2-8.2)", () => {
  test.each([0, 1001, 1.5, Number.NaN])("a count of %p", async (count) => {
    const { fake, surface } = setup(["/a"]);
    const scan = page(surface, { count });
    await expect(scan).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(scan).rejects.toThrow("A page holds 1 to 1,000 keys.");
    expect(fake.calls).toEqual([]);
  });

  test("a database", async () => {
    const { fake, surface } = setup(["/a"]);
    await expect(page(surface, { database: 0 })).rejects.toThrow(
      "An Oxia connection reads one namespace, so a page names no database.",
    );
    expect(fake.calls).toEqual([]);
  });

  test("a prefix under __oxia/", async () => {
    const { fake, surface } = setup(["/a"]);
    await expect(page(surface, { pattern: "__oxia/assignments" })).rejects.toThrow(OXIA_INTERNAL_KEY_SENTENCE);
    expect(fake.calls).toEqual([]);
  });

  test("a prefix holding a lone surrogate", async () => {
    const { fake, surface } = setup(["/a"]);
    await expect(page(surface, { pattern: "/a\ud800" })).rejects.toThrow(
      "The prefix holds a character that is not text, so it names no exact key: type it again.",
    );
    expect(fake.calls).toEqual([]);
  });

  test("a cursor this provider did not write", async () => {
    const { fake, surface } = setup(["/a"]);
    const scan = page(surface, { cursor: "k:L2FwcC9i:12:9" });
    await expect(scan).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(scan).rejects.toThrow(OXIA_CURSOR_FOREIGN_REFUSAL);
    expect(OXIA_CURSOR_FOREIGN_REFUSAL).toBe("This cursor was not written by the Oxia provider: start the walk again.");
    expect(fake.calls).toEqual([]);
  });

  test("readOxiaKeyScanOptions answers the cursor, the prefix and the count, an empty pattern as none", () => {
    expect(readOxiaKeyScanOptions({ cursor: "0", count: 5, pattern: "/a/" })).toEqual({
      cursor: "0",
      prefix: "/a/",
      count: 5,
    });
    expect(readOxiaKeyScanOptions({ cursor: "0", count: 5, pattern: "" })).toEqual({ cursor: "0", count: 5 });
    expect(readOxiaKeyScanOptions({ cursor: "0", count: 5 })).toEqual({ cursor: "0", count: 5 });
  });
});

describe("the cursor's order (SB1-7.9)", () => {
  test("a cursor cut under the other order is refused, after the order is read", async () => {
    const { surface } = setup(["/a", "/b"], "hierarchical");
    const scan = page(surface, { cursor: encodeOxiaCursor({ lastKey: "/a", order: "natural" }) });
    await expect(scan).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(scan).rejects.toThrow(OXIA_CURSOR_ORDER_REFUSAL);
    expect(OXIA_CURSOR_ORDER_REFUSAL).toBe(
      "This cursor was cut under the other key order than this namespace is now detected to have: start the walk again.",
    );
  });
});

describe("a key past the cursor bound (ruling R6)", () => {
  test("a page whose last key is 70,000 bytes, with a next page, is refused before a cursor is written", async () => {
    const long = `/a/${"x".repeat(70_000 - 3)}`;
    const { surface } = setup([long, "/b/1"]);
    const scan = page(surface, { pattern: "/", count: 1 });
    await expect(scan).rejects.toBeInstanceOf(QueryError);
    await expect(scan).rejects.toThrow(OXIA_CURSOR_KEY_TOO_LONG_SENTENCE);
    expect(OXIA_CURSOR_KEY_TOO_LONG_SENTENCE).toBe(
      "A key on this page is longer than 65,536 bytes, so the Keys panel cannot page past it; read the keys after it in the editor with list --key-min.",
    );
  });

  test("a last key of exactly 65,536 bytes is paged: its cursor is written and the next page reads past it", async () => {
    const bound = `/a/${"x".repeat(65_536 - 3)}`;
    const { surface } = setup([bound, "/b/1"]);
    const first = await page(surface, { pattern: "/", count: 1 });
    expect(first.keys).toEqual([bound]);
    expect(first.cursor).not.toBe("0");
    const second = await page(surface, { pattern: "/", count: 1, cursor: first.cursor });
    expect(second.keys).toEqual(["/b/1"]);
    expect(second.cursor).toBe("0");
  });

  test("the bound counts UTF-8 bytes: 33,000 two-byte characters are past it, though the text is shorter", async () => {
    const wide = `/a/${"\u00e9".repeat(33_000)}`;
    expect(wide.length).toBeLessThan(65_536);
    const { surface } = setup([wide, "/b/1"]);
    const scan = page(surface, { pattern: "/", count: 1 });
    await expect(scan).rejects.toBeInstanceOf(QueryError);
    await expect(scan).rejects.toThrow(OXIA_CURSOR_KEY_TOO_LONG_SENTENCE);
  });

  test("a last page whose last key is past the bound is answered: it writes no cursor", async () => {
    const long = `/b/${"x".repeat(70_000 - 3)}`;
    const { surface } = setup(["/a/1", long]);
    const last = await page(surface, { pattern: "/", count: 2 });
    expect(last.keys).toEqual(["/a/1", long]);
    expect(last.cursor).toBe("0");
  });
});

describe("the pages", () => {
  test("a page answers no types and no total, and no skipped", async () => {
    const { surface } = setup(["/a/1", "/b/1"]);
    const first = await page(surface);
    expect(first.types).toEqual({});
    expect(first.total).toBe(0);
    expect("skipped" in first).toBe(false);
    expect(first.cursor).toBe("0");
  });

  test("the first page lists each key once: a representative the walk also returns stays in the walk's part", async () => {
    const keys = ["/admin/a", "/admin/b", "/ledgers/1", "/managed/x/y"];
    const { surface } = setup(keys);
    const first = await page(surface);
    expect(new Set(first.keys).size).toBe(first.keys.length);
    expect([...first.keys].sort()).toEqual([...keys].sort());
  });

  test("the first page keeps the first count - 1 representatives in the order's encoder, then the walk's part", async () => {
    const keys = ["/a/b/c", "/z/1", "/m/x", "/q/r/s/t", "/b/1"];
    // Five top-level folders and a page of 4: three representatives are kept, the walk is asked for one key, and the
    // representative it returns stays only in the walk's part.
    const hierarchical = await page(setup(keys, "hierarchical").surface, { count: 4 });
    expect(hierarchical.keys).toEqual(["/m/x", "/z/1", "/b/1"]);
    expect(hierarchical.cursor).not.toBe("0");
    const natural = await page(setup(keys, "natural").surface, { count: 4 });
    expect(natural.keys).toEqual(["/b/1", "/m/x", "/a/b/c"]);
    expect(natural.cursor).not.toBe("0");
  });

  test("a page never holds more than count keys, the first one included, and the walk reaches every key", async () => {
    const keys = pulsarKeyset(40);
    const orders: readonly KeyOrder[] = ["hierarchical", "natural"];
    const walks = await Promise.all(orders.map((order) => walkAll(setup(keys, order).surface, { count: 7 })));
    for (const pages of walks) {
      for (const each of pages) expect(each.keys.length).toBeLessThanOrEqual(7);
      // A representative may come back on a later page (SB2-8.2's residual); the keys held are each key once.
      expect(new Set(pages.flatMap((each) => each.keys))).toEqual(new Set(keys));
    }
  });

  test("a later page resumes the walk alone, from the cursor, with no discovery", async () => {
    const keys = Array.from({ length: 30 }, (_, index) => `/k/${String(index).padStart(2, "0")}`);
    const { fake, surface } = setup(keys);
    const first = await page(surface, { count: 10 });
    expect(first.cursor).not.toBe("0");
    const probesBefore = discoveryProbes(fake).length;
    const second = await page(surface, { count: 10, cursor: first.cursor });
    expect(discoveryProbes(fake).length).toBe(probesBefore);
    // The cursor resumes after the first page's last key: no key of the first page comes again.
    expect(second.keys.some((key) => first.keys.includes(key))).toBe(false);
  });

  test("a prefix page walks the prefix alone, with no discovery, and resumes from its cursor", async () => {
    const keys = ["/a/1", "/a/2", "/a/b/3", "/b/1", "/c/1"];
    const { fake, surface } = setup(keys);
    const pages = await walkAll(surface, { pattern: "/a/", count: 2 });
    expect(discoveryProbes(fake)).toEqual([]);
    expect(new Set(pages.flatMap((each) => each.keys))).toEqual(new Set(["/a/1", "/a/2", "/a/b/3"]));
    expect(pages.flatMap((each) => each.keys)).toEqual([...sortedKeys(["/a/1", "/a/2", "/a/b/3"], "hierarchical")]);
  });

  test("a capped discovery answers with no skipped, and the walk still reaches every key", async () => {
    // More top-level nodes than discovery's 256 rounds reach.
    const keys = Array.from({ length: 300 }, (_, index) => `/n${String(index).padStart(3, "0")}/x`);
    const { fake, surface } = setup(keys);
    const discovered = await discoverTopNodes(fake, await surface.snapshot(call()), "hierarchical", call());
    expect(discovered.complete).toBe(false);
    const pages = await walkAll(surface, { count: 500 });
    for (const each of pages) expect("skipped" in each).toBe(false);
    expect(new Set(pages.flatMap((each) => each.keys))).toEqual(new Set(keys));
  });
});
