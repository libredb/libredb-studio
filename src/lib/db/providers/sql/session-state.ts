/**
 * Whether one statement can leave state on the SESSION it ran on, read off its text (Q5).
 *
 * A pooled provider hands every `query()` a connection borrowed from a pool and gives it back
 * afterwards, and what a statement set on that session outlives the call: a user variable, a
 * session variable, a temporary table, a named lock, a prepared statement. Measured on MySQL
 * 8.4.13 and on PostgreSQL 19 and 18 on 2026-11-20: a script's `SET @v = 42` and `SET SESSION
 * innodb_lock_wait_timeout = 7` (MySQL), or `SET statement_timeout = '7s'` and
 * `set_config('x.v', '42', false)` (PostgreSQL), were read back by about half of the later
 * unrelated runs on the same stored connection, by whichever request the pool happened to hand
 * that session next.
 *
 * The provider asks this question to decide whether the connection may go back to the pool as
 * it is. It is deliberately a text reading and not a round trip: the answer has to cost nothing
 * on the ordinary statement, which is nearly every statement, and a wrong YES only costs one
 * reconnect, because the provider then closes the session instead of returning it. A wrong NO
 * is the leak, so the reading errs towards yes: a marker found inside a string literal still
 * counts. What it cannot see is state set by code the server runs on the statement's behalf,
 * a procedure or a function body, which is written down in each provider's doc.
 *
 * The vocabulary is per engine, declared beside each provider that asks; only the reading is
 * shared here.
 */
import type { SqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";

/** What makes a statement session-changing on one engine. */
export interface SessionStateVocabulary {
  /** Leading keywords (upper-case) of statements that change the session by what they are: `SET`, `USE`, ... */
  readonly leading: ReadonlySet<string>;
  /** Text anywhere in the statement that changes the session from inside another statement: `:=`, `set_config(` ... */
  readonly markers: readonly RegExp[];
}

/** Whether `sql` can leave state on the session that runs it, under `vocabulary` and the engine's `grammar`. */
export function changesSessionState(sql: string, vocabulary: SessionStateVocabulary, grammar: SqlGrammar): boolean {
  const keyword = readLeadingKeyword(sql, grammar)?.keyword;
  if (keyword !== undefined && vocabulary.leading.has(keyword)) return true;
  return vocabulary.markers.some((marker) => marker.test(sql));
}
