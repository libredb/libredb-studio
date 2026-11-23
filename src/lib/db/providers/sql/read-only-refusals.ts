import { MSSQL_CUT_VALUE_TEXT, MSSQL_SERIALISED_TEXT } from "./mssql-read-only-refusals";

/**
 * What `run_read_query` answers a too-large refusal with when one engine alone raises its kind: SQL Server is the only
 * engine that raises the cut-value and serialised refusals, so their answers are in its words. The MCP tool reads them
 * here, among the SQL family's modules, until that family moves into core (docs/PROVIDER_IMPORTS.md, PR 8 sql).
 */
export const ENGINE_TOO_LARGE_TEXTS: Readonly<{ "cut-value": string; serialised: string }> = Object.freeze({
  "cut-value": MSSQL_CUT_VALUE_TEXT,
  serialised: MSSQL_SERIALISED_TEXT,
});
