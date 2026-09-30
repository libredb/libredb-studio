/**
 * Keys and byte ranges (spec 4.1, 4.3, 5.5, E8, E9).
 *
 * The prefix-group rule is tested over sets of keys, then the walk's pure step is driven page by
 * page and held to the set function as its oracle, for every page size up to the whole set and for
 * seeded page sizes, so the walk and the rule cannot disagree (R13 A1, D8, D9).
 */
import { describe, expect, test } from "bun:test";
import type { EtcdByteRange, EtcdBytes } from "@/lib/db/providers/keyvalue/etcd/client";
import {
  ALL_KEYS,
  commandRange,
  compareBytes,
  decodeUtf8,
  encodeKey,
  fromHexId,
  groupLabel,
  hasBytePrefix,
  INITIAL_PREFIX_WALK,
  isSecretKey,
  isUnderProtectedPrefix,
  keySpan,
  leaseHexId,
  memberHexId,
  type PrefixGroup,
  type PrefixWalkState,
  PROTECTED_KEYS,
  PROTECTED_PREFIXES,
  prefixGroups,
  prefixRangeEnd,
  prefixWalkResult,
  protectedHit,
  rangesIntersect,
  SECRET_ROOTS,
  spanIsEmpty,
  spanToRange,
  stepPrefixWalk,
  typedKey,
} from "@/lib/db/providers/keyvalue/etcd/keys";

const utf8 = (text: string): EtcdBytes => new TextEncoder().encode(text);
/** A key from text and raw bytes, in order: `key("/bin/", [0xff, 0xfe], "/x")`. */
const key = (...parts: ReadonlyArray<string | readonly number[]>): EtcdBytes =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? Array.from(utf8(part)) : Array.from(part))));
const hex = (bytes: EtcdBytes | undefined): string | undefined =>
  bytes === undefined ? undefined : Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
/** A key as a test names it: its text, or its bytes in hex when it is not UTF-8. */
const named = (bytes: EtcdBytes): string => decodeUtf8(bytes) ?? `hex:${hex(bytes)}`;
const prefixOf = (text: string): EtcdByteRange => ({ key: utf8(text), rangeEnd: prefixRangeEnd(utf8(text)) });
const point = (text: string): EtcdByteRange => ({ key: utf8(text) });
const range = (from: string, to: string): EtcdByteRange => ({ key: utf8(from), rangeEnd: utf8(to) });
const fromKey = (text: string): EtcdByteRange => ({ key: utf8(text), rangeEnd: Uint8Array.of(0) });

/** A group as a test compares it: its prefix, its range in hex, and whether it is undecided. */
const shapeOf = (groups: readonly PrefixGroup[]) =>
  groups.map((group) => ({
    prefix: group.prefix,
    key: hex(group.range.key),
    end: hex(group.range.rangeEnd),
    undecided: group.undecided === true,
  }));

/** Mulberry32: the same page sizes and shuffles on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_other, position) => position !== index)).map((rest) => [item].concat(rest)),
  );
}

const sortedUnique = (keys: readonly EtcdBytes[]): EtcdBytes[] =>
  [...keys].sort(compareBytes).filter((each, index, all) => index === 0 || compareBytes(all[index - 1], each) !== 0);

/**
 * Drives the walk over one sorted key space as the provider's driver does: each page holds the keys
 * from the cursor, `size(page)` of them, and says whether more follow; the cursor moves to the step's
 * `next`. With `stopAfter`, the walk stops once it has read that many keys, as the bound S stops it.
 */
function walk(
  keys: readonly EtcdBytes[],
  size: (page: number) => number,
  segmentBudget: number,
  stopAfter?: number,
): { readonly groups: readonly PrefixGroup[]; readonly state: PrefixWalkState; readonly pages: number } {
  const space = sortedUnique(keys);
  let state = INITIAL_PREFIX_WALK;
  let cursor: EtcdBytes = Uint8Array.of(0);
  for (let pages = 0; ; pages++) {
    const from = space.findIndex((each) => compareBytes(each, cursor) >= 0);
    const start = from < 0 ? space.length : from;
    const held = space.slice(start, start + size(pages));
    const step = stepPrefixWalk(state, { keys: held, more: start + held.length < space.length }, { segmentBudget });
    state = step.state;
    if (step.next === undefined) return { groups: prefixWalkResult(state, true), state, pages: pages + 1 };
    if (stopAfter !== undefined && state.keysRead >= stopAfter) {
      return { groups: prefixWalkResult(state, false), state, pages: pages + 1 };
    }
    cursor = step.next;
  }
}

// ----------------------------------------------------------------------------
// The fixtures of spec 4.1 and Review Focus 1
// ----------------------------------------------------------------------------

/** Spec 4.1's table, every row. */
const TABLE_KEYS = [
  "/registry/pods/default/nginx",
  "/apisix/routes/1",
  "/apisix/plugins",
  "/service/batman/leader",
  "/config/a",
  "/config/b",
  "/app/cfg",
  "/app/x/y",
  "config/app/x",
  "/feature-flag",
  "plain",
  "compact_rev_key",
].map(utf8);

const SET_OF_FIVE = ["/registry/health", "/registry/pods/default/nginx", "/app/a/x", "/app/b", "/feature-flag"].map(
  utf8,
);
const CILIUM = ["cilium/.heartbeat", "cilium/.initlock/r/1", "cilium/state/nodes/v1/c/n"].map(utf8);
const APISIX = ["/apisix/consumers/jack", "/apisix/plugins", "/apisix/routes/1"].map(utf8);
/** Every arm of rule 7 (R13 D8), as spec 9 seeds it. */
const RULE_SEVEN = [
  key("/values/a"),
  key("/values/", [0xff]),
  key("/bin/ok/x"),
  key("/bin/", [0xff, 0xfe], "/x"),
  key("/", [0xff, 0xfe], "/x"),
];
/** Review Focus 1: keys whose bytes or shape strain the path model. */
const STRAIN = [
  "/a//b",
  "/app/",
  "/",
  "/cfg/a b",
  '/q/"x"/y',
  "/n/a\nb/c",
  "-lead/x",
  "/h/#x/y",
  "/d/$x/y",
  "/s/it's/z",
].map(utf8);
const FIXTURES: ReadonlyArray<readonly [string, readonly EtcdBytes[]]> = [
  ["the table of 4.1", TABLE_KEYS],
  ["the set of five", SET_OF_FIVE],
  ["Cilium's keys", CILIUM],
  ["APISIX's keys", APISIX],
  ["rule 7's keys", RULE_SEVEN],
  ["Review Focus 1's keys", STRAIN],
];

