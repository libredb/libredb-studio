import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  NO_BARE_SPELLING,
  NULL_NON_FINITE,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryZeroX } from "@/lib/db/sql-writing/export-shared";
import { cassandraLiteral, cqlFrozenNested } from "./typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/**
 * Written above the Cassandra `CREATE TABLE` only, immediately before the statement.
 *
 * Every line is its own `--` comment closed by a real newline: a CQL line comment
 * that reaches end of file with no trailing newline is left open, so this is never
 * the last thing in the file without one: the statement always follows it.
 */
const CASSANDRA_PRIMARY_KEY_NOTE =
  "-- CQL requires exactly one PRIMARY KEY per table, and a result set carries no key of\n" +
  "-- its own. This export chose the first column as a placeholder: confirm it is unique\n" +
  "-- per row before running this statement.\n";

/** How a generated statement spells a literal, a name and a bind for Cassandra. */
export const CASSANDRA_SQL_WRITING: SqlWritingSpec = {
  // Measured on Cassandra 5.0.9 (2026-08-20), both directions. Doubling is the
  // escape: `… WHERE name = 'O''Brien'` runs and matches nothing, so the literal
  // closed at the doubled pair. A backslash is DATA: `… WHERE name = 'a\\b'` runs,
  // and `… WHERE name = 'a\\'` runs too - the statement reached the server's
  // filtering check, which is only possible if the backslash did not escape the
  // quote that closed the literal.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form. Measured on 5.0.9: `SELECT "id" FROM probe.customers` returns the
  // column, a backtick is "no viable alternative at character '`'", and a
  // double-quoted STRING is a syntax error - so `"` is the name quote and nothing
  // else.
  quoteIdentifier: identifierDoubleQuoted,
  // CQL really does bind `?` positionally and `cassandra-driver` really does
  // bind an array against it - through a PREPARED statement, which is exactly what the
  // transport does not send (`prepare: false`, so a one-shot statement costs one round
  // trip and no server-side cache entry). `CassandraProvider.query()` therefore refuses a
  // non-empty params array outright, and emitting `?` here would build a statement whose
  // placeholder the provider then declines to fill.
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    // CQL has no `DOUBLE PRECISION`: measured on Cassandra 5.0.9, `CREATE TABLE … (c
    // DOUBLE PRECISION)` is `SyntaxException: no viable alternative at input
    // 'PRECISION'`, while `DOUBLE`, `TEXT`, `BIGINT`, `BOOLEAN`, `TIMESTAMP` and `BLOB`
    // are all whole type names.
    ddlTypes: {
      text: "TEXT",
      integer: "BIGINT",
      numeric: "DOUBLE",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "BLOB",
    },
    standsAlone: ["varchar", "text", "blob", "decimal", "timestamp"],
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Measured on Cassandra 5.0.9: the generated pair replays, and `SELECT "payload"`
    // answers `0x0102deadbeef`. Bare `0x` is the empty blob: `blobAsText(0x)` answers
    // the empty string rather than raising, and `X'…'` is not in the grammar at all.
    binaryLiteral: binaryZeroX,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
    typedLiteral: cassandraLiteral,
    // The Cassandra driver reports a nested collection without its `frozen<...>` (measured on
    // 5.0.9: a `list<frozen<list<int>>>` column is declared `list<list<int>>`), and CQL refuses
    // that spelling: `Non-frozen collections are not allowed inside collections`.
    rewriteDeclared: cqlFrozenNested,
    // Measured on 5.0.9, a CQL `CREATE TABLE` with a column list and no
    // key is `InvalidRequest ... No PRIMARY KEY specifed for table (exactly one
    // required)`, so the plain column list every other dialect gets cannot run at
    // all. A result set does not know which column is the real key, so the first one is
    // chosen as a placeholder - wrong often enough to be dangerous, but a wrong key that
    // replays beats a file that fails to parse. The comment says so above the statement,
    // rather than in the column list, so it survives being read on its own.
    createTableKey: {
      note: CASSANDRA_PRIMARY_KEY_NOTE,
      clause: (quoted) => `PRIMARY KEY (${quoted[0]})`,
    },
  },
};
