/**
 * The level page, which is where the address space meets the Keys panel (#1677).
 *
 * MORE ROWS THAN NODES IS CORRECT HERE, and that is the finding behind this file. The address space
 * is a directed acyclic graph: re-measured on the documented fixture, 6,769 nodes reachable from the
 * Objects folder have 7,040 distinct browse paths, because 41 of them hang off more than one parent
 * - 39 off two, and two of them off thirty - which gives 215 of those nodes more than one path. There are no cycles; an exhaustive walk saturates
 * at 7,040 paths, and the deepest node is at depth 7.
 *
 * So a node seen twice is shown twice, under each parent that reaches it. A tree that showed it once
 * would have to pick a parent the server does not privilege.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { keyScanShape } from "@/lib/db/types";
import type { OpcuaReference } from "@/lib/db/providers/industrial/opcua/client";
import {
  browseLevel,
  childBearingNodes,
  levelPage,
  levelScope,
  levelSlice,
  OPCUA_KEY_SCAN,
  resolvePath,
} from "@/lib/db/providers/industrial/opcua/key-scan";
import type { OpcuaBrowseResult, OpcuaNodeId, OpcuaReadOnlyClient } from "@/lib/db/providers/industrial/opcua/client";
import { pathSegments } from "@/lib/db/providers/industrial/opcua/node-id";
import {
  OPCUA_BROWSE_LEVEL_MAX_CONTINUATIONS,
  OPCUA_BROWSE_LEVEL_MAX_REFERENCES,
} from "@/lib/db/providers/industrial/opcua/constants";

function reference(browseName: string, over: Partial<OpcuaReference> = {}): OpcuaReference {
  return {
    nodeId: `ns=3;s=${browseName}`,
    browseName,
    displayName: browseName,
    nodeClass: "Variable",
    referenceTypeId: "i=47",
    mayHaveChildren: false,
    ...over,
  };
}

/**
 * ONE PAGE, ASKED FOR THE WAY THE ROUTE ASKS FOR IT, and that is the correction this helper carries.
 * Every paging test in this file used to start at `cursor: ""` and assert `""` at the end - a
 * protocol the product does not have. `POST /api/db/keys/scan` sends `"0"` for the first press
 * (`readCursor`) and refuses an empty cursor outright, and `use-key-scan.ts` reads `"0"` as the
 * ONLY end-of-walk signal. Driving the pages through this helper, with `START` the route's own
 * sentinel, is what makes a passing test here mean a working panel there.
 */
const START = "0";
const END = "0";

function pageOf(
  pattern: string,
  references: readonly OpcuaReference[],
  options: {
    readonly cursor: string;
    readonly count: number;
    readonly folders?: ReadonlySet<OpcuaNodeId>;
  },
) {
  const slice = levelSlice(pattern, references, {
    cursor: options.cursor,
    count: options.count,
  });
  return {
    ...levelPage(slice, options.folders),
    rows: slice.rows,
    exhausted: slice.exhausted,
  };
}

describe("what the panel is told about this walk", () => {
  /** A server publishes no count of its nodes, so no total is claimed. */
  test("the capability promises no total", () => {
    expect(OPCUA_KEY_SCAN.totalScope).toBe("none");
  });

  test("a path key is a literal prefix, not a glob", () => {
    expect(OPCUA_KEY_SCAN.pattern).toBe("prefix");
  });

  test("the walk lists one level at a time", () => {
    // `toBeDefined` on a `{}` passes whatever the declaration says, so the shape is read through the
    // one helper every panel reads it through, and the level fields it requires are asserted.
    expect(OPCUA_KEY_SCAN.levels).toBeDefined();
    expect(keyScanShape(OPCUA_KEY_SCAN)).toEqual({
      separator: "/",
      cursor: "opaque",
      pattern: "prefix",
      totalScope: "none",
    });
  });

  /**
   * OPAQUE, AND THAT IS THE LEVEL CONTRACT RATHER THAN A PREFERENCE. A level cursor is the last
   * entry the page returned, so the next page starts after it and a level re-browsed between two
   * calls neither skips a row nor repeats one. An ordinal into the previous answer cannot promise
   * that, and a continuation point cannot survive the request at all.
   */
  test("the cursor is opaque, because a level cursor is the entry it ended on", () => {
    expect(OPCUA_KEY_SCAN.cursor).toBe("opaque");
  });
});