// ----------------------------------------------------------------------------
// Bytes and text
// ----------------------------------------------------------------------------

describe("bytes and text", () => {
  test("encodeKey is UTF-8 and decodeUtf8 reads it back, a leading U+FEFF kept", () => {
    expect(hex(encodeKey("/é"))).toBe("2fc3a9");
    expect(decodeUtf8(encodeKey("\uFEFF/a"))).toBe("\uFEFF/a");
    expect(decodeUtf8(encodeKey("\u{1D11E}"))).toBe("\u{1D11E}");
  });

  test("decodeUtf8 answers undefined for bytes that are not UTF-8, never a replacement character", () => {
    expect(decodeUtf8(Uint8Array.of(0x2f, 0xff, 0xfe))).toBeUndefined();
    expect(decodeUtf8(Uint8Array.of(0xc3))).toBeUndefined();
  });

  test("encodeKey writes a lone surrogate as U+FFFD, which the round trip through decodeUtf8 shows", () => {
    expect(hex(encodeKey("/a\uD800"))).toBe("2f61efbfbd");
    expect(decodeUtf8(encodeKey("/a\uD800"))).not.toBe("/a\uD800");
    expect(decodeUtf8(encodeKey("/a\u{1D11E}"))).toBe("/a\u{1D11E}");
  });

  test("compareBytes is etcd's byte order: a shorter prefix first, 0 for equal bytes", () => {
    expect(compareBytes(utf8("/a"), utf8("/a/"))).toBeLessThan(0);
    expect(compareBytes(utf8("/b"), utf8("/a/z"))).toBeGreaterThan(0);
    expect(compareBytes(Uint8Array.of(0x7f), Uint8Array.of(0x80))).toBeLessThan(0);
    expect(compareBytes(utf8("/a"), utf8("/a"))).toBe(0);
    expect(compareBytes(new Uint8Array(), Uint8Array.of(0))).toBeLessThan(0);
  });

  test("hasBytePrefix compares every byte of the prefix", () => {
    expect(hasBytePrefix(utf8("/registry/x"), utf8("/registry/"))).toBe(true);
    expect(hasBytePrefix(utf8("/registry"), utf8("/registry/"))).toBe(false);
    expect(hasBytePrefix(utf8("/registrx/"), utf8("/registry/"))).toBe(false);
    expect(hasBytePrefix(utf8("anything"), new Uint8Array())).toBe(true);
  });
});

describe("typedKey (spec 5.5)", () => {
  test.each([
    ["/App/", "/App/"],
    [" a", "' a'"],
    [" ", "' '"],
    ["it's", "'it'\\''s'"],
    ["-a", "-a"],
    ["a#b$c", "'a#b$c'"],
  ])("on the command line %j is typed as %s, bare when a bare word reads back as the same bytes", (text, typed) => {
    expect(typedKey(utf8(text), "command-line")).toBe(typed);
  });

  test.each([
    ["/App/", "/App/"],
    [" a", '" a"'],
    ["it's", `"it's"`],
    ['a"b', '"a\\"b"'],
    ["-a", "-a"],
  ])("in a txn body %j is typed as %s, Go-quoted when it is not bare", (text, typed) => {
    expect(typedKey(utf8(text), "txn")).toBe(typed);
  });

  test("a key holding a control character is typed in Go %q quoting under either rule", () => {
    for (const quoting of ["command-line", "txn"] as const) {
      expect(typedKey(utf8("/a\nb/"), quoting)).toBe('"/a\\nb/"');
      expect(typedKey(utf8("a\r"), quoting)).toBe('"a\\r"');
      expect(typedKey(Uint8Array.of(0x61, 0x00, 0x62), quoting)).toBe('"a\\x00b"');
      expect(typedKey(utf8("a\u007f"), quoting)).toBe('"a\\x7f"');
      expect(typedKey(utf8("a\u0085"), quoting)).toBe('"a\\u0085"');
    }
  });

  test("the control characters are C0, DEL and C1 exactly, and the characters beside them keep the rule's quoting", () => {
    for (const quoting of ["command-line", "txn"] as const) {
      expect(typedKey(utf8("a\u001f"), quoting)).toBe('"a\\x1f"');
      expect(typedKey(utf8("a\u0080"), quoting)).toBe('"a\\u0080"');
      expect(typedKey(utf8("a\u009f"), quoting)).toBe('"a\\u009f"');
    }
    expect(typedKey(utf8("a~"), "command-line")).toBe("'a~'");
    expect(typedKey(utf8("a\u00a0"), "command-line")).toBe("'a\u00a0'");
  });

  test("a key that is not UTF-8 is typed in Go %q quoting, each byte past ASCII as \\xNN", () => {
    expect(typedKey(key("/", [0xff, 0xfe], "/"), "command-line")).toBe('"/\\xff\\xfe/"');
    expect(typedKey(key("/", [0xff, 0xfe], "/"), "txn")).toBe('"/\\xff\\xfe/"');
  });
});

// ----------------------------------------------------------------------------
// Ranges
// ----------------------------------------------------------------------------

