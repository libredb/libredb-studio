/**
 * The agent's SNMP reads over an in-memory client: values rendered as the console renders them, withheld identifiers
 * never sent and never answered, walk and table budgets refused at their edges rather than cut, and every failure
 * worded by its category with nothing the agent sent back quoted.
 */
import { describe, expect, test } from "bun:test";
import type { SnmpAgentClient } from "@/lib/db/providers/network/snmp/agent-client";
import {
  runSnmpAgentRead,
  runSnmpAgentReadWithin,
  SNMP_AGENT_FAILURE_SENTENCES as F,
  SnmpAgentError,
  snmpAgentResult,
} from "@/lib/db/providers/network/snmp/agent-read";
import {
  readSnmpAgentStatement,
  SNMP_WITHHELD_SUBTREES,
  type SnmpAgentPlan,
  withheldSubtreeOf,
} from "@/lib/db/providers/network/snmp/agent-statement";
import type { SnmpFailure } from "@/lib/db/providers/network/snmp/errors";
import type { Response, ResponseVarbind } from "@/lib/db/providers/network/snmp/message";
import { compareOid } from "@/lib/db/providers/network/snmp/objects";
import { ROW_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 3, maxResultBytes: 10_000, statementTimeoutMs: 2_000 };
const enc = (value: string) => new TextEncoder().encode(value);
const oid = (dotted: string) => dotted.split(".").map(Number);

type Call = { readonly pdu: "get" | "getNext" | "getBulk"; readonly oids: string[]; readonly maxRepetitions?: number };

/** A client answering from a tree in agent order, recording every call; `answer` may replace any answer. */
function treeClient(
  tree: Array<[string, number, Uint8Array]>,
  answer?: (call: Call, made: Response) => Response | SnmpFailure,
): { client: SnmpAgentClient; calls: Call[] } {
  const ordered = tree
    .map(([dotted, tag, value]) => ({ oid: oid(dotted), tag, value }))
    .sort((a, b) => compareOid(a.oid, b.oid));
  /** The first entry after `from`, by binary search, so a walk of thousands of objects stays fast. */
  const after = (from: readonly number[]): ResponseVarbind => {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareOid(ordered[middle].oid, from) > 0) high = middle;
      else low = middle + 1;
    }
    return ordered[low] ?? { oid: from, tag: 0x82, value: new Uint8Array(0) };
  };
  const calls: Call[] = [];
  const respond = async (call: Call, varbinds: ResponseVarbind[]) => {
    calls.push(call);
    const made: Response = { requestId: 1, errorStatus: 0, errorIndex: 0, varbinds };
    return answer === undefined ? made : answer(call, made);
  };
  const client: SnmpAgentClient = {
    get: (oids) =>
      respond(
        { pdu: "get", oids: oids.map((o) => o.join(".")) },
        oids.map(
          (o) =>
            ordered.find((entry) => compareOid(entry.oid, o) === 0) ?? { oid: o, tag: 0x80, value: new Uint8Array(0) },
        ),
      ),
    getNext: (oids) =>
      respond(
        { pdu: "getNext", oids: oids.map((o) => o.join(".")) },
        oids.map((o) => after(o)),
      ),
    getBulk: (from, maxRepetitions) => {
      const varbinds: ResponseVarbind[] = [];
      let at = from;
      for (let i = 0; i < maxRepetitions; i += 1) {
        const step = after(at);
        varbinds.push(step);
        if (step.tag === 0x82) break;
        at = step.oid;
      }
      return respond({ pdu: "getBulk", oids: [from.join(".")], maxRepetitions }, varbinds);
    },
  };
  return { client, calls };
}

const plan = (text: string): SnmpAgentPlan => {
  const reading = readSnmpAgentStatement(text);
  if (!reading.ok) throw new Error(reading.message);
  return reading.plan;
};

