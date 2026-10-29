/**
 * The building blocks every composed agent statement shares (#1821): the refusal type the
 * tool layer maps to a typed outcome, the catalog selector and its validation, and the
 * estimating-plan request shape.
 *
 * A leaf on purpose. It imports nothing from the agent, so a module that composes SQL for
 * one engine can take these without importing `composed-sql.ts`, which holds every engine's
 * composition and the dispatchers over them.
 */

import { quoteLiteral } from "@/lib/sql/values";
import type { ReadOnlyStatementMode } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/**
 * An estimating plan request: the statement to send, and what the provider is being
 * asked to do with it. See `ReadOnlyStatementMode` for why the second field exists.
 */
export interface AgentEstimatingExplain {
  readonly sql: string;
  readonly mode: ReadOnlyStatementMode;
}

/**
 * How an engine asks for its estimating plan: a statement prefix, or a session mode the provider sets around the
 * statement it is given unchanged (`composeEstimatingExplain` in `composed-sql.ts`).
 */
export type AgentPlanEstimate =
  | {
      readonly kind: "prefix";
      /**
       * A model that writes this prefix in front of its statement has it removed on every engine before the composer
       * adds its own (`withoutEstimatingPrefix` in `composed-sql.ts`).
       */
      readonly prefix: string;
    }
  | { readonly kind: "session-mode"; readonly mode: "estimate-plan" };

export type AgentComposedSqlDenyCode =
  /**
   * This dialect has no verified composition. The engines whose server overlay supplies `catalogRead`
   * (`languages/sql/engines/<id>.ts`) are the list, and they are the engines whose `AGENT_STATEMENT_LANGUAGE`
   * is SQL: PostgreSQL, SQLite, DuckDB, SQL Server and MySQL. Anything else is refused rather than served a statement nobody
   * ran against that engine's catalog.
   */
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

/**
 * Which inventory a catalog read asks for.
 *
 * Four kinds rather than one wide statement, because the engines do not agree on
 * how many reads the inventory takes and a single composed monster would have to be
 * verified per dialect anyway. Each kind is one bounded read (`sql.query.read`)
 * under the same descriptor, so the split costs statements out of the run's budget
 * and buys nothing in privilege — which is exactly the trade the row cap forces.
 * The PostgreSQL column kind aggregates its columns per table so a stock image's
 * own catalog cannot overflow the cap (B52); the relation and index kinds stay
 * flat, where an overflow is a narrowing the selector names.
 *
 * `statistics` is the newest and the only one whose values are ESTIMATES: it reads
 * what the engine already recorded about table sizes and column distributions, and
 * computes nothing. See `composePostgresStatistics` / `composeSqliteStatistics` for
 * what each engine actually holds and for what it does not hold at all.
 */
export type AgentCatalogKind = "columns" | "relations" | "indexes" | "statistics";

export interface AgentCatalogSelector {
  /** Defaults to the column inventory, which is what a bare `inspect_schema` means. */
  readonly kind?: AgentCatalogKind;
  readonly schema?: string;
  readonly table?: string;
}

/** Catalog rows as a catalog read answers them: the columns in order, and each row keyed by those columns. */
export interface AgentCatalogRows {
  readonly fields: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * How an engine reads its catalog (`composeCatalogRead` in `composed-sql.ts`, `readCatalog` in `tools.ts`): one
 * composer per kind; the fold from a selector's schema to the name a policy target declares, absent when the name is
 * declared as written; the one retry a refused read may take, absent when there is none; and the row mapper, absent
 * when the composed statement answers the catalog rows itself.
 */
export interface AgentCatalogRead {
  readonly compose: Readonly<Record<AgentCatalogKind, (selector: AgentCatalogSelector) => string>>;
  readonly declaredSchema?: (schema: string) => string;
  readonly retry?: {
    /** Whether a database error is the one this retry answers. */
    readonly matches: (message: string) => boolean;
    /** The statement to send instead. A rewrite that changes nothing is not sent. */
    readonly rewrite: (sql: string) => string;
  };
  /**
   * The rows of one kind as the engine answered them, turned into the catalog rows that kind reads as, for an engine
   * whose catalog statement answers under column names no SELECT can rename. Applied to the engine's answer before
   * the run keeps it, so the model, the capture and the statistics reading all read the mapped rows.
   *
   * Pure, and held to it by `engine-pack-contract.test.ts`: it never throws on an engine answer, never writes into
   * it, answers the same rows twice, keeps no row it was not given (the budget was spent on the engine's rows), and
   * keys every row by the columns it declares.
   */
  readonly mapRows?: (kind: AgentCatalogKind, rows: readonly Record<string, unknown>[]) => AgentCatalogRows;
}
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
 * narrowing to its schema instead. Escape handling is now a per-dialect grammar fact
 * (`backslashAlwaysEscapes`, `docs/BACKLOG.md` S2) that every shipped row declares
 * false, and the wide rule stays correct whichever way a row declares it.
 */
export function assertSelector(value: string, field: string): string {
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
export function equalsClause(column: string, value: string | undefined, field: string, dialect: DatabaseType): string {
  if (value === undefined) return "";
  return ` AND ${column} = ${quoteLiteral(assertSelector(value, field), dialect)}`;
}
