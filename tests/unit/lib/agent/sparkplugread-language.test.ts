/**
 * The sparkplugread request language: its server adapter, its admission, its prompt texts and its posture, each held
 * to the provider's own reader and constants so no copy of the reads, the window or the completeness sentence can
 * drift from what it names.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_WORKFLOW_VARIANTS,
  planDeliverableOf,
  workflowAvailability,
} from "@/lib/agent/agent-manifest";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { fingerprintSparkplugread, sparkplugreadRowCapAdvice } from "@/lib/agent/languages/sparkplugread/adapter";
import {
  LANGUAGE_BASE_DEFINITIONS,
  languageServer,
  languageServerPack,
  WORKFLOW_TOOL_RULES,
} from "@/lib/agent/languages/server";
import { agentPosture } from "@/lib/agent/posture";
import {
  admitSparkplugreadStatement,
  SPARKPLUGREAD_AGENT_MAX_STATEMENT_CHARS,
  sparkplugreadAgentReadInput,
} from "@/lib/db/operations/sparkplugread-admission";
import { SPARKPLUG_COMPLETENESS } from "@/lib/db/providers/industrial/sparkplug/agent-read";
import {
  SPARKPLUG_AGENT_READS,
  SPARKPLUG_AGENT_SENTENCES,
} from "@/lib/db/providers/industrial/sparkplug/agent-statement";
import { SPARKPLUG_IDS_WITHHELD_SENTENCE } from "@/lib/db/providers/industrial/sparkplug/agent-surface";
import { DEFAULT_WINDOW_SECONDS } from "@/lib/db/providers/industrial/sparkplug/constants";

const READ = '{"read": "edgeNode", "group": "G1", "edgeNode": "E1"}';
const BUDGETS = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

describe("the server adapter", () => {
  test("the fingerprint is the plan the reader sends, so one request written two ways is one identity", () => {
    const one = fingerprintSparkplugread(READ);
    expect(fingerprintSparkplugread('{ "edgeNode": "E1", "group": "G1", "read": "edgeNode" }')).toBe(one);
    expect(fingerprintSparkplugread('{"read": "edgeNode", "group": "G1", "edgeNode": "E2"}')).not.toBe(one);
    expect(fingerprintSparkplugread('{"read": "window"}')).not.toBe(one);
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = '{"read": "publish"}';
    expect(fingerprintSparkplugread(raw)).toBe(fingerprintSparkplugread(raw));
    expect(fingerprintSparkplugread(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintSparkplugread(`${raw} `)).not.toBe(fingerprintSparkplugread(raw));
  });

  test("the row-cap advice says every read is one row", () => {
    expect(AGENT_LANGUAGE_COPY.sparkplugread.adviceKeys).toEqual([]);
    expect(sparkplugreadRowCapAdvice(READ, "0")).toBe(
      "Ask for at most 0 rows: a Sparkplug read answers one row, the window's totals or one group's, edge node's or device's counts, so a row budget of 1 holds every read.",
    );
    expect(languageServer("sparkplugread").shapeAdvice).toContain("a bounded Sparkplug read");
    expect(languageServer("sparkplugread").readOperation).toBe("sparkplugread.query.read");
  });
});

describe("the admission", () => {
  test("is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitSparkplugreadStatement(READ)).toBeNull();
    expect(admitSparkplugreadStatement('{"read": "group", "group": "G#"}')).toEqual({
      code: "metadata-only",
      message: SPARKPLUG_AGENT_SENTENCES.wildcard,
    });
    const long = JSON.stringify({ read: "group", group: "a".repeat(SPARKPLUGREAD_AGENT_MAX_STATEMENT_CHARS) });
    expect(admitSparkplugreadStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The request is longer than ${SPARKPLUGREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
  });

  test("the input schema is strict and carries the reader's sentence on the statement", () => {
    expect(sparkplugreadAgentReadInput.safeParse({ statement: READ }).success).toBe(true);
    expect(sparkplugreadAgentReadInput.safeParse({ statement: READ, sql: "x" }).success).toBe(false);
    const refused = sparkplugreadAgentReadInput.safeParse({ statement: '{"read": "NCMD"}' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(SPARKPLUG_AGENT_SENTENCES.notARead);
  });
});

describe("the prompt texts", () => {
  test("the list of reads names the window as the provider runs it, and withholds every id and metric", () => {
    expect(SPARKPLUG_AGENT_READS).toContain(`for a window of ${DEFAULT_WINDOW_SECONDS} seconds`);
    expect(SPARKPLUG_AGENT_READS).toContain("never an id");
    expect(SPARKPLUG_AGENT_READS).toContain("never a metric name or value");
  });

  test("the tool description names the reads, the window's columns, the completeness sentence and what is withheld", () => {
    const description =
      languageServerPack("sparkplugread").toolOverrides.investigation?.run_read_query?.description ?? "";
    expect(description).toContain(SPARKPLUG_AGENT_READS);
    expect(description).toContain("its scope, which is never complete");
    expect(description).toContain("An exact read's last_seen_ms is its last message's");
    expect(description).toContain(SPARKPLUG_COMPLETENESS);
    expect(description).toContain(SPARKPLUG_IDS_WITHHELD_SENTENCE);
    expect(description).toContain("refused before anything is sent");
    expect(description.replace(SPARKPLUG_COMPLETENESS, "")).not.toMatch(/\b(?:is|are) (?:online|offline)\b/);
    expect(Object.keys(LANGUAGE_BASE_DEFINITIONS)).not.toContain("sparkplugread");
  });

  test("the rule reads a named object directly, never guesses one, and never reports one absent or offline", () => {
    const rule = WORKFLOW_TOOL_RULES.sparkplugread.investigation as string;
    expect(rule).toContain("When the question names a group, an edge node or a device in full, read it directly");
    expect(rule).toContain("only for the plant's totals, never to look for an id");
    expect(rule).toContain("never derive one from another");
    expect(rule).toContain("report an object not seen as not seen in that window, never as absent or offline");
    expect(rule).toContain(SPARKPLUG_COMPLETENESS);
    expect(rule).toContain(SPARKPLUG_IDS_WITHHELD_SENTENCE);
    const grounding = languageServerPack("sparkplugread").grounding;
    expect(grounding.omissionAdvice).toContain(SPARKPLUG_IDS_WITHHELD_SENTENCE);
    expect(grounding.omissionAdvice).toContain(SPARKPLUG_COMPLETENESS);
    expect(grounding.relations).toBe(false);
    expect(grounding.ungrounded?.("No inventory.", { singular: "edge node", plural: "edge nodes" })).toStartWith(
      "No inventory.\nSo nothing about this plant has been established for you: not one edge node name. No group, edge node or device is listed for the run, and none ever will be",
    );
    expect(grounding.planningRules).toBeUndefined();
    expect(grounding.ungroundedPlanning).toBeUndefined();
  });

  test("only the investigation and the operations workflow are offered, a plan is prose, and nothing auto-executes", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.sparkplugread).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.sparkplugread.investigation?.canAutoExecute).toBe(false);
    expect(planDeliverableOf("sparkplugread", "investigation")).toEqual({ kind: "prose" });
    expect(workflowAvailability("agent", "investigation", "sparkplug").open).toBe(true);
    expect(workflowAvailability("agent", "operations", "sparkplug").open).toBe(true);
    expect(workflowAvailability("agent", "data-analysis", "sparkplug").open).toBe(false);
  });
});

describe("the posture on Sparkplug", () => {
  const posture = agentPosture({ mode: "agent", engine: "sparkplug", engineLabel: "Sparkplug B", handover: false });

  test("names exactly what the agent reads, its window, what is withheld, and never a write", () => {
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(
      `metadata only, one row per read, each read one ${DEFAULT_WINDOW_SECONDS}-second window within ${BUDGETS.statementTimeoutMs / 1000} s, over an encoder that cannot write a publish, a command or a will`,
    );
    expect(posture.body).toContain(`listens to the whole spBv1.0 namespace for ${DEFAULT_WINDOW_SECONDS} seconds`);
    expect(posture.body).toContain("that an edge node or device not seen in the window may still exist");
    expect(posture.body).toContain("no answer says a node is online or offline");
    expect(posture.body).toContain(
      "cannot publish, send a command or a rebirth request, take a host application's role, register a will or write a topic filter",
    );
  });

  test("plan mode says what is true here: nothing is listed, the connection only shakes hands, and why no request", () => {
    const plan = agentPosture({ mode: "planning", engine: "sparkplug", engineLabel: "Sparkplug B", handover: false });
    expect(plan.qualifier).toBe(
      "no group, edge node or device is listed for it; opening the connection is a handshake that subscribes to nothing",
    );
    expect(plan.body).not.toContain("schema read");
    expect(plan.body).toContain(
      "It drafts no read request: the editor's console request reads metric values, which agent mode never reads",
    );
  });

  test("the hand-over is never offered", () => {
    const widened = agentPosture({ mode: "agent", engine: "sparkplug", engineLabel: "Sparkplug B", handover: true });
    expect(widened.headline).toBe("Reads only");
    expect(widened.qualifier).toBe(posture.qualifier);
    expect(AGENT_LANGUAGE_COPY.sparkplugread.subject).toBe("a Sparkplug plant");
  });
});
