/**
 * The SQL the SERVER composes for an agent run (#329, epic #325; planning decision P1).
 *
 * Two of the M2 tools do not take a statement from the model at all. A catalog
 * inspection takes a structured selector and a plan inspection takes the statement
 * it is about; in both cases the statement that reaches the database is written
 * here, per dialect. That is what lets a schema read BE the canonical bounded read
 * (`sql.query.read`) instead of needing a fourth operation descriptor, which the
 * epic pinned shut.
 *
 * Three constraints shape every string below:
 *
 * 1. **The composed statement must satisfy the M1 input guard**, or the tool can
 *    never run. That rules out more than it looks like: `statement-guard.ts`
 *    refuses any word beginning `PRAGMA_`, so SQLite's `pragma_table_info()`
 *    table-valued function — the obvious way to read a column list there — is
 *    unavailable, and the SQLite catalog read goes through `sqlite_master`
 *    instead. The asymmetry is real and documented on the tool: PostgreSQL yields
 *    a structured column inventory, SQLite yields each object's own DDL text.
 * 2. **The profiled providers bind nothing.** `queryReadOnly(sql, budget)` takes no
 *    parameters (`postgres.ts`, `sqlite.ts`), so a selector cannot be bound and has
 *    to be quoted with the shared `quoteLiteral`. Selectors are therefore validated
 *    here as well as quoted — see `assertSelector` for the one character that is
 *    refused rather than quoted, and why.
 * 3. **No dialect is served on a guess.** Both maps are looked up with
 *    `Object.hasOwn`, and an unlisted dialect is refused. A composition that has
 *    not been checked against that engine's catalog and its EXPLAIN grammar is not
 *    a fallback, it is a statement nobody verified.
 *
 * On the plan side: the composed form is the ESTIMATING one on both engines, never
 * the executing one. `src/lib/explain`'s PostgreSQL strategy is deliberately not
 * reused for this — its `buildSql` ignores the `mode` argument and always emits
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, which RUNS the statement it explains.
 * That is correct for the editor's Explain button (a user asked for real timings)
 * and exactly wrong here, where the approval-gated `sql.explain.analyze` descriptor
 * is the only thing allowed to execute a plan. Teaching the strategy registry to
 * honour its own mode argument is a separate, editor-visible change (#194).
 */

import { quoteLiteral } from "@/lib/sql/values";
import type { DatabaseType } from "@/lib/types";

export type AgentComposedSqlDenyCode =
  /** This milestone has verified a composition for PostgreSQL and SQLite only. */
  | "UNSUPPORTED_DIALECT"
  /** Blank, over-long, or carrying a character that cannot be safely quoted. */
  | "INVALID_SELECTOR"
  /** A well-formed selector that has no meaning for this engine. */
  | "SELECTOR_UNSUPPORTED_BY_DIALECT"
  /** Nothing to explain. */
  | "INVALID_STATEMENT";

/**
 * Raised when no statement can honestly be composed. The tool layer maps it to a
 * typed tool outcome; it is never surfaced as a database failure, because no
 * database was reached.
 */
export class AgentComposedSqlError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: AgentComposedSqlDenyCode,
  ) {
    super(message);
    this.name = "AgentComposedSqlError";
    Object.setPrototypeOf(this, AgentComposedSqlError.prototype);
  }
}

/**
 * The widest identifier limit among the engines this repository serves (Oracle's
 * 128; PostgreSQL's is 63 and MySQL's 64). A selector longer than any engine could
 * name is not a narrowing request, and bounding it keeps a multi-megabyte string
 * out of a composed statement.
 */
export const MAX_CATALOG_SELECTOR_LENGTH = 128;

export interface AgentCatalogSelector {
  readonly schema?: string;
  readonly table?: string;
}

/**
 * SQLite's only schema for a profiled provider. The read-only profile opens one
 * file and attaching another is refused at the input stage, so `main` is not merely
 * the default — it is the whole set.
 */
const SQLITE_ONLY_SCHEMA = "main";

/**
 * Validates one selector value and returns it.
 *
 * The backslash refusal is not decoration. `spans.ts` reads a single-quoted literal
 * with backslash escapes under the dialect-less grammar the guard uses, so a value
 * ending in a backslash makes the closing quote look escaped and the whole
 * composed statement reads as `UNDETERMINABLE_TEXT`. The statement would then be
 * refused anyway — this path fails closed either way — but it would be refused with
 * a reason that describes the composition rather than the input. Refusing here
 * names the actual cause, which is the difference between a model that can fix its
 * request and one that cannot.
 *
 * ANY backslash is refused, not only a trailing one, and that is deliberately wider
 * than the reasoning above requires: an interior backslash IS settleable (`'a\b'`
 * reads as a terminated literal and the guard admits the composed statement), so an
 * object genuinely named `a\b` cannot be selected. Separating the two cases would buy
 * that one name back at the cost of a rule whose boundary depends on where in the
 * string the character sits — and a selector is a name a caller can also reach by
 * narrowing to its schema instead. The wide rule is the one that stays true if the
 * grammar's escape handling is ever revisited (`docs/BACKLOG.md` S2).
 */
