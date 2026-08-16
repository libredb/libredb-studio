/**
 * Whether the info string on a markdown fence says the block holds a query.
 *
 * Extracted from `src/components/rich-text.tsx` on 2026-08-15, when a SECOND reader of
 * the same fences appeared: `src/lib/agent/plan-statement.ts` reads a plan run's
 * deliverable out of its closing prose on the server, and the rail renders the same
 * text in the browser. While the predicate lived in the browser layer only, the two
 * disagreed about which block is a statement — the reader took the FIRST fenced block
 * whatever its info string, so a run that opened with a ```text illustration recorded
 * the illustration as its deliverable while the rail offered the editor the SQL block
 * below it. One shared answer is what makes the agreement those two modules claim an
 * enforced fact rather than a comment.
 *
 * The fence PATTERN itself stays duplicated in both callers, and deliberately: it is
 * three characters of regex whose reason is recorded in both places, and the server
 * layer does not import the browser layer to get it.
 */

import type { DatabaseType } from "@/lib/types";

/**
 * Every engine this product speaks, as a fence tag.
 *
 * A TOTAL RECORD over `DatabaseType` rather than a list, and that is the point: the
 * first version of this was a hand-written set whose comment claimed every engine was
 * in it, and `libredb` was not (#389 review). A comment cannot keep that promise and a
 * record can — an engine added to the union stops this file compiling until someone
 * decides what its blocks are called.
 *
 * The keys are the canonical type-ids because that is what the union holds; the aliases
 * models actually write live below.
 */
const ENGINE_FENCE_TAGS: Readonly<Record<DatabaseType, true>> = Object.freeze({
  postgres: true,
  mysql: true,
  sqlite: true,
  mongodb: true,
  redis: true,
  oracle: true,
  mssql: true,
  libredb: true,
  couchbase: true,
  clickhouse: true,
  druid: true,
});

/**
 * The other names the same query languages go by, which is what a model actually types.
 *
 * Separate from the record above because these answer to nothing: no union widens when
 * a model invents `pgsql`, so completeness here is a judgement rather than a guarantee.
 * A tag missing from either costs the user a button and never a wrong one — the copy
 * control is offered on every block regardless.
 */
const QUERY_FENCE_ALIASES: ReadonlySet<string> = new Set([
  "sql",
  "postgresql",
  "pgsql",
  "psql",
  "plpgsql",
  "mariadb",
  "sqlite3",
  "plsql",
  "tsql",
  "sqlserver",
  "mongo",
  "n1ql",
]);

/**
 * The aliases that name ONE engine, and which one.
 *
 * `sql` is deliberately absent: it names no engine, and mapping it to the connection's
 * would turn a generic tag into a claim the model never made.
 */
const ALIAS_ENGINES: Readonly<Record<string, DatabaseType>> = Object.freeze({
  postgresql: "postgres",
  pgsql: "postgres",
  psql: "postgres",
  plpgsql: "postgres",
  mariadb: "mysql",
  sqlite3: "sqlite",
  plsql: "oracle",
  tsql: "mssql",
  sqlserver: "mssql",
  mongo: "mongodb",
  n1ql: "couchbase",
});

/**
 * The engine a tag NAMES, or `null` when it names none (#396 review).
 *
 * The distinction this draws is the one `isQueryFenceTag` cannot: that predicate asks
 * whether a block holds a query at all, and answers yes for `mysql` on a PostgreSQL
 * connection. A reader that then records the block under the connection's own dialect
 * has relabelled the model's MySQL as PostgreSQL — it says the run drafted something
 * for this database that the run explicitly wrote for another one, which is the
 * false-self-description defect this repository keeps finding.
 *
 * `null` for an untagged fence and for `sql` is not a gap: neither says which engine,
 * so neither can contradict the connection. Only an explicit engine can.
 */
export const fenceTagEngine = (tag: string | undefined): DatabaseType | null => {
  if (tag === undefined) return null;
  if (Object.hasOwn(ENGINE_FENCE_TAGS, tag)) return tag as DatabaseType;
  return Object.hasOwn(ALIAS_ENGINES, tag) ? ALIAS_ENGINES[tag] : null;
};

/**
 * Whether a fence holds something the editor should be offered.
 *
 * Fail-closed on an unrecognised tag, the same posture the auto-execute gate takes about
 * a dialect it has no rule for: the tag is the model saying what the block is, and
 * offering to put a shell command into a SQL editor would be this surface claiming
 * something the model contradicted.
 *
 * An untagged fence counts. Models write one for SQL constantly, and in a document
 * whose entire subject is a database the bare fence is a query far more often than it
 * is anything else — while the cost of being wrong is one click that puts text in an
 * editor, which the user can see and undo.
 *
 * The tag is expected lower-cased; both callers lower-case it as they read the fence.
 */
export const isQueryFenceTag = (tag: string | undefined): boolean =>
  tag === undefined || Object.hasOwn(ENGINE_FENCE_TAGS, tag) || QUERY_FENCE_ALIASES.has(tag);
