import type { z } from "zod";
import type { DatabaseType } from "@/lib/types";
import type { ToolResult } from "../output";
import type { McpToolCall } from "../context";
import { runStatement } from "./run-statement";
import { RUN_READ_QUERY_ARM, RunReadQueryInputSchema } from "./statement-arms";

/**
 * run_read_query (#246): the SQL arm of the MCP statement tools, run by the core in `run-statement.ts`.
 *
 * Its served engines come from the one served-engine resolver: those agent mode executes statements on, offered to MCP
 * by MCP_EXPOSABLE, opened to MCP statement reads by MCP_STATEMENT_READ, whose statement is SQL. The description names
 * them and the core refuses every other engine before anything is acquired, both from this one list, so the tool cannot
 * advertise an engine it refuses or run on one it does not name.
 *
 * The factory's profile does not draw this line: it refuses a provider with no read-only path at all. Kubernetes is
 * executed by the agent and closed to MCP. MongoDB is executed by the agent too, and its JSON command is read by its own
 * arm, run_mongo_command, so this tool refuses a MongoDB connection and names that tool.
 */

export { RunReadQueryInputSchema };
export type RunReadQueryInput = z.infer<typeof RunReadQueryInputSchema>;

export const RUN_READ_QUERY_TYPES: readonly DatabaseType[] = RUN_READ_QUERY_ARM.types;
/** Derived from the list, as src/lib/agent/posture.ts derives its own sentence. */
export const RUN_READ_QUERY_ENGINES = RUN_READ_QUERY_ARM.engines;
export const RUN_READ_QUERY_DESCRIPTION = RUN_READ_QUERY_ARM.description;

export function runReadQuery(args: RunReadQueryInput, call: McpToolCall): Promise<ToolResult> {
  return runStatement(RUN_READ_QUERY_ARM, args, call);
}