describe("ranges (spec E8, R06 2.3)", () => {
  test("prefixRangeEnd raises the last byte below 0xff, and answers 0x00 when there is none", () => {
    expect(named(prefixRangeEnd(utf8("/app/")))).toBe("/app0");
    expect(hex(prefixRangeEnd(key("a", [0xff])))).toBe("62");
    expect(hex(prefixRangeEnd(Uint8Array.of(0xff, 0xff)))).toBe("00");
    expect(hex(prefixRangeEnd(new Uint8Array()))).toBe("00");
  });

  test("prefixRangeEnd leaves its argument as it was", () => {
    const prefix = utf8("/a/");
    prefixRangeEnd(prefix);
    expect(named(prefix)).toBe("/a/");
  });

  test("commandRange: the key alone, a range end, --prefix, --from-key, and the whole key space", () => {
    const shape = (spec: Parameters<typeof commandRange>[0]) => {
      const answer = commandRange(spec);
      return [hex(answer.key), hex(answer.rangeEnd)];
    };
    expect(shape({ key: utf8("/a"), prefix: false, fromKey: false })).toEqual(["2f61", undefined]);
    expect(shape({ key: utf8("/a"), rangeEnd: utf8("/b"), prefix: false, fromKey: false })).toEqual(["2f61", "2f62"]);
    expect(shape({ key: utf8("/a/"), prefix: true, fromKey: false })).toEqual(["2f612f", "2f6130"]);
    expect(shape({ key: utf8("/a"), prefix: false, fromKey: true })).toEqual(["2f61", "00"]);
    expect(shape({ key: new Uint8Array(), prefix: true, fromKey: false })).toEqual(["00", "00"]);
    expect(shape({ key: new Uint8Array(), prefix: false, fromKey: true })).toEqual(["00", "00"]);
    expect(shape({ key: Uint8Array.of(0xff), prefix: true, fromKey: false })).toEqual(["ff", "00"]);
  });

  test("ALL_KEYS is the key 0x00 with the range end 0x00, and the object is frozen", () => {
    expect([hex(ALL_KEYS.key), hex(ALL_KEYS.rangeEnd)]).toEqual(["00", "00"]);
    expect(Object.isFrozen(ALL_KEYS)).toBe(true);
    expect(commandRange({ key: new Uint8Array(), prefix: true, fromKey: false }).key).not.toBe(ALL_KEYS.key);
  });

  test("keySpan reads a missing or empty range end as the one key and 0x00 as an open end", () => {
    const span = (range: EtcdByteRange) => {
      const answer = keySpan(range);
      return [hex(answer.begin), hex(answer.end)];
    };
    expect(span(point("/a"))).toEqual(["2f61", "2f6100"]);
    expect(span({ key: utf8("/a"), rangeEnd: new Uint8Array() })).toEqual(["2f61", "2f6100"]);
    expect(span(fromKey("/a"))).toEqual(["2f61", undefined]);
    expect(span(range("/a", "/b"))).toEqual(["2f61", "2f62"]);
    // Only the single byte 0x00 is the open end: a longer end that begins with it is an ordinary end.
    expect(span({ key: utf8("/a"), rangeEnd: Uint8Array.of(0, 1) })).toEqual(["2f61", "0001"]);
  });

  test("spanToRange writes an interval back in its plainest spelling", () => {
    const back = (range: EtcdByteRange) => {
      const answer = spanToRange(keySpan(range));
      return [hex(answer.key), hex(answer.rangeEnd)];
    };
    expect(back(point("/a"))).toEqual(["2f61", undefined]);
    expect(back({ key: utf8("/a"), rangeEnd: key("/a", [0]) })).toEqual(["2f61", undefined]);
    expect(back(fromKey("/a"))).toEqual(["2f61", "00"]);
    expect(back(range("/a", "/b"))).toEqual(["2f61", "2f62"]);
    expect(back(ALL_KEYS)).toEqual(["00", "00"]);
  });

  test("spanIsEmpty: a range end at or before its key holds no key", () => {
    expect(spanIsEmpty(keySpan(range("/b", "/a")))).toBe(true);
    expect(spanIsEmpty(keySpan(range("/a", "/a")))).toBe(true);
    expect(spanIsEmpty(keySpan(range("/a", "/b")))).toBe(false);
    expect(spanIsEmpty(keySpan(fromKey("/z")))).toBe(false);
  });

  test.each([
    ["a key and the prefix it lies under", point("/app/x"), prefixOf("/app/"), true],
    ["a key and a prefix it does not lie under", point("/apple"), prefixOf("/app/"), false],
    ["a range that ends inside a prefix", range("/a", "/app/b"), prefixOf("/app/"), true],
    ["a range from before a prefix to after it", range("/a", "/z"), prefixOf("/app/"), true],
    ["a range that ends where a prefix begins", range("/a", "/app/"), prefixOf("/app/"), false],
    ["a range that begins where a prefix ends", range("/app0", "/z"), prefixOf("/app/"), false],
    ["a from-key range from before a prefix", fromKey("/a"), prefixOf("/app/"), true],
    ["a from-key range from after a prefix", fromKey("/b"), prefixOf("/app/"), false],
    ["the whole key space and any key", ALL_KEYS, point("plain"), true],
    ["two open ends", fromKey("/a"), fromKey("/z"), true],
    ["the one key and itself", point("/a"), point("/a"), true],
    ["the one key and a key it prefixes", point("/a"), point("/a0"), false],
    ["a range that holds no key", range("/z", "/a"), ALL_KEYS, false],
  ])("rangesIntersect: %s", (_label, a, b, meets) => {
    expect(rangesIntersect(a, b)).toBe(meets);
    expect(rangesIntersect(b, a)).toBe(meets);
  });
});

// ----------------------------------------------------------------------------
// The protected set and the secrets roots
// ----------------------------------------------------------------------------

