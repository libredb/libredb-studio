/**
 * Bounded per-table profiling: the SQL the server composes for it, and the
 * findings it derives from what comes back (#330 T3).
 *
 * **The profile records counts, never values.** That is the rule the whole module
 * is built around, and it is what makes profiling a table of personal data
 * acceptable at all: every statistic is an aggregate — how many rows, how many are
 * present, how many are distinct, how many match a shape — so no name, address or
 * account number is ever written to the ledger, shown to the model, or rendered in
 * the rail. A `min`/`max` of a text column would return an actual value, which is
 * why neither is here even though both are conventional in a profiler.
 *
 * Three further decisions:
 *
 *  - **The model names a table; the server chooses the columns.** They come from the
 *    run's own captured inventory, so a profile cannot be aimed at a column the run
 *    never established exists, and the statement is composed rather than supplied —
 *    the same rule `inspect_schema` follows.
 *  - **The findings are derived from the numbers, not asserted by the model.** Every
 *    one is a mechanical predicate over counts with a stated threshold. A model may
 *    interpret them; it cannot invent them.
 *  - **`suspected_pii` is a suspicion, and says so.** At any depth it is read from
 *    the column NAME, and at `pattern` depth from the RATIO of values matching a
 *    shape — computed inside the database by a `count(CASE WHEN …)`, so the values
 *    that matched never leave it. Neither test establishes that a column holds
 *    personal data; both establish that it is worth a human looking. The shape tests
 *    are PER-DIALECT predicates rather than one shared operator, because the shapes
 *    worth suspecting are not all expressible in the intersection of the three
 *    grammars (B26; see `PROFILE_SHAPES`).
 */

import { quoteIdentifier } from "@/lib/sql/identifier";
import type { ColumnSchema, DatabaseType } from "@/lib/types";
import { AgentComposedSqlError, MAX_CATALOG_SELECTOR_LENGTH } from "./composed-sql-primitives";
import { engineServerDialect } from "./languages/engines/server";
import type { AgentInventoryObject } from "./types";

/**
 * How deeply one profile reads. Each level is the one before it plus more, so a
 * deepening re-reads what it already had — which is the cost of asking the engine
 * once rather than keeping a partial profile in flight across statements.
 */
export type AgentProfileDepth = "basic" | "distribution" | "pattern";

/**
 * Columns one profile may cover.
 *
 * Bounded because the composed statement grows with it: at `pattern` depth each
 * column contributes four aggregates — present, distinct and one per shape test — so
 * an unbounded table would compose a statement whose cost nobody chose. A wider table
 * is profiled in more than one call, which the statement budget accounts for
 * honestly.
 */
export const MAX_PROFILE_COLUMNS = 16;

/** Below this many present values, a ratio says more about the sample than the data. */
export const MIN_ROWS_FOR_RATIO_FINDINGS = 20;

/** At or above this share of missing values, a column is worth reporting as sparse. */
export const HIGH_NULL_RATIO = 0.5;

/** At or below this share of distinct values, a column carries very few of them. */
const LOW_CARDINALITY_RATIO = 0.01;

/** At or above this share of shape matches, the shape is the column's norm rather than an accident. */
const PII_SHAPE_RATIO = 0.5;

/**
 * Column names that name personal data in the languages this project is written
 * and used in. A suspicion drawn from a NAME, which is why the finding says
 * "suspected" — a column called `email` may hold anything, and one called `col_7`
 * may hold every address in the country.
 */
const PII_NAME_WORDS: readonly string[] = Object.freeze([
  "email",
  "mail",
  "phone",
  "tel",
  "mobile",
  "gsm",
  "ssn",
  "tckn",
  "national_id",
  "passport",
  "iban",
  "card",
  "birth",
  "dob",
  "address",
  "adres",
  "postcode",
  "zip",
]);

