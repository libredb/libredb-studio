/**
 * The opcuaread request language: its server adapter, its admission, its prompt texts and its posture, each held to
 * the provider's own reader and constants so no copy of a bound or of the withheld nodes can drift from what it names.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY, AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { fingerprintOpcuaread, opcuareadRowCapAdvice } from "@/lib/agent/languages/opcuaread/adapter";
import {
  languageServer,
  languageServerPack,
  LANGUAGE_BASE_DEFINITIONS,
  WORKFLOW_TOOL_RULES,
} from "@/lib/agent/languages/server";
import { agentPosture } from "@/lib/agent/posture";
import {
  admitOpcuareadStatement,
  OPCUAREAD_AGENT_MAX_STATEMENT_CHARS,
  opcuareadAgentReadInput,
} from "@/lib/db/operations/opcuaread-admission";
import { OPCUA_AGENT_MAX_REQUESTS } from "@/lib/db/providers/industrial/opcua/agent-read";
import { OPCUA_AGENT_READS } from "@/lib/db/providers/industrial/opcua/agent-statement";
import { OPCUA_WITHHELD_NODES, OPCUA_WITHHELD_SENTENCE } from "@/lib/db/providers/industrial/opcua/agent-withheld";
import { OPCUA_LABELS } from "@/lib/db/providers/industrial/opcua/labels";

const READ = '{"read": ["ns=3;s=SlowUInt1", "i=2256"]}';
const BUDGETS = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

describe("the server adapter", () => {
  test("the fingerprint is the read the reader sends, so one request written two ways is one identity", () => {
    const one = fingerprintOpcuaread(READ);
    expect(fingerprintOpcuaread('{ "read":["ns=3;s=SlowUInt1","ns=0;i=2256"] }')).toBe(one);
    expect(fingerprintOpcuaread('{"read": ["i=2256", "ns=3;s=SlowUInt1"]}')).not.toBe(one);
    expect(fingerprintOpcuaread('{"browse": "i=85"}')).toBe(fingerprintOpcuaread('{"browse":"ns=0;i=85"}'));
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = '{"write": "ns=3;s=SlowUInt1", "value": 1}';
    expect(fingerprintOpcuaread(raw)).toBe(fingerprintOpcuaread(raw));
    expect(fingerprintOpcuaread(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOpcuaread(`${raw} `)).not.toBe(fingerprintOpcuaread(raw));
  });

  test("the row-cap advice names a smaller read, never a cut", () => {
    expect(AGENT_LANGUAGE_COPY.opcuaread.adviceKeys).toEqual([]);
    expect(opcuareadRowCapAdvice(READ, "2")).toBe(
      "Ask for at most 2 rows: a value read answers one row per node it names, a history read one row per value in its window, and a browse one row per child of the node, so name fewer nodes, narrow the window or give it a limit, or browse a node further down.",
    );
    expect(languageServer("opcuaread").shapeAdvice).toContain("a valid console request");
    expect(languageServer("opcuaread").readOperation).toBe("opcuaread.query.read");
  });
});

describe("the admission", () => {
  test("is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitOpcuareadStatement(READ)).toBeNull();
    expect(admitOpcuareadStatement('{"call": "i=11492"}')).toEqual({
      code: "request",
      message: expect.stringContaining(OPCUA_AGENT_READS),
    });
    expect(admitOpcuareadStatement('{"browse": "i=15606"}')).toEqual({
      code: "withheld",
      message: expect.stringContaining("Server.ServerCapabilities.RoleSet (i=15606) is withheld"),
    });
    const long = `{"read": [${Array.from({ length: 400 }, (_unused, n) => `"ns=3;s=P${n}"`).join(", ")}]}`;
    expect(long.length).toBeGreaterThan(OPCUAREAD_AGENT_MAX_STATEMENT_CHARS);
    expect(admitOpcuareadStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The request is longer than ${OPCUAREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("opcuaread").admit?.(READ)).toBeNull();
  });

  test("the descriptor's input is strict, carries the statement, and refuses what the admission refuses", () => {
    expect(opcuareadAgentReadInput.safeParse({ statement: READ }).success).toBe(true);
    expect(opcuareadAgentReadInput.safeParse({ statement: READ, sql: "x" }).success).toBe(false);
    const refused = opcuareadAgentReadInput.safeParse({ statement: '{"read": []}' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toStartWith('"read" is a non-empty array of node ids');
  });
});

describe("the prompt texts", () => {
  test("the tool description names the three reads, the units, the withheld nodes and the request bound", () => {
    const description = languageServerPack("opcuaread").toolOverrides.investigation?.run_read_query?.description ?? "";
    expect(description).toContain('{"read": ["ns=3;s=SlowUInt1", ...]}');
    expect(description).toContain('{"browse": "i=85"}');
    expect(description).toContain('"no units published"');
    expect(description).toContain("report the unit beside every value, and never assume one");
    expect(description).toContain("Only Browse, BrowseNext, Read and HistoryRead are sent");
    expect(description).toContain(OPCUA_WITHHELD_SENTENCE);
    expect(description).toContain(`at most ${OPCUA_AGENT_MAX_REQUESTS} requests to the server`);
    expect(Object.keys(LANGUAGE_BASE_DEFINITIONS)).not.toContain("opcuaread");
  });

  test("the rule, the grounding advice and the ungrounded note say how the address space is reached and the units rule", () => {
    const rule = WORKFLOW_TOOL_RULES.opcuaread.investigation as string;
    const browsed =
      'An OPC UA address space is browsed one level at a time rather than listed, so no node is listed for the run: read a node id the question names exactly as it is written, without browsing to it first, and browse from the Objects folder with {"browse": "i=85"} only to find a node the question does not name, going down from what it answers.';
    const units =
      "Every value row carries the node's engineering units and EU range as the server publishes them, or \"no units published\": report the unit beside each value, and never assume one from a node's name.";
    expect(rule).toContain(browsed);
    expect(rule).toContain("Write any other node id exactly as a browse answers it");
    expect(rule).toContain(units);
    expect(rule).toContain(OPCUA_WITHHELD_SENTENCE);
    const grounding = languageServerPack("opcuaread").grounding;
    expect(grounding.omissionAdvice).toBe(`${browsed} ${units} ${OPCUA_WITHHELD_SENTENCE}`);
    expect(grounding.relations).toBe(false);
    expect(grounding.ungrounded?.("No inventory.", { singular: "node", plural: "nodes" })).toBe(
      `No inventory.\nSo nothing about this server has been established for you: not one node name. ${browsed} ${units} ${OPCUA_WITHHELD_SENTENCE}`,
    );
    expect(grounding.planningRules).toBeUndefined();
  });

  test("the withheld sentence names every withheld node by its id", () => {
    for (const entry of OPCUA_WITHHELD_NODES) expect(OPCUA_WITHHELD_SENTENCE).toContain(`(${entry.nodeId})`);
  });

  test("plan mode follows the provider's statement label, which names the console's two reads and the withheld nodes", () => {
    const label = OPCUA_LABELS.statementLanguage ?? "";
    expect(label).toContain('{"read": ["ns=3;s=SlowUInt1", ...]}');
    expect(label).toContain('{"history": "ns=3;s=HistorianInt32"');
    expect(label).not.toContain('"browse"');
    for (const entry of OPCUA_WITHHELD_NODES) expect(label).toContain(entry.nodeId);
  });

  test("only the investigation and the operations workflow are offered, and nothing auto-executes", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.opcuaread).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.opcuaread.investigation?.canAutoExecute).toBe(false);
  });
});

describe("the posture on OPC UA", () => {
  const posture = agentPosture({ mode: "agent", engine: "opcua", engineLabel: "OPC UA", handover: false });

  test("names exactly what the agent sends and reads, the units, the withheld nodes, and never a write", () => {
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(
      `${BUDGETS.maxResultRows} rows and ${BUDGETS.statementTimeoutMs / 1000} s per read, one session per read, over a client that sends only Browse, BrowseNext, Read and HistoryRead`,
    );
    expect(posture.body).toContain('or "no units published" where it publishes none, never a unit Studio guessed');
    expect(posture.body).toContain("ServerConfiguration, RoleSet and session diagnostics");
    expect(posture.body).toContain("Each read opens its own session and closes it, so nothing is held between reads.");
    expect(posture.body).toContain("so it cannot write a value, call a method, change a node or subscribe");
    expect(posture.body).not.toMatch(/metadata only/);
  });

  test("plan mode says it reads nothing from the server, since no inventory grounds it", () => {
    const plan = agentPosture({ mode: "planning", engine: "opcua", engineLabel: "OPC UA", handover: false });
    expect(plan.qualifier).toBe(
      "nothing is read from the server to ground it, and the request it drafts is never sent",
    );
    expect(plan.body).toContain("plan mode reads nothing from the server");
  });

  test("the hand-over is never offered", () => {
    const posture = agentPosture({ mode: "agent", engine: "opcua", engineLabel: "OPC UA", handover: true });
    expect(posture.headline).toBe("Reads only");
  });
});
