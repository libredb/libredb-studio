/**
 * Reading SQLite's stored DDL back into an inventory (#329 T8, epic #325).
 *
 * On the agent path SQLite has no structured catalog at all. Every `pragma_*`
 * table-valued function is refused by the input guard (`composed-sql.ts` records
 * the rule and why it is not worked around), so the only description of a table's
 * columns, keys and indexes is the text SQLite itself stored in `sqlite_master.sql`
 * — the engine's own normalised copy of the statement that created the object.
 * This module reads that text.
 *
 * It is a READER, not a SQL parser, and the difference is the point:
 *
 *  - It answers four questions — what are the columns, which are NOT NULL, which
 *    form the primary key, and which references point where — and ignores
 *    everything else the DDL says. A `CHECK`, a generated column's expression, a
 *    conflict clause and a collation are stepped over, not modelled.
 *  - It never guesses. Text it cannot read as a `CREATE TABLE` with a column list
 *    (a view, a `CREATE TABLE … AS SELECT`, anything else) yields an EMPTY
 *    definition rather than a partial one, and the caller renders that table as
 *    having no derivable columns. A half-read inventory presented as whole is the
 *    failure mode worth avoiding here.
 *  - Quoting is handled by scanning rather than by regular expressions, because
 *    the three quote characters SQLite accepts (`'`, `"`, `` ` ``) plus the
 *    bracket form all change what a comma means, and a comma is what separates one
 *    column from the next. `DECIMAL(10, 4)` and `DEFAULT 'a, b'` are the ordinary
 *    cases, not exotic ones.
 *
 * Everything here is verified against a real engine in
 * `tests/unit/lib/agent/sqlite-ddl.test.ts`: each fixture is created in a live
 * `bun:sqlite` database and the text SQLite stored is what gets parsed. Parsing a
 * string the test wrote would only prove the parser agrees with its author.
 */

import type { ColumnSchema, ForeignKeySchema, IndexSchema } from "@/lib/types";

/** What one stored `CREATE TABLE` yields. Empty when the text is not one. */
export interface SqliteTableDefinition {
  readonly columns: readonly ColumnSchema[];
  readonly foreignKeys: readonly ForeignKeySchema[];
  /**
   * The indexes SQLite builds to enforce this table's `UNIQUE` constraints.
   *
   * They are here because they are NOWHERE ELSE: SQLite stores no DDL for them, so
   * the composed index read (`sql IS NOT NULL`) cannot see them, and the table's own
   * DDL — where the constraint is declared — is the only place the agent path can
   * learn they exist. Leaving them out made a foreign key covered by a `UNIQUE`
   * constraint read as unindexed (#502).
   */
  readonly indexes: readonly IndexSchema[];
}

const EMPTY_TABLE: SqliteTableDefinition = Object.freeze({ columns: [], foreignKeys: [], indexes: [] });

/**
 * What a constraint-created index is CALLED here.
 *
 * Not the engine's own `sqlite_autoindex_<table>_<n>`: that name is not derivable
 * from the DDL — a named `CONSTRAINT uq_x UNIQUE (…)` does not lend the index its
 * name (measured: the index is still `sqlite_autoindex_…`), and the `<n>` counts
 * constraints in an order this reader does not model. Inventing one would put a
 * name in the inventory that might not exist in the database.
 *
 * Plain words in parentheses instead, the same convention `IMPLICIT_PRIMARY_KEY`
 * uses above, so no reader can mistake it for an index somebody wrote a
 * `CREATE INDEX` for. It IS a real index — it just has no DDL and no author.
 */
const IMPLICIT_UNIQUE_INDEX = "(unique constraint)";

/**
 * What a reference names when the DDL omits the referenced column. SQLite then
 * points at the parent's primary key, which this text says plainly rather than
 * copying the referencing column's name and hoping.
 */
const IMPLICIT_PRIMARY_KEY = "(primary key)";

/** Closing character per opening quote. `[` is SQLite's fourth identifier form. */
const CLOSING_QUOTE: Readonly<Record<string, string>> = { "'": "'", '"': '"', "`": "`", "[": "]" };

