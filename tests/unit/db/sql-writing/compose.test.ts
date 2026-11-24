/**
 * Studio's SQL writing is composed when its module loads (docs/providers/CONTRACT.md, clause M-79): each engine's row
 * from the SQL writing its declaration authors, projected into src/lib/db/engine-catalog/sql-writing.generated.ts, and
 * Studio's SQL writing function table, `SQL_WRITING_FUNCTIONS`, which binds each function name the declaration gives.
 *
 * The census (tests/unit/db/engine-declarations.test.ts) reads every row back to its declaration fact by fact, and the
 * golden files hold what every reader answers from the rows; this file holds the composition itself: a null hook left
 * out, each type name list a set, each type pattern compiled once, every record frozen, and each name bound at its own
 * slot or refused by name. A type name set is read-only by its `ReadonlySet` type: freezing a Set does not stop its `add`.
 */
import { describe, expect, test } from "bun:test";
import { BUNDLED_SQL_WRITING } from "@/lib/db/engine-catalog/sql-writing.generated";
import type { SqlWritingEntry } from "@/lib/db/engine-catalog/projection";
import { MONGODB_INSERT_DOCUMENTS } from "@/lib/db/providers/document/mongodb/sql-writing";
import { CASSANDRA_CREATE_TABLE_KEY_CLAUSE } from "@/lib/db/providers/sql/cassandra/sql-writing";
import { cassandraLiteral, cqlFrozenNested } from "@/lib/db/providers/sql/cassandra/typed-literals";
import { MSSQL_BOUND_EDIT, MSSQL_TYPED_LITERAL } from "@/lib/db/providers/sql/mssql-sql-writing";
import {
  ORACLE_BOUND_EDIT,
  ORACLE_COLUMN_WRITERS,
  ORACLE_TEMPORAL_LITERAL,
} from "@/lib/db/providers/sql/oracle-sql-writing";
import { SNOWFLAKE_DECLARE_FROM_SAMPLE } from "@/lib/db/providers/sql/snowflake/sql-writing";
import { composeSqlWriting, SQL_WRITING, SQL_WRITING_FUNCTIONS, sqlWritingFor } from "@/lib/db/sql-writing";
import type { SqlWritingFunctions } from "@/lib/db/sql-writing";
import type { DatabaseType } from "@/lib/types";

const IDS = Object.keys(BUNDLED_SQL_WRITING) as DatabaseType[];

/**
 * Whether `value` is frozen with every object under it, a RegExp left as it is. A Set counts as its own object being
 * frozen, which does not stop its `add`; its members are held read-only by the `ReadonlySet` type, not here.
 */
function frozenThrough(value: unknown): boolean {
  if (typeof value !== "object" || value === null || value instanceof RegExp) return true;
  if (value instanceof Set) return Object.isFrozen(value);
  return Object.isFrozen(value) && Object.values(value).every(frozenThrough);
}

/** Each slot kind of the table, with the name an entry gives at that slot, or null where it fills none. */
const SLOT_NAMES: Readonly<Record<keyof SqlWritingFunctions, (entry: SqlWritingEntry) => string | null>> = {
  escapeLiterals: (entry) => entry.escapeLiteral,
  unescapeLiterals: (entry) => entry.unescapeLiteral,
  quoteIdentifiers: (entry) => entry.quoteIdentifier,
  placeholders: (entry) => entry.placeholder,
  temporalLiterals: (entry) => entry.temporalLiteral,
  insertDocuments: (entry) => entry.insertDocuments,
  boundEdits: (entry) => entry.inlineEdit.boundEdit,
  binaryLiterals: (entry) => entry.export.binaryLiteral,
  rewriteDeclareds: (entry) => entry.export.rewriteDeclared,
  declareFromSamples: (entry) => entry.export.declareFromSample,
  typedLiterals: (entry) => entry.export.typedLiteral,
  columnWriters: (entry) => entry.export.columnWriters,
  createTableKeyClauses: (entry) => entry.export.createTableKey?.clause ?? null,
};

