"use client";

import { useCallback, useState } from "react";
import type { DatabaseConnection, QueryResult, QueryTab } from "@/lib/types";
import type { CellChange } from "@/components/ResultsGrid";
import { useToast } from "@/hooks/use-toast";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { resolveUpdateTarget, selectsPlainColumn } from "@/lib/sql/update-target";
import { positionalPlaceholder, quoteLiteral } from "@/lib/sql/values";
import { appFetch } from "@/lib/config/base-path";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { asBytes } from "@/lib/export/binary";

interface UseInlineEditingParams {
  activeConnection: DatabaseConnection | null;
  currentTab: QueryTab;
  /**
   * Whether a transaction is open on this connection.
   *
   * The UPDATEs already follow it: `executeQuery` sends them to `/api/db/transaction`,
   * which holds the one reserved connection the transaction lives on. The key check has to
   * follow it too, or it asks a different pooled connection and cannot see anything the
   * transaction has not committed. Measured: a row INSERTed inside an open transaction is
   * on screen, invisible to the check, and the apply refuses for ever with "no longer in
   * the table" - a sentence that is false, about rows the user is looking at.
   */
  transactionActive?: boolean;
  /**
   * `useQueryExecution`'s `executeQuery`. `handleApplyChanges` awaits it between
   * rows and passes its execution options, so the signature carries both.
   *
   * It resolves to whether the statement landed. Only an explicit `false` is read as
   * a failure here: an implementation that reports nothing keeps the behaviour it had
   * before the outcome existed, so a caller passing a void-returning function is not
   * silently told every row failed.
   */
  executeQuery: (
    sql: string,
    tabId?: string,
    isExplain?: boolean,
    options?: { skipSafety?: boolean; params?: unknown[] },
  ) => void | Promise<boolean | void>;
}

/** `1 row` / `2 rows`, because a count the user reads should read like one. */
const rows = (count: number) => `${count} row${count === 1 ? "" : "s"}`;

/** The same, for the statements a run is made of. */
const updates = (count: number) => `${count} UPDATE statement${count === 1 ? "" : "s"}`;

/**
 * What the ENGINE said this key column is, in the one distinction that decides whether a
 * value read out of it can be sent back as the row that holds it.
 *
 * - `date-time`: a column declared as a date or a timestamp.
 * - `float64`: a column declared as a 64-bit IEEE float, the one width a JavaScript number
 *   is. A value read out of such a column IS the value the row holds, exactly.
 * - `decimal`: a column declared as an EXACT DECIMAL — Oracle's `NUMBER`, T-SQL's
 *   `decimal`, `numeric` and `money` — which holds more digits than a double carries. A
 *   number read out of one is a ROUNDING of the value the row holds, not that value.
 * - `declared`: a column declared as something else. Its values are what they look like.
 * - `undeclared`: the result carried no type for this column at all.
 */
type KeyColumnKind = "date-time" | "float64" | "decimal" | "declared" | "undeclared";

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
 * and are read only on the dialects where they mean an instant. See
 * `NO_INSTANT_TYPE_DIALECTS` below, which is the same shape, and the same reason, as
 * `FLOAT64_ONLY_DIALECTS`.
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
 * A date or a timestamp is the opposite: those same two drivers hand back a JavaScript
 * `Date`, and that is the value this whole check exists for.
 */
