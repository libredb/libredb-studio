/**
 * Object order, and a test that measures its own premise first.
 *
 * A sorting test written with data both orderings agree on asserts nothing: it says "sorted by
 * sub-identifier" and would pass just as well against a textual sort. So the first test here
 * proves the two orderings DISAGREE on the data the rest of the file uses, and the rest is only
 * meaningful because that one passes.
 *
 * The data is not invented. These are the real arcs under mib-2 on the Net-SNMP snmpd 5.9.4
 * fixture, read on 13 October 2026, and the divergence they produce was measured there too:
 * on a page of five, the textual order never reaches twelve of the twenty-two.
 */
import { describe, expect, test } from "bun:test";
import {
  countFromWalk,
  UNAVAILABLE_REASONS,
  type UnavailableReason,
  assertMovesForward,
  compareOid,
  compareOidAsText,
  groupByKind,
  isWithinSubtree,
  nextWithinSubtree,
  sortObjects,
  type SnmpObject,
} from "@/lib/db/providers/network/snmp/objects";

/** The arcs the fixture's agent actually answered under 1.3.6.1.2.1. */
const MIB2_ARCS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17, 25, 31, 47, 49, 50, 88, 92];
const oidFor = (arc: number) => [1, 3, 6, 1, 2, 1, arc];

const object = (name: string, oid: readonly number[], kind: "table" | "scalars" = "table"): SnmpObject => ({
  kind,
  name,
  module: "TEST-MIB",
  oid,
});

describe("the premise: the two orderings disagree on this data", () => {
  test("sub-identifier order and dotted-text order are not the same list", () => {
    const numeric = [...MIB2_ARCS]
      .map(oidFor)
      .sort(compareOid)
      .map((o) => o.join("."));
    const textual = [...MIB2_ARCS]
      .map(oidFor)
      .sort(compareOidAsText)
      .map((o) => o.join("."));
    expect(numeric).not.toEqual(textual);
  });
  test("they disagree from the second entry, not somewhere deep in the tail", () => {
    const numeric = [...MIB2_ARCS].map(oidFor).sort(compareOid);
    const textual = [...MIB2_ARCS].map(oidFor).sort(compareOidAsText);
    const firstDifference = numeric.findIndex((o, i) => o.join(".") !== textual[i].join("."));
    expect(firstDifference).toBe(1);
  });
  test("the smallest pair that separates them", () => {
    const nine = [1, 3, 6, 1, 2, 1, 9];
    const ten = [1, 3, 6, 1, 2, 1, 10];
    expect(compareOid(nine, ten)).toBeLessThan(0);
    expect(compareOidAsText(nine, ten)).toBeGreaterThan(0);
  });
});

describe("objects come back in the order an agent walks them", () => {
  test("nine before ten, which a textual sort reverses", () => {
    const sorted = sortObjects([object("ten", [1, 3, 6, 1, 2, 1, 10]), object("nine", [1, 3, 6, 1, 2, 1, 9])]);
    expect(sorted.map((o) => o.name)).toEqual(["nine", "ten"]);
  });
  test("a prefix sorts before what extends it", () => {
    expect(compareOid([1, 3, 6], [1, 3, 6, 1])).toBeLessThan(0);
    expect(compareOid([1, 3, 6, 1], [1, 3, 6])).toBeGreaterThan(0);
    expect(compareOid([1, 3, 6], [1, 3, 6])).toBe(0);
  });
  test("a large sub-identifier is compared by value, not by digit count", () => {
    expect(compareOid([1, 4294967295], [1, 9])).toBeGreaterThan(0);
    expect(compareOidAsText([1, 4294967295], [1, 9])).toBeLessThan(0);
  });
  test("sorting does not mutate what it was given", () => {
    const given = [object("ten", [1, 10]), object("nine", [1, 9])];
    sortObjects(given);
    expect(given.map((o) => o.name)).toEqual(["ten", "nine"]);
  });
});

describe("both kinds are always present", () => {
  test("an empty input still answers both", () => {
    expect(Object.keys(groupByKind([])).sort()).toEqual(["scalars", "table"]);
  });
  test("a kind with nothing in it is empty rather than missing", () => {
    const grouped = groupByKind([object("ifTable", [1, 3, 6, 1, 2, 1, 2, 2])]);
    expect(grouped.scalars).toEqual([]);
    expect(grouped.table).toHaveLength(1);
  });
  test("each group keeps agent order", () => {
    const grouped = groupByKind([
      object("ten", [1, 3, 6, 1, 2, 1, 10], "scalars"),
      object("nine", [1, 3, 6, 1, 2, 1, 9], "scalars"),
    ]);
    expect(grouped.scalars.map((o) => o.name)).toEqual(["nine", "ten"]);
  });
});