describe("the protected set (spec E8)", () => {
  test("holds every storage root with and without its leading /, rke2/ as the inferred root, and one exact key", () => {
    expect(PROTECTED_PREFIXES).toEqual([
      "/registry/",
      "registry/",
      "/kubernetes.io/",
      "kubernetes.io/",
      "/openshift.io/",
      "openshift.io/",
      "/bootstrap/",
      "bootstrap/",
      "/k3s/",
      "k3s/",
      "/rke2/",
      "rke2/",
    ]);
    expect(PROTECTED_KEYS).toEqual(["compact_rev_key"]);
    expect(Object.isFrozen(PROTECTED_PREFIXES) && Object.isFrozen(PROTECTED_KEYS)).toBe(true);
  });

  test.each([
    ["the exact key", point("/registry/pods/default/nginx"), "prefix", "/registry/"],
    ["a range ending inside the prefix", range("/reg", "/registry/x"), "prefix", "/registry/"],
    ["a range from before the prefix to after it", range("/a", "/z"), "prefix", "/registry/"],
    ["--prefix of the parent /", prefixOf("/"), "prefix", "/registry/"],
    ["--prefix of the parent /reg", prefixOf("/reg"), "prefix", "/registry/"],
    ["--from-key from a smaller key", fromKey("/a"), "prefix", "/registry/"],
    ["the whole key space", ALL_KEYS, "prefix", "/registry/"],
    ["a slash-less Kubernetes root", point("registry/secrets/default/token"), "prefix", "registry/"],
    ["OpenShift's root", prefixOf("/kubernetes.io/secrets/"), "prefix", "/kubernetes.io/"],
    ["OpenShift's own root", point("openshift.io/oauth/x"), "prefix", "openshift.io/"],
    ["k3s's bootstrap key", point("/bootstrap/9f8b1c"), "prefix", "/bootstrap/"],
    ["k3s's root", point("k3s/apiaddresses"), "prefix", "k3s/"],
    ["RKE2's root", point("rke2/etcd/learnerProgress"), "prefix", "rke2/"],
    ["compact_rev_key itself", point("compact_rev_key"), "key", "compact_rev_key"],
    ["del c d", range("c", "d"), "key", "compact_rev_key"],
    ["del compact --prefix", prefixOf("compact"), "key", "compact_rev_key"],
    ["del a d, which a slash-less root refuses first", range("a", "d"), "prefix", "bootstrap/"],
    ["del c --from-key, which a slash-less root refuses first", fromKey("c"), "prefix", "registry/"],
  ])("protectedHit refuses %s", (_label, written, kind, name) => {
    expect(protectedHit(written)).toEqual({ kind: kind as "prefix" | "key", name });
  });

  test.each([
    ["a key beside the prefixes", point("/app/config")],
    ["a custom prefix", prefixOf("/tenant-a/")],
    ["the root key /registry, which is not under /registry/", point("/registry")],
    ["a key that extends compact_rev_key", point("compact_rev_key2")],
    ["a range between the roots", range("/c", "/k")],
  ])("protectedHit passes %s", (_label, written) => {
    expect(protectedHit(written)).toBeUndefined();
  });

  test("del / --prefix does not reach the slash-less roots that the whole key space reaches (R11 ETCD-6)", () => {
    for (const root of ["registry/", "kubernetes.io/", "openshift.io/", "bootstrap/", "k3s/", "rke2/"]) {
      expect(rangesIntersect(prefixOf("/"), prefixOf(root))).toBe(false);
      expect(rangesIntersect(ALL_KEYS, prefixOf(root))).toBe(true);
    }
  });

  test("isUnderProtectedPrefix reads the prefixes, and the one exact key is not a prefix", () => {
    expect(isUnderProtectedPrefix(utf8("/registry/pods/x"))).toBe(true);
    expect(isUnderProtectedPrefix(utf8("rke2/x"))).toBe(true);
    expect(isUnderProtectedPrefix(utf8("/k3s/x"))).toBe(true);
    expect(isUnderProtectedPrefix(utf8("/app/x"))).toBe(false);
    expect(isUnderProtectedPrefix(utf8("compact_rev_key"))).toBe(false);
  });
});

describe("the secrets roots (spec E9 row 1)", () => {
  test("are the Kubernetes secrets roots and k3s's bootstrap root, each with and without its leading /", () => {
    expect(SECRET_ROOTS).toEqual([
      "/registry/secrets/",
      "registry/secrets/",
      "/kubernetes.io/secrets/",
      "kubernetes.io/secrets/",
      "/bootstrap/",
      "bootstrap/",
    ]);
  });

  test.each([
    ["/registry/secrets/default/token", true],
    ["registry/secrets/default/token", true],
    ["/kubernetes.io/secrets/ns/s", true],
    ["kubernetes.io/secrets/ns/s", true],
    ["/bootstrap/9f8b1c", true],
    ["bootstrap/9f8b1c", true],
    ["/registry/secretsx/a", false],
    ["/registry/pods/default/nginx", false],
    ["/app/secrets/x", false],
  ])("isSecretKey(%j) is %p", (text, secret) => {
    expect(isSecretKey(utf8(text))).toBe(secret);
  });
});

// ----------------------------------------------------------------------------
// The prefix-group rule (spec 4.1)
// ----------------------------------------------------------------------------

