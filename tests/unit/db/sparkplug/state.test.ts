/**
 * The birth, alias, seq and bdSeq rules, with the cases a capture cannot stage: a previous
 * session's death arriving after the new birth, a seq gap, an alias with no birth, and a stored
 * birth that a live one must beat.
 *
 * The two facts this file is built on were MEASURED by this session on 2026-10-13 against
 * Mosquitto 2.1.2 and HiveMQ CE 2026.5, both with their Sparkplug Aware plugins: a rebirth
 * REPLACES the stored birth, and NDEATH/DDEATH DO NOT REMOVE it. See the header of `state.ts`.
 */
import { describe, expect, test } from "bun:test";
import { birthReplaces, ReadState } from "@/lib/db/providers/industrial/sparkplug/state";
import type { BirthRecord } from "@/lib/db/providers/industrial/sparkplug/state";
import { parseTopic } from "@/lib/db/providers/industrial/sparkplug/topics";
import type { NodeTopic } from "@/lib/db/providers/industrial/sparkplug/topics";

const topic = (t: string) => parseTopic(t) as NodeTopic;
const NBIRTH = topic("spBv1.0/G1/NBIRTH/E1");
const NBIRTH_STORED = topic("$sparkplug/certificates/spBv1.0/G1/NBIRTH/E1");
const DBIRTH = topic("spBv1.0/G1/DBIRTH/E1/D1");
const NDEATH = topic("spBv1.0/G1/NDEATH/E1");
const NDATA = topic("spBv1.0/G1/NDATA/E1");
const DDATA = topic("spBv1.0/G1/DDATA/E1/D1");

function birth(over: Partial<BirthRecord> = {}): BirthRecord {
  return {
    origin: "live",
    bdSeq: "0",
    receivedAt: 1_000,
    metrics: [
      { name: "ints/i8", alias: "2", datatype: 1 },
      { name: "f/temp", alias: "3", datatype: 9 },
    ],
    ...over,
  };
}

describe("the unresolved counter is held from BOTH sides (KURAL 112)", () => {
  /*
   * Shifting `count < 0` to `< -1` broke no test, which means nothing held the line at zero. The
   * counter is additive and feeds a sentence a reader acts on, so a negative would subtract a loss
   * that happened from a loss the panel reports.
   */
  test("zero is accepted and minus one is refused", () => {
    const state = new ReadState();
    expect(() => state.noteUnresolved(0)).not.toThrow();
    expect(state.summary().unresolvedValues).toBe(0);
    expect(() => state.noteUnresolved(-1)).toThrow(RangeError);
  });

  test("two folds into one state add up rather than replacing each other", () => {
    const state = new ReadState();
    state.noteUnresolved(2);
    state.noteUnresolved(3);
    expect(state.summary().unresolvedValues).toBe(5);
  });
});

describe("a definition's existence and a node's liveness are separate answers", () => {
  test("a stored birth alone leaves the node not seen in this read", () => {
    // The measured reason: a death does not remove the stored birth, so its presence cannot mean
    // the node is up.
    const state = new ReadState();
    state.takeBirth(NBIRTH_STORED, birth({ origin: "stored" }));
    const node = state.all()[0];
    expect(node.birth?.origin).toBe("stored");
    expect(node.liveness.kind).toBe("not-seen-in-this-read");
  });

  test("a node can have a stored birth AND have been seen to die in the same read", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH_STORED, birth({ origin: "stored" }));
    expect(state.takeDeath(NDEATH, "0", 5_000)).toBe("applied");
    const node = state.all()[0];
    expect(node.birth?.origin).toBe("stored");
    expect(node.liveness).toEqual({ kind: "death-seen-in-this-read", deathSeenAt: 5_000, bdSeq: "0" });
  });

  test("the summary counts what was seen and has no online count at all", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH_STORED, birth({ origin: "stored" }));
    state.takeBirth(DBIRTH, birth({ origin: "live" }));
    state.takeDeath(NDEATH, "0", 5_000);
    const summary = state.summary();
    expect(summary).toMatchObject({ edgeNodes: 1, devices: 1, birthsStored: 1, birthsLive: 1, deathsSeen: 1 });
    expect(Object.keys(summary)).not.toContain("online");
  });
});

