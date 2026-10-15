/**
 * What a query event keeps of the statement it records (docs/GOVERNANCE.md#query-events, `queryLog.statementCapture`).
 *
 * Under `redacted` an event stores `redactStatement()`: the statement with every value it carries replaced by `?`,
 * which still says which tables and columns it touched, the reason governance installs default to this mode (P3),
 * and `statement_fingerprint`, the lowercase hex SHA-256 of that text, so the runs of one statement shape group
 * together. Under `full` it stores the statement through `maskCredentials()`, which changes nothing but the
 * credentials written into it. Under `none` it stores neither, and nothing here runs.
 *
 * A statement is read the way the engine that runs it reads it, because a wrong reading stores a value as if it
 * were a name:
 *
 * - SQL is read by the span reader every statement reader in Studio shares (`src/lib/sql/spans.ts`), under the
 *   engine's row of `src/lib/sql/grammar.ts`, so a literal, a comment and a quoted name end here where the
 *   confirmation gate and the statement splitter end them. A quoted run the reader cannot close, such as one whose
 *   closing quote stands behind a backslash that some sessions read as an escape, runs to the end of the text, so
 *   nothing after its opening quote is kept under either reading.
 * - A MongoDB command is the JSON document the provider parses, and a Redis command is the one command
 *   `readRedisCommandText()` reads for the provider.
 * - Every other engine, and a SQL engine `grammar.ts` has no row for, keeps nothing: its statement is stored as
 *   `?`, because a reader guessing where a literal ends can store the literal.
 *
 * The userinfo of a URI is masked in both modes by the rule the audit log applies to its fields
 * (`redactUriCredentials()` in `src/lib/audit.ts`). The cases are pinned in
 * `tests/fixtures/governance/redaction-vectors.json`.
 */

import { createHash } from "node:crypto";
import { CREDENTIAL_REDACTION, redactUriCredentials } from "@/lib/audit";
import { readRedisCommandText } from "@/lib/db/providers/keyvalue/redis-command-text";
import { isRecord } from "@/lib/is-record";
import { DEFAULT_SQL_GRAMMAR, readsSqlText, resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { IDENTIFIER_PART, readSqlSpan } from "@/lib/sql/spans";
import { readSqlWord } from "@/lib/sql/words";
import type { DatabaseType } from "@/lib/types";

/** A redacted statement and its fingerprint, under the names of their `query_events_v1` columns. */
export interface RedactedStatement {
  readonly statement: string;
  readonly statement_fingerprint: string;
}

/** What replaces a value in a redacted statement, and the whole statement when nothing of it can be kept. */
const VALUE = "?";

/**
 * The quote each engine writes a NAME with under every session setting, the one quoted run a redacted statement
 * keeps. A double quote is a name in PostgreSQL and Oracle, but a string in MySQL unless `ANSI_QUOTES` is set and in
 * SQL Server while `QUOTED_IDENTIFIER` is off, so on those two it is masked like any literal. An engine absent here
 * keeps no quoted run at all, which costs its quoted names and never stores a literal.
 */
const NAME_QUOTES: Partial<Record<DatabaseType, string>> = {
  postgres: '"',
  oracle: '"',
  mysql: "`",
  mssql: "[",
};

/** The engines whose statement is no SQL text, each with a reader that mirrors its provider's own parse. */
const COMMAND_READERS: Partial<Record<DatabaseType, (text: string) => string>> = {
  mongodb: redactMongoCommand,
  redis: redactRedisCommand,
};

/**
 * The fields of a MongoDB command whose top-level string values say what it runs on, kept as SQL keeps table names.
 * Anywhere else, and as any other type, a value is data.
 */
const MONGODB_NAME_FIELDS: ReadonlySet<string> = new Set(["collection", "operation", "database"]);

/**
 * A word written against a literal's opening quote that belongs to the literal: `E'…'`, `N'…'`, `B'…'`, `X'…'` and
 * MySQL's charset introducer `_utf8mb4'…'`. `U&'…'` is a word and a `&`, matched in `pushQuoted()`.
 */
const LITERAL_PREFIX = /^(?:[ENBX]|_.+)$/i;

/**
 * The words that name a password. Under `full`, a quoted run the reader cannot close is masked whole when it holds
 * one: under the other reading part of the run is code, and that code may set a password.
 */
const PASSWORD_WORDS = /PASSWORD|IDENTIFIED/i;

/**
 * How many tokens MySQL's `SET PASSWORD FOR <account> =` may spend on the account: `'ann'@'%'` and `CURRENT_USER()`
 * are three. A bound, so a text of `PASSWORD FOR` repeated is still read in one pass.
 */
const ACCOUNT_TOKENS = 3;

/** What a run of a statement is, as far as redaction is concerned. */
type TokenKind = "space" | "comment" | "quoted" | "word" | "number" | "symbol";

interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  /** Index one past the token's last character. */
  readonly end: number;
  /** A quoted run's opening quote, past any prefix written against it; empty for every other kind. */
  readonly opener: string;
  /** Whether a quoted run reached its closing quote; true for every other kind. */
  readonly terminated: boolean;
}

