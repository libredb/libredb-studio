import type { ExportSpec } from "@/lib/db/sql-writing/types";

/**
 * The key a Cassandra `CREATE TABLE` from a result export takes: the first column, as a placeholder. Studio's SQL
 * writing function table binds it to the `createTableKeyClause` the engine's declaration names
 * (src/lib/db/sql-writing/index.ts, `SQL_WRITING_FUNCTIONS`), and the declaration's `createTableKey.note` says so above
 * the statement.
 *
 * Measured on 5.0.9, a CQL `CREATE TABLE` with a column list and no key is `InvalidRequest ... No PRIMARY KEY specifed
 * for table (exactly one required)`, so the plain column list every other dialect gets cannot run at all. A result set
 * does not know which column is the real key, so the first one is chosen as a placeholder: wrong often enough to be
 * dangerous, but a wrong key that replays beats a file that fails to parse.
 */
export const CASSANDRA_CREATE_TABLE_KEY_CLAUSE: NonNullable<ExportSpec["createTableKey"]>["clause"] = (quoted) =>
  `PRIMARY KEY (${quoted[0]})`;