describe("a death's time comes from receipt, never from the payload", () => {
  test("the receipt time the caller passes is what is recorded", () => {
    // MEASURED: with a Will payload whose timestamp was 1000, Mosquitto delivered 1000 and
    // HiveMQ CE delivered its own receipt time. The payload timestamp is therefore not consulted.
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth());
    state.takeDeath(NDEATH, "0", 1_760_000_000_123);
    const liveness = state.all()[0].liveness;
    expect(liveness.kind).toBe("death-seen-in-this-read");
    if (liveness.kind === "death-seen-in-this-read") expect(liveness.deathSeenAt).toBe(1_760_000_000_123);
  });

  test("takeDeath has no way to read a payload timestamp", () => {
    // A structural check rather than a behavioural one: the signature takes a receipt time and a
    // bdSeq, so there is no argument a payload timestamp could arrive in.
    expect(ReadState.prototype.takeDeath).toHaveLength(3);
  });
});

describe("a previous session's death does not kill the new session", () => {
  test("a death whose bdSeq does not match the birth in hand is ignored", () => {
    // 5.4: "timing with Will Messages may result in NDEATH messages arriving after a new/next
    // NBIRTH message". MEASURED in passing on Mosquitto: the dead session's NDEATH carried bdSeq 0
    // while the next session's NBIRTH carried 1.
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ bdSeq: "1", receivedAt: 2_000 }));
    expect(state.takeDeath(NDEATH, "0", 3_000)).toBe("ignored-stale");
    expect(state.all()[0].liveness.kind).toBe("published-during-read");
  });

  test("a matching bdSeq applies", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ bdSeq: "1" }));
    expect(state.takeDeath(NDEATH, "1", 3_000)).toBe("applied");
  });

  test("a death with no bdSeq is applied, because there is nothing to contradict", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ bdSeq: "1" }));
    expect(state.takeDeath(NDEATH, undefined, 3_000)).toBe("applied");
  });
});

describe("a newer birth replaces an older one, and a live birth beats a stored one", () => {
  test("bdSeq decides between two live births", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ bdSeq: "5", metrics: [{ name: "old", alias: "9", datatype: 1 }] }));
    state.takeBirth(NBIRTH, birth({ bdSeq: "6", metrics: [{ name: "new", alias: "9", datatype: 1 }] }));
    expect(state.all()[0].birth?.metrics[0].name).toBe("new");
  });

  test("an older bdSeq does not replace a newer birth", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ bdSeq: "6", metrics: [{ name: "new", alias: "9", datatype: 1 }] }));
    state.takeBirth(NBIRTH, birth({ bdSeq: "5", metrics: [{ name: "old", alias: "9", datatype: 1 }] }));
    expect(state.all()[0].birth?.metrics[0].name).toBe("new");
  });

  test("a live birth replaces a stored one even with the same bdSeq", () => {
    // The stored copy is older by definition, and 10.1.4 says its values "can not be expected to
    // be the current values".
    const state = new ReadState();
    state.takeBirth(
      NBIRTH_STORED,
      birth({ origin: "stored", bdSeq: "0", metrics: [{ name: "old", alias: "2", datatype: 1 }] }),
    );
    state.takeBirth(
      NBIRTH,
      birth({ origin: "rebirth", bdSeq: "0", metrics: [{ name: "fresh", alias: "2", datatype: 1 }] }),
    );
    expect(state.all()[0].birth?.origin).toBe("rebirth");
    expect(state.all()[0].birth?.metrics[0].name).toBe("fresh");
  });

  test("bdSeq is compared as a 64-bit value, not as a JavaScript number", () => {
    // THE PAIR MATTERS. The first version of this test used 2^53+1 and 2^53+2, which differ as
    // doubles too, so it passed with `Number` in place of `BigInt` and a mutation run proved it
    // caught nothing. 2^53+1 and 2^53 are the pair that tells them apart: `Number` maps both to
    // 9007199254740992 and calls them equal, while as text they are different bdSeqs.
    expect(Number("9007199254740993")).toBe(Number("9007199254740992"));
    // The older bdSeq must NOT replace the newer. Under `Number` the two look equal and `>=`
    // answers true, which is the silent regression this asserts against.
    expect(birthReplaces("9007199254740993", "9007199254740992")).toBe(false);
    expect(birthReplaces("9007199254740992", "9007199254740993")).toBe(true);
  });

  test("a birth with no bdSeq replaces nothing and is replaced by anything", () => {
    expect(birthReplaces("0", undefined)).toBe(false);
    expect(birthReplaces(undefined, "0")).toBe(true);
  });

  test("a bdSeq that is not a number at all does not replace", () => {
    expect(birthReplaces("0", "not-a-number")).toBe(false);
  });
});