const IF_TABLE: Array<[string, number, Uint8Array]> = [
  ["1.3.6.1.2.1.1.1.0", 0x04, enc("a test agent")],
  ["1.3.6.1.2.1.1.5.0", 0x04, enc("host-one")],
  ["1.3.6.1.2.1.2.2.1.1.1", 0x02, Uint8Array.of(1)],
  ["1.3.6.1.2.1.2.2.1.1.2", 0x02, Uint8Array.of(2)],
  ["1.3.6.1.2.1.2.2.1.2.1", 0x04, enc("lo")],
  ["1.3.6.1.2.1.2.2.1.2.2", 0x04, enc("eth0")],
  ["1.3.6.1.2.1.2.2.1.6.2", 0x04, Uint8Array.of(0x02, 0x42, 0xac, 0x11, 0x00, 0x02)],
  ["1.3.6.1.2.1.31.1.1.1.1.1", 0x04, enc("lo")],
  // A community row the agent holds: its value and its instance suffix spell the marker.
  ["1.3.6.1.6.3.18.1.1.1.2.109.97.114.107", 0x04, enc("marker-community")],
  ["1.3.6.1.6.3.16.1.2.1.3.2.109.97.114.107", 0x04, enc("marker-group")],
];

const MARKER = /marker|109\.97\.114\.107/;

describe("get and next", () => {
  test("a get answers each value as the console renders it, and an exception as its type with no value", async () => {
    const { client, calls } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(
      client,
      plan("get sysDescr.0 1.3.6.1.2.1.2.2.1.6.2 1.3.6.1.2.1.1.4.0"),
      BUDGET,
    );
    expect(calls).toEqual([{ pdu: "get", oids: ["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.2.2.1.6.2", "1.3.6.1.2.1.1.4.0"] }]);
    expect(answer).toEqual({
      fields: ["object", "value", "type"],
      rows: [
        { object: "1.3.6.1.2.1.1.1.0", value: "a test agent", type: "text" },
        // Control bytes are never text: the console's hex.
        { object: "1.3.6.1.2.1.2.2.1.6.2", value: "0242ac110002", type: "hex" },
        { object: "1.3.6.1.2.1.1.4.0", value: null, type: "noSuchObject" },
      ],
      withheld: [],
    });
  });

  test("a withheld identifier is never sent, and its row names only the subtree's root", async () => {
    const { client, calls } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(
      client,
      plan("get 1.3.6.1.6.3.18.1.1.1.2.109.97.114.107 sysName.0 1.3.6.1.6.3.16.1"),
      BUDGET,
    );
    expect(calls).toEqual([{ pdu: "get", oids: ["1.3.6.1.2.1.1.5.0"] }]);
    expect(answer.rows).toEqual([
      { object: "1.3.6.1.6.3.18", value: null, type: "withheld" },
      { object: "1.3.6.1.2.1.1.5.0", value: "host-one", type: "text" },
      { object: "1.3.6.1.6.3.16", value: null, type: "withheld" },
    ]);
    expect(answer.withheld.map((entry) => entry.module)).toEqual(["SNMP-COMMUNITY-MIB", "SNMP-VIEW-BASED-ACM-MIB"]);
    expect(JSON.stringify(answer)).not.toMatch(MARKER);
  });

  test("a get naming only withheld identifiers sends nothing at all, so no existence is learnt", async () => {
    const { client, calls } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(
      client,
      plan("get 1.3.6.1.6.3.18.1.1.1.2.1 1.3.6.1.6.3.18.1.1.1.2.2"),
      BUDGET,
    );
    expect(calls).toEqual([]);
    expect(answer.rows).toEqual([
      { object: "1.3.6.1.6.3.18", value: null, type: "withheld" },
      { object: "1.3.6.1.6.3.18", value: null, type: "withheld" },
    ]);
    expect(answer.withheld).toHaveLength(1);
  });

  test("a next from inside a withheld subtree is not sent, since its answer would bisect the names it holds", async () => {
    const { client, calls } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(client, plan("next 1.3.6.1.6.3.18.1.1.1.2.109"), BUDGET);
    expect(calls).toEqual([]);
    expect(answer.rows).toEqual([{ object: "1.3.6.1.6.3.18", value: null, type: "withheld" }]);
  });

  test("a next from just below a withheld subtree lands inside it: withheld, never its identifier or value", async () => {
    const { client, calls } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(client, plan("next 1.3.6.1.6.3.17 1.3.6.1.6.3.15.99 sysDescr.0"), BUDGET);
    expect(calls).toEqual([{ pdu: "getNext", oids: ["1.3.6.1.6.3.17", "1.3.6.1.2.1.1.1.0"] }]);
    expect(answer.rows).toEqual([
      { object: "1.3.6.1.6.3.18", value: null, type: "withheld" },
      { object: "1.3.6.1.6.3.15", value: null, type: "withheld" },
      { object: "1.3.6.1.2.1.1.5.0", value: "host-one", type: "text" },
    ]);
    expect(JSON.stringify(answer)).not.toMatch(MARKER);
  });

  test("an agent that answers fewer varbinds than were asked leaves the rest unanswered", async () => {
    const { client } = treeClient(IF_TABLE, (_call, made) => ({ ...made, varbinds: made.varbinds.slice(0, 1) }));
    const answer = await runSnmpAgentRead(client, plan("get sysDescr.0 sysName.0"), BUDGET);
    expect(answer.rows).toEqual([{ object: "1.3.6.1.2.1.1.1.0", value: "a test agent", type: "text" }]);
  });

  test("a next at the end of the view answers endOfMibView as its type", async () => {
    const { client } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(client, plan("next 1.3.6.1.6.3.19"), BUDGET);
    expect(answer.rows).toEqual([{ object: "1.3.6.1.6.3.19", value: null, type: "endOfMibView" }]);
  });
});

