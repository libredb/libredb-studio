/**
 * The tool definitions the mqttread request language's workflows are offered: the statement tool for one MQTT read.
 */
import { z } from "zod";
import { MQTT_COMPLETENESS } from "@/lib/db/providers/keyvalue/mqtt/agent-read";
import { MQTT_AGENT_READS } from "@/lib/db/providers/keyvalue/mqtt/agent-statement";
import { MQTT_TOPICS_WITHHELD_SENTENCE } from "@/lib/db/providers/keyvalue/mqtt/agent-surface";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readMqttreadStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const MQTTREAD_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description: `Run one bounded MQTT read, written as one JSON object with the key read and, for the topic read, the key topic. ${MQTT_AGENT_READS} Each read is one fresh subscription that listens for the whole window and leaves; its one row says how long it listened (listened_ms of window_ms), why it stopped (stop_reason: budget-time when the window ended, budget-messages or budget-bytes when Studio's own budget ended it first, server-disconnect, transport-closed, or subscription-refused with the broker's reason code) and its scope, which is never complete. ${MQTT_COMPLETENESS} ${MQTT_TOPICS_WITHHELD_SENTENCE} A request with any other key, a topic with + or #, a topic beginning with $, a publish or a will is refused before anything is sent, and you are told why.`,
  inputSchema: readMqttreadStatementSchema,
  operationId: "mqttread.query.read",
});

const MQTTREAD_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: MQTTREAD_RUN_READ_QUERY,
});

/** The investigation sends reads through the one statement tool; `operations` sends none. */
export const MQTTREAD_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: MQTTREAD_STATEMENT_TOOLS,
});
