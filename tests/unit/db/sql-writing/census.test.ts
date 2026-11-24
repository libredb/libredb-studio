import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_SQL_WRITING } from "@/lib/db/engine-catalog/sql-writing.generated";
import { composeSqlWriting, SQL_WRITING, SQL_WRITING_FUNCTIONS, sqlWritingFor } from "@/lib/db/sql-writing";
import { NO_CONNECTION_SQL_WRITING } from "@/lib/db/sql-writing/no-connection";
import {
  binaryBinaryHex,
  binaryHexToRaw,
  binaryPgBytea,
  binaryStandardHex,
  binaryTextBackslash,
  binaryUnhex,
  binaryZeroX,
} from "@/lib/db/sql-writing/export-shared";
import * as SHARED from "@/lib/db/sql-writing/shared";
import {
  BARE_TYPE_FAMILY,
  CLICKHOUSE_WRAPPER,
  EXACT_DECIMAL_TYPE_NAMES,
  EXACT_NUMERIC_TYPE,
  FLOAT64_TYPE_NAMES,
  FLOAT_TYPE,
  INSTANT_TYPE_NAMES,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  literalBackslash,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
} from "@/lib/db/sql-writing/shared";
import type { ExportSpec, InferredKind, SqlWritingSpec } from "@/lib/db/sql-writing/types";
import { buildResultExport } from "@/lib/export/result-export";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";
import { TYPED_LITERAL_MODULES } from "./engine-modules";

/** A pattern as its source and flags, the form a declaration states it in. */
const patternOf = ({ source, flags }: RegExp) => ({ source, flags });

describe("SQL writing census", () => {
  test("one row per shipped type id", () => {
    expect(Object.keys(SQL_WRITING).sort()).toEqual([...EXTERNAL_DATABASE_TYPES, "libredb"].sort());
    expect(Object.keys(BUNDLED_SQL_WRITING).sort()).toEqual(Object.keys(SQL_WRITING).sort());
  });

  test("the registry is frozen", () => {
    expect(Object.isFrozen(SQL_WRITING)).toBe(true);
  });

  for (const type of Object.keys(SQL_WRITING) as DatabaseType[]) {
    test(`${type}: the row is its declaration's SQL writing composed with Studio's SQL writing function table`, () => {
      expect(SQL_WRITING[type]).toEqual(composeSqlWriting(type, BUNDLED_SQL_WRITING[type], SQL_WRITING_FUNCTIONS));
    });
  }

  test("every row is its own object", () => {
    const rows = Object.values(SQL_WRITING);
    expect(new Set(rows).size).toBe(rows.length);
  });

  test("no connection reads the named no-connection spec", () => {
    expect(sqlWritingFor(undefined)).toBe(NO_CONNECTION_SQL_WRITING);
  });

  // Only `undefined` is no connection (FND-1, Q6): the empty string a published component's
  // `databaseType?: string` can carry and a JS caller's `null` are refused like any other value outside the union.
  test.each(OUTSIDE_THE_UNION)("sqlWritingFor refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => sqlWritingFor(value as string))).toEqual(refusalOf(value));
  });

  test("a member of the union reads its row", () => {
    expect(sqlWritingFor("postgres")).toBe(SQL_WRITING.postgres);
  });

  // Every engine but the two that embed SQLite declares the shared type-name words, and the
  // no-connection spec reads the shared sets, because before the contract a type outside the
  // dialect sets read those sets.
  const NO_DECLARED_KINDS = new Set(["sqlite", "libsql"]);
  const SHARED_SET_ROWS: readonly (readonly [string, SqlWritingSpec])[] = [
    ...Object.entries(SQL_WRITING).filter(([id]) => !NO_DECLARED_KINDS.has(id)),
    ["no connection", NO_CONNECTION_SQL_WRITING],
  ];

  for (const [name, spec] of SHARED_SET_ROWS) {
    test(`${name}: the inline edit reads the shared type-name words`, () => {
      const { instantTypeNames, exactDecimalTypeNames, float64TypeNames } = spec.inlineEdit;
      expect([...instantTypeNames]).toEqual([...INSTANT_TYPE_NAMES]);
      expect([...exactDecimalTypeNames]).toEqual([...EXACT_DECIMAL_TYPE_NAMES]);
      expect(float64TypeNames === "all" ? "all" : [...float64TypeNames]).toEqual([...FLOAT64_TYPE_NAMES]);
    });
  }

  test.each(["sqlite", "libsql"] as const)(
    "%s: no declaration names an instant or exact decimal, and every key is float64",
    (id) => {
      const inlineEdit = SQL_WRITING[id].inlineEdit;
      expect(inlineEdit.instantTypeNames.size).toBe(0);
      expect(inlineEdit.exactDecimalTypeNames.size).toBe(0);
      expect(inlineEdit.float64TypeNames).toBe("all");
    },
  );

  test("only mssql and oracle bind an edit through their own form", () => {
    const bound = Object.entries(SQL_WRITING)
      .filter(([, spec]) => spec.inlineEdit.boundEdit !== undefined)
      .map(([id]) => id)
      .sort();
    expect(bound).toEqual(["mssql", "oracle"]);
    expect(NO_CONNECTION_SQL_WRITING.inlineEdit.boundEdit).toBeUndefined();
  });
});

