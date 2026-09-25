/**
 * Each column's DEFAULT clause, read out of MySQL's own `SHOW CREATE TABLE` text (#1031).
 *
 * WHY THE DDL AND NOT THE CATALOG. `information_schema.COLUMNS.COLUMN_DEFAULT` reports the
 * VALUE a MySQL column defaults to, and nothing in that row says whether the text is also
 * SQL: `abc` is not and `b'1'` is, both with an empty `EXTRA`. Measured on 26.7.0, it also
 * TRUNCATES a binary default at its first zero byte, so `binary(4) DEFAULT 0x00FF0A27` reads
 * back as the two characters `0x`. `SHOW CREATE TABLE` is the server's own rendering of every
 * default as SQL it accepts back, and pasting it round-trips all of the #1031 binary cases
 * byte for byte.
 *
 * WHY A SCANNER OF ITS OWN AND NOT `src/lib/sql/spans.ts`. That module reads text a USER wrote,
 * where whether a backslash escapes depends on the session, so it reports a quote behind a
 * backslash as undeterminable. This text is the SERVER's, and the server fixes the rule:
 * measured, `SHOW CREATE TABLE` escapes with backslashes (`'a\\b'`, `'\0''\0\\\r'`) even in a
 * session running `NO_BACKSLASH_ESCAPES`. So here the backslash reading is a fact, not a
 * guess, and a general reader would decline exactly the defaults this exists for.
 *
 * WHAT IT READS. The column list only: a top-level `DEFAULT` in a column definition, and the
 * one primary that follows it - a string (`'it''s'`), a prefixed string (`b'101'`), a word
 * (`NULL`, `CURRENT_TIMESTAMP`, `0x00FF0A27`), a call (`CURRENT_TIMESTAMP(6)`) or a
 * parenthesised expression (`(json_array())`). Reading ONE primary rather than "up to the next
 * keyword" is what stops it at `ON UPDATE`, `COMMENT` and a versioned comment such as
 * `/*!80023 INVISIBLE *\/` without a list of every attribute that can follow. Since 8.0.13
 * MySQL requires a parenthesis around any other expression default, so one primary is the
 * whole clause.
 *
 * The word DEFAULT turns up in four places where it is not the clause, and all four are
 * skipped by structure rather than by a pattern: inside a string (`COMMENT 'has DEFAULT'`, an
 * `enum('x DEFAULT y')` member), inside a parenthesis (`GENERATED ALWAYS AS
 * ((default(inv) + 1))`, a `CHECK`), inside a quoted identifier, and in the table options
 * after the list (`DEFAULT CHARSET=`), which is never scanned.
 *
 * IDENTIFIERS in all three spellings the server uses, measured: backticks by default, the
 * double quote under `ANSI_QUOTES`, and bare under `sql_quote_show_create=0` for a name that
 * needs no quoting. A bare constraint keyword opens a key or constraint line rather than a
 * column; every one of them is reserved, so a column of that name is always quoted.
 *
 * ANY DOUBT IS `undefined`, NEVER A PARTIAL MAP. An unterminated string, identifier, comment
 * or parenthesis, a missing column list, a DEFAULT with no primary after it, or an item that
 * starts with anything else: the caller keeps today's catalog reading for the whole table.
 * A partial map would leave some columns of one table on each reading, and a diff of that
 * table would compare the two.
 */

/** The bare words that open a line of the column list that is not a column. All are reserved. */
const NON_COLUMN_WORDS: ReadonlySet<string> = new Set([
  "CHECK",
  "CONSTRAINT",
  "FOREIGN",
  "FULLTEXT",
  "INDEX",
  "KEY",
  "PRIMARY",
  "SPATIAL",
  "UNIQUE",
]);

const WORD_CHAR = /[\p{L}\p{N}_$]/u;
const SPACE = /\s/;

/** An end the scan could not reach, which `tokens()` turns into `undefined`. */
const STUCK = -1;

/**
 * One unit of the statement. A `group` is a whole balanced parenthesis, contents included, so
 * a reader over tokens never sees a comma, a paren or a DEFAULT that sits inside one.
 */
interface Token {
  readonly kind: "space" | "word" | "string" | "identifier" | "comment" | "group" | "other";
  readonly text: string;
}

/**
 * One past a `'…'` string opening at `index`. A backslash escapes the next character and a
 * doubled quote is one quote, which is how the server writes both.
 */