/** The JSON command form of a Redis statement, before the provider checks it. */
interface RedisJsonCommand {
  readonly command?: unknown;
  readonly args?: unknown;
}

function plainToken(kind: TokenKind, start: number, end: number): Token {
  return { kind, start, end, opener: "", terminated: true };
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Where the number at `index` ends, or `index` when none starts there: digits, or a point and digits, then every
 * name character and point after them, so `1.5`, `0x1F`, `1_000` and Oracle's `7D` are one number each, plus the
 * sign of an exponent (`1.5e-5`). A digit inside a name never gets here, because the name was read whole first.
 *
 * The number stops where the span reader would open a literal, so `1.q'[x]'` on Oracle ends before the `q` the
 * reader opens an alternate-quoted literal at, and the two never disagree about where the literal starts.
 */
function numberEnd(text: string, index: number, grammar: SqlGrammar): number {
  if (!isDigit(text[index]) && !(text[index] === "." && isDigit(text[index + 1]))) return index;
  let end = index + 1;
  while (end < text.length) {
    const ch = text[end];
    const exponentSign = (ch === "+" || ch === "-") && /[eE]/.test(text[end - 1]) && isDigit(text[end + 1]);
    if ((ch === "." || IDENTIFIER_PART.test(ch)) && readSqlSpan(text, end, grammar) === null) end++;
    else if (exponentSign) end += 2;
    else break;
  }
  return end;
}

/**
 * A quoted run, with the prefix written against its opening quote counted in, so `E'…'`, `N'…'`, `B'…'`, `X'…'`,
 * `U&'…'` and `_utf8mb4'…'` are masked as one value each rather than kept as a name followed by one. A word with
 * white space before the quote stays a word, which is how `DATE '2024-01-31'` keeps its type name.
 */
function pushQuoted(tokens: Token[], text: string, start: number, end: number, terminated: boolean): void {
  let from = start;
  const last = tokens.at(-1);
  const before = tokens.at(-2);
  if (last?.end === start && last.kind === "word" && LITERAL_PREFIX.test(text.slice(last.start, last.end))) {
    tokens.pop();
    from = last.start;
  } else if (
    last?.end === start &&
    last.kind === "symbol" &&
    text[last.start] === "&" &&
    before?.kind === "word" &&
    before.end === last.start &&
    text.slice(before.start, before.end).toUpperCase() === "U"
  ) {
    tokens.splice(-2);
    from = before.start;
  }
  tokens.push({ kind: "quoted", start: from, end, opener: text[start], terminated });
}

/**
 * The statement as tokens, under the engine's grammar. Every position asks the shared span reader first, and only
 * code is cut here: into names and keywords by `readSqlWord()`, the word reader the readers in `src/lib/sql/` share,
 * into numbers, and into single characters.
 *
 * One span is read as code: a subscript or array literal (`ARRAY['a']`, `m['k']`) under a grammar whose brackets
 * subscript, because what it holds is code with literals in it. The span reader is not asked there at all, since it
 * would scan to the end of an unclosed run at every one of its brackets.
 */
function readTokens(text: string, grammar: SqlGrammar): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const span = text[index] === "[" && grammar.bracket === "subscript" ? null : readSqlSpan(text, index, grammar);
    if (span !== null) {
      if (span.kind === "whitespace") tokens.push(plainToken("space", index, span.end));
      else if (span.kind === "line-comment" || span.kind === "block-comment") {
        tokens.push(plainToken("comment", index, span.end));
      } else pushQuoted(tokens, text, index, span.end, span.terminated);
      index = span.end;
      continue;
    }
    const word = readSqlWord(text, index);
    const number = word === null ? numberEnd(text, index, grammar) : index;
    if (word !== null) tokens.push(plainToken("word", index, word.end));
    else if (number > index) tokens.push(plainToken("number", index, number));
    else tokens.push(plainToken("symbol", index, index + 1));
    index = tokens[tokens.length - 1].end;
  }
  return tokens;
}