function assertSelector(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    throw new AgentComposedSqlError(`catalog selector "${field}" must be a non-empty name`, "INVALID_SELECTOR");
  }
  if (trimmed.length > MAX_CATALOG_SELECTOR_LENGTH) {
    throw new AgentComposedSqlError(
      `catalog selector "${field}" is longer than ${MAX_CATALOG_SELECTOR_LENGTH} characters`,
      "INVALID_SELECTOR",
    );
  }
  if (trimmed.includes("\\")) {
    throw new AgentComposedSqlError(
      `catalog selector "${field}" carries a backslash, which no dialect-less reading of a quoted literal settles`,
      "INVALID_SELECTOR",
    );
  }
  return trimmed;
}

/** `AND <column> = '<value>'`, or nothing when the selector is absent. */
function equalsClause(column: string, value: string | undefined, field: string, dialect: DatabaseType): string {
  if (value === undefined) return "";
  return ` AND ${column} = ${quoteLiteral(assertSelector(value, field), dialect)}`;
}

function composePostgresCatalog(selector: AgentCatalogSelector): string {
  return (
    "SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position " +
    "FROM information_schema.columns " +
    "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')" +
    equalsClause("table_schema", selector.schema, "schema", "postgres") +
    equalsClause("table_name", selector.table, "table", "postgres") +
    " ORDER BY table_schema, table_name, ordinal_position"
  );
}

function composeSqliteCatalog(selector: AgentCatalogSelector): string {
  if (selector.schema !== undefined) {
    const schema = assertSelector(selector.schema, "schema");
    if (schema.toLowerCase() !== SQLITE_ONLY_SCHEMA) {
      throw new AgentComposedSqlError(
        `SQLite serves one schema on the agent path ("${SQLITE_ONLY_SCHEMA}"), so "${schema}" cannot be selected`,
        "SELECTOR_UNSUPPORTED_BY_DIALECT",
      );
    }
    // `main` needs no clause: sqlite_master IS main's catalog, so filtering on it
    // would be a no-op dressed up as a narrowing.
  }
  return (
    "SELECT name, type, sql FROM sqlite_master " +
    // The escape character is `@` rather than a backslash on purpose: `'\'` is the
    // literal the dialect-less span reader cannot settle (see `assertSelector`).
    "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("name", selector.table, "table", "sqlite") +
    " ORDER BY type, name"
  );
}

const CATALOG_COMPOSERS: Partial<Record<DatabaseType, (selector: AgentCatalogSelector) => string>> = {
  postgres: composePostgresCatalog,
  sqlite: composeSqliteCatalog,
};

/**
 * The dialect's estimating EXPLAIN prefix. Both forms DESCRIBE without running:
 * PostgreSQL's `EXPLAIN` executes only with `ANALYZE`, and SQLite's
 * `EXPLAIN QUERY PLAN` reports the plan the compiler produced.
 */
const ESTIMATING_EXPLAIN_PREFIX: Partial<Record<DatabaseType, string>> = {
  postgres: "EXPLAIN (FORMAT JSON)",
  sqlite: "EXPLAIN QUERY PLAN",
};

/**
 * The catalog statement for this dialect and selector.
 *
 * The result is a bounded read like any other: it carries no LIMIT, so a schema
 * wider than the policy's row budget is REFUSED rather than silently truncated.
 * That is the same choice the rest of this layer makes — a partial inventory that
 * claims to be whole is worse than a refusal a caller can narrow — and the selector
 * is how a caller narrows it.
 *
 * KNOWN LIMITATION, with its number: the PostgreSQL projection is one row per COLUMN,
 * so against `maxResultRows: 200` an unnarrowed call overflows at roughly 25 tables of
 * eight columns and comes back as a repairable database error. The engine's message
 * names the budget, so it is diagnosable, but it does cost one repair attempt. The
 * SQLite side is one row per OBJECT and is nowhere near the cap. Making the two
 * symmetric means aggregating columns per table, which changes what a caller parses
 * out of the result — that decision belongs with the context snapshot that consumes
 * it, not here.
 */
export function composeCatalogRead(dialect: DatabaseType, selector: AgentCatalogSelector): string {
  if (!Object.hasOwn(CATALOG_COMPOSERS, dialect)) {
    throw new AgentComposedSqlError(
      `no verified catalog composition for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  // Non-null: the key was just proven to be an own property of the map.
  return CATALOG_COMPOSERS[dialect]!(selector);
}

/**
 * The estimating plan statement for `sql` on this dialect.
 *
 * Nothing here inspects `sql`: whether it is a bounded read is the descriptor's
 * input contract to answer, and it answers for the COMPOSED text, so a write the
 * model smuggled in is refused with the prefix already attached. Composing it first
 * and letting the guard refuse it is deliberate — one place decides what a
 * statement may be.
 */
export function composeEstimatingExplain(dialect: DatabaseType, sql: string): string {
  const statement = typeof sql === "string" ? sql.trim() : "";
  if (statement.length === 0) {
    throw new AgentComposedSqlError("there is no statement to explain", "INVALID_STATEMENT");
  }
  if (!Object.hasOwn(ESTIMATING_EXPLAIN_PREFIX, dialect)) {
    throw new AgentComposedSqlError(
      `no verified estimating EXPLAIN for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  return `${ESTIMATING_EXPLAIN_PREFIX[dialect]} ${statement}`;
}