describe("one level", () => {
  const children = [
    reference("Beta"),
    reference("Alpha"),
    reference("Gamma", { mayHaveChildren: true, nodeClass: "Object" }),
  ];

  /**
   * KEYS AND PREFIXES ARE TWO LISTS, which is the level contract and not a detail: the tree draws a
   * folder row from `prefixes` alone, so a folder put in `keys` is a leaf the reader cannot open.
   * That is what this provider answered until the panel's own request was measured.
   */
  const GAMMA = new Set<OpcuaNodeId>(["ns=3;s=Gamma"]);

  test("the leaves are keys and the folders are prefixes, each one separator deeper", () => {
    const page = pageOf("", children, {
      cursor: START,
      count: 10,
      folders: GAMMA,
    });
    expect(page.keys).toEqual(["Alpha", "Beta"]);
    expect(page.prefixes).toEqual(["Gamma/"]);
  });

  test("a leaf is typed by its node class, and a folder is not in the key types at all", () => {
    const page = pageOf("", children, {
      cursor: START,
      count: 10,
      folders: GAMMA,
    });
    expect(page.types.Alpha).toBe("variable");
    expect(page.types.Gamma).toBeUndefined();
  });

  /** The panel's pattern carries the separator; the keys it answers hang directly under it. */
  test("a child's key hangs under the pattern it was asked for, separator and all", () => {
    const page = pageOf("Objects/OpcPlc/", children, {
      cursor: START,
      count: 10,
      folders: GAMMA,
    });
    expect(page.keys).toContain("Objects/OpcPlc/Alpha");
    expect(page.prefixes).toEqual(["Objects/OpcPlc/Gamma/"]);
    expect(pathSegments("Objects/OpcPlc/Alpha")).toEqual(["Objects", "OpcPlc", "Alpha"]);
    // Every key and every folder is inside the level the route checks it against.
    for (const entry of [...page.keys, ...(page.prefixes ?? [])]) {
      expect(entry.startsWith("Objects/OpcPlc/")).toBe(true);
      expect(entry.slice("Objects/OpcPlc/".length).replace(/\/$/, "")).not.toContain("/");
    }
  });

  /**
   * A PATTERN WITHOUT THE SEPARATOR NAMES THE LEVEL ABOVE AND NARROWS IT, which is what the filter
   * box sends. Measured against the route before this was handled: `Plant` was read as the level
   * `Plant/`, whose keys hold a separator after the pattern, and the route answered HTTP 500
   * accusing the provider of leaving the level it was asked for.
   */
  test("a pattern with no trailing separator filters the level above it", () => {
    const level = [reference("Plant"), reference("Plant1"), reference("Pump")];
    const page = pageOf("Plant", level, { cursor: START, count: 10 });
    expect(page.keys).toEqual(["Plant", "Plant1"]);
    // The route's own rule over the raw pattern: every entry begins with it and adds no separator.
    for (const entry of [...page.keys, ...(page.prefixes ?? [])]) {
      expect(entry.startsWith("Plant")).toBe(true);
      expect(entry.slice("Plant".length).replace(/\/$/, "")).not.toContain("/");
    }
  });

  test("the filtered level keeps a folder one level deeper, which the route accepts as a prefix", () => {
    const level = [reference("Plant", { nodeClass: "Object", mayHaveChildren: true }), reference("Pump")];
    const page = pageOf("Plant", level, {
      cursor: START,
      count: 10,
      folders: new Set(["ns=3;s=Plant"]),
    });
    expect(page.prefixes).toEqual(["Plant/"]);
    expect(page.keys).toEqual([]);
  });

  /**
   * A separator with nothing between it and the next one names no node, and says so - INCLUDING a
   * trailing one, which is the case the first version missed: `pathSegments` pops EVERY trailing
   * empty segment, so a typed `A//` lost its empty step before the check could see it, the level
   * resolved to `A`, and no child key of `A` begins with `A//` - so the filter box answered "this
   * folder is empty" for a folder that is not.
   */
  test("an empty step is a sentence, not a browse for a nameless child", () => {
    expect(() => levelScope("A//B/")).toThrow(/holds no empty step/);
    expect(() => levelScope("/A/")).toThrow(/holds no empty step/);
    expect(() => levelScope("A//")).toThrow(/holds no empty step/);
    expect(() => levelScope("A///")).toThrow(/holds no empty step/);
    expect(() => levelScope("//")).toThrow(/holds no empty step/);
    expect(levelScope("A/B/")).toEqual({ path: "A/B/", segments: ["A", "B"] });
    // The filter-box form: the level is the part up to the last separator, the whole pattern filters.
    expect(levelScope("A/Pu")).toEqual({ path: "A/", segments: ["A"] });
  });

  test("the node id travels with the row, so the next read need not walk down again", () => {
    const slice = levelSlice("", children, { cursor: START, count: 10 });
    expect(slice.rows[0]?.nodeId).toBe("ns=3;s=Alpha");
  });
});