describe("walk and table", () => {
  test("a walk sends GetBulk with the console's max-repetitions and drops what lies past the subtree", async () => {
    const { client, calls } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(client, plan("walk 1.3.6.1.2.1.2.2.1.2"), BUDGET);
    expect(calls).toEqual([{ pdu: "getBulk", oids: ["1.3.6.1.2.1.2.2.1.2"], maxRepetitions: 50 }]);
    expect(answer.rows).toEqual([
      { object: "1.3.6.1.2.1.2.2.1.2.1", value: "lo", type: "text" },
      { object: "1.3.6.1.2.1.2.2.1.2.2", value: "eth0", type: "text" },
    ]);
  });

  test("a walk over-reading into a withheld subtree passes on nothing of it", async () => {
    const { client } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(client, plan("walk 1.3.6.1.6.3.10"), BUDGET);
    expect(answer.rows).toEqual([]);
    expect(JSON.stringify(answer)).not.toMatch(MARKER);
  });

  test("the row budget's edge: exactly the budget is answered, one row more is refused, never cut", async () => {
    const three: Array<[string, number, Uint8Array]> = [1, 2, 3].map((n) => [
      `1.3.6.1.4.1.9.${n}`,
      0x02,
      Uint8Array.of(n),
    ]);
    const exact = treeClient(three);
    expect((await runSnmpAgentRead(exact.client, plan("walk 1.3.6.1.4.1.9"), BUDGET)).rows).toHaveLength(3);
    // Step by step, three repetitions at a time, so the walk asks again before it sees the end.
    const stepped = treeClient(three);
    expect((await runSnmpAgentRead(stepped.client, plan("walk 1.3.6.1.4.1.9 limit 3"), BUDGET)).rows).toHaveLength(3);
    expect(stepped.calls.map((call) => call.oids[0])).toEqual(["1.3.6.1.4.1.9", "1.3.6.1.4.1.9.3"]);
    const four = treeClient([...three, ["1.3.6.1.4.1.9.4", 0x02, Uint8Array.of(4)]]);
    // The whole subtree in one answer: the walk ends at its end, and the result is refused past the budget.
    const whole = await runSnmpAgentRead(four.client, plan("walk 1.3.6.1.4.1.9"), BUDGET);
    expect(() => snmpAgentResult(whole, BUDGET, 1)).toThrow(`${ROW_BUDGET_PREFIX}: 4 rows > 3 allowed`);
    // A full answer with more to come: the walk stops at once, past the budget, and sends no second request.
    const sixty = treeClient(
      Array.from({ length: 60 }, (_, i): [string, number, Uint8Array] => [
        `1.3.6.1.4.1.9.${i + 1}`,
        0x02,
        Uint8Array.of(1),
      ]),
    );
    const refusal = runSnmpAgentRead(sixty.client, plan("walk 1.3.6.1.4.1.9"), BUDGET);
    await expect(refusal).rejects.toThrow(SnmpAgentError);
    await expect(refusal).rejects.toThrow(`${ROW_BUDGET_PREFIX}: 50 rows > 3 allowed`);
    expect(sixty.calls).toHaveLength(1);
    // Four objects an answer: the walk stops on the first, at one row past the budget, and asks nothing more.
    const fours = treeClient(
      Array.from({ length: 60 }, (_, i): [string, number, Uint8Array] => [
        `1.3.6.1.4.1.9.${i + 1}`,
        0x02,
        Uint8Array.of(1),
      ]),
      (_call, made) => ({ ...made, varbinds: made.varbinds.slice(0, 4) }),
    );
    await expect(runSnmpAgentRead(fours.client, plan("walk 1.3.6.1.4.1.9"), BUDGET)).rejects.toThrow(
      `${ROW_BUDGET_PREFIX}: 4 rows > 3 allowed`,
    );
    expect(fours.calls).toHaveLength(1);
  });

  test("a walk the agent is still answering when the time budget runs out is Studio's refusal, never silence", async () => {
    const ten: Array<[string, number, Uint8Array]> = Array.from({ length: 10 }, (_, i) => [
      `1.3.6.1.4.1.9.${i + 1}`,
      0x02,
      Uint8Array.of(1),
    ]);
    // One object an answer, every one of them answered, and each step 700ms on Studio's clock.
    const { client } = treeClient(ten, (_call, made) => ({ ...made, varbinds: made.varbinds.slice(0, 1) }));
    let clock = 0;
    const read = runSnmpAgentRead(client, plan("walk 1.3.6.1.4.1.9"), { ...BUDGET, maxResultRows: 100 }, () => {
      clock += 700;
      return clock;
    });
    await expect(read).rejects.toThrow(F.walkTime("walk", 2_000));
    expect(F.walkTime("walk", 2_000)).toBe(
      `${TIME_BUDGET_PREFIX}: the agent was still answering the walk after 2000ms, Studio's time budget for one read, so the walk was refused rather than answered in part; walk a narrower subtree.`,
    );
    expect(F.walkTime("table", 2_000)).not.toContain("community");
  });

  test("a walk past the console's request or byte bound is refused by that bound", async () => {
    const many: Array<[string, number, Uint8Array]> = Array.from({ length: 6000 }, (_, i) => [
      `1.3.6.1.4.1.7.${i + 1}`,
      0x02,
      Uint8Array.of(1),
    ]);
    // One varbind per answer, whatever was asked, so the walk spends a request per object.
    const { client } = treeClient(many, (_call, made) => ({ ...made, varbinds: made.varbinds.slice(0, 1) }));
    const wide = { ...BUDGET, maxResultRows: 100_000 };
    await expect(runSnmpAgentRead(client, plan("walk 1.3.6.1.4.1.7 limit 1"), wide, () => 0)).rejects.toThrow(
      F.walkBound("walk", "request"),
    );
    const big: Array<[string, number, Uint8Array]> = Array.from({ length: 40 }, (_, i) => [
      `1.3.6.1.4.1.8.${i + 1}`,
      0x04,
      new Uint8Array(120_000),
    ]);
    const oneEach = treeClient(big, (_call, made) => ({ ...made, varbinds: made.varbinds.slice(0, 1) })).client;
    await expect(
      runSnmpAgentRead(oneEach, plan("walk 1.3.6.1.4.1.8"), { ...BUDGET, maxResultRows: 1_000 }),
    ).rejects.toThrow(F.walkBound("walk", "inbound byte"));
  });

  test("a walk the agent left unfinished is refused, never answered as the whole subtree", async () => {
    const empty = treeClient(IF_TABLE, (_call, made) => ({ ...made, varbinds: [] }));
    await expect(runSnmpAgentRead(empty.client, plan("walk 1.3.6.1.2.1.2"), BUDGET)).rejects.toThrow(
      F.walkIncomplete("walk", "the agent answered a step with no objects"),
    );
    const backwards = treeClient(IF_TABLE, (call, made) =>
      call.oids[0] === "1.3.6.1.2.1.2.2.1.1"
        ? {
            ...made,
            varbinds: [
              { oid: oid("1.3.6.1.2.1.2.2.1.1.2"), tag: 0x02, value: Uint8Array.of(2) },
              { oid: oid("1.3.6.1.2.1.2.2.1.1.1"), tag: 0x02, value: Uint8Array.of(1) },
            ],
          }
        : made,
    );
    await expect(runSnmpAgentRead(backwards.client, plan("walk 1.3.6.1.2.1.2.2.1.1"), BUDGET)).rejects.toThrow(
      F.walkIncomplete("walk", "the agent's answers did not move forward"),
    );
  });

  test("a walk covering a withheld subtree steps over it: no request starts inside it, nothing of it is answered, its reason is warned", async () => {
    const tree: Array<[string, number, Uint8Array]> = [
      ["1.3.6.1.4.1.2021.1.0", 0x02, Uint8Array.of(1)],
      // Net-SNMP's access table: the instance suffix spells the group name, the value a view name.
      ["1.3.6.1.4.1.8072.1.9.1.1.2.6.109.97.114.107.101.114.0.1", 0x04, enc("marker-view")],
      ["1.3.6.1.4.1.8072.1.9.1.1.3.6.109.97.114.107.101.114.0.1", 0x04, enc("marker-view")],
      ["1.3.6.1.4.1.8072.1.10.1.0", 0x02, Uint8Array.of(7)],
      ["1.3.6.1.4.1.8072.9.1.0", 0x02, Uint8Array.of(9)],
    ];
    const { client, calls } = treeClient(tree);
    const answer = await runSnmpAgentRead(client, plan("walk 1.3.6.1.4.1"), { ...BUDGET, maxResultRows: 10 });
    expect(calls).toEqual([
      { pdu: "getBulk", oids: ["1.3.6.1.4.1"], maxRepetitions: 50 },
      { pdu: "getBulk", oids: ["1.3.6.1.4.1.8072.1.10"], maxRepetitions: 50 },
    ]);
    expect(answer.rows).toEqual([
      { object: "1.3.6.1.4.1.2021.1.0", value: "1", type: "number" },
      { object: "1.3.6.1.4.1.8072.1.10.1.0", value: "7", type: "number" },
      { object: "1.3.6.1.4.1.8072.9.1.0", value: "9", type: "number" },
    ]);
    expect(answer.withheld.map((entry) => entry.module)).toEqual(["NET-SNMP-VACM-MIB"]);
    expect(JSON.stringify(answer)).not.toMatch(MARKER);
    expect(calls.every((call) => withheldSubtreeOf(oid(call.oids[0])) === undefined)).toBe(true);
  });

  test("a walk whose first answer lands inside a withheld subtree resumes past it, and adjacent roots are stepped together", async () => {
    const vacm = treeClient([
      ["1.3.6.1.4.1.8072.1.9.1.1.2.1", 0x04, enc("marker-view")],
      ["1.3.6.1.4.1.8072.1.10.1.0", 0x02, Uint8Array.of(7)],
    ]);
    const first = await runSnmpAgentRead(vacm.client, plan("walk 1.3.6.1.4.1.8072.1"), BUDGET);
    expect(vacm.calls.map((call) => call.oids[0])).toEqual(["1.3.6.1.4.1.8072.1", "1.3.6.1.4.1.8072.1.10"]);
    expect(first.rows).toEqual([{ object: "1.3.6.1.4.1.8072.1.10.1.0", value: "7", type: "number" }]);
    // One varbind an answer, so every withheld root of the framework lands first in an answer of its own.
    const framework = treeClient(
      [...IF_TABLE, ["1.3.6.1.6.3.10.2.1.1.0", 0x04, enc("engine")], ["1.3.6.1.6.3.12.1.1.0", 0x02, Uint8Array.of(1)]],
      (_call, made) => ({ ...made, varbinds: made.varbinds.slice(0, 1) }),
    );
    const answer = await runSnmpAgentRead(framework.client, plan("walk 1.3.6.1.6.3"), BUDGET);
    expect(answer.rows).toEqual([{ object: "1.3.6.1.6.3.10.2.1.1.0", value: "engine", type: "text" }]);
    expect(framework.calls.map((call) => call.oids[0])).toEqual([
      "1.3.6.1.6.3",
      "1.3.6.1.6.3.10.2.1.1.0",
      "1.3.6.1.6.3.17",
      "1.3.6.1.6.3.19",
    ]);
    expect(answer.withheld.map((entry) => entry.module)).toEqual([
      "SNMP-TARGET-MIB",
      "SNMP-NOTIFICATION-MIB",
      "SNMP-PROXY-MIB",
      "SNMP-USER-BASED-SM-MIB",
      "SNMP-VIEW-BASED-ACM-MIB",
      "SNMP-COMMUNITY-MIB",
    ]);
    expect(JSON.stringify(answer)).not.toMatch(MARKER);
  });

  test("walk 1.3 answers what lies outside the eleven withheld subtrees and warns every one, whether or not the agent holds it", async () => {
    const { client, calls } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(client, plan("walk 1.3"), { ...BUDGET, maxResultRows: 20 });
    expect(answer.rows.map((row) => row.object)).toEqual(IF_TABLE.slice(0, 8).map(([dotted]) => dotted));
    expect(answer.withheld).toEqual(SNMP_WITHHELD_SUBTREES);
    expect(JSON.stringify(answer)).not.toMatch(MARKER);
    expect(calls.every((call) => withheldSubtreeOf(oid(call.oids[0])) === undefined)).toBe(true);
  });

  test("stepping over a withheld subtree spends a request and the time budget like any other step", async () => {
    const tree: Array<[string, number, Uint8Array]> = [
      ["1.3.6.1.4.1.8072.1.9.1.1.2.1", 0x04, enc("marker-view")],
      ["1.3.6.1.4.1.8072.1.10.1.0", 0x02, Uint8Array.of(7)],
    ];
    let clock = 0;
    const read = runSnmpAgentRead(treeClient(tree).client, plan("walk 1.3.6.1.4.1.8072.1"), BUDGET, () => {
      clock += 2_500;
      return clock;
    });
    await expect(read).rejects.toThrow(F.walkTime("walk", 2_000));
  });

  test("a table is shaped as the console shapes it, and refused past the row budget once built", async () => {
    const { client } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentRead(client, plan("table ifEntry"), BUDGET);
    expect(answer.fields).toEqual(["index", "column1", "column2", "column6"]);
    expect(answer.rows).toEqual([
      { index: "1", column1: "1", column2: "lo", column6: "absent" },
      { index: "2", column1: "2", column2: "eth0", column6: "0242ac110002" },
    ]);
    const narrow = { ...BUDGET, maxResultRows: 1 };
    await expect(runSnmpAgentRead(client, plan("table ifEntry"), narrow)).rejects.toThrow(F.tableOverRows(2, 1));
    const none = await runSnmpAgentRead(client, plan("table 1.3.6.1.4.1.99"), BUDGET);
    expect(none).toEqual({ fields: ["index"], rows: [], withheld: [] });
  });

  test("a table is bounded by its rows, not by its objects: many columns under the row budget are answered", async () => {
    // 300 interfaces of 22 columns each: 6,600 objects, past the console's 5,000-object walk bound, and 300 rows.
    const wide: Array<[string, number, Uint8Array]> = [];
    for (let column = 1; column <= 22; column += 1) {
      for (let row = 1; row <= 300; row += 1) wide.push([`1.3.6.1.2.1.2.2.1.${column}.${row}`, 0x02, Uint8Array.of(1)]);
    }
    const budget = { ...BUDGET, maxResultRows: 500, maxResultBytes: 10_000_000 };
    const answer = await runSnmpAgentRead(treeClient(wide).client, plan("table ifEntry"), budget);
    expect(answer.rows).toHaveLength(300);
    expect(answer.fields).toHaveLength(23);
  });

  test("a table past the row budget is refused by its row count as soon as it holds one row more, never cut", async () => {
    const tall: Array<[string, number, Uint8Array]> = Array.from({ length: 600 }, (_, i) => [
      `1.3.6.1.4.1.6.1.1.${i + 1}`,
      0x02,
      Uint8Array.of(1),
    ]);
    const { client, calls } = treeClient(tall);
    const read = runSnmpAgentRead(client, plan("table 1.3.6.1.4.1.6.1"), { ...BUDGET, maxResultRows: 500 });
    await expect(read).rejects.toThrow(F.tableOverRows(501, 500));
    expect(calls).toHaveLength(11);
    const exact = treeClient(tall.slice(0, 500));
    const answer = await runSnmpAgentRead(exact.client, plan("table 1.3.6.1.4.1.6.1"), {
      ...BUDGET,
      maxResultRows: 500,
    });
    expect(answer.rows).toHaveLength(500);
  });
});

