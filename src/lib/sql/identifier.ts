import type { DatabaseType } from "@/lib/types";

/**
 * Quote an identifier for a dialect, escaping the closing quote character.
 *
 * The escaping is the point, not decoration. An identifier that reaches SQL
 * generation is often arbitrary engine output — a result field carries whatever
 * alias the query wrote — so a name holding the closing quote character would end
 * the quoted span and leave the rest to be parsed as statement text. Doubling it is
 * how every one of these dialects spells a literal quote inside an identifier.
 *
 * Quoting also decides CASE semantics: an unquoted name is folded by the engine
 * (upper on Oracle, lower on PostgreSQL) while a quoted one is exact. Only quote a
 * name you have exactly as the engine reports it — a result field name is such a
 * name; a table name guessed from a tab title is not.
 */
export function quoteIdentifier(name: string, dialect: DatabaseType | undefined): string {
  switch (dialect) {
    // OpenSearch shares MySQL's backtick, and it is NOT a stylistic choice: measured
    // 2026-08-19 on 3.8.0, its SQL plugin reads a DOUBLE-quoted name as a string
    // literal, so `SELECT customer FROM "probe_orders"` is `IndexNotFoundException[no
    // such index ["probe_orders"]]` - quotes and all - while ``FROM `probe_orders``` is
    // HTTP 200. Worse in a predicate, where nothing fails: `WHERE "customer" = 'acme'`
    // compares two literals and answers 0 rows. Backticks work for both a table and a
    // field there. Elasticsearch 9.1.4 is the exact opposite - it answers a backtick
    // with "backquoted identifiers not supported; please use double quotes instead" -
    // so the two search ids cannot share a branch, and `elasticsearch` belongs in the
    // standard-form default below.
    //
    // The doubling is this repo's own convention carried over from MySQL and is NOT
    // measured: an index or field name containing a backtick would be needed to probe
    // it, and creating one on the probe cluster to find out was judged not worth
    // polluting the fixtures. It is the fail-safe direction either way - a doubled
    // backtick can only make the engine refuse a name, never make it read one it
    // should not.
    case "opensearch":
    case "mysql":
      return `\`${name.replace(/`/g, "``")}\``;
    case "mssql":
      return `[${name.replace(/]/g, "]]")}]`;
    default:
      // The SQL standard form, and what the remaining dialects use: PostgreSQL,
      // SQLite, Oracle, ClickHouse, Druid, Elasticsearch (measured: `FROM
      // "probe_orders"` and `SELECT "note.keyword"` both answer 200, and a backtick is
      // refused outright), Trino (measured on 476: `SELECT "nationkey" FROM
      // tpch.sf1.nation LIMIT 1` returns the column, `SELECT 1 AS "a""b"` names it
      // `a"b`, and a backtick is refused in the engine's own words - "backquoted
      // identifiers are not supported; use double quotes to quote identifiers"),
      // Cassandra (measured on 5.0.9: `SELECT "id" FROM probe.customers` returns the
      // column, a backtick is "no viable alternative at character '`'", and a
      // double-quoted STRING is a syntax error - so `"` is the name quote and nothing
      // else), DuckDB (measured on v1.5.5: `"quoted identifier"` works, and `[…]` is a
      // LIST literal here rather than a name quote, so the bracket branch above would
      // be wrong for it), and the document/key-value providers
      // whose generators fall back to it. An undefined dialect lands here too —
      // a generator with no connection to name one can claim only the standard.
      return `"${name.replace(/"/g, '""')}"`;
  }
}

/**
 * Whether `name` is a bare identifier, optionally qualified by dots — the shape
 * that can be interpolated into SQL without quoting.
 *
 * For a name that was DERIVED rather than read from the engine (the inline editor
 * guesses its table from the tab title or a `FROM` match), this is the safe test:
 * quoting such a guess would change its case semantics, while interpolating an
 * arbitrary string would let it carry statement text.
 */
export function isBareIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/.test(name);
}
