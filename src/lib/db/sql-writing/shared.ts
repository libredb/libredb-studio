/**
 * The literal, identifier and placeholder forms more than one engine spells alike.
 *
 * An engine module imports the one it uses by name, so a change here shows in the golden
 * output of every engine that imports it, and nowhere else. This module is a leaf: it
 * imports nothing from the tree but types, so any engine module can import it first in a
 * fresh process.
 */
import type { NonFiniteWord } from "@/lib/non-finite";
import type { ExportTypeVocabulary, InferredKind, SqlWritingSpec } from "./types";

type Escape = SqlWritingSpec["escapeLiteral"];
type Unescape = SqlWritingSpec["unescapeLiteral"];
type QuoteIdentifier = SqlWritingSpec["quoteIdentifier"];
type Placeholder = NonNullable<SqlWritingSpec["placeholder"]>;

// The quote is doubled and a backslash is ordinary data.
export const literalStandard: Escape = (text) => `'${text.replace(/'/g, "''")}'`;

// Same escaping as `literalStandard`, plus the `N` prefix that decides which character set
// the server reads the escaped text in: without it the characters are not Unicode at all.
export const literalUnicode: Escape = (text) => `N${literalStandard(text)}`;

// The backslash goes first in both remaining forms: doubling it afterwards would also
// double the one just added in front of a quote. A value ending in `\` would otherwise
// escape the closing quote and everything after it would be read as SQL (issue #290).

// The quote is doubled, and a backslash escapes, so it has to be doubled too.
export const literalDoubleAndBackslash: Escape = (text) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

// Every escape is spelled with a backslash, including the quote; doubling is not part of the grammar.
export const literalBackslash: Escape = (text) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * What a backslash escape decodes to in the dialects that have them.
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

interface QuotedGrammar {
  /** The literal may carry an `N` prefix, which is part of what is read. */
  readonly nPrefix: boolean;
  /** A doubled quote is one quote. */
  readonly doubles: boolean;
  /** A backslash escapes the next character. */
  readonly backslashes: boolean;
}

/**
 * The value inside a single-quoted literal, or `undefined` when `literal` is not exactly one.
 *
 * The `undefined` answer is half the contract, not an error path. A catalog that reports a
 * default as the expression AS WRITTEN hands its reader string literals and bare
 * expressions through the same column, so "is this one literal" is the question the caller
 * needs answered, and the answer has to come from the grammar. A literal that CLOSES before
 * the end of the text is not one literal: `'a' = 'b'` is an expression, and stripping its
 * outer quotes would produce `a' = 'b`, a value nobody wrote.
 *
 * One left-to-right scan rather than a chain of replaces. The writers have to order their
 * two escapes, for the reason written above them; a scanner has no second pass to order.
 */
