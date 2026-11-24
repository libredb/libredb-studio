/**
 * The openings of SQL Server's own read-only refusals, in the SQL family's core module, where the provider that raises
 * them and MCP's `run_read_query` both read them, and the answer MCP's `run_read_query` gives for the two that are about
 * a result too large to read.
 *
 * The provider raises each refusal as its budget's class (`CutValueRefusal`, `SerialisedResultRefusal`,
 * `TimeBudgetRefusal`), and MCP's `run_read_query` answers the first two with the texts below by that class, never by
 * the opening (`classifyReadQueryFailure` in `src/lib/mcp/tools/read-query-limits.ts`). This module is a leaf, so the
 * MCP server reads it without loading the driver.
 */

/** The opening of the refusal of a value the server cut at the byte ceiling. */
export const MSSQL_CUT_VALUE_PREFIX = "Read-only execution refused a value the server cut at the byte budget";

/** The opening of the refusal of a FOR JSON or FOR XML result, which the row budget cannot bound. */
export const MSSQL_SERIALISED_PREFIX = "Read-only execution cannot bound a serialised result";

/** The opening of the refusal of a statement cancelled at the time budget. */
export const MSSQL_TIME_BUDGET_PREFIX = "Read-only execution exceeded its time budget";

/** What `run_read_query` answers a value cut at the byte ceiling with. */
export const MSSQL_CUT_VALUE_TEXT =
  "One value in this result is 1 MiB or larger, and SQL Server cut it at the most this server reads for one call. Select fewer or narrower columns, for example a substring of a long text column.";

/** What `run_read_query` answers a serialised result with. */
export const MSSQL_SERIALISED_TEXT =
  "SQL Server returns a FOR JSON or FOR XML result as one serialised value, which this server cannot bound. Select the rows themselves, without the FOR JSON or FOR XML clause.";