// The expected lists are copied as data from the tables `src/lib/export/result-export.ts`
// read before each engine stated its export facts: `DIALECT_TYPES`, `STANDS_ALONE`,
// `DIALECT_BARE_SPELLING`, `BINARY_LITERAL`, `NON_FINITE_LITERALS`, `INSERT_SELECT_DIALECTS`,
// `TYPED_WRITERS`, `DECLARED_TYPE_REWRITE` and the snowflake, oracle and cassandra branches.
const TODAY_DDL_OVERRIDES: Readonly<Partial<Record<DatabaseType, Partial<Record<InferredKind, string>>>>> = {
  postgres: { binary: "BYTEA" },
  mysql: { numeric: "DOUBLE", timestamp: "DATETIME" },
  clickhouse: { binary: "String" },
  trino: { text: "VARCHAR", binary: "VARBINARY" },
  cassandra: { numeric: "DOUBLE" },
  db2: { text: "CLOB" },
  databend: { text: "VARCHAR", numeric: "DOUBLE", binary: "BINARY" },
  snowflake: { numeric: "FLOAT", binary: "BINARY" },
  oracle: { text: "VARCHAR2(4000)", integer: "NUMBER(19)", numeric: "BINARY_DOUBLE", boolean: "NUMBER(1)" },
  mssql: {
    text: "NVARCHAR(MAX)",
    numeric: "FLOAT",
    boolean: "BIT",
    timestamp: "DATETIME2",
    binary: "VARBINARY(MAX)",
  },
  spark: { text: "STRING", numeric: "DOUBLE", binary: "BINARY" },
};

const STANDS_ALONE_IDS: readonly DatabaseType[] = [
  "postgres",
  "mysql",
  "oracle",
  "mssql",
  "sqlite",
  "libsql",
  "clickhouse",
  "duckdb",
  "trino",
  "cassandra",
  "databend",
];

const TODAY_BARE_SPELLING: Readonly<Partial<Record<DatabaseType, Readonly<Record<string, string>>>>> = {
  postgres: { bit: "bit varying" },
  mysql: { bit: "bit(64)", datetime: "datetime(6)", timestamp: "timestamp(6)", time: "time(6)" },
};

const BINARY_FORM: Readonly<Partial<Record<DatabaseType, ExportSpec["binaryLiteral"]>>> = {
  postgres: binaryPgBytea,
  mssql: binaryZeroX,
  cassandra: binaryZeroX,
  oracle: binaryHexToRaw,
  db2: binaryBinaryHex,
  duckdb: binaryUnhex,
  clickhouse: binaryUnhex,
  databend: binaryUnhex,
  bigquery: binaryTextBackslash,
  couchbase: binaryTextBackslash,
};

const TODAY_NON_FINITE: Readonly<Partial<Record<DatabaseType, ExportSpec["nonFinite"]>>> = {
  postgres: { NaN: "'NaN'", Infinity: "'Infinity'", "-Infinity": "'-Infinity'" },
  duckdb: { NaN: "'NaN'", Infinity: "'Infinity'", "-Infinity": "'-Infinity'" },
  sqlite: { NaN: "NULL", Infinity: "9e999", "-Infinity": "-9e999" },
  oracle: { NaN: "BINARY_DOUBLE_NAN", Infinity: "BINARY_DOUBLE_INFINITY", "-Infinity": "-BINARY_DOUBLE_INFINITY" },
  databend: { NaN: "'NaN'::FLOAT", Infinity: "'inf'::DOUBLE", "-Infinity": "'-inf'::FLOAT" },
  snowflake: { NaN: "'NaN'::FLOAT", Infinity: "'inf'::FLOAT", "-Infinity": "'-inf'::FLOAT" },
  clickhouse: { NaN: "nan", Infinity: "inf", "-Infinity": "-inf" },
  spark: {
    NaN: "CAST('NaN' AS DOUBLE)",
    Infinity: "CAST('Infinity' AS DOUBLE)",
    "-Infinity": "CAST('-Infinity' AS DOUBLE)",
  },
};

