/**
 * The SQL language's MCP facet: `run_read_query`, as SQL clients have always known it.
 *
 * It keeps the `sql` argument, the `database` key and offset paging, and MCP's own read-only statement fence reads it,
 * so a SQL client sees no change. Unknown input keys are dropped, as they always were.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const SQL_MCP_FACET = Object.freeze({
  tool: "run_read_query",
  title: "Run a read-only query",
  statementInput: z.string().min(1, "SQL cannot be empty"),
  takesDatabase: true,
  strictInput: false,
  paging: "offset",
  fence: "read-only-statement",
  holdsNoTables: false,
  /** Names no statement form beyond SELECT, because the others differ by engine; the refusal names the engine's own. */
  describe: ({ engines, limits }) =>
    `Run one read-only SQL statement on a connection. A SELECT (a WITH is fine) runs on every engine it serves; a refused statement's answer names what else that engine takes. Runs on ${engines}; other engines refuse it, and list_connections' read_tool names the tool that reads each connection. ${limits}, and pagination.nextOffset is the offset of the next page when the query can be paged.`,
} as const satisfies AgentLanguageMcpFacet);