function readQuoted(literal: string, grammar: QuotedGrammar): string | undefined {
  const body = grammar.nPrefix && literal.startsWith("N") ? literal.slice(1) : literal;
  if (body.length < 2 || !body.startsWith("'")) return undefined;

  let value = "";
  let at = 1;
  while (at < body.length) {
    const char = body[at];
    if (char === "'") {
      if (grammar.doubles && body[at + 1] === "'") {
        value += "'";
        at += 2;
        continue;
      }
      // The literal closed. It is the WHOLE text only if nothing follows the closing quote.
      return at === body.length - 1 ? value : undefined;
    }
    if (grammar.backslashes && char === "\\" && at + 1 < body.length) {
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

export const unquoteStandard: Unescape = (literal) =>
  readQuoted(literal, { nPrefix: false, doubles: true, backslashes: false });

export const unquoteUnicode: Unescape = (literal) =>
  readQuoted(literal, { nPrefix: true, doubles: true, backslashes: false });

export const unquoteDoubleAndBackslash: Unescape = (literal) =>
  readQuoted(literal, { nPrefix: false, doubles: true, backslashes: true });

export const unquoteBackslash: Unescape = (literal) =>
  readQuoted(literal, { nPrefix: false, doubles: false, backslashes: true });

/**
 * What a string outside the union gets today: a doubled quote is one quote, a backslash is
 * data, and no prefix is read. It reads exactly as `unquoteStandard` does, and is named
 * apart so the unknown-type answer does not move when the standard one does.
 */
export const unquoteDoublingOnly: Unescape = (literal) =>
  readQuoted(literal, { nPrefix: false, doubles: true, backslashes: false });

// Each identifier form doubles (or escapes) its own closing quote character, so a name
// holding it cannot end the quoted span and leave the rest to be parsed as statement text.

// The SQL standard form.
export const identifierDoubleQuoted: QuoteIdentifier = (name) => `"${name.replace(/"/g, '""')}"`;

// A backtick name, a doubled backtick inside it, and a backslash as data.
export const identifierBacktickDoubled: QuoteIdentifier = (name) => `\`${name.replace(/`/g, "``")}\``;

// A backtick name escaped inside with a backslash; a doubled backtick is not an escape there, it ends the name.
export const identifierBacktickBackslash: QuoteIdentifier = (name) =>
  `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;

export const identifierBracket: QuoteIdentifier = (name) => `[${name.replace(/]/g, "]]")}]`;

export const placeholderDollar: Placeholder = (position) => `$${position}`;

export const placeholderQuestion: Placeholder = () => "?";

export const placeholderColon: Placeholder = (position) => `:${position}`;

export const placeholderAtP: Placeholder = (position) => `@p${position}`;

// The inline edit type-name sets: the words that make a key column's declared type an
// instant, a 64-bit float or an exact decimal, matched on the type's own first word. An
// engine module that wants one imports it by name. "This hook" in their docblocks is the
// inline edit hook, `src/hooks/use-inline-editing.ts`, whose path every measurement ran on.

/**
 * The declared types whose value is an INSTANT, matched on the type's own first word.
 *
 * Every driver here spells the type the way its engine's catalog does, so the set is the
 * union of those spellings and nothing else: `timestamp without time zone` and `timestamp
 * with time zone` (`pg`), `datetime`/`timestamp`/`date` (mysql2), `DATE` and `TIMESTAMP
 * WITH TIME ZONE` (oracledb, uppercase), `datetime2`/`smalldatetime`/`datetimeoffset`
 * (mssql), `DateTime64(6, 'UTC')` and `Date32` (ClickHouse), `timestamp(3) with time zone`
 * (Trino).
 *
 * The SQLite and libsql spellings — `DATE`, `DATETIME`, `TIMESTAMP` — are in this set too,
 * and are read only on the dialects where they mean an instant. The sqlite and libsql
 * modules do not import this set, so their `instantTypeNames` is empty, for the same
 * reason their `float64TypeNames` is `"all"`.
 *
 * The FIRST WORD of the type and not a substring of it, which is the whole reason this is
 * a set rather than a `.includes("date")`: PostgreSQL's `daterange`, `tsrange` and
 * `tstzrange` are ranges rendered as text, `'[2024-01-01,2024-02-01)'`, whose text is
 * exactly their identity — a substring test would refuse three perfectly good keys to
 * catch one bad one.
 *
 * `time` and `time with time zone` are deliberately ABSENT. `pg` and `mysql2` both hand a
 * time-of-day back as the string the engine prints (`'10:00:00'`), which is its own
 * identity and matches when sent back, so refusing one would take away a key that works.
 * A date or a timestamp is the opposite: `pg` hands back a JavaScript `Date` for `timestamp
 * with time zone`, and that is the value this whole check exists for. `pg`'s `date` and
 * `timestamp without time zone` arrive as the engine's own text since the provider's per-pool
 * parsers, and so do mysql2's `date`, `datetime` and `timestamp` since the MySQL pool's
 * `dateStrings` (#1388). They are still refused here: the refusal reads the declaration,
 * which is conservative for those rather than wrong.
 */
export const INSTANT_TYPE_NAMES: ReadonlySet<string> = new Set([
  "date",
  "date32",
  "datetime",
  "datetime2",
  "datetime64",
  "datetimeoffset",
  "smalldatetime",
  "timestamp",
  "timestamptz",
]);

/**
 * The declared types that ARE a 64-bit IEEE float, matched on the type's own first word.
 *
 * A JavaScript number is a 64-bit IEEE float, and `String()` of one is the shortest decimal
 * that parses back to the same double — so a value read out of a column of this width is
 * the value the row holds, and the decimal sent back is read by the engine as that same
 * value. MEASURED 2026-09-18: PostgreSQL 16.15 `double precision` and MySQL 8.4.11 `DOUBLE`
 * both answered one row for every one of 0.30000000000000004, 1.5, 0.1, 1e-7 and 1e21 sent
 * back through this hook's own bound-parameter path.
 *
 * The spellings are the engines' own, which is what `QueryResult.columnTypes` carries:
 * `double precision` (`pg`, first word `double`), `double` (mysql2, mssql's `float` is NOT
 * here — see below), `Float64` (ClickHouse), `BINARY_DOUBLE` (oracledb, uppercase),
 * `double` (Trino, DuckDB).
 *
 * TWO WORDS ARE DELIBERATELY ABSENT, because one word means two widths across engines and
 * a key that is refused is only inconvenient while a key that is waved through is wrong:
 *
 * - `float`. MySQL's `FLOAT` is 32 bits; T-SQL's `float` is 64. MEASURED on MySQL 8.4.11,
 *   `zz40_f(k FLOAT)` holding 0.1: mysql2's text protocol hands over the double 0.1, and
 *   `WHERE k IN (0.1)` matched NOTHING — the row holds the 32-bit 0.100000001490116…, and
 *   0.1 is a different number to it. So `float` falls through to that hook's digit rule.
 * - `real`. PostgreSQL's and Trino's are 32 bits; SQLite's is 64. (PostgreSQL happens to
 *   match a `real` key anyway — it infers the parameter's type from the column and re-reads
 *   the decimal at 32-bit precision — but that is `pg`'s doing, not the value's.)
 *
 * Which is why the two words are absent from THIS set and not from the rule: on an engine
 * that has no 32-bit float at all they mean 64 bits and nothing else, and that is what
 * the sqlite and libsql modules state with `float64TypeNames: "all"`, for those engines only.
 */
export const FLOAT64_TYPE_NAMES: ReadonlySet<string> = new Set(["double", "float8", "float64", "binary_double"]);

/**
 * The declared types that are an EXACT DECIMAL, matched on the type's own first word.
 *
 * A column of one of these holds a decimal of up to 38 digits, and the two drivers that
 * reach this hook with one hand it over as a JavaScript number — a 64-bit IEEE float, which
 * carries 15 to 17 significant decimal digits. So the number in front of the user is a
 * RENDERING of the row's value, the same way a `Date` string is a rendering of an instant,
 * and the decimal it prints can be the key of a DIFFERENT row.
 *
 * MEASURED 2026-09-19 through this hook's own path, on Oracle AI Database 26ai Free
 * 23.26.3.0.0 and SQL Server 2022 CU27 (16.0.4295.3):
 *  - Oracle `zz969_frac(id NUMBER(20,4) PRIMARY KEY)` holding 1234567890123456.7891 and
 *    1234567890123456.8: oracledb hands BOTH rows over as 1234567890123456.8. With only
 *    the first row edited, the check asked the engine, Oracle answered ONE group holding
 *    ONE row, `UPDATE ... WHERE "ID" = :2` went out against `the-neighbour` — the row
 *    nobody edited — and the apply reported "Changes Applied".
 *  - Oracle `NUMBER` with no precision holding .10000000000000000001 and .1: both arrive as
 *    the ONE-digit 0.1, and the UPDATE lands on the row holding .1. So the wrong-row write
 *    happens at one printed digit as readily as at seventeen, which is why no count of
 *    digits can separate these from a value that is its own, and the declaration decides.
 *  - SQL Server `zz969_num(id decimal(20,4) PRIMARY KEY, cash money)` over the same pair:
 *    both rows arrive as 1234567890123456.8, and `922337203685477.5807` in the `money`
 *    column arrives as 922337203685477.6. tedious computes every `decimal`/`numeric` as
 *    `value / 10^scale` and every `money` as an int64 over 10000 (`readNumeric`,
 *    `readMoney`), so the rounding is the driver's arithmetic, not one column's width.
 *    Sent back, that one key UPDATEd BOTH rows: `float` outranks `decimal` in T-SQL, so the
 *    column is widened to meet the parameter `mssql` infers for a fractional number, and
 *    both rows are equal to it. Driven through this hook the count check SAW those two
 *    groups and refused, so SQL Server was not writing a wrong row — it was writing the
 *    right one wherever a rounding happened to be unique, and this rule costs it those
 *    writes. They go anyway: which of the two cases is in front of the user cannot be read
 *    off the value, the safety rests on a type `mssql` infers rather than on anything the
 *    engine promises, and the closed side is the safe side here as in the two sets above.
 *
 * The words are the engines' own, which is what `QueryResult.columnTypes` carries. Oracle
 * spells all of `NUMBER`, `DECIMAL`, `NUMERIC`, `DEC` and `FLOAT` as `NUMBER` in
 * `dbTypeName` — measured on the five declarations in one table — so the one word covers
 * that engine. T-SQL reports `decimal`, `numeric`, `money` and `smallmoney` as themselves.
 *
 * A driver that hands the same column back as a STRING is untouched by this: the string is
 * its own digits and takes the string path in that hook. MEASURED the same day — PostgreSQL 16.15
 * `numeric(20,4)` over `pg`, MySQL 8.4.11 `DECIMAL(20,4)` over mysql2's text AND binary
 * protocols, and DuckDB 1.5.5 `DECIMAL(20,4)` through the `getRowObjectsJson()` the
 * provider reads — all four hand "1234567890123456.7891" over as text, exact to the digit.
 *
 * AND THE COST IS REAL, so it is written down rather than implied: a fractional key that
 * happens to be exactly what the row holds is refused with the rest. MEASURED on the same
 * Oracle, `zz969_ten(id NUMBER(20,4))` holding 123456.7891 and 123456.7892 — two values a
 * double carries exactly — used to be asked about and written to its own row, and now is
 * not. It is refused because nothing in front of the editor tells it apart from the case
 * above: the same column, the same driver, the same shape of decimal, and the difference
 * lives only in digits that never left the engine. A key the editor cannot tell apart from
 * a wrong-row write is the one that hook has always closed, and its whole-number rule
 * refuses a `bigint` past 2^53 for exactly the same reason.
 */
export const EXACT_DECIMAL_TYPE_NAMES: ReadonlySet<string> = new Set([
  "number",
  "numeric",
  "decimal",
  "dec",
  "money",
  "smallmoney",
]);

// The SQLite storage-class facts: what the inline edit reads on the two engines whose type
// words name an AFFINITY and not a storage width, SQLite and libSQL, which embeds it. Both
// modules import each fact by name; a sentence that holds for one of them only stays in
// that engine's module beside the reference.

/**
 * No declared type is an INSTANT, so the words that name one everywhere else state nothing
 * here.
 *
 * SQLITE HAS NO DATE TYPE. A column declared `DATE`, `DATETIME` or `TIMESTAMP` picks no
 * storage class from its declaration: it holds the TEXT somebody put in it, or the integer,
 * and `sqlite3_column_decltype` reports the declaration back verbatim beside it. So the
 * value the driver hands over IS the value the row holds, it is its own identity, and it
 * matches when it is sent back — which is the opposite of what the word means everywhere
 * else, where the driver hands over a `Date` or a rendering of one.
 *
 * MEASURED 2026-09-19 on bun:sqlite (Bun 1.4.0) and on libSQL server v0.24.33 over its HTTP
 * pipeline, `zz_<decl>(k <decl> PRIMARY KEY, note TEXT)` for each of `DATE`, `DATETIME` and
 * `TIMESTAMP` against `'2024-01-15'`, `'2026-01-01 10:00:00.123'`, the ISO text
 * `'2026-01-01T07:00:00.123Z'` and the integer epoch 1705276800 — three declarations by
 * four value shapes by two engines, 24 combinations. Every one reported the declaration
 * back verbatim, answered `text` (or `integer`, for the epoch) to `typeof()`, handed the
 * value back unchanged, matched ONE group holding ONE row for `WHERE k IN (?)`, and changed
 * exactly one row on the `UPDATE` that followed.
 *
 * NO OTHER DIALECT but SQLite and libSQL states this, and the closed side is the safe side
 * here as everywhere else in the inline edit. MEASURED the same day: PostgreSQL 16.15
 * `zz_m1_ts(ts_id timestamp PRIMARY KEY)` holding 10:00:00.123456 and .654321 answered ZERO
 * rows for the `'2026-01-01T07:00:00.123Z'` the browser holds and zero for
 * `'2026-01-01 10:00:00.123'`, with both rows still in the table; MySQL 8.4.11
 * `zz_m1_dt(d_id DATETIME(6) PRIMARY KEY)` answered zero for both of the same two. Those
 * engines really do store something the value in front of us is only a rendering of, so
 * they keep the refusal.
 *
 * A `Date` is refused on every dialect including these two, because `String(date)` is a
 * rendering whatever holds it: the driver never produces one, so it can only have come
 * from the host application the embeddable shell runs inside.
 */
export const NO_INSTANT_TYPE_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * No declared type is an EXACT DECIMAL: the words that are one elsewhere are an AFFINITY
 * here, not an exact decimal type at all.
 *
 * SQLITE HAS NO DECIMAL TYPE, the way it has no date type (`NO_INSTANT_TYPE_NAMES` above)
 * and no 32-bit float (`EVERY_TYPE_IS_FLOAT64` below). A column declared `DECIMAL(20,4)` or
 * `NUMERIC(20,4)` takes NUMERIC affinity and stores an integer or an 8-byte double — so
 * what the driver hands over IS the value the row holds, and "the driver rounded it to fit"
 * would be false about it.
 *
 * MEASURED 2026-09-19 on bun:sqlite (Bun 1.4.0), `zz(k DECIMAL(20,4), n NUMERIC(20,4))`:
 * `pragma_table_info` reports both declarations back verbatim, `typeof()` answers `real`
 * for both, 1234567890123456.7891 comes back as the double 1234567890123456.8 — which is
 * exactly what the file now holds, not a rounding of it — and `WHERE k = 1234567890123456.8`
 * matched ONE row, its own.
 */
export const NO_EXACT_DECIMAL_TYPE_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * Only ONE float width exists, so every declaration states it.
 *
 * SQLite has no 32-bit float: `REAL`, `FLOAT`, `DOUBLE` and `DOUBLE PRECISION` are four
 * spellings of one storage class, 8 bytes of IEEE double, which is exactly as wide as the
 * JavaScript number in front of us. So on this dialect the declaration DOES say the
 * width, and the refusal's sentence — "nothing here says the column holds it as a 64-bit
 * float" — is false about it.
 *
 * MEASURED 2026-09-18 through the real provider path, on bun:sqlite (Bun 1.4.0) and on
 * libSQL server v0.24.33 over its HTTP pipeline: `zz_real(r REAL, f FLOAT, d DOUBLE, dp
 * DOUBLE PRECISION)` reported those four decltypes and answered `real` to `typeof()` for
 * every one of them; 0.30000000000000004 was written and read back identical, which no
 * 32-bit column can do; and `WHERE r = 1.5`, `WHERE f = 0.1`, `WHERE d =
 * 0.30000000000000004` and `WHERE dp = 0.1` each matched exactly one row on both.
 *
 * NO OTHER DIALECT but SQLite and libSQL states this, and each was measured rather than
 * assumed. PostgreSQL 16.15: `real` and `float4` are both spelled `real` by `pg`, both
 * `pg_column_size` 4, and `0.1::real::float8` is 0.10000000149011612 — a different number
 * to the double 0.1. MySQL 8.4.11: one row holding 0.1 in a `FLOAT` and a `DOUBLE` answered
 * `f = 0.1` FALSE and `d = 0.1` TRUE. DuckDB: `REAL` and `FLOAT` are one 32-bit type, handed
 * over as 0.10000000149011612, and `r::DOUBLE = 0.1` is false. Trino was not reachable to
 * measure, so it keeps the refusal — the closed side is the safe side, which is what this
 * rule already chose.
 *
 * And "all" rather than the words `real` and `float`: whatever a column is called, a
 * fractional value in it is the 8-byte double the file holds, so it is its own identity and
 * the length rule - which exists to catch the printed form of a 32-bit float - has nothing
 * to catch.
 *
 * MEASURED 2026-09-19 on bun:sqlite (Bun 1.4.0), one row per declaration: `DATE` holding
 * `julianday('2024-01-15 06:00:00')` (2460324.75, `typeof` real), `REAL`, `INTEGER`, `TEXT`,
 * `BLOB`, no declaration at all, and `NUMERIC` holding 0.30000000000000004. Every one came
 * back as the value the file holds and `WHERE k = <value>` matched ONE row, its own.
 *
 * Reading only the words `real` and `float` refused the rest of them: a `DATE` column
 * holding a julian day is nine digits, which the length rule reads as "could be a 32-bit
 * float", and the sentence it showed was the one this rule exists to say is false on SQLite.
 */
export const EVERY_TYPE_IS_FLOAT64 = "all" as const;

/**
 * One declared type in lower case with its wrappers off.
 *
 * ClickHouse spells a nullable or dictionary-encoded column by WRAPPING the real type —
 * `Nullable(DateTime64(6, 'UTC'))`, `LowCardinality(Nullable(String))` — so the wrappers
 * come off before anything else is read.
 */
export function unwrappedType(declaredType: string): string {
  let name = declaredType.trim().toLowerCase();
  for (;;) {
    // Each turn strips a whole `wrapper(` and its `)`, so the name shortens every time and
    // this cannot spin on a type it fails to unwrap.
    const wrapper = /^(?:nullable|lowcardinality)\((.*)\)$/.exec(name);
    if (wrapper === null) break;
    name = wrapper[1].trim();
  }
  return name;
}

/**
 * The first word of an unwrapped declared type, its parameters off: `DateTime64(6, 'UTC')`
 * is `datetime64`, Trino's `timestamp(3) with time zone` is `timestamp`, and `character
 * varying` is `character`, which is in no set here.
 */
export function firstWord(name: string): string {
  return name.split("(")[0].trim().split(/\s+/)[0];
}

// The result export's building blocks: the tables an engine with nothing special to say
// imports by name, and the patterns a declared type is read with. Each is today's value
// in `src/lib/export/result-export.ts`, which reads its own copy until its tables become
// reads of each engine's export spec.

/**
 * How each dialect spells the inferred kinds.
 *
 * The generic set is not portable, and the statement is meant to be run against the
 * engine it was read from: Oracle has no `TEXT` and no `BOOLEAN` before 23c, SQL
 * Server has no `BOOLEAN` at all, and a bare `NUMERIC` on MySQL is `DECIMAL(10,0)` —
 * which silently truncates every decimal it was chosen for. Only the dialects that
 * disagree with the standard spelling appear here; the rest fall through to it,
 * including SQLite, whose column types are advisory affinities anyway.
 */
export const STANDARD_DDL_TYPES: Readonly<Record<InferredKind, string>> = {
  text: "TEXT",
  integer: "BIGINT",
  numeric: "DOUBLE PRECISION",
  boolean: "BOOLEAN",
  timestamp: "TIMESTAMP",
  // `BLOB` is the standard spelling and MySQL, SQLite, Oracle and Cassandra all take
  // it verbatim, so the four that would otherwise need a row here do not get one.
  binary: "BLOB",
};

/** No bare name is written through verbatim: every one is re-spelled from its family. */
export const NOTHING_STANDS_ALONE: readonly string[] = [];

/** No bare name is narrowed below the value the driver hands back, so none is re-spelled. */
export const NO_BARE_SPELLING: Readonly<Record<string, string>> = {};

/** NaN and the infinities written as NULL, by every dialect that cannot store them or was not replayed. */
export const NULL_NON_FINITE: Readonly<Record<NonFiniteWord, string>> = {
  NaN: "NULL",
  Infinity: "NULL",
  "-Infinity": "NULL",
};

/**
 * NaN and the infinities as the quoted words, which the engine reads back into a float column.
 *
 * Replayed into the engine (2026-10-04): PostgreSQL 18.6 and DuckDB read the quoted words into `real`,
 * `double precision`, `DOUBLE` and `FLOAT` (PostgreSQL also into `timestamptz`, whose
 * infinities are quoted text anyway).
 */
export const QUOTED_WORD_NON_FINITE: Readonly<Record<NonFiniteWord, string>> = {
  NaN: "'NaN'",
  Infinity: "'Infinity'",
  "-Infinity": "'-Infinity'",
};

/**
 * The family a BARE declared type belongs to, for the names that cannot stand alone.
 *
 * The four biggest providers declare a bare base name — `varchar`, `decimal`,
 * `VARCHAR2`, `nvarchar`, `varbinary` — because a length or a precision cannot be
 * recovered from the wire, and `src/lib/db/providers/sql/column-types.ts` says why it
 * must not be guessed at: a MySQL `varchar(40)` reports `columnLength` 160 under
 * utf8mb4 and 120 under utf8mb3, `mssql` reports 65535 as its sentinel for
 * `varchar(MAX)`, and Oracle reports precision 0 for `COUNT(*)` and scale -127 for
 * `1/3`. So the length is genuinely gone, and a bare name carries exactly as much
 * information as one of the inferred kinds above — which is what this maps it to, so
 * that the dialect tables spell it the same way they spell an inferred column.
 *
 * Measured by replaying the generated `CREATE TABLE` into the engine it was read from:
 *
 *   mysql:  ERROR 1064 … near ',\n  `body` text,'   (the bare `varchar` before it)
 *   oracle: ORA-00906: missing left parenthesis      (the bare VARCHAR2)
 *   mssql:  parses, then INFORMATION_SCHEMA.COLUMNS reports nvarchar length 1,
 *           varchar length 1, varbinary length 1, decimal precision 18 scale 0
 *
 * The silent narrowing is the worst of the three: the file replays and the data is
 * truncated. Two more of the same class were measured and are covered here — `CREATE
 * TABLE t (c decimal)` is `decimal(10,0)` on MySQL and `NUMBER(*,0)` on Oracle, both
 * of which round every decimal the column existed for, and `character` is
 * `character(1)` even on Postgres.
 *
 * Only the four families whose parameters the wire drops are listed. `bit` is measured
 * to narrow to `bit(1)` on Postgres and MySQL and is deliberately NOT here: `pg` hands
 * a bit string back as `"1010"` and `mysql2` hands it back as a Buffer, so the two
 * drivers need different families for the same name, and completing it to one of them
 * would break the INSERT this same export writes for the other.
 */
export const BARE_TYPE_FAMILY: Readonly<Record<string, InferredKind>> = {
  "character varying": "text",
  varchar: "text",
  varchar2: "text",
  nvarchar: "text",
  nvarchar2: "text",
  character: "text",
  char: "text",
  nchar: "text",
  text: "text",
  ntext: "text",
  tinytext: "text",
  mediumtext: "text",
  longtext: "text",
  clob: "text",
  nclob: "text",
  enum: "text",
  set: "text",
  uniqueidentifier: "text",
  rowid: "text",
  binary: "binary",
  varbinary: "binary",
  raw: "binary",
  blob: "binary",
  tinyblob: "binary",
  mediumblob: "binary",
  longblob: "binary",
  bytea: "binary",
  image: "binary",
  numeric: "numeric",
  decimal: "numeric",
  number: "numeric",
  binary_double: "numeric",
  binary_float: "numeric",
  money: "numeric",
  timestamp: "timestamp",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  datetime: "timestamp",
  datetime2: "timestamp",
  smalldatetime: "timestamp",
  datetimeoffset: "timestamp",
  year: "integer",
};

/**
 * A declared type is kept verbatim, so every candidate stands alone: each name of
 * `BARE_TYPE_FAMILY` (above) but the four the affinity narrows.
 *
 * SQLite's `enum`, `uniqueidentifier` and `rowid`. SQLite parses any type name, so
 * the narrowing is in the AFFINITY: these three match none of its keywords, so the
 * column is NUMERIC and `INSERT INTO p (c) VALUES ('007')` reads back as the integer
 * 7 (measured), where the same insert into `varchar2` reads back as the text `007`.
 * `set` is not in SQLite's grammar as a type name at all (`near "set": syntax
 * error`).
 *
 * Every candidate name but those four: SQLite keeps a declared type as the exact string
 * it was given (`pragma_table_info` answers `varchar2` for `varchar2`), so the spelling
 * the source engine used is the one that survives.
 */
export const VERBATIM_DECLARED_TYPES_STAND_ALONE: readonly string[] = [
  "character varying",
  "varchar",
  "varchar2",
  "nvarchar",
  "nvarchar2",
  "character",
  "char",
  "nchar",
  "text",
  "ntext",
  "tinytext",
  "mediumtext",
  "longtext",
  "clob",
  "nclob",
  "binary",
  "varbinary",
  "raw",
  "blob",
  "tinyblob",
  "mediumblob",
  "longblob",
  "bytea",
  "image",
  "numeric",
  "decimal",
  "number",
  "binary_double",
  "binary_float",
  "money",
  "timestamp",
  "timestamp without time zone",
  "timestamp with time zone",
  "datetime",
  "datetime2",
  "smalldatetime",
  "datetimeoffset",
  "year",
];

/**
 * A declared type that holds a binary float, spelled the way the providers report it:
 * PostgreSQL's `real` / `double precision`, DuckDB's `FLOAT` / `DOUBLE`, SQLite's
 * declared `REAL`, Oracle's `BINARY_DOUBLE` / `BINARY_FLOAT`, and `float4`/`float8`.
 */
export const FLOAT_TYPE = /^(double( precision)?|real|float\d*|binary_(double|float))$/i;

/**
 * The exact numeric types that can hold an infinity, as the providers spell them: PostgreSQL's
 * `numeric` (14 and later), Snowflake's `DECFLOAT`, and the `decimal`/`number` spellings, with or
 * without a precision. Used only by the CSV writer, which lets `-Infinity` through its formula
 * guard in a numeric column (`toCsv`).
 */
export const EXACT_NUMERIC_TYPE = /^(numeric|decimal|number|decfloat)(\s*\(\s*\d+\s*(,\s*-?\d+\s*)?\))?$/i;

/** ClickHouse's wrappers, which change nothing about whether the column holds numbers. */
export const CLICKHOUSE_WRAPPER = /^\s*(?:Nullable|LowCardinality)\((.*)\)\s*$/;

/** The patterns every engine reads a declared type with: the four above, shared by name. */
export const STANDARD_TYPE_VOCABULARY: ExportTypeVocabulary = {
  bareTypeFamily: BARE_TYPE_FAMILY,
  floatType: FLOAT_TYPE,
  exactNumericType: EXACT_NUMERIC_TYPE,
  numericWrapper: CLICKHOUSE_WRAPPER,
};