describe("prefixGroups (spec 4.1, R13 A1)", () => {
  test.each([
    [["/registry/pods/default/nginx"], ["/registry/pods/"], []],
    [["/apisix/routes/1", "/apisix/plugins"], ["/apisix/routes/"], ["/apisix/plugins"]],
    [["/service/batman/leader"], ["/service/batman/"], []],
    [["/config/a", "/config/b"], ["/config/"], []],
    [["/app/cfg", "/app/x/y"], ["/app/x/"], ["/app/cfg"]],
    [["config/app/x"], ["config/app/"], []],
    [["/feature-flag", "plain", "compact_rev_key"], [], ["/feature-flag", "compact_rev_key", "plain"]],
  ])("the table row %j gives the groups %j", (keys, prefixes, ungrouped) => {
    const answer = prefixGroups(keys.map(utf8));
    expect(answer.groups.map((group) => group.prefix)).toEqual(prefixes);
    expect(answer.ungrouped.map(named)).toEqual(ungrouped);
  });

  test("the whole table, grouped at once", () => {
    const answer = prefixGroups(TABLE_KEYS);
    expect(answer.groups.map(groupLabel)).toEqual([
      "/apisix/routes/*",
      "/app/x/*",
      "/config/*",
      "/registry/pods/*",
      "/service/batman/*",
      "config/app/*",
    ]);
    expect(answer.ungrouped.map(named)).toEqual([
      "/apisix/plugins",
      "/app/cfg",
      "/feature-flag",
      "compact_rev_key",
      "plain",
    ]);
  });

  test("a group's range is the prefix range of its prefix, and it is never marked undecided", () => {
    expect(shapeOf(prefixGroups([utf8("/config/a")]).groups)).toEqual([
      { prefix: "/config/", key: "2f636f6e6669672f", end: "2f636f6e66696730", undecided: false },
    ]);
  });

  test("the set of five yields /app/a/* and /registry/pods/*, and leaves the other three in no group", () => {
    const answer = prefixGroups(SET_OF_FIVE);
    expect(answer.groups.map(groupLabel)).toEqual(["/app/a/*", "/registry/pods/*"]);
    expect(answer.ungrouped.map(named)).toEqual(["/app/b", "/feature-flag", "/registry/health"]);
  });

  test("Cilium's and APISIX's sets each find every group their deeper keys make", () => {
    expect(prefixGroups(CILIUM).groups.map(groupLabel)).toEqual(["cilium/.initlock/*", "cilium/state/*"]);
    expect(prefixGroups(CILIUM).ungrouped.map(named)).toEqual(["cilium/.heartbeat"]);
    expect(prefixGroups(APISIX).groups.map(groupLabel)).toEqual(["/apisix/consumers/*", "/apisix/routes/*"]);
    expect(prefixGroups(APISIX).ungrouped.map(named)).toEqual(["/apisix/plugins"]);
  });

  test("rule 7: a flat F keeps a key whose second segment is not UTF-8, a deep F and a first segment that is not UTF-8 do not", () => {
    const answer = prefixGroups(RULE_SEVEN);
    expect(answer.groups.map(groupLabel)).toEqual(["/bin/ok/*", "/values/*"]);
    expect(answer.ungrouped.map(named)).toEqual(["hex:2f62696e2ffffe2f78", "hex:2ffffe2f78"]);
    const values = answer.groups[1];
    expect(rangesIntersect(values.range, point("/values/"))).toBe(true);
    expect(RULE_SEVEN.filter((each) => rangesIntersect({ key: each }, values.range)).map(named)).toEqual([
      "/values/a",
      "hex:2f76616c7565732fff",
    ]);
  });

  test("rule 7: a deep key whose second segment is not UTF-8 still makes its first segment deep", () => {
    const answer = prefixGroups([key("/bin/", [0xff, 0xfe], "/x"), utf8("/bin/flat")]);
    expect(answer.groups).toEqual([]);
    expect(answer.ungrouped.map(named)).toEqual(["/bin/flat", "hex:2f62696e2ffffe2f78"]);
  });

  test("Review Focus 1: an empty segment, a trailing /, / alone and keys holding a space, quotes, a newline, #, $ or a leading -", () => {
    const answer = prefixGroups(STRAIN);
    expect(answer.groups.map((group) => group.prefix)).toEqual([
      "-lead/",
      "/a//",
      "/app/",
      "/cfg/",
      "/d/$x/",
      "/h/#x/",
      "/n/a\nb/",
      '/q/"x"/',
      "/s/it's/",
    ]);
    expect(answer.ungrouped.map(named)).toEqual(["/"]);
    const app = answer.groups[2];
    expect(rangesIntersect(app.range, point("/app/"))).toBe(true);
  });

  test("keys given twice count once", () => {
    const answer = prefixGroups([utf8("/app/cfg"), utf8("/app/cfg"), utf8("/app/x/y")]);
    expect(answer.ungrouped.map(named)).toEqual(["/app/cfg"]);
  });

  test.each(FIXTURES)("%s: every key lies in at most one group, and no group name equals a key", (_label, keys) => {
    const { groups } = prefixGroups(keys);
    for (const each of keys) {
      expect(groups.filter((group) => rangesIntersect({ key: each }, group.range)).length).toBeLessThanOrEqual(1);
    }
    const texts = new Set(keys.map(named));
    for (const group of groups) expect(texts.has(groupLabel(group))).toBe(false);
  });

  test("the set of five and APISIX's set give one answer in every insertion order", () => {
    for (const keys of [SET_OF_FIVE, [...APISIX, ...CILIUM]]) {
      const expected = shapeOf(prefixGroups(keys).groups);
      for (const order of permutations(keys)) expect(shapeOf(prefixGroups(order).groups)).toEqual(expected);
    }
  });

  test("the table and every fixture give one answer in 500 seeded insertion orders", () => {
    const random = seeded(4101);
    const all = FIXTURES.flatMap(([, keys]) => keys);
    const expected = prefixGroups(all);
    for (let run = 0; run < 500; run++) {
      const answer = prefixGroups(shuffled(all, random));
      expect(shapeOf(answer.groups)).toEqual(shapeOf(expected.groups));
      expect(answer.ungrouped.map(hex)).toEqual(expected.ungrouped.map(hex));
    }
  });
});

// ----------------------------------------------------------------------------
// The walk's pure step (spec 4.3), held to prefixGroups
// ----------------------------------------------------------------------------

/** The first segment's prefix, `F/`, of a key with two segments or more, written without keys.ts. */
function firstPrefix(bytes: EtcdBytes): EtcdBytes | undefined {
  const slash = bytes.indexOf(0x2f, bytes[0] === 0x2f ? 1 : 0);
  return slash < 0 ? undefined : bytes.subarray(0, slash + 1);
}

