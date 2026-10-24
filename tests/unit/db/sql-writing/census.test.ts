import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { SQL_WRITING, sqlWritingFor } from "@/lib/db/sql-writing";
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
  EVERY_TYPE_IS_FLOAT64,
  EXACT_DECIMAL_TYPE_NAMES,
  EXACT_NUMERIC_TYPE,
  FLOAT64_TYPE_NAMES,
  FLOAT_TYPE,
  INSTANT_TYPE_NAMES,
  NO_BARE_SPELLING,
  NO_EXACT_DECIMAL_TYPE_NAMES,
  NO_INSTANT_TYPE_NAMES,
  NOTHING_STANDS_ALONE,
  literalBackslash,
  NULL_NON_FINITE,
  QUOTED_WORD_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  VERBATIM_DECLARED_TYPES_STAND_ALONE,
} from "@/lib/db/sql-writing/shared";
import { UNKNOWN_TYPE_SQL_WRITING } from "@/lib/db/sql-writing/unknown-type";
import type { ExportSpec, InferredKind, SqlWritingSpec } from "@/lib/db/sql-writing/types";
import type { DatabaseType } from "@/lib/types";
import { TYPED_LITERAL_MODULES } from "./engine-modules";
import { renderExportGolden } from "./export-fixtures";

/**
 * The SQL writing registry is one row per type id, and each row is the object the engine's
 * own module exports at its placement beside the provider (spec 5.3), so a reader of the
 * registry and a typed writer that imports the module directly hold the same rules.
 */
const PLACEMENT: Readonly<Record<DatabaseType, string>> = {
  bigquery: "sql/bigquery/sql-writing",
  cassandra: "sql/cassandra/sql-writing",
  clickhouse: "sql/clickhouse/sql-writing",
  couchbase: "document/couchbase/sql-writing",
  databend: "sql/databend/sql-writing",
  db2: "sql/db2/sql-writing",
  druid: "sql/druid/sql-writing",
  duckdb: "sql/duckdb/sql-writing",
  elasticsearch: "sql/search/elasticsearch-sql-writing",
  etcd: "keyvalue/etcd/sql-writing",
  firestore: "document/firestore/sql-writing",
  influxdb: "timeseries/influxdb/influxdb-sql-writing",
  influxdb3: "timeseries/influxdb/influxdb3-sql-writing",
  kafka: "stream/kafka/sql-writing",
  kubernetes: "platform/kubernetes/sql-writing",
  libredb: "embedded/libredb-sql-writing",
  libsql: "sql/libsql/sql-writing",
  milvus: "vector/milvus/sql-writing",
  modbus: "industrial/modbus/sql-writing",
  mongodb: "document/mongodb/sql-writing",
  mqtt: "keyvalue/mqtt/sql-writing",
  mssql: "sql/mssql-sql-writing",
  mtconnect: "industrial/mtconnect/sql-writing",
  mysql: "sql/mysql-sql-writing",
  neo4j: "graph/neo4j/sql-writing",
  netconf: "network/netconf/sql-writing",
  opcua: "industrial/opcua/sql-writing",
  opensearch: "sql/search/opensearch-sql-writing",
  oracle: "sql/oracle-sql-writing",
  oxia: "keyvalue/oxia/sql-writing",
  postgres: "sql/postgres-sql-writing",
  prometheus: "timeseries/prometheus/sql-writing",
  qdrant: "vector/qdrant/sql-writing",
  weaviate: "vector/weaviate/sql-writing",
  rabbitmq: "stream/rabbitmq/sql-writing",
  redis: "keyvalue/redis-sql-writing",
  s3: "objectstore/s3/sql-writing",
  snmp: "network/snmp/sql-writing",
  snowflake: "sql/snowflake/sql-writing",
  spark: "sql/spark/sql-writing",
  sparkplug: "industrial/sparkplug/sql-writing",
  sqlite: "sql/sqlite-sql-writing",
  trino: "sql/trino/sql-writing",
};