/**
 * Types this module is willing to apply a text shape test to.
 *
 * It matches a SPELLING, which makes it only as good as the spelling it is handed, and
 * the DECLARED one is not always usable. On SQL Server an ALIAS type is reported by its
 * own name, so `Person.PersonPhone.PhoneNumber` is declared `Phone` and
 * `Person.Person.FirstName` is `Name` (measured on AdventureWorks2022 via `sys.columns`,
 * where `TYPE_NAME(user_type_id)` answers `Phone` and `TYPE_NAME(system_type_id)` answers
 * `nvarchar`), and no pattern over a name the schema's author invented can tell a text
 * alias from a numeric one.
 *
 * So the fix is where the type is READ rather than here, and it landed: the mssql
 * provider reports the base type beside the declared one (`ColumnSchema.baseType`), and
 * every type test in this file matches `decidableType` below, which prefers it. An
 * alias-typed column therefore gets its shape tests. Measured end to end after that
 * change: the provider reports `PhoneNumber` as `{type: Phone, baseType: nvarchar}` and
 * the composed profile carries its `shaped_1` and `digits_1` counts, which it did not
 * before. Where an engine draws no such distinction there is no `baseType` to prefer and
 * the declared spelling is still what this matches, unchanged.
 */
const TEXTUAL_TYPE = /char|text|string|clob|varying/i;

/** Something, an `@`, something, a `.`, something. All three dialects spell `LIKE` alike. */
const EMAIL_SHAPE = "%_@_%._%";

/**
 * How many consecutive digits make a run worth suspecting.
 *
 * Nine, because that is the shortest of the identifiers `PII_NAME_WORDS` already
 * names: an `ssn` is nine digits, and a `tckn`, a phone number or a `card` is longer.
 * A shorter bound would start matching years, prices and quantities — the failure the
 * earlier `LIKE '%_________%'` draft would have had for every text column.
 */
export const DIGIT_RUN_LENGTH = 9;

/**
 * How one engine composes a profile: the server dialect member `profileComposition`, which each SQL engine's overlay
 * in `languages/sql/engines/` supplies or declares `"unsupported"`. The core passes the shapes' own constants into the
 * shape tests, so an overlay needs nothing from this module but its types.
 */
export interface AgentProfileComposition {
  /** The shape tests, each over an already-quoted column reference, in this engine's spelling (see `PROFILE_SHAPES`). */
  readonly shapeTests: {
    readonly email: (quotedColumn: string, likePattern: string) => string;
    readonly digitRun: (quotedColumn: string, runLength: number) => string;
  };
  /**
   * Types with no equality operator, so `count(DISTINCT …)` refuses them.
   *
   * PostgreSQL answers `could not identify an equality operator for type json` — and
   * because one unsupported column aborts the WHOLE aggregate, a single `json` column
   * would have failed distribution and pattern profiling for the entire table. Found
   * by review on #345.
   *
   * An exclusion rather than an allowlist of comparable types, deliberately: the
   * comparable set is open (every domain, every enum, every extension type), so an
   * allowlist would refuse to count things it simply had not heard of. This list is
   * the closed set that genuinely has no default equality.
   */
  readonly incomparableType: RegExp;
  /**
   * Types the engine refuses to COUNT at all, so the column is left out whole.
   *
   * Stronger than `incomparableType`, and therefore its own set: an incomparable type
   * still has a presence count and only loses its distinct count, while a column of one
   * of these types cannot be projected at all. SQL Server answers
   * "Operand data type text is invalid for count operator" (Msg 8117) for a plain
   * `count([col])` on `text`, `ntext` and `image` - measured on 2022 CU26, one probe
   * column per type. Because the whole profile is ONE aggregate over one scan, a single
   * such column would fail the statement and with it every other column's statistics, so
   * the column contributes no presence, no distinct count and no shape test. That reads
   * back as "the engine was not asked about this column", which is exactly true: a
   * column the composer left out is absent from the profile rather than reported as
   * empty (see `readTableProfile`).
   *
   * Only SQL Server has such a set. PostgreSQL and SQLite count presence for every type
   * this module has met, including the ones they refuse to count DISTINCT, so an entry
   * for them would be an assertion nothing measured.
   */
  readonly uncountableType?: RegExp;
}

/** One value shape, and how each engine spells the test for it. */
interface ProfileShape {
  /** Alias prefix for this shape's count. Generated, never taken from a column name. */
  readonly alias: string;
  /** The app's own words for the shape, read back into a `suspected_pii` finding. */
  readonly words: string;
  /** The predicate, in the engine's own shape tests, over an already-quoted column reference. */
  readonly test: (shapeTests: AgentProfileComposition["shapeTests"], quotedColumn: string) => string;
}