/**
 * What the walk must answer under a per-segment budget: for each first segment, `F/*` undecided
 * when it holds at least `budget` keys and the first `budget` of them in byte order all have two
 * segments, else what the set function answers for its keys.
 */
function expectedUnderBudget(keys: readonly EtcdBytes[], budget: number): readonly PrefixGroup[] {
  const bySegment = new Map<string, EtcdBytes[]>();
  for (const each of sortedUnique(keys)) {
    const first = firstPrefix(each);
    if (first === undefined || decodeUtf8(first) === undefined) continue;
    const id = hex(first) as string;
    bySegment.set(id, [...(bySegment.get(id) ?? []), each]);
  }
  const groups: PrefixGroup[] = [];
  for (const members of bySegment.values()) {
    const first = firstPrefix(members[0]) as EtcdBytes;
    const flatHead = members.slice(0, budget).every((each) => each.indexOf(0x2f, first.length) < 0);
    if (members.length >= budget && flatHead) {
      groups.push({
        prefix: decodeUtf8(first) as string,
        range: { key: first, rangeEnd: prefixRangeEnd(first) },
        undecided: true,
      });
    } else {
      groups.push(...prefixGroups(members).groups);
    }
  }
  return groups.sort((a, b) => compareBytes(a.range.key, b.range.key));
}

