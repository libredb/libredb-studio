/**
 * The walk, driven without an agent.
 *
 * The state machine is given what came back and answers with the next move, so every rule about
 * when a walk STOPS can be tested by handing it the thing that should stop it. The case that
 * matters most is the one with no error in it at all: over SNMPv2c a walk that meets an object
 * no datagram can carry just stops, and a reader that treats "no error" as "complete" reports a
 * short table as a whole one. Measured against Net-SNMP snmpd 5.9.4 on 13 October 2026, four of
 * five rows and an ordinary end of walk.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveName,
  budgetSpent,
  describeEnd,
  fallBackToGetNext,
  firstRequest,
  startWalk,
  stepWalk,
  type Varbind,
  type WalkStep,
} from "@/lib/db/providers/network/snmp/read";
import {
  parseObjectName,
  DEFAULT_WALK_BUDGET,
  parseStatement,
  type WalkBudget,
} from "@/lib/db/providers/network/snmp/statement";

const SUBTREE = [1, 3, 6, 1, 2, 1, 2, 2];

/**
 * Narrowing helpers rather than casts. A cast would let the shape change underneath these tests
 * without any of them noticing, which is the same reason the silence arm has one in the error
 * tests: the union is the contract, and reading past it is how a test stops testing.
 */
const stopped = (step: WalkStep) => {
  if (step.kind !== "stop") throw new Error(`expected a stop, got ${step.kind}`);
  return step;
};
const asked = (step: WalkStep) => {
  if (step.kind !== "ask") throw new Error(`expected an ask, got ${step.kind}`);
  return step;
};
const vb = (oid: readonly number[], bytes = 10): Varbind => ({ oid, bytes });
const budget = (over: Partial<WalkBudget> = {}): WalkBudget => ({ ...DEFAULT_WALK_BUDGET, ...over });

describe("a statement becomes the right first request", () => {
  test("get sends a Get", () => {
    expect(firstRequest(parseStatement(["get", "1.3.6.1.2.1.1.1.0"]))).toMatchObject({ pdu: "get" });
  });
  test("next sends a GetNext", () => {
    expect(firstRequest(parseStatement(["next", "1.3.6.1.2.1.1"]))).toMatchObject({ pdu: "getNext" });
  });
  test("walk starts with a GetBulk, capped", () => {
    const request = firstRequest(parseStatement(["walk", "1.3.6.1.2.1.2.2"]));
    expect(request.pdu).toBe("getBulk");
    expect(request.maxRepetitions).toBeLessThanOrEqual(50);
  });
  test("a get carrying several names carries them all", () => {
    expect(firstRequest(parseStatement(["get", "1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"])).oids).toHaveLength(2);
  });
});

describe("a walk ends cleanly only when it reaches the end of its subtree", () => {
  test("endOfMibView finishes it", () => {
    const step = stepWalk(
      SUBTREE,
      budget(),
      startWalk(0),
      [{ oid: [...SUBTREE, 1, 1], status: "endOfMibView", bytes: 0 }],
      1,
    );
    expect(step).toMatchObject({ kind: "stop", end: { reason: "subtree", complete: true } });
  });
  test("stepping past the subtree finishes it", () => {
    const step = stepWalk(SUBTREE, budget(), startWalk(0), [vb([1, 3, 6, 1, 2, 1, 3])], 1);
    expect(step).toMatchObject({ kind: "stop", end: { reason: "subtree", complete: true } });
  });
  test("the varbind that took it past is not counted as a row", () => {
    const step = stepWalk(SUBTREE, budget(), startWalk(0), [vb([1, 3, 6, 1, 2, 1, 3])], 1);
    expect(step.state.rows).toBe(0);
  });
  test("a whole answer past the end is a finished walk, not an empty one", () => {
    /*
     * The shape a GetBulk really returns: several varbinds at once, all of them past the end of
     * the subtree. Nothing is read, and the two ways of reading nothing must not be mixed up -
     * an answer that carried objects from beyond the subtree is EVIDENCE that the subtree ended,
     * while an answer that carried no objects at all is the absence of evidence and is held
     * incomplete in the block below.
     *
     * This test exists because an internal guard in `stepWalk` claimed this case for itself and
     * returned the incomplete ending for it. The guard cannot run (its own comment says why it
     * is kept), and the case belongs here, where the answer is complete with no rows.
     */
    const past = [vb([1, 3, 6, 1, 2, 1, 3, 1]), vb([1, 3, 6, 1, 2, 1, 3, 2]), vb([1, 3, 6, 1, 2, 1, 4, 1])];
    const step = stopped(stepWalk(SUBTREE, budget(), startWalk(0), past, 1));
    expect(step.end).toMatchObject({ reason: "subtree", complete: true });
    expect(step.end.reason).not.toBe("empty");
    expect(step.state.rows).toBe(0);
    expect(describeEnd(step.end, 0)).toContain("reached the end of its subtree");
  });
  test("and the same answer after rows have been read is still a finished walk", () => {
    // The continuation case: the walk read four objects, then one request brought back only
    // objects from beyond the subtree. The rows already read are kept and the walk is complete.
    const after = stepWalk(SUBTREE, budget(), startWalk(0), [vb([...SUBTREE, 1, 4])], 1);
    const step = stopped(stepWalk(SUBTREE, budget(), after.state, [vb([1, 3, 6, 1, 2, 1, 3, 1])], 2));
    expect(step.end).toMatchObject({ reason: "subtree", complete: true });
    expect(step.state.rows).toBe(1);
  });
  test("staying inside asks again", () => {
    const step = stepWalk(SUBTREE, budget(), startWalk(0), [vb([...SUBTREE, 1, 1])], 1);
    expect(step.kind).toBe("ask");
    expect(step.state.rows).toBe(1);
  });
});

