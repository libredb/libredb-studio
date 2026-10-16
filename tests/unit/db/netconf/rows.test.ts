/**
 * Tests for the two behaviours that were measured live but had no unit test: building rows out of a
 * reply, and reading a list's key names out of module text. Both run against a fake reader tree and
 * real module text, so neither needs the XML reader that another session is writing.
 */
import { test } from "bun:test";
import { expectBe, expectEqual, expectMatch, expectThrows, expectTruthy } from "./helpers";
import { buildRows, ROW_LIMITS } from "@/lib/db/providers/network/netconf/rows";
import { keyNamesOf, scanYangModule, YANG_LIMITS } from "@/lib/db/providers/network/netconf/yangkeys";
import { QueryError } from "@/lib/db/errors";
import type { XmlElement } from "@/lib/db/providers/network/netconf/reader-port";

/** A tree the way the reader port will answer one. */
function el(name: string, text?: string, children: XmlElement[] = []): XmlElement {
  const base = { name, attributes: new Map<string, string>(), children, bindings: new Map<string, string>() };
  return text === undefined ? base : { ...base, text };
}

const interfaces = el("interfaces", undefined, [
  el("interface", undefined, [
    el("name", "ge-0/0/0"),
    el("type", "ianaift:ethernetCsmacd"),
    el("in-octets", "18446744073709551615"),
    el("alias", "a"),
    el("alias", "b"),
    el("statistics", undefined, [el("discards", "0")]),
  ]),
  el("interface", undefined, [el("name", "ge-0/0/1"), el("type", "ianaift:other")]),
]);

test("key columns come first and every value stays text", () => {
  const rows = buildRows(interfaces, "interface", ["name"]);
  expectBe(rows.columns[0], "name");
  expectBe(rows.rows[0]?.["name"], "ge-0/0/0");
  // A uint64 at its maximum. A number would read 18446744073709552000 here.
  expectBe(rows.rows[0]?.["in-octets"], "18446744073709551615");
  expectBe(typeof rows.rows[0]?.["in-octets"], "string");
});

test("a leaf-list becomes an array cell and a container becomes a JSON cell", () => {
  const rows = buildRows(interfaces, "interface", ["name"]);
  expectBe(rows.rows[0]?.["alias"], '["a","b"]');
  expectBe(rows.rows[0]?.["statistics"], '{"discards":"0"}');
});

test("a cell absent from one entry is empty rather than missing, so the row shape holds", () => {
  const rows = buildRows(interfaces, "interface", ["name"]);
  expectBe(rows.rows[1]?.["in-octets"], "");
  expectEqual(Object.keys(rows.rows[1] ?? {}), rows.columns);
});

test("a keyless list is still shown, by position", () => {
  const rows = buildRows(interfaces, "interface", []);
  expectBe(rows.columns.includes("name"), true);
  expectBe(rows.rows.length, 2);
});

test("a list past the row cap is cut and the cut is stated, not silent", () => {
  const many = el(
    "table",
    undefined,
    Array.from({ length: 5 }, (_, i) => el("entry", undefined, [el("id", String(i))])),
  );
  const rows = buildRows(many, "entry", ["id"], { ...ROW_LIMITS, maxRows: 2 });
  expectBe(rows.rows.length, 2);
  expectMatch(rows.warning ?? "", /first 2 are shown/);
});

const moduleText = `
module example {
  namespace "urn:example";
  prefix ex;
  import ietf-inet-types { prefix inet; }
  grouping shared {
    list in-grouping {
      key "a b";
      leaf a { type string; }
      leaf b { type string; }
    }
  }
  container top {
    list keyed {
      key "name";
      leaf name { type string; }
    }
    list keyless {
      leaf x { type string; }
    }
    list commented {
      // key "x";
      leaf x { type string; }
    }
    uses inet:shared-thing;
    uses shared;
  }
  augment "/other:tree/other:node" {
    leaf added { type string; }
  }
}
`;

test("the key statement is read from module text, in order, without compiling the module", () => {
  const scan = scanYangModule(moduleText);
  expectEqual(keyNamesOf(scan, "keyed"), ["name"]);
  expectEqual(keyNamesOf(scan, "in-grouping"), ["a", "b"]);
});

test("a list with no key, and one whose key is only in a comment, both read as keyless", () => {
  const scan = scanYangModule(moduleText);
  expectEqual(keyNamesOf(scan, "keyless"), []);
  expectEqual(keyNamesOf(scan, "commented"), []);
});

test("a list inside a grouping is marked, because its data appears wherever uses pulls it", () => {
  const scan = scanYangModule(moduleText);
  expectBe(scan.lists.find((l) => l.name === "in-grouping")?.inGrouping, true);
  expectBe(scan.lists.find((l) => l.name === "keyed")?.inGrouping, false);
});

test("a prefixed uses and an augment are reported, because they move a list's data elsewhere", () => {
  const scan = scanYangModule(moduleText);
  expectEqual(scan.externalUses, ["inet:shared-thing"]);
  expectBe(scan.augments.length, 1);
  expectMatch(scan.augments[0] ?? "", /other:tree/);
});

/**
 * The data here is chosen so that the test fails when quoted text stops being neutralised, which is
 * the only thing it claims (decision K-125). An earlier version put a brace in a description AFTER
 * the key statement, where mis-parsing changed nothing and the test passed either way: a planted
 * bug survived it. The description below closes the list early and declares a second list inside
 * the string, so a scanner that reads quoted text as code loses the real key and gains a list that
 * does not exist.
 */
