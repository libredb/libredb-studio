import type { DatabaseType } from "@/lib/types";

/**
 * How a dialect spells the escapes inside a single-quoted string literal.
 *
 * - `standard` — the quote is doubled and a backslash is ordinary data.
 * - `double-and-backslash` — the quote is doubled, and a backslash escapes, so it
 *   has to be doubled too or it would escape the closing quote.
 * - `backslash` — every escape is spelled with a backslash, including the quote;
 *   doubling is not part of the grammar.
 * - `unicode` — the quote is doubled and a backslash is ordinary data, exactly as
 *   `standard`, but the literal carries an `N` prefix because without it the
 *   characters are not Unicode at all. See the `mssql` row for the measurement.
 *
 * The map is total on purpose: a new provider cannot be added without TypeScript
 * demanding an answer here, because the silent wrong answer is exactly the defect
 * this file exists to close (issue #290).
 */
type LiteralEscape = "standard" | "double-and-backslash" | "backslash" | "unicode";

const LITERAL_ESCAPE: Record<DatabaseType, LiteralEscape> = {
  // `standard_conforming_strings` has been on by default since PostgreSQL 9.1, so
  // a backslash in a plain literal is data.
  postgres: "standard",
  sqlite: "standard",
  // Measured on sqld 0.24.33: `SELECT 'it''s'` answers `it's`, and a backslash has no
  // special meaning - the same standard doubling SQLite defines.
  libsql: "standard",
  // Measured on DuckDB v1.5.5, both directions: `SELECT 'it''s'` answers `it's`, and
  // `SELECT 'a\b', length('a\b')` answers the three characters `a\b` - so a backslash
  // is data, and doubling it would add a second one to the value.
  duckdb: "standard",
  oracle: "standard",
  // SQL Server parses a BARE literal in the database's collation code page and only an
  // `N`-prefixed one as Unicode, so the prefix is not decoration: every catalog name in
  // `sys` is `sysname`, which is `nvarchar(128)`.
  // Measured on SQL Server 2022 CU26, database AdventureWorks2022, collation
  // `SQL_Latin1_General_CP1_CI_AS` (code page 1252), with schemas `Müşteri` and `Müsteri`
  // both present: `SELECT 'Müşteri'` answers `Müsteri`, because `ş` (U+015F) is not in
  // 1252 and the server best-fits it to `s`. So `… WHERE s.name = 'Müşteri'` matched
  // `Müsteri.Siparis` - THE WRONG OBJECT - while `… WHERE s.name = N'Müşteri'` matched
  // `Müşteri.Sipariş`. With no `Müsteri` present the bare form matched nothing at all.
  // Both failures are silent, which is why this dialect does not share the `standard`
  // row: the escaping is the same, the code page is not.
  mssql: "unicode",
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
  // Measured on Cassandra 5.0.9 (2026-08-20), both directions. Doubling is the
  // escape: `… WHERE name = 'O''Brien'` runs and matches nothing, so the literal
  // closed at the doubled pair. A backslash is DATA: `… WHERE name = 'a\\b'` runs,
  // and `… WHERE name = 'a\\'` runs too - the statement reached the server's
  // filtering check, which is only possible if the backslash did not escape the
  // quote that closed the literal.
  cassandra: "standard",
  // These three declare `queryLanguage: "json"`, so no statement is ever built for
  // them to read. What a generator emits for such a connection is portable SQL
  // meant to run elsewhere, and the standard form is the only thing it can claim.
  mongodb: "standard",
  redis: "standard",
  libredb: "standard",
  // PromQL, not SQL (#1085): the same reading as the three above. A PromQL string
  // escapes with a backslash, but that is not a SQL literal and nothing here builds one.
  prometheus: "standard",
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
 *
 * The inverse is `unquoteLiteral` below, which reads these same rules backwards.
 */
export function quoteLiteral(value: string, dialect: DatabaseType | undefined): string {
  const escape = dialect ? LITERAL_ESCAPE[dialect] : "standard";
  if (escape === "standard") return `'${value.replace(/'/g, "''")}'`;
  // Same escaping as `standard`, plus the prefix that decides which character set the
  // server reads the escaped text in.
  if (escape === "unicode") return `N'${value.replace(/'/g, "''")}'`;

  // The backslash goes first in both remaining forms: doubling it afterwards would
  // also double the one this function just added in front of a quote.
  const escaped = value.replace(/\\/g, "\\\\");
  return escape === "backslash" ? `'${escaped.replace(/'/g, "\\'")}'` : `'${escaped.replace(/'/g, "''")}'`;
}

/**
 * What a backslash escape decodes to in the two dialects that have them.
 *
 * `\%` and `\_` are the documented exceptions: MySQL keeps BOTH characters, because the
 * pair exists for `LIKE` and not for the string. Anything not named here decodes to the
 * escaped character itself.
 */
const BACKSLASH_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\u0000",
  b: "\b",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\u001a",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "%": "\\%",
  _: "\\_",
};