/**
 * The shapes tested inside the database, so no matching value ever leaves it.
 *
 * PER-DIALECT predicates rather than one shared `LIKE` (B26). `LIKE` is the only
 * pattern operator all three dialects spell the same way, and `_` in it means "any
 * character" rather than "any digit" — so a digit run cannot be expressed in the
 * intersection at all, and an earlier draft's `LIKE '%_________%'` would have
 * reported `suspected_pii` for essentially every text column. PostgreSQL spells the
 * run `~ '[0-9]{9,}'`, SQLite spells it `GLOB '*[0-9]…*'` and T-SQL spells it as the
 * character class repeated inside a `LIKE`.
 *
 * Every spelling was run against a live engine and returned the same counts, so the
 * dialects agree about what a run is rather than each merely being accepted: PostgreSQL
 * 18 and SQLite 3.53 over the same four rows, and the T-SQL pair replayed on SQL Server
 * 2022 CU26 over four values (a nine-digit run, an eight-digit one, an email and a plain
 * string), which counted the nine-digit run once and the email once. The SQLite arm is
 * executed end to end in `tests/unit/lib/agent/table-profile.test.ts`.
 */
const EMAIL_SHAPE_TEST: ProfileShape = Object.freeze({
  alias: "shaped",
  words: "an email address",
  test: (shapeTests: AgentProfileComposition["shapeTests"], quoted: string) => shapeTests.email(quoted, EMAIL_SHAPE),
});

const DIGIT_RUN_SHAPE_TEST: ProfileShape = Object.freeze({
  alias: "digits",
  words: `a run of ${DIGIT_RUN_LENGTH} or more digits`,
  test: (shapeTests: AgentProfileComposition["shapeTests"], quoted: string) =>
    shapeTests.digitRun(quoted, DIGIT_RUN_LENGTH),
});

const PROFILE_SHAPES: readonly ProfileShape[] = Object.freeze([EMAIL_SHAPE_TEST, DIGIT_RUN_SHAPE_TEST]);

export type AgentProfileFindingCode =
  /** At least `HIGH_NULL_RATIO` of the rows have no value in this column. */
  | "high_null"
  /** Every present value is the same one. */
  | "constant"
  /** Very few distinct values across many rows. */
  | "low_cardinality"
  /** A foreign-key column that no index in the captured inventory leads on. */
  | "fk_unindexed"
  /** The column's name, or the shape of its values, suggests personal data. */
  | "suspected_pii";

export interface AgentProfileFinding {
  readonly code: AgentProfileFindingCode;
  readonly column: string;
  /**
   * The app's own words, carrying the numbers the finding was derived from.
   * Deliberately no engine text and no value — see the module docblock.
   */
  readonly detail: string;
}

/** What one column's aggregates came back as. Counts only. */
export interface AgentColumnProfile {
  readonly column: string;
  /** Rows where the column is not null. */
  readonly present: number;
  /** Distinct present values, at `distribution` depth and deeper. */
  readonly distinct?: number;
  /** Rows shaped like an email address, at `pattern` depth. */
  readonly shaped?: number;
  /** Rows carrying a run of `DIGIT_RUN_LENGTH` or more digits, at `pattern` depth. */
  readonly digitRun?: number;
}

export interface AgentTableProfile {
  readonly table: string;
  readonly depth: AgentProfileDepth;
  readonly rowCount: number;
  readonly columns: readonly AgentColumnProfile[];
  readonly findings: readonly AgentProfileFinding[];
}

// ─── composition ────────────────────────────────────────────────────────────

/** Aliases are generated, never taken from a column name: a name is untrusted text. */
const alias = (prefix: string, index: number): string => `${prefix}_${index}`;

function assertProfileTable(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_CATALOG_SELECTOR_LENGTH) {
    throw new AgentComposedSqlError("a profile needs one table name of a usable length", "INVALID_SELECTOR");
  }
  return trimmed;
}

