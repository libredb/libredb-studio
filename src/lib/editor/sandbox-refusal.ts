import type { SqlGrammar } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { readSqlSpan } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { readSqlWord } from "@/lib/sql/words";

/**
 * The statements that end the transaction SANDBOX runs in, on every engine that has one.
 * `COMMIT` makes the run permanent; `ROLLBACK` (and PostgreSQL's synonym `ABORT`, which no
 * other dialect here has as a statement) ends it early, so whatever follows in the text runs
 * outside it. Synonyms one dialect alone has (`END`, `PREPARE TRANSACTION`) are that
 * provider's declaration, because a word like `END` is code in another dialect's blocks.
 */
const TRANSACTION_CONTROL = new Set(["COMMIT", "ROLLBACK", "ABORT"]);

/** How many words a declared sequence may name; `PREPARE TRANSACTION` and `BEGIN NOT ATOMIC` need three at most. */
const MAX_SEQUENCE_WORDS = 3;

/**
 * The statement's leading words, upper-cased, starting at its operative keyword and stepping
 * over whitespace and comments only. A literal, a quoted name or punctuation ends the read:
 * those are not words of the statement's verb.
 */
function leadingWords(sql: string, grammar: SqlGrammar): string[] {
  const keyword = readOperativeKeyword(sql, grammar);
  if (keyword === null) return [];
  const words = [keyword.keyword];
  let i = keyword.end;
  while (words.length < MAX_SEQUENCE_WORDS && i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span !== null) {
      if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") break;
      i = span.end;
      continue;
    }
    const word = readSqlWord(sql, i);
    if (word === null) break;
    words.push(word.text);
    i = word.end;
  }
  return words;
}

/** Whether `words` starts with the space-separated sequence `entry`. */
function startsWith(words: readonly string[], entry: string): boolean {
  const wanted = entry.split(" ");
  return wanted.every((word, index) => words[index] === word);
}

/**
 * Why SANDBOX may not run this text, or `undefined` when it may.
 *
 * SANDBOX runs the text inside a transaction and rolls it back, and tells the user nothing
 * was changed. A statement that ends that transaction makes the promise false:
 *
 * - `COMMIT`, `ROLLBACK` and `ABORT`, on every engine (`TRANSACTION_CONTROL`).
 * - The statements the connection's provider declares in `implicitCommitStatements`, less
 *   the ones it declares in `implicitCommitExceptions`. That is the engine's own rule: MySQL
 *   and Oracle commit around DDL, PostgreSQL has `END` and `PREPARE TRANSACTION`. Measured
 *   2026-10-04 on MySQL 26.7.0: a SANDBOX `CREATE TABLE` left the table behind under the
 *   toast "Changes auto-rolled back. No data was modified."
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
  implicitCommitExceptions: readonly string[] | undefined,
): string | undefined {
  for (const statement of splitStatements(sql, grammar)) {
    const words = leadingWords(statement.sql, grammar);
    if (words.length === 0) continue;
    const keyword = words[0];
    if (keyword === "COMMIT") {
      return "SANDBOX cannot run COMMIT: it would make the changes permanent, and the rollback that follows would undo nothing. Turn SANDBOX off to commit.";
    }
    if (TRANSACTION_CONTROL.has(keyword)) {
      return `SANDBOX cannot run ${keyword}: SANDBOX rolls the run back itself, and a ${keyword} inside it would end the transaction early, so anything after it would run outside one.`;
    }
    const declared = implicitCommitStatements?.find((entry) => startsWith(words, entry));
    const excepted = implicitCommitExceptions?.some((entry) => startsWith(words, entry)) === true;
    if (declared !== undefined && !excepted) {
      return `SANDBOX cannot run ${declared}: on this database it can end the open transaction (it commits implicitly, or runs code that may), so the rollback that follows could undo nothing. Turn SANDBOX off to run it for real.`;
    }
  }
  return undefined;
}