describe("stepPrefixWalk against prefixGroups (spec 4.3, R13 A1)", () => {
  test.each(FIXTURES)("%s: every page size up to the whole set answers the set function's groups", (_label, keys) => {
    const expected = shapeOf(prefixGroups(keys).groups);
    for (let size = 1; size <= keys.length + 1; size++) {
      expect(shapeOf(walk(keys, () => size, 1_000).groups)).toEqual(expected);
    }
  });

  test.each(FIXTURES)("%s: 200 seeded page-size sequences answer the set function's groups", (_label, keys) => {
    const random = seeded(4302);
    const expected = shapeOf(prefixGroups(keys).groups);
    for (let run = 0; run < 200; run++) {
      const sizes = Array.from({ length: keys.length + 1 }, () => 1 + Math.floor(random() * 4));
      expect(shapeOf(walk(keys, (page) => sizes[page % sizes.length], 1_000).groups)).toEqual(expected);
    }
  });

  test("every fixture at once, under every budget from 1 to 4 and every page size, matches the budget's oracle", () => {
    const all = [
      ...FIXTURES.flatMap(([, keys]) => keys),
      ...["/big/1", "/big/2", "/big/3", "/big/4", "/big/5"].map(utf8),
      // A flat first segment after every other key, so the walk also finishes inside one.
      ...["zz/1", "zz/2"].map(utf8),
    ];
    for (let budget = 1; budget <= 4; budget++) {
      const expected = shapeOf(expectedUnderBudget(all, budget));
      for (let size = 1; size <= 6; size++) expect(shapeOf(walk(all, () => size, budget).groups)).toEqual(expected);
    }
  });

  test("a flat first segment reaching the budget is recorded undecided and the next page starts past it (R13 D9)", () => {
    const keys = ["/big/1", "/big/2", "/big/3", "/big/4", "/big/5", "/later/x/y"].map(utf8);
    const first = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: keys.slice(0, 2), more: true }, { segmentBudget: 3 });
    expect(first.state.groups).toEqual([]);
    expect(named(first.next as EtcdBytes)).toBe("/big/2\u0000");
    const second = stepPrefixWalk(first.state, { keys: keys.slice(2, 4), more: true }, { segmentBudget: 3 });
    expect(shapeOf(second.state.groups)).toEqual([
      { prefix: "/big/", key: "2f6269672f", end: "2f62696730", undecided: true },
    ]);
    expect(named(second.next as EtcdBytes)).toBe("/big0");
    const third = stepPrefixWalk(second.state, { keys: keys.slice(5), more: false }, { segmentBudget: 3 });
    expect(third.next).toBeUndefined();
    expect(prefixWalkResult(third.state, true).map(groupLabel)).toEqual(["/big/*", "/later/x/*"]);
    expect(third.state.keysRead).toBe(5);
  });

  test("a first segment with exactly the budget's keys is recorded undecided, since the walk cannot know it read the last", () => {
    const answer = walk(["/big/1", "/big/2", "/big/3"].map(utf8), () => 10, 3);
    expect(shapeOf(answer.groups)).toEqual([
      { prefix: "/big/", key: "2f6269672f", end: "2f62696730", undecided: true },
    ]);
  });

  test("a first segment decided deep before the budget keeps its groups, however many flat keys follow", () => {
    const answer = walk(["/mix/a", "/mix/b/c", "/mix/d", "/mix/e", "/mix/f"].map(utf8), () => 1, 2);
    expect(answer.groups.map(groupLabel)).toEqual(["/mix/b/*"]);
  });

  test("the page after a recorded group starts at its range end, so no key inside it is read beyond that page", () => {
    const keys = ["/app/x/1", "/app/x/2", "/app/x/3", "/app/y"].map(utf8);
    const first = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: keys.slice(0, 2), more: true }, { segmentBudget: 1_000 });
    expect(first.state.groups.map(groupLabel)).toEqual(["/app/x/*"]);
    expect(named(first.next as EtcdBytes)).toBe("/app/x0");
    const answer = walk(keys, () => 2, 1_000);
    expect(answer.state.keysRead).toBe(3);
  });

  test("a page ending on the key a group begins at, the directory marker /a/b/, starts the next at the group's range end (Review Focus 1)", () => {
    const first = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/a/b/")], more: true }, { segmentBudget: 1_000 });
    expect(first.state.groups.map(groupLabel)).toEqual(["/a/b/*"]);
    expect(named(first.next as EtcdBytes)).toBe("/a/b0");
    const answer = walk(["/a/b/", "/a/b/c", "/a/d/x"].map(utf8), () => 1, 1_000);
    expect(answer.groups.map(groupLabel)).toEqual(["/a/b/*", "/a/d/*"]);
    expect(answer.state.keysRead).toBe(2);
  });

  test("a page ending on a key equal to a recorded group's range end continues just after it, since a range end is exclusive", () => {
    const first = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/a/b/c")], more: true }, { segmentBudget: 1_000 });
    expect(named(first.next as EtcdBytes)).toBe("/a/b0");
    const second = stepPrefixWalk(first.state, { keys: [utf8("/a/b0")], more: true }, { segmentBudget: 1_000 });
    expect(second.state.segment).toMatchObject({ deep: true, keysRead: 2 });
    expect(hex(second.next)).toBe(`${hex(utf8("/a/b0"))}00`);
    const answer = walk(["/a/b/c", "/a/b0", "/a/d/x"].map(utf8), () => 1, 1_000);
    expect(answer.groups.map(groupLabel)).toEqual(["/a/b/*", "/a/d/*"]);
    expect(answer.state.keysRead).toBe(3);
  });

  test("a first segment that is not UTF-8 is passed over after its first key, since no key under it can be in a group", () => {
    const keys = [key("/", [0xff], "/1"), key("/", [0xff], "/2"), key("/", [0xff], "/3"), utf8("/zz/a/b")];
    const first = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: keys.slice(0, 1), more: true }, { segmentBudget: 1_000 });
    expect(hex(first.next)).toBe("2fff30");
    const answer = walk(keys, () => 1, 1_000);
    expect(answer.groups.map(groupLabel)).toEqual(["/zz/a/*"]);
    expect(answer.state.keysRead).toBe(2);
  });

  test("under a deep first segment, a second segment that is not UTF-8 is passed over too", () => {
    const keys = [utf8("/bin/a/1"), key("/bin/", [0xff], "/1"), key("/bin/", [0xff], "/2"), utf8("/bin/zz/1")];
    const answer = walk(keys, () => 1, 1_000);
    expect(answer.groups.map(groupLabel)).toEqual(["/bin/a/*", "/bin/zz/*"]);
    expect(answer.state.keysRead).toBe(3);
  });

  test("keys passed over, inside a recorded group or a skipped range, count toward S and are not placed under their first segment", () => {
    const keys = [utf8("/bin/a/1"), utf8("/bin/a/2"), key("/bin/", [0xff], "/1"), key("/bin/", [0xff], "/2")];
    const step = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys, more: false }, { segmentBudget: 5 });
    expect(step.state.keysRead).toBe(4);
    expect(step.state.segment).toMatchObject({ deep: true, keysRead: 2 });
  });

  test("a page ending on a key in no group continues just after it", () => {
    const step = stepPrefixWalk(
      INITIAL_PREFIX_WALK,
      { keys: [utf8("/feature-flag")], more: true },
      { segmentBudget: 5 },
    );
    expect(hex(step.next)).toBe(`${hex(utf8("/feature-flag"))}00`);
    expect(step.state.segment).toBeUndefined();
  });

  test("a walk stopped by S reports its decided groups and never a first segment it has not finished", () => {
    const keys = ["/app/x/1", "/flat/1", "/flat/2", "/flat/3", "/flat/4", "/zz/y/1"].map(utf8);
    const stopped = walk(keys, () => 1, 1_000, 3);
    expect(stopped.groups.map(groupLabel)).toEqual(["/app/x/*"]);
    expect(stopped.state.segment?.keysRead).toBe(2);
    expect(prefixWalkResult(stopped.state, true).map(groupLabel)).toEqual(["/app/x/*", "/flat/*"]);
  });

  test("a finished walk reading a deep first segment adds nothing for it", () => {
    const step = stepPrefixWalk(
      INITIAL_PREFIX_WALK,
      { keys: [utf8("/a/b/c"), utf8("/a/d")], more: false },
      { segmentBudget: 5 },
    );
    expect(step.state.segment?.deep).toBe(true);
    expect(prefixWalkResult(step.state, true).map(groupLabel)).toEqual(["/a/b/*"]);
  });

  test("a finished walk decides the flat first segment it ends inside, below the budget, as F/* and not undecided", () => {
    const step = stepPrefixWalk(
      INITIAL_PREFIX_WALK,
      { keys: [utf8("/config/a"), utf8("/config/b")], more: false },
      { segmentBudget: 5 },
    );
    expect(step.state.segment).toMatchObject({ deep: false, keysRead: 2 });
    expect(shapeOf(prefixWalkResult(step.state, true))).toEqual([
      { prefix: "/config/", key: "2f636f6e6669672f", end: "2f636f6e66696730", undecided: false },
    ]);
  });

  test("Review Focus 5 and 4.7: the walk over a reader's grants /app/cfg and the prefix /app/x/ answers /app/x/* alone", () => {
    const one = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/app/cfg")], more: false }, { segmentBudget: 5 });
    const two = stepPrefixWalk(one.state, { keys: [utf8("/app/x/y")], more: false }, { segmentBudget: 5 });
    expect(prefixWalkResult(two.state, true).map(groupLabel)).toEqual(["/app/x/*"]);
    expect(prefixGroups([utf8("/app/cfg"), utf8("/app/x/y")]).groups.map(groupLabel)).toEqual(["/app/x/*"]);
  });

  test("Review Focus 5 and 4.7: the walk over two single-key grants inside one group lists the group once", () => {
    const one = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/app/x/a")], more: false }, { segmentBudget: 5 });
    const two = stepPrefixWalk(one.state, { keys: [utf8("/app/x/b")], more: false }, { segmentBudget: 5 });
    expect(prefixWalkResult(two.state, true).map(groupLabel)).toEqual(["/app/x/*"]);
    expect(two.state.keysRead).toBe(2);
  });

  test("Review Focus 5 and 4.7: a single-key grant inside a flat group opens that group", () => {
    const step = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/config/a")], more: false }, { segmentBudget: 5 });
    expect(prefixWalkResult(step.state, true).map(groupLabel)).toEqual(["/config/*"]);
  });

  test("an empty last page finishes the walk, and a step never changes INITIAL_PREFIX_WALK", () => {
    const step = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [], more: false }, { segmentBudget: 5 });
    expect(step).toEqual({ state: { groups: [], keysRead: 0 }, next: undefined });
    stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/a/b/c")], more: false }, { segmentBudget: 5 });
    expect(INITIAL_PREFIX_WALK.groups).toEqual([]);
    expect(Object.isFrozen(INITIAL_PREFIX_WALK)).toBe(true);
  });

  test.each([0, 1.5, Number.NaN])("refuses the per-segment budget %p", (segmentBudget) => {
    expect(() => stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [], more: false }, { segmentBudget })).toThrow(
      "The walk's per-segment budget is a whole number of keys, 1 or more",
    );
  });

  test("refuses a page that says more keys follow and holds none", () => {
    expect(() => stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [], more: true }, { segmentBudget: 5 })).toThrow(
      "A keys_only page that says more keys follow holds at least one key",
    );
  });

  test("refuses a key that is not after the last key read, within a page and across pages", () => {
    const message = "The walk reads keys in byte order, each after the last key it read";
    expect(() =>
      stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/b"), utf8("/a")], more: false }, { segmentBudget: 5 }),
    ).toThrow(message);
    const first = stepPrefixWalk(INITIAL_PREFIX_WALK, { keys: [utf8("/b")], more: true }, { segmentBudget: 5 });
    expect(() => stepPrefixWalk(first.state, { keys: [utf8("/b")], more: false }, { segmentBudget: 5 })).toThrow(
      message,
    );
  });
});