const HOOKS: Readonly<Record<string, readonly DatabaseType[]>> = {
  typedLiteral: ["cassandra", "clickhouse", "databend", "duckdb", "mssql", "postgres", "snowflake", "spark", "trino"],
  rewriteDeclared: ["cassandra"],
  declareFromSample: ["snowflake"],
  columnWriters: ["oracle"],
  createTableKey: ["cassandra"],
};

describe("SQL export census", () => {
  const rows = Object.entries(SQL_WRITING) as [DatabaseType, SqlWritingSpec][];

  for (const [id, spec] of rows) {
    test(`${id}: the DDL type spellings are today's`, () => {
      const override = TODAY_DDL_OVERRIDES[id];
      expect(spec.export.ddlTypes).toEqual({ ...STANDARD_DDL_TYPES, ...override });
    });

    test(`${id}: the bare names standing alone are today's`, () => {
      if (STANDS_ALONE_IDS.includes(id)) {
        expect(spec.export.standsAlone.length).toBeGreaterThan(0);
      } else {
        expect(spec.export.standsAlone).toEqual([]);
      }
    });

    test(`${id}: the bare spellings are today's`, () => {
      const today = TODAY_BARE_SPELLING[id];
      expect(spec.export.bareSpelling).toEqual(today ?? {});
    });

    test(`${id}: the type vocabulary is the shared words and patterns`, () => {
      const vocabulary = spec.export.typeVocabulary;
      expect(vocabulary.bareTypeFamily).toEqual(BARE_TYPE_FAMILY);
      expect(patternOf(vocabulary.floatType)).toEqual(patternOf(FLOAT_TYPE));
      expect(patternOf(vocabulary.exactNumericType)).toEqual(patternOf(EXACT_NUMERIC_TYPE));
      expect(patternOf(vocabulary.numericWrapper)).toEqual(patternOf(CLICKHOUSE_WRAPPER));
    });

    test(`${id}: the binary literal is today's form`, () => {
      expect(spec.export.binaryLiteral).toBe(BINARY_FORM[id] ?? binaryStandardHex);
    });

    test(`${id}: the non-finite literals are today's`, () => {
      const today = TODAY_NON_FINITE[id];
      expect(spec.export.nonFinite).toEqual(today ?? NULL_NON_FINITE);
    });
  }

  // A typed writer names its engine's escape rather than reading its row, so the two are held equal here:
  // an engine whose escape changed would otherwise keep the old one in its typed cells and binary literals.
  for (const { ownerId, absPath, repoPath } of TYPED_LITERAL_MODULES) {
    test(`${repoPath}: quotes with its engine's own escape`, () => {
      const imported = [
        ...readFileSync(absPath, "utf8").matchAll(/import \{([^}]*)\} from "@\/lib\/db\/sql-writing\/shared";/g),
      ].flatMap((match) =>
        match[1]
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      );
      const spec = SQL_WRITING[ownerId as DatabaseType];
      for (const name of imported) {
        const used = (SHARED as Record<string, unknown>)[name];
        if (name.startsWith("literal"))
          expect({ name, same: used === spec.escapeLiteral }).toEqual({ name, same: true });
        if (name.startsWith("identifier")) {
          expect({ name, same: used === spec.quoteIdentifier }).toEqual({ name, same: true });
        }
      }
    });
  }

  test("an engine writing binary as backslash-escaped text escapes its literals the same way", () => {
    const backslashText = rows.filter(([, spec]) => spec.export.binaryLiteral === binaryTextBackslash);
    expect(backslashText.map(([id]) => id).sort()).toEqual(["bigquery", "couchbase"]);
    for (const [id, spec] of backslashText) {
      expect({ id, same: spec.escapeLiteral === literalBackslash }).toEqual({ id, same: true });
    }
  });

  test.each(["sqlite", "libsql"] as const)(
    "%s: keeps every declared type verbatim, the shared bare type names but the four the affinity narrows",
    (id) => {
      const narrowed = ["enum", "set", "uniqueidentifier", "rowid"];
      expect(SQL_WRITING[id].export.standsAlone).toEqual(
        Object.keys(BARE_TYPE_FAMILY).filter((name) => !narrowed.includes(name)),
      );
    },
  );

  test.each(["postgres", "duckdb"] as const)("%s: writes the quoted non-finite words", (id) => {
    expect(SQL_WRITING[id].export.nonFinite).toEqual({
      NaN: "'NaN'",
      Infinity: "'Infinity'",
      "-Infinity": "'-Infinity'",
    });
  });

  test("only snowflake writes its INSERT as a SELECT", () => {
    const select = rows.filter(([, spec]) => spec.export.insertForm === "select").map(([id]) => id);
    expect(select).toEqual(["snowflake"]);
    for (const [, spec] of rows) expect(["values", "select"]).toContain(spec.export.insertForm);
  });

  for (const [hook, ids] of Object.entries(HOOKS)) {
    test(`exactly ${ids.join(", ")} define ${hook}`, () => {
      const defining = rows
        .filter(([, spec]) => (spec.export as unknown as Record<string, unknown>)[hook] !== undefined)
        .map(([id]) => id)
        .sort();
      expect(defining).toEqual([...ids].sort());
    });
  }

  test.each([["no connection", NO_CONNECTION_SQL_WRITING]] as const)(
    "%s: the export is the shared defaults with no hook",
    (_name, spec) => {
      expect(spec.export.ddlTypes).toBe(STANDARD_DDL_TYPES);
      expect(spec.export.standsAlone).toBe(NOTHING_STANDS_ALONE);
      expect(spec.export.bareSpelling).toBe(NO_BARE_SPELLING);
      expect(spec.export.typeVocabulary).toBe(STANDARD_TYPE_VOCABULARY);
      expect(spec.export.typeVocabulary.bareTypeFamily).toBe(BARE_TYPE_FAMILY);
      expect(spec.export.typeVocabulary.floatType).toBe(FLOAT_TYPE);
      expect(spec.export.typeVocabulary.exactNumericType).toBe(EXACT_NUMERIC_TYPE);
      expect(spec.export.typeVocabulary.numericWrapper).toBe(CLICKHOUSE_WRAPPER);
      expect(spec.export.binaryLiteral).toBe(binaryStandardHex);
      expect(spec.export.nonFinite).toBe(NULL_NON_FINITE);
      expect(spec.export.insertForm).toBe("values");
      for (const hook of Object.keys(HOOKS)) {
        expect((spec.export as unknown as Record<string, unknown>)[hook]).toBeUndefined();
      }
    },
  );

  // Spec 5.3 [T14]: the export reaches the registry through `sqlWritingFor`, so a key the
  // registry does not own is refused by name before any format is written (FND-1). Before the
  // registry each of these threw or wrote `[object Object]`; before FND-1 they wrote the
  // unknown-type defaults.
  test.each(
    OUTSIDE_THE_UNION.flatMap(([label, value]) =>
      (["sql-insert", "csv"] as const).map((format) => [label, format, value] as const),
    ),
  )("the export refuses %s by name, whatever the format (%s)", (_label, format, value) => {
    const call = () =>
      buildResultExport(format, { rows: [{ c: 1 }], fields: ["c"], dialect: value as DatabaseType, tabName: "t" });
    expect(refusalThrownBy(call)).toEqual(refusalOf(value));
  });

  // The hooks nothing reads until the export path does: each answers what today's code in
  // `result-export.ts` writes for the same cell or column.
  test("oracle's column writers write a declared date or timestamp through its conversion function", () => {
    const [date, zoned, text] =
      SQL_WRITING.oracle.export.columnWriters?.(["DATE", "TIMESTAMP(6) WITH TIME ZONE", "VARCHAR2"]) ?? [];
    expect(date?.("2026-09-01 10:30:00")).toBe("TO_DATE('2026-09-01 10:30:00', 'YYYY-MM-DD HH24:MI:SS')");
    expect(date?.("2026-09-01 10:30:00.5")).toBeUndefined();
    expect(zoned?.(new Date("2026-08-24T07:11:12.345Z"))).toBe(
      "FROM_TZ(TO_TIMESTAMP('2026-08-24 07:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC')",
    );
    expect(zoned?.("2026-08-24T07:11:12.345Z")).toBe(
      "FROM_TZ(TO_TIMESTAMP('2026-08-24 07:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC')",
    );
    expect(text?.("2026-09-01 10:30:00")).toBeUndefined();
    expect(text?.(5)).toBeUndefined();
  });

  test("snowflake declares a VECTOR column from its first value and nothing else", () => {
    const declare = SQL_WRITING.snowflake.export.declareFromSample;
    expect(declare?.(" vector ", "[1, 2, 3]")).toBe("VECTOR(INT, 3)");
    expect(declare?.("VECTOR", undefined)).toBe("ARRAY");
    expect(declare?.("NUMBER", 1)).toBeUndefined();
  });

  test("cassandra keys its CREATE TABLE on the first column under a note", () => {
    const key = SQL_WRITING.cassandra.export.createTableKey;
    expect(key?.clause(['"a"', '"b"'])).toBe('PRIMARY KEY ("a")');
    expect(key?.note.startsWith("-- CQL requires exactly one PRIMARY KEY per table")).toBe(true);
  });
});
