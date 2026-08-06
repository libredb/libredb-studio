import type { DatabaseType } from "@/lib/types";

/**
 * Whether the dialect reads a backslash as an escape character inside a string
 * literal. The map is total on purpose: a new provider cannot be added without
 * TypeScript demanding an answer here, because the silent wrong answer is exactly
 * the defect this file exists to close (issue #290).
 */
const BACKSLASH_ESCAPES_IN_LITERAL: Record<DatabaseType, boolean> = {
  // `standard_conforming_strings` has been on by default since PostgreSQL 9.1, so
  // a backslash in a plain literal is data.
  postgres: false,
  sqlite: false,
  oracle: false,
  mssql: false,
  // Calcite's standard lexer, which Druid SQL uses: doubling is the only escape.
  druid: false,
  // No SQL string literal of its own; the standard form is the inert choice.
  redis: false,
  libredb: false,
  // Default `sql_mode`. A server running with NO_BACKSLASH_ESCAPES reads the
  // doubled backslash as two characters, which is why binding the value beats
  // quoting it wherever a bind form exists.
  mysql: true,
  // Matches what the ClickHouse provider already does when it builds its own
  // literals (`src/lib/db/providers/sql/clickhouse/index.ts`).
  clickhouse: true,
  // SQL++ and the document shells spell their strings the way JSON does.
  couchbase: true,
  mongodb: true,
};

/**
 * Quote a value as a string literal for a dialect.
 *
 * This is the weaker half of the fix and it is the fallback, not the default: use
 * `positionalPlaceholder` and bind the value wherever the dialect has a bind form,
 * so the value never becomes statement text at all. Quoting is what remains for a
 * dialect that has no positional form.
 *
 * Doubling the quote alone is not enough. In a dialect where a backslash escapes,
 * a value ending in `\` would escape the closing quote and everything after it
 * would be read as SQL — a `WHERE` clause pasted into a cell then becomes the
 * statement's real predicate (issue #290).
 */
export function quoteLiteral(value: string, dialect: DatabaseType): string {
  const escaped = BACKSLASH_ESCAPES_IN_LITERAL[dialect] ? value.replace(/\\/g, "\\\\") : value;
  return `'${escaped.replace(/'/g, "''")}'`;
}

/**
 * The placeholder a dialect's driver binds for the 1-based `position`, or `null`
 * where this repo has not pinned a positional bind form.
 *
 * Each form is the one the provider's own `query(sql, params)` actually binds, so
 * changing one without changing the provider breaks the pair: `pg` takes `$n`,
 * `mysql2` and the SQLite drivers take `?`, `oracledb` binds an array to `:n`, and
 * the mssql provider registers its inputs as `p1`, `p2`, … which the statement
 * spells `@p1`, `@p2`.
 *
 * `null` is not the claim that an engine cannot bind — it is the claim that this
 * repo has not verified how. ClickHouse's provider refuses positional parameters
 * outright, and the remaining engines are not driven by a SQL statement. A dialect
 * that gains statement-driven row editing (issue #279) adds its form here; until
 * it does, `quoteLiteral` keeps the value out of the statement's grammar.
 */
export function positionalPlaceholder(dialect: DatabaseType, position: number): string | null {
  switch (dialect) {
    case "postgres":
      return `$${position}`;
    case "mysql":
    case "sqlite":
      return "?";
    case "oracle":
      return `:${position}`;
    case "mssql":
      return `@p${position}`;
    default:
      return null;
  }
}
