/**
 * The tool definitions the opcuaread request language's workflows are offered: the statement tool for one OPC UA read.
 */
import { z } from "zod";
import { OPCUA_AGENT_MAX_REQUESTS } from "@/lib/db/providers/industrial/opcua/agent-read";
import { OPCUA_WITHHELD_SENTENCE } from "@/lib/db/providers/industrial/opcua/agent-withheld";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readOpcuareadStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const OPCUAREAD_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description: `Run one bounded OPC UA read, written as one JSON object: {"read": ["ns=3;s=SlowUInt1", ...]} for the current value of each node, one row per node; {"history": "ns=3;s=HistorianInt32", "start": "2026-10-31T00:00:00Z", "end": "2026-10-31T01:00:00Z", "limit": 100} for one node's raw history, one row per value (start, end and limit optional); or {"browse": "i=85"} for the children of one node, one row per reference, starting from the Objects folder i=85. Write a node id with its namespace index (ns=3;s=...) or in namespace 0 with no prefix (i=2256), as a browse answers it. Every value row carries the node's engineering units (units, unitId, unitNamespace) and EU range (euRange) as the server publishes them, or "no units published" and "no range published" where it publishes none: report the unit beside every value, and never assume one. Only Browse, BrowseNext, Read and HistoryRead are sent: a Write, a method Call, any other key, an index range and every other request are refused before anything is sent. ${OPCUA_WITHHELD_SENTENCE} A value read naming a withheld node answers its row with statusCode Withheld and no value, a browse steps over a withheld child and names it in a warning, and a history read or a browse of one is refused. One read sends at most ${OPCUA_AGENT_MAX_REQUESTS} requests to the server, counting the units lookup; a read holding more rows than the row budget, or needing more requests, is refused rather than cut, and you are told why.`,
  inputSchema: readOpcuareadStatementSchema,
  operationId: "opcuaread.query.read",
});

const OPCUAREAD_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: OPCUAREAD_RUN_READ_QUERY,
});

/** The investigation sends requests through the one statement tool; `operations` sends none. */
export const OPCUAREAD_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: OPCUAREAD_STATEMENT_TOOLS,
});
