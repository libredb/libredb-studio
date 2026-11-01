/**
 * The mqttread request language: its server adapter, its admission, its prompt texts and its posture, each held to the
 * provider's own reader and constants so no copy of the reads, the window or the completeness sentence can drift from
 * what it names.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_WORKFLOW_VARIANTS,
  planDeliverableOf,
  workflowAvailability,
} from "@/lib/agent/agent-manifest";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { fingerprintMqttread, mqttreadRowCapAdvice } from "@/lib/agent/languages/mqttread/adapter";
import {
  languageServer,
  languageServerPack,
  LANGUAGE_BASE_DEFINITIONS,
  WORKFLOW_TOOL_RULES,
} from "@/lib/agent/languages/server";
import { agentPosture } from "@/lib/agent/posture";
import {
  admitMqttreadStatement,
  MQTTREAD_AGENT_MAX_STATEMENT_CHARS,
  mqttreadAgentReadInput,
} from "@/lib/db/operations/mqttread-admission";
import { MQTT_COMPLETENESS } from "@/lib/db/providers/keyvalue/mqtt/agent-read";
import { MQTT_AGENT_READS, MQTT_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/mqtt/agent-statement";
import { MQTT_TOPICS_WITHHELD_SENTENCE } from "@/lib/db/providers/keyvalue/mqtt/agent-surface";
import { MQTT_READ_BUDGET_MS } from "@/lib/db/providers/keyvalue/mqtt/constants";

const READ = '{"read": "topic", "topic": "plant/line1/temp"}';
const BUDGETS = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

describe("the server adapter", () => {
  test("the fingerprint is the plan the reader sends, so one request written two ways is one identity", () => {
    const one = fingerprintMqttread(READ);
    expect(fingerprintMqttread('{ "topic": "plant/line1/temp", "read": "topic" }')).toBe(one);
    expect(fingerprintMqttread('{"read": "topic", "topic": "plant/line1/temq"}')).not.toBe(one);
    expect(fingerprintMqttread('{"read": "window"}')).not.toBe(one);
  });

  test("the fingerprint is total: a refused request is identified by its raw text, so it is refused again", () => {
    const raw = '{"read": "publish"}';
    expect(fingerprintMqttread(raw)).toBe(fingerprintMqttread(raw));
    expect(fingerprintMqttread(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintMqttread(`${raw} `)).not.toBe(fingerprintMqttread(raw));
  });

  test("the row-cap advice says every read is one row", () => {
    expect(AGENT_LANGUAGE_COPY.mqttread.adviceKeys).toEqual([]);
    expect(mqttreadRowCapAdvice(READ, "0")).toBe(
      "Ask for at most 0 rows: an MQTT read answers one row, the window's totals or one topic's metadata, so a row budget of 1 holds every read.",
    );
    expect(languageServer("mqttread").shapeAdvice).toContain("a bounded MQTT read");
    expect(languageServer("mqttread").readOperation).toBe("mqttread.query.read");
  });
});

describe("the admission", () => {
  test("is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitMqttreadStatement(READ)).toBeNull();
    expect(admitMqttreadStatement('{"read": "topic", "topic": "plant/#"}')).toEqual({
      code: "metadata-only",
      message: MQTT_AGENT_SENTENCES.wildcard,
    });
    const long = JSON.stringify({ read: "topic", topic: "a".repeat(MQTTREAD_AGENT_MAX_STATEMENT_CHARS) });
    expect(admitMqttreadStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The request is longer than ${MQTTREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    // At the bound and not past it.
    const at = JSON.stringify({ read: "topic", topic: "a".repeat(MQTTREAD_AGENT_MAX_STATEMENT_CHARS - 27) });
    expect(at.length).toBe(MQTTREAD_AGENT_MAX_STATEMENT_CHARS);
    expect(admitMqttreadStatement(at)).toBeNull();
    expect(languageServer("mqttread").admit?.(READ)).toBeNull();
  });

  test("the descriptor's input is strict, carries the statement, and refuses what the admission refuses", () => {
    expect(mqttreadAgentReadInput.safeParse({ statement: READ }).success).toBe(true);
    expect(mqttreadAgentReadInput.safeParse({ statement: READ, sql: "x" }).success).toBe(false);
    const refused = mqttreadAgentReadInput.safeParse({ statement: '{"read": "publish"}' });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toBe(MQTT_AGENT_SENTENCES.notARead);
  });
});

describe("the prompt texts", () => {
  test("the list of reads names the window as the provider runs it", () => {
    expect(MQTT_AGENT_READS).toContain(`for a window of ${MQTT_READ_BUDGET_MS / 1000} seconds`);
    expect(MQTT_AGENT_READS).toContain("never a topic name");
    expect(MQTT_AGENT_READS).toContain("never its payload");
  });

  test("the topic read's flag, QoS and size are named as the last message's, never as a total", () => {
    // Seen in a browser pass: a model read `payload_bytes` of a topic with seven messages as their combined size, and
    // `retained: false` as "the messages were not retained" of a topic the broker held a retained message on.
    const lastMessage =
      "answers whether a message was seen on it and how many, and of the last message seen on it its retained flag, the QoS it was delivered at, its payload size and when it arrived";
    expect(MQTT_AGENT_READS).toContain(lastMessage);
    const posture = agentPosture({ mode: "agent", engine: "mqtt", engineLabel: "MQTT", handover: false });
    expect(posture.body).toContain(lastMessage);
  });

  test("the tool description names both reads, the window's columns, the completeness sentence and what is withheld", () => {
    const description = languageServerPack("mqttread").toolOverrides.investigation?.run_read_query?.description ?? "";
    expect(description).toContain(MQTT_AGENT_READS);
    expect(description).toContain("its scope, which is never complete");
    expect(description).toContain(MQTT_COMPLETENESS);
    expect(description).toContain(MQTT_TOPICS_WITHHELD_SENTENCE);
    expect(description).toContain("refused before anything is sent");
    // The one "does not exist" is the completeness sentence's own "never proof that a topic does not exist".
    expect(description.replace(MQTT_COMPLETENESS, "")).not.toContain("does not exist");
    expect(Object.keys(LANGUAGE_BASE_DEFINITIONS)).not.toContain("mqttread");
  });

  test("the rule reads a named topic directly, never guesses one, and never reports one absent", () => {
    const rule = WORKFLOW_TOOL_RULES.mqttread.investigation as string;
    expect(rule).toContain("When the question names a topic in full, read that topic directly");
    expect(rule).toContain("read the window");
    expect(rule).toContain("only for the broker's totals, never to look for a topic");
    expect(rule).toContain("never derive one from another");
    expect(rule).toContain("report a topic not seen as not seen in that window, never as absent");
    expect(rule).toContain(MQTT_COMPLETENESS);
    expect(rule).toContain(MQTT_TOPICS_WITHHELD_SENTENCE);
    const grounding = languageServerPack("mqttread").grounding;
    expect(grounding.omissionAdvice).toContain(MQTT_TOPICS_WITHHELD_SENTENCE);
    expect(grounding.omissionAdvice).toContain(MQTT_COMPLETENESS);
    expect(grounding.relations).toBe(false);
    expect(grounding.ungrounded?.("No inventory.", { singular: "topic", plural: "topics" })).toStartWith(
      "No inventory.\nSo nothing about this broker has been established for you: not one topic name. No topic is listed for the run, and none ever will be",
    );
    expect(grounding.planningRules).toBeUndefined();
    expect(grounding.ungroundedPlanning).toBeUndefined();
  });

  test("only the investigation and the operations workflow are offered, a plan is prose, and nothing auto-executes", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.mqttread).sort()).toEqual(["investigation", "operations"]);
    expect(AGENT_WORKFLOW_VARIANTS.mqttread.investigation?.canAutoExecute).toBe(false);
    expect(planDeliverableOf("mqttread", "investigation")).toEqual({ kind: "prose" });
    expect(workflowAvailability("agent", "investigation", "mqtt").open).toBe(true);
    expect(workflowAvailability("agent", "operations", "mqtt").open).toBe(true);
    expect(workflowAvailability("agent", "data-analysis", "mqtt").open).toBe(false);
  });
});

describe("the posture on MQTT", () => {
  const posture = agentPosture({ mode: "agent", engine: "mqtt", engineLabel: "MQTT", handover: false });

  test("names exactly what the agent reads, its window, what is withheld, and never a write", () => {
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(
      `metadata only, one row per read, each read one ${MQTT_READ_BUDGET_MS / 1000}-second window within ${BUDGETS.statementTimeoutMs / 1000} s, over an encoder that cannot write a publish or a will`,
    );
    expect(posture.body).toContain(`listens to every topic (the filter #) for ${MQTT_READ_BUDGET_MS / 1000} seconds`);
    expect(posture.body).toContain("that a topic not seen in the window may still exist");
    expect(posture.body).toContain("No answer names a topic or carries a payload, a user property or a $SYS reading");
    expect(posture.body).toContain(
      "cannot publish, register a will, take a shared subscription or write a topic filter",
    );
    expect(posture.body).not.toMatch(/does not exist/);
  });

  test("plan mode says what is true here: nothing is listed, and the connection only shakes hands", () => {
    const plan = agentPosture({ mode: "planning", engine: "mqtt", engineLabel: "MQTT", handover: false });
    expect(plan.qualifier).toBe(
      "no topic is listed for it; opening the connection is a handshake that subscribes to nothing",
    );
    expect(plan.body).not.toContain("schema read");
  });

  test("the hand-over is never offered", () => {
    const widened = agentPosture({ mode: "agent", engine: "mqtt", engineLabel: "MQTT", handover: true });
    expect(widened.headline).toBe("Reads only");
    expect(widened.qualifier).toBe(posture.qualifier);
  });
});