/**
 * The tokens of a SQL statement that hold a password, as indexes into `tokens`:
 *
 * - the value after `IDENTIFIED BY`, after MySQL's `IDENTIFIED WITH <plugin> BY | AS` and after MariaDB's
 *   `IDENTIFIED VIA <plugin> USING`: a literal, or a bare word, which is how Oracle writes a password
 *   (`IDENTIFIED BY tiger`), with Oracle's `IDENTIFIED BY VALUES '<hash>'` read through to the hash;
 * - the literal after a word ending in `PASSWORD` (`PASSWORD`, `OLD_PASSWORD`, `MASTER_PASSWORD`), with an `=` or a
 *   `(` between them or not, and after MySQL's `SET PASSWORD FOR <account> =`;
 * - the old password a `REPLACE` writes right after either.
 *
 * So `CREATE USER x PASSWORD 'p'`, `ALTER ROLE r IDENTIFIED BY p`, SQL Server's `ALTER LOGIN … WITH PASSWORD = N'p'`
 * and an `UPDATE … SET password = 'h'` each hold one, while `SELECT password FROM users`, `PASSWORD NULL` and MySQL's
 * `IDENTIFIED BY RANDOM PASSWORD` hold none. White space and comments between the words are stepped over, and every
 * rule looks a bounded number of tokens ahead, so the read stays linear.
 */
function passwordTokens(tokens: readonly Token[], text: string): Set<number> {
  const significant: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "space" && token.kind !== "comment") significant.push(index);
  });
  const at = (k: number): Token | undefined => (k < significant.length ? tokens[significant[k]] : undefined);
  const wordAt = (k: number): string | undefined => {
    const token = at(k);
    return token?.kind === "word" ? text.slice(token.start, token.end).toUpperCase() : undefined;
  };
  const symbolAt = (k: number, symbol: string): boolean => {
    const token = at(k);
    return token?.kind === "symbol" && text[token.start] === symbol;
  };
  const isLiteral = (k: number): boolean => at(k)?.kind === "quoted" || at(k)?.kind === "number";
  const isValue = (k: number): boolean => isLiteral(k) || at(k)?.kind === "word";
  /** Where MySQL's `SET PASSWORD FOR <account> =` puts its `=`, given where its `FOR` is, or -1. */
  const accountEquals = (forAt: number): number => {
    for (let k = forAt + 2; k <= forAt + 1 + ACCOUNT_TOKENS; k++) if (symbolAt(k, "=")) return k;
    return -1;
  };

  const masked = new Set<number>();
  const maskValue = (k: number, accepts: (k: number) => boolean): void => {
    if (!accepts(k)) return;
    masked.add(significant[k]);
    if (wordAt(k + 1) === "REPLACE" && accepts(k + 2)) masked.add(significant[k + 2]);
  };

  for (let k = 0; k < significant.length; k++) {
    const word = wordAt(k);
    if (word === "IDENTIFIED") {
      let next = k + 1;
      if (wordAt(next) === "WITH" || wordAt(next) === "VIA") next += 2;
      const by = wordAt(next);
      if (by !== "BY" && by !== "AS" && by !== "USING") continue;
      next++;
      // MySQL 5.7's `IDENTIFIED BY PASSWORD '<hash>'` is read by the PASSWORD rule, and `RANDOM PASSWORD` names none.
      const value = wordAt(next);
      if (value === "PASSWORD" || value === "RANDOM") continue;
      if (value === "VALUES") next++;
      maskValue(next, isValue);
    } else if (word?.endsWith("PASSWORD")) {
      let next = k + 1;
      if (wordAt(next) === "FOR") {
        next = accountEquals(next);
        if (next === -1) continue;
      }
      if (symbolAt(next, "=")) next++;
      if (symbolAt(next, "(")) next++;
      maskValue(next, isLiteral);
    }
  }
  return masked;
}