// ----------------------------------------------------------------------------
// Member and lease ids
// ----------------------------------------------------------------------------

describe("member and lease ids (spec 4.1)", () => {
  test("a member id is unpadded lowercase hex and a lease id 16 hex digits, past 2^53 exactly", () => {
    expect(memberHexId("10276657743932975437")).toBe("8e9e05c52164694d");
    expect(memberHexId("255")).toBe("ff");
    expect(memberHexId("0")).toBe("0");
    expect(memberHexId("18446744073709551615")).toBe("ffffffffffffffff");
    expect(leaseHexId("7587863092875085000")).toBe("694d8147df1dc4c8");
    expect(leaseHexId("255")).toBe("00000000000000ff");
    expect(leaseHexId("0")).toBe("0000000000000000");
  });

  test("a negative lease id, which etcd holds only when a client chose it, prints as etcdctl prints it", () => {
    // Measured with go1.27.0: fmt.Sprintf("%016x", int64(-5)) is "-000000000000005", the sign inside the width.
    expect(leaseHexId("-5")).toBe("-000000000000005");
    expect(leaseHexId("-1")).toBe("-000000000000001");
    expect(leaseHexId("-7587863092875085000")).toBe("-694d8147df1dc4c8");
    expect(leaseHexId("-9223372036854775808")).toBe("-8000000000000000");
    expect(leaseHexId("9223372036854775807")).toBe("7fffffffffffffff");
  });

  test.each([
    [() => memberHexId("-1"), TypeError, "A member id is not a decimal integer as the adapter hands ids over"],
    [() => memberHexId("0x10"), TypeError, "A member id is not a decimal integer as the adapter hands ids over"],
    [() => memberHexId(""), TypeError, "A member id is not a decimal integer as the adapter hands ids over"],
    [() => leaseHexId("007"), TypeError, "A lease id is not a decimal integer as the adapter hands ids over"],
    [() => leaseHexId("-0"), TypeError, "A lease id is not a decimal integer as the adapter hands ids over"],
    [() => leaseHexId("-05"), TypeError, "A lease id is not a decimal integer as the adapter hands ids over"],
    [() => leaseHexId("+5"), TypeError, "A lease id is not a decimal integer as the adapter hands ids over"],
    [() => memberHexId("18446744073709551616"), RangeError, "A member id is past the largest id etcd holds"],
    [() => leaseHexId("9223372036854775808"), RangeError, "A lease id is past the largest id etcd holds"],
    [() => leaseHexId("-9223372036854775809"), RangeError, "A lease id is past the smallest id etcd holds"],
  ])("refuses an id that is not one: %#", (call, kind, message) => {
    expect(call).toThrow(kind);
    expect(call).toThrow(message);
  });

  test("fromHexId reads any padding and case, and answers the decimal string", () => {
    expect(fromHexId("8e9e05c52164694d")).toBe("10276657743932975437");
    expect(fromHexId("00008E9E05C52164694D")).toBe("10276657743932975437");
    expect(fromHexId("694d8147df1dc4c8")).toBe("7587863092875085000");
    expect(fromHexId("0000000000000000000001")).toBe("1");
    expect(fromHexId("0")).toBe("0");
    expect(fromHexId("ffffffffffffffff")).toBe("18446744073709551615");
  });

  test("fromHexId answers undefined for text that is not hex and for an id past 64 bits", () => {
    expect(fromHexId("")).toBeUndefined();
    expect(fromHexId("g1")).toBeUndefined();
    expect(fromHexId("-1")).toBeUndefined();
    expect(fromHexId("1ffffffffffffffff")).toBeUndefined();
  });

  test("every hex id reads back to the decimal it was written from", () => {
    for (const decimal of ["1", "10276657743932975437", "18446744073709551615"]) {
      expect(fromHexId(memberHexId(decimal))).toBe(decimal);
    }
    for (const decimal of ["1", "7587863092875085001", "9223372036854775807"]) {
      expect(fromHexId(leaseHexId(decimal))).toBe(decimal);
    }
  });

  test("a negative lease id is shown and never read back, since the grammar addresses no signed id", () => {
    expect(fromHexId(leaseHexId("-5"))).toBeUndefined();
    expect(fromHexId("-000000000000005")).toBeUndefined();
    expect(fromHexId("+5")).toBeUndefined();
  });
});