/**
 * The value inside a single-quoted literal, or `undefined` when `text` is not exactly one.
 *
 * The inverse of `quoteLiteral`, and it is here rather than beside its caller because the
 * escape rules it undoes are the ones this module already measures per dialect. A second
 * copy elsewhere is how one of them ends up half right (#795).
 *
 * The `undefined` answer is half the contract, not an error path. A catalog that reports a
 * default as the expression AS WRITTEN hands this function string literals and bare
 * expressions through the same column, so "is this one literal" is the question the caller
 * needs answered, and the answer has to come from the grammar. A literal that CLOSES before
 * the end of the text is not one literal: `'a' = 'b'` is an expression, and stripping its
 * outer quotes would produce `a' = 'b`, a value nobody wrote.
 *
 * One left-to-right scan rather than a chain of replaces. `quoteLiteral` has to order its
 * two escapes, for the reason written above it; a scanner has no second pass to order.
 */
export function unquoteLiteral(text: string, dialect: DatabaseType | undefined): string | undefined {
  const escape = dialect ? LITERAL_ESCAPE[dialect] : "standard";
  // The prefix is part of the literal this dialect writes, so it is part of what is read.
  const body = escape === "unicode" && text.startsWith("N") ? text.slice(1) : text;
  if (body.length < 2 || !body.startsWith("'")) return undefined;

  const doubles = escape !== "backslash";
  const backslashes = escape === "double-and-backslash" || escape === "backslash";

  let value = "";
  let at = 1;
  while (at < body.length) {
    const char = body[at];
    if (char === "'") {
      if (doubles && body[at + 1] === "'") {
        value += "'";
        at += 2;
        continue;
      }
      // The literal closed. It is the WHOLE text only if nothing follows the closing quote.
      return at === body.length - 1 ? value : undefined;
    }
    if (backslashes && char === "\\" && at + 1 < body.length) {
      const escaped = body[at + 1] as string;
      value += BACKSLASH_ESCAPES[escaped] ?? escaped;
      at += 2;
      continue;
    }
    value += char;
    at += 1;
  }
  // Ran off the end without closing, which a trailing backslash is one way to do.
  return undefined;
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
 * `cassandra` falls to `null` on the same terms, and its version of the reason is the
 * plainest: CQL really does bind `?` positionally and `cassandra-driver` really does
 * bind an array against it - through a PREPARED statement, which is exactly what the
 * transport does not send (`prepare: false`, so a one-shot statement costs one round
 * trip and no server-side cache entry). `CassandraProvider.query()` therefore refuses a
 * non-empty params array outright, and emitting `?` here would build a statement whose
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
    // DuckDB binds BOTH forms - measured on v1.5.5, `runAndReadAll("SELECT ?::INTEGER
    // AS a, ?::VARCHAR AS b", [7, "x"])` and `runAndReadAll("SELECT $1::INTEGER AS a",
    // [9])` each answer - so this is a choice rather than a reading, and `?` is the one
    // taken. `$` is overloaded in this dialect: `$tag$…$tag$` is a dollar-quoted string
    // literal (measured), so a `$1` written into a generated statement sits one
    // character away from a form the readers in this folder have to tell apart, while
    // `?` has no second meaning anywhere in DuckDB's grammar. It also matches the
    // positional ORDER the driver binds by, which is the array's, not the digit's.
    case "duckdb":
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
