/**
 * The tool definitions the InfluxQL language's workflows are offered: the statement tool for one read statement.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readInfluxqlStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const INFLUXQL_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded read-only InfluxQL statement against the connection's database: a SELECT, a SHOW of the catalog (DATABASES, RETENTION POLICIES, MEASUREMENTS, SERIES, TAG KEYS, TAG VALUES, FIELD KEYS, or one of their CARDINALITY forms) or an EXPLAIN of a SELECT. One statement, with no comment. Double-quote a name and single-quote a string. INTO, every write, SHOW QUERIES, SHOW USERS and the server's other administration reads are refused before anything is sent, and you are told why.",
  inputSchema: readInfluxqlStatementSchema,
  operationId: "influxql.query.read",
});

const INFLUXQL_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: INFLUXQL_RUN_READ_QUERY,
});

/** Every InfluxQL workflow that sends a statement shares the one statement tool; `operations` sends none. */
export const INFLUXQL_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: INFLUXQL_STATEMENT_TOOLS,
  "data-analysis": INFLUXQL_STATEMENT_TOOLS,
});
