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
    case "mysql":
      return `\`${name.replace(/`/g, "``")}\``;
    case "mssql":
      return `[${name.replace(/]/g, "]]")}]`;
    default:
      // The SQL standard form, and what the remaining dialects use: PostgreSQL,
      // SQLite, Oracle, ClickHouse, Druid, and the document/key-value providers
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