/** Each slot kind of the table, with the function a composed row holds at that slot. */
const ROW_FUNCTIONS: Readonly<Record<keyof SqlWritingFunctions, (id: DatabaseType) => unknown>> = {
  escapeLiterals: (id) => SQL_WRITING[id].escapeLiteral,
  unescapeLiterals: (id) => SQL_WRITING[id].unescapeLiteral,
  quoteIdentifiers: (id) => SQL_WRITING[id].quoteIdentifier,
  placeholders: (id) => SQL_WRITING[id].placeholder,
  temporalLiterals: (id) => SQL_WRITING[id].temporalLiteral,
  insertDocuments: (id) => SQL_WRITING[id].insertDocuments,
  boundEdits: (id) => SQL_WRITING[id].inlineEdit.boundEdit,
  binaryLiterals: (id) => SQL_WRITING[id].export.binaryLiteral,
  rewriteDeclareds: (id) => SQL_WRITING[id].export.rewriteDeclared,
  declareFromSamples: (id) => SQL_WRITING[id].export.declareFromSample,
  typedLiterals: (id) => SQL_WRITING[id].export.typedLiteral,
  columnWriters: (id) => SQL_WRITING[id].export.columnWriters,
  createTableKeyClauses: (id) => SQL_WRITING[id].export.createTableKey?.clause,
};

