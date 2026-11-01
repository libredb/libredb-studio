/**
 * The agent's reader of one Sparkplug read request: the closed table of four reads, and every refusal decided by the
 * request's text alone, in agent mode's words, never quoting the request.
 */
import { describe, expect, test } from "bun:test";
import {
  readSparkplugAgentStatement,
  SPARKPLUG_AGENT_READS,
  SPARKPLUG_AGENT_SENTENCES,
} from "@/lib/db/providers/industrial/sparkplug/agent-statement";
import { SPARKPLUG_AGENT_MAX_ID_BYTES } from "@/lib/db/providers/industrial/sparkplug/constants";

function refusal(text: string) {
  const reading = readSparkplugAgentStatement(text);
  if (reading.ok) throw new Error(`admitted: ${text}`);
  return { code: reading.code, message: reading.message };
}

describe("the four reads of the closed table", () => {
  test("each maps to its one fixed plan, whatever the key order or spacing", () => {
    expect(readSparkplugAgentStatement('{"read": "window"}')).toEqual({ ok: true, plan: { op: "window" } });
    expect(readSparkplugAgentStatement(' { "group": "Plant A", "read": "group" } ')).toEqual({
      ok: true,
      plan: { op: "group", group: "Plant A" },
    });
    expect(readSparkplugAgentStatement('{"read": "edgeNode", "edgeNode": "E1", "group": "G1"}')).toEqual({
      ok: true,
      plan: { op: "edgeNode", group: "G1", edgeNode: "E1" },
    });
    expect(
      readSparkplugAgentStatement('{"read": "device", "group": "G1", "edgeNode": "E1", "device": "Pump 3"}'),
    ).toEqual({ ok: true, plan: { op: "device", group: "G1", edgeNode: "E1", device: "Pump 3" } });
  });

  test("an id at the length bound is admitted, and one byte past it is refused", () => {
    const longest = "a".repeat(SPARKPLUG_AGENT_MAX_ID_BYTES);
    expect(readSparkplugAgentStatement(JSON.stringify({ read: "group", group: longest })).ok).toBe(true);
    expect(refusal(JSON.stringify({ read: "group", group: `${longest}a` }))).toEqual({
      code: "request",
      message: SPARKPLUG_AGENT_SENTENCES.idText,
    });
    // Counted in UTF-8 bytes, not characters: 512 two-byte characters fit and one more does not.
    expect(readSparkplugAgentStatement(JSON.stringify({ read: "group", group: "é".repeat(512) })).ok).toBe(true);
    expect(refusal(JSON.stringify({ read: "group", group: "é".repeat(513) })).message).toBe(
      SPARKPLUG_AGENT_SENTENCES.idText,
    );
  });
});

describe("every refusal is decided by the text alone, before anything is sent", () => {
  test.each([
    ["", "request", "empty"],
    ["   ", "request", "empty"],
    ["not json", "request", "notObject"],
    ["[]", "request", "notObject"],
    ["null", "request", "notObject"],
    ['"window"', "request", "notObject"],
    ['{"read": "window", "read": "group"}', "request", "repeated"],
    ['{"read": "group", "group": "G1", "gr\\u006fup": "G2"}', "request", "repeated"],
    ['{"read": "window", "topic": "spBv1.0/#"}', "request", "keys"],
    ['{"read": "window", "filter": "$sparkplug/certificates/#"}', "request", "keys"],
    ['{"read": "window", "rebirth": true}', "request", "keys"],
    ['{"read": "window", "hostId": "H1"}', "request", "keys"],
    ['{"read": "window", "will": {}}', "request", "keys"],
    ['{"read": "window", "seconds": 60}', "request", "keys"],
    ['{"read": "window", "command": "Node Control/Rebirth"}', "request", "keys"],
    ['{"read": "publish"}', "metadata-only", "notARead"],
    ['{"read": "NCMD", "group": "G1", "edgeNode": "E1"}', "metadata-only", "notARead"],
    ['{"read": "DCMD"}', "metadata-only", "notARead"],
    ['{"read": "rebirth"}', "metadata-only", "notARead"],
    ['{"read": "state"}', "metadata-only", "notARead"],
    ['{"read": "toString"}', "metadata-only", "notARead"],
    ['{"read": 1}', "metadata-only", "notARead"],
    ['{"group": "G1"}', "metadata-only", "notARead"],
    ['{"read": "group"}', "request", "idsRequired"],
    ['{"read": "edgeNode", "group": "G1"}', "request", "idsRequired"],
    ['{"read": "device", "group": "G1", "edgeNode": "E1"}', "request", "idsRequired"],
    ['{"read": "device", "group": "G1", "device": "D1"}', "request", "idsRequired"],
    ['{"read": "window", "group": "G1"}', "request", "idsNotTaken"],
    ['{"read": "group", "group": "G1", "edgeNode": "E1"}', "request", "idsNotTaken"],
    ['{"read": "edgeNode", "group": "G1", "edgeNode": "E1", "device": "D1"}', "request", "idsNotTaken"],
    ['{"read": "group", "group": ""}', "request", "idText"],
    ['{"read": "group", "group": 7}', "request", "idText"],
    ['{"read": "group", "group": null}', "request", "idText"],
    ['{"read": "group", "group": ["G1"]}', "request", "idText"],
    ['{"read": "group", "group": "G\\u0000"}', "request", "idText"],
    ['{"read": "group", "group": "G\\ud800"}', "request", "idText"],
    ['{"read": "group", "group": "+"}', "metadata-only", "wildcard"],
    ['{"read": "group", "group": "#"}', "metadata-only", "wildcard"],
    ['{"read": "edgeNode", "group": "G1", "edgeNode": "E+"}', "metadata-only", "wildcard"],
    ['{"read": "device", "group": "G1", "edgeNode": "E1", "device": "D#"}', "metadata-only", "wildcard"],
    ['{"read": "group", "group": "G1/NDATA"}', "request", "separator"],
    ['{"read": "device", "group": "G1", "edgeNode": "E1", "device": "D1/x"}', "request", "separator"],
    ['{"read": "group", "group": "STATE"}', "metadata-only", "state"],
    ['{"read": "device", "group": "STATE", "edgeNode": "E1", "device": "D1"}', "metadata-only", "state"],
  ] as const)("%s is refused as %s (%s)", (text, code, sentence) => {
    expect(refusal(text)).toEqual({ code, message: SPARKPLUG_AGENT_SENTENCES[sentence] });
  });

  test("a group named like STATE in another case is an ordinary group, read by its own name", () => {
    expect(readSparkplugAgentStatement('{"read": "group", "group": "state"}').ok).toBe(true);
  });

  test("a wildcard and a / are refused alike whether or not the id they would find exists", () => {
    // The reader holds no broker state, so a hit and a miss cannot be told apart by the refusal: the sentence is a
    // constant of the text's shape.
    expect(refusal('{"read": "group", "group": "Plant#"}').message).toBe(
      refusal('{"read": "group", "group": "NoSuch#"}').message,
    );
  });

  test("no refusal quotes the request, and every one ends with the list of reads and nothing sent", () => {
    const marker = "zz-marker-zz";
    for (const text of [
      `{"read": "${marker}"}`,
      `{"read": "group", "group": "${marker}#"}`,
      `{"read": "window", "${marker}": 1}`,
      `${marker}`,
    ]) {
      const { message } = refusal(text);
      expect(message).not.toContain(marker);
      expect(message.endsWith(`${SPARKPLUG_AGENT_READS} Nothing was sent.`)).toBe(true);
    }
  });
});