describe("an answer with no objects is not a finished walk either", () => {
  // The defect this block exists for: a GetBulk whose max-repetitions was zero came back with an
  // empty varbind list, `stepWalk` read it as the end of the subtree, and the console showed
  // "0 rows: the walk reached the end of its subtree" over a tree with sixteen objects in it.
  // Measured against a real net-snmp agent on 14 October 2026. The whole suite was green.
  test("it stops, and says it is NOT the end", () => {
    const step = stepWalk(SUBTREE, budget(), startWalk(0), [], 1);
    expect(step).toMatchObject({ kind: "stop", end: { reason: "empty", complete: false } });
  });
  test("it names the last object that did arrive, so the gap can be located", () => {
    const after = stepWalk(SUBTREE, budget(), startWalk(0), [vb([...SUBTREE, 1, 4])], 1);
    const empty = stopped(stepWalk(SUBTREE, budget(), after.state, [], 2));
    expect(empty.end).toMatchObject({ reason: "empty", lastSeen: [...SUBTREE, 1, 4] });
  });
  test("the sentence does not claim the subtree ended", () => {
    const step = stopped(stepWalk(SUBTREE, budget(), startWalk(0), [], 1));
    const said = describeEnd(step.end, 0);
    expect(said).toContain("no objects at all");
    expect(said).not.toContain("reached the end of its subtree");
  });
});

describe("a written name resolves to the identifier the MIB gives it", () => {
  // `get sysName.0` is the spelling the provider document teaches, and it answered with an
  // internal sentence about an unresolved name until the index was generated: nothing in the
  // build mapped a descriptor to an identifier. Measured live on 14 October 2026.
  test("a descriptor and its instance become one identifier", () => {
    expect(resolveName(parseObjectName("sysName.0"))).toEqual([1, 3, 6, 1, 2, 1, 1, 5, 0]);
  });
  test("a module qualifier reads the same as the bare descriptor", () => {
    expect(resolveName(parseObjectName("SNMPv2-MIB::sysName.0"))).toEqual(resolveName(parseObjectName("sysName.0")));
  });
  test("a name with no instance is the object itself, which is what a walk needs", () => {
    expect(resolveName(parseObjectName("system"))).toEqual([1, 3, 6, 1, 2, 1, 1]);
  });
  test("a name this build does not carry is refused in the user's terms, not with an internal note", () => {
    expect(() => resolveName(parseObjectName("sysNameThatIsNotReal.0"))).toThrow(
      /is not in any module this build carries/,
    );
  });
});

