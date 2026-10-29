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
 *    here as well as quoted — see `assertSelector` in `composed-sql-primitives.ts`
 *    for the one character that is refused rather than quoted, and why.
 * 3. **No dialect is served on a guess.** Both maps are looked up with
 *    `Object.hasOwn`, and an unlisted dialect is refused. A composition that has
 *    not been checked against that engine's catalog and its EXPLAIN grammar is not
 *    a fallback, it is a statement nobody verified.
 *
 * On the plan side: the composed form is the ESTIMATING one on both engines, never
 * the executing one. `src/lib/explain`'s PostgreSQL strategy is deliberately not
 * reused for this. Its `buildSql` honours the mode since #1311 (`estimate` builds
 * `EXPLAIN (FORMAT JSON)`, `analyze` the executing `EXPLAIN (ANALYZE, BUFFERS, FORMAT
 * JSON)`), but it is the EDITOR's strategy, selected by a capability the provider
 * measures at connect, and the agent path needs a form fixed per dialect that the
 * approval-gated `sql.explain.analyze` descriptor alone may turn into an executing one.
 */

import {
  type AgentCatalogSelector,
  AgentComposedSqlError,
  type AgentEstimatingExplain,
} from "./composed-sql-primitives";
import { engineServerDialect, everyEngineServerDialect } from "./languages/engines/server";
import type { DatabaseType } from "@/lib/types";

/**
 * The statement that answers "does this database hold any statistics at all?", or
 * `null` when the dialect needs no such question asked.
 *
 * Only SQLite needs one, for the prepare-time reason documented on
 * `composeSqliteStatistics` in `languages/sql/engines/sqlite.ts`. PostgreSQL's
 * `pg_class` and `pg_stats` are part of every
 * installation, so absence there is per-table and already expressed IN the statistics
 * read as NULL statistics columns — a probe would answer a question that read has
 * already answered more precisely, and returning a statement for it would invite a
 * caller to treat an empty result as "no statistics anywhere".
 *
 * An unserved dialect is refused rather than answered `null`, because `null` here
 * means "verified: no probe needed", and a dialect nobody has verified has not
 * earned that answer.
 */
