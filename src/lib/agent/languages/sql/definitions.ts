/**
 * The statement tools SQL's workflows are offered (#1821): the catalog, the read, the plan and the profile. They are
 * the reference definitions, the ones `AGENT_TOOL_DEFINITIONS` holds, and every other family's `toolOverrides` replace
 * them by name.
 */
import { z } from "zod";
import { catalogSelectorSchema, profileSelectorSchema } from "../../tool-contracts";
import type { AgentToolDefinition, AgentToolName } from "../../tools";

const readStatementSchema = z.strictObject({
  sql: z.string().min(1),
  /**
   * Why the model wrote this statement. Accepted here and NOT recorded at this
   * commit: the `statement-drafted` event that carries it (`types.ts`) is emitted by
   * the run service, which does not exist yet. It is in the declared contract so the
   * model is asked for it from the first run rather than having the tool's shape
   * change under it later. Deliberately no `min(1)`: refusing an otherwise valid read
   * because its rationale came back blank would be a disproportionate refusal.
   */
  rationale: z.string().optional(),
});

/**
 * What `inspect_plan` takes on SQL. Exported for the SQL pack's arms (`./index.ts`), which declare it as
 * the SQL arm's input, held equal to the offered schema by `tests/unit/lib/agent/tool-offer-census.test.ts`.
 */
export const planStatementSchema = z.strictObject({ sql: z.string().min(1) });

/**
 * The four statement definitions, in the order `AGENT_TOOL_DEFINITIONS` lists them. Each entry keeps its own schema
 * type, so the arm that parses a model's argument reads the schema the model was offered.
 */
export const SQL_STATEMENT_DEFINITIONS = Object.freeze({
  inspect_schema: Object.freeze({
    name: "inspect_schema",
    description:
      "Read the database's own catalog of user objects, optionally narrowed to one schema or table. The engine's system schemas and catalog or statistics views are not listed: read one of those directly with run_read_query. Pass kind to choose the inventory: columns (the default: tables and their columns), relations (foreign keys) or indexes. The statement is composed by the server; you supply only the selector. On a large database pass a schema or table selector: the result is subject to the same row budget as any read and is refused, not truncated, if it overflows.",
    inputSchema: catalogSelectorSchema,
    operationId: "sql.query.read",
  }),
  run_read_query: Object.freeze({
    name: "run_read_query",
    description:
      "Run one bounded read-only SQL statement. Writes, DDL and multi-statement text are refused before the database is reached.",
    inputSchema: readStatementSchema,
    operationId: "sql.query.read",
  }),
  inspect_plan: Object.freeze({
    name: "inspect_plan",
    description:
      "Ask the engine for the ESTIMATED plan of one read-only statement. The plan is described, never executed, so no timings are produced.",
    inputSchema: planStatementSchema,
    operationId: "sql.explain.estimate",
  }),
  profile_table: Object.freeze({
    name: "profile_table",
    description:
      "Profile one table the run has already inventoried. The server chooses the columns from the captured schema and composes the aggregates; you supply only the table and how deep to go. Depth basic counts rows and missing values, distribution adds distinct counts, pattern adds a shape test for personal data. Only COUNTS are returned — no value is ever read out of a column.",
    inputSchema: profileSelectorSchema,
    operationId: "sql.table.profile",
  }),
} satisfies Partial<Record<AgentToolName, AgentToolDefinition>>);