/**
 * The resolved address, one quoted identifier per SEGMENT, each in the DIALECT's own quote:
 * `"` on PostgreSQL and SQLite, `[…]` on SQL Server (`quoteIdentifier`).
 *
 * A schema and a table was enough while a resolution produced at most those two, and it is
 * not any more: an address is as deep as the object read made it, and joining its leading
 * segments into one string before quoting it composes `"shop.sales"."orders"` - a single
 * identifier no engine holds, assembled from two that it does (#789). Quoting segment by
 * segment is the only shape that cannot invent one. An empty address composes nothing: there
 * is no name in it to profile.
 */
function quoteTarget(dialect: DatabaseType, segments: readonly string[]): string {
  if (segments.length === 0) {
    throw new AgentComposedSqlError("a profile needs one table name of a usable length", "INVALID_SELECTOR");
  }
  return segments.map((segment) => quoteIdentifier(assertProfileTable(segment), dialect)).join(".");
}

/**
 * The spelling a TYPE TEST must match against, which is not always the declared one.
 *
 * SQL Server alias types are why: `Person.PersonPhone.PhoneNumber` is declared `Phone`,
 * an alias over `nvarchar`, and `Person.Person.FirstName` is `Name` over the same. The
 * declared name is what a person wants to see and what `type` carries; it is a name the
 * schema's author invented, so every regex below would match nothing against it, and the
 * one column in that table the PII shapes exist to find got no shape test at all. Worse,
 * an alias over `text` would slip past `uncountableType` and fail the whole table's
 * profile with Msg 8117.
 *
 * `baseType` is the provider's answer to that, absent wherever an engine draws no such
 * distinction, so this falls back to the declared type and every other engine is unchanged.
 */
const decidableType = (column: ColumnSchema): string => column.baseType ?? column.type;

const isTextual = (column: ColumnSchema): boolean => TEXTUAL_TYPE.test(decidableType(column));

const isComparable = (column: ColumnSchema, composition: AgentProfileComposition): boolean =>
  !composition.incomparableType.test(decidableType(column));

const isCountable = (column: ColumnSchema, composition: AgentProfileComposition): boolean => {
  const refused = composition.uncountableType;
  return refused === undefined || !refused.test(decidableType(column));
};

/**
 * One statement covering the whole table, rather than one per statistic.
 *
 * The run's statement budget is 20, and a per-statistic composition would spend it
 * on a single table. Everything here is an aggregate over one scan, which is also
 * the shape an engine can plan best.
 *
 * The shape tests are applied only to columns whose type reads as textual - the base
 * type where the engine reports one, the declared type otherwise (`decidableType`):
 * comparing an integer column to a string pattern is an error on PostgreSQL, and
 * casting every column to text to avoid that would turn a bounded read into a full
 * conversion of the table.
 *
 * A column of a type the engine will not count is left out of the projection entirely
 * (`uncountableType`). Because everything is one aggregate, one such column would
 * otherwise cost the table its whole profile. A table made only of them still composes:
 * the row count is a profile, a smaller one than was asked for.
 */
export function composeTableProfile(
  dialect: DatabaseType,
  selector: { readonly segments: readonly string[]; readonly depth: AgentProfileDepth },
  columns: readonly ColumnSchema[],
): string {
  const composition = engineServerDialect(dialect).profileComposition;
  if (composition === "unsupported") {
    throw new AgentComposedSqlError(
      `no verified profile composition for provider type "${dialect}"`,
      "UNSUPPORTED_DIALECT",
    );
  }
  if (columns.length === 0) {
    throw new AgentComposedSqlError("that table has no columns to profile", "INVALID_SELECTOR");
  }

  const parts = ["count(*) AS row_count"];
  columns.forEach((column, index) => {
    // A type the engine refuses to count contributes NOTHING: one such column in the
    // projection fails the single aggregate and takes the whole table's profile with it.
    if (!isCountable(column, composition)) return;
    const quoted = quoteIdentifier(column.name, dialect);
    parts.push(`count(${quoted}) AS ${alias("present", index)}`);
    // A type with no equality operator is skipped rather than counted: its absence
    // reads as "the engine did not report this", which is exactly true.
    if (selector.depth !== "basic" && isComparable(column, composition)) {
      parts.push(`count(DISTINCT ${quoted}) AS ${alias("distinct", index)}`);
    }
    if (selector.depth === "pattern" && isTextual(column)) {
      // Counted inside the database: the rows that matched are never returned.
      for (const shape of PROFILE_SHAPES) {
        const test = shape.test(composition.shapeTests, quoted);
        parts.push(`count(CASE WHEN ${test} THEN 1 END) AS ${alias(shape.alias, index)}`);
      }
    }
  });

  return `SELECT ${parts.join(", ")} FROM ${quoteTarget(dialect, selector.segments)}`;
}

