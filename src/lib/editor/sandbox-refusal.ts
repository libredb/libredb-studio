import type { SqlGrammar } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { splitStatements } from "@/lib/sql/statement-splitter";

/**
 * Why SANDBOX may not run this text, or `undefined` when it may.
 *
 * SANDBOX runs the text inside a transaction and rolls it back, and tells the user nothing
 * was changed. A statement that commits that transaction makes the promise false: the
 * ROLLBACK that follows answers success and undoes nothing. Two kinds do that:
 *
 * - `COMMIT`, on every engine that has a transaction to commit.
 * - The statements the connection's provider declares in `implicitCommitStatements`, which
 *   are the engine's own rule (MySQL and Oracle commit around DDL; PostgreSQL does not and
 *   declares none). Measured 2026-10-04 on MySQL 26.7.0: a SANDBOX `CREATE TABLE` left the
 *   table behind under the toast "Changes auto-rolled back. No data was modified."
 *
 * Every statement of the text is read, under the connection's own grammar, because one
 * committing statement anywhere in it commits everything before it too. The operative
 * keyword is read rather than the first word, so a leading comment or a `WITH` preamble
 * cannot hide the statement that actually runs.
 */
export function sandboxRefusal(
  sql: string,
  grammar: SqlGrammar,
  implicitCommitStatements: readonly string[] | undefined,
): string | undefined {
  const committing = new Set(["COMMIT", ...(implicitCommitStatements ?? [])]);
  for (const statement of splitStatements(sql, grammar)) {
    const keyword = readOperativeKeyword(statement.sql, grammar)?.keyword;
    if (keyword !== undefined && committing.has(keyword)) {
      return keyword === "COMMIT"
        ? "SANDBOX cannot run COMMIT: it would make the changes permanent, and the rollback that follows would undo nothing. Turn SANDBOX off to commit."
        : `SANDBOX cannot run ${keyword}: this database commits the open transaction when it runs one, so the rollback that follows would undo nothing. Turn SANDBOX off to run it for real.`;
    }
  }
  return undefined;
}