/**
 * A VARIABLE THAT BEARS CHILDREN IS A KEY AND A FOLDER, and on every OPC UA server there is one:
 * `Server/ServerStatus` carries the server's state as a structured value and has eight children.
 * Drawn as a folder alone - which is what this did - its row is a twisty and nothing else, there is
 * no entry in `types` for it, `KeyBrowser.tsx`'s `readable = node.isKey && onOpenKey !== undefined`
 * is false, and the value can be reached only by someone who already knows to type a node id into
 * the console. The panel is written for the dual row; the provider simply never produced one.
 */
describe("a row that is both a key and a folder", () => {
  const level = [
    reference("ServerStatus", { nodeClass: "Variable", mayHaveChildren: true }),
    reference("ServerCapabilities", {
      nodeClass: "Object",
      mayHaveChildren: true,
    }),
    reference("ServerArray", { nodeClass: "Variable" }),
    reference("ResetToDefaults", { nodeClass: "Method" }),
  ];
  const bearing = new Set<OpcuaNodeId>(["ns=3;s=ServerStatus", "ns=3;s=ServerCapabilities"]);

  test("a child-bearing Variable is answered in both lists, with its type", () => {
    const page = pageOf("Server/", level, {
      cursor: START,
      count: 10,
      folders: bearing,
    });
    expect(page.keys).toContain("Server/ServerStatus");
    expect(page.prefixes).toContain("Server/ServerStatus/");
    expect(page.types["Server/ServerStatus"]).toBe("variable");
  });

  /** An Object has no Value attribute at all - reading one answers BadAttributeIdInvalid. */
  test("a child-bearing Object is a folder only", () => {
    const page = pageOf("Server/", level, {
      cursor: START,
      count: 10,
      folders: bearing,
    });
    expect(page.prefixes).toContain("Server/ServerCapabilities/");
    expect(page.keys).not.toContain("Server/ServerCapabilities");
    expect(page.types["Server/ServerCapabilities"]).toBeUndefined();
  });

  test("a leaf Variable and a Method are keys only, which is the control", () => {
    const page = pageOf("Server/", level, {
      cursor: START,
      count: 10,
      folders: bearing,
    });
    expect(page.keys).toContain("Server/ServerArray");
    expect(page.keys).toContain("Server/ResetToDefaults");
    expect(page.prefixes).not.toContain("Server/ServerArray/");
    expect(page.prefixes).not.toContain("Server/ResetToDefaults/");
  });

  /**
   * THE BUDGET IS ENTRIES AND NOT ROWS, which the route enforces: keys and prefixes together may
   * not exceed `count`. The rows are chosen before folder-ness is measured, so the tail that no
   * longer fits is dropped and the cursor names the last row that did - which is the only way a
   * page can both honour the count and never repeat or skip a row.
   */
  test("a dual row costs two entries, and the page never exceeds its count", () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      const page = pageOf("Server/", level, {
        cursor: START,
        count,
        folders: bearing,
      });
      const entries = page.keys.length + (page.prefixes ?? []).length;
      expect(entries).toBeLessThanOrEqual(count);
      expect(entries).toBeGreaterThan(0);
    }
  });

  test("paging a level of dual rows answers every entry once, and ends", () => {
    for (const count of [1, 2, 3, 5]) {
      const seen: string[] = [];
      let cursor = START;
      let pages = 0;
      do {
        const page = pageOf("Server/", level, {
          cursor,
          count,
          folders: bearing,
        });
        seen.push(...page.keys, ...(page.prefixes ?? []));
        cursor = page.cursor;
        pages += 1;
        if (pages > 12) throw new Error(`the cursor did not advance at count ${count}`);
      } while (cursor !== END);
      // Five entries: two for the dual row (its key and its folder), one folder for the Object, and
      // two keys for the leaf Variable and the Method. At count 1 the dual row is answered as its
      // folder alone, so one entry fewer.
      expect(new Set(seen).size).toBe(count === 1 ? 4 : 5);
      expect(seen.length).toBe(new Set(seen).size);
    }
  });

  /** A page of one cannot hold a dual row whole: the folder wins, because the subtree is only reachable through it. */
  test("a dual row on a page of one is answered as the folder, and the walk still advances", () => {
    const page = pageOf("Server/", [level[0] as OpcuaReference], {
      cursor: START,
      count: 1,
      folders: bearing,
    });
    expect(page.prefixes).toEqual(["Server/ServerStatus/"]);
    expect(page.keys).toEqual([]);
    expect(page.cursor).toBe("after:Server/ServerStatus");
    // AND IT SAYS SO, through the one field the contract has for "read and left out": dropping the
    // key in silence would make the value unreachable with nothing anywhere saying why.
    expect(page.skipped?.count).toBe(1);
    expect(page.skipped?.reason).toMatch(/both a node with a value and a folder/);
  });

  /** On any page that fits the row whole there is nothing left out, so the field stays absent. */
  test("a page that holds the dual row whole reports nothing skipped", () => {
    const page = pageOf("Server/", level, {
      cursor: START,
      count: 10,
      folders: bearing,
    });
    expect(page.skipped).toBeUndefined();
  });
});