// ─── reading the result back ────────────────────────────────────────────────

const count = (row: Record<string, unknown>, key: string): number | undefined => {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // `count()` comes back as a bigint on some drivers and as a numeric string on
  // node-postgres, which returns int8 as text to avoid losing precision.
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
};

/**
 * Turns the one aggregate row into a profile. A statistic the engine did not
 * report is ABSENT rather than zero: zero present values is a finding, and "the
 * engine said nothing" is not.
 *
 * A COLUMN the engine did not report is absent the same way, and for the same reason.
 * The composer leaves an uncountable column out of the projection whole
 * (`uncountableType`), and reading its missing presence count back as zero would make
 * a `text` column on SQL Server arrive as `high_null` at 100% - a finding derived from
 * a question nobody asked. The aliases carry the column's own index, so dropping one
 * column cannot shift another's statistics onto it.
 */
export function readTableProfile(
  table: string,
  depth: AgentProfileDepth,
  columns: readonly ColumnSchema[],
  rows: readonly Record<string, unknown>[],
): AgentTableProfile | null {
  const row = rows[0];
  if (row === undefined) return null;
  const rowCount = count(row, "row_count");
  if (rowCount === undefined) return null;

  const profiled: AgentColumnProfile[] = [];
  columns.forEach((column, index) => {
    const present = count(row, alias("present", index));
    if (present === undefined) return;
    const distinct = count(row, alias("distinct", index));
    const shaped = count(row, alias(EMAIL_SHAPE_TEST.alias, index));
    const digitRun = count(row, alias(DIGIT_RUN_SHAPE_TEST.alias, index));
    profiled.push({
      column: column.name,
      present,
      ...(distinct === undefined ? {} : { distinct }),
      ...(shaped === undefined ? {} : { shaped }),
      ...(digitRun === undefined ? {} : { digitRun }),
    });
  });

  return { table, depth, rowCount, columns: profiled, findings: deriveFindings(rowCount, profiled) };
}

/**
 * A share as a whole percent, never rounded up onto 100% it has not reached: 999 of 1000 is "over 99%". A live
 * assessment on 2026-10-17 was told a column held "100% of 1000 rows" with no value while the profile counted one,
 * and both engines' reports then called the column completely empty. Every finding that states a share is gated at
 * half or more, so the other end, a share rounded down to 0%, is never stated.
 */
const ratio = (part: number, whole: number): string => {
  const percent = Math.round((part / whole) * 100);
  return percent === 100 && part < whole ? "over 99%" : `${percent}%`;
};

function namesPersonalData(column: string): boolean {
  const lowered = column.toLowerCase();
  return PII_NAME_WORDS.some((word) => lowered.includes(word));
}

/**
 * The shapes that are the column's NORM rather than an accident, in the app's own
 * words and carrying the ratio each was derived from.
 *
 * A shape the engine did not report is absent rather than zero, so a profile read at
 * `basic` depth contributes no shape suspicion at all — which is exactly true.
 */
function matchedShapes(profile: AgentColumnProfile): readonly string[] {
  if (profile.present < MIN_ROWS_FOR_RATIO_FINDINGS) return [];

  const counted: readonly (readonly [number | undefined, string])[] = [
    [profile.shaped, EMAIL_SHAPE_TEST.words],
    [profile.digitRun, DIGIT_RUN_SHAPE_TEST.words],
  ];

  const matched: string[] = [];
  for (const [matches, words] of counted) {
    if (matches !== undefined && matches / profile.present >= PII_SHAPE_RATIO) {
      matched.push(`${ratio(matches, profile.present)} of the values are shaped like ${words}`);
    }
  }
  return matched;
}

/**
 * Every finding, as a mechanical predicate over counts.
 *
 * Order is stable and by column, so two profiles of the same table produce the same
 * list — a finding set that reordered between runs would read as having changed.
 */