describe("the read's own deadline", () => {
  const slow = (delayMs: number): SnmpAgentClient => {
    const { client } = treeClient(
      Array.from({ length: 100 }, (_, i): [string, number, Uint8Array] => [
        `1.3.6.1.4.1.5.${i + 1}`,
        0x02,
        Uint8Array.of(1),
      ]),
      (_call, made) => ({ ...made, varbinds: made.varbinds.slice(0, 1) }),
    );
    return {
      get: client.get,
      getNext: client.getNext,
      getBulk: async (from, n) => {
        await Bun.sleep(delayMs);
        return client.getBulk(from, n);
      },
    };
  };

  test("a read the agent kept answering past the time budget is Studio's refusal, not silence", async () => {
    const budget = { ...BUDGET, statementTimeoutMs: 60, maxResultRows: 1_000 };
    const read = runSnmpAgentReadWithin(slow(5), plan("walk 1.3.6.1.4.1.5"), budget, () => 0);
    await expect(read).rejects.toThrow(F.deadline(60));
    expect(F.deadline(60)).toBe(
      `${TIME_BUDGET_PREFIX}: the read did not finish within 60ms, Studio's time budget for one read, while the agent was still answering, so it was refused rather than answered in part; ask for less in one read, such as a narrower subtree.`,
    );
  });

  test("a read the agent never answered is silence, with what silence can mean", async () => {
    const silent: SnmpAgentClient = {
      get: () => new Promise(() => undefined),
      getNext: () => new Promise(() => undefined),
      getBulk: () => new Promise(() => undefined),
    };
    const budget = { ...BUDGET, statementTimeoutMs: 40 };
    await expect(runSnmpAgentReadWithin(silent, plan("get sysDescr.0"), budget)).rejects.toThrow(F.silence(40));
  });

  test("a read that finishes in time is answered, and a failure inside it is its own", async () => {
    const { client } = treeClient(IF_TABLE);
    const answer = await runSnmpAgentReadWithin(client, plan("get sysName.0"), BUDGET);
    expect(answer.rows).toEqual([{ object: "1.3.6.1.2.1.1.5.0", value: "host-one", type: "text" }]);
    const failing = treeClient(IF_TABLE, () => ({ kind: "transport", reason: "x", retryable: false })).client;
    await expect(runSnmpAgentReadWithin(failing, plan("next system"), BUDGET)).rejects.toThrow(F.unreachable);
  });
});