/**
 * The index just past the quoted region starting at `start`.
 *
 * A doubled closing character is an escape for the three symmetric forms, so
 * `'a''b'` is one literal; the bracket form has no escape and ends at its first
 * `]`, which is SQLite's own rule. An unterminated region ends at the text's end —
 * the caller is reading engine-stored DDL, so this cannot be a hostile string, and
 * refusing the whole table over it would lose an inventory to a truncation nobody
 * can act on.
 */
function skipQuoted(text: string, start: number): number {
  const open = text[start] as string;
  const close = CLOSING_QUOTE[open] as string;
  const escapable = open !== "[";
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === close) {
      if (escapable && text[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/** Splits on top-level commas, stepping over quoted regions and nested parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (CLOSING_QUOTE[char] !== undefined) {
      index = skipQuoted(text, index);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}

type Token =
  /** A bare run of identifier characters: a keyword, a type name or an unquoted name. */
  | { readonly kind: "word"; readonly value: string }
  /** A quoted identifier, already unquoted. */
  | { readonly kind: "ident"; readonly value: string }
  /** A parenthesised group; `value` is its inner text, unparsed. */
  | { readonly kind: "paren"; readonly value: string }
  /** A single-quoted literal; kept as a token so a comma or keyword inside it is inert. */
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "symbol"; readonly value: string };

const WORD_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * Splits DDL text into the few token kinds this reader distinguishes.
 *
 * Deliberately tokenising rather than pattern-matching: `NOT NULL` inside a string
 * default, a `REFERENCES` inside a `CHECK`, and a quoted column literally named
 * `primary key` are all cases a regular expression over the raw text gets wrong,
 * and all three are ordinary SQL.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "'") {
      const end = skipQuoted(text, index);
      tokens.push({ kind: "string", value: text.slice(index + 1, Math.max(index + 1, end - 1)) });
      index = end;
    } else if (CLOSING_QUOTE[char] !== undefined) {
      const end = skipQuoted(text, index);
      const raw = text.slice(index + 1, Math.max(index + 1, end - 1));
      // A doubled quote inside the name is one character of the name.
      tokens.push({ kind: "ident", value: char === "[" ? raw : raw.split(char + char).join(char) });
      index = end;
    } else if (char === "(") {
      const end = matchingParenthesis(text, index);
      tokens.push({ kind: "paren", value: text.slice(index + 1, end) });
      index = end + 1;
    } else if (WORD_CHARACTER.test(char)) {
      let end = index;
      while (end < text.length && WORD_CHARACTER.test(text[end] as string)) end += 1;
      tokens.push({ kind: "word", value: text.slice(index, end) });
      index = end;
    } else {
      tokens.push({ kind: "symbol", value: char });
      index += 1;
    }
  }
  return tokens;
}

/** Index of the `)` closing the `(` at `open`, or the text's end when unterminated. */
function matchingParenthesis(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const char = text[index] as string;
    if (CLOSING_QUOTE[char] !== undefined) {
      index = skipQuoted(text, index);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return text.length;
}

const upper = (token: Token | undefined): string => (token?.kind === "word" ? token.value.toUpperCase() : "");

/** A name, whether it arrived quoted or bare. `null` for anything else. */
function nameOf(token: Token | undefined): string | null {
  if (token === undefined) return null;
  return token.kind === "ident" || token.kind === "word" ? token.value : null;
}

const CREATE_TABLE_HEAD = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i;

/**
 * The index of the `(` opening the column list, or `null` when the text has none.
 *
 * The head is matched strictly and the column list must follow the table name
 * IMMEDIATELY, which is what separates a real column list from the parentheses in
 * `CREATE TABLE big AS SELECT … WHERE x > (SELECT 1)`. That statement's columns
 * exist only in the query that filled it, so there is nothing here to read.
 */
function columnListStart(sql: string): number | null {
  const head = CREATE_TABLE_HEAD.exec(sql);
  if (head === null) return null;

  let index = head[0].length;
  // The name, optionally schema-qualified: `main.orders`, `"my db"."odd names"`.
  for (;;) {
    if (index >= sql.length) return null;
    const char = sql[index] as string;
    if (CLOSING_QUOTE[char] !== undefined) index = skipQuoted(sql, index);
    else if (WORD_CHARACTER.test(char)) {
      while (index < sql.length && WORD_CHARACTER.test(sql[index] as string)) index += 1;
    } else return null;
    if (sql[index] !== ".") break;
    index += 1;
  }
  while (index < sql.length && /\s/.test(sql[index] as string)) index += 1;
  return sql[index] === "(" ? index : null;
}

/** Column-definition keywords that end the type name and begin the constraints. */
const COLUMN_CONSTRAINT_HEADS: ReadonlySet<string> = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "NOT",
  "NULL",
  "UNIQUE",
  "CHECK",
  "DEFAULT",
  "COLLATE",
  "REFERENCES",
  "GENERATED",
  "AS",
]);