test("quoted text is neutralised, so a brace in a description neither ends a list nor starts one", () => {
  const scan = scanYangModule(`
module q {
  container c {
    list l {
      description "ends the list here } and starts list fake { key \\"zzz\\"; } and holds a ; too";
      key "k";
      leaf k { type string; }
    }
  }
}
`);
  expectEqual(keyNamesOf(scan, "l"), ["k"]);
  expectEqual(
    scan.lists.map((list) => list.name),
    ["l"],
  );
  expectBe(keyNamesOf(scan, "fake").length, 0);
});

test("module text past the byte cap is refused rather than scanned", () => {
  expectThrows(() => scanYangModule("x".repeat(100), { maxBytes: 10, maxDepth: 8 }), QueryError);
});

/**
 * The tests above prove the caps are applied. They cannot prove the published numbers are right,
 * because they pass their own numbers in: `{ ...ROW_LIMITS, maxRows: 2 }` imports the record and
 * then overrides the one field under test. Setting `maxRows` in the definition to 2 left every one
 * of them green, measured. "Is the limit enforced" and "is the published limit this number" are
 * different questions, and the four below answer the second: they call the default path, with
 * nothing injected, and assert the figure itself rather than the constant against itself.
 */
test("the published row cap is 10,000, and the constant is only its name", () => {
  const many = el(
    "table",
    undefined,
    Array.from({ length: 10_001 }, (_, i) => el("entry", undefined, [el("id", String(i))])),
  );
  const rows = buildRows(many, "entry", ["id"]);
  expectBe(rows.rows.length, 10_000);
  expectMatch(rows.warning ?? "", /first 10000 are shown/);
  expectBe(ROW_LIMITS.maxRows, 10_000);
});

test("the published cell cap is 65,536 characters, and a longer value is cut and declared", () => {
  const long = "v".repeat(70_000);
  const one = el("table", undefined, [el("entry", undefined, [el("id", "1"), el("note", long)])]);
  const rows = buildRows(one, "entry", ["id"]);
  expectBe(rows.rows[0]?.["note"]?.length, 65_536);
  expectBe(ROW_LIMITS.maxCellChars, 65_536);
});

test("the published module text cap is 4 MiB, and the figure is 35 times the largest measured", () => {
  const over = `module m { ${"/* pad */ ".repeat(430_000)} }`;
  expectTruthy(over.length > 4 * 1024 * 1024);
  expectThrows(() => scanYangModule(over), QueryError);
  expectBe(YANG_LIMITS.maxBytes, 4_194_304);
  // MEASURED: the largest of the fixture's 59 module texts is 118,482 bytes, so the cap has to be
  // comfortably above that and is.
  expectTruthy(YANG_LIMITS.maxBytes > 118_482);
});

test("the published nesting cap is 64 levels, and the figure is six times the deepest measured", () => {
  const deep = `module m { ${"container c {".repeat(70)}${"}".repeat(70)} }`;
  expectThrows(() => scanYangModule(deep), QueryError);
  expectBe(YANG_LIMITS.maxDepth, 64);
  // MEASURED: the deepest of the 59 modules nests 11 levels, median 5.
  expectTruthy(YANG_LIMITS.maxDepth > 11);
});

/**
 * Every cap, at the value it allows and the first value it refuses.
 *
 * A test that only exceeds a cap cannot see the cap move upwards: raising maxRows to a million
 * leaves "10,001 entries were cut" true. A test that only stays under it cannot see it move
 * downwards. The pairs below pin both sides, so the threshold itself is held and not just its
 * direction.
 */
test("the row cap allows exactly 10,000 and cuts at 10,001", () => {
  const listOf = (count: number) =>
    el(
      "table",
      undefined,
      Array.from({ length: count }, (_, i) => el("entry", undefined, [el("id", String(i))])),
    );
  const atCap = buildRows(listOf(10_000), "entry", ["id"]);
  expectBe(atCap.rows.length, 10_000);
  expectBe(atCap.warning, undefined, "a list exactly at the cap is complete, so nothing is declared");
  const over = buildRows(listOf(10_001), "entry", ["id"]);
  expectBe(over.rows.length, 10_000);
  expectMatch(over.warning ?? "", /10000/);
});

test("the cell cap keeps 65,536 characters and cuts 65,537", () => {
  const cellOf = (length: number) =>
    el("table", undefined, [el("entry", undefined, [el("id", "1"), el("note", "v".repeat(length))])]);
  expectBe(buildRows(cellOf(65_536), "entry", ["id"]).rows[0]?.["note"]?.length, 65_536);
  expectBe(buildRows(cellOf(65_537), "entry", ["id"]).rows[0]?.["note"]?.length, 65_536);
});

test("the nesting cap allows 64 levels and refuses 65", () => {
  // The module's own brace is one level, so 63 containers reach 64 and 64 containers reach 65.
  const nested = (containers: number) => `module m { ${"container c {".repeat(containers)}${"}".repeat(containers)} }`;
  expectBe(scanYangModule(nested(63)).lists.length, 0, "63 containers inside the module is 64 levels");
  expectThrows(() => scanYangModule(nested(64)), QueryError);
});

test("the module text cap allows exactly 4 MiB and refuses one character more", () => {
  const head = "module m { } ";
  const atCap = head + " ".repeat(4 * 1024 * 1024 - head.length);
  expectBe(atCap.length, 4 * 1024 * 1024);
  expectBe(scanYangModule(atCap).lists.length, 0);
  expectThrows(() => scanYangModule(`${atCap} `), QueryError);
});