/**
 * A NODE THE SERVER GIVES NO NAME TAKES NO LEVEL WITH IT. `QualifiedName.name` is `string | null` in
 * the library and `library.ts` substitutes `""`, so the path key became the level's own prefix -
 * `""` at the root - which the route refuses outright: measured through the real route, ONE such
 * reference answered `500 opcua answered a key outside the level it was asked for: ""` for the
 * whole root page, and the Keys panel is this engine's only listing surface.
 */
describe("a node with no browse name", () => {
  const level = [reference(""), reference("Ok"), reference("")];

  test("it is left out, and the rest of the level is answered", () => {
    const page = pageOf("", level, { cursor: START, count: 50 });
    expect(page.keys).toEqual(["Ok"]);
    expect(page.prefixes).toEqual([]);
    for (const key of page.keys) expect(key).not.toBe("");
    expect(page.cursor).toBe(END);
  });

  test("the page says how many it left out, and why", () => {
    const page = pageOf("", level, { cursor: START, count: 50 });
    expect(page.skipped?.count).toBe(2);
    expect(page.skipped?.reason).toMatch(/carry no browse name/);
    // The node ids still read them, which the sentence says: that is the one way left.
    expect(page.skipped?.reason).toMatch(/name one in a read request/);
  });

  test("inside a folder it is left out too, where the key would have been the folder's own prefix", () => {
    const page = pageOf("Server/", level, { cursor: START, count: 50 });
    expect(page.keys).toEqual(["Server/Ok"]);
    expect(page.keys).not.toContain("Server/");
    expect(page.skipped?.count).toBe(2);
  });

  /** A level of nothing but nameless nodes is empty and finished, rather than a page of one row. */
  test("a level of nothing but nameless nodes ends", () => {
    const page = pageOf("", [reference("")], { cursor: START, count: 50 });
    expect(page.keys).toEqual([]);
    expect(page.cursor).toBe(END);
    expect(page.skipped?.count).toBe(1);
  });
});

describe("the escaped separator, measured on the fixture", () => {
  /**
   * The real name: Microsoft ships a BrowseName holding every candidate separator at once as a
   * torture test. Its key is escaped, so the panel still sees one segment.
   */
  const AWKWARD = "Special_\"!§$%&/()=?`´\\+~*'#_-:.;,<>|@^°€µ{[]}";

  test("a name holding every candidate separator stays one segment", () => {
    const page = pageOf("Objects/", [reference(AWKWARD)], {
      cursor: START,
      count: 10,
    });
    const key = page.keys[0] as string;
    expect(pathSegments(key)).toEqual(["Objects", AWKWARD]);
    expect(key.split("/")).toHaveLength(2);
  });

  test("a namespace URI used as a BrowseName does not grow three levels", () => {
    const name = "http://microsoft.com/Opc/OpcPlc/Boiler";
    const page = pageOf("Objects/", [reference(name)], {
      cursor: START,
      count: 10,
    });
    expect(pathSegments(page.keys[0] as string)).toEqual(["Objects", name]);
  });
});

