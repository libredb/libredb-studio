/**
 * The modbusread request language: its server adapter, its admission, its prompt texts and its posture, each held to
 * the provider's own reader and constants so no copy of a bound can drift from the bound it names.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY, AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { fingerprintModbusread, modbusreadRowCapAdvice } from "@/lib/agent/languages/modbusread/adapter";
import {
  languageServer,
  languageServerPack,
  LANGUAGE_BASE_DEFINITIONS,
  WORKFLOW_TOOL_RULES,
} from "@/lib/agent/languages/server";
import { agentPosture } from "@/lib/agent/posture";
import {
  admitModbusreadStatement,
  MODBUSREAD_AGENT_MAX_STATEMENT_CHARS,
  modbusreadAgentReadInput,
} from "@/lib/db/operations/modbusread-admission";
import { MODBUS_AGENT_DEVICE_GAP_MS } from "@/lib/db/providers/industrial/modbus/agent-pacing";
import { MODBUS_AGENT_RUN_REQUESTS } from "@/lib/db/providers/industrial/modbus/agent-read";
import { MODBUS_AGENT_READS } from "@/lib/db/providers/industrial/modbus/agent-statement";
import { MAX_IDENTIFICATION_ROUNDS } from "@/lib/db/providers/industrial/modbus/constants";

const READ = '{"unit": 1, "table": "holding_register", "address": 0, "count": 10}';
const BUDGETS = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

describe("the server adapter", () => {
  test("the fingerprint is the read the reader sends, so one request written two ways is one identity", () => {
    const one = fingerprintModbusread(READ);
    expect(fingerprintModbusread('{"count":10,"address":0,"table":"holding_register","unit":1}')).toBe(one);
    expect(fingerprintModbusread('{"unit": 1, "table": "holding_register", "address": 1, "count": 10}')).not.toBe(one);
    expect(fingerprintModbusread('{"unit": 1, "table": "input_register", "address": 0, "count": 10}')).not.toBe(one);
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = '{"unit": 1, "table": "holding_register", "address": 0, "count": 1, "function": 6}';
    expect(fingerprintModbusread(raw)).toBe(fingerprintModbusread(raw));
    expect(fingerprintModbusread(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintModbusread(`${raw} `)).not.toBe(fingerprintModbusread(raw));
  });

  test("the row-cap advice names a smaller read, never a cut", () => {
    expect(AGENT_LANGUAGE_COPY.modbusread.adviceKeys).toEqual([]);
    expect(modbusreadRowCapAdvice(READ, "2")).toBe(
      'Ask for at most 2 rows: a points read answers one row per point it names, a block one row per coil, input or register (one per decoded value with "type"), and identification one row per object, so name fewer points, read a shorter block, or ask for a lower identification level.',
    );
    expect(languageServer("modbusread").shapeAdvice).toContain("a valid console request");
    expect(languageServer("modbusread").readOperation).toBe("modbusread.query.read");
  });
});

describe("the admission", () => {
  test("is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitModbusreadStatement(READ)).toBeNull();
    // With no connection in hand a point name is read for its shape; the provider reads it against the map.
    expect(admitModbusreadStatement('{"read": ["any point"]}')).toBeNull();
    expect(admitModbusreadStatement('{"unit": 0, "table": "coil", "address": 0, "count": 1}')).toEqual({
      code: "request",
      message: expect.stringContaining(MODBUS_AGENT_READS),
    });
    const long = `{"read": [${Array.from({ length: 600 }, (_unused, n) => `"p${n}"`).join(", ")}]}`;
    expect(long.length).toBeGreaterThan(MODBUSREAD_AGENT_MAX_STATEMENT_CHARS);
    expect(admitModbusreadStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The request is longer than ${MODBUSREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("modbusread").admit?.(READ)).toBeNull();
  });

  test("the descriptor's input is strict, carries the statement, and refuses what the admission refuses", () => {
    expect(modbusreadAgentReadInput.safeParse({ statement: READ }).success).toBe(true);
    expect(modbusreadAgentReadInput.safeParse({ statement: READ, sql: "x" }).success).toBe(false);
    const refused = modbusreadAgentReadInput.safeParse({ statement: '{"identify": "individual"}' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toStartWith('"identify" must be basic, regular, extended');
  });
});

describe("the prompt texts", () => {
  test("the tool description names the three shapes, the five requests and the provider's own bounds", () => {
    const tool = languageServerPack("modbusread").toolOverrides.investigation?.run_read_query;
    const description = tool?.description ?? "";
    expect(description).toContain('{"read": ["name", ...]}');
    expect(description).toContain('{"identify": "basic"}');
    expect(description).toContain(
      "Only Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers and Read Device Identification are sent",
    );
    expect(description).toContain(`with a ${MODBUS_AGENT_DEVICE_GAP_MS} ms gap after each`);
    expect(description).toContain(`at most ${MODBUS_AGENT_RUN_REQUESTS} requests to Modbus devices`);
    expect(description).toContain(`identification up to ${MAX_IDENTIFICATION_ROUNDS}`);
    expect(Object.keys(LANGUAGE_BASE_DEFINITIONS)).not.toContain("modbusread");
  });

  test("the rule, the grounding advice and the ungrounded note say the inventory is the map, never the device", () => {
    const rule = WORKFLOW_TOOL_RULES.modbusread.investigation as string;
    const fromTheMap =
      "Modbus has no discovery: the inventory lists the points the connection's register map names, read from the map and never from the device, and a connection with no map lists none, which says nothing about what the device holds.";
    expect(rule).toContain(fromTheMap);
    expect(rule).toContain(`at most ${MODBUS_AGENT_RUN_REQUESTS} requests to Modbus devices`);
    const grounding = languageServerPack("modbusread").grounding;
    expect(grounding.omissionAdvice).toStartWith(
      "Points are listed by name from the connection's register map, never with a value.",
    );
    expect(grounding.omissionAdvice).toContain(fromTheMap);
    expect(grounding.relations).toBe(false);
    expect(grounding.ungrounded?.("The capture failed.", { singular: "point", plural: "points" })).toBe(
      `The capture failed.\nSo nothing about this device has been established for you: not one point name. ${fromTheMap} Read what you need with run_read_query, starting with {"identify": "basic"}.`,
    );
    expect(grounding.planningRules).toBeUndefined();
  });

  test("only the investigation and the operations workflow are offered, and nothing auto-executes", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.modbusread).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.modbusread.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the posture on Modbus", () => {
  const posture = agentPosture({ mode: "agent", engine: "modbus", engineLabel: "Modbus", handover: false });

  test("names exactly what the agent sends and reads, and never a write", () => {
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(
      `${BUDGETS.maxResultRows} rows and ${BUDGETS.statementTimeoutMs / 1000} s per read, one read at a time per device, over a client that sends only Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers and Read Device Identification`,
    );
    expect(posture.body).toContain(
      "each one of the console's JSON read requests: points the connection's register map names, one block of one table, or the device identification objects",
    );
    expect(posture.body).toContain("so it cannot write. Nothing reaches your editor.");
    expect(posture.body).not.toMatch(/metadata only|withheld|four read function codes/);
  });

  test("states the pacing and the run's bound in the provider's own figures", () => {
    expect(MODBUS_AGENT_DEVICE_GAP_MS).toBe(1000);
    expect(posture.body).toContain(
      "Agent reads of one device never overlap, across every run on this server, and Studio waits one second after each before the next one dials",
    );
    expect(posture.body).toContain(`one run sends at most ${MODBUS_AGENT_RUN_REQUESTS} requests to Modbus devices`);
  });
});
