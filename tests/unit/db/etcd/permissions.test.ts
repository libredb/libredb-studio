/**
 * A user's readable and writable ranges (spec 4.7, 5.6), merged as etcd's own permission check
 * merges them (SRC etcd__server_auth_range_perm_cache.go).
 *
 * Review Focus 5 is here: grants of unusual shape merge exactly, the pieces of a group a user may
 * read hold only the grant's bytes, and the "may read" sentence names every range.
 */
import { describe, expect, test } from "bun:test";
import type { EtcdByteRange, EtcdBytes, EtcdPermission } from "@/lib/db/providers/keyvalue/etcd/client";
import { ALL_KEYS, compareBytes, prefixRangeEnd, rangesIntersect } from "@/lib/db/providers/keyvalue/etcd/keys";
import {
  type AccessScope,
  clipToScope,
  describeRange,
  describeScope,
  rangeCovered,
  rangeShape,
  readableScope,
  writableScope,
} from "@/lib/db/providers/keyvalue/etcd/permissions";

const utf8 = (text: string): EtcdBytes => new TextEncoder().encode(text);
const key = (...parts: ReadonlyArray<string | readonly number[]>): EtcdBytes =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? Array.from(utf8(part)) : Array.from(part))));
const hex = (bytes: EtcdBytes | undefined): string | undefined =>
  bytes === undefined ? undefined : Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const text = (bytes: EtcdBytes | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

const prefixOf = (bytes: EtcdBytes): EtcdByteRange => ({ key: bytes, rangeEnd: prefixRangeEnd(bytes) });
const point = (value: string): EtcdByteRange => ({ key: utf8(value) });
const range = (from: string, to: string): EtcdByteRange => ({ key: utf8(from), rangeEnd: utf8(to) });

const grant = (type: EtcdPermission["type"], written: EtcdByteRange): EtcdPermission => ({ type, ...written });
const readPrefix = (value: string) => grant("read", prefixOf(utf8(value)));
const readKey = (value: string) => grant("read", point(value));

/** A scope as a test compares it: "all", or each range as its text key and text range end. */
function spelled(scope: AccessScope) {
  return scope.kind === "all" ? "all" : scope.ranges.map((each) => [text(each.key), text(each.rangeEnd)]);
}

describe("readableScope and writableScope (spec 4.7)", () => {
  test("READ and READWRITE are readable, WRITE and READWRITE writable", () => {
    const permissions = [
      readPrefix("/r/"),
      grant("write", prefixOf(utf8("/w/"))),
      grant("readwrite", prefixOf(utf8("/rw/"))),
    ];
    expect(spelled(readableScope(permissions))).toEqual([
      ["/r/", "/r0"],
      ["/rw/", "/rw0"],
    ]);
    expect(spelled(writableScope(permissions))).toEqual([
      ["/rw/", "/rw0"],
      ["/w/", "/w0"],
    ]);
  });

  test("no grant of a type is no range, which the sentence calls no key", () => {
    const scope = writableScope([readPrefix("/app/")]);
    expect(scope).toEqual({ kind: "ranges", ranges: [] });
    expect(describeScope(scope)).toBe("no key");
  });

  test("Review Focus 5: READ on a prefix beside READWRITE on a prefix inside it merges into the outer prefix", () => {
    const permissions = [readPrefix("/app/"), grant("readwrite", prefixOf(utf8("/app/x/")))];
    expect(spelled(readableScope(permissions))).toEqual([["/app/", "/app0"]]);
    expect(spelled(writableScope(permissions))).toEqual([["/app/x/", "/app/x0"]]);
    expect(describeScope(readableScope(permissions))).toBe("/app/ (prefix)");
    expect(describeScope(writableScope(permissions))).toBe("/app/x/ (prefix)");
  });

  test("Review Focus 5: a from-key grant runs to the end of the key space and swallows every grant after it", () => {
    const permissions = [
      grant("read", { key: utf8("/m"), rangeEnd: Uint8Array.of(0) }),
      readPrefix("/z/"),
      readKey("/a"),
    ];
    const scope = readableScope(permissions);
    expect(scope.kind === "ranges" && scope.ranges.map((each) => [text(each.key), hex(each.rangeEnd)])).toEqual([
      ["/a", undefined],
      ["/m", "00"],
    ]);
    expect(describeScope(scope)).toBe("/a, /m (from key)");
  });

  test("Review Focus 5: a single-key grant inside a flat group stays one key", () => {
    const permissions = [readPrefix("/app/"), readKey("/config/a")];
    expect(spelled(readableScope(permissions))).toEqual([
      ["/app/", "/app0"],
      ["/config/a", undefined],
    ]);
    expect(describeScope(readableScope(permissions))).toBe("/app/ (prefix), /config/a");
  });

  test("Review Focus 5: two roles whose ranges overlap are one range, and two that touch are one too", () => {
    const overlapping = [grant("read", range("/a", "/c")), grant("readwrite", range("/b", "/d"))];
    expect(spelled(readableScope(overlapping))).toEqual([["/a", "/d"]]);
    const touching = [grant("read", range("/a", "/b")), grant("read", range("/b", "/c"))];
    expect(spelled(readableScope(touching))).toEqual([["/a", "/c"]]);
    const inside = [grant("read", range("/a", "/z")), grant("read", range("/b", "/c"))];
    expect(spelled(readableScope(inside))).toEqual([["/a", "/z"]]);
    const apart = [grant("read", range("/c", "/d")), grant("read", range("/a", "/b"))];
    expect(spelled(readableScope(apart))).toEqual([
      ["/a", "/b"],
      ["/c", "/d"],
    ]);
  });

  test("Review Focus 5: a grant whose key is not UTF-8 keeps its bytes, and the sentence writes them in Go quoting", () => {
    const binary = key("/", [0xff, 0xfe], "/");
    const scope = readableScope([grant("read", prefixOf(binary))]);
    expect(scope.kind === "ranges" && scope.ranges.map((each) => [hex(each.key), hex(each.rangeEnd)])).toEqual([
      ["2ffffe2f", "2ffffe30"],
    ]);
    expect(describeScope(scope)).toBe('"/\\xff\\xfe/" (prefix)');
  });

  test("Review Focus 5: READ on the whole key space without the root role is every key", () => {
    expect(readableScope([grant("read", ALL_KEYS)])).toEqual({ kind: "all" });
    expect(readableScope([readPrefix("/app/"), grant("readwrite", ALL_KEYS)])).toEqual({ kind: "all" });
    expect(describeScope({ kind: "all" })).toBe("every key");
    expect(writableScope([grant("read", ALL_KEYS)])).toEqual({ kind: "ranges", ranges: [] });
  });

  test("a grant given twice, in two roles, is one range", () => {
    expect(spelled(readableScope([readPrefix("/app/"), readPrefix("/app/")]))).toEqual([["/app/", "/app0"]]);
  });

  test("a grant of a key beside its own prefix range merges, and an empty range end is the one key", () => {
    const permissions = [readKey("/app"), grant("read", { key: utf8("/app/x"), rangeEnd: new Uint8Array() })];
    expect(spelled(readableScope(permissions))).toEqual([
      ["/app", undefined],
      ["/app/x", undefined],
    ]);
  });

  test("a permission etcd never grants is a decoding fault, raised and never read as a grant of nothing", () => {
    expect(() => readableScope([grant("read", { key: new Uint8Array() })])).toThrow(
      "A permission with an empty key is not one etcd grants (isValidPermissionRange)",
    );
    expect(() => readableScope([grant("read", range("/b", "/a"))])).toThrow(
      "A permission whose range end is at or before its key is not one etcd grants (isValidPermissionRange)",
    );
  });
});

describe("rangeCovered (spec 4.7, the edit offer)", () => {
  const scope = readableScope([
    readPrefix("/app/"),
    readKey("/config/a"),
    grant("read", { key: utf8("/m"), rangeEnd: Uint8Array.of(0) }),
  ]);

  test.each([
    ["a key under a readable prefix", point("/app/x/y"), true],
    ["the readable prefix itself", prefixOf(utf8("/app/")), true],
    ["the single readable key", point("/config/a"), true],
    ["another key of the same group", point("/config/b"), false],
    ["a group wider than the grant", prefixOf(utf8("/config/")), false],
    ["a range reaching past a prefix", range("/app/a", "/apq"), false],
    ["a key past a from-key grant", point("/zz/top"), true],
    ["a from-key range inside a from-key grant", { key: utf8("/n"), rangeEnd: Uint8Array.of(0) }, true],
    ["a from-key range from before a from-key grant", { key: utf8("/l"), rangeEnd: Uint8Array.of(0) }, false],
    ["a range that holds no key", range("/z", "/a"), true],
  ])("%s: %p", (_label, written, covered) => {
    expect(rangeCovered(written, scope)).toBe(covered);
  });

  test("the whole key space covers every range, and no range covers none", () => {
    expect(rangeCovered(ALL_KEYS, { kind: "all" })).toBe(true);
    expect(rangeCovered(point("/a"), { kind: "ranges", ranges: [] })).toBe(false);
  });

  test("a range that holds no key is covered by any scope, one with no range included", () => {
    expect(rangeCovered(range("/z", "/a"), { kind: "ranges", ranges: [] })).toBe(true);
  });

  test("Review Focus 5: edit.offered follows the writable union, a key read but not written answering false", () => {
    const permissions = [readPrefix("/app/"), grant("readwrite", prefixOf(utf8("/app/x/")))];
    expect(rangeCovered(point("/app/x/cfg"), writableScope(permissions))).toBe(true);
    expect(rangeCovered(point("/app/cfg"), writableScope(permissions))).toBe(false);
    expect(rangeCovered(point("/app/cfg"), readableScope(permissions))).toBe(true);
  });

  test("ranges a caller did not merge are merged before they are read", () => {
    const unmerged: AccessScope = { kind: "ranges", ranges: [range("/b", "/d"), range("/a", "/c"), range("/q", "/p")] };
    expect(rangeCovered(range("/a", "/d"), unmerged)).toBe(true);
    expect(clipToScope(range("/a", "/z"), unmerged).map((each) => [text(each.key), text(each.rangeEnd)])).toEqual([
      ["/a", "/d"],
    ]);
  });
});

describe("clipToScope and rangeShape (spec 3.4, 4.7): the pieces a group's readRanges come from", () => {
  test("a group read whole by a prefix grant is one piece, the group's own range", () => {
    const pieces = clipToScope(prefixOf(utf8("/app/a/")), readableScope([readPrefix("/app/")]));
    expect(pieces.map((each) => [text(each.key), text(each.rangeEnd)])).toEqual([["/app/a/", "/app/a0"]]);
    expect(rangeShape(pieces[0])).toEqual({ shape: "prefix", prefix: utf8("/app/a/") });
  });

  test("a group read by one single-key grant is that key alone, in the key's own bytes", () => {
    const pieces = clipToScope(prefixOf(utf8("/config/")), readableScope([readKey("/config/a")]));
    expect(pieces).toEqual([{ key: utf8("/config/a") }]);
    expect(rangeShape(pieces[0])).toEqual({ shape: "key", key: utf8("/config/a") });
  });

  test("a group read by two single-key grants inside it is two pieces, each key counted once", () => {
    const pieces = clipToScope(prefixOf(utf8("/app/x/")), readableScope([readKey("/app/x/b"), readKey("/app/x/a")]));
    expect(pieces.map((each) => text(each.key))).toEqual(["/app/x/a", "/app/x/b"]);
    expect(pieces.every((each) => each.rangeEnd === undefined)).toBe(true);
  });

  test("a group cut by a range grant is the start and end the two share", () => {
    const pieces = clipToScope(prefixOf(utf8("/app/")), readableScope([grant("read", range("/app/m", "/b"))]));
    expect(pieces.map((each) => [text(each.key), text(each.rangeEnd)])).toEqual([["/app/m", "/app0"]]);
    expect(rangeShape(pieces[0])).toEqual({ shape: "range", start: utf8("/app/m"), end: utf8("/app0") });
  });

  test("Review Focus 5: a group cut by a from-key grant starts at the grant and ends at the group's end", () => {
    const pieces = clipToScope(
      prefixOf(utf8("/app/")),
      readableScope([grant("read", { key: utf8("/app/q"), rangeEnd: Uint8Array.of(0) })]),
    );
    expect(pieces.map((each) => [text(each.key), text(each.rangeEnd)])).toEqual([["/app/q", "/app0"]]);
  });

  test("Review Focus 5: no piece addresses bytes other than the grant's, a grant that is not UTF-8 included", () => {
    const binary = key("/bin/", [0xff]);
    const scope = readableScope([grant("read", { key: binary }), readPrefix("/bin/ok/")]);
    const pieces = clipToScope(prefixOf(utf8("/bin/")), scope);
    expect(pieces.map((each) => [hex(each.key), hex(each.rangeEnd)])).toEqual([
      ["2f62696e2f6f6b2f", "2f62696e2f6f6b30"],
      ["2f62696e2fff", undefined],
    ]);
  });

  test("the whole key space clipped to a narrow reader is exactly its grants, from-key grant included", () => {
    const scope = readableScope([
      readPrefix("/app/"),
      readKey("/config/a"),
      grant("read", { key: utf8("/m"), rangeEnd: Uint8Array.of(0) }),
    ]);
    const pieces = clipToScope(ALL_KEYS, scope);
    expect(pieces.map((each) => [text(each.key), hex(each.rangeEnd)])).toEqual([
      ["/app/", hex(utf8("/app0"))],
      ["/config/a", undefined],
      ["/m", "00"],
    ]);
    expect(rangeShape(pieces[2])).toEqual({ shape: "range", start: utf8("/m"), end: Uint8Array.of(0) });
  });

  test("the whole key space under every key is itself, and a range that holds no key has no piece", () => {
    expect(clipToScope(ALL_KEYS, { kind: "all" })).toEqual([ALL_KEYS]);
    expect(clipToScope(range("/z", "/a"), { kind: "all" })).toEqual([]);
    expect(clipToScope(point("/a"), { kind: "ranges", ranges: [] })).toEqual([]);
  });

  test("the pieces are disjoint, lie inside both the range and the scope, and hold every key the two share", () => {
    const scope = readableScope([
      readPrefix("/app/"),
      grant("read", range("/app/x/", "/b")),
      readKey("/config/a"),
      grant("read", { key: utf8("/z"), rangeEnd: Uint8Array.of(0) }),
    ]);
    const probes = [
      "/app/",
      "/app/a",
      "/app/x/q",
      "/apq",
      "/a/z",
      "/c",
      "/config/a",
      "/config/b",
      "/y",
      "/z",
      "/zz",
    ].map(utf8);
    for (const written of [prefixOf(utf8("/app/")), prefixOf(utf8("/config/")), range("/app/m", "/zz"), ALL_KEYS]) {
      const pieces = clipToScope(written, scope);
      for (let index = 1; index < pieces.length; index++) {
        expect(rangesIntersect(pieces[index - 1], pieces[index])).toBe(false);
        expect(compareBytes(pieces[index - 1].key, pieces[index].key)).toBeLessThan(0);
      }
      for (const probe of probes) {
        const inRange = rangesIntersect({ key: probe }, written);
        const inScope = scope.kind === "ranges" && scope.ranges.some((each) => rangesIntersect({ key: probe }, each));
        const inPieces = pieces.filter((each) => rangesIntersect({ key: probe }, each)).length;
        expect(inPieces).toBe(inRange && inScope ? 1 : 0);
      }
    }
  });

  test.each([
    ["no range end", { key: utf8("/a") }, "key"],
    ["an empty range end", { key: utf8("/a"), rangeEnd: new Uint8Array() }, "key"],
    ["the key and one 0x00 byte", { key: utf8("/a"), rangeEnd: key("/a", [0]) }, "key"],
    ["a prefix range", prefixOf(utf8("/a/")), "prefix"],
    ["the prefix of bytes that are all 0xff", { key: Uint8Array.of(0xff), rangeEnd: Uint8Array.of(0) }, "prefix"],
    ["a start and end key", range("/a", "/c"), "range"],
    ["a key, one 0x00 byte and more", { key: utf8("/a"), rangeEnd: key("/a", [0, 0]) }, "range"],
    ["the same length ending in 0x00 on other bytes", { key: utf8("/a"), rangeEnd: key("/b", [0]) }, "range"],
    ["the key and one byte other than 0x00", { key: utf8("/a"), rangeEnd: key("/a", [1]) }, "range"],
  ])("rangeShape of %s is %s", (_label, written, shape) => {
    expect(rangeShape(written).shape).toBe(shape as "key" | "prefix" | "range");
  });

  test("rangeShape of the whole key space is the empty prefix, as etcdctl writes it", () => {
    expect(rangeShape(ALL_KEYS)).toEqual({ shape: "prefix", prefix: new Uint8Array() });
  });
});

describe("describeRange and describeScope (spec 5.6's may-read list)", () => {
  test.each([
    [prefixOf(utf8("/app/")), "/app/ (prefix)"],
    [point("/cfg/x"), "/cfg/x"],
    [range("/a", "/c"), "/a to /c (range)"],
    [{ key: utf8("/m"), rangeEnd: Uint8Array.of(0) }, "/m (from key)"],
    [ALL_KEYS, "every key"],
    [point("/a b"), "'/a b'"],
    [prefixOf(utf8("/it's/")), "'/it'\\''s/' (prefix)"],
    [point("/a\nb"), '"/a\\nb"'],
  ])("describeRange(%#) is %s", (written, sentence) => {
    expect(describeRange(written)).toBe(sentence);
  });

  test("the scope of the etcd-auth reader reads as spec 5.6 writes it", () => {
    expect(describeScope(readableScope([readPrefix("/app/"), readKey("/config/a")]))).toBe("/app/ (prefix), /config/a");
  });
});
