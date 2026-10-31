/**
 * The agent's reader of one SNMP statement: the console's four commands, read by the console's own parser and resolver,
 * every name resolved before anything is sent, and every walk or table that would reach a withheld security or target
 * subtree refused, decided by the prefix of the resolved identifier and never by the text written.
 */
import { describe, expect, test } from "bun:test";
import {
  readSnmpAgentStatement,
  SNMP_AGENT_SENTENCES,
  SNMP_WITHHELD_SUBTREES,
  withheldReason,
  withheldSubtreeOf,
} from "@/lib/db/providers/network/snmp/agent-statement";
import { MIB_NAMES } from "@/lib/db/providers/network/snmp/mib-names";
import { MAX_REPETITIONS_CAP } from "@/lib/db/providers/network/snmp/statement";

const refusedWith = (text: string, maxRows?: number) => {
  const reading = readSnmpAgentStatement(text, maxRows);
  if (reading.ok) throw new Error(`admitted: ${text}`);
  return reading;
};

describe("the withheld subtrees", () => {
  test("are the six security and target modules' roots under 1.3.6.1.6.3", () => {
    expect(SNMP_WITHHELD_SUBTREES.map((entry) => [entry.module, entry.root.join(".")])).toEqual([
      ["SNMP-TARGET-MIB", "1.3.6.1.6.3.12"],
      ["SNMP-NOTIFICATION-MIB", "1.3.6.1.6.3.13"],
      ["SNMP-PROXY-MIB", "1.3.6.1.6.3.14"],
      ["SNMP-USER-BASED-SM-MIB", "1.3.6.1.6.3.15"],
      ["SNMP-VIEW-BASED-ACM-MIB", "1.3.6.1.6.3.16"],
      ["SNMP-COMMUNITY-MIB", "1.3.6.1.6.3.18"],
    ]);
  });

  test("no name the bundled modules define resolves inside one, so only a numeric identifier reaches them", () => {
    const inside = [...MIB_NAMES.entries()].filter(([, oid]) => withheldSubtreeOf(oid) !== undefined);
    expect(inside).toEqual([]);
  });

  test("an identifier is inside one by its prefix, from the root down, and the neighbours are not", () => {
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3, 18])?.module).toBe("SNMP-COMMUNITY-MIB");
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3, 18, 1, 1, 1, 2, 99, 97])?.module).toBe("SNMP-COMMUNITY-MIB");
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3, 15, 1, 1, 3, 0])?.module).toBe("SNMP-USER-BASED-SM-MIB");
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3, 17])).toBeUndefined();
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3, 10, 2, 1, 1, 0])).toBeUndefined();
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3, 1])).toBeUndefined();
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3])).toBeUndefined();
    expect(withheldSubtreeOf([1, 3, 6, 1, 6, 3, 180])).toBeUndefined();
  });

  test("a withheld row's reason names the module and its root and nothing below it", () => {
    const community = SNMP_WITHHELD_SUBTREES[5];
    expect(withheldReason(community)).toBe(
      "SNMP-COMMUNITY-MIB (1.3.6.1.6.3.18) is withheld from agent mode: it holds the community strings and the security names they map to, so no value or instance of it is read or answered.",
    );
  });
});

describe("what is admitted", () => {
  test("a get and a next, each name resolved, in the order written, a leading dot read as the console reads it", () => {
    expect(readSnmpAgentStatement("get sysDescr.0 .1.3.6.1.2.1.1.5.0")).toEqual({
      ok: true,
      plan: {
        command: "get",
        oids: [
          [1, 3, 6, 1, 2, 1, 1, 1, 0],
          [1, 3, 6, 1, 2, 1, 1, 5, 0],
        ],
      },
    });
    expect(readSnmpAgentStatement("  next   system  ")).toEqual({
      ok: true,
      plan: { command: "next", oids: [[1, 3, 6, 1, 2, 1, 1]] },
    });
  });

  test("a get or next naming a withheld identifier is admitted: the read answers it withheld without sending it", () => {
    expect(readSnmpAgentStatement("get 1.3.6.1.6.3.18.1.1.1.2.1")).toEqual({
      ok: true,
      plan: { command: "get", oids: [[1, 3, 6, 1, 6, 3, 18, 1, 1, 1, 2, 1]] },
    });
    expect(readSnmpAgentStatement("next 1.3.6.1.6.3.17").ok).toBe(true);
  });

  test("a walk carries the console's max-repetitions, narrowed by limit", () => {
    expect(readSnmpAgentStatement("walk ifTable")).toEqual({
      ok: true,
      plan: { command: "walk", subtree: [1, 3, 6, 1, 2, 1, 2, 2], maxRepetitions: MAX_REPETITIONS_CAP },
    });
    expect(readSnmpAgentStatement("walk 1.3.6.1.2.1 limit 7", 100)).toEqual({
      ok: true,
      plan: { command: "walk", subtree: [1, 3, 6, 1, 2, 1], maxRepetitions: 7 },
    });
  });

  test("a table, and walks beside the withheld subtrees that reach none of them", () => {
    expect(readSnmpAgentStatement("table ifTable")).toEqual({
      ok: true,
      plan: { command: "table", table: [1, 3, 6, 1, 2, 1, 2, 2], maxRepetitions: MAX_REPETITIONS_CAP },
    });
    for (const subtree of ["1.3.6.1.6.3.10", "1.3.6.1.6.3.17", "1.3.6.1.6.3.1", "1.3.6.1.4.1", "1.3.6.1.6.3.180"]) {
      expect(readSnmpAgentStatement(`walk ${subtree}`).ok).toBe(true);
    }
  });
});