const exportName = (type: DatabaseType): string => `${type.toUpperCase()}_SQL_WRITING`;

describe("SQL writing census", () => {
  test("one row per shipped type id", () => {
    expect(Object.keys(SQL_WRITING).sort()).toEqual([...EXTERNAL_DATABASE_TYPES, "libredb"].sort());
    expect(Object.keys(PLACEMENT).sort()).toEqual(Object.keys(SQL_WRITING).sort());
  });

  test("the registry is frozen", () => {
    expect(Object.isFrozen(SQL_WRITING)).toBe(true);
  });

  for (const type of Object.keys(PLACEMENT) as DatabaseType[]) {
    test(`${type}: the row is the module at its placement`, async () => {
      const engineModule = (await import(`@/lib/db/providers/${PLACEMENT[type]}`)) as Record<string, unknown>;
      expect(engineModule[exportName(type)]).toBe(SQL_WRITING[type]);
    });
  }

  test("every row is its own object", () => {
    const rows = Object.values(SQL_WRITING);
    expect(new Set(rows).size).toBe(rows.length);
  });

  test("no connection reads the named no-connection spec", () => {
    expect(sqlWritingFor(undefined)).toBe(NO_CONNECTION_SQL_WRITING);
  });

  // Before the contract every writer tested `dialect ? ... : "standard"`, so the empty string a
  // published component's `databaseType?: string` can carry, and a JS caller's `null`, meant no connection.
  test.each(["", null])("%p reads the named no-connection spec", (type) => {
    expect(sqlWritingFor(type as string | undefined)).toBe(NO_CONNECTION_SQL_WRITING);
  });

  test.each(["constructor", "__proto__", "not-an-engine"])("%s reads the named unknown-type spec", (type) => {
    expect(sqlWritingFor(type)).toBe(UNKNOWN_TYPE_SQL_WRITING);
  });

  test("a member of the union reads its row", () => {
    expect(sqlWritingFor("postgres")).toBe(SQL_WRITING.postgres);
  });

  // Every engine but the two that embed SQLite reads the shared type-name sets, and so do
  // the two named specs, because before the contract a type outside the dialect sets, the
  // empty string and an unknown string all read those sets.
  const NO_DECLARED_KINDS = new Set(["sqlite", "libsql"]);
  const SHARED_SET_ROWS: readonly (readonly [string, SqlWritingSpec])[] = [
    ...Object.entries(SQL_WRITING).filter(([id]) => !NO_DECLARED_KINDS.has(id)),
    ["no connection", NO_CONNECTION_SQL_WRITING],
    ["unknown type", UNKNOWN_TYPE_SQL_WRITING],
  ];

  for (const [name, spec] of SHARED_SET_ROWS) {
    test(`${name}: the inline edit reads the shared type-name sets`, () => {
      expect(spec.inlineEdit.instantTypeNames).toBe(INSTANT_TYPE_NAMES);
      expect(spec.inlineEdit.exactDecimalTypeNames).toBe(EXACT_DECIMAL_TYPE_NAMES);
      expect(spec.inlineEdit.float64TypeNames).toBe(FLOAT64_TYPE_NAMES);
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

  test.each(["sqlite", "libsql"] as const)("%s: the inline edit reads the SQLite storage-class facts by name", (id) => {
    const inlineEdit = SQL_WRITING[id].inlineEdit;
    expect(inlineEdit.instantTypeNames).toBe(NO_INSTANT_TYPE_NAMES);
    expect(inlineEdit.exactDecimalTypeNames).toBe(NO_EXACT_DECIMAL_TYPE_NAMES);
    expect(inlineEdit.float64TypeNames).toBe(EVERY_TYPE_IS_FLOAT64);
  });

  test("only mssql and oracle bind an edit through their own form", () => {
    const bound = Object.entries(SQL_WRITING)
      .filter(([, spec]) => spec.inlineEdit.boundEdit !== undefined)
      .map(([id]) => id)
      .sort();
    expect(bound).toEqual(["mssql", "oracle"]);
    expect(NO_CONNECTION_SQL_WRITING.inlineEdit.boundEdit).toBeUndefined();
    expect(UNKNOWN_TYPE_SQL_WRITING.inlineEdit.boundEdit).toBeUndefined();
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
      if (override === undefined) {
        expect(spec.export.ddlTypes).toBe(STANDARD_DDL_TYPES);
      } else {
        expect(spec.export.ddlTypes).not.toBe(STANDARD_DDL_TYPES);
        expect(spec.export.ddlTypes).toEqual({ ...STANDARD_DDL_TYPES, ...override });
      }
    });

    test(`${id}: the bare names standing alone are today's`, () => {
      if (STANDS_ALONE_IDS.includes(id)) {
        expect(spec.export.standsAlone.length).toBeGreaterThan(0);
      } else {
        expect(spec.export.standsAlone).toBe(NOTHING_STANDS_ALONE);
      }
    });

    test(`${id}: the bare spellings are today's`, () => {
      const today = TODAY_BARE_SPELLING[id];
      if (today === undefined) expect(spec.export.bareSpelling).toBe(NO_BARE_SPELLING);
      else expect(spec.export.bareSpelling).toEqual(today);
    });

    test(`${id}: the type vocabulary is the shared set`, () => {
      expect(spec.export.typeVocabulary).toBe(STANDARD_TYPE_VOCABULARY);
      expect(spec.export.typeVocabulary.bareTypeFamily).toBe(BARE_TYPE_FAMILY);
      expect(spec.export.typeVocabulary.floatType).toBe(FLOAT_TYPE);
      expect(spec.export.typeVocabulary.exactNumericType).toBe(EXACT_NUMERIC_TYPE);
      expect(spec.export.typeVocabulary.numericWrapper).toBe(CLICKHOUSE_WRAPPER);
    });

    test(`${id}: the binary literal is today's form`, () => {
      expect(spec.export.binaryLiteral).toBe(BINARY_FORM[id] ?? binaryStandardHex);
    });

    test(`${id}: the non-finite literals are today's`, () => {
      const today = TODAY_NON_FINITE[id];
      if (today === undefined) expect(spec.export.nonFinite).toBe(NULL_NON_FINITE);
      else expect(spec.export.nonFinite).toEqual(today);
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

  test.each(["sqlite", "libsql"] as const)("%s: keeps every declared type verbatim, by the shared name", (id) => {
    expect(SQL_WRITING[id].export.standsAlone).toBe(VERBATIM_DECLARED_TYPES_STAND_ALONE);
  });

  test.each(["postgres", "duckdb"] as const)("%s: writes the quoted non-finite words, by the shared name", (id) => {
    expect(SQL_WRITING[id].export.nonFinite).toBe(QUOTED_WORD_NON_FINITE);
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

  test.each([
    ["no connection", NO_CONNECTION_SQL_WRITING],
    ["unknown type", UNKNOWN_TYPE_SQL_WRITING],
  ] as const)("%s: the export is the shared defaults with no hook", (_name, spec) => {
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
  });

  // Spec 5.3 [T14]: the export reaches the named specs through `sqlWritingFor`, so a key
  // the registry does not own writes what the committed `not-an-engine` golden pins. Before
  // the registry each of these threw or wrote `[object Object]` instead.
  test.each(["__proto__", "toString", "valueOf", "hasOwnProperty", "constructor", "POSTGRES", " postgres"])(
    "%s: the export writes what an unknown type writes",
    (type) => {
      expect(renderExportGolden(type)).toBe(renderExportGolden("not-an-engine"));
    },
  );

  test("null: the export writes what no connection writes", () => {
    expect(renderExportGolden(null as unknown as undefined)).toBe(renderExportGolden(undefined));
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