describe("silence is never a finished walk", () => {
  test("it stops, and says it is not the end", () => {
    const step = stepWalk(SUBTREE, budget(), startWalk(0), undefined, 1);
    expect(step).toMatchObject({ kind: "stop", end: { reason: "silence", complete: false } });
  });
  test("it names the last object that did arrive", () => {
    const after = stepWalk(SUBTREE, budget(), startWalk(0), [vb([...SUBTREE, 1, 4])], 1);
    const silent = stopped(stepWalk(SUBTREE, budget(), after.state, undefined, 2));
    expect(silent.end).toMatchObject({ reason: "silence", lastSeen: [...SUBTREE, 1, 4] });
  });
  test("the sentence says an oversized object looks the same, so the table is not done", () => {
    const text = describeEnd({ reason: "silence", complete: false, lastSeen: [1, 2] }, 4);
    expect(text).toContain("not the end of the table");
    expect(text).toContain("too large");
  });
  test("the clean ending does not carry that warning", () => {
    expect(describeEnd({ reason: "subtree", complete: true }, 4)).toContain("reached the end");
    expect(describeEnd({ reason: "subtree", complete: true }, 4)).not.toContain("not the end");
  });
});

describe("a budget stops the walk and names itself", () => {
  test("rows", () => {
    const state = { ...startWalk(0), rows: 5 };
    expect(budgetSpent(state, budget({ rows: 5 }), 1)).toBe("rows");
  });
  test("inbound bytes", () => {
    expect(budgetSpent({ ...startWalk(0), inboundBytes: 99 }, budget({ inboundBytes: 99 }), 1)).toBe("inboundBytes");
  });
  test("requests", () => {
    expect(budgetSpent({ ...startWalk(0), requests: 3 }, budget({ requests: 3 }), 1)).toBe("requests");
  });
  test("wall time", () => {
    expect(budgetSpent(startWalk(0), budget({ wallMs: 10 }), 10)).toBe("wallMs");
  });
  test("an unspent budget answers nothing", () => {
    expect(budgetSpent(startWalk(0), budget(), 1)).toBeUndefined();
  });
  test("the walk stops on it and says which one", () => {
    const step = stepWalk(SUBTREE, budget({ rows: 1 }), startWalk(0), [vb([...SUBTREE, 1, 1])], 1);
    expect(step).toMatchObject({ kind: "stop", end: { reason: "budget", complete: false, budget: "rows" } });
  });
  test("a DIFFERENT budget is named as itself, not as rows", () => {
    // The mutation run needed this: with only the rows case, hardcoding "rows" in the source
    // passed, so the test said the budget is named and did not check that it is the right one.
    const state = { ...startWalk(0), requests: 2 };
    const step = stopped(stepWalk(SUBTREE, budget({ requests: 3 }), state, [vb([...SUBTREE, 1, 1])], 1));
    expect(step.end).toMatchObject({ reason: "budget", budget: "requests" });
  });
  test("the sentence says there is more rather than implying completion", () => {
    expect(describeEnd({ reason: "budget", complete: false, budget: "rows" }, 9)).toContain("there is more");
  });
});

describe("a walk refuses to accept a step that is not forward", () => {
  test("a backwards answer stops it rather than looping", () => {
    const after = stepWalk(SUBTREE, budget(), startWalk(0), [vb([...SUBTREE, 1, 9])], 1);
    const back = stepWalk(SUBTREE, budget(), after.state, [vb([...SUBTREE, 1, 2])], 2);
    expect(back).toMatchObject({ kind: "stop", end: { reason: "notForward", complete: false } });
  });
  test("and the reason reaches the user", () => {
    const after = stepWalk(SUBTREE, budget(), startWalk(0), [vb([...SUBTREE, 1, 9])], 1);
    const back = stepWalk(SUBTREE, budget(), after.state, [vb([...SUBTREE, 1, 2])], 2);
    expect(describeEnd(stopped(back).end, 1)).toContain("did not move forward");
  });
});

describe("the fall back from GetBulk to GetNext goes one way", () => {
  test("after it, the walk asks with GetNext", () => {
    const state = fallBackToGetNext(stepWalk(SUBTREE, budget(), startWalk(0), [vb([...SUBTREE, 1, 1])], 1).state);
    const step = stepWalk(SUBTREE, budget(), state, [vb([...SUBTREE, 1, 2])], 2);
    expect(step).toMatchObject({ kind: "ask", request: { pdu: "getNext" } });
  });
  test("and it does not go back to GetBulk by itself", () => {
    let state = fallBackToGetNext(startWalk(0));
    for (let i = 2; i < 6; i += 1) {
      const step = stepWalk(SUBTREE, budget(), state, [vb([...SUBTREE, 1, i])], i);
      expect(asked(step).request.pdu).toBe("getNext");
      state = step.state;
    }
  });
});