function stringEnd(text: string, index: number): number {
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
    } else if (text[i] === "'") {
      if (text[i + 1] !== "'") return i + 1;
      i++;
    }
  }
  return STUCK;
}

/** One past an identifier quoted with `quote` (backtick or double quote), whose closer doubles. */
function quotedEnd(text: string, index: number, quote: string): number {
  for (let i = index + 1; i < text.length; i++) {
    if (text[i] !== quote) continue;
    if (text[i + 1] !== quote) return i + 1;
    i++;
  }
  return STUCK;
}

/** One past the `)` matching the `(` at `index`, stepping over every run inside it whole. */
function groupEnd(text: string, index: number): number {
  let depth = 0;
  for (let i = index; i < text.length; ) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
    const end = runEnd(text, i);
    if (end === STUCK) return STUCK;
    i = end;
  }
  return STUCK;
}

/** The kind of the unit opening at `index`, and one past its end. */
function unitAt(text: string, index: number): { kind: Token["kind"]; end: number } {
  const ch = text[index];
  if (ch === "'") return { kind: "string", end: stringEnd(text, index) };
  if (ch === "`" || ch === '"') return { kind: "identifier", end: quotedEnd(text, index, ch) };
  if (ch === "/" && text[index + 1] === "*") {
    const close = text.indexOf("*/", index + 2);
    return { kind: "comment", end: close === -1 ? STUCK : close + 2 };
  }
  if (ch === "(") return { kind: "group", end: groupEnd(text, index) };
  let end = index;
  const kind = WORD_CHAR.test(ch) ? "word" : SPACE.test(ch) ? "space" : "other";
  if (kind === "other") return { kind, end: index + 1 };
  const same = kind === "word" ? WORD_CHAR : SPACE;
  while (end < text.length && same.test(text[end])) end++;
  return { kind, end };
}

/**
 * Inside a group, one step: a paren is one character, counted by `groupEnd` itself, and
 * anything else is its whole run, so a paren counts only where no string or name hides it.
 */
function runEnd(text: string, index: number): number {
  return text[index] === "(" ? index + 1 : unitAt(text, index).end;
}

/** The statement as tokens, or `undefined` when any run in it never closes. */
function tokens(text: string): Token[] | undefined {
  const out: Token[] = [];
  for (let i = 0; i < text.length; ) {
    const { kind, end } = unitAt(text, i);
    if (end === STUCK) return undefined;
    out.push({ kind, text: text.slice(i, end) });
    i = end;
  }
  return out;
}

/**
 * The one primary after DEFAULT, as the server wrote it: a group, a string, or a word with
 * the string or group written against it (`b'101'`, `CURRENT_TIMESTAMP(6)`).
 */
function primaryAt(item: readonly Token[], index: number): string | undefined {
  let i = index;
  while (item[i]?.kind === "space") i++;
  const first = item[i];
  if (first?.kind === "group" || first?.kind === "string") return first.text;
  if (first?.kind !== "word") return undefined;
  const next = item[i + 1];
  return next?.kind === "string" || next?.kind === "group" ? first.text + next.text : first.text;
}

/**
 * One column list item. `null` is a line that is not a column (a key or constraint),
 * `undefined` is an item this could not read, and otherwise the column's name with its
 * default, which is absent when it declares none.
 */
function readItem(item: readonly Token[]): { name: string; defaultSql?: string } | null | undefined {
  const at = item.findIndex((token) => token.kind !== "space");
  const head = item[at];
  let name: string;
  if (head?.kind === "identifier") {
    const quote = head.text[0];
    name = head.text.slice(1, -1).replaceAll(quote + quote, quote);
  } else if (head?.kind === "word") {
    if (NON_COLUMN_WORDS.has(head.text.toUpperCase())) return null;
    name = head.text;
  } else {
    return undefined;
  }

  const clause = item.findIndex(
    (token, i) => i > at && token.kind === "word" && token.text.toUpperCase() === "DEFAULT",
  );
  if (clause === -1) return { name };
  const defaultSql = primaryAt(item, clause + 1);
  return defaultSql === undefined ? undefined : { name, defaultSql };
}

/**
 * Every column's DEFAULT clause in one `SHOW CREATE TABLE` answer, keyed by column name, or
 * `undefined` when any part of the column list could not be read (see the module docblock).
 * A column with no DEFAULT clause - a generated column, an `AUTO_INCREMENT` key - is absent.
 */
