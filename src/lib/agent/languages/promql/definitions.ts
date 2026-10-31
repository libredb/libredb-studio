/**
 * The tool definitions the PromQL language's workflows are offered: the statement tool for one PromQL read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readPromqlStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const PROMQL_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded PromQL read: one expression, evaluated as an instant query at the server's own now, the way the console runs it. A selector or an aggregation answers a vector, one row per series with its labels and value; a range vector or a subquery at the top, such as up[5m] or rate(x[1m])[30m:1m], answers a matrix, every sample counted as a row. Write the expression alone: no time, range, step, limit or other request parameter can be written, a dashboard variable such as $__range is refused, and the server's time-out is set from the read's time budget. An answer holding more rows than the row budget, or more bytes than the byte budget, is refused rather than cut, and you are told why.",
  inputSchema: readPromqlStatementSchema,
  operationId: "promql.query.read",
});

const PROMQL_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: PROMQL_RUN_READ_QUERY,
});

/** Every PromQL workflow that sends a read shares the one statement tool; `operations` sends none. */
export const PROMQL_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: PROMQL_STATEMENT_TOOLS,
  "data-analysis": PROMQL_STATEMENT_TOOLS,
});
