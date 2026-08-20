import type { DatabaseType } from "@/lib/types";

/**
 * How a dialect spells the escapes inside a single-quoted string literal.
 *
 * - `standard` — the quote is doubled and a backslash is ordinary data.
 * - `double-and-backslash` — the quote is doubled, and a backslash escapes, so it
 *   has to be doubled too or it would escape the closing quote.
 * - `backslash` — every escape is spelled with a backslash, including the quote;
 *   doubling is not part of the grammar.
 *
 * The map is total on purpose: a new provider cannot be added without TypeScript
 * demanding an answer here, because the silent wrong answer is exactly the defect
 * this file exists to close (issue #290).
 */
type LiteralEscape = "standard" | "double-and-backslash" | "backslash";

const LITERAL_ESCAPE: Record<DatabaseType, LiteralEscape> = {
  // `standard_conforming_strings` has been on by default since PostgreSQL 9.1, so
  // a backslash in a plain literal is data.
  postgres: "standard",
  sqlite: "standard",
  oracle: "standard",
  mssql: "standard",
  // Druid quotes a string with single quotes and puts its backslash escapes in the
  // separate `U&'fo\00F6'` form, so a backslash in a plain literal is data.
  druid: "standard",
  // Elasticsearch doubles the quote and reads a backslash as DATA. Measured on
  // 9.1.4 (2026-08-19): `SELECT 'a''b'` -> `a'b`; `SELECT 'a\\b'` -> the two
  // characters `a\b`; `SELECT 'a\'b'` is a `parsing_exception` at the character AFTER
  // the backslash, which is only possible if the `\` did not escape the quote that
  // closed the literal; and `SELECT 'a\'` returns `a\`.
  elasticsearch: "standard",
  // Measured on Trino 476 (2026-08-20), both directions: `SELECT 'O''Brien' AS a`
  // answers `O'Brien`, so doubling is the escape; `SELECT 'a\\b' AS a` answers the two
  // characters `a\\b`, so a backslash is DATA and doubling it would add a second one to
  // the value. Trino spells its backslash escapes in the separate `U&'fo\\+0000F6'`
  // form, exactly as Druid does.
  trino: "standard",
  // These three declare `queryLanguage: "json"`, so no statement is ever built for
  // them to read. What a generator emits for such a connection is portable SQL
  // meant to run elsewhere, and the standard form is the only thing it can claim.
  mongodb: "standard",
  redis: "standard",
  libredb: "standard",
  // Default `sql_mode`. A server running with NO_BACKSLASH_ESCAPES reads the
  // doubled backslash as two characters, which is why binding the value beats
  // quoting it wherever a bind form exists.
  mysql: "double-and-backslash",
  // Matches what the ClickHouse provider already does when it builds its own
  // literals (`src/lib/db/providers/sql/clickhouse/index.ts`).
  clickhouse: "double-and-backslash",
  // OpenSearch does BOTH, which is why its two type-ids do not share a row with
  // Elasticsearch's. Measured on 3.8.0 (2026-08-19): `SELECT 'a''b'` -> `a'b`, so
  // doubling works; `SELECT 'a\'b'` -> `a'b` too, so a backslash escapes the quote;
  // `SELECT 'a\\b'` -> ONE backslash, so it escapes itself; and `SELECT 'a\'` is a
  // `ParserException` - the trailing backslash escaped the closing quote and left the
  // literal open, which is exactly the defect #290 is about. The fork's SQL plugin
  // reads its literals the way MySQL does, and this row is not an inference from that
  // lineage but the four probes above.
  opensearch: "double-and-backslash",
  // SQL++ spells its literals the way JSON does — `char ::= unicode-character |
  // '\' ( '\' | '"' | "'" | 'b' | 'f' | 'n' | 'r' | 't' | 'u' hex hex hex hex )`.
  // Doubling is not in that grammar, so a doubled quote is not one literal there.
  couchbase: "backslash",
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
 *
 * An undefined dialect is the generator that has no connection to name one. It
 * gets the standard form, matching the standard identifier quoting such a
 * generator already emits: doubling the backslash there would corrupt the value on
 * every dialect that reads it as data, which is the larger group.
 */
export function quoteLiteral(value: string, dialect: DatabaseType | undefined): string {
  const escape = dialect ? LITERAL_ESCAPE[dialect] : "standard";
  if (escape === "standard") return `'${value.replace(/'/g, "''")}'`;

  // The backslash goes first in both remaining forms: doubling it afterwards would
  // also double the one this function just added in front of a quote.
  const escaped = value.replace(/\\/g, "\\\\");
  return escape === "backslash" ? `'${escaped.replace(/'/g, "\\'")}'` : `'${escaped.replace(/'/g, "''")}'`;
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
 * `null` is where this repo knows there is no positional form to spell: ClickHouse
 * binds named parameters only and its provider refuses positional ones outright,
 * and MongoDB, Redis and the embedded engine declare `queryLanguage: "json"`, so
 * no SQL statement binds anything for them. It is the signal to quote the value
 * with `quoteLiteral` instead — never to emit a placeholder nothing will bind.
 *
 * `trino` falls to `null` for that same sharper reason. Trino really does bind, through
 * `PREPARE`/`EXECUTE` plus an `X-Trino-Prepared-Statement` header, but the provider's
 * transport seam carries the statement alone, so `TrinoProvider.query()` REFUSES a
 * non-empty params array outright. Emitting `?` here would build a statement whose
 * placeholder the provider then declines to fill.
 *
 * `elasticsearch` and `opensearch` fall to that `null` too, and for a sharper reason
 * than "no form exists": both endpoints really do bind `?` (measured - ES takes
 * `{"query":"… WHERE id = ?","params":[1]}`, OpenSearch takes a `parameters` array of
 * `{type,value}` objects, both HTTP 200), but they spell the REQUEST differently and
 * the provider's seam carries the statement alone, so its `query()` refuses
 * positional parameters outright. Emitting `?` here would produce a statement whose
 * placeholder the provider then declines to fill.
 */
export function positionalPlaceholder(dialect: DatabaseType, position: number): string | null {
  switch (dialect) {
    // SQL++ takes its values in `args`, which the statement reads as `$1`, `$2`.
    case "postgres":
    case "couchbase":
      return `$${position}`;
    // Druid binds a `parameters` array against `?`, live-verified when the
    // provider was written (`src/lib/db/providers/sql/druid/index.ts`).
    case "mysql":
    case "sqlite":
    case "druid":
      return "?";
    case "oracle":
      return `:${position}`;
    case "mssql":
      return `@p${position}`;
    default:
      return null;
  }
}