function deriveFindings(rowCount: number, profiles: readonly AgentColumnProfile[]): readonly AgentProfileFinding[] {
  const findings: AgentProfileFinding[] = [];

  for (const profile of profiles) {
    const missing = rowCount - profile.present;

    if (rowCount >= MIN_ROWS_FOR_RATIO_FINDINGS && missing / rowCount >= HIGH_NULL_RATIO) {
      findings.push({
        code: "high_null",
        column: profile.column,
        detail: `${ratio(missing, rowCount)} of ${rowCount} rows have no value here.`,
      });
    }

    if (profile.distinct === 1 && profile.present > 1) {
      findings.push({
        code: "constant",
        column: profile.column,
        detail: `All ${profile.present} present values are the same one.`,
      });
    } else if (
      profile.distinct !== undefined &&
      profile.distinct > 1 &&
      profile.present >= MIN_ROWS_FOR_RATIO_FINDINGS &&
      profile.distinct / profile.present <= LOW_CARDINALITY_RATIO
    ) {
      findings.push({
        code: "low_cardinality",
        column: profile.column,
        detail: `${profile.distinct} distinct values across ${profile.present} rows.`,
      });
    }

    const shapes = matchedShapes(profile);
    if (namesPersonalData(profile.column) || shapes.length > 0) {
      findings.push({
        code: "suspected_pii",
        column: profile.column,
        detail:
          shapes.length > 0
            ? `${shapes.join(", and ")}. No value was read out of the database to establish this.`
            : "The column's name suggests personal data. Its values were not inspected to establish this.",
      });
    }
  }

  return findings;
}

// ─── the one finding that comes from the inventory rather than the numbers ───

/**
 * Foreign-key columns that no index in the CAPTURED INVENTORY leads on.
 *
 * Stated that precisely because the inventory still has a known blind spot, and a
 * finding worded as "this foreign key is unindexed" would overstate it:
 * **PostgreSQL expression indexes are absent**, and a partly-expression index
 * appears carrying only its plain columns (#463).
 *
 * SQLite's constraint-created indexes WERE a second blind spot (B25) and are not
 * one any more: SQLite stores no DDL for them, so the composed index read cannot
 * see them, and `parseSqliteTableDdl` now reports the ones a `UNIQUE` constraint
 * creates out of the table's own DDL — as an index named `(unique constraint)`,
 * which is plain words rather than a name anybody could mistake for a user's
 * `CREATE INDEX`. A `PRIMARY KEY` needs no such row: it is read from the column
 * inventory below, not from the index one.
 *
 * COVERAGE IS A PREFIX TEST, not a membership test: an index serves a lookup on the
 * column it LEADS on, so `UNIQUE (note, parent_id)` does not cover `parent_id`.
 *
 * Composite foreign keys are SKIPPED rather than guessed at: PostgreSQL's catalog
 * read returns them as the cross product of both sides (B8), so their columns
 * cannot be regrouped into the key they belong to, and a covering test over the
 * wrong grouping would be an answer about a key that does not exist.
 */
export function findUnindexedForeignKeys(table: AgentInventoryObject): readonly AgentProfileFinding[] {
  if (!Array.isArray(table.indexes)) return [];
  const keys = table.foreignKeys ?? [];
  // More than one edge from a table is where a composite key becomes
  // indistinguishable from several single-column ones on PostgreSQL.
  const byTarget = new Map<string, number>();
  for (const key of keys) byTarget.set(key.referencedTable, (byTarget.get(key.referencedTable) ?? 0) + 1);

  const leading = new Set(table.indexes.map((index) => index.columns[0]).filter((name) => name !== undefined));
  const primary = new Set(table.columns.filter((column) => column.isPrimary).map((column) => column.name));

  const findings: AgentProfileFinding[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if ((byTarget.get(key.referencedTable) ?? 0) > 1) continue;
    if (seen.has(key.columnName) || leading.has(key.columnName) || primary.has(key.columnName)) continue;
    seen.add(key.columnName);
    findings.push({
      code: "fk_unindexed",
      column: key.columnName,
      detail: "No index in the captured inventory leads on this foreign-key column.",
    });
  }
  return findings;
}
