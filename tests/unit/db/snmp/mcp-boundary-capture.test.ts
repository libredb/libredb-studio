/**
 * What `run_snmp_read` answered on the Net-SNMP 5.9.4 agent, held to the capture `tests/live/snmp-mcp-boundary.ts`
 * wrote (tests/fixtures/snmp/5.9.4/mcp-boundary/boundary.json), so the data-scope claims of `docs/providers/snmp.md`
 * section 14 stay tied to a measurement: every instance the raw walk answered with a planted marker lies inside a
 * withheld subtree, the process, command and framework subtrees among them; no answer through the tool carried a marker
 * or a community, and each named the withheld subtrees it stepped over in its notes; the narrow community's view held
 * it to the system group, and an object outside it answered as a missing one; every refused form sent nothing; the
 * unfenced Set with a writer's community changed nothing while the raw Set did; and a silent agent and a cancel ended
 * as the cancel table says.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SNMP_WITHHELD_SUBTREES } from "@/lib/db/providers/network/snmp/agent-statement";

const capture = JSON.parse(
  readFileSync(new URL("../../../fixtures/snmp/5.9.4/mcp-boundary/boundary.json", import.meta.url), "utf8"),
);

describe("the run_snmp_read capture", () => {
  test("every marked instance the raw walk answered lies inside a withheld subtree", () => {
    expect(capture.census.marked).toBeGreaterThan(0);
    expect(capture.census.markedOutsideWithheld).toBe(0);
    const modules = SNMP_WITHHELD_SUBTREES.map((entry) => entry.module);
    for (const name of Object.keys(capture.census.markedByWithheldSubtree)) expect(modules).toContain(name);
    for (const name of [
      "HOST-RESOURCES-MIB::hrSWRun",
      "NET-SNMP-EXTEND-MIB::nsExtendObjects",
      "UCD-SNMP-MIB::extTable",
      "UCD-SNMP-MIB::prErrFixCmd",
      "SNMP-TARGET-MIB",
      "SNMP-USER-BASED-SM-MIB",
    ]) {
      expect(capture.census.markedByWithheldSubtree[name]).toBeGreaterThan(0);
    }
  });

  test("no answer carried a marker or a community, and each withheld read's notes named its subtree", () => {
    for (const answer of [...Object.values(capture.reads), ...Object.values(capture.withheld)]) {
      expect(answer).toMatchObject({ isError: false, carriesMarker: false, carriesCommunity: false });
    }
    const notes = (statement: string) => capture.withheld[statement].notes.map((note: string) => note.split(" (")[0]);
    expect(notes("walk host")).toEqual(["HOST-RESOURCES-MIB::hrSWRun"]);
    expect(notes("walk 1.3.6.1.4.1.2021")).toEqual(["UCD-SNMP-MIB::prErrFixCmd", "UCD-SNMP-MIB::extTable"]);
    expect(notes("next 1.3.6.1.4.1.8072.1.2.99999")).toEqual(["NET-SNMP-EXTEND-MIB::nsExtendObjects"]);
    for (const answer of Object.values(capture.reads) as Array<{ notes: string[] }>) expect(answer.notes).toEqual([]);
  });

  test("the narrow community's view held it to the system group, and an object outside it answered as a missing one", () => {
    expect(capture.scope.narrowSystem).toMatchObject({ isError: false, rows: 1, carriesCommunity: false });
    expect(capture.scope.outsideViewType).toBe(capture.scope.missingType);
    expect(capture.scope.narrowWalkOfMib2Rows).toBe(capture.reads["walk system"].rows);
  });

  test("every refused form was refused in its own words and sent nothing, and the unfenced Set changed nothing", () => {
    expect(capture.refused.map((form: { request: string; code: string }) => [form.request, form.code])).toEqual([
      ["a set", "request"],
      ["a walk inside the community module", "withheld"],
      ["a table of the running processes", "withheld"],
      ["a walk of the extend directives", "withheld"],
      ["a walk of the exec directives", "withheld"],
      ["a trap", "request"],
      ["Net-SNMP's tool syntax", "request"],
    ]);
    for (const form of capture.refused) expect(form.ownWords).toBe(true);
    expect(capture.overBudget).toStartWith(
      "The result has more than 1000 rows, the most this server reads for one call.",
    );
    expect(capture.writes).toEqual({ rawSetChangedSysContact: true, unfencedToolSetChangedSysContact: false });
  });

  test("a silent agent was the timeout answer at the least timeout_ms, and a cancel answered while the read ran to its time left", () => {
    expect(capture.limits.leastTimeoutAnsweredMs).toBeLessThan(1000);
    expect(capture.limits.leastReadEndedMs).toBeLessThan(1000);
    expect(capture.limits.cancelAnsweredMs).toBeLessThan(1500);
    expect(capture.limits.cancelReadEndedMs).toBeGreaterThanOrEqual(1500);
  });
});
