/**
 * The tool definitions the sparkplugread request language's workflows are offered: the statement tool for one
 * Sparkplug read.
 */
import { z } from "zod";
import { SPARKPLUG_COMPLETENESS } from "@/lib/db/providers/industrial/sparkplug/agent-read";
import { SPARKPLUG_AGENT_READS } from "@/lib/db/providers/industrial/sparkplug/agent-statement";
import { SPARKPLUG_IDS_WITHHELD_SENTENCE } from "@/lib/db/providers/industrial/sparkplug/agent-surface";
import { DEFAULT_WINDOW_SECONDS } from "@/lib/db/providers/industrial/sparkplug/constants";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readSparkplugreadStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const SPARKPLUGREAD_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description: `Run one bounded Sparkplug read, written as one JSON object with the key read and, for an exact read, the keys group, edgeNode and device its level needs. ${SPARKPLUG_AGENT_READS} Each read is one fresh subscription inside one window of ${DEFAULT_WINDOW_SECONDS} seconds, which starts before the dial, so the handshake takes its share of it; its one row says how long the window ran (window_ms) and how long the subscription listened in it (listened_ms, from the subscription to the end of the read, never more than window_ms), why it stopped (stop_reason: time-budget when the window ended, message-budget or byte-budget when Studio's own budget ended it first, broker-closed, subscription-refused with the broker's reason code, or wildcards-unavailable), how many of its subscriptions the broker refused (subscriptions_refused) and its scope, which is never complete. An exact read's last_seen_ms is its last message's; its counts are the window's. ${SPARKPLUG_COMPLETENESS} ${SPARKPLUG_IDS_WITHHELD_SENTENCE} A request with any other key, an id with +, # or /, a group named STATE, a command, a rebirth, a host id, a publish or a will is refused before anything is sent, and you are told why.`,
  inputSchema: readSparkplugreadStatementSchema,
  operationId: "sparkplugread.query.read",
});

const SPARKPLUGREAD_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: SPARKPLUGREAD_RUN_READ_QUERY,
});

/** The investigation sends reads through the one statement tool; `operations` sends none. */
export const SPARKPLUGREAD_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: SPARKPLUGREAD_STATEMENT_TOOLS,
});