describe("paging one level, in the route's own cursor spellings", () => {
  /** The measured worst case: one node under the Objects folder has 100 children. */
  const hundred = Array.from({ length: 100 }, (_, at) => reference(`N${String(at).padStart(3, "0")}`));

  test("a page holds what was asked for and the cursor names the entry it ended on", () => {
    const first = pageOf("", hundred, { cursor: START, count: 40 });
    expect(first.keys).toHaveLength(40);
    expect(first.cursor).toBe("after:N039");
  });

  /**
   * THE END OF A LEVEL IS `"0"`, AND NOTHING ELSE WORKS. `use-key-scan.ts` reads `page.cursor === "0"`
   * as the only end-of-walk signal, and `POST /api/db/keys/scan` refuses an empty cursor, so a level
   * that ended with `""` - which this provider did, with every test here agreeing - left List more,
   * List all and every folder's Load more enabled for ever, and the next press was an HTTP 400.
   */
  test("the last page ends the level with the cursor the panel reads as the end", () => {
    const last = pageOf("", hundred, { cursor: "after:N079", count: 40 });
    expect(last.keys).toHaveLength(20);
    expect(last.cursor).toBe(END);
  });

  test("a level that fits in one page ends in that page", () => {
    const only = pageOf("", hundred, { cursor: START, count: 1_000 });
    expect(only.keys).toHaveLength(100);
    expect(only.cursor).toBe(END);
  });

  test("the pages together are the level, once, in order", () => {
    const seen: string[] = [];
    let cursor = START;
    let pages = 0;
    do {
      const page = pageOf("", hundred, { cursor, count: 30 });
      seen.push(...page.keys, ...(page.prefixes ?? []));
      cursor = page.cursor;
      pages += 1;
      // A level of 100 in pages of 30 is four pages; anything more is a cursor that does not advance.
      if (pages > 10) throw new Error("the cursor did not advance");
    } while (cursor !== END);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    expect(seen).toEqual([...seen].sort());
  });

  /**
   * A NODE CAN BE CALLED `0`, and `"0"` is the route's word for both ends of a walk. A cursor spelled
   * as the bare entry name made the two the same string: measured, a root level of `["0","A","B"]`
   * answered `["A","B"]` on its first page, with `total: 0` contradicting nothing. The `after:`
   * prefix is what keeps them apart.
   */
  test("a node named 0 is on the first page, because a cursor is never a bare entry name", () => {
    const level = [reference("0"), reference("A"), reference("B")];
    const page = pageOf("", level, { cursor: START, count: 10 });
    expect(page.keys).toEqual(["0", "A", "B"]);
    const paged = pageOf("", level, { cursor: START, count: 1 });
    expect(paged.keys).toEqual(["0"]);
    expect(paged.cursor).toBe("after:0");
    expect(pageOf("", level, { cursor: paged.cursor, count: 10 }).keys).toEqual(["A", "B"]);
  });

  /**
   * UTF-8 BYTE ORDER, WHICH IS THE CONTRACT, and JavaScript's `<` is not it: `\uFF21` sorts before
   * `\u{10000}` by code unit and after it by byte, so a level holding a name outside the BMP would
   * page differently on the two orders and a row could be skipped or repeated.
   */
  test("the order is UTF-8 byte order, not UTF-16 code-unit order", () => {
    const outside = String.fromCodePoint(0x1_0000); // U+10000, a surrogate pair in UTF-16
    const wide = "\uFF21"; // U+FF21, one code unit, three UTF-8 bytes
    const page = pageOf("", [reference(outside), reference(wide)], {
      cursor: START,
      count: 10,
    });
    expect(page.keys).toEqual([wide, outside]);
    // The control: the two orders disagree on this pair, so the assertion above is about the order
    // and not about the pair. UTF-16 puts the surrogate pair first; UTF-8 puts the three-byte name first.
    expect([outside, wide].sort()).toEqual([outside, wide]);
    expect(Buffer.compare(Buffer.from(wide, "utf8"), Buffer.from(outside, "utf8"))).toBe(-1);
  });

  /**
   * A VANISHED ENTRY IS RESUMED PAST, NOT RESTARTED. The cursor named a position before this, so a
   * node deleted between two pages left `findIndex` at -1 and `-1 + 1` started the level again: the
   * reader pressed Load more and was handed page one, for ever. Resuming at the first key AFTER the
   * name - by name, not by position - neither repeats a row nor skips one.
   */
  test("a cursor whose own entry is gone resumes at what now follows it", () => {
    const left = hundred.filter((row) => row.browseName !== "N040");
    const page = pageOf("", left, { cursor: "after:N040", count: 5 });
    expect(page.keys).toEqual(["N041", "N042", "N043", "N044", "N045"]);
  });

  test("a cursor past every entry of the level ends it rather than restarting it", () => {
    const page = pageOf("", hundred, { cursor: "after:N999", count: 5 });
    expect(page.keys).toEqual([]);
    expect(page.cursor).toBe(END);
  });

  /**
   * A CURSOR IS BOUND TO ITS LEVEL. Measured before it was: a cursor from a sibling level was not
   * found among this level's entries, so the level restarted and the reader was served page one as
   * though it were page two.
   */
  test("a cursor from another level is refused by name", () => {
    expect(() => pageOf("", hundred, { cursor: "after:Objects/Z/Q", count: 5 })).toThrow(
      /cursor names an entry of "Objects\/Z\/"/,
    );
    expect(() => pageOf("Objects/Z/", hundred, { cursor: "after:N001", count: 5 })).toThrow(
      /this page is about "Objects\/Z\/"/,
    );
  });

  test("a cursor this provider did not write is refused rather than read as a start", () => {
    expect(() => pageOf("", hundred, { cursor: "7", count: 5 })).toThrow(/not written by the OPC UA provider/);
    expect(() => pageOf("", hundred, { cursor: "N039", count: 5 })).toThrow(DatabaseConfigError);
  });

  test("a count outside the capability's range is refused", () => {
    expect(() => pageOf("", hundred, { cursor: START, count: 0 })).toThrow(DatabaseConfigError);
    expect(() => pageOf("", hundred, { cursor: START, count: 1_001 })).toThrow(DatabaseConfigError);
  });

  /** Keys and prefixes are counted TOGETHER against the page's count, which the route enforces. */
  test("a page of folders and leaves together never exceeds the count", () => {
    const mixed = [
      ...Array.from({ length: 5 }, (_, at) => reference(`F${at}`, { mayHaveChildren: true, nodeClass: "Object" })),
      ...Array.from({ length: 5 }, (_, at) => reference(`L${at}`)),
    ];
    const folders = new Set<OpcuaNodeId>(Array.from({ length: 5 }, (_, at) => `ns=3;s=F${at}`));
    const page = pageOf("", mixed, { cursor: START, count: 4, folders });
    expect(page.keys.length + (page.prefixes ?? []).length).toBe(4);
  });

  /**
   * TWO CHILDREN OF ONE BROWSE NAME ARE ONE ROW, because the contract allows no entry twice on a
   * level page and both produce one path key. The one that is not a Method wins, so the row that
   * survives can still be opened; its node id says which node it is.
   */
  test("a duplicate browse name is answered once, and the row that survives is not the Method", () => {
    const level = [
      reference("Dup", { nodeId: "ns=3;s=DupMethod", nodeClass: "Method" }),
      reference("Dup", {
        nodeId: "ns=3;s=DupObject",
        nodeClass: "Object",
        mayHaveChildren: true,
      }),
    ];
    const slice = levelSlice("", level, { cursor: START, count: 10 });
    expect(slice.rows).toHaveLength(1);
    expect(slice.rows[0]?.nodeId).toBe("ns=3;s=DupObject");
    // And the other way round, so the order the server answered in is not what decided it.
    const reversed = levelSlice("", [...level].reverse(), {
      cursor: START,
      count: 10,
    });
    expect(reversed.rows[0]?.nodeId).toBe("ns=3;s=DupObject");
  });
});