describe("what is refused before anything is sent", () => {
  test("an empty request names the commands", () => {
    expect(refusedWith("   ")).toEqual({ ok: false, code: "request", message: SNMP_AGENT_SENTENCES.empty });
  });

  test("a set, a trap, an unknown command and bulkwalk carry the parser's sentence and the agent's commands", () => {
    expect(refusedWith("set 1.3.6.1.2.1.1.5.0 s x").message).toBe(
      `\`set\` is not a command this provider has: it reads and never writes. ${SNMP_AGENT_SENTENCES.reads} Nothing was sent.`,
    );
    for (const text of ["trap 1", "inform 1", "bulkwalk 1.3.6.1.2.1", "delete 1", "getbulk 1"]) {
      const reading = refusedWith(text);
      expect(reading.code).toBe("request");
      expect(reading.message.endsWith(`${SNMP_AGENT_SENTENCES.reads} Nothing was sent.`)).toBe(true);
    }
  });

  test("a malformed identifier, an overlong arc, too many arcs and an unknown name are the parser's", () => {
    expect(refusedWith("get 1.3.6.1.x").message).toStartWith("`x` is not a sub-identifier. ");
    expect(refusedWith("get 1.3.6.1.4294967296").message).toStartWith("a sub-identifier is at most 4294967295");
    expect(refusedWith(`get ${Array.from({ length: 129 }, () => "1").join(".")}`).message).toStartWith(
      "an object identifier holds at most 128",
    );
    expect(refusedWith("get snmpCommunityName.1").message).toContain("snmpCommunityName");
    expect(refusedWith("walk 1.3 limit 0").code).toBe("request");
    expect(refusedWith("walk 1.3.6.1.2.1 extra").code).toBe("request");
  });

  test("a walk limit above the request's row budget is the console's own refusal", () => {
    expect(refusedWith("walk 1.3.6.1.2.1 limit 4", 3).message).toStartWith(
      "`limit` is above this walk's row budget of 3. ",
    );
  });

  test("a walk or table of any root above the withheld subtrees, or inside one, is refused by prefix", () => {
    const cases: Array<[string, string]> = [
      ["walk 1", "SNMP-TARGET-MIB"],
      ["walk .1.3.6", "SNMP-TARGET-MIB"],
      ["walk 1.3.6.1.6", "SNMP-TARGET-MIB"],
      ["walk 1.3.6.1.6.3", "SNMP-TARGET-MIB"],
      ["walk snmpModules", "SNMP-TARGET-MIB"],
      ["walk 1.3.6.1.6.3.18", "SNMP-COMMUNITY-MIB"],
      ["walk .1.3.6.1.6.3.16.1.2", "SNMP-VIEW-BASED-ACM-MIB"],
      ["table 1.3.6.1.6.3.15.1.2.2", "SNMP-USER-BASED-SM-MIB"],
      ["table 1.3.6.1.6.3", "SNMP-TARGET-MIB"],
    ];
    for (const [text, module] of cases) {
      const reading = refusedWith(text);
      expect(reading.code).toBe("withheld");
      expect(reading.message).toContain(`inside ${module}`);
      expect(reading.message.endsWith(`${SNMP_AGENT_SENTENCES.reads} Nothing was sent.`)).toBe(true);
    }
    expect(refusedWith("walk 1.3.6.1.6.3.18.1.1.1.2.1").message).toStartWith(
      "A walk of 1.3.6.1.6.3.18.1.1.1.2.1 would read inside SNMP-COMMUNITY-MIB (1.3.6.1.6.3.18), which holds the community strings and the security names they map to and is withheld from agent mode, so the walk is refused rather than read; walk a subtree that does not reach it, such as mib-2 (1.3.6.1.2.1) or one of its groups.",
    );
  });
});