describe("Studio's SQL writing, composed from the declarations", () => {
  test("each row is its declaration's SQL writing composed with Studio's SQL writing function table", () => {
    expect(Object.keys(SQL_WRITING)).toEqual(IDS);
    for (const id of IDS) {
      const entry = BUNDLED_SQL_WRITING[id];
      const row = SQL_WRITING[id];
      expect({ id, row }).toEqual({ id, row: composeSqlWriting(id, entry, SQL_WRITING_FUNCTIONS) });
      expect(sqlWritingFor(id)).toBe(row);
      // Each type name list a set in the declared order, `all` kept as itself.
      expect([...row.inlineEdit.instantTypeNames]).toEqual([...entry.inlineEdit.instantTypeNames]);
      expect([...row.inlineEdit.exactDecimalTypeNames]).toEqual([...entry.inlineEdit.exactDecimalTypeNames]);
      const float64 = row.inlineEdit.float64TypeNames;
      expect<unknown>(float64 === "all" ? "all" : [...float64]).toEqual(entry.inlineEdit.float64TypeNames);
      // The export's data as declared, the bare spellings and the bare type families as records.
      expect(row.export.ddlTypes).toEqual(entry.export.ddlTypes);
      expect(row.export.standsAlone).toEqual(entry.export.standsAlone);
      expect(row.export.nonFinite).toEqual(entry.export.nonFinite);
      expect(row.export.insertForm).toBe(entry.export.insertForm);
      expect(Object.entries(row.export.bareSpelling)).toEqual(
        entry.export.bareSpelling.map(({ name, spelling }) => [name, spelling]),
      );
      expect<unknown>(Object.entries(row.export.typeVocabulary.bareTypeFamily)).toEqual(
        Object.entries(entry.export.typeVocabulary.bareTypeFamily).flatMap(
          ([kind, names]: [string, readonly string[]]) => names.map((name) => [name, kind]),
        ),
      );
    }
  });

  test("a hook the declaration states as null is left out, and a placeholder or temporal literal stated as null is null", () => {
    const mysql = SQL_WRITING.mysql;
    expect(BUNDLED_SQL_WRITING.mysql.insertDocuments).toBeNull();
    expect(Object.keys(mysql)).toEqual([
      "escapeLiteral",
      "unescapeLiteral",
      "quoteIdentifier",
      "placeholder",
      "temporalLiteral",
      "inlineEdit",
      "export",
    ]);
    expect(Object.keys(mysql.inlineEdit)).toEqual(["instantTypeNames", "exactDecimalTypeNames", "float64TypeNames"]);
    expect(Object.keys(mysql.export)).toEqual([
      "ddlTypes",
      "standsAlone",
      "bareSpelling",
      "typeVocabulary",
      "binaryLiteral",
      "nonFinite",
      "insertForm",
    ]);
    expect(BUNDLED_SQL_WRITING.clickhouse.placeholder).toBeNull();
    expect(SQL_WRITING.clickhouse.placeholder).toBeNull();
    expect(SQL_WRITING.mysql.temporalLiteral).toBeNull();
    // Every hook stated by name is there, bound.
    expect(Object.keys(SQL_WRITING.cassandra.export)).toEqual([
      "ddlTypes",
      "standsAlone",
      "bareSpelling",
      "typeVocabulary",
      "binaryLiteral",
      "nonFinite",
      "insertForm",
      "rewriteDeclared",
      "typedLiteral",
      "createTableKey",
    ]);
    expect(SQL_WRITING.cassandra.export.createTableKey).toEqual({
      note: BUNDLED_SQL_WRITING.cassandra.export.createTableKey?.note ?? "",
      clause: CASSANDRA_CREATE_TABLE_KEY_CLAUSE,
    });
    expect(SQL_WRITING.mongodb.insertDocuments).toBe(MONGODB_INSERT_DOCUMENTS);
    expect(Object.keys(SQL_WRITING.oracle.inlineEdit)).toContain("boundEdit");
    // A composition of an entry stating every hook null leaves every hook out.
    const bare = composeSqlWriting(
      "oracle",
      {
        ...BUNDLED_SQL_WRITING.oracle,
        temporalLiteral: null,
        inlineEdit: { ...BUNDLED_SQL_WRITING.oracle.inlineEdit, boundEdit: null },
        export: { ...BUNDLED_SQL_WRITING.oracle.export, columnWriters: null, typedLiteral: null },
      },
      SQL_WRITING_FUNCTIONS,
    );
    expect(bare.temporalLiteral).toBeNull();
    expect(Object.hasOwn(bare.inlineEdit, "boundEdit")).toBe(false);
    expect(Object.hasOwn(bare.export, "columnWriters")).toBe(false);
    expect(Object.hasOwn(bare.export, "typedLiteral")).toBe(false);
  });

  test("each type pattern is compiled once, when its row is composed", () => {
    const declared = BUNDLED_SQL_WRITING.clickhouse.export.typeVocabulary;
    const vocabulary = SQL_WRITING.clickhouse.export.typeVocabulary;
    for (const member of ["floatType", "exactNumericType", "numericWrapper"] as const) {
      expect(vocabulary[member]).toBeInstanceOf(RegExp);
      expect({ source: vocabulary[member].source, flags: vocabulary[member].flags }).toEqual(declared[member]);
    }
    // The same objects on every read.
    expect(sqlWritingFor("clickhouse").export.typeVocabulary.numericWrapper).toBe(vocabulary.numericWrapper);
    // A composition compiles its own.
    const again = composeSqlWriting("clickhouse", BUNDLED_SQL_WRITING.clickhouse, SQL_WRITING_FUNCTIONS);
    expect(again.export.typeVocabulary.numericWrapper).not.toBe(vocabulary.numericWrapper);
    expect(again.export.typeVocabulary.numericWrapper).toEqual(vocabulary.numericWrapper);
  });

  test("every declared bare type name is its own entry of the bare type families, `__proto__` included", () => {
    const declared = BUNDLED_SQL_WRITING.postgres;
    const vocabulary = declared.export.typeVocabulary;
    const composed = composeSqlWriting(
      "postgres",
      {
        ...declared,
        export: {
          ...declared.export,
          typeVocabulary: {
            ...vocabulary,
            bareTypeFamily: { ...vocabulary.bareTypeFamily, text: [...vocabulary.bareTypeFamily.text, "__proto__"] },
          },
        },
      },
      SQL_WRITING_FUNCTIONS,
    );
    const families = composed.export.typeVocabulary.bareTypeFamily;
    expect(Object.hasOwn(families, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(families, "__proto__")?.value).toBe("text");
    expect(Object.getPrototypeOf(families)).toBe(Object.prototype);
  });

  test("the rows and their records are frozen", () => {
    expect(Object.isFrozen(SQL_WRITING)).toBe(true);
    for (const id of IDS) {
      expect({ id, frozen: frozenThrough(SQL_WRITING[id]) }).toEqual({ id, frozen: true });
    }
    // A type pattern is a RegExp, left unfrozen: its lastIndex is the engine's to write.
    expect(Object.isFrozen(SQL_WRITING.postgres.export.typeVocabulary.floatType)).toBe(false);
  });

  test("a function name Studio holds none for is refused by name at its slot, a name it holds only at another slot included", () => {
    const mysql = BUNDLED_SQL_WRITING.mysql;
    expect(() =>
      composeSqlWriting(
        "mysql",
        { ...mysql, export: { ...mysql.export, typedLiteral: "typedLiteral" } },
        SQL_WRITING_FUNCTIONS,
      ),
    ).toThrow('mysql names the function "typedLiteral", which Studio holds no function for.');
    const postgres = BUNDLED_SQL_WRITING.postgres;
    expect(() =>
      composeSqlWriting("postgres", { ...postgres, escapeLiteral: "binaryLiteral" }, SQL_WRITING_FUNCTIONS),
    ).toThrow('postgres names the function "binaryLiteral", which Studio holds no function for.');
    expect(() =>
      composeSqlWriting("postgres", { ...postgres, quoteIdentifier: "toString" }, SQL_WRITING_FUNCTIONS),
    ).toThrow('postgres names the function "toString", which Studio holds no function for.');
    const cassandra = BUNDLED_SQL_WRITING.cassandra;
    expect(() =>
      composeSqlWriting(
        "cassandra",
        { ...cassandra, export: { ...cassandra.export, createTableKey: { note: "", clause: "typedLiteral" } } },
        SQL_WRITING_FUNCTIONS,
      ),
    ).toThrow('cassandra names the function "typedLiteral", which Studio holds no function for.');
  });

  test("Studio's SQL writing function table holds exactly the functions the committed declarations name, each at its own slot", () => {
    const tableNames = (table: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>) =>
      Object.fromEntries(Object.entries(table).map(([id, slots]) => [id, Object.keys(slots ?? {})]));
    expect(Object.keys(SQL_WRITING_FUNCTIONS)).toEqual(Object.keys(SLOT_NAMES));
    for (const kind of Object.keys(SLOT_NAMES) as (keyof SqlWritingFunctions)[]) {
      const named = Object.fromEntries(
        IDS.flatMap((id) => {
          const name = SLOT_NAMES[kind](BUNDLED_SQL_WRITING[id]);
          return name === null ? [] : [[id, [name]]];
        }),
      );
      expect({ kind, names: tableNames(SQL_WRITING_FUNCTIONS[kind]) }).toEqual({ kind, names: named });
      // Each row runs, at the slot, the very function the table binds there.
      for (const [id, slots] of Object.entries(SQL_WRITING_FUNCTIONS[kind]) as [DatabaseType, object][]) {
        expect({ kind, id, bound: ROW_FUNCTIONS[kind](id) === Object.values(slots)[0] }).toEqual({
          kind,
          id,
          bound: true,
        });
      }
    }
    // 198 bindings, 17 of them an engine's own function.
    const bindings = Object.values(SQL_WRITING_FUNCTIONS).flatMap((table) => Object.keys(table));
    expect(bindings.length).toBe(198);
    expect(SQL_WRITING_FUNCTIONS.insertDocuments.mongodb?.insertDocuments).toBe(MONGODB_INSERT_DOCUMENTS);
    expect(SQL_WRITING_FUNCTIONS.createTableKeyClauses.cassandra?.createTableKeyClause).toBe(
      CASSANDRA_CREATE_TABLE_KEY_CLAUSE,
    );
    expect(SQL_WRITING_FUNCTIONS.rewriteDeclareds.cassandra?.rewriteDeclared).toBe(cqlFrozenNested);
    expect(SQL_WRITING_FUNCTIONS.typedLiterals.cassandra?.typedLiteral).toBe(cassandraLiteral);
    expect(SQL_WRITING_FUNCTIONS.boundEdits.mssql?.boundEdit).toBe(MSSQL_BOUND_EDIT);
    expect(SQL_WRITING_FUNCTIONS.typedLiterals.mssql?.typedLiteral).toBe(MSSQL_TYPED_LITERAL);
    expect(SQL_WRITING_FUNCTIONS.temporalLiterals.oracle?.temporalLiteral).toBe(ORACLE_TEMPORAL_LITERAL);
    expect(SQL_WRITING_FUNCTIONS.boundEdits.oracle?.boundEdit).toBe(ORACLE_BOUND_EDIT);
    expect(SQL_WRITING_FUNCTIONS.columnWriters.oracle?.columnWriters).toBe(ORACLE_COLUMN_WRITERS);
    expect(SQL_WRITING_FUNCTIONS.declareFromSamples.snowflake?.declareFromSample).toBe(SNOWFLAKE_DECLARE_FROM_SAMPLE);
    expect(frozenThrough(SQL_WRITING_FUNCTIONS)).toBe(true);
  });
});