describe("a node reachable from two parents", () => {
  /**
   * 41 of the fixture's 6,769 nodes have more than one path. The same node id appears under each
   * parent, with a different key, which is what the server publishes.
   */
  test("it appears under each parent, with its own key and the same node id", () => {
    const shared = reference("SouthMotor", {
      nodeId: "ns=6;s=1:Metals/SouthMotor",
    });
    const underA = pageOf("Objects/Metals/", [shared], {
      cursor: START,
      count: 10,
    });
    const underB = pageOf("Objects/Lines/Line1/", [shared], {
      cursor: START,
      count: 10,
    });
    expect(underA.keys[0]).toBe("Objects/Metals/SouthMotor");
    expect(underB.keys[0]).toBe("Objects/Lines/Line1/SouthMotor");
    expect(underA.rows[0]?.nodeId).toBe(underB.rows[0]?.nodeId);
  });

  /**
   * And a node id holding the separator is not a path. One of the documented fixture's 6,769 ids
   * contains `/`; the Eclipse Milo demo, whose shape this fixture uses, writes whole paths into its
   * ids, which is where `1:Metals/SouthMotor` comes from.
   */
  test("a node id holding the separator is never used as a key", () => {
    const shared = reference("SouthMotor", {
      nodeId: "ns=6;s=1:Metals/SouthMotor",
    });
    const page = pageOf("Objects/", [shared], { cursor: START, count: 10 });
    expect(page.keys[0]).toBe("Objects/SouthMotor");
    expect(page.keys[0]).not.toContain("1:Metals");
  });
});

/** A client that answers browses from a map and records what it was asked and released. */
function clientFrom(
  tree: Readonly<Record<string, OpcuaBrowseResult>>,
  record: { asked: OpcuaNodeId[][]; released: Uint8Array[][]; nexts: number },
): OpcuaReadOnlyClient {
  return {
    endpoints: async () => [],
    limits: async () => ({}),
    browse: async (nodeIds) => {
      record.asked.push([...nodeIds]);
      return nodeIds.map((nodeId) => tree[nodeId] ?? { nodeId, references: [], statusCode: "Good" });
    },
    browseNext: async (points) => {
      record.nexts += 1;
      const key = `next:${record.nexts}`;
      return [
        tree[key] ?? {
          nodeId: key,
          references: [],
          statusCode: "Good",
          ...(points.length === 0 ? {} : {}),
        },
      ];
    },
    releaseBrowseContinuationPoints: async (points) => {
      record.released.push([...points]);
    },
    read: async () => [],
    historyRead: async () => ({ nodeId: "", values: [], statusCode: "Good" }),
    historyReadNext: async () => ({
      nodeId: "",
      values: [],
      statusCode: "Good",
    }),
    releaseHistoryContinuationPoint: async () => {},
    close: async () => {},
  };
}

const fresh = () => ({
  asked: [] as OpcuaNodeId[][],
  released: [] as Uint8Array[][],
  nexts: 0,
});

