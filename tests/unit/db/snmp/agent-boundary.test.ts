/**
 * The SNMP agent's boundary: the structural closed table, held two ways.
 *
 * In the source, the agent's modules name no PDU outside the Read Class and reach the socket only through the agent's
 * client, whose three requests are the Get, the GetNext and the GetBulk, so no Set can be encoded on the agent path.
 *
 * In the capture (`tests/fixtures/snmp/5.9.4/agent-boundary/boundary.json`, recorded by its run.sh against the
 * docker/snmp fixture), what the agent answered: a raw Set with the read-only community is refused by the agent with
 * noAccess, the agent path sent no Set (the agent's own snmpInSetRequests did not move), every statement the reader
 * refuses or answers withheld reached the agent not at all (snmpInPkts moved by the one raw read after them), the
 * withheld subtrees answered raw carry no community in a value or an instance suffix on this fixture, and no
 * credential value is anywhere in the capture.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readSnmpAgentStatement } from "@/lib/db/providers/network/snmp/agent-statement";
import { FIXTURE_COMMUNITY } from "../../../fixtures/snmp/identity";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SNMP = path.join(ROOT, "src/lib/db/providers/network/snmp");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const AGENT_MODULES = readdirSync(SNMP)
  .filter((file) => file.startsWith("agent-"))
  .sort();

interface Capture {
  readonly withheld: ReadonlyArray<{
    readonly module: string;
    readonly root: string;
    readonly raw: {
      readonly instances: number;
      readonly carriesCommunity: boolean;
      readonly suffixSpellsCommunity: boolean;
    };
  }>;
  readonly rawSet: { readonly reason: string };
  readonly notSent: ReadonlyArray<{ readonly statement: string; readonly refused?: string; readonly rows?: unknown[] }>;
  readonly notSentReachedNothing: {
    readonly snmpInPktsBefore: number;
    readonly snmpInPktsAfter: number;
    readonly rawReadsBetween: number;
  };
  readonly reads: ReadonlyArray<{ readonly statement: string; readonly rowCount?: number; readonly refused?: string }>;
  readonly steppedOver: ReadonlyArray<{
    readonly statement: string;
    readonly rowCount?: number;
    readonly refused?: string;
    readonly warned: readonly string[];
    readonly insideWithheld: number;
  }>;
  readonly overBudget: { readonly refused: string; readonly message: string };
  readonly agentPathSentNoSet: { readonly snmpInSetRequestsAtStart: number; readonly snmpInSetRequestsAtEnd: number };
}

const CAPTURE_TEXT = read("tests/fixtures/snmp/5.9.4/agent-boundary/boundary.json");
const CAPTURE = JSON.parse(CAPTURE_TEXT) as Capture;

describe("the agent's modules hold the Read Class alone", () => {
  test("these are the agent's modules", () => {
    expect(AGENT_MODULES).toEqual(["agent-client.ts", "agent-read.ts", "agent-statement.ts", "agent-surface.ts"]);
  });

  test("none names a PDU outside the Read Class or an encoder, and only the client names a PDU at all", () => {
    for (const file of AGENT_MODULES) {
      const text = read(`src/lib/db/providers/network/snmp/${file}`);
      for (const forbidden of ["PDU_SET", "PDU_REPORT", "encodeRequest", "encodePdu", "0xa3", "0xa6", "0xa7"]) {
        expect(`${file}: ${text.includes(forbidden)}`).toBe(`${file}: false`);
      }
      expect(`${file}: ${/\bPDU_GET/.test(text)}`).toBe(`${file}: ${file === "agent-client.ts"}`);
    }
  });

  test("the client sends through the exchange with exactly the three read PDUs", () => {
    const client = read("src/lib/db/providers/network/snmp/agent-client.ts");
    expect(client).toContain('import { PDU_GET, PDU_GET_BULK, PDU_GET_NEXT } from "./valve";');
    expect([...client.matchAll(/exchange\.send\((\w+),/g)].map((match) => match[1])).toEqual([
      "PDU_GET",
      "PDU_GET_NEXT",
      "PDU_GET_BULK",
    ]);
  });

  test("the provider opens the agent's exchange only to hand it to the agent's client", () => {
    const index = read("src/lib/db/providers/network/snmp/index.ts");
    const agentPath = index.slice(index.indexOf("public async queryReadOnly("), index.indexOf("Drives one statement"));
    expect(agentPath).toContain("createSnmpAgentClient(exchange)");
    expect(agentPath).not.toContain("exchange.send");
  });
});

describe("the capture", () => {
  test("holds no credential value, neither the community nor its spelling as an instance suffix", () => {
    expect(CAPTURE_TEXT.includes(FIXTURE_COMMUNITY)).toBe(false);
    expect(CAPTURE_TEXT.includes([...new TextEncoder().encode(FIXTURE_COMMUNITY)].join("."))).toBe(false);
    expect(read("tests/fixtures/snmp/5.9.4/agent-boundary/run.sh").includes(FIXTURE_COMMUNITY)).toBe(false);
  });

  test("a raw Set with the read-only community is the agent's noAccess, and the agent path sent no Set", () => {
    expect(CAPTURE.rawSet.reason).toBe("Reason: noAccess");
    expect(CAPTURE.agentPathSentNoSet.snmpInSetRequestsAtEnd).toBe(CAPTURE.agentPathSentNoSet.snmpInSetRequestsAtStart);
  });

  test("every statement refused or answered withheld reached the agent not at all", () => {
    const { snmpInPktsBefore, snmpInPktsAfter, rawReadsBetween } = CAPTURE.notSentReachedNothing;
    expect(snmpInPktsAfter - snmpInPktsBefore).toBe(rawReadsBetween);
    for (const entry of CAPTURE.notSent) {
      if (entry.refused === undefined) {
        expect(entry.rows?.every((row) => (row as { type: string }).type === "withheld")).toBe(true);
      } else {
        expect(entry.refused).toBe("RefusedBeforeSendError");
        expect(readSnmpAgentStatement(entry.statement).ok).toBe(false);
      }
    }
  });

  test("the withheld subtrees answered raw, and on this fixture none carries the community", () => {
    expect(CAPTURE.withheld.map((entry) => entry.root)).toEqual([
      "1.3.6.1.2.1.189",
      "1.3.6.1.2.1.190",
      "1.3.6.1.2.1.198",
      "1.3.6.1.3.101",
      "1.3.6.1.4.1.8072.1.9",
      "1.3.6.1.6.3.12",
      "1.3.6.1.6.3.13",
      "1.3.6.1.6.3.14",
      "1.3.6.1.6.3.15",
      "1.3.6.1.6.3.16",
      "1.3.6.1.6.3.18",
    ]);
    // The access control tables answer under `view everything`: their instances are indexed by security names.
    expect(CAPTURE.withheld.find((entry) => entry.module === "SNMP-VIEW-BASED-ACM-MIB")?.raw.instances).toBeGreaterThan(
      0,
    );
    // So does Net-SNMP's own access table, indexed by group name, under the enterprise subtree.
    expect(CAPTURE.withheld.find((entry) => entry.module === "NET-SNMP-VACM-MIB")?.raw.instances).toBeGreaterThan(0);
    for (const entry of CAPTURE.withheld) {
      expect(entry.raw.carriesCommunity).toBe(false);
      expect(entry.raw.suffixSpellsCommunity).toBe(false);
    }
  });

  test("every admitted read answered, and a walk past the row budget was refused, never cut", () => {
    for (const entry of CAPTURE.reads)
      expect(`${entry.statement}: ${entry.refused ?? "answered"}`).toBe(`${entry.statement}: answered`);
    expect(CAPTURE.overBudget.refused).toBe("SnmpAgentError");
    const framework = CAPTURE.reads.find((entry) => entry.statement === "walk 1.3.6.1.6.3");
    expect(framework?.rowCount).toBeGreaterThan(0);
  });

  test("a walk of the enterprise subtree steps over Net-SNMP's access table: none of it answered, its reason warned", () => {
    expect(
      CAPTURE.steppedOver.map((entry) => [entry.statement, entry.refused, entry.warned, entry.insideWithheld]),
    ).toEqual([
      ["walk 1.3.6.1.4.1.8072.1", undefined, ["NET-SNMP-VACM-MIB"], 0],
      ["walk 1.3.6.1.4.1", undefined, ["NET-SNMP-VACM-MIB"], 0],
    ]);
    for (const entry of CAPTURE.steppedOver) expect(entry.rowCount).toBeGreaterThan(0);
    expect(CAPTURE.overBudget.message).toStartWith("Read-only execution exceeded the row budget: ");
  });
});
