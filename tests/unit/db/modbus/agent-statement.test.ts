/**
 * The agent's reader of one Modbus request: the console's three shapes, read by the console's own parser, and every
 * other text refused before anything is sent, in agent mode's own words followed by the list of reads.
 */
import { describe, expect, test } from "bun:test";
import {
  MODBUS_AGENT_READS,
  MODBUS_AGENT_SENTENCES,
  readModbusAgentStatement,
} from "@/lib/db/providers/industrial/modbus/agent-statement";

const refusal = (text: string, names: ReadonlySet<string> | null = null): string => {
  const reading = readModbusAgentStatement(text, names);
  if (reading.ok) throw new Error(`admitted: ${text}`);
  expect(reading.code).toBe("request");
  return reading.message;
};

describe("the three console shapes are admitted as the console writes them", () => {
  test("named points, read for their shape alone when no map is in hand", () => {
    expect(readModbusAgentStatement('{"read": ["volts", "amps"]}')).toEqual({
      ok: true,
      plan: { kind: "points", names: ["volts", "amps"] },
    });
  });

  test("named points read against the map when one is in hand", () => {
    expect(readModbusAgentStatement('{"read": ["volts"]}', new Set(["volts"])).ok).toBe(true);
    expect(refusal('{"read": ["watts"]}', new Set(["volts"]))).toBe(
      MODBUS_AGENT_SENTENCES.request('The register map has no point named "watts".'),
    );
    // An absent map is not an empty device: the refusal says there is no map, not that the point is missing.
    expect(refusal('{"read": ["volts"]}', new Set())).toStartWith("This connection carries no register map");
  });

  test("one raw block, decoded or not", () => {
    expect(readModbusAgentStatement('{"unit": 1, "table": "holding_register", "address": 0, "count": 10}')).toEqual({
      ok: true,
      plan: { kind: "range", unitId: 1, table: "holding_register", address: 0, count: 10 },
    });
    expect(
      readModbusAgentStatement(
        '{"unit": 255, "table": "input_register", "address": 2, "count": 4, "type": "float32", "wordOrder": "low_first"}',
      ),
    ).toEqual({
      ok: true,
      plan: {
        kind: "range",
        unitId: 255,
        table: "input_register",
        address: 2,
        count: 4,
        type: "float32",
        wordOrder: "low_first",
      },
    });
  });

  test("identification at each of its three levels", () => {
    for (const level of ["basic", "regular", "extended"] as const) {
      expect(readModbusAgentStatement(`{"identify": "${level}"}`)).toEqual({
        ok: true,
        plan: { kind: "identify", level },
      });
    }
  });
});

describe("every other text is refused before anything is sent, with the list of reads", () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["not JSON", "write 40001 1", /^The read request is not valid JSON/],
    ["a list", "[1]", /^A read request is a JSON object, and this is a list/],
    ["no shape", '{"function": 6}', /^A read request carries "read" for named points/],
    [
      "a function code by number",
      '{"unit": 1, "table": "holding_register", "address": 0, "count": 1, "function": 6}',
      /carries no key "function"/,
    ],
    [
      "a write table",
      '{"unit": 1, "table": "write_register", "address": 0, "count": 1}',
      /^"table" must be one of coil, discrete_input, holding_register, input_register/,
    ],
    [
      "a value to write",
      '{"unit": 1, "table": "coil", "address": 0, "count": 1, "value": true}',
      /carries no key "value"/,
    ],
    [
      "the broadcast unit",
      '{"unit": 0, "table": "coil", "address": 0, "count": 1}',
      /^Unit id must be a whole number from 1 to 255\. Unit 0 is a broadcast/,
    ],
    [
      "a unit past a byte",
      '{"unit": 256, "table": "coil", "address": 0, "count": 1}',
      /^Unit id must be a whole number from 1 to 255/,
    ],
    [
      "an address past 65535",
      '{"unit": 1, "table": "coil", "address": 65536, "count": 1}',
      /^Address must be a whole number from 0 to 65535/,
    ],
    [
      "a block past the table",
      '{"unit": 1, "table": "holding_register", "address": 65530, "count": 10}',
      /passes the end of the table/,
    ],
    [
      "an overlong register count",
      '{"unit": 1, "table": "holding_register", "address": 0, "count": 126}',
      /from 1 to 125 for registers/,
    ],
    ["an overlong bit count", '{"unit": 1, "table": "coil", "address": 0, "count": 2001}', /from 1 to 2000 for bits/],
    ["a zero count", '{"unit": 1, "table": "coil", "address": 0, "count": 0}', /from 1 to 2000 for bits/],
    ["an identify object range", '{"identify": "extended", "objectId": 128}', /carries no key "objectId"/],
    ["an individual identify", '{"identify": "individual"}', /^"identify" must be basic, regular, extended/],
    ["two shapes", '{"read": ["x"], "identify": "basic"}', /^A read request carries one shape, and this one carries 2/],
    ["a diagnostic", '{"diagnostic": 1}', /^A read request carries "read"/],
  ];
  for (const [label, text, opening] of cases) {
    test(label, () => {
      const message = refusal(text);
      expect(message).toMatch(opening);
      expect(message).toEndWith(`. ${MODBUS_AGENT_READS} Nothing was sent.`);
    });
  }

  test("the sentence keeps one full stop between the parser's refusal and the list of reads", () => {
    expect(MODBUS_AGENT_SENTENCES.request("No.")).toBe(`No. ${MODBUS_AGENT_READS} Nothing was sent.`);
    expect(MODBUS_AGENT_SENTENCES.request("No")).toBe(`No. ${MODBUS_AGENT_READS} Nothing was sent.`);
  });

  test("the list of reads names the three shapes and no write", () => {
    expect(MODBUS_AGENT_READS).toContain('{"read": ["name", ...]}');
    expect(MODBUS_AGENT_READS).toContain('{"identify": "basic"}');
    expect(MODBUS_AGENT_READS).toContain("never a write");
  });

  test("a defect that is not the parser's refusal rises unchanged", () => {
    const broken = {
      size: 1,
      has: () => {
        throw new TypeError("a defect in the map reader");
      },
    } as unknown as ReadonlySet<string>;
    expect(() => readModbusAgentStatement('{"read": ["volts"]}', broken)).toThrow(TypeError);
  });
});
