/**
 * The tool definitions the Cypher language's workflows are offered: the statement tool for one read statement.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readCypherStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const CYPHER_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded read-only Cypher statement against the connection's database: a MATCH ... RETURN, a SHOW of indexes, constraints, procedures or functions, or a CALL of db.labels(), db.relationshipTypes(), db.propertyKeys() or db.schema.visualization(). One statement, with no comment and no parameters. Backtick a name that holds spaces or a reserved word and single-quote a string. Every write, LOAD CSV, USE, CALL { } IN TRANSACTIONS, any other procedure and every extension function are refused before anything is sent, and you are told why.",
  inputSchema: readCypherStatementSchema,
  operationId: "cypher.query.read",
});

const CYPHER_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: CYPHER_RUN_READ_QUERY,
});

/** Every Cypher workflow that sends a statement shares the one statement tool; `operations` sends none. */
export const CYPHER_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: CYPHER_STATEMENT_TOOLS,
  "data-analysis": CYPHER_STATEMENT_TOOLS,
});