/** Table-level constraint keywords, i.e. an item that declares no column. */
const TABLE_CONSTRAINT_HEADS: ReadonlySet<string> = new Set(["PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);

/** The type name as written, parenthesised arguments included: `NUMERIC(10, 2)`. */
function readTypeName(tokens: readonly Token[], from: number): { type: string; next: number } {
  const words: string[] = [];
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index] as Token;
    if (token.kind === "paren" && words.length > 0) {
      words[words.length - 1] += `(${token.value.trim()})`;
      index += 1;
      continue;
    }
    if (token.kind !== "word" || COLUMN_CONSTRAINT_HEADS.has(token.value.toUpperCase())) break;
    words.push(token.value);
    index += 1;
  }
  return { type: words.join(" "), next: index };
}

/** Each name in a parenthesised column list, modifiers (`ASC`, `COLLATE …`) dropped. */
function columnNames(list: string): string[] {
  const names: string[] = [];
  for (const item of splitTopLevel(list)) {
    const name = nameOf(tokenize(item)[0]);
    if (name !== null) names.push(name);
  }
  return names;
}

/**
 * The edges one `REFERENCES` clause declares, paired by position.
 *
 * `local` is the referencing column list: one entry for an inline reference, the
 * `FOREIGN KEY (…)` list for a table-level one. SQLite requires the two lists to
 * be the same length when both are present, so a positional pairing is the
 * declaration's own meaning rather than an assumption.
 */
function referenceEdges(tokens: readonly Token[], at: number, local: readonly string[]): ForeignKeySchema[] {
  const table = nameOf(tokens[at + 1]);
  if (table === null) return [];
  const listToken = tokens[at + 2];
  const referenced = listToken?.kind === "paren" ? columnNames(listToken.value) : [];
  return local.map((columnName, position) => ({
    columnName,
    referencedTable: table,
    referencedColumn: referenced[position] ?? IMPLICIT_PRIMARY_KEY,
  }));
}

/** One item of the column list: a column definition, or a table-level constraint. */
interface ParsedItem {
  readonly column?: ColumnSchema;
  readonly foreignKeys: readonly ForeignKeySchema[];
  /** Column names a table-level `PRIMARY KEY (…)` named. */
  readonly primaryKeyColumns: readonly string[];
  /**
   * Column names one `UNIQUE` constraint covers, IN ORDER — the order is the point,
   * since a covering test is a prefix test, not a membership test.
   *
   * A `PRIMARY KEY` is deliberately not reported the same way: the primary key is
   * already in the column inventory (`isPrimary`), and an `INTEGER PRIMARY KEY` is
   * the rowid itself with no index behind it at all, so an index row for it would
   * name an object that does not exist.
   */
  readonly uniqueColumns: readonly string[];
}