/**
 * Every test above hands `stepWalk` one answer and reads the result, so all of them
 * would pass a walk that threw away everything it had learned at each datagram boundary.
 *
 * Measured on 13 October 2026, with the single-answer tests as the only coverage: resetting the
 * row count to 1 at each step, resetting the inbound byte count, and freezing the cursor at the
 * first datagram's OID all left the suite green. The last of those three is not a reporting
 * detail. The cursor is what the next GetBulk continues from, so a walk that never advanced it
 * would ask the same question forever and the tests would have agreed.
 *
 * A walk is not one answer. These drive four datagrams through it and read the totals.
 */
describe("a walk that spans several datagrams keeps what it learned", () => {
  const PAGE = [
    [vb([...SUBTREE, 1, 1], 12), vb([...SUBTREE, 1, 2], 12), vb([...SUBTREE, 1, 3], 12)],
    [vb([...SUBTREE, 1, 4], 20), vb([...SUBTREE, 1, 5], 20)],
    [vb([...SUBTREE, 1, 6], 7)],
    [vb([...SUBTREE, 2, 1], 31), vb([...SUBTREE, 2, 2], 31)],
  ];

  /** Walks the four pages and hands back the step each one produced. */
  const walkPages = () => {
    const steps: WalkStep[] = [];
    let state = startWalk(0);
    PAGE.forEach((page, index) => {
      const step = stepWalk(SUBTREE, budget(), state, page, index + 1);
      steps.push(step);
      state = step.state;
    });
    return { steps, state };
  };

  test("the row count is the total across all four, not the last one's", () => {
    expect(walkPages().state.rows).toBe(8);
  });

  test("the inbound byte count adds up across all four", () => {
    expect(walkPages().state.inboundBytes).toBe(36 + 40 + 7 + 62);
    expect(walkPages().state.inboundBytes).toBe(145);
  });

  test("one datagram's answer is counted as one request, not one per varbind", () => {
    expect(walkPages().state.requests).toBe(4);
  });

  test("the cursor advances through every datagram and ends on the last OID seen", () => {
    expect(walkPages().state.last).toEqual([...SUBTREE, 2, 2]);
  });

  /**
   * The cursor is read back out of the request rather than out of the state, because the
   * request is what the agent sees. A cursor that advanced internally and was sent stale would
   * loop just as surely, and reading the state alone cannot tell the two apart.
   */
  test("each request continues from where the datagram before it stopped", () => {
    const { steps } = walkPages();
    expect(asked(steps[0]).request.oids[0]).toEqual([...SUBTREE, 1, 3]);
    expect(asked(steps[1]).request.oids[0]).toEqual([...SUBTREE, 1, 5]);
    expect(asked(steps[2]).request.oids[0]).toEqual([...SUBTREE, 1, 6]);
    expect(asked(steps[3]).request.oids[0]).toEqual([...SUBTREE, 2, 2]);
  });

  test("no two requests in the run ask the same question", () => {
    const asks = walkPages().steps.map((step) => asked(step).request.oids[0].join("."));
    expect(new Set(asks).size).toBe(asks.length);
  });

  /**
   * The budget is spent by the whole walk and not by each datagram, which is the same accrual
   * seen from the other side: a per-datagram counter would never reach a limit of five.
   */
  test("a row budget is reached by the datagrams together", () => {
    let state = startWalk(0);
    let stop;
    for (const [index, page] of PAGE.entries()) {
      const step = stepWalk(SUBTREE, budget({ rows: 5 }), state, page, index + 1);
      state = step.state;
      if (step.kind === "stop") {
        stop = step;
        break;
      }
    }
    expect(stopped(stop as WalkStep).end).toMatchObject({ reason: "budget", complete: false });
    expect(state.rows).toBeGreaterThanOrEqual(5);
  });

  test("silence after several datagrams names the last OID the run actually reached", () => {
    const { state } = walkPages();
    const end = stopped(stepWalk(SUBTREE, budget(), state, undefined, 9)).end;
    // Narrowed through the union rather than read past it. `lastSeen` lives on the silence arm
    // alone, and reaching for it on the union is how a test stops following the contract.
    if (end.reason !== "silence") throw new Error(`expected silence, got ${end.reason}`);
    expect(end.complete).toBe(false);
    expect(end.lastSeen).toEqual([...SUBTREE, 2, 2]);
  });
});