export function composeStatisticsAvailabilityProbe(dialect: DatabaseType): string | null {
  if (engineServerDialect(dialect).catalogRead === "unsupported") {
    throw new AgentComposedSqlError(
      `no verified statistics composition for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  const statistics = engineServerDialect(dialect).statistics;
  return statistics === "unsupported" ? null : statistics.probe;
}

/**
 * The catalog statement for this dialect and selector.
 *
 * The result is a bounded read like any other: it carries no LIMIT, so a schema
 * wider than the policy's row budget is REFUSED rather than silently truncated.
 * That is the same choice the rest of this layer makes — a partial inventory that
 * claims to be whole is worse than a refusal a caller can narrow — and the selector
 * is how a caller narrows it.
 *
 * The PostgreSQL column kind aggregates its columns per table (B52), one row per
 * OBJECT and symmetric with the SQLite side, so a stock image's own wide catalog
 * no longer overflows the row cap before the user has created anything.
 *
 * The composers are the engine's `catalogRead` (`languages/sql/engines/<id>.ts`), one per
 * kind, and every SQL engine's overlay has to supply them or declare the member
 * `"unsupported"`: the registry is total over the engines whose `AGENT_STATEMENT_LANGUAGE`
 * is SQL, so a fifth one does not compile until it says which. An engine that reaches the
 * factory's read-only gate but no composer is an engine on which `inspect_schema`,
 * `profile_table` and `inspect_plan` can only ever refuse — which is how DuckDB shipped
 * into `AGENT_EXECUTION_ENGINES`: `POST /api/agent/runs` accepted the
 * `query-optimization` and `database-assessment` workflows on it and no run could
 * complete one.
 */
export function composeCatalogRead(dialect: DatabaseType, selector: AgentCatalogSelector): string {
  const catalogRead = engineServerDialect(dialect).catalogRead;
  if (catalogRead === "unsupported") {
    throw new AgentComposedSqlError(
      `no verified catalog composition for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  return catalogRead.compose[selector.kind ?? "columns"](selector);
}

/**
 * The estimating plan statement for `sql` on this dialect.
 *
 * Nothing here inspects `sql`: whether it is a bounded read is the descriptor's
 * input contract to answer, and it answers for the COMPOSED text, so a write the
 * model smuggled in is refused with the prefix already attached. Composing it first
 * and letting the guard refuse it is deliberate — one place decides what a
 * statement may be.
 *
 * The form is the engine's `planEstimate` (`languages/sql/engines/<id>.ts`): a prefix that
 * DESCRIBES without running, or a session mode the statement travels under unchanged. An
 * engine that declares it `"unsupported"` is one whose estimating plan nobody has verified,
 * and it is refused rather than guessed at.
 */
export function composeEstimatingExplain(dialect: DatabaseType, sql: string): AgentEstimatingExplain {
  const statement = typeof sql === "string" ? sql.trim() : "";
  if (statement.length === 0) {
    throw new AgentComposedSqlError("there is no statement to explain", "INVALID_STATEMENT");
  }
  const estimate = engineServerDialect(dialect).planEstimate;
  if (estimate === "unsupported") {
    throw new AgentComposedSqlError(
      `no verified estimating EXPLAIN for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  if (estimate.kind === "session-mode") {
    return { sql: withoutEstimatingPrefix(statement), mode: estimate.mode };
  }
  return { sql: `${estimate.prefix} ${withoutEstimatingPrefix(statement)}`, mode: "execute" };
}

/**
 * Whether this dialect has a verified catalog composition for every kind. The manifest's `sql-catalog` mirror is
 * pinned to it, and its `sql-composers` mirror to it together with `composesEstimatingExplainFor`.
 */
export function composesCatalogFor(dialect: DatabaseType): boolean {
  return engineServerDialect(dialect).catalogRead !== "unsupported";
}

/** Whether this dialect has a verified estimating plan, as a prefix or as a session mode. */
export function composesEstimatingExplainFor(dialect: DatabaseType): boolean {
  return engineServerDialect(dialect).planEstimate !== "unsupported";
}

/**
 * The statement with a leading estimating EXPLAIN removed, if the model wrote one.
 *
 * Measured across 133 optimization runs: 21 calls arrived already prefixed, 12 were refused,
 * and at least three runs lost outright to it. `qwen3:8b` does it in 9 of its 15 runs on
 * that surface. What the model got back was one line of engine text —
 * `near "EXPLAIN": syntax error` — because this function had prepended a second prefix. That
 * message is unactionable when the model did not write the outer EXPLAIN, and the shared
 * rules then tell it not to send the same statement again; three runs abandoned the tool and
 * reported nothing.
 *
 * Stripped rather than refused. The intent is unambiguous — the model asked for the plan of
 * a statement and named the operation twice — and this function already trims whitespace
 * without asking anyone. A refusal would teach, but it would still cost the run the turn it
 * has already spent.
 *
 * `EXPLAIN ANALYZE` is deliberately NOT matched. That form asks to EXECUTE, which is a
 * different request and one this run may not make: removing it would quietly turn a refused
 * execution into an accepted estimate. Composing it through is what puts the word in front
 * of the guard that exists to refuse it.
 */
function withoutEstimatingPrefix(statement: string): string {
  const match = restatedEstimatingPrefix().exec(statement);
  return match === null ? statement : statement.slice(match[0].length).trim();
}

/** A prefix's words and punctuation, in order: `EXPLAIN (FORMAT JSON)` is `EXPLAIN`, `(`, `FORMAT`, `JSON`, `)`. */
const prefixTokens = (prefix: string): string[] => prefix.match(/\w+|[^\s\w]/g) ?? [];

const isWord = (token: string): boolean => /^\w+$/.test(token);

/**
 * One token's pattern and the whitespace after it: at least one space between two words, so `EXPLAINED` is no
 * `EXPLAIN`, and any amount beside punctuation, so `( FORMAT JSON )` is the same prefix.
 */
function tokenPattern(token: string, next: string | undefined): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${escaped}${isWord(token) && (next === undefined || isWord(next)) ? "\\s+" : "\\s*"}`;
}

let restatedPrefix: RegExp | undefined;

/**
 * The strip, built once from every engine's declared estimating prefix (`planEstimate.prefix` in
 * `languages/sql/engines/<id>.ts`), so the composer keeps no prefix of its own. Anchored and case-insensitive. Each
 * prefix's first word may stand alone, and the rest of it is an optional tail, because a model that repeats a full
 * prefix is the most common shape of the mistake. A tail is stripped on every engine, not only on the one that
 * declares it: a model that wrote another engine's prefix asked for the same thing.
 */
function restatedEstimatingPrefix(): RegExp {
  if (restatedPrefix !== undefined) return restatedPrefix;
  const tails = new Map<string, Set<string>>();
  for (const dialect of everyEngineServerDialect()) {
    const estimate = dialect.planEstimate;
    if (estimate === "unsupported" || estimate.kind !== "prefix") continue;
    const [keyword, ...rest] = prefixTokens(estimate.prefix);
    const keywordTails = tails.get(keyword.toUpperCase()) ?? new Set<string>();
    if (rest.length > 0) keywordTails.add(rest.map((token, at) => tokenPattern(token, rest[at + 1])).join(""));
    tails.set(keyword.toUpperCase(), keywordTails);
  }
  const forms = [...tails].map(([keyword, keywordTails]) => {
    const tail = keywordTails.size === 0 ? "" : `(?:${[...keywordTails].join("|")})?`;
    return `${tokenPattern(keyword, undefined)}${tail}`;
  });
  restatedPrefix = new RegExp(`^(?:${forms.join("|")})(?!ANALYZE\\b)`, "i");
  return restatedPrefix;
}