function parseItem(item: string): ParsedItem {
  let tokens = tokenize(item);
  // `CONSTRAINT <name> …` prefixes a table-level constraint and says nothing else.
  if (upper(tokens[0]) === "CONSTRAINT" && nameOf(tokens[1]) !== null) tokens = tokens.slice(2);

  const head = upper(tokens[0]);
  if (TABLE_CONSTRAINT_HEADS.has(head)) {
    // `PRIMARY KEY (…)` and `FOREIGN KEY (…)` spell the keyword in two words, so
    // their list is the third token; `UNIQUE (…)` spells it in one.
    const list = head === "UNIQUE" ? tokens[1] : tokens[2];
    const names = list?.kind === "paren" ? columnNames(list.value) : [];
    if (head === "PRIMARY") return { foreignKeys: [], primaryKeyColumns: names, uniqueColumns: [] };
    if (head === "UNIQUE") return { foreignKeys: [], primaryKeyColumns: [], uniqueColumns: names };
    if (head === "FOREIGN") {
      const referencesAt = tokens.findIndex((token) => upper(token) === "REFERENCES");
      return {
        foreignKeys: referencesAt === -1 ? [] : referenceEdges(tokens, referencesAt, names),
        primaryKeyColumns: [],
        uniqueColumns: [],
      };
    }
    return { foreignKeys: [], primaryKeyColumns: [], uniqueColumns: [] };
  }

  const name = nameOf(tokens[0]);
  if (name === null) return { foreignKeys: [], primaryKeyColumns: [], uniqueColumns: [] };

  const { type, next } = readTypeName(tokens, 1);
  let nullable = true;
  let isPrimary = false;
  let unique = false;
  const foreignKeys: ForeignKeySchema[] = [];
  for (let index = next; index < tokens.length; index += 1) {
    const word = upper(tokens[index]);
    if (word === "NOT" && upper(tokens[index + 1]) === "NULL") nullable = false;
    else if (word === "PRIMARY" && upper(tokens[index + 1]) === "KEY") isPrimary = true;
    else if (word === "UNIQUE") unique = true;
    else if (word === "REFERENCES") foreignKeys.push(...referenceEdges(tokens, index, [name]));
  }
  return {
    column: { name, type, nullable, isPrimary },
    foreignKeys,
    primaryKeyColumns: [],
    uniqueColumns: unique ? [name] : [],
  };
}

/**
 * The columns and foreign keys one stored `CREATE TABLE` declares.
 *
 * Returns an empty definition — never a partial one — for anything that is not a
 * `CREATE TABLE` carrying a column list.
 */
export function parseSqliteTableDdl(sql: string): SqliteTableDefinition {
  if (typeof sql !== "string") return EMPTY_TABLE;
  const start = columnListStart(sql);
  if (start === null) return EMPTY_TABLE;

  const body = sql.slice(start + 1, matchingParenthesis(sql, start));
  const columns: ColumnSchema[] = [];
  const foreignKeys: ForeignKeySchema[] = [];
  const indexes: IndexSchema[] = [];
  const tablePrimaryKey = new Set<string>();

  for (const item of splitTopLevel(body)) {
    const parsed = parseItem(item);
    if (parsed.column !== undefined) columns.push(parsed.column);
    foreignKeys.push(...parsed.foreignKeys);
    for (const name of parsed.primaryKeyColumns) tablePrimaryKey.add(name);
    if (parsed.uniqueColumns.length > 0) {
      indexes.push({ name: IMPLICIT_UNIQUE_INDEX, columns: [...parsed.uniqueColumns], unique: true });
    }
  }

  return {
    columns: columns.map((column) => (tablePrimaryKey.has(column.name) ? { ...column, isPrimary: true } : column)),
    foreignKeys,
    indexes,
  };
}

/**
 * What one stored `CREATE INDEX` indexes, or `null` when the text carries no
 * column list (an index SQLite created for a constraint stores no DDL at all, and
 * the composed read already excludes those).
 *
 * An expression keeps its written form rather than being dropped: an index on
 * `lower(code)` is a real index and a reader that silently omitted it would make
 * the inventory disagree with the database.
 */
export function parseSqliteIndexDdl(
  sql: string,
): { readonly columns: readonly string[]; readonly unique: boolean } | null {
  if (typeof sql !== "string") return null;
  const tokens = tokenize(sql);
  const onAt = tokens.findIndex((token) => upper(token) === "ON");
  if (onAt === -1) return null;
  const list = tokens[onAt + 2];
  if (list?.kind !== "paren") return null;

  const columns: string[] = [];
  for (const item of splitTopLevel(list.value)) {
    const itemTokens = tokenize(item);
    // A lone name, with or without `ASC`/`DESC`/`COLLATE …` after it; anything
    // more is an expression and is kept as written.
    const name = nameOf(itemTokens[0]);
    const modifier = upper(itemTokens[1]);
    const bare = itemTokens.length === 1 || modifier === "ASC" || modifier === "DESC" || modifier === "COLLATE";
    if (name !== null && bare) columns.push(name);
    else columns.push(item.trim());
  }
  return { columns, unique: upper(tokens[1]) === "UNIQUE" };
}
