/**
 * The tool definitions the netconfrpc request language's workflows are offered: the statement tool for one NETCONF
 * read.
 */
import { z } from "zod";
import { NETCONF_WITHHELD_TEXT } from "@/lib/db/providers/network/netconf/agent-withheld";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readNetconfrpcStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const NETCONFRPC_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description: `Run one bounded NETCONF read, written as one JSON object: {"datastore": "running", "path": "ietf-interfaces:interfaces", "limit": 100} for the configuration (running, candidate or startup, read with get-config) or the configuration and state (operational or intended, read with get-data) under a path that names its module on its first node, one more name per level and a list entry's keys after = (interface=eth0); or {"schema": "ietf-interfaces"} for one module's YANG text (get-schema). Values are answered as text, as the console renders them, one row per entry of the list at the end of the path. ${NETCONF_WITHHELD_TEXT} Before every read Studio reads the device's YANG modules to decide what is withheld, and a read it could not decide is refused, never answered unchecked. A path that names a withheld node, a node inside one, or a key that is a withheld leaf is refused before it is sent; a read covering one answers [withheld] in its place and names it in a warning. Every other operation and field is refused before anything is sent, and a list holding more entries than the limit or the row budget is refused rather than cut, and you are told why.`,
  inputSchema: readNetconfrpcStatementSchema,
  operationId: "netconfrpc.query.read",
});

const NETCONFRPC_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: NETCONFRPC_RUN_READ_QUERY,
});

/** The investigation sends reads through the one statement tool; `operations` sends none. */
export const NETCONFRPC_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: NETCONFRPC_STATEMENT_TOOLS,
});
