/**
 * Which grammar the readers in this folder are reading.
 *
 * Every reader here answers a question about a statement's STRUCTURE from
 * characters alone, and a handful of those characters mean different things in
 * different engines. Where they do, a reader with no dialect has to take one
 * engine's side, and taking the wrong one moves where a construct ends: a `)`
 * that closes a CTE body, a comment that hides a bound, a keyword that types the
 * statement. `operative-keyword.ts` records what that costs - a statement that
 * WRITES typed as a read, and a row bound then appended to it, which on
 * PostgreSQL and MySQL commits part of the write (#287).
 *
 * The dialect was always available at the callers - every provider knows its own
 * `type`, the multi-statement route resolves its provider before it asks, and
 * both client-side execution paths hold the active connection - so this module
 * threads information that already exists rather than inferring it from the text
 * (#292).
 *
 * Two rules keep this from becoming the type-switching this project bans
 * ("no `=== 'mongodb'` type-checks outside provider classes - drive behaviour
 * through capabilities"):
 *
 * 1. **Exactly one place maps a database type to grammar facts** - the registry
 *    in `src/lib/db/sql-grammar/`, whose row for each engine is declared in a module
 *    beside its provider. Readers receive the resolved record and never see a type
 *    id, so no reader can grow a dialect test of its own.
 * 2. **A fact that could not be established from an authoritative source is not
 *    guessed.** It stays at the compatibility default, and which dialects are
 *    there is stated (in `docs/editor/query-optimization.md`) rather than
 *    implied. Never read one dialect's rule off another's behaviour.
 *
 * The facts' type, `SqlGrammar`, and the compatibility default, `DEFAULT_SQL_GRAMMAR`, are the SDK's
 * (`@libredb/provider-sdk/sql`), so this module holds only the two readers that resolve a row by engine id.
 */

import { sqlGrammarFor } from "@/lib/db/sql-grammar";
import type { DatabaseType } from "@/lib/types";
import type { SqlGrammar } from "@libredb/provider-sdk/sql";

/**
 * The grammar to read a statement of this dialect with: its row of the registry (`SQL_GRAMMAR` in
 * `src/lib/db/sql-grammar/`), where each engine's module beside its provider declares it with its sources.
 *
 * One constant per dialect, and a fact spelled `DEFAULT_SQL_GRAMMAR.<fact>` is one its module could not establish
 * for that dialect. The default is therefore per FACT, not per dialect: a dialect whose `#` rule is known can still
 * be undecided about its brackets, and writing the default's own value there is what keeps that visible in the code
 * rather than only in the doc. A dialect whose module states `DEFAULT_SQL_GRAMMAR` whole is at the compatibility
 * default because its rule was not established, NOT because it agrees with the default.
 *
 * Every source is offline or first-party documentation, except the rows established by probing the engines
 * themselves where their SQL surface is an HTTP endpoint, so the grammar can be asked rather than read about. Block
 * comments have one source per dialect and every SQL row established, so no dialect is left undecided about that
 * fact (#300). `//`, the third line-comment form, is a LIVE PROBE from 2026-08-25 on every row that carries it rather
 * than a document: it is the fact this record used to say it could not carry, and the splitter is where that cost was
 * live, since a comment is what a `;` can hide inside and `/api/db/multi-query` runs every fragment the splitter
 * returns. The full probe text for every row is quoted on the constants and in `grammar.test.ts`.
 *
 * An absent type gets the compatibility default; any other value that is not a type id, a `String` object included, is
 * refused with `UnknownProviderError` (`sqlGrammarFor`).
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id.
 */
export function resolveSqlGrammar(type?: DatabaseType): SqlGrammar {
  return sqlGrammarFor(type).grammar;
}

/**
 * Whether this dialect's query text is SQL - the question BEFORE which SQL grammar
 * to read it under. Each engine's module states it as `readsSqlText`, with the reason.
 *
 * `resolveSqlGrammar` has an answer for every type id, so without this a Mongo
 * document or a Redis command is simply read as SQL under the compatibility
 * grammar. For a reader that only ever declines to act, that costs nothing. For the
 * confirmation gate it cost a false prompt on ordinary reads: the escaped quote in
 * `{"filter":{"msg":"say \"hi\""}}` or in `GETRANGE k "a\"b" 0 1` is an unresolvable
 * literal to a SQL span reader and a perfectly closed one in the grammar the text is
 * actually written in - and the dialog then said the statement could not be read
 * about text that reads fine. An operator who learns to click the confirmation away
 * is the one thing that gate cannot survive.
 *
 * An absent type gets the compatibility default and reads as SQL, which keeps every
 * existing caller that names no dialect on today's reading. Any other value that is
 * not a type id, a `String` object such as `new String("mongodb")` from a host
 * calling in plain JavaScript included, is refused with `UnknownProviderError`
 * (`sqlGrammarFor`) rather than read as SQL or under the row its conversion names.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id.
 */
export function readsSqlText(type?: DatabaseType): boolean {
  return sqlGrammarFor(type).readsSqlText;
}