describe("failures are worded by category, quoting nothing the agent sent", () => {
  const failing = (failure: SnmpFailure) => treeClient(IF_TABLE, () => failure).client;
  const cases: Array<[SnmpFailure, string]> = [
    [{ kind: "silence", reason: "x", causes: [], retryable: true }, F.silence(2_000)],
    [{ kind: "tooLarge", reason: "x", retryable: false }, F.tooBig],
    [{ kind: "requestTooLarge", reason: "x", retryable: false }, F.requestTooLarge],
    [{ kind: "credential", reason: "x", retryable: false }, F.credential],
    [{ kind: "transport", reason: "x", retryable: false }, F.unreachable],
    [
      {
        kind: "refused",
        reason: "the agent sent a report this provider does not know (1.3.6.1.6.3.18.1)",
        retryable: false,
      },
      F.report,
    ],
  ];
  for (const [failure, sentence] of cases) {
    test(`${failure.kind}`, async () => {
      const read = runSnmpAgentRead(failing(failure), plan("get sysDescr.0"), BUDGET);
      await expect(read).rejects.toThrow(sentence);
    });
  }

  test("a non-zero error-status by its number, tooBig by its own sentence", async () => {
    const status = (n: number) => treeClient(IF_TABLE, (_c, made) => ({ ...made, errorStatus: n })).client;
    await expect(runSnmpAgentRead(status(5), plan("get sysDescr.0"), BUDGET)).rejects.toThrow(F.refused(5));
    await expect(runSnmpAgentRead(status(1), plan("walk system"), BUDGET)).rejects.toThrow(F.tooBig);
  });
});