/**
 * A SQL statement with every literal, number and comment replaced by `?`, the names and keywords around them kept,
 * and white space collapsed to one space between tokens. A comment separates the tokens around it as white space
 * does. A quoted run is kept only when it is a closed name in `nameQuote`, and a password written as a bare word or
 * as a name is masked too.
 */
function redactSql(text: string, grammar: SqlGrammar, nameQuote: string | undefined): string {
  const tokens = readTokens(text, grammar);
  const passwords = passwordTokens(tokens, text);
  const pieces: string[] = [];
  let separated = false;
  const emit = (piece: string): void => {
    if (separated && pieces.length > 0) pieces.push(" ");
    pieces.push(piece);
    separated = false;
  };
  const keeps = (token: Token, index: number): boolean => {
    if (passwords.has(index) || token.kind === "number") return false;
    return token.kind !== "quoted" || (token.terminated && token.opener === nameQuote);
  };
  tokens.forEach((token, index) => {
    if (token.kind === "space") {
      separated = true;
    } else if (token.kind === "comment") {
      separated = true;
      emit(VALUE);
      separated = true;
    } else {
      emit(keeps(token, index) ? text.slice(token.start, token.end) : VALUE);
    }
  });
  return pieces.join("");
}

/**
 * A MongoDB command's shape: its keys and its top-level `collection`, `operation` and `database` names, every other
 * value replaced by `?`, as compact JSON. Text that is not one JSON document keeps nothing, since the provider does
 * not run it either.
 *
 * The document is walked with a stack of its own rather than by recursion: the text is the caller's, and `JSON.parse`
 * reads a document nested far deeper than a recursive walk can follow.
 */
function redactMongoCommand(text: string): string {
  let command: unknown;
  try {
    command = JSON.parse(text.trim());
  } catch {
    return VALUE;
  }
  const pieces: string[] = [];
  const pending: (string | { readonly value: unknown; readonly top: boolean })[] = [{ value: command, top: true }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next === "string") {
      pieces.push(next);
      continue;
    }
    const { value, top } = next;
    if (Array.isArray(value)) {
      pending.push("]");
      for (let i = value.length - 1; i >= 0; i--) {
        pending.push({ value: value[i], top: false });
        if (i > 0) pending.push(",");
      }
      pending.push("[");
    } else if (isRecord(value)) {
      const fields = Object.entries(value);
      pending.push("}");
      for (let i = fields.length - 1; i >= 0; i--) {
        const [key, field] = fields[i];
        const named = top && MONGODB_NAME_FIELDS.has(key) && typeof field === "string";
        pending.push(named ? JSON.stringify(field) : { value: field, top: false });
        pending.push(`${JSON.stringify(key)}:`);
        if (i > 0) pending.push(",");
      }
      pending.push("{");
    } else {
      pieces.push(VALUE);
    }
  }
  return pieces.join("");
}

/** A Redis command's name, upper-cased as the provider sends it, and one `?` for each of its arguments. */
function commandShape(command: string, argumentCount: number): string {
  return [command.toUpperCase(), ...Array.from({ length: argumentCount }, () => VALUE)].join(" ");
}

/**
 * A Redis command's shape: the name of the one command the provider would send, and a `?` for every argument, which
 * holds keys and values alike. A text that sends nothing (blank, only comments, a second command or an unclosed
 * quote) keeps nothing, and so does a JSON command the provider would refuse.
 */
function redactRedisCommand(text: string): string {
  const read = readRedisCommandText(text);
  if (read.kind === "plain") return commandShape(read.words[0], read.words.length - 1);
  if (read.kind !== "json") return VALUE;
  let parsed: RedisJsonCommand;
  try {
    // A JSON command is read only when its first character is `{`, so a body that parses is an object.
    parsed = JSON.parse(read.body) as RedisJsonCommand;
  } catch {
    return VALUE;
  }
  const { command, args } = parsed;
  if (typeof command !== "string" || command === "") return VALUE;
  if (args !== undefined && !Array.isArray(args)) return VALUE;
  return commandShape(command, args?.length ?? 0);
}