/**
 * A REFUSED BROWSE IS NOT AN EMPTY NODE. A Browse answers per node, and a refusal comes back as a
 * status with an EMPTY reference list: measured on the documented fixture, `ns=9;s=NoSuchNode`
 * answered `BadNodeIdUnknown` with no references, which this module returned as `[]` - so a level
 * the server refused opened as a folder with nothing in it, and the walk down a path said "No node
 * named X" for a level nobody had been allowed to read.
 */
describe("the server's own answer about a Browse", () => {
  test("a refused Browse is the server's status, not an empty level", async () => {
    const record = fresh();
    const client = clientFrom(
      {
        "ns=9;s=Gone": {
          nodeId: "ns=9;s=Gone",
          references: [],
          statusCode: "BadNodeIdUnknown",
        },
      },
      record,
    );
    await expect(browseLevel(client, "ns=9;s=Gone")).rejects.toThrow(/has no node with that id/);
    // The remedy travels with it: a saved `ns=` id may address nothing after a restart.
    await expect(browseLevel(client, "ns=9;s=Gone")).rejects.toThrow(/namespace index/);
  });

  test("a refusal on a CONTINUED page is read too, not just on the first", async () => {
    const record = fresh();
    const client = clientFrom(
      {
        "ns=3;s=Folder": {
          nodeId: "ns=3;s=Folder",
          references: [reference("A")],
          continuationPoint: new Uint8Array([1]),
          statusCode: "Good",
        },
        "next:1": {
          nodeId: "ns=3;s=Folder",
          references: [],
          statusCode: "BadTooManyOperations",
        },
      },
      record,
    );
    await expect(browseLevel(client, "ns=3;s=Folder")).rejects.toThrow(/more nodes than the server will take/);
  });

  test("Good and Uncertain both pass, which is what makes the line above about refusals", async () => {
    const record = fresh();
    for (const statusCode of ["Good", "GoodMoreData", "UncertainSubNormal"]) {
      const client = clientFrom(
        {
          "ns=3;s=F": {
            nodeId: "ns=3;s=F",
            references: [reference("A")],
            statusCode,
          },
        },
        record,
      );
      expect((await browseLevel(client, "ns=3;s=F")).map((row) => row.browseName)).toEqual(["A"]);
    }
  });
});

describe("one level, however many answers the server splits it into", () => {
  test("a paged level is followed to its end inside the one request", async () => {
    const record = fresh();
    const client = clientFrom(
      {
        "ns=3;s=Folder": {
          nodeId: "ns=3;s=Folder",
          references: [reference("A")],
          continuationPoint: new Uint8Array([1]),
          statusCode: "Good",
        },
        "next:1": {
          nodeId: "ns=3;s=Folder",
          references: [reference("B")],
          continuationPoint: new Uint8Array([2]),
          statusCode: "Good",
        },
        "next:2": {
          nodeId: "ns=3;s=Folder",
          references: [reference("C")],
          statusCode: "Good",
        },
      },
      record,
    );
    const references = await browseLevel(client, "ns=3;s=Folder");
    expect(references.map((row) => row.browseName)).toEqual(["A", "B", "C"]);
    expect(record.nexts).toBe(2);
  });

  test("a level whose node the server does not answer at all is empty, not a throw", async () => {
    const record = fresh();
    const client: OpcuaReadOnlyClient = {
      ...clientFrom({}, record),
      browse: async () => [],
    };
    expect(await browseLevel(client, "ns=3;s=Gone")).toEqual([]);
  });

  test("a continuation that answers nothing ends the level where it stood", async () => {
    const record = fresh();
    const client: OpcuaReadOnlyClient = {
      ...clientFrom(
        {
          "ns=3;s=Folder": {
            nodeId: "ns=3;s=Folder",
            references: [reference("A")],
            continuationPoint: new Uint8Array([1]),
            statusCode: "Good",
          },
        },
        record,
      ),
      browseNext: async () => [],
    };
    expect((await browseLevel(client, "ns=3;s=Folder")).map((row) => row.browseName)).toEqual(["A"]);
  });
});

describe("a level the server never stops listing", () => {
  /** A server that answers every Browse and BrowseNext of the folder with `per` references and a fresh point. */
  function endless(per: number) {
    const record = fresh();
    let points = 0;
    const page = (): OpcuaBrowseResult => {
      points += 1;
      return {
        nodeId: "ns=3;s=Folder",
        references: Array.from({ length: per }, (_, at) => reference(`R${points}-${at}`)),
        continuationPoint: new Uint8Array([points % 256, Math.floor(points / 256)]),
        statusCode: "Good",
      };
    };
    const client: OpcuaReadOnlyClient = {
      ...clientFrom({}, record),
      browse: async () => [page()],
      browseNext: async () => {
        record.nexts += 1;
        return [page()];
      },
    };
    return { client, record, last: () => new Uint8Array([points % 256, Math.floor(points / 256)]) };
  }

  test("stops at the continuation bound, hands the point back, and refuses rather than answering part", async () => {
    const { client, record, last } = endless(1);
    const refused = await browseLevel(client, "ns=3;s=Folder").catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("refused rather than shown in part");
    expect(record.nexts).toBe(OPCUA_BROWSE_LEVEL_MAX_CONTINUATIONS);
    expect(record.released).toEqual([[last()]]);
  });

  test("stops at the reference bound, hands the point back, and refuses rather than answering part", async () => {
    const { client, record, last } = endless(OPCUA_BROWSE_LEVEL_MAX_REFERENCES / 2);
    const refused = await browseLevel(client, "ns=3;s=Folder").catch((error: Error) => error);
    expect((refused as Error).message).toContain("refused rather than shown in part");
    expect(record.nexts).toBe(2);
    expect(record.released).toEqual([[last()]]);
  });
});

