import { describe, expect, test } from "bun:test";
import {
  asBytes as exportSharedAsBytes,
  binaryBinaryHex,
  binaryHexToRaw,
  binaryPgBytea,
  binaryStandardHex,
  binaryTextBackslash,
  binaryUnhex,
  binaryZeroX,
  jsonText as exportSharedJsonText,
  splitArguments,
} from "@/lib/db/sql-writing/export-shared";
import {
  BARE_TYPE_FAMILY,
  CLICKHOUSE_WRAPPER,
  EXACT_DECIMAL_TYPE_NAMES,
  EVERY_TYPE_IS_FLOAT64,
  EXACT_NUMERIC_TYPE,
  FLOAT_TYPE,
  FLOAT64_TYPE_NAMES,
  firstWord,
  INSTANT_TYPE_NAMES,
  identifierBacktickBackslash,
  identifierBacktickDoubled,
  identifierBracket,
  identifierDoubleQuoted,
  literalBackslash,
  literalDoubleAndBackslash,
  literalStandard,
  literalUnicode,
  NO_BARE_SPELLING,
  NO_EXACT_DECIMAL_TYPE_NAMES,
  NO_INSTANT_TYPE_NAMES,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  placeholderAtP,
  placeholderColon,
  placeholderDollar,
  placeholderQuestion,
  QUOTED_WORD_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteBackslash,
  unquoteDoubleAndBackslash,
  unquoteDoublingOnly,
  unquoteStandard,
  unquoteUnicode,
  unwrappedType,
  VERBATIM_DECLARED_TYPES_STAND_ALONE,
} from "@/lib/db/sql-writing/shared";
import type { ExportSpec } from "@/lib/db/sql-writing/types";
import { asBytes } from "@/lib/export/binary";
import { jsonText } from "@/lib/export/json";
import { buildResultExport } from "@/lib/export/result-export";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { positionalPlaceholder, quoteLiteral, unquoteLiteral } from "@/lib/sql/values";
import type { DatabaseType } from "@/lib/types";
import { IDENTIFIER_NAMES, LITERAL_VALUES, PLACEHOLDER_POSITIONS, RAW_LITERALS } from "./fixtures";

/**
 * Each shared building block answers what today's public function answers for one engine
 * of that form, over the golden fixture values, so an engine module that imports one by
 * name inherits today's output and nothing else.
 */
const LITERALS: ReadonlyArray<
  readonly [DatabaseType, (text: string) => string, (literal: string) => string | undefined]
> = [
  ["postgres", literalStandard, unquoteStandard],
  ["mssql", literalUnicode, unquoteUnicode],
  ["mysql", literalDoubleAndBackslash, unquoteDoubleAndBackslash],
  ["bigquery", literalBackslash, unquoteBackslash],
];

const IDENTIFIERS: ReadonlyArray<readonly [DatabaseType, (name: string) => string]> = [
  ["postgres", identifierDoubleQuoted],
  ["mysql", identifierBacktickDoubled],
  ["bigquery", identifierBacktickBackslash],
  ["mssql", identifierBracket],
];

const PLACEHOLDERS: ReadonlyArray<readonly [DatabaseType, (position: number) => string]> = [
  ["postgres", placeholderDollar],
  ["mysql", placeholderQuestion],
  ["oracle", placeholderColon],
  ["mssql", placeholderAtP],
];

