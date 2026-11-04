/**
 * The agent's reader of one OPC UA request: the console's two read requests, read by the console's own parser, the
 * one-level browse agent mode adds, node ids in their canonical spelling, and every other text refused in agent mode's
 * own words followed by the list of reads. Which ids a read may answer is the read roots' to say, on the read's session.
 */
import { describe, expect, test } from "bun:test";
import {
  OPCUA_AGENT_READS,
  OPCUA_AGENT_SENTENCES,
  readOpcuaAgentStatement,
} from "@/lib/db/providers/industrial/opcua/agent-statement";
import { OPCUA_READ_ROOTS_SENTENCE } from "@/lib/db/providers/industrial/opcua/agent-roots";
import { OPCUA_HISTORY_VALUE_CAP } from "@/lib/db/providers/industrial/opcua/constants";

const refusal = (text: string): string => {
  const reading = readOpcuaAgentStatement(text);
  if (reading.ok) throw new Error(`admitted: ${text}`);
  expect(reading.code).toBe("request");
  return reading.message;
};

describe("the three agent reads are admitted", () => {
  test("a value read, every node id in its canonical spelling", () => {
    expect(readOpcuaAgentStatement('{"read": ["ns=3;s=SlowUInt1", "ns=0;i=2256", "i=2258"]}')).toEqual({
      ok: true,
      plan: { kind: "read", nodeIds: ["ns=3;s=SlowUInt1", "i=2256", "i=2258"] },
    });
  });

  test("a value read may name any node: one outside the read roots answers as missing, decided on the session", () => {
    expect(readOpcuaAgentStatement('{"read": ["i=12637"]}')).toEqual({
      ok: true,
      plan: { kind: "read", nodeIds: ["i=12637"] },
    });
  });

  test("a history read, with its window and limit as the console reads them", () => {
    expect(
      readOpcuaAgentStatement(
        '{"history": "ns=3;s=HistorianInt32", "start": "2026-10-31T00:00:00Z", "end": "2026-10-31T01:00:00Z", "limit": 50}',
      ),
    ).toEqual({
      ok: true,
      plan: {
        kind: "history",
        nodeId: "ns=3;s=HistorianInt32",
        start: new Date("2026-10-31T00:00:00Z"),
        end: new Date("2026-10-31T01:00:00Z"),
        limit: 50,
        limitStated: true,
      },
    });
    expect(readOpcuaAgentStatement('{"history": "ns=3;s=HistorianInt32"}')).toEqual({
      ok: true,
      plan: { kind: "history", nodeId: "ns=3;s=HistorianInt32", limit: OPCUA_HISTORY_VALUE_CAP, limitStated: false },
    });
  });

  test("a one-level browse of a node", () => {
    expect(readOpcuaAgentStatement('{"browse": "ns=0;i=85"}')).toEqual({
      ok: true,
      plan: { kind: "browse", nodeId: "i=85" },
    });
  });
});

describe("everything else is refused before anything is sent, with the list of reads", () => {
  test("the console parser's refusals, followed by agent mode's list", () => {
    expect(refusal("not json")).toEndWith(`${OPCUA_AGENT_READS} Nothing was sent.`);
    expect(refusal('{"read": []}')).toBe(OPCUA_AGENT_SENTENCES.request('"read" is a non-empty array of node ids.'));
    expect(refusal('{"read": ["x"], "write": 1}')).toBe(
      OPCUA_AGENT_SENTENCES.request('A value read takes "read" only, and this names "write".'),
    );
    expect(refusal('{"write": "ns=3;s=x", "value": 1}')).toStartWith('A request names "read", "history" or "browse"');
    expect(refusal('{"call": "i=11492"}')).toContain(OPCUA_AGENT_READS);
    expect(refusal("[]")).toContain(OPCUA_AGENT_READS);
    expect(refusal("")).toContain(OPCUA_AGENT_READS);
  });

  test("a browse takes one node id and nothing else", () => {
    expect(refusal('{"browse": "i=85", "direction": "inverse"}')).toBe(
      OPCUA_AGENT_SENTENCES.request('A browse takes "browse" only, and this names "direction".'),
    );
    expect(refusal('{"browse": ["i=85"]}')).toBe(
      OPCUA_AGENT_SENTENCES.request('"browse" is one node id, such as "i=85" for the Objects folder.'),
    );
    expect(refusal('{"browse": "Objects"}')).toBe(
      OPCUA_AGENT_SENTENCES.request('"browse" is one node id, such as "i=85" for the Objects folder.'),
    );
    expect(refusal('{"browse": "i=85", "read": ["i=85"]}')).toBe(
      OPCUA_AGENT_SENTENCES.request("A request reads values, history or one level of nodes, one at a time."),
    );
  });

  test("an index range, a data encoding or an attribute are fields the table does not hold", () => {
    expect(refusal('{"read": ["ns=3;s=x"], "indexRange": "0:1"}')).toContain('names "indexRange"');
    expect(refusal('{"read": ["ns=3;s=x"], "dataEncoding": "Default XML"}')).toContain('names "dataEncoding"');
    expect(refusal('{"history": "ns=3;s=x", "attributeId": 13}')).toContain('names "attributeId"');
  });

  test("an nsu= namespace keeps its URI for the server's namespace table, and namespace 0's URI is namespace 0", () => {
    expect(readOpcuaAgentStatement('{"read": ["nsu=urn:plant;s=x", "nsu=urn:plant;b=AR"]}')).toEqual({
      ok: true,
      plan: { kind: "read", nodeIds: ["nsu=urn:plant;s=x", "nsu=urn:plant;b=AQ=="] },
    });
    expect(readOpcuaAgentStatement('{"browse": "nsu=http://opcfoundation.org/UA/;i=2253"}')).toEqual({
      ok: true,
      plan: { kind: "browse", nodeId: "i=2253" },
    });
  });

  test("an id that cannot be put in one spelling is refused with the list of reads", () => {
    const sentence =
      "A node id in the request cannot be put in one spelling: its identifier does not decode, so Studio cannot tell which node it names.";
    expect(refusal('{"read": ["ns=2;b=A=Q="]}')).toBe(OPCUA_AGENT_SENTENCES.request(sentence));
    expect(refusal('{"browse": "nsu=urn:plant;ns=2;i=5"}')).toContain("cannot be put in one spelling");
    expect(refusal('{"history": "ns=2;b=A"}')).toContain("cannot be put in one spelling");
  });

  test("a history read or a browse of any node is admitted here: the read roots decide it on the read's session", () => {
    for (const text of ['{"browse": "i=12642"}', '{"history": "ns=0;i=16192"}', '{"browse": "ns=0;i=12637"}'])
      expect(readOpcuaAgentStatement(text).ok).toBe(true);
  });
});

describe("the list of reads", () => {
  test("names the three reads and the read roots rule", () => {
    expect(OPCUA_AGENT_READS).toContain('{"read": [');
    expect(OPCUA_AGENT_READS).toContain('{"history": ');
    expect(OPCUA_AGENT_READS).toContain('{"browse": "i=85"} lists the read roots');
    expect(OPCUA_AGENT_READS).toContain(OPCUA_READ_ROOTS_SENTENCE);
    expect(OPCUA_AGENT_READS).not.toContain("ithheld");
    expect(OPCUA_AGENT_READS).toContain("never a Write, a method Call");
  });
});