/**
 * WHICH ROWS ARE FOLDERS IS MEASURED, because a server publishes no such flag and a folder that
 * opens empty costs the reader a click to learn nothing.
 */
describe("the folder flag is measured, one Browse round over the level", () => {
  test("a row with children is a folder and a row without one is not", async () => {
    const record = fresh();
    const level = [
      reference("Slow", { nodeClass: "Object", mayHaveChildren: true }),
      reference("SlowUInt1"),
      reference("ResetToServerDefaults", {
        nodeClass: "Method",
        mayHaveChildren: false,
      }),
    ];
    const client = clientFrom(
      {
        "ns=3;s=Slow": {
          nodeId: "ns=3;s=Slow",
          references: [reference("SlowUInt1")],
          statusCode: "Good",
        },
        "ns=3;s=SlowUInt1": {
          nodeId: "ns=3;s=SlowUInt1",
          references: [],
          statusCode: "Good",
        },
      },
      record,
    );
    const folders = await childBearingNodes(client, level);
    expect(folders.has("ns=3;s=Slow")).toBe(true);
    expect(folders.has("ns=3;s=SlowUInt1")).toBe(false);
    // A method is never asked about: O-S1 decided it is listed and never browsed.
    expect(record.asked.flat()).not.toContain("ns=3;s=ResetToServerDefaults");

    const page = pageOf("", level, { cursor: START, count: 10, folders });
    // A folder is a prefix, not a key: that is what makes its row expandable.
    expect(page.prefixes).toEqual(["Slow/"]);
    expect(page.types.SlowUInt1).toBe("variable");
    expect(page.types.ResetToServerDefaults).toBe("method");
  });

  /** A point handed back means there are more children than one answer carried: released, not followed. */
  test("a continuation point from the measurement round is released rather than followed", async () => {
    const record = fresh();
    const level = [reference("Busy", { nodeClass: "Object", mayHaveChildren: true })];
    const client = clientFrom(
      {
        "ns=3;s=Busy": {
          nodeId: "ns=3;s=Busy",
          references: [reference("First")],
          continuationPoint: new Uint8Array([9]),
          statusCode: "Good",
        },
      },
      record,
    );
    const folders = await childBearingNodes(client, level);
    expect(folders.has("ns=3;s=Busy")).toBe(true);
    expect(record.released).toEqual([[new Uint8Array([9])]]);
    // The page never follows it: one round, not a walk.
    expect(record.nexts).toBe(0);
  });

  test("a server's own browse limit chunks the measurement round", async () => {
    const record = fresh();
    const level = Array.from({ length: 7 }, (_, at) =>
      reference(`N${at}`, { nodeClass: "Object", mayHaveChildren: true }),
    );
    const client = clientFrom({}, record);
    await childBearingNodes(client, level, { maxNodesPerBrowse: 3 });
    expect(record.asked.map((batch) => batch.length)).toEqual([3, 3, 1]);
  });
});

describe("resolving a path down from the Objects folder", () => {
  test("each segment is matched on its browse name, and the node it names comes back", async () => {
    const record = fresh();
    const client = clientFrom(
      {
        "i=85": {
          nodeId: "i=85",
          references: [reference("OpcPlc", { nodeClass: "Object" })],
          statusCode: "Good",
        },
        "ns=3;s=OpcPlc": {
          nodeId: "ns=3;s=OpcPlc",
          references: [reference("Telemetry", { nodeClass: "Object" })],
          statusCode: "Good",
        },
      },
      record,
    );
    expect(await resolvePath(client, ["OpcPlc", "Telemetry"])).toBe("ns=3;s=Telemetry");
    expect(record.asked).toEqual([["i=85"], ["ns=3;s=OpcPlc"]]);
  });

  test("an empty path is the Objects folder itself, with nothing asked of the server", async () => {
    const record = fresh();
    expect(await resolvePath(clientFrom({}, record), [])).toBe("i=85");
    expect(record.asked).toEqual([]);
  });
});