function keepNothing(): string {
  return VALUE;
}

/**
 * The reader that redacts this engine's statements: its own command reader, its SQL grammar, or none.
 *
 * `resolveSqlGrammar()` answers the compatibility default for an engine without a row, an id Studio does not know
 * included, and that default is no engine's own reading, so a statement it would read keeps nothing.
 */
function readerOf(engine: DatabaseType): (text: string) => string {
  const commandReader = Object.hasOwn(COMMAND_READERS, engine) ? COMMAND_READERS[engine] : undefined;
  if (commandReader !== undefined) return commandReader;
  const grammar = resolveSqlGrammar(engine);
  if (!readsSqlText(engine) || grammar === DEFAULT_SQL_GRAMMAR) return keepNothing;
  const nameQuote = Object.hasOwn(NAME_QUOTES, engine) ? NAME_QUOTES[engine] : undefined;
  return (text) => redactSql(text, grammar, nameQuote);
}

/**
 * The redacted text of a statement `engine` runs, and its fingerprint, for `queryLog.statementCapture` `redacted`.
 *
 * For SQL, every string, dollar-quoted, alternate-quoted (`q'…'`) and prefixed literal, every number and every comment
 * (`--`, `/* … *\/`, and `#` or `//` where the engine reads one) becomes `?`, names and keywords stay, and white space
 * collapses to single spaces. A MongoDB command keeps its keys, its operation and the collection and database it
 * names, and a Redis command keeps its command name. The userinfo of a URI left in the text as code is masked.
 *
 * `statement_fingerprint` is the lowercase hex SHA-256 of the UTF-8 bytes of `statement`, so two runs that differ
 * only in values and white space share it.
 */
export function redactStatement(text: string, engine: DatabaseType): RedactedStatement {
  const statement = readerOf(engine)(text)
    .split(" ")
    .map((word) => redactUriCredentials(word))
    .join(" ");
  return { statement, statement_fingerprint: createHash("sha256").update(statement, "utf8").digest("hex") };
}

/** `text` with the userinfo of a URI masked in each run between white space, and the white space kept as written. */
function maskUriRuns(text: string): string {
  return text
    .split(/(\s+)/)
    .map((run) => redactUriCredentials(run))
    .join("");
}

/**
 * A statement `engine` runs with every credential written into it replaced by `[REDACTED]`, the marker the audit log
 * writes, for `queryLog.statementCapture` `full`. Everything else is kept byte for byte, white space included.
 *
 * Masked: the userinfo of every URI, read in each literal and quoted name and in each run between white space
 * elsewhere, so two values never merge into one URI, and a `//` that ClickHouse or Cassandra read as a comment does
 * not cut one in two. In SQL also every password `passwordTokens()` finds, and a quoted run that never closes and
 * names a password, since part of that run is code under the other reading. A comment that closes is kept as written.
 *
 * The engine picks the reading for the reason it does in `redactStatement()`: `#` opens a comment in MySQL and names
 * a temporary table in SQL Server, so the same characters hide a password on one engine and set it on the other.
 * Text that is not SQL is read for its quoted runs under the compatibility default, which is enough to find the URIs
 * in it.
 */
export function maskCredentials(text: string, engine: DatabaseType): string {
  const sql = readsSqlText(engine);
  const tokens = readTokens(text, sql ? resolveSqlGrammar(engine) : DEFAULT_SQL_GRAMMAR);
  const passwords = sql ? passwordTokens(tokens, text) : new Set<number>();
  const pieces: string[] = [];
  let between = "";
  const flush = (): void => {
    pieces.push(maskUriRuns(between));
    between = "";
  };
  tokens.forEach((token, index) => {
    const raw = text.slice(token.start, token.end);
    if (passwords.has(index)) {
      flush();
      pieces.push(CREDENTIAL_REDACTION);
    } else if (token.kind !== "quoted") {
      between += raw;
    } else {
      flush();
      const hidesPassword = sql && !token.terminated && PASSWORD_WORDS.test(raw);
      pieces.push(hidesPassword ? CREDENTIAL_REDACTION : redactUriCredentials(raw));
    }
  });
  flush();
  return pieces.join("");
}
