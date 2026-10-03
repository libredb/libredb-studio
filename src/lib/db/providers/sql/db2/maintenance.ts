/**
 * RUNSTATS and REORG on Db2 LUW (#786).
 *
 * Both are CLP commands, so they reach the server through `SYSPROC.ADMIN_CMD`, and that `CALL`
 * runs inside a compound block: db2-node 1.0.22 fails every bare `CALL` with SQLSTATE 07005
 * SQLCODE -517 (K9), and the same `CALL` between `BEGIN` and `END` runs (M2, measured on
 * 12.1.0.0). The block has no result set to read, which these two commands do not need.
 *
 * The schema comes from the request's container and never from the session (M4): db2-node
 * ignores `currentSchema` (K12), and a session schema standing in for a missing one would run
 * the command against a table the user did not name.
 */

import type { MaintenanceOperation } from "@/lib/db/types";
import { DatabaseConfigError, QueryError } from "../../../errors";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The table as ADMIN_CMD's command text names it: two delimited identifiers, then every single
 * quote doubled, because the whole command is itself a string literal.
 */
export const adminCommandTarget = (schema: string, table: string): string =>
  `${quote(schema)}.${quote(table)}`.replaceAll("'", "''");

/** Each operation's command, and the word its messages use. */
const COMMANDS: Partial<Record<MaintenanceOperation, { word: string; command: (target: string) => string }>> = {
  analyze: {
    word: "RUNSTATS",
    command: (target) => `RUNSTATS ON TABLE ${target} WITH DISTRIBUTION AND DETAILED INDEXES ALL`,
  },
  optimize: { word: "REORG", command: (target) => `REORG TABLE ${target}` },
};

/**
 * The catalog types both commands run on: `SYSCAT.TABLES.TYPE` T and S. A view answers
 * SQLSTATE 428DY to RUNSTATS (measured), so it is refused before anything is sent, and so is
 * every other type.
 */
export const MAINTAINED_TABLE_TYPES: Readonly<Record<string, string>> = { T: "table", S: "materialized query table" };

/** The object kinds whose catalog type is one of the two above: what the row menus offer both on. */
export const MAINTAINED_KINDS: readonly string[] = ["table", "materialized_query_table"];

/** What one target is, so a view or an alias is refused by name rather than by the server. */
export const MAINTENANCE_TARGET_TYPE_SQL = `SELECT RTRIM(TYPE) AS TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TABNAME = ?`;

/** The statement for one operation on one table, and the sentence its success reports. */
export function maintenanceStatement(
  type: MaintenanceOperation,
  target: string | undefined,
  schema: string | undefined,
): { sql: string; message: string; word: string } {
  const spec = COMMANDS[type];
  if (spec === undefined) {
    throw new QueryError(`Unsupported maintenance operation for Db2: ${type}`, "db2");
  }
  if (!target) throw new DatabaseConfigError(`A table name is required for ${spec.word}`, "db2");
  if (!schema) throw new DatabaseConfigError(`A schema is required for ${spec.word} on Db2`, "db2");
  return {
    sql: `BEGIN CALL SYSPROC.ADMIN_CMD('${spec.command(adminCommandTarget(schema, target))}'); END`,
    message: `${spec.word} completed on ${schema}.${target}`,
    word: spec.word,
  };
}
