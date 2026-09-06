/**
 * The one place that tells two kinds of monitoring-panel absence apart.
 *
 * `getMonitoringData` reads each panel independently and, when one rejects, leaves that
 * panel absent and records the ENGINE's own sentence under `MonitoringData.errors`
 * (see the contract on `MonitoringData` in `src/lib/db/types.ts`). Both of the absences
 * below arrive through that same channel, but they are different facts and a reader
 * acts on them differently:
 *
 * - The object was never there. Materialize has no `pg_table_size()` and no
 *   `pg_stat_user_tables`; CockroachDB has no `pg_size_pretty()`. Nothing the user can
 *   do makes this panel answer, and nothing is wrong - it is a property of the engine.
 * - The object is there and this statement was refused. Apache Cloudberry answers
 *   `query plan with multiple segworker groups is not supported` for the very queries
 *   whose catalogs it holds and can read; its MPP planner is rejecting the query's
 *   shape, so a different statement could still succeed. That is worth a reader's
 *   attention in a way the first is not.
 *
 * Reading the first as the second made Materialize's dashboard look broken across three
 * panels while every one of them was behaving correctly. This component is shared by all
 * six monitoring tabs, so the rule has to speak every engine's wording, not PostgreSQL's:
 * StarRocks, Apache Doris, ClickHouse and Cassandra each phrase a missing catalog object
 * differently and each was landing on the wrong side of the line. Reading the second as the first
 * would be worse: it would present a real, fixable restriction as a settled fact.
 *
 * This is deliberately NOT solved by having providers answer `[]` instead of rejecting.
 * An empty array claims the engine answered "nothing", which is a measurement it never
 * made, and it throws away the sentence that says why - the exact confusion the
 * `MonitoringData` contract exists to prevent.
 */

/**
 * Phrases an engine uses when the thing asked for is not there. A list rather than one
 * regex because each is a different engine's wording, and every one was taken from a
 * live instance:
 *
 * - `does not exist` — PostgreSQL, and Materialize for a missing function
 * - `unknown catalog item` — Materialize for a missing relation
 * - `unknown function` — CockroachDB
 * - `unknown table` — StarRocks and Apache Doris ("Unknown table
 *   'information_schema.PROCESSLIST'"), and ClickHouse, whose "Unknown table expression
 *   identifier 'system.parts'" contains it
 * - `unconfigured table` — Apache Cassandra
 */
const ABSENT_OBJECT_PHRASES = [
  "does not exist",
  "unknown catalog item",
  "unknown function",
  "unknown table",
  "unconfigured table",
] as const;

/**
 * True when the message says the thing the query named is not there.
 *
 * The phrase carries the whole meaning, so no second test on the object's name is
 * applied. An earlier version also required a `pg_`-prefixed identifier, which is how
 * this rule came to recognise Materialize and CockroachDB while rendering StarRocks,
 * Doris, ClickHouse and Cassandra absences as faults — on a component all six monitoring
 * tabs share, so the distinction was quietly PostgreSQL-only.
 *
 * What stays a fault is a different sentence shape: the engine describing a restriction
 * on the STATEMENT rather than a missing object. Apache Cloudberry's "query plan with
 * multiple segworker groups is not supported" names nothing absent and matches no phrase
 * here, which is the behaviour its panel needs — `pg_stat_user_tables` exists there and
 * is readable, so a differently shaped statement could still succeed.
 *
 * The SQL these panels run is ours and fixed, so a message about a missing column or
 * relation is about a catalog the engine does not have, not about a typo in a user's
 * query. That is what makes the phrase alone sufficient here.
 */
export function describesAbsentObject(message: string): boolean {
  const normalized = message.toLowerCase();
  return ABSENT_OBJECT_PHRASES.some((phrase) => normalized.includes(phrase));
}