describe("SQL writing shared building blocks", () => {
  for (const [engine, escape, unescape] of LITERALS) {
    test(`${escape.name} and ${unescape.name} answer as ${engine} does today`, () => {
      for (const value of LITERAL_VALUES) {
        const quoted = quoteLiteral(value, engine);
        expect(escape(value)).toBe(quoted);
        expect(unescape(escape(value))).toBe(unquoteLiteral(quoted, engine));
      }
      for (const raw of RAW_LITERALS) {
        expect(unescape(raw)).toBe(unquoteLiteral(raw, engine));
      }
    });
  }

  for (const [engine, quote] of IDENTIFIERS) {
    test(`${quote.name} answers as ${engine} does today`, () => {
      for (const name of IDENTIFIER_NAMES) {
        expect(quote(name)).toBe(quoteIdentifier(name, engine));
      }
    });
  }

  for (const [engine, placeholder] of PLACEHOLDERS) {
    test(`${placeholder.name} answers as ${engine} does today`, () => {
      for (const position of PLACEHOLDER_POSITIONS) {
        expect(placeholder(position)).toBe(positionalPlaceholder(engine, position) as string);
      }
    });
  }

  test("unquoteDoublingOnly reads a doubled quote and not a backslash escape", () => {
    expect(unquoteDoublingOnly("'a''b'")).toBe("a'b");
    expect(unquoteDoublingOnly("'a\\'b'")).toBeUndefined();
  });

  test("the inline edit type-name sets hold today's words", () => {
    expect([...INSTANT_TYPE_NAMES].sort()).toEqual([
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
    expect([...FLOAT64_TYPE_NAMES].sort()).toEqual(["binary_double", "double", "float64", "float8"]);
    expect([...EXACT_DECIMAL_TYPE_NAMES].sort()).toEqual([
      "dec",
      "decimal",
      "money",
      "number",
      "numeric",
      "smallmoney",
    ]);
  });

  test("unwrappedType lowers the type and takes its ClickHouse wrappers off", () => {
    expect(unwrappedType(" Nullable(DateTime64(6, 'UTC')) ")).toBe("datetime64(6, 'utc')");
    expect(unwrappedType("LowCardinality(Nullable(String))")).toBe("string");
  });

  test("firstWord reads the first word with its parameters off", () => {
    expect(firstWord("datetime64(6, 'utc')")).toBe("datetime64");
    expect(firstWord("timestamp(3) with time zone")).toBe("timestamp");
    expect(firstWord("character varying")).toBe("character");
  });
});

/** One engine of each binary literal form, with the literal it writes for `BYTES` and for no bytes. */
const BYTES = new Uint8Array([0x01, 0x02, 0xde, 0xad, 0xbe, 0xef]);
const NO_BYTES = new Uint8Array([]);

const BINARY_FORMS: ReadonlyArray<readonly [DatabaseType, (bytes: Uint8Array) => string, string, string]> = [
  ["postgres", binaryPgBytea, "'\\x0102deadbeef'::bytea", "'\\x'::bytea"],
  ["mssql", binaryZeroX, "0x0102deadbeef", "0x"],
  ["db2", binaryBinaryHex, "BX'0102deadbeef'", "BX''"],
  ["oracle", binaryHexToRaw, "HEXTORAW('0102deadbeef')", "HEXTORAW('')"],
  ["clickhouse", binaryUnhex, "unhex('0102deadbeef')", "unhex('')"],
  ["mysql", binaryStandardHex, "X'0102deadbeef'", "X''"],
  ["bigquery", binaryTextBackslash, "'\\\\x0102deadbeef'", "'\\\\x'"],
];

/** The literal today's INSERT export writes for a one-cell binary row on `dialect`. */
function exportedBinary(dialect: DatabaseType, bytes: Uint8Array): string | undefined {
  const { content } = buildResultExport("sql-insert", { rows: [{ b: bytes }], fields: ["b"], tabName: "t", dialect });
  return /VALUES \((.*)\);$/.exec(content)?.[1];
}

describe("SQL export shared building blocks", () => {
  for (const [engine, write, full, empty] of BINARY_FORMS) {
    test(`${write.name} writes what ${engine} writes today`, () => {
      expect(write(BYTES)).toBe(full);
      expect(write(NO_BYTES)).toBe(empty);
      expect(write(BYTES)).toBe(exportedBinary(engine, BYTES) as string);
      expect(write(NO_BYTES)).toBe(exportedBinary(engine, NO_BYTES) as string);
    });
  }

  test("the default tables hold today's values", () => {
    expect(STANDARD_DDL_TYPES).toEqual({
      text: "TEXT",
      integer: "BIGINT",
      numeric: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "BLOB",
    });
    expect(NULL_NON_FINITE).toEqual({ NaN: "NULL", Infinity: "NULL", "-Infinity": "NULL" });
    expect(NOTHING_STANDS_ALONE).toEqual([]);
    expect(NO_BARE_SPELLING).toEqual({});
    expect(QUOTED_WORD_NON_FINITE).toEqual({ NaN: "'NaN'", Infinity: "'Infinity'", "-Infinity": "'-Infinity'" });
  });

  test("the SQLite storage-class facts hold today's values", () => {
    expect(NO_INSTANT_TYPE_NAMES.size).toBe(0);
    expect(NO_EXACT_DECIMAL_TYPE_NAMES.size).toBe(0);
    expect(NO_INSTANT_TYPE_NAMES).not.toBe(NO_EXACT_DECIMAL_TYPE_NAMES);
    expect(EVERY_TYPE_IS_FLOAT64).toBe("all");
    const narrowedByAffinity = new Set(["enum", "set", "uniqueidentifier", "rowid"]);
    expect(VERBATIM_DECLARED_TYPES_STAND_ALONE).toEqual(
      Object.keys(BARE_TYPE_FAMILY).filter((name) => !narrowedByAffinity.has(name)),
    );
  });

  test("the standard type vocabulary is the four shared patterns", () => {
    expect(STANDARD_TYPE_VOCABULARY.bareTypeFamily).toBe(BARE_TYPE_FAMILY);
    expect(STANDARD_TYPE_VOCABULARY.floatType).toBe(FLOAT_TYPE);
    expect(STANDARD_TYPE_VOCABULARY.exactNumericType).toBe(EXACT_NUMERIC_TYPE);
    expect(STANDARD_TYPE_VOCABULARY.numericWrapper).toBe(CLICKHOUSE_WRAPPER);
  });

  test("the type vocabulary patterns read today's spellings", () => {
    expect(FLOAT_TYPE.test("binary_double")).toBe(true);
    expect(EXACT_NUMERIC_TYPE.test("decfloat")).toBe(true);
    expect(CLICKHOUSE_WRAPPER.exec("Nullable(Float64)")?.[1]).toBe("Float64");
  });

  test("the shared patterns fill an export spec's type vocabulary", () => {
    const vocabulary: ExportSpec["typeVocabulary"] = {
      bareTypeFamily: BARE_TYPE_FAMILY,
      floatType: FLOAT_TYPE,
      exactNumericType: EXACT_NUMERIC_TYPE,
      numericWrapper: CLICKHOUSE_WRAPPER,
    };
    expect(Object.keys(vocabulary.bareTypeFamily)).toHaveLength(42);
    expect(vocabulary.bareTypeFamily.varchar2).toBe("text");
    expect(vocabulary.bareTypeFamily.bytea).toBe("binary");
    expect(vocabulary.bareTypeFamily.money).toBe("numeric");
    expect(vocabulary.bareTypeFamily.datetimeoffset).toBe("timestamp");
    expect(vocabulary.bareTypeFamily.year).toBe("integer");
    expect(Object.hasOwn(vocabulary.bareTypeFamily, "bit")).toBe(false);
  });

  test("splitArguments splits at top-level commas only", () => {
    expect(splitArguments("'a,b' = 1, map<int, set<text>>, \"x,y\" INTEGER")).toEqual([
      "'a,b' = 1",
      "map<int, set<text>>",
      '"x,y" INTEGER',
    ]);
  });

  test("the export modules re-export the leaf's helpers rather than copies", () => {
    expect(jsonText).toBe(exportSharedJsonText);
    expect(asBytes).toBe(exportSharedAsBytes);
  });
});