describe("an alias resolves only against a birth in hand", () => {
  test("with no birth, the value is unresolved and keeps its alias", () => {
    const state = new ReadState();
    const seen = state.resolve(NDATA, "40");
    expect(seen).toEqual({ alias: "40", unresolved: true, birthTime: false });
    expect(seen.name).toBeUndefined();
    expect(seen.datatype).toBeUndefined();
  });

  test("an alias the birth does not define stays unresolved", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth());
    expect(state.resolve(NDATA, "999").unresolved).toBe(true);
  });

  test("a device value resolves against its own birth first, then its node's", () => {
    // 6.4.6: aliases are unique across the NBIRTH and all its DBIRTHs, so the union is the scope.
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ metrics: [{ name: "node/metric", alias: "2", datatype: 1 }] }));
    state.takeBirth(DBIRTH, birth({ metrics: [{ name: "dev/p", alias: "40", datatype: 3 }] }));
    expect(state.resolve(DDATA, "40")).toMatchObject({ name: "dev/p", datatype: 3, unresolved: false });
    expect(state.resolve(DDATA, "2")).toMatchObject({ name: "node/metric", unresolved: false });
  });

  test("a value resolved from a stored birth is marked birth-time", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH_STORED, birth({ origin: "stored" }));
    expect(state.resolve(NDATA, "3")).toMatchObject({ name: "f/temp", birthTime: true });
  });

  test("a value resolved from a live birth is not birth-time", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ origin: "live" }));
    expect(state.resolve(NDATA, "3").birthTime).toBe(false);
  });

  test("an absent alias is unresolved rather than matched to the first metric", () => {
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth());
    expect(state.resolve(NDATA, undefined).unresolved).toBe(true);
  });
});

describe("a seq gap is flagged and never filled in", () => {
  test("successive seq values with a hole are recorded", () => {
    const state = new ReadState();
    state.takeSeq(NDATA, 1);
    state.takeSeq(NDATA, 2);
    state.takeSeq(NDATA, 7);
    expect(state.all()[0].seqGaps).toEqual([{ expected: 3, saw: 7 }]);
  });

  test("the wrap from 255 to 0 is a continuation, not a gap", () => {
    const state = new ReadState();
    state.takeSeq(NDATA, 254);
    state.takeSeq(NDATA, 255);
    state.takeSeq(NDATA, 0);
    expect(state.all()[0].seqGaps).toHaveLength(0);
  });

  test("the first seq seen cannot be a gap", () => {
    const state = new ReadState();
    state.takeSeq(NDATA, 42);
    expect(state.all()[0].seqGaps).toHaveLength(0);
  });

  test("data after a death does not undo the death", () => {
    // A late data message from the dead session must not flip the panel back to published.
    const state = new ReadState();
    state.takeBirth(NBIRTH, birth({ bdSeq: "0" }));
    state.takeDeath(NDEATH, "0", 5_000);
    state.takeSeq(NDATA, 9);
    expect(state.all()[0].liveness.kind).toBe("death-seen-in-this-read");
  });
});
