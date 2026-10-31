/**
 * The agent's reader of one SNMP statement: the console's four commands, read by the console's own parser and resolver,
 * every name resolved before anything is sent, and every walk or table that would reach a withheld security or target
 * subtree refused, decided by the prefix of the resolved identifier and never by the text written.
 */
import { describe, expect, test } from "bun:test";
import {
  readSnmpAgentStatement,
  resumeAfter,
  SNMP_AGENT_SENTENCES,
  SNMP_WITHHELD_MODULES_TEXT,
  SNMP_WITHHELD_SUBTREES,
  withheldReason,
  withheldSubtreeOf,
  withheldWithin,
} from "@/lib/db/providers/network/snmp/agent-statement";
import { MIB_NAMES } from "@/lib/db/providers/network/snmp/mib-names";
import { MAX_REPETITIONS_CAP } from "@/lib/db/providers/network/snmp/statement";

const refusedWith = (text: string) => {
  const reading = readSnmpAgentStatement(text);
  if (reading.ok) throw new Error(`admitted: ${text}`);
  return reading;
};

describe("the withheld subtrees", () => {
  test("are the security, target and transport security modules' roots, and Net-SNMP's access extension, in agent order", () => {
    expect(SNMP_WITHHELD_SUBTREES.map((entry) => [entry.module, entry.root.join(".")])).toEqual([
      ["SNMP-SSH-TM-MIB", "1.3.6.1.2.1.189"],
      ["SNMP-TSM-MIB", "1.3.6.1.2.1.190"],
      ["SNMP-TLS-TM-MIB", "1.3.6.1.2.1.198"],
      ["SNMP-USM-DH-OBJECTS-MIB", "1.3.6.1.3.101"],
      ["NET-SNMP-VACM-MIB", "1.3.6.1.4.1.8072.1.9"],
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
    expect(withheldSubtreeOf([1, 3, 6, 1, 4, 1, 8072, 1, 9, 1, 1, 2])?.module).toBe("NET-SNMP-VACM-MIB");
    expect(withheldSubtreeOf([1, 3, 6, 1, 4, 1, 8072, 1, 10])).toBeUndefined();
    expect(withheldSubtreeOf([1, 3, 6, 1, 4, 1, 8072, 1, 90])).toBeUndefined();
    expect(withheldSubtreeOf([1, 3, 6, 1, 2, 1, 198, 2, 2, 1, 4])?.module).toBe("SNMP-TLS-TM-MIB");
    expect(withheldSubtreeOf([1, 3, 6, 1, 2, 1, 19])).toBeUndefined();
    expect(withheldSubtreeOf([1, 3, 6, 1, 3, 101, 1])?.module).toBe("SNMP-USM-DH-OBJECTS-MIB");
  });

  test("a walk steps over every root it contains and resumes past it, past adjacent roots together", () => {
    expect(withheldWithin([1, 3, 6, 1, 4, 1]).map((entry) => entry.module)).toEqual(["NET-SNMP-VACM-MIB"]);
    expect(withheldWithin([1, 3, 6, 1, 2, 1])).toHaveLength(3);
    expect(withheldWithin([1])).toEqual(SNMP_WITHHELD_SUBTREES);
    expect(withheldWithin([1, 3, 6, 1, 2, 1, 2])).toEqual([]);
    const at = (module: string) => SNMP_WITHHELD_SUBTREES.find((entry) => entry.module === module)!;
    expect(resumeAfter(at("NET-SNMP-VACM-MIB")).join(".")).toBe("1.3.6.1.4.1.8072.1.10");
    expect(resumeAfter(at("SNMP-TARGET-MIB")).join(".")).toBe("1.3.6.1.6.3.17");
    expect(resumeAfter(at("SNMP-COMMUNITY-MIB")).join(".")).toBe("1.3.6.1.6.3.19");
    expect(resumeAfter(at("SNMP-SSH-TM-MIB")).join(".")).toBe("1.3.6.1.2.1.191");
  });

  test("a withheld row's reason names the module and its root and nothing below it", () => {
    const community = SNMP_WITHHELD_SUBTREES[10];
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

  test("a walk carries the console's max-repetitions, a limit narrowing the first request's and capping no rows", () => {
    expect(readSnmpAgentStatement("walk ifTable")).toEqual({
      ok: true,
      plan: { command: "walk", subtree: [1, 3, 6, 1, 2, 1, 2, 2], maxRepetitions: MAX_REPETITIONS_CAP },
    });
    expect(readSnmpAgentStatement("walk 1.3.6.1.2.1 limit 7")).toEqual({
      ok: true,
      plan: { command: "walk", subtree: [1, 3, 6, 1, 2, 1], maxRepetitions: 7 },
    });
  });

  test("a table, walks beside the withheld subtrees, and walks covering them, which step over them", () => {
    expect(readSnmpAgentStatement("table ifTable")).toEqual({
      ok: true,
      plan: { command: "table", table: [1, 3, 6, 1, 2, 1, 2, 2], maxRepetitions: MAX_REPETITIONS_CAP },
    });
    const beside = ["1.3.6.1.6.3.10", "1.3.6.1.6.3.17", "1.3.6.1.6.3.1", "1.3.6.1.6.3.180", "1.3.6.1.4.1.8072.1.10"];
    const covering = [
      "1.3",
      ".1.3.6",
      "1.3.6.1.6",
      "1.3.6.1.6.3",
      "snmpModules",
      "1.3.6.1.4.1",
      "1.3.6.1.2.1",
      "mib-2",
    ];
    for (const subtree of [...beside, ...covering]) {
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
    for (const text of ["walk 1", "table .1", "get 1", "next 1.3 2"]) {
      expect(refusedWith(text).message).toBe(
        `an object identifier is sent with at least two sub-identifiers, such as 1.3. ${SNMP_AGENT_SENTENCES.reads} Nothing was sent.`,
      );
    }
    expect(refusedWith("walk 1.3.6.1.2.1 extra").code).toBe("request");
  });

  test("a walk limit is read under the console's walk budget whatever the run's row budget, so admission and provider agree", () => {
    expect(readSnmpAgentStatement("walk 1.3.6.1.2.1 limit 600").ok).toBe(true);
    expect(refusedWith("walk 1.3.6.1.2.1 limit 5001").message).toStartWith(
      "`limit` is above this walk's row budget of 5000. ",
    );
  });

  test("a walk or table inside a withheld subtree, or of its root, is refused by prefix", () => {
    const cases: Array<[string, string]> = [
      ["walk 1.3.6.1.6.3.18", "SNMP-COMMUNITY-MIB"],
      ["walk .1.3.6.1.6.3.16.1.2", "SNMP-VIEW-BASED-ACM-MIB"],
      ["table 1.3.6.1.6.3.15.1.2.2", "SNMP-USER-BASED-SM-MIB"],
      ["walk 1.3.6.1.4.1.8072.1.9", "NET-SNMP-VACM-MIB"],
      ["table .1.3.6.1.4.1.8072.1.9.1.1", "NET-SNMP-VACM-MIB"],
      ["walk 1.3.6.1.2.1.198.2", "SNMP-TLS-TM-MIB"],
      ["walk 1.3.6.1.3.101", "SNMP-USM-DH-OBJECTS-MIB"],
    ];
    for (const [text, module] of cases) {
      const reading = refusedWith(text);
      expect(reading.code).toBe("withheld");
      expect(reading.message).toContain(`inside ${module}`);
      expect(reading.message.endsWith(`${SNMP_AGENT_SENTENCES.reads} Nothing was sent.`)).toBe(true);
    }
    expect(refusedWith("walk 1.3.6.1.6.3.18.1.1.1.2.1").message).toStartWith(
      "A walk of 1.3.6.1.6.3.18.1.1.1.2.1 would read inside SNMP-COMMUNITY-MIB (1.3.6.1.6.3.18), which holds the community strings and the security names they map to and is withheld from agent mode, so the walk is refused rather than read; walk a subtree outside it, such as mib-2 (1.3.6.1.2.1) or one of its groups.",
    );
  });

  test("the agent's list of commands names every withheld module before anything counts them, and no limit", () => {
    for (const entry of SNMP_WITHHELD_SUBTREES) expect(SNMP_WITHHELD_MODULES_TEXT).toContain(entry.module);
    expect(SNMP_AGENT_SENTENCES.reads).toContain(SNMP_WITHHELD_MODULES_TEXT);
    expect(SNMP_AGENT_SENTENCES.reads).not.toContain("limit");
  });
});