describe("a walk knows when it has left its subtree", () => {
  const subtree = [1, 3, 6, 1, 2, 1, 2];
  test("a child is within", () => {
    expect(isWithinSubtree(subtree, [1, 3, 6, 1, 2, 1, 2, 2, 1, 1])).toBe(true);
  });
  test("the subtree itself is within", () => {
    expect(isWithinSubtree(subtree, subtree)).toBe(true);
  });
  test("the next sibling is not, even though it sorts straight after", () => {
    expect(isWithinSubtree(subtree, [1, 3, 6, 1, 2, 1, 3])).toBe(false);
  });
  test("a shorter OID is not within a longer subtree", () => {
    expect(isWithinSubtree(subtree, [1, 3, 6, 1])).toBe(false);
  });
  test("21 is not inside 2, which a text prefix check would get wrong", () => {
    expect(isWithinSubtree([1, 2], [1, 21])).toBe(false);
    expect("1.2".startsWith("1.2") && "1.21".startsWith("1.2")).toBe(true);
  });
  test("nextWithinSubtree stops rather than wandering", () => {
    expect(nextWithinSubtree(subtree, [1, 3, 6, 1, 2, 1, 2, 2])).toEqual([1, 3, 6, 1, 2, 1, 2, 2]);
    expect(nextWithinSubtree(subtree, [1, 3, 6, 1, 2, 1, 3])).toBeUndefined();
  });
});

describe("a walk refuses a step that does not move forward", () => {
  test("forward is allowed", () => {
    expect(() => assertMovesForward([1, 3, 6, 1, 9], [1, 3, 6, 1, 10])).not.toThrow();
  });
  test("standing still is refused", () => {
    expect(() => assertMovesForward([1, 3, 6, 1], [1, 3, 6, 1])).toThrow(/not forward/);
  });
  test("going backwards is refused, and the message says why it matters", () => {
    expect(() => assertMovesForward([1, 3, 6, 1, 10], [1, 3, 6, 1, 9])).toThrow(/does not end/);
  });
});

/**
 * A count is allowed only when the walk that produced it finished. The tests below separate the
 * two zeros the shared contract separates: `{ count: 0 }` is the agent saying it holds none,
 * and `{ unavailable }` is the question never having been answered.
 */
describe("a count is only ever taken from a walk that finished", () => {
  test("a finished walk gives the number it saw, and says where it came from", () => {
    expect(countFromWalk(7, true)).toEqual({
      count: 7,
      sampledFrom: "a walk that reached the end of its subtree",
    });
  });

  /**
   * The honest zero. A walk that reached the end of its subtree and saw nothing is the one case
   * where zero is a measurement rather than an absence of one.
   */
  test("a finished walk that saw nothing gives zero, which is a real answer", () => {
    expect(countFromWalk(0, true)).toMatchObject({ count: 0 });
  });

  /**
   * The dishonest one. Seven rows seen in a walk that stopped early is a floor, and reporting
   * it as a count tells a reader a short table is the whole table.
   */
  test("an unfinished walk never reports what it saw as a count, however much it saw", () => {
    for (const seen of [0, 1, 7, 4000]) {
      expect(countFromWalk(seen, false)).not.toHaveProperty("count");
      expect(countFromWalk(seen, false)).toHaveProperty("unavailable");
    }
  });

  test("each reason carries its own sentence, so a reader can tell them apart", () => {
    const reasons: UnavailableReason[] = ["notAsked", "outsideView", "budgetReached", "valueTooLarge"];
    const sentences = reasons.map((reason) => countFromWalk(3, false, reason));
    for (const [index, reason] of reasons.entries()) {
      expect(sentences[index]).toEqual({ unavailable: UNAVAILABLE_REASONS[reason] });
    }
    expect(new Set(sentences.map((s) => JSON.stringify(s))).size).toBe(4);
  });

  test("a stop with no reason given is reported as the budget, not as a blank", () => {
    expect(countFromWalk(3, false)).toEqual({ unavailable: UNAVAILABLE_REASONS.budgetReached });
    expect(countFromWalk(3, false, "budgetReached")).toEqual(countFromWalk(3, false));
  });

  /**
   * The two sentences a reader is most likely to confuse: one says we never asked, the other
   * says we asked and the answer cannot be told apart from absence.
   */
  test("not asking and asking outside the view are not the same sentence", () => {
    expect(UNAVAILABLE_REASONS.notAsked).not.toBe(UNAVAILABLE_REASONS.outsideView);
    expect(UNAVAILABLE_REASONS.outsideView).toContain("no count is claimed");
    expect(UNAVAILABLE_REASONS.notAsked).toContain("bundled MIB modules");
  });
});