export function showCreateColumnDefaults(ddl: string): ReadonlyMap<string, string> | undefined {
  // The column list is the statement's first group: a paren inside the table name is inside
  // an identifier token, and the table options after the list are never read.
  const list = tokens(ddl)?.find((token) => token.kind === "group");
  if (list === undefined) return undefined;
  const inner = tokens(list.text.slice(1, -1)) ?? [];

  const defaults = new Map<string, string>();
  let item: Token[] = [];
  for (const token of [...inner, { kind: "other", text: "," } as const]) {
    if (token.kind !== "other" || token.text !== ",") {
      item.push(token);
      continue;
    }
    const column = readItem(item);
    if (column === undefined) return undefined;
    if (column?.defaultSql !== undefined) defaults.set(column.name, column.defaultSql);
    item = [];
  }
  return defaults;
}

/**
 * The `DATA_TYPE`s whose `SHOW CREATE` default is a quoted number that MariaDB reports bare.
 * `bit` is not one: both servers write it `b'101'`. A type missing here costs only a
 * cosmetic difference, since `DEFAULT '42'` and `DEFAULT 42` are one default on these types.
 */
const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "bigint",
  "decimal",
  "float",
  "double",
  "year",
]);

/** The types a bare hex literal fills byte for byte. Every other type gets an introducer. */
const BINARY_TYPES: ReadonlySet<string> = new Set(["binary", "varbinary"]);

/** A quoted plain number, the only shape `SHOW CREATE` gave a numeric default (#1031). */
const QUOTED_NUMBER = /^'(-?\d+(?:\.\d+)?)'$/;

/**
 * MySQL's backslash escapes (reference manual, String Literals), of which `SHOW CREATE`
 * emits four: `\0`, `\n`, `\r` and `\\`, with a quote doubled rather than escaped and the
 * other control bytes written raw (measured on 26.7.0). `\%` and `\_` keep their backslash,
 * and a backslash before any other character is that character, both per the manual.
 */
const ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  "'": "'",
  '"': '"',
  b: "\b",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\x1a",
  "\\": "\\",
  "%": "\\%",
  _: "\\_",
};

/** The text a complete `'…'` literal holds, read the way the server that wrote it reads it. */
function literalText(literal: string): string {
  return literal
    .slice(1, -1)
    .replace(/\\([\s\S])|''/g, (_match, escaped: string | undefined) =>
      escaped === undefined ? "'" : (ESCAPES[escaped] ?? escaped),
    );
}

/**
 * One `SHOW CREATE` default as the SQL the migration generator should carry, for a column of
 * `dataType` (`information_schema.COLUMNS.DATA_TYPE`). Two rewrites, both approved on #1031
 * with the measurements behind them, and everything else exactly as the server wrote it:
 *
 *  1. A quoted number on a numeric type loses its quotes. MySQL writes `'42'` where MariaDB's
 *     catalog reports `42`, and `diffColumns` compares the text, so without this an unchanged
 *     int default would read as changed across the two. The type gate is what keeps a varchar
 *     `'007'` quoted, where the quotes are the value's.
 *  2. A string literal holding a backslash escape becomes hex. `SHOW CREATE` writes the escape
 *     even for a `NO_BACKSLASH_ESCAPES` session, and a server in that mode accepts `'a\\b'`
 *     and stores `a\\b`: wrong bytes, silently. Hex has one meaning in both modes. A text
 *     column takes the `_utf8mb4` introducer because a bare hex literal is read in the
 *     COLUMN's charset (latin1 `DEFAULT 0x5CC3A9` stores 5CC3A9, not 5CE9); a binary column
 *     takes the bytes bare. Only a whole literal is rewritten: an expression default stays as
 *     written, escapes and all, because an introducer inside it would change what it means.
 */
export function portableDefaultSql(text: string, dataType: string): string {
  const type = dataType.toLowerCase();
  const number = QUOTED_NUMBER.exec(text);
  if (number !== null && NUMERIC_TYPES.has(type)) return number[1];
  if (!text.startsWith("'") || !text.includes("\\")) return text;
  const bytes = new TextEncoder().encode(literalText(text));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return BINARY_TYPES.has(type) ? `0x${hex}` : `_utf8mb4 0x${hex}`;
}