const INSTANT_TYPE_NAMES: ReadonlySet<string> = new Set([
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
 * The engines with NO instant type at all, where those same words therefore state nothing.
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
 * `libsql` is here for the reason it is in `FLOAT64_ONLY_DIALECTS`: it embeds the same
 * engine and reports the same declarations — measured over the wire rather than reasoned
 * from that, and identical to bun:sqlite on all twelve of its combinations.
 *
 * NO OTHER DIALECT IS, and the closed side is the safe side here as everywhere else in this
 * file. MEASURED the same day: PostgreSQL 16.15 `zz_m1_ts(ts_id timestamp PRIMARY KEY)`
 * holding 10:00:00.123456 and .654321 answered ZERO rows for the
 * `'2026-01-01T07:00:00.123Z'` the browser holds and zero for `'2026-01-01 10:00:00.123'`,
 * with both rows still in the table; MySQL 8.4.11 `zz_m1_dt(d_id DATETIME(6) PRIMARY KEY)`
 * answered zero for both of the same two. Those engines really do store something the value
 * in front of us is only a rendering of, so they keep the refusal.
 *
 * A `Date` is refused on every dialect including these two, because `String(date)` is a
 * rendering whatever holds it: neither driver ever produces one, so it can only have come
 * from the host application the embeddable shell runs inside.
 */
const NO_INSTANT_TYPE_DIALECTS: ReadonlySet<DatabaseConnection["type"]> = new Set(["sqlite", "libsql"]);

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
 *   0.1 is a different number to it. So `float` falls through to the digit rule below.
 * - `real`. PostgreSQL's and Trino's are 32 bits; SQLite's is 64. (PostgreSQL happens to
 *   match a `real` key anyway — it infers the parameter's type from the column and re-reads
 *   the decimal at 32-bit precision — but that is `pg`'s doing, not the value's.)
 *
 * Which is why the two words are absent from THIS set and not from the rule: on an engine
 * that has no 32-bit float at all they mean 64 bits and nothing else, and that is what
 * `FLOAT64_ONLY_NAMES` below adds back, for those engines only.
 */
const FLOAT64_TYPE_NAMES: ReadonlySet<string> = new Set(["double", "float8", "float64", "binary_double"]);

/**
 * The engines with only ONE float width, and the words that therefore state it there.
 *
 * SQLite has no 32-bit float: `REAL`, `FLOAT`, `DOUBLE` and `DOUBLE PRECISION` are four
 * spellings of one storage class, 8 bytes of IEEE double, which is exactly as wide as the
 * JavaScript number in front of us. So on these dialects the declaration DOES say the
 * width, and the refusal's sentence — "nothing here says the column holds it as a 64-bit
 * float" — is false about them.
 *
 * MEASURED 2026-09-18 through the real provider path, on bun:sqlite (Bun 1.4.0) and on
 * libSQL server v0.24.33 over its HTTP pipeline: `zz_real(r REAL, f FLOAT, d DOUBLE, dp
 * DOUBLE PRECISION)` reported those four decltypes and answered `real` to `typeof()` for
 * every one of them; 0.30000000000000004 was written and read back identical, which no
 * 32-bit column can do; and `WHERE r = 1.5`, `WHERE f = 0.1`, `WHERE d =
 * 0.30000000000000004` and `WHERE dp = 0.1` each matched exactly one row on both.
 *
 * `libsql` is here for the reason `sqlite` is: it embeds the same engine and reports the
 * same `sqlite3_column_decltype` declarations.
 *
 * NO OTHER DIALECT IS, and each was measured rather than assumed. PostgreSQL 16.15:
 * `real` and `float4` are both spelled `real` by `pg`, both `pg_column_size` 4, and
 * `0.1::real::float8` is 0.10000000149011612 — a different number to the double 0.1.
 * MySQL 8.4.11: one row holding 0.1 in a `FLOAT` and a `DOUBLE` answered `f = 0.1` FALSE
 * and `d = 0.1` TRUE. DuckDB: `REAL` and `FLOAT` are one 32-bit type, handed over as
 * 0.10000000149011612, and `r::DOUBLE = 0.1` is false. Trino was not reachable to measure,
 * so it keeps the refusal — the closed side is the safe side, which is what this rule
 * already chose.
 */
const FLOAT64_ONLY_DIALECTS: ReadonlySet<DatabaseConnection["type"]> = new Set(["sqlite", "libsql"]);

/** The words that mean 64 bits ONLY on the dialects above, and 32 elsewhere. */
const FLOAT64_ONLY_NAMES: ReadonlySet<string> = new Set(["real", "float"]);

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
 * its own digits and takes the string path above. MEASURED the same day — PostgreSQL 16.15
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
 * a wrong-row write is the one this file has always closed, and the whole-number rule two
 * screens down refuses a `bigint` past 2^53 for exactly the same reason.
 */
const EXACT_DECIMAL_TYPE_NAMES: ReadonlySet<string> = new Set([
  "number",
  "numeric",
  "decimal",
  "dec",
  "money",
  "smallmoney",
]);

/**
 * The engines where those words are an AFFINITY and not an exact decimal type at all.
 *
 * SQLITE HAS NO DECIMAL TYPE, the way it has no date type (`NO_INSTANT_TYPE_DIALECTS`) and
 * no 32-bit float (`FLOAT64_ONLY_DIALECTS`). A column declared `DECIMAL(20,4)` or
 * `NUMERIC(20,4)` takes NUMERIC affinity and stores an integer or an 8-byte double — so
 * what the driver hands over IS the value the row holds, and "the driver rounded it to fit"
 * would be false about it.
 *
 * MEASURED 2026-09-19 on bun:sqlite (Bun 1.4.0), `zz(k DECIMAL(20,4), n NUMERIC(20,4))`:
 * `pragma_table_info` reports both declarations back verbatim, `typeof()` answers `real`
 * for both, 1234567890123456.7891 comes back as the double 1234567890123456.8 — which is
 * exactly what the file now holds, not a rounding of it — and `WHERE k = 1234567890123456.8`
 * matched ONE row, its own.
 *
 * `libsql` is here for the reason it is in the other two sets: it embeds the same engine and
 * reports the same `sqlite3_column_decltype` declarations.
 */
const NO_EXACT_DECIMAL_DIALECTS: ReadonlySet<DatabaseConnection["type"]> = new Set(["sqlite", "libsql"]);

/**
 * Reads one declared type down to its first word.
 *
 * ClickHouse spells a nullable or dictionary-encoded column by WRAPPING the real type —
 * `Nullable(DateTime64(6, 'UTC'))`, `LowCardinality(Nullable(String))` — so the wrappers
 * come off first, and only then the parameters: `DateTime64(6, 'UTC')` is `datetime64`,
 * Trino's `timestamp(3) with time zone` is `timestamp`, and `character varying` is
 * `character`, which is in no set here.
 *
 * The DIALECT is read alongside the word, because one word is two widths across engines:
 * `REAL` is 64 bits on SQLite and 32 on PostgreSQL, and the same declaration therefore
 * settles the question on one and settles nothing on the other.
 */
function keyColumnKind(declaredType: string | undefined, dialect: DatabaseConnection["type"]): KeyColumnKind {
  if (declaredType === undefined) return "undeclared";
  let name = declaredType.trim().toLowerCase();
  for (;;) {
    // Each turn strips a whole `wrapper(` and its `)`, so the name shortens every time and
    // this cannot spin on a type it fails to unwrap.
    const wrapper = /^(?:nullable|lowcardinality)\((.*)\)$/.exec(name);
    if (wrapper === null) break;
    name = wrapper[1].trim();
  }
  const first = name.split("(")[0].trim().split(/\s+/)[0];
  if (!NO_INSTANT_TYPE_DIALECTS.has(dialect) && INSTANT_TYPE_NAMES.has(first)) return "date-time";
  if (FLOAT64_TYPE_NAMES.has(first)) return "float64";
  if (!NO_EXACT_DECIMAL_DIALECTS.has(dialect) && EXACT_DECIMAL_TYPE_NAMES.has(first)) return "decimal";
  return FLOAT64_ONLY_DIALECTS.has(dialect) && FLOAT64_ONLY_NAMES.has(first) ? "float64" : "declared";
}

/**
 * The one refused kind whose reason is not that the value is mangled on the way out.
 *
 * Every other kind here — binary data, a date, a document — is measurably a different value
 * by the time `String()` has had it. A fractional number is not: its decimal is exact, and
 * what is missing is any statement of the WIDTH the engine will read it back at. Saying it
 * "does not reach the table as the row holds it" was false about it — measured on
 * PostgreSQL 16.15, 0.30000000000000004 in a `double precision` column reaches the table
 * exactly, and `WHERE f_id = 0.30000000000000004` found the row — so it gets its own reason.
 */
const FRACTIONAL = "a fractional number";

/**
 * The fractional key that was mangled on the way out after all.
 *
 * `FRACTIONAL` is about a WIDTH nothing states: the decimal is the row's own and what is
 * missing is any statement of how the engine will read it back. This one is the opposite
 * fact — the column says exactly what it is, an exact decimal, and says at the same time
 * that the number in front of the user is a rounding of digits it can hold and a double
 * cannot. Two different reasons, so two different sentences: see `EXACT_DECIMAL_TYPE_NAMES`
 * for what each engine hands over.
 */
const ROUNDED_DECIMAL = "a fractional number the driver rounded to fit";

/**
 * The most significant decimal digits any 32-bit IEEE float needs to round-trip — nine.
 *
 * So a decimal spelling LONGER than this cannot be the printed form of a 32-bit float, and
 * the value in front of us can only have come from a 64-bit one. That is the whole of the
 * inference below, and it is a bound rather than a guess: `String()` of a JavaScript number
 * is the SHORTEST decimal that parses back to it, and every 32-bit float has a shortest
 * form of nine digits or fewer.
 */
const FLOAT32_MAX_DIGITS = 9;

/** How many significant digits `String(value)` spends — `0.1` one, `100.5` four. */
function significantDigits(value: number): number {
  const mantissa = Math.abs(value).toString().split("e")[0];
  return mantissa.replace(".", "").replace(/^0+/, "").length;
}

/**
 * Why a fractional number cannot be sent back as the row that holds it — or `null` when it
 * can.
 *
 * The decimal `String()` writes always parses back to the same double — that is what
 * "shortest round-trip" means — so the only question is at what precision the ENGINE reads
 * it. Where it reads at 64 bits the answer is the same number and the row is found; where
 * the column is narrower, the number we hold is a rendering of a value the engine will not
 * agree with, and asking about it matches nothing.
 *
 * MEASURED 2026-09-18, and both halves are needed:
 *  - The declaration settles it where there is one. PostgreSQL 16.15 `double precision` and
 *    MySQL 8.4.11 `DOUBLE` matched every fractional key put to them, 1.5 and
 *    0.30000000000000004 alike.
 *  - Where there is none, the LENGTH of the decimal still settles half of it. MySQL's
 *    binary protocol hands a `FLOAT` over as the 17-digit 0.10000000149011612, and sending
 *    that back matched; its text protocol hands the same column over as 0.1, and sending
 *    THAT back matched nothing. Nine digits or fewer is a spelling a 32-bit column can
 *    produce, so it is refused; more than nine is one no 32-bit column can produce.
 *
 * Fail closed, in other words: allowed only where the value is provably the one the row
 * holds. A `numeric`/`DECIMAL` over `pg` or mysql2 never reaches here at all — both hand
 * those back as STRINGS, exactly so nothing rounds them — and a driver that hands one back
 * as a NUMBER, which oracledb and tedious both do, is the first case below.
 */
function describeFraction(value: number, column: KeyColumnKind): string | null {
  // An exact decimal is settled by the DECLARATION and by nothing else. The digits printed
  // here are the driver's rounding of the row's, and one row's rounding is another row's
  // key: Oracle handed .10000000000000000001 over as the one-digit 0.1 and
  // 1234567890123456.7891 over as the seventeen-digit 1234567890123456.8, and wrote to the
  // neighbour both times. No length rule separates those two from a decimal that is its
  // own, which is why this asks the column and not the number.
  if (column === "decimal") return ROUNDED_DECIMAL;
  return column === "float64" || significantDigits(value) > FLOAT32_MAX_DIGITS ? null : FRACTIONAL;
}

/**
 * Whether a string is EXACTLY what a `Date` turns into on its way through JSON.
 *
 * `JSON.stringify` calls `Date.prototype.toJSON`, which is `toISOString`, which always
 * writes four-to-six year digits, always three fractional digits and always a literal `Z`
 * — so `2026-01-01T07:00:00.123Z` is that and `2024-01-15T10:30:00Z` (no fraction) is not,
 * nor is `2024-01-15`, nor `2024-01-15 10:30:00`. The re-serialisation is what makes it
 * exact rather than approximate: a string in the right shape that no `Date` would ever
 * produce, `2026-02-30T00:00:00.000Z`, comes back as `2026-03-02T...` and is let through.
 *
 * This is the LAST resort and not the rule. It runs only where the result declared no type
 * for the key column at all, because a shape is evidence about a value and a declaration is
 * a fact about the column: a `text` column really holding `2026-01-01T07:00:00.123Z` is
 * settled by its declaration and never reaches this.
 */
function isSerializedDate(value: string): boolean {
  if (!/^[+-]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Why this key value cannot be sent back to the engine as the row that holds it — or
 * `null` when it can.
 *
 * Everything downstream of here spells a key ONE way: `typeof key === "number" ? key :
 * String(key)`. That is faithful for text, for a bigint's digits, for `true`/`false` and
 * for an integer a double can hold exactly, and for nothing else.
 *
 * MEASURED, and the reason this exists. A `bytea` on PostgreSQL 16 and a `BINARY(16)` on
 * MySQL 8.4 both reach the grid as a Buffer over the library path and as
 * `{"type":"Buffer","data":[…]}` over the HTTP one, since the response is JSON.
 * `String()` turns the first into its bytes read as text and the second into
 * "[object Object]", and the check below then asked the engine about that:
 * PostgreSQL refused the parameter (`invalid byte sequence for encoding "UTF8": 0x00`),
 * MySQL accepted it and matched nothing — so the apply answered "some of the rows you
 * edited are no longer in the table. Run the query again" about a row that `SELECT
 * count(*)` put at one. The advice is a loop: the same query produces the same Buffer and
 * the same refusal for ever. A `timestamp` is the same defect with a different value —
 * `pg` hands back a Date, which has no microseconds to hand back, and `String(date)` has
 * no fractional seconds at all.
 *
 * So the question is asked HERE, before the engine is asked anything, and the sentence
 * the user gets is about the value in front of them rather than about rows that never
 * moved.
 *
 * An allowlist and not a list of bad shapes: a driver may hand back anything, and a kind
 * nobody anticipated has to fail closed. The kinds are named individually anyway, because
 * "binary data" tells the reader which column to stop keying on and "a value" does not.
 *
 * AND THE VALUE IS NOT THE ONLY WITNESS. A `Date` is only ever a `Date` where this hook
 * runs in-process; the browser reads its rows from `/api/db/query`, which is JSON, and
 * `JSON.stringify(date)` is a STRING. MEASURED 2026-09-18 against PostgreSQL 16.15 and
 * MySQL 8.4.11 through this hook, with the rows put through `JSON.parse(JSON.stringify())`
 * exactly as the route delivers them: a `timestamp`, a `timestamptz` and a `DATETIME(6)`
 * key all arrive as `"2026-01-01T10:00:00.123Z"` — the microseconds gone, and a `Z` on a
 * value PostgreSQL stores with no zone at all — the string was waved through as its own
 * text, the engine WAS asked, it matched nothing, and the user was told "some of the rows
 * you edited are no longer in the table. Run the query again" while `SELECT count(*)`
 * answered 2. So the check reads the column's DECLARED type, which those same results
 * carry beside the rows (`QueryResult.columnTypes`) and which says `timestamp without time
 * zone` / `timestamp with time zone` / `datetime` no matter what shape the value took to
 * get here.
 */
function describeUncarriableKey(value: unknown, column: KeyColumnKind): string | null {
  // `String()` is these values themselves, and a safe integer goes to the driver as the
  // number it is — unless the engine declared the column an instant, in which case what
  // the driver handed over is a rendering of one and not the value the table holds.
  if (typeof value === "string") {
    if (column === "date-time") return "a date and time";
    // No declaration to go on. The shape a `Date` takes through JSON is the one thing left
    // to read, and it is asked exactly, so a text column holding `2024-01-15T10:30:00Z` —
    // or a date, or a timestamp anybody typed — is untouched by it.
    return column === "undeclared" && isSerializedDate(value) ? "a date and time" : null;
  }
  if (typeof value === "bigint" || typeof value === "boolean") return column === "date-time" ? "a date and time" : null;
  if (typeof value === "number") {
    if (column === "date-time") return "a date and time";
    if (Number.isSafeInteger(value)) return null;
    if (!Number.isFinite(value)) return "not a number";
    if (!Number.isInteger(value)) return describeFraction(value, column);
    // Whole, and past the range a double spells every integer in. WHAT THE COLUMN IS
    // decides this one, not how big the number is, and the two halves were measured
    // 2026-09-18 on PostgreSQL 16.15 and MySQL 8.4.11 through this hook's own path:
    //
    //  - A column the result declares 64 bits wide is exactly as wide as the number in
    //    front of us, so 1e21 read out of a `double precision` / `DOUBLE` column IS the
    //    value the row holds, and `String()` of it is the shortest decimal that parses
    //    back to that same double. Both engines answered ONE row for 1e21 and for 1e300
    //    sent back as a bound parameter, and the UPDATE that followed changed that one
    //    row. Refusing it took away work the engine does perfectly — and said something
    //    untrue about the data while doing it: nothing is out of range about a double a
    //    `double precision` column holds exactly.
    //  - An INTEGER column is the opposite: `mysql2` rounds a BIGINT past 2^53, so
    //    9007199254740993 arrives as ...992 — the key of the NEIGHBOURING row, which the
    //    engine would answer about perfectly. Measured on `zz43_big(b_id bigint)` holding
    //    both keys: `WHERE b_id = 9007199254740992` matched one row, the neighbour's.
    //
    // Everything else stays refused, declared or not, because only the declaration says
    // the number was read at a width that holds it: a bigint's digits are past what a
    // double spells, and where no type came with the result there is nothing to read.
    return column === "float64" ? null : "a whole number past the range this editor carries exactly";
  }
  // Both shapes a binary cell arrives in, read by the same function the grid renders it
  // with, so the refusal names what the reader is looking at.
  if (asBytes(value) !== undefined) return "binary data";
  // Not `instanceof`: a Date built in another realm — which is every Date a host
  // application hands the embeddable shell — is still a Date to this.
  if (Object.prototype.toString.call(value) === "[object Date]") return "a date and time";
  return "a value with no text form the engine could match";
}

/** How many of `keys` are unusable in the same way, and which way that is. */
function uncarriableKeys(
  keys: readonly unknown[],
  numbers: boolean,
  column: KeyColumnKind,
): { readonly count: number; readonly what: string } | null {
  const described = keys
    .filter((key) => (typeof key === "number") === numbers)
    .map((key) => describeUncarriableKey(key, column))
    .filter((what): what is string => what !== null);
  const what = described[0];
  // Only the rows carrying the SAME kind are counted: a Buffer and a Date in one apply are
  // two facts, and "2 rows carry binary data" would be false about one of them.
  return what === undefined ? null : { count: described.filter((other) => other === what).length, what };
}

/** What the user is told about such a key: what it is, and what to put in the query instead. */
const uncarriableReason = (keyColumn: string, found: { readonly count: number; readonly what: string }) =>
  `This editor cannot address a row by ${keyColumn} here: in ${rows(found.count)} you edited it is ${found.what}, ` +
  (found.what === FRACTIONAL
    ? "and nothing here says the column holds it as a 64-bit float, so the engine may read that decimal back as a " +
      "different number"
    : found.what === ROUNDED_DECIMAL
      ? "and the column it came out of holds more digits than a 64-bit float carries, so this decimal may be a " +
        "rounding of the row's own — and a rounding matches another row as readily as yours"
      : "which does not reach the table as the row holds it") +
  ". Put a column that identifies a row as text or a whole number in the query and run it again, or edit the SQL " +
  "by hand";

/**
 * Whether the column this editor found actually addresses ONE row per value.
 *
 * The key is a GUESS: the first field called `id` or ending in `_id`. On a result that
 * carries a foreign key and not the table's own key — `SELECT category_id, product_name
 * FROM products` — the guess lands on `category_id`, and the `UPDATE ... WHERE
 * category_id = 5` that follows rewrites every product in that category. Measured on
 * PostgreSQL 16 against the sample data: editing one cell changed FIFTEEN rows, and the
 * apply reported one statement accepted, so nothing on screen said otherwise. Resolving
 * the right TABLE (#881) does not help here; this is the right table and the wrong rows.
 *
 * One grouped count over the DISTINCT keys about to be written answers it for the whole
 * apply: every group has to come back holding exactly one row, and there have to be as
 * many groups as there are distinct keys.
 *
 * Distinct is the first word that matters. Counting the keys per ROW lets the defect
 * straight back through: editing three rows that share `order_id` 87 sends `IN (87, 87,
 * 87)`, the engine counts the three rows behind that one value, three equals three, and
 * all three UPDATEs write to all three rows. Measured on the sample data — `order_items`
 * has a composite key and the guess takes `order_id` — and editing a whole order's lines
 * is the ordinary thing to do, so this needed no coincidence at all.
 *
 * GROUPED is the second, and a plain total would not have caught it: the engine decides
 * what counts as the same key, not JavaScript. MySQL's default collation is
 * case-insensitive, so two rows keyed `abc` and `ABC` are two distinct keys here and one
 * key there. Measured on MySQL 8.4: `IN ('abc', 'ABC')` counts two rows, two equals two,
 * and `WHERE k = 'abc'` then writes to BOTH. Grouped, the engine answers one group of two
 * and the apply refuses. The same argument covers trailing spaces on CHAR columns and
 * every other collation the engine applies and this side cannot see.
 *
 * A row that has gone missing is a different fact and gets a different sentence: fewer
 * rows than keys says nothing about whether the column tells them apart.
 *
 * And the rows ON SCREEN have to answer as many keys as there are of them. Two grid rows
 * that collapse to one key are not told apart by that column either, and this side cannot
 * always see it: `bun:sqlite` hands back the text `'1'` and the integer `1` from the same
 * dynamically typed column, and `mysql2` rounds a BIGINT past 2^53, so `9007199254740993`
 * arrives as `...992` — the same number as its neighbour. Measured on both. In each case
 * the engine was asked about ONE key, answered one group holding one row, and two UPDATEs
 * then went out carrying the raw values the grid still held: a row the user never edited
 * was overwritten and the apply reported success. So the dedup key carries the type as
 * well as the text, and the number of edited rows has to equal the number of distinct keys.
 *
 * Refusing is what a failed check does: this exists to stop a write nobody asked for.
 */
async function keyAddressesOneRow(
  connection: DatabaseConnection,
  table: string,
  keyColumn: string,
  keys: readonly unknown[],
  inTransaction: boolean,
  /** What the result said this key column is — `undefined` where it said nothing. */
  declaredKeyType: string | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // The connection is already in hand — the same object line 433 reads its dialect from —
  // so the width a declared float means is read from the engine that declared it.
  const column = keyColumnKind(declaredKeyType, connection.type);
  // A key with no value cannot be addressed by `=` at all, and `String(null)` would send
  // the text "null" — which an integer column rejects, so the whole apply would fail on a
  // driver error rather than on the reason.
  if (keys.some((key) => key === null || key === undefined)) {
    return { ok: false, reason: `a row you edited has no ${keyColumn}, so it cannot be addressed` };
  }
  // A value whose TEXT is not its identity is refused BEFORE the dedup below, which reads
  // keys as text: two different `bytea` values are "[object Object]" to `String()` and the
  // dedup would collapse them, refusing with "2 rows on screen carry one value between
  // them" — false, because the grid renders each one's own hex and the reader can see two.
  const unspellable = uncarriableKeys(keys, false, column);
  if (unspellable !== null) return { ok: false, reason: uncarriableReason(keyColumn, unspellable) };

  // Safe to read as text: the caller has already refused any key this would throw on, and
  // every key still here is one whose text is itself.
  const distinct = [...new Map(keys.map((key) => [`${typeof key}:${String(key)}`, key])).values()];
  if (distinct.length !== keys.length) {
    return {
      ok: false,
      reason:
        `This editor cannot tell these rows apart by ${keyColumn}: ${rows(keys.length)} on screen carry ` +
        `${distinct.length === 1 ? "one value" : `only ${distinct.length} values`} between them. ` +
        `Put a key that identifies a row in the query and run it again`,
    };
  }

  // A number is the one kind whose text IS its identity even when the number itself is
  // not exact, so it is asked about AFTER the dedup: two BIGINTs the driver rounded to the
  // same double really do arrive identical and are shown identical, and "2 rows on screen
  // carry one value between them" is the truer sentence for that. What is left here is a
  // number that is alone in its inexactness, where nothing else would say anything.
  const inexact = uncarriableKeys(keys, true, column);
  if (inexact !== null) return { ok: false, reason: uncarriableReason(keyColumn, inexact) };

  const dialect = connection.type;
  const params: unknown[] = [];
  const placeholders = distinct.map((key) => {
    const placeholder = positionalPlaceholder(dialect, params.length + 1);
    if (placeholder !== null) {
      params.push(typeof key === "number" ? key : String(key));
      return placeholder;
    }
    return typeof key === "number" ? String(key) : quoteLiteral(String(key), dialect);
  });
  const key = quoteIdentifier(keyColumn, dialect);
  const sql = `SELECT ${key}, COUNT(*) FROM ${table} WHERE ${key} IN (${placeholders.join(", ")}) GROUP BY ${key}`;

  let data: { rows?: Record<string, unknown>[]; error?: string };
  try {
    const res = await appFetch(inTransaction ? "/api/db/transaction" : "/api/db/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...buildConnectionPayload(connection),
        ...(inTransaction && { action: "query" }),
        sql,
        // A limit the answer cannot reach: one group per distinct key, and the keys are the
        // rows a person edited by hand. Left to the default the answer would be cut at 500
        // and the missing groups would read as missing ROWS, which is a refusal with a false
        // reason attached.
        options: { limit: distinct.length + 1 },
        ...(params.length > 0 && { params }),
      }),
    });
    // A proxy answering HTML rather than JSON would throw here, and the catch below is
    // what turns that into a refusal instead of an unhandled rejection.
    data = await res.json();
    if (!res.ok) return { ok: false, reason: data.error ?? "the check could not be run" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // `/api/db/query` answers rows as objects, always, and the name a bare `COUNT(*)` comes
  // back under is the engine's business: `count` on PostgreSQL, `COUNT(*)` on MySQL and
  // SQLite. So the count is read by POSITION — second value of each row, after the key —
  // rather than by a name no dialect agrees on. PostgreSQL returns it as a STRING, which
  // is why it goes through `Number`.
  const groups = data.rows ?? [];
  const counts = groups.map((row) => Number(Object.values(row)[1]));
  if (counts.some((count) => !Number.isFinite(count))) {
    return { ok: false, reason: "the check returned no count" };
  }
  const matched = counts.reduce((total, count) => total + count, 0);
  if (groups.length === distinct.length && counts.every((count) => count === 1)) return { ok: true };

  // Two independent things can be wrong with the same answer, and a refusal that reports
  // one of them hides the other. MEASURED on PostgreSQL 16: a grid read while `zz_dup_keys`
  // held k_id 1 twice and k_id 2 once, with the k_id 2 row deleted afterwards, comes back
  // as ONE group of two rows — so the totals read two-into-two, "the 2 rows you edited
  // would write to 2 rows" sounds like a rounding error, and the row that has gone is
  // never mentioned. Both facts are counted separately and both are said.
  const crowded = counts.filter((count) => count > 1).length;
  const unanswered = distinct.length - groups.length;

  // No key addresses more than one row, so the column may be perfectly unique and saying
  // it is not would be false. Fewer rows than keys can only mean rows have gone: a key the
  // engine folds into another (a case-insensitive collation) still answers for the rows
  // behind it, so its group would hold more than one and would not be here.
  if (crowded === 0 && matched < distinct.length) {
    return { ok: false, reason: "some of the rows you edited are no longer in the table. Run the query again" };
  }

  // What the engine LITERALLY answered, in both halves. The second one is deliberately not
  // read as "these rows are gone": an engine that reads two of the keys as one — MySQL's
  // default collation does — answers with fewer groups than it was asked about while every
  // row is still there, and "a row is missing" would be false about exactly that case.
  const short =
    unanswered > 0
      ? `, and the engine answered for only ${groups.length} of those ${distinct.length} keys — a row gone since ` +
        "you read it, or two keys this engine reads as one"
      : "";
  return {
    ok: false,
    reason:
      `${keyColumn} does not tell these rows apart in this table: the ${rows(distinct.length)} you edited ` +
      `would write to ${rows(matched)}${short}. Put the table's own key in the query and run it again`,
  };
}

/**
 * The type the engine declared for one column of this result, or `undefined`.
 *
 * `Object.hasOwn` and a `typeof` guard, the way `ResultsGrid` reads the same map: a column
 * name is arbitrary SQL output, `SELECT 1 AS constructor` is legal, and the map arrives
 * here through `JSON.parse`, so a plain property read would answer `Object.prototype`'s
 * own `constructor` — a function — for a column nothing declared.
 */
function declaredTypeOf(result: QueryResult, field: string): string | undefined {
  const types = result.columnTypes;
  if (types === undefined || !Object.hasOwn(types, field)) return undefined;
  const declared = types[field];
  return typeof declared === "string" ? declared : undefined;
}

export function useInlineEditing({
  activeConnection,
  currentTab,
  executeQuery,
  transactionActive = false,
}: UseInlineEditingParams) {
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<CellChange[]>([]);
  const { toast } = useToast();

  const handleCellChange = useCallback((change: CellChange) => {
    setPendingChanges((prev) => {
      // Replace existing change for same cell, or add new
      const existing = prev.findIndex((c) => c.rowIndex === change.rowIndex && c.columnId === change.columnId);
      if (existing >= 0) {
        // If reverting to original value, remove the change
        if (String(change.originalValue ?? "") === change.newValue) {
          return prev.filter((_, i) => i !== existing);
        }
        const updated = [...prev];
        updated[existing] = change;
        return updated;
      }
      // Don't add if no actual change
      if (String(change.originalValue ?? "") === change.newValue) return prev;
      return [...prev, change];
    });
  }, []);

  const handleApplyChanges = useCallback(async () => {
    if (!activeConnection || pendingChanges.length === 0) return;

    // A pending change addresses its row BY POSITION, so it only means anything against
    // the rows it was made on. Applying always ended by clearing the changes, which is
    // what kept a position from outliving those rows; keeping them after a refused apply
    // — which is what #882 asks for — removes that, and re-running the query is the
    // ordinary next move after a failure. Measured before this: an edit typed into the row
    // whose key was 1 was written to the row whose key was 77, and reported as applied.
    //
    // The change already carries what settles it: `originalValue`, the cell's content when
    // it was edited. The edits are KEPT on a refusal, the way every other refusal in this
    // hook keeps them — the check runs again on the next click, and Discard is how a user
    // throws work away on purpose.
    const rowsMoved = pendingChanges.some((change) => {
      const row = currentTab.result?.rows[change.rowIndex];
      if (row === undefined) return true;
      const current = Object.hasOwn(row, change.columnId) ? row[change.columnId] : undefined;
      return String(current ?? "") !== String(change.originalValue ?? "");
    });
    if (!currentTab.result || rowsMoved) {
      toast({
        title: "Cannot Apply Changes",
        description: "The rows these edits were made on are no longer on screen. Run the query again.",
        variant: "destructive",
      });
      return;
    }

    // Detect primary key column
    const pkColumn = currentTab.result.fields.find((f) => f.toLowerCase() === "id" || f.toLowerCase().endsWith("_id"));

    if (!pkColumn) {
      toast({
        title: "Cannot Apply Changes",
        description: "No primary key column detected (id or *_id). Edit the SQL manually.",
        variant: "destructive",
      });
      return;
    }

    // Group changes by row
    const changesByRow = new Map<number, CellChange[]>();
    for (const change of pendingChanges) {
      const existing = changesByRow.get(change.rowIndex) || [];
      existing.push(change);
      changesByRow.set(change.rowIndex, existing);
    }

    // The rows on screen came from this tab's query, so the query is the only thing in
    // the tab that names the table they may be written back to. The tab's TITLE named it
    // until #881, and a title is free text: it outlives the query it was created for, and
    // renaming a tab is not a way anyone expects to pick a write target. Where the title
    // happened to name another real table carrying the same key column, the UPDATE landed
    // on that table and said nothing.
    //
    // `resolveUpdateTarget` reads the query instead, and refuses every shape whose rows
    // have no single base table — joins, subqueries, CTEs, set operations. Refusing is
    // the honest answer there: the user edits the SQL by hand, which is what the old code
    // asked for only when its guess failed to parse. It reads the statement under the
    // connection's own dialect, and hands back the table reference exactly as the query
    // spells it, so a name the engine only accepts quoted stays quoted and a bare one is
    // validated as an identifier rather than quoted — quoting a hand-typed lowercase name
    // would break Oracle, where the real table is upper-cased.
    // `resultQuery` and not `query`: the buffer is rewritten on every keystroke and a run
    // may have executed only a selection of it, so the buffer can name a different table
    // than the one on screen — the same wrong-table write as #881, reached by typing
    // instead of by renaming.
    //
    // The `??` is a total function, not a live path. Every commit that writes a non-null
    // `result` writes `resultQuery` beside it, and a tab restored from storage comes back
    // with `result: null`, which returns above — so there is no state in which rows are on
    // screen and this falls through to the buffer.
    const target = resolveUpdateTarget(currentTab.resultQuery ?? currentTab.query, activeConnection.type);
    if (target.kind === "refused") {
      toast({
        title: "Cannot Apply Changes",
        description: `${target.reason}. Edit the SQL manually.`,
        variant: "destructive",
      });
      return;
    }
    const tableName = target.table;

    const dialect = activeConnection.type;
    const quote = (identifier: string) => quoteIdentifier(identifier, dialect);

    // Every key has to survive being read as text before anything is built from it. A value
    // with a null prototype has no `toString`, and `String()` throws on it - which happened
    // where the statement is assembled, so the apply died as an unhandled rejection with no
    // write and no toast either. Asked here, it is a refusal like any other.
    const keysByRow = new Map<number, unknown>();
    for (const rowIndex of changesByRow.keys()) {
      const value = currentTab.result.rows[rowIndex]?.[pkColumn];
      try {
        void String(value);
      } catch {
        toast({
          title: "Cannot Apply Changes",
          description: `This editor cannot read the ${pkColumn} of every row it would write to. Edit the SQL manually.`,
          variant: "destructive",
        });
        return;
      }
      keysByRow.set(rowIndex, value);
    }

    // Generate UPDATE statements
    const statements: Array<{ sql: string; params: unknown[]; rowIndex: number }> = [];
    for (const [rowIndex, changes] of changesByRow) {
      const row = currentTab.result.rows[rowIndex];
      const pkValue = row[pkColumn];
      const params: unknown[] = [];
      // A value is arbitrary text — pasted, imported, or read back from the table —
      // so it is bound rather than written into the statement. Interpolating it and
      // doubling the quote is only enough where a backslash is data: MySQL reads
      // `\'` as an escaped quote, so a value could close its own literal and have
      // the rest read as SQL, and applying edits skips the dangerous-query dialog
      // that would otherwise show the user that statement (#290). Where the dialect
      // has no positional bind form, a dialect-aware quoted literal is the fallback.
      const emit = (value: string | number): string => {
        const placeholder = positionalPlaceholder(dialect, params.length + 1);
        if (placeholder !== null) {
          params.push(value);
          return placeholder;
        }
        return typeof value === "number" ? String(value) : quoteLiteral(value, dialect);
      };
      const setClauses = changes.map((c) => {
        const isNull = c.newValue === "" || c.newValue.toUpperCase() === "NULL";
        // Column names come from the result's own field list, so they are exactly
        // what the engine reports and can be quoted: that keeps a name holding a
        // space or a reserved word legal, and keeps one that spells SQL inert.
        // NULL stays a keyword: it is not a value, so it takes no parameter.
        return `${quote(c.columnId)} = ${isNull ? "NULL" : emit(c.newValue)}`;
      });
      // The key keeps the number/text split it always had — a number goes to the
      // driver as a number — but neither form is written into the statement now.
      const pkVal = emit(typeof pkValue === "number" ? pkValue : String(pkValue));
      // No trailing semicolon: it only ever served to join the statements, and each
      // one now goes to /api/db/query verbatim rather than through
      // `splitStatements`, which used to strip it. oracledb rejects a plain
      // statement that carries one (ORA-00933).
      statements.push({
        sql: `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${quote(pkColumn)} = ${pkVal}`,
        params,
        rowIndex,
      });
    }

    // Before anything is written: is that key column the TABLE's, and does it address one
    // row per value? The first question comes first because it decides whether the second
    // one is even being asked about the right thing: a key that is an expression or a
    // rename sends the check to a real column the grid never showed, and every answer it
    // gives is about rows nobody is looking at.
    if (!selectsPlainColumn(currentTab.resultQuery ?? currentTab.query, pkColumn, activeConnection.type)) {
      toast({
        title: "Cannot Apply Changes",
        description: `${pkColumn} is not read straight from the table here, so it cannot identify a row to write to. Edit the SQL manually.`,
        variant: "destructive",
      });
      return;
    }

    // And then: does that key column address one row per value?
    // `pkColumn` is a guess off the field list, and on a result carrying a foreign key
    // rather than the table's own key it aims at the foreign key — one cell edit then
    // rewrote fifteen rows, reported as one statement accepted.
    const uniqueness = await keyAddressesOneRow(
      activeConnection,
      tableName,
      pkColumn,
      // The RAW cell values. Converting here would turn a missing key into the text
      // "null" before the check could see it was missing.
      statements.map((statement) => keysByRow.get(statement.rowIndex)),
      transactionActive,
      // What the engine itself called this column, carried beside the rows by the same
      // response that carried them. It is the only witness that survives the trip through
      // JSON, which is what turns a `Date` into a string indistinguishable from text.
      declaredTypeOf(currentTab.result, pkColumn),
    );
    if (!uniqueness.ok) {
      toast({
        title: "Cannot Apply Changes",
        description: `${uniqueness.reason}.`,
        variant: "destructive",
      });
      return;
    }

    // One request per row (issue #269), sequentially and with the safety dialog
    // skipped. Each part matters:
    //  - per row, because a joined payload reaches the engine as ONE string whenever
    //    a transaction or sandbox run is active, and because a failure is only
    //    attributable to a row when the row is its own request. (On the default path
    //    `/api/db/multi-query` did split it, so this is about the other path and
    //    about error attribution, not about every engine rejecting the join.)
    //  - sequentially, because executeQuery mutates the active tab's result and
    //    isExecuting, so concurrent calls would race on that state (the tab ends up
    //    showing the last row's result);
    //  - skipSafety, because isDangerousQuery matches every `UPDATE ... SET` and the
    //    gate returns WITHOUT executing while remembering only the last query it was
    //    handed — so an unflagged loop would apply nothing but the row the user then
    //    confirms, silently dropping the rest. Apply is the confirmation here: these
    //    statements are generated rather than typed, each carries a WHERE on the
    //    detected key, and the pending changes were reviewed in the grid first.
    const failedRows = new Set<number>();
    for (const statement of statements) {
      const outcome = await executeQuery(statement.sql, currentTab.id, false, {
        skipSafety: true,
        ...(statement.params.length > 0 && { params: statement.params }),
      });
      // Only an explicit refusal counts. `executeQuery` reports the failure to the
      // user itself; what it could not do before was tell THIS loop, which went on to
      // clear the pending changes and claim success whatever happened (#882).
      if (outcome === false) failedRows.add(statement.rowIndex);
    }

    if (failedRows.size === statements.length) {
      // Nothing was written, so nothing on screen was overwritten either: a run that
      // never reached the engine leaves the tab's result alone. The grid the edits
      // belong to is still there, the edits are still lined up with it, and the user
      // can correct and retry without retyping anything.
      toast({
        title: "Changes Not Applied",
        // "confirmed as saved" rather than "updated": a run the user superseded by pressing
        // Run again reports failure here without the engine having refused it, so the
        // strongest true claim is that none of them came back confirmed.
        description: `${rows(statements.length)} could not be confirmed as saved. Your edits are still here.`,
        variant: "destructive",
      });
      return;
    }

    // At least one UPDATE ran, and each one wrote its own result into the tab as it went,
    // so the rows the edits came from are no longer on screen (#883). Re-running the
    // tab's own query puts them back AND shows them as the engine now holds them, which
    // is the confirmation a toast can only assert. It goes to the tab the edits came
    // from, not to whichever tab is active by the time the last row answers.
    const refreshed = await executeQuery(currentTab.resultQuery ?? currentTab.query, currentTab.id);

    // Pending changes address rows BY POSITION, and the refresh has just replaced the
    // rows they were positions into. Keeping the ones that failed would mean carrying an
    // index forward onto a result this hook cannot see from here — and a retry would then
    // read its key from whatever row now sits at that index, which is the wrong-row write
    // #881 is about. They are dropped instead, and the toast says so: the refreshed grid
    // shows exactly which rows still hold their old values.
    setPendingChanges([]);
    setEditingEnabled(failedRows.size > 0);

    if (failedRows.size > 0) {
      toast({
        title: "Some Changes Not Applied",
        description:
          `${failedRows.size} of ${statements.length} rows could not be confirmed as saved, and your edits have ` +
          "been cleared. " +
          (refreshed === false ? "Run the query again to see what was saved." : "The results are up to date."),
        variant: "destructive",
      });
      return;
    }

    // "accepted", not "updated": a statement the engine accepts may still have matched no
    // row, and this loop cannot tell those apart. The re-read grid is what actually shows
    // the user what changed, so the toast points at it rather than claiming a count.
    toast({
      title: "Changes Applied",
      description:
        // Read the same way a row's outcome is: only an explicit refusal is a failure, so
        // a caller that reports nothing keeps the behaviour it had before the outcome
        // existed.
        refreshed === false
          ? `${updates(statements.length)} accepted. Run the query again to see the saved rows.`
          : `${updates(statements.length)} accepted. The results are up to date.`,
    });
  }, [activeConnection, currentTab, pendingChanges, executeQuery, toast, transactionActive]);

  const handleDiscardChanges = useCallback(() => {
    setPendingChanges([]);
  }, []);

  return {
    editingEnabled,
    setEditingEnabled,
    pendingChanges,
    handleCellChange,
    handleApplyChanges,
    handleDiscardChanges,
  };
}