describe("the result", () => {
  test("carries one warning per withheld module and is refused past the row or byte budget", () => {
    const answer = {
      fields: ["object", "value", "type"],
      rows: [{ object: "1.3.6.1.6.3.18", value: null, type: "withheld" }],
      withheld: [
        {
          module: "SNMP-COMMUNITY-MIB",
          root: [1, 3, 6, 1, 6, 3, 18],
          holds: "the community strings and the security names they map to",
        },
      ],
    };
    const result = snmpAgentResult(answer, BUDGET, 7);
    expect(result).toEqual({
      fields: ["object", "value", "type"],
      rows: [{ object: "1.3.6.1.6.3.18", value: null, type: "withheld" }],
      rowCount: 1,
      executionTime: 7,
      warnings: [
        {
          message:
            "SNMP-COMMUNITY-MIB (1.3.6.1.6.3.18) is withheld from agent mode: it holds the community strings and the security names they map to, so no value or instance of it is read or answered.",
        },
      ],
    });
    expect(snmpAgentResult({ ...answer, withheld: [] }, BUDGET, 1).warnings).toBeUndefined();
    const four = { ...answer, rows: [1, 2, 3, 4].map(() => answer.rows[0]), withheld: [] };
    expect(() => snmpAgentResult(four, BUDGET, 1)).toThrow(`${ROW_BUDGET_PREFIX}: 4 rows > 3 allowed`);
    expect(() => snmpAgentResult(answer, { ...BUDGET, maxResultBytes: 10 }, 1)).toThrow(
      "Read-only execution exceeded the byte budget",
    );
  });
});
