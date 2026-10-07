import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  buildResultExport,
  deriveTableName,
  FALLBACK_TABLE_NAME,
  resultExportFileName,
} from "@/lib/export/result-export";

const source = (over: Partial<Parameters<typeof buildResultExport>[1]> = {}) => ({
  rows: [{ id: 1, name: "Ada" }],
  fields: ["id", "name"],
  tabName: "users",
  dialect: "postgres" as const,
  ...over,
});

describe("deriveTableName", () => {
  test("keeps a tab name that is already a bare identifier", () => {
    expect(deriveTableName("users")).toBe("users");
  });

  test("strips the generated tab prefix the studio writes", () => {
    expect(deriveTableName("Query: orders")).toBe("orders");
    expect(deriveTableName("Query 1")).toBe(FALLBACK_TABLE_NAME);
  });

  test("keeps a schema-qualified name", () => {
    expect(deriveTableName("public.users")).toBe("public.users");
  });

  test("refuses a name that would carry statement text into the file", () => {
    expect(deriveTableName("users; DROP TABLE secrets")).toBe(FALLBACK_TABLE_NAME);
    expect(deriveTableName('users" ("')).toBe(FALLBACK_TABLE_NAME);
  });

  test("refuses a name with a space rather than emitting broken SQL", () => {
    expect(deriveTableName("my table")).toBe(FALLBACK_TABLE_NAME);
  });

  test("falls back when the tab name is empty once the prefix is gone", () => {
    expect(deriveTableName("Query:  ")).toBe(FALLBACK_TABLE_NAME);
    expect(deriveTableName("")).toBe(FALLBACK_TABLE_NAME);
  });
});

describe("buildResultExport — csv", () => {
  test.each([";", "\t"] as const)("passes the chosen CSV delimiter to the shared writer (%s)", (csvDelimiter) => {
    const file = buildResultExport("csv", source({ csvDelimiter }));
    expect(file.content).toBe(`id${csvDelimiter}name\n1${csvDelimiter}Ada`);
    expect(file.extension).toBe("csv");
    expect(file.mimeType).toBe("text/csv;charset=utf-8");
  });
  test("writes an escaped CSV under the declared columns", () => {
    const file = buildResultExport("csv", source({ rows: [{ id: 1, name: 'A,"B"' }] }));

    expect(file.content).toBe('id,name\n1,"A,""B"""');
    expect(file.mimeType).toBe("text/csv;charset=utf-8");
    expect(file.extension).toBe("csv");
  });
});

describe("buildResultExport — json", () => {
  test("writes the rows as indented JSON", () => {
    const file = buildResultExport("json", source());

    expect(JSON.parse(file.content)).toEqual([{ id: 1, name: "Ada" }]);
    expect(file.mimeType).toBe("application/json");
    expect(file.extension).toBe("json");
  });

  // The CSV, the SQL forms and the grid all read a binary cell as `\x` hex; the JSON
  // wrote `{"type":"Buffer","data":[...]}`, so one result exported three ways
  // disagreed with itself (#1381). Measured 2026-10-03 on PostgreSQL 18.6 (`bytea`)
  // and on SQL Server (`varbinary`), whose cells both reach the browser in that form.
  test("writes a bytea or varbinary cell as the same text the CSV writes for it", () => {
    for (const dialect of ["postgres", "mssql", "mysql", "sqlite", "oracle"] as const) {
      const rows = [{ id: 1, payload: { type: "Buffer", data: [0xde, 0xad, 0xbe, 0xef, 0x00, 0xff] } }];
      const json = buildResultExport("json", source({ rows, fields: ["id", "payload"], dialect }));
      const csv = buildResultExport("csv", source({ rows, fields: ["id", "payload"], dialect }));

      expect(JSON.parse(json.content)).toEqual([{ id: 1, payload: "\\xdeadbeef00ff" }]);
      expect(csv.content).toBe("id,payload\n1,\\xdeadbeef00ff");
    }
  });

  test("writes a live Uint8Array the same way", () => {
    const rows = [{ payload: Uint8Array.from([0x00, 0xff]) }];

    expect(JSON.parse(buildResultExport("json", source({ rows, fields: ["payload"] })).content)).toEqual([
      { payload: "\\x00ff" },
    ]);
  });

  test("leaves a document that merely looks Buffer-shaped as JSON", () => {
    const rows = [{ doc: { type: "Buffer", data: [1, "two"] } }];

    expect(JSON.parse(buildResultExport("json", source({ rows, fields: ["doc"] })).content)).toEqual(rows);
  });
});

describe("buildResultExport — sql-insert", () => {
  test("quotes every column name, so an aliased column cannot break the statement", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{ "total count": 3 }], fields: ["total count"] }));

    expect(file.content).toBe('INSERT INTO users ("total count") VALUES (3);');
    expect(file.mimeType).toBe("text/sql");
    expect(file.extension).toBe("sql");
  });

  test("spells identifiers the way the dialect does", () => {
    const file = buildResultExport("sql-insert", source({ dialect: "mysql" }));

    expect(file.content).toBe("INSERT INTO users (`id`, `name`) VALUES (1, 'Ada');");
  });

  test("quotes a value through the dialect's own literal grammar", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{ id: 1, name: "O'Hara\\" }] }));

    expect(file.content).toContain("'O''Hara\\'");
  });

  test("writes an absent value as NULL", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{ id: null, name: undefined }] }));

    expect(file.content).toBe('INSERT INTO users ("id", "name") VALUES (NULL, NULL);');
  });

  test("writes a column the row does not carry as NULL instead of shifting the rest", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{ name: "Ada" }] }));

    expect(file.content).toBe('INSERT INTO users ("id", "name") VALUES (NULL, \'Ada\');');
  });

  test("writes numbers, bigints and booleans unquoted", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ rows: [{ a: 1.5, b: BigInt("9007199254740993"), c: true }], fields: ["a", "b", "c"] }),
    );

    expect(file.content).toContain("VALUES (1.5, 9007199254740993, true);");
  });

  // NaN is not a SQL number literal, and NULL is a different value. The quoted word is
  // what PostgreSQL reads back into a float column, and it is the same text the cell
  // carries when it arrived over HTTP, where the server already wrote it as a word.
  test("writes a non-finite number as its quoted word, not as NULL", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ rows: [{ a: NaN, b: Infinity, c: -Infinity }], fields: ["a", "b", "c"] }),
    );

    expect(file.content).toContain("VALUES ('NaN', 'Infinity', '-Infinity');");
  });

  // Each spelling was replayed into its engine: SQLite stores a quoted 'Infinity' as
  // TEXT and has no NaN, Oracle reads its own constants into BINARY_DOUBLE.
  test.each([
    ["sqlite", "VALUES (NULL, 9e999, -9e999);"],
    ["oracle", "VALUES (BINARY_DOUBLE_NAN, BINARY_DOUBLE_INFINITY, -BINARY_DOUBLE_INFINITY);"],
    ["duckdb", "VALUES ('NaN', 'Infinity', '-Infinity');"],
    ["mysql", "VALUES (NULL, NULL, NULL);"],
    ["mssql", "VALUES (NULL, NULL, NULL);"],
    [undefined, "VALUES (NULL, NULL, NULL);"],
  ] as const)("writes a non-finite number the way %s reads it back", (dialect, expected) => {
    const file = buildResultExport(
      "sql-insert",
      source({ rows: [{ a: NaN, b: Infinity, c: -Infinity }], fields: ["a", "b", "c"], dialect }),
    );

    expect(file.content).toContain(expected);
  });

  // Over HTTP the server sends the words as strings, which are floats only where the
  // column was declared one; a text column may hold the word itself.
  test("writes a non-finite word as a float only in a column declared as a float", () => {
    const file = buildResultExport(
      "sql-insert",
      source({
        rows: [{ f: "Infinity", d: "-Infinity", r: "NaN", t: "Infinity" }],
        fields: ["f", "d", "r", "t"],
        dialect: "sqlite",
        columnTypes: { f: "REAL", d: " double precision ", r: "FLOAT", t: "TEXT" },
      }),
    );

    expect(file.content).toContain("VALUES (9e999, -9e999, NULL, 'Infinity');");
  });

  test("leaves a word in a column whose declared type is not a string as text", () => {
    const file = buildResultExport(
      "sql-insert",
      source({
        rows: [{ f: "NaN" }],
        fields: ["f"],
        dialect: "sqlite",
        columnTypes: { f: 7 } as unknown as Record<string, string>,
      }),
    );

    expect(file.content).toContain("VALUES ('NaN');");
  });

  test("writes a non-finite number as JSON and CSV words too", () => {
    const rows = [{ a: NaN, b: Infinity, c: -Infinity }];
    const fields = ["a", "b", "c"];

    expect(JSON.parse(buildResultExport("json", source({ rows, fields })).content)).toEqual([
      { a: "NaN", b: "Infinity", c: "-Infinity" },
    ]);
    // `-Infinity` opens with a formula lead and is not a plain number, so the CSV formula
    // guard prefixes it the way it does PostgreSQL's `numeric` text `-Infinity`.
    expect(buildResultExport("csv", source({ rows, fields })).content).toBe('a,b,c\nNaN,Infinity,"\'-Infinity"');
  });

  test("writes a date as an ISO literal rather than as a locale string", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ rows: [{ at: new Date("2026-08-17T06:31:49.000Z") }], fields: ["at"] }),
    );

    expect(file.content).toContain("VALUES ('2026-08-17T06:31:49.000Z');");
  });

  test("writes a structured value as JSON rather than as [object Object]", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{ meta: { a: 1 } }], fields: ["meta"] }));

    expect(file.content).toContain(`VALUES ('{"a":1}');`);
  });

  test("writes one statement per row", () => {
    const file = buildResultExport(
      "sql-insert",
      source({
        rows: [
          { id: 1, name: "Ada" },
          { id: 2, name: "Ben" },
        ],
      }),
    );

    expect(file.content.split("\n")).toHaveLength(2);
  });

  // A 0-byte file is not wrong, it is unexplained: the user asked for an export and
  // got something they cannot tell apart from a failed one. A comment is valid SQL
  // everywhere and says which of the two happened.
  test("says so in a SQL comment when there are no rows to write", () => {
    const file = buildResultExport("sql-insert", source({ rows: [] }));

    expect(file.content).toBe("-- No rows to export.");
  });

  test("says so when the result declares no columns at all", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{}], fields: [] }));

    expect(file.content).toBe("-- No columns to export.");
  });
});

describe("buildResultExport — sql-ddl", () => {
  test("types each column from the first row that actually carries a value", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({
        rows: [
          { id: null, score: null, ok: null, at: null },
          { id: 4, score: 1.5, ok: true, at: new Date("2026-08-17T00:00:00.000Z") },
        ],
        fields: ["id", "score", "ok", "at"],
      }),
    );

    expect(file.content).toBe(
      'CREATE TABLE users (\n  "id" BIGINT,\n  "score" DOUBLE PRECISION,\n  "ok" BOOLEAN,\n  "at" TIMESTAMP\n);',
    );
  });

  test("falls back to TEXT for a column that is null in every row", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [{ note: null }], fields: ["note"] }));

    expect(file.content).toContain('"note" TEXT');
  });

  test("types a bigint as an integer column", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [{ n: BigInt(10) }], fields: ["n"] }));

    expect(file.content).toContain('"n" BIGINT');
  });

  test("quotes column names for the dialect", () => {
    const file = buildResultExport("sql-ddl", source({ dialect: "mssql" }));

    expect(file.content).toContain("[id] BIGINT");
    expect(file.content).toContain("[name] NVARCHAR(MAX)");
  });

  test("uses the fallback table name when the tab name cannot be one", () => {
    const file = buildResultExport("sql-ddl", source({ tabName: "Query 3" }));

    expect(file.content).toContain(`CREATE TABLE ${FALLBACK_TABLE_NAME} (`);
  });
});

describe("buildResultExport — columns", () => {
  test("falls back to the rows' own keys when the result declared no fields", () => {
    const file = buildResultExport("csv", source({ fields: [], rows: [{ a: 1 }, { b: 2 }] }));

    expect(file.content).toBe("a,b\n1,\n,2");
  });
});

describe("buildResultExport — a DDL type the engine can actually parse", () => {
  // The statement is meant to be run against the engine it was read from, and half
  // of these dialects reject the generic set: Oracle has no TEXT and no BOOLEAN
  // before 23c, SQL Server has no BOOLEAN at all, and a bare NUMERIC on MySQL is
  // DECIMAL(10,0) — which silently truncates every decimal it was chosen for.
  const row = { t: "x", i: 4, n: 1.5, b: true, at: new Date("2026-08-17T00:00:00.000Z") };
  const fields = ["t", "i", "n", "b", "at"];

  test("spells every inferred type the way Oracle does", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [row], fields, dialect: "oracle" }));

    expect(file.content).toContain('"t" VARCHAR2(4000)');
    expect(file.content).toContain('"i" NUMBER(19)');
    expect(file.content).toContain('"n" BINARY_DOUBLE');
    expect(file.content).toContain('"b" NUMBER(1)');
    expect(file.content).toContain('"at" TIMESTAMP');
  });

  test("spells text the way Db2 takes it back, and keeps the standard spellings it accepts (#786)", () => {
    // Measured on Db2 12.1.0.0: TEXT is SQL0204N "TEXT" is an undefined name, while BIGINT,
    // DOUBLE PRECISION, BOOLEAN and TIMESTAMP are whole Db2 types.
    const file = buildResultExport("sql-ddl", source({ rows: [row], fields, dialect: "db2" }));

    expect(file.content).toContain('"t" CLOB');
    expect(file.content).not.toContain("TEXT");
    expect(file.content).toContain('"i" BIGINT');
    expect(file.content).toContain('"n" DOUBLE PRECISION');
    expect(file.content).toContain('"b" BOOLEAN');
    expect(file.content).toContain('"at" TIMESTAMP');
  });

  test("spells every inferred type the way SQL Server does", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [row], fields, dialect: "mssql" }));

    expect(file.content).toContain("[t] NVARCHAR(MAX)");
    expect(file.content).toContain("[i] BIGINT");
    expect(file.content).toContain("[n] FLOAT");
    expect(file.content).toContain("[b] BIT");
    expect(file.content).toContain("[at] DATETIME2");
  });

  test("spells the two MySQL disagrees about the way MySQL does", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [row], fields, dialect: "mysql" }));

    expect(file.content).toContain("`n` DOUBLE");
    expect(file.content).toContain("`at` DATETIME");
  });

  test("keeps the standard spelling for the dialects that accept it", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [row], fields, dialect: "postgres" }));

    expect(file.content).toContain('"t" TEXT');
    expect(file.content).toContain('"i" BIGINT');
    expect(file.content).toContain('"n" DOUBLE PRECISION');
    expect(file.content).toContain('"b" BOOLEAN');
  });

  test("uses the standard spelling when no dialect is connected", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [row], fields, dialect: undefined }));

    expect(file.content).toContain('"i" BIGINT');
  });
});

describe("buildResultExport — the type the engine itself declared", () => {
  // `QueryResult.columnTypes` is the type the wire format declared for THIS result,
  // which is the only source for a computed column, and it is spelled the way the
  // engine spells it. Inferring from a sample value is the fallback, not the rule.
  test("prefers the declared type over one inferred from a value", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ rows: [{ n: 1 }], fields: ["n"], columnTypes: { n: "Nullable(Int64)" } }),
    );

    expect(file.content).toContain('"n" Nullable(Int64)');
  });

  test("infers the type for a column the declaration does not cover", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ rows: [{ a: 1, b: "x" }], fields: ["a", "b"], columnTypes: { a: "DECIMAL(10, 2)" } }),
    );

    expect(file.content).toContain('"a" DECIMAL(10, 2)');
    expect(file.content).toContain('"b" TEXT');
  });

  test("does not read a declared type off the prototype chain", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [{ constructor: "x" }], fields: ["constructor"] }));

    expect(file.content).toContain('"constructor" TEXT');
  });

  // The file is run somewhere else, unattended (#290): a declared type is engine
  // output, so it is data until it has been checked. Anything that could carry
  // statement text is refused and the inferred type stands in.
  test("refuses a declared type that could carry statement text", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ rows: [{ a: "x" }], fields: ["a"], columnTypes: { a: "TEXT); DROP TABLE secrets; --" } }),
    );

    expect(file.content).toBe('CREATE TABLE users (\n  "a" TEXT\n);');
  });

  test("refuses a declared type holding a quote it does not close", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ rows: [{ a: 1 }], fields: ["a"], columnTypes: { a: 'ENUM("a)' } }),
    );

    expect(file.content).toContain('"a" BIGINT');
  });

  test("refuses an empty declared type", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [{ a: 1 }], fields: ["a"], columnTypes: { a: "" } }));

    expect(file.content).toContain('"a" BIGINT');
  });

  // #1386: these three were written as TEXT, which lost the type the INSERT beside them
  // needs (an `integer[]` literal does not replay into TEXT as an array).
  test("keeps an array type, a quoted type argument and a negative enum value", () => {
    const ddl = (type: string) =>
      buildResultExport("sql-ddl", source({ rows: [{ a: null }], fields: ["a"], columnTypes: { a: type } })).content;

    expect(ddl("integer[]")).toContain('"a" integer[]');
    expect(ddl("timestamp with time zone[]")).toContain('"a" timestamp with time zone[]');
    expect(ddl("integer[][]")).toContain('"a" integer[][]');
    expect(ddl("DateTime64(3, 'Europe/Istanbul')")).toContain(`"a" DateTime64(3, 'Europe/Istanbul')`);
    expect(ddl("Enum8('a' = 1, 'b' = -2)")).toContain(`"a" Enum8('a' = 1, 'b' = -2)`);
  });

  test("still refuses a quoted argument that could close early or a comment", () => {
    const ddl = (type: string) =>
      buildResultExport("sql-ddl", source({ rows: [{ a: 1 }], fields: ["a"], columnTypes: { a: type } })).content;

    for (const type of [
      "Enum8('a\\', 1)",
      "Enum8('a'' = 1)",
      "DateTime64(3, 'UTC\n')",
      "Int32 -- comment",
      "Int32 - 1",
      "integer[x]",
      "integer]",
      'STRUCT("a\\" INTEGER)',
      'STRUCT("a) b" INTEGER',
      "map<text, int>)",
      "map<text, int",
      "list>int<",
      // Closes the column list and opens a new one: the character class alone admits it.
      "int) SELECT load_file('/etc/passwd') AS b, (c int",
      "Int32)",
      "Nullable(Int32",
    ]) {
      expect(ddl(type)).toContain('"a" BIGINT');
    }
  });
});

describe("buildResultExport — a column name that is also a prototype member", () => {
  // `row[column]` walks the prototype chain, so a header naming a field this row has
  // no own entry for resolved to an inherited member — and the native `Object`
  // function reached the file as a quoted literal.
  test("writes NULL for a prototype-named column the row does not carry", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ rows: [{ constructor: "own" }, { id: 2 }], fields: ["constructor"] }),
    );

    expect(file.content).toBe(
      'INSERT INTO users ("constructor") VALUES (\'own\');\nINSERT INTO users ("constructor") VALUES (NULL);',
    );
  });

  test("leaves a prototype-named column out of the CSV cell it does not own", () => {
    const file = buildResultExport("csv", source({ rows: [{ id: 1 }], fields: ["id", "toString"] }));

    expect(file.content).toBe("id,toString\n1,");
  });
});

describe("buildResultExport — a value JSON cannot serialize", () => {
  test("writes a bigint inside a structured value rather than throwing", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{ meta: { n: BigInt(10) } }], fields: ["meta"] }));

    expect(file.content).toContain(`VALUES ('{"n":"10"}')`);
  });

  test("writes a self-referencing value rather than throwing", () => {
    const doc: Record<string, unknown> = { name: "root" };
    doc.self = doc;
    const file = buildResultExport("json", source({ rows: [{ doc }], fields: ["doc"] }));

    expect(file.content).toContain("[Circular]");
  });
});

describe("deriveTableName — the generated prefix needs a separator", () => {
  // The prefix the studio writes is `Query 1`, `Query: users`. Stripping a bare
  // `Query` turned a tab renamed after a real table into a different table: an
  // export from a tab named `QueryLog` wrote `INSERT INTO Log`.
  test("keeps a name that merely starts with the word", () => {
    expect(deriveTableName("QueryLog")).toBe("QueryLog");
    expect(deriveTableName("QueryStats")).toBe("QueryStats");
  });

  test("still strips the prefix when a separator follows it", () => {
    expect(deriveTableName("Query users")).toBe("users");
    expect(deriveTableName("Query:orders")).toBe("orders");
  });

  test("falls back for the bare generated name", () => {
    expect(deriveTableName("Query")).toBe(FALLBACK_TABLE_NAME);
  });
});

describe("buildResultExport — a binary value in a statement", () => {
  // The grid, the row detail sheet and the CSV all show `\x…` hex
  // (`src/lib/export/binary.ts`), and the SQL forms wrote the `Buffer` JSON shape
  // instead. Replayed against Postgres 18.4, that INSERT stored 46 bytes of the text
  // `{"type":"Buffer","data":[1,2,222,173,190,239]}` in a `bytea` column instead of
  // the six bytes the column held. Same on MySQL 26.7.0: `LENGTH(payload)` 46.
  const wire = { type: "Buffer", data: [0x01, 0x02, 0xde, 0xad, 0xbe, 0xef] };
  const binaryRow = (payload: unknown) => ({ rows: [{ payload }], fields: ["payload"] });

  test("writes a Postgres bytea literal rather than the Buffer JSON shape", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect: "postgres" }));

    expect(file.content).toBe(`INSERT INTO users ("payload") VALUES ('\\x0102deadbeef'::bytea);`);
  });

  test("writes the standard X'…' form for the dialects whose engines take it", () => {
    // InfluxDB 3 measured on 3.12.0: `SELECT arrow_typeof(X'00ff')` answers `Binary`.
    for (const dialect of ["mysql", "sqlite", "trino", "druid", "influxdb3"] as const) {
      const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect }));

      expect(file.content).toContain("VALUES (X'0102deadbeef');");
    }
  });

  test("writes the standard X'...' form for the dialects that write no SQL of their own", () => {
    // No statement is ever built for these to read: MongoDB, Redis, Kafka and the embedded store
    // declare `queryLanguage: "json"` and Prometheus declares `"promql"` (#1085, #1088), so the
    // export can claim only the portable form, as `values.ts` does for their literals. Neo4j writes
    // Cypher, which has no INSERT and no byte literal, so the same holds for it, for Milvus and Qdrant, whose
    // console requests are JSON, for InfluxQL, which has no INSERT and no byte literal either, and for Oxia, which
    // has no statement language for a value.
    for (const dialect of [
      "mongodb",
      "redis",
      "libredb",
      "prometheus",
      "kafka",
      "etcd",
      "neo4j",
      "milvus",
      "qdrant",
      "influxdb",
      "oxia",
    ] as const) {
      const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect }));

      expect(file.content).toContain("VALUES (X'0102deadbeef');");
    }
  });

  test("writes the 0x… form for the dialects that reject X'…'", () => {
    for (const dialect of ["mssql", "cassandra"] as const) {
      const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect }));

      expect(file.content).toContain("VALUES (0x0102deadbeef);");
    }
  });

  test("writes Oracle's HEXTORAW, the only binary form it parses", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect: "oracle" }));

    expect(file.content).toContain("VALUES (HEXTORAW('0102deadbeef'));");
  });

  // The trap this row exists for: DuckDB is Postgres-shaped everywhere else in this
  // file, and the standard `X'…'` form PARSES here - it is just not a binary literal.
  // Measured on v1.5.5, `SELECT typeof(X'0102')` answers `VARCHAR` and `SELECT X'0102'`
  // answers the five characters `x0102`, so the standard spelling would write TEXT into
  // a BLOB column and the file would replay wrong rather than fail.
  test("writes DuckDB's unhex, because its X'…' is a string and not six bytes", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect: "duckdb" }));

    expect(file.content).toContain("VALUES (unhex('0102deadbeef'));");
    expect(file.content).not.toContain("X'");
  });

  // Db2's `X'…'` is a CHARACTER string (FOR BIT DATA), not a binary one. Measured on Db2 LUW
  // 12.1.0.0 (#786): `X'0102deadbeef'` into a `BLOB` or a `VARBINARY` column is SQL0408N, a value
  // not compatible with the target, while `BX'0102deadbeef'` goes into `BLOB`, `VARBINARY` and
  // `VARCHAR FOR BIT DATA` alike and reads back as `HEX(...)` = `0102DEADBEEF`.
  test("writes Db2's BX'…', because its X'…' is a character string", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect: "db2" }));

    expect(file.content).toContain("VALUES (BX'0102deadbeef');");
  });

  test("writes ClickHouse's unhex", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect: "clickhouse" }));

    expect(file.content).toContain("VALUES (unhex('0102deadbeef'));");
  });

  test("writes the hex as a string where the dialect has no binary type at all", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect: "couchbase" }));

    expect(file.content).toContain("VALUES ('\\\\x0102deadbeef');");
  });

  test("uses the standard form when no dialect is connected", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(wire), dialect: undefined }));

    expect(file.content).toContain("VALUES (X'0102deadbeef');");
  });

  // A zero-length value is where the spellings stop agreeing: `X''` and `0x` are both
  // accepted empties (measured), `HEXTORAW('')` is Oracle's NULL, and `0x` alone is a
  // syntax error on MySQL — which is why MySQL is in the `X'…'` group and not the `0x…` one.
  test("writes an empty value in each dialect's own accepted empty form", () => {
    const empty = { type: "Buffer", data: [] };

    expect(buildResultExport("sql-insert", source({ ...binaryRow(empty), dialect: "postgres" })).content).toContain(
      `VALUES ('\\x'::bytea);`,
    );
    expect(buildResultExport("sql-insert", source({ ...binaryRow(empty), dialect: "mysql" })).content).toContain(
      "VALUES (X'');",
    );
    expect(buildResultExport("sql-insert", source({ ...binaryRow(empty), dialect: "mssql" })).content).toContain(
      "VALUES (0x);",
    );
    expect(buildResultExport("sql-insert", source({ ...binaryRow(empty), dialect: "oracle" })).content).toContain(
      "VALUES (HEXTORAW(''));",
    );
    // `BX''` inserts a zero-length value into all three Db2 byte types, measured (#786).
    expect(buildResultExport("sql-insert", source({ ...binaryRow(empty), dialect: "db2" })).content).toContain(
      "VALUES (BX'');",
    );
    // `unhex('')` really inserts the zero-length blob on DuckDB: measured, the row
    // reads back with `octet_length(payload)` 0 rather than NULL.
    expect(buildResultExport("sql-insert", source({ ...binaryRow(empty), dialect: "duckdb" })).content).toContain(
      "VALUES (unhex(''));",
    );
  });

  test("writes a NULL binary cell as NULL, not as an empty literal", () => {
    const file = buildResultExport("sql-insert", source({ ...binaryRow(null), dialect: "postgres" }));

    expect(file.content).toBe('INSERT INTO users ("payload") VALUES (NULL);');
  });

  // The embeddable shell hands the live object the host passed in, so the bytes reach
  // this module as a `Uint8Array` rather than as the JSON a `Buffer` serialized to.
  test("writes the same literal for a live Uint8Array as for the wire shape", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ ...binaryRow(Uint8Array.from([1, 2, 222, 173, 190, 239])), dialect: "postgres" }),
    );

    expect(file.content).toContain(`VALUES ('\\x0102deadbeef'::bytea);`);
  });

  // A user's own document may carry a `type` field. Turning it into bytes would lose
  // it as surely as the defect this closes, so it stays JSON.
  test("leaves a document that merely looks Buffer-shaped as JSON", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ ...binaryRow({ type: "Buffer", data: [1, "two"] }), dialect: "postgres" }),
    );

    expect(file.content).toContain(`VALUES ('{"type":"Buffer","data":[1,"two"]}');`);
  });
});

describe("buildResultExport — a binary column in the DDL", () => {
  // The inferred kind fell through to `text`, so a `bytea` column was recreated as
  // `TEXT` and the INSERT this same export writes could not be replayed into it.
  const binaryRow = { rows: [{ payload: { type: "Buffer", data: [1, 2] } }], fields: ["payload"] };

  test("types a binary column as the dialect's own binary type", () => {
    const spellings: [Parameters<typeof buildResultExport>[1]["dialect"], string][] = [
      ["postgres", '"payload" BYTEA'],
      ["mysql", "`payload` BLOB"],
      ["sqlite", '"payload" BLOB'],
      ["oracle", '"payload" BLOB'],
      ["mssql", "[payload] VARBINARY(MAX)"],
      ["clickhouse", '"payload" String'],
      ["trino", '"payload" VARBINARY'],
      ["cassandra", '"payload" BLOB'],
      [undefined, '"payload" BLOB'],
    ];

    for (const [dialect, expected] of spellings) {
      expect(buildResultExport("sql-ddl", source({ ...binaryRow, dialect })).content).toContain(expected);
    }
  });

  test("still prefers the type the engine declared for the column", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ ...binaryRow, dialect: "postgres", columnTypes: { payload: "bytea" } }),
    );

    expect(file.content).toContain('"payload" bytea');
  });
});

describe("buildResultExport — a declared type that cannot stand alone", () => {
  // The four biggest providers declare a BARE BASE NAME (`varchar`, `decimal`,
  // `VARCHAR2`, `nvarchar`, `varbinary`), because a length or a precision cannot be
  // recovered from the wire. Measured by replaying the generated CREATE TABLE into the
  // engine it was read from: MySQL answers `ERROR 1064 … near ','` on the bare
  // `varchar`, Oracle `ORA-00906: missing left parenthesis` on the bare `VARCHAR2`,
  // and SQL Server PARSES it and then reports length 1 for `nvarchar`, `varchar` and
  // `varbinary` and precision 18 scale 0 for `decimal` — a silent narrowing, which is
  // worse than a refusal.
  const ddl = (columnTypes: Record<string, string>, dialect: Parameters<typeof buildResultExport>[1]["dialect"]) =>
    buildResultExport("sql-ddl", source({ rows: [{ c: null }], fields: ["c"], dialect, columnTypes })).content;

  test("spells MySQL's bare character and byte types as its unbounded ones", () => {
    expect(ddl({ c: "varchar" }, "mysql")).toContain("`c` TEXT");
    expect(ddl({ c: "char" }, "mysql")).toContain("`c` TEXT");
    expect(ddl({ c: "varbinary" }, "mysql")).toContain("`c` BLOB");
    expect(ddl({ c: "binary" }, "mysql")).toContain("`c` BLOB");
    // Not a refusal but a truncation: measured, `CREATE TABLE t (c decimal)` on MySQL
    // 26.7.0 is `decimal(10,0)`, so every decimal the column was declared for is
    // rounded to an integer on the way back in.
    expect(ddl({ c: "decimal" }, "mysql")).toContain("`c` DOUBLE");
  });

  test("keeps the MySQL types that already stand for their whole family", () => {
    for (const bare of ["text", "longtext", "blob", "tinyblob", "year"]) {
      expect(ddl({ c: bare }, "mysql")).toBe(`CREATE TABLE users (\n  \`c\` ${bare}\n);`);
    }
  });

  // #1386: a bare `datetime`, `timestamp` and `time` are fractional precision 0 on MySQL,
  // which rounds the `.999` the INSERT beside it carries up to the next second, and a bare
  // `bit` is `bit(1)`, which refuses the wider value `mysql2` hands back as bytes.
  test("widens the MySQL names whose bare form rounds or refuses the exported value", () => {
    expect(ddl({ c: "datetime" }, "mysql")).toContain("`c` datetime(6)");
    expect(ddl({ c: "timestamp" }, "mysql")).toContain("`c` timestamp(6)");
    expect(ddl({ c: "time" }, "mysql")).toContain("`c` time(6)");
    expect(ddl({ c: "bit" }, "mysql")).toContain("`c` bit(64)");
  });

  test("writes Postgres's bare bit as bit varying, which takes the bit string at its own length", () => {
    expect(ddl({ c: "bit" }, "postgres")).toContain('"c" bit varying');
    expect(ddl({ c: "bit[]" }, "postgres")).toContain('"c" bit varying[]');
    expect(ddl({ c: "bit[][]" }, "postgres")).toContain('"c" bit varying[][]');
  });

  test("keeps a bare bit on the dialects with no measured re-spelling", () => {
    expect(ddl({ c: "bit" }, "mssql")).toContain("[c] bit");
    expect(ddl({ c: "datetime" }, undefined)).toContain('"c" TIMESTAMP');
  });

  test("spells Oracle's bare character and byte types as its unbounded ones", () => {
    expect(ddl({ c: "VARCHAR2" }, "oracle")).toContain('"c" VARCHAR2(4000)');
    expect(ddl({ c: "NVARCHAR2" }, "oracle")).toContain('"c" VARCHAR2(4000)');
    expect(ddl({ c: "CHAR" }, "oracle")).toContain('"c" VARCHAR2(4000)');
    expect(ddl({ c: "RAW" }, "oracle")).toContain('"c" BLOB');
  });

  test("keeps the Oracle types that already stand for their whole family", () => {
    for (const bare of ["NUMBER", "BINARY_DOUBLE", "CLOB", "NCLOB", "BLOB", "TIMESTAMP"]) {
      expect(ddl({ c: bare }, "oracle")).toContain(`"c" ${bare}`);
    }
  });

  test("spells SQL Server's bare character and byte types as its (max) ones", () => {
    expect(ddl({ c: "nvarchar" }, "mssql")).toContain("[c] NVARCHAR(MAX)");
    expect(ddl({ c: "varchar" }, "mssql")).toContain("[c] NVARCHAR(MAX)");
    expect(ddl({ c: "char" }, "mssql")).toContain("[c] NVARCHAR(MAX)");
    expect(ddl({ c: "varbinary" }, "mssql")).toContain("[c] VARBINARY(MAX)");
    expect(ddl({ c: "decimal" }, "mssql")).toContain("[c] FLOAT");
  });

  // `timestamp` in T-SQL is not a moment in time: measured, `CREATE TABLE t (c
  // timestamp)` on SQL Server 2022 CU26 creates a `rowversion`, which no INSERT may
  // name — so the pair this export writes parses and then fails on the INSERT.
  test("does not let a foreign `timestamp` become SQL Server's rowversion", () => {
    expect(ddl({ c: "timestamp" }, "mssql")).toContain("[c] DATETIME2");
  });

  test("keeps the SQL Server types that already stand for their whole family", () => {
    for (const bare of ["text", "ntext", "image", "datetime2", "datetimeoffset", "uniqueidentifier"]) {
      expect(ddl({ c: bare }, "mssql")).toContain(`[c] ${bare}`);
    }
  });

  // Postgres is the one dialect of the four whose own bare spellings are unbounded
  // already (`character varying`, `numeric`), which is why it needed nothing.
  test("keeps Postgres's own bare spellings, which are already unbounded", () => {
    for (const bare of ["character varying", "numeric", "text", "bytea", "timestamp without time zone"]) {
      expect(ddl({ c: bare }, "postgres")).toContain(`"c" ${bare}`);
    }
  });

  // `character` and `nchar` are the exception: measured, both are `character(1)` on
  // 18.4, so an eight-character value has nowhere to be replayed into.
  test("completes the two Postgres spellings that do narrow", () => {
    expect(ddl({ c: "character" }, "postgres")).toContain('"c" TEXT');
    expect(ddl({ c: "nchar" }, "postgres")).toContain('"c" TEXT');
  });

  test("leaves a declared type that already carries its parameters untouched", () => {
    expect(ddl({ c: "DECIMAL(10, 2)" }, "mysql")).toContain("`c` DECIMAL(10, 2)");
    expect(ddl({ c: "varchar(40)" }, "mysql")).toContain("`c` varchar(40)");
    expect(ddl({ c: "VARCHAR2(4000)" }, "oracle")).toContain('"c" VARCHAR2(4000)');
    expect(ddl({ c: "Nullable(Int64)" }, "clickhouse")).toContain('"c" Nullable(Int64)');
  });

  test("matches the name whatever its case and spacing", () => {
    expect(ddl({ c: "VarChar" }, "mysql")).toContain("`c` TEXT");
    expect(ddl({ c: "timestamp  without   time zone" }, "mysql")).toContain("`c` DATETIME");
  });

  // Both shells pass the ACTIVE connection's type beside the tab's own result
  // (`Studio.tsx`, `StudioWorkspace.tsx`), so switching connections and then
  // exporting hands this module one engine's declarations under another's dialect.
  test("re-spells a declared type the target dialect cannot parse at all", () => {
    const oracleResult = { rows: [{ s: null, d: null, n: null }], fields: ["s", "d", "n"] };
    const file = buildResultExport(
      "sql-ddl",
      source({ ...oracleResult, dialect: "postgres", columnTypes: { s: "VARCHAR2", d: "BINARY_DOUBLE", n: "NUMBER" } }),
    );

    expect(file.content).toBe('CREATE TABLE users (\n  "s" TEXT,\n  "d" DOUBLE PRECISION,\n  "n" DOUBLE PRECISION\n);');
  });

  // The regression: a Postgres result exported as another engine's DDL. Every one of
  // these three was measured to refuse or to narrow before this.
  test("writes legal DDL for a Postgres result in each target dialect", () => {
    const pg = {
      rows: [{ amount: "4.99", at: null, title: null }],
      fields: ["amount", "at", "title"],
      columnTypes: { amount: "numeric", at: "timestamp without time zone", title: "character varying" },
    };

    expect(buildResultExport("sql-ddl", source({ ...pg, dialect: "postgres" })).content).toBe(
      'CREATE TABLE users (\n  "amount" numeric,\n  "at" timestamp without time zone,\n  "title" character varying\n);',
    );
    expect(buildResultExport("sql-ddl", source({ ...pg, dialect: "mysql" })).content).toBe(
      "CREATE TABLE users (\n  `amount` DOUBLE,\n  `at` DATETIME,\n  `title` TEXT\n);",
    );
    expect(buildResultExport("sql-ddl", source({ ...pg, dialect: "mssql" })).content).toBe(
      "CREATE TABLE users (\n  [amount] FLOAT,\n  [at] DATETIME2,\n  [title] NVARCHAR(MAX)\n);",
    );
    expect(buildResultExport("sql-ddl", source({ ...pg, dialect: "oracle" })).content).toBe(
      'CREATE TABLE users (\n  "amount" BINARY_DOUBLE,\n  "at" TIMESTAMP,\n  "title" VARCHAR2(4000)\n);',
    );
  });

  // `varchar` is one of the names SQLite and ClickHouse were measured to store
  // unbounded (the measured rows below), so it goes through for those two; with no target
  // dialect at all there is no engine standing behind any spelling, so the portable
  // one is written instead.
  test("keeps a bare type only where the target engine stands behind it", () => {
    expect(ddl({ c: "varchar" }, "sqlite")).toContain('"c" varchar');
    expect(ddl({ c: "varchar" }, "clickhouse")).toContain('"c" varchar');
    expect(ddl({ c: "varchar" }, undefined)).toContain('"c" TEXT');
  });

  // The completion tables are looked up with `Object.hasOwn`: a column declared
  // `constructor` would otherwise read `Object.prototype.constructor` — a function —
  // as its family and write `undefined` into the statement.
  test("does not read a family off the prototype chain", () => {
    expect(ddl({ c: "constructor" }, "mysql")).toContain("`c` constructor");
    expect(ddl({ c: "toString" }, "postgres")).toContain('"c" toString');
  });
});

// A bare name reaching a dialect that never declared it: both shells pass
// the ACTIVE connection's type beside the tab's own result, so querying Oracle and
// switching to a ClickHouse connection before exporting wrote `VARCHAR2` and
// `BINARY_DOUBLE` into a file that replays nowhere, and with no connection at all it
// wrote them too (measured 2026-08-24, one Oracle result under each target). The four
// rows below are the remaining dialects an engine could be measured on, one `CREATE
// TABLE probe (c <name>)` per candidate name read back out of that engine's own
// catalog — the same method the first four rows used.
describe("buildResultExport — the bare names the remaining reachable dialects stand behind", () => {
  const ddl = (columnTypes: Record<string, string>, dialect: Parameters<typeof buildResultExport>[1]["dialect"]) =>
    buildResultExport("sql-ddl", source({ rows: [{ c: null }], fields: ["c"], dialect, columnTypes })).content;

  // Measured through `bun:sqlite`: every candidate name parses except `set` (`near
  // "set": syntax error`) and every one is stored verbatim in `pragma_table_info`, so
  // a declared type survives a SQLite target as it was spelled.
  test("keeps the names SQLite stores verbatim", () => {
    for (const bare of ["varchar", "VARCHAR2", "CLOB", "longtext", "bytea", "NUMBER", "datetime2", "RAW"]) {
      expect(ddl({ c: bare }, "sqlite")).toContain(`"c" ${bare}`);
    }
  });

  // The three that do narrow, and they narrow silently — which is the SQL Server
  // lesson. `enum`, `uniqueidentifier` and `rowid` match none of SQLite's affinity
  // keywords, so the column gets NUMERIC affinity: measured, `INSERT INTO p (c)
  // VALUES ('007')` into each of the three reads back as the INTEGER 7, where the
  // same insert into a `varchar2` column reads back as the TEXT `007`.
  test("re-spells the three SQLite names that convert a text value to a number", () => {
    expect(ddl({ c: "enum" }, "sqlite")).toContain('"c" TEXT');
    expect(ddl({ c: "uniqueidentifier" }, "sqlite")).toContain('"c" TEXT');
    expect(ddl({ c: "rowid" }, "sqlite")).toContain('"c" TEXT');
    // `set` is not in SQLite's grammar as a type name at all.
    expect(ddl({ c: "set" }, "sqlite")).toContain('"c" TEXT');
  });

  // Measured on ClickHouse 26.7.1, read back out of `system.columns`: every character
  // and byte alias it knows resolves to `String`, which is unbounded — and its alias
  // set is wider than the defect report assumed, `VARCHAR2` and `CLOB` included, so those two
  // columns of an Oracle result were never the defect there. `BINARY_DOUBLE` was.
  test("keeps ClickHouse's own character and byte aliases", () => {
    for (const bare of ["varchar", "VARCHAR2", "clob", "longtext", "blob", "bytea", "varbinary", "timestamp", "year"]) {
      expect(ddl({ c: bare }, "clickhouse")).toContain(`"c" ${bare}`);
    }
  });

  test("re-spells what ClickHouse does not know or would narrow", () => {
    // `Unknown data type family: nvarchar2` / `: number` / `: binary_double`, each
    // suggesting a name ClickHouse does have (`['NVARCHAR','VARCHAR2']`).
    expect(ddl({ c: "NVARCHAR2" }, "clickhouse")).toContain('"c" TEXT');
    expect(ddl({ c: "uniqueidentifier" }, "clickhouse")).toContain('"c" TEXT');
    expect(ddl({ c: "BINARY_DOUBLE" }, "clickhouse")).toContain('"c" DOUBLE PRECISION');
    expect(ddl({ c: "NUMBER" }, "clickhouse")).toContain('"c" DOUBLE PRECISION');
    // Narrowings rather than refusals: `decimal` is stored as `Decimal(10, 0)`, which
    // rounds every decimal the column existed for, and MySQL's `set` — a character
    // type — is stored as `UInt64`, because ClickHouse's `SET` is something else
    // entirely.
    expect(ddl({ c: "decimal" }, "clickhouse")).toContain('"c" DOUBLE PRECISION');
    expect(ddl({ c: "numeric" }, "clickhouse")).toContain('"c" DOUBLE PRECISION');
    expect(ddl({ c: "set" }, "clickhouse")).toContain('"c" TEXT');
  });

  // The trap: Trino's own `varchar` is legal AND unbounded, so widening the
  // rule to re-spell from the family whenever the target is unmeasured would have
  // turned it into a `TEXT` Trino answers `Unknown type 'text'` to.
  test("never turns Trino's own unbounded varchar into a TEXT it does not have", () => {
    expect(ddl({ c: "varchar" }, "trino")).toContain('"c" varchar');
    expect(ddl({ c: "varchar" }, "trino")).not.toContain("TEXT");
  });

  test("keeps the other Trino names measured to store unnarrowed", () => {
    for (const bare of ["varbinary", "timestamp", "timestamp with time zone"]) {
      expect(ddl({ c: bare }, "trino")).toContain(`"c" ${bare}`);
    }
  });

  // Measured on Trino 476 through the memory connector: `text`, `clob`, `blob` and
  // `varchar2` are all `Unknown type`, `char` is stored as `char(1)` and `decimal` as
  // `decimal(38,0)` — the two narrowings. `VARCHAR`, not `TEXT`, is the spelling Trino
  // takes for a text column (`stored=varchar`).
  test("spells a name Trino does not have as Trino's own", () => {
    expect(ddl({ c: "text" }, "trino")).toContain('"c" VARCHAR');
    expect(ddl({ c: "VARCHAR2" }, "trino")).toContain('"c" VARCHAR');
    expect(ddl({ c: "char" }, "trino")).toContain('"c" VARCHAR');
    expect(ddl({ c: "CLOB" }, "trino")).toContain('"c" VARCHAR');
    expect(ddl({ c: "blob" }, "trino")).toContain('"c" VARBINARY');
    expect(ddl({ c: "decimal" }, "trino")).toContain('"c" DOUBLE PRECISION');
  });

  // Measured on DuckDB v1.5.5, read back out of `duckdb_columns().data_type`. The
  // seven character spellings all resolve to an unbounded `VARCHAR`, the four byte ones
  // to `BLOB` and the four moment ones to `TIMESTAMP` - so a declared type survives a
  // DuckDB target as it was spelled.
  test("keeps the names DuckDB stores unnarrowed", () => {
    for (const bare of ["varchar", "nvarchar", "char", "text", "bytea", "varbinary", "datetime", "timestamp"]) {
      expect(ddl({ c: bare }, "duckdb")).toContain(`"c" ${bare}`);
    }
  });

  test("re-spells what DuckDB does not have, and the two names it would silently narrow", () => {
    // `Catalog Error: Type with name … does not exist!` for each of these.
    expect(ddl({ c: "VARCHAR2" }, "duckdb")).toContain('"c" TEXT');
    expect(ddl({ c: "longtext" }, "duckdb")).toContain('"c" TEXT');
    expect(ddl({ c: "CLOB" }, "duckdb")).toContain('"c" TEXT');
    expect(ddl({ c: "NUMBER" }, "duckdb")).toContain('"c" DOUBLE PRECISION');
    expect(ddl({ c: "BINARY_DOUBLE" }, "duckdb")).toContain('"c" DOUBLE PRECISION');
    // The narrowing pair, and the reason they are absent from the row above rather
    // than kept: DuckDB ACCEPTS both and stores `DECIMAL(18,3)`, which rounds away
    // every value past the third decimal the column existed for.
    expect(ddl({ c: "numeric" }, "duckdb")).toContain('"c" DOUBLE PRECISION');
    expect(ddl({ c: "decimal" }, "duckdb")).toContain('"c" DOUBLE PRECISION');
  });

  // Measured on Cassandra 5.0.9, read back out of `system_schema.columns`: exactly
  // five of the candidate names are in CQL's grammar, and all five are unbounded —
  // `varchar` is an alias stored as `text`, and `decimal` is arbitrary-precision.
  test("keeps the five bare names Cassandra has", () => {
    for (const bare of ["text", "varchar", "blob", "decimal", "timestamp"]) {
      expect(ddl({ c: bare }, "cassandra")).toContain(`"c" ${bare}`);
    }
  });

  // `DOUBLE PRECISION` is a SyntaxException in CQL (`no viable alternative at input
  // 'PRECISION'`), so the standard spelling is the one thing a numeric column must NOT
  // get here; `double` is the whole name.
  test("spells a foreign name as CQL, whose numeric type is DOUBLE with no PRECISION", () => {
    expect(ddl({ c: "VARCHAR2" }, "cassandra")).toContain('"c" TEXT');
    expect(ddl({ c: "BINARY_DOUBLE" }, "cassandra")).toContain('"c" DOUBLE');
    expect(ddl({ c: "BINARY_DOUBLE" }, "cassandra")).not.toContain("PRECISION");
    expect(ddl({ c: "numeric" }, "cassandra")).toContain('"c" DOUBLE');
    expect(ddl({ c: "datetime" }, "cassandra")).toContain('"c" TIMESTAMP');
    expect(ddl({ c: "bytea" }, "cassandra")).toContain('"c" BLOB');
  });

  // A value-shaped guess reaches the same two tables, so the two rows above fix it in
  // the same place: a Cassandra target used to get `DOUBLE PRECISION` for a decimal
  // value and a Trino target `TEXT` for a string, neither of which parses.
  test("spells an inferred column the same way", () => {
    const row = (value: unknown) => ({ rows: [{ c: value }], fields: ["c"] });

    expect(buildResultExport("sql-ddl", source({ ...row(4.99), dialect: "cassandra" })).content).toContain(
      '"c" DOUBLE',
    );
    expect(buildResultExport("sql-ddl", source({ ...row("Ada"), dialect: "trino" })).content).toContain('"c" VARCHAR');
  });

  // No target dialect means the file is not addressed to any engine, so an Oracle-only
  // spelling is definitionally wrong in it: the portable standard names are written
  // instead, which is what the value-shaped path already produced there.
  test("writes portable standard SQL when there is no target dialect", () => {
    expect(ddl({ c: "VARCHAR2" }, undefined)).toContain('"c" TEXT');
    expect(ddl({ c: "BINARY_DOUBLE" }, undefined)).toContain('"c" DOUBLE PRECISION');
    expect(ddl({ c: "CLOB" }, undefined)).toContain('"c" TEXT');
    expect(ddl({ c: "RAW" }, undefined)).toContain('"c" BLOB');
    expect(ddl({ c: "datetime" }, undefined)).toContain('"c" TIMESTAMP');
    expect(ddl({ c: "year" }, undefined)).toContain('"c" BIGINT');
  });

  // The sixteen dialects no row could be measured for: Druid takes no INSERT without the
  // MSQ extension, the two search endpoints and Couchbase parse no CREATE TABLE (a SQL++ collection
  // takes no columns), InfluxDB 3 parses SQL but its 3.12 planner refuses DDL and DML, and MongoDB, Redis, Kafka,
  // etcd and the embedded store declare `queryLanguage: "json"`, `prometheus` declares `"promql"`,
  // `neo4j` declares `"cypher"`, `influxdb` declares `"influxql"`, and `milvus`, `qdrant` and `oxia` each
  // declare `"json"` with a dialect of their own, so no SQL statement is ever built for those eleven to read.
  // A file for one of those is a file meant to run somewhere else, so it gets the same
  // portable spelling as no dialect at all rather than a guessed row.
  test("writes portable standard SQL for the dialects that parse no CREATE TABLE", () => {
    // The identifier quoting differs per dialect and is not what this is about, so the
    // assertion is on the type name alone.
    for (const dialect of [
      "druid",
      "elasticsearch",
      "opensearch",
      "mongodb",
      "redis",
      "libredb",
      "couchbase",
      "prometheus",
      "kafka",
      "etcd",
      "neo4j",
      "milvus",
      "qdrant",
      "influxdb",
      "influxdb3",
      "oxia",
    ] as const) {
      expect(ddl({ c: "VARCHAR2" }, dialect)).toContain(" TEXT\n");
      expect(ddl({ c: "BINARY_DOUBLE" }, dialect)).toContain(" DOUBLE PRECISION\n");
    }
  });
});

describe("buildResultExport — Cassandra DDL needs a PRIMARY KEY to run at all", () => {
  // Measured on Cassandra 5.0.9: `CREATE TABLE probe.nopk (a text, b bigint)` is
  // `InvalidRequest ... No PRIMARY KEY specifed for table 'probe.nopk' (exactly one
  // required)`. A column list alone is not valid CQL, so the export must pick a key -
  // the first column, since a result set does not know the real one - and say so
  // loudly rather than hand back a statement that fails to parse.

  test("appends a PRIMARY KEY on the first column and a warning comment above the statement", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ rows: [{ id: 1, name: "Ada" }], fields: ["id", "name"], dialect: "cassandra" }),
    );

    expect(file.content).toBe(
      "-- CQL requires exactly one PRIMARY KEY per table, and a result set carries no key of\n" +
        "-- its own. This export chose the first column as a placeholder: confirm it is unique\n" +
        "-- per row before running this statement.\n" +
        'CREATE TABLE users (\n  "id" BIGINT,\n  "name" TEXT,\n  PRIMARY KEY ("id")\n);',
    );
  });

  test("quotes the key column the same way the column list itself is quoted", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ rows: [{ 'weird"col': 1, other: 2 }], fields: ['weird"col', "other"], dialect: "cassandra" }),
    );

    expect(file.content).toContain('PRIMARY KEY ("weird""col")');
    expect(file.content).toContain('"weird""col" BIGINT');
  });

  test("does not add a PRIMARY KEY line for any other dialect", () => {
    const file = buildResultExport("sql-ddl", source({ dialect: "postgres" }));

    expect(file.content).not.toContain("PRIMARY KEY");
    expect(file.content).not.toContain("-- CQL requires");
  });

  test("a zero-column Cassandra result still gets the plain no-columns comment, not the key note", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [], fields: [], dialect: "cassandra" }));

    expect(file.content).toBe("-- No columns to export.");
  });

  test("the warning comment is closed by a trailing newline, never left open at EOF", () => {
    const file = buildResultExport("sql-ddl", source({ dialect: "cassandra" }));
    const lines = file.content.split("\n");
    const lastCommentLineIndex = lines.findIndex((line) => line.startsWith("CREATE TABLE")) - 1;

    // A CQL line comment runs to the next newline; one left open at EOF with no
    // newline after it would swallow whatever followed. Every `--` line here is
    // followed by a real newline, including the one right before the statement.
    for (let i = 0; i <= lastCommentLineIndex; i++) {
      expect(lines[i].startsWith("--")).toBe(true);
    }
    expect(file.content.endsWith(";")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Oracle date/timestamp literals (D23)
// ---------------------------------------------------------------------------

describe("buildResultExport - Oracle date and timestamp literals", () => {
  // CI runs at UTC, where a local-field literal and an ISO one are the same string and
  // the assertions below would pass against either (a developer machine sets no TZ
  // either way). Held at a real offset for this block so they cannot.
  const runnerZone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Asia/Tokyo";
  });
  afterAll(() => {
    if (runnerZone === undefined) delete process.env.TZ;
    else process.env.TZ = runnerZone;
  });

  // `oracledb` builds the `Date` for a naive DATE/TIMESTAMP by reading the stored wall
  // clock in the Node process's zone, so the literal that replays it is the one that
  // spells those same LOCAL fields back. Under the +09:00 held above this instant is
  // 2026-08-24 10:11:12.345 locally and 01:11:12.345 in ISO, so the two spellings cannot
  // be confused for each other.
  const naive = new Date("2026-08-24T01:11:12.345Z");
  const instant = new Date("2026-08-24T17:11:12.345Z");

  const oracle = (columnTypes?: Record<string, string>, value: unknown = naive) =>
    buildResultExport("sql-insert", source({ rows: [{ at: value }], fields: ["at"], dialect: "oracle", columnTypes }))
      .content;

  test("writes a TIMESTAMP column as TO_TIMESTAMP of its local fields, milliseconds kept", () => {
    expect(oracle({ at: "TIMESTAMP" })).toContain(
      `VALUES (TO_TIMESTAMP('2026-08-24 10:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'));`,
    );
  });

  test("writes a DATE column as TO_DATE, which is the type that carries no fraction", () => {
    expect(oracle({ at: "DATE" })).toContain(`VALUES (TO_DATE('2026-08-24 10:11:12', 'YYYY-MM-DD HH24:MI:SS'));`);
  });

  test("writes a zoned column as the UTC instant through FROM_TZ, not as a fabricated offset", () => {
    const expected = `VALUES (FROM_TZ(TO_TIMESTAMP('2026-08-24 17:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC'));`;
    expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, instant)).toContain(expected);
    expect(oracle({ at: "timestamp with local time zone" }, instant)).toContain(expected);
  });

  test("falls back to the timestamp form when the result declared no type for the column", () => {
    expect(oracle(undefined)).toContain(
      `VALUES (TO_TIMESTAMP('2026-08-24 10:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'));`,
    );
    expect(oracle({ other: "DATE" })).toContain(
      `VALUES (TO_TIMESTAMP('2026-08-24 10:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'));`,
    );
  });

  test("pads every field, so a single-digit month and a sub-100 millisecond still parse", () => {
    expect(oracle({ at: "TIMESTAMP" }, new Date("2026-01-01T18:04:05.006Z"))).toContain(
      `VALUES (TO_TIMESTAMP('2026-01-02 03:04:05.006', 'YYYY-MM-DD HH24:MI:SS.FF3'));`,
    );
  });

  test("reads no declared type off the prototype for a column named after one", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ rows: [{ constructor: naive }], fields: ["constructor"], dialect: "oracle", columnTypes: {} }),
    );

    expect(file.content).toContain(`VALUES (TO_TIMESTAMP('2026-08-24 10:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'));`);
  });

  test("leaves every other dialect on the ISO literal", () => {
    const file = buildResultExport(
      "sql-insert",
      source({ rows: [{ at: instant }], fields: ["at"], dialect: "postgres", columnTypes: { at: "DATE" } }),
    );
    expect(file.content).toContain(`VALUES ('2026-08-24T17:11:12.345Z');`);
  });

  // The provider reads a DATE and a TIMESTAMP as the engine's wall clock (#1131), and that
  // text is what reaches the export, over HTTP and in-process alike. Quoted as it is, it is
  // read through the session's NLS_DATE_FORMAT (`DD-MON-RR` by default) and refused, so a
  // column DECLARED one of the two gets the conversion function that parses that text.
  // No getter is read on this path, which is why the +09:00 held above moves nothing.
  describe("the provider's DATE and TIMESTAMP text (#1131)", () => {
    test("writes a DATE's text as TO_DATE of that same text", () => {
      expect(oracle({ at: "DATE" }, "2026-09-01 00:00:00")).toContain(
        `VALUES (TO_DATE('2026-09-01 00:00:00', 'YYYY-MM-DD HH24:MI:SS'));`,
      );
    });

    test("writes a TIMESTAMP's text as TO_TIMESTAMP, with FF only when there is a fraction", () => {
      expect(oracle({ at: "TIMESTAMP" }, "2026-09-01 10:30:00")).toContain(
        `VALUES (TO_TIMESTAMP('2026-09-01 10:30:00', 'YYYY-MM-DD HH24:MI:SS'));`,
      );
      expect(oracle({ at: "TIMESTAMP" }, "2026-09-01 10:30:00.345")).toContain(
        `VALUES (TO_TIMESTAMP('2026-09-01 10:30:00.345', 'YYYY-MM-DD HH24:MI:SS.FF'));`,
      );
    });

    // `ALL_TAB_COLUMNS.DATA_TYPE` spells a timestamp column with its precision; a host
    // declaring from the catalog would hand that spelling over.
    test("still reads a TIMESTAMP declared with its precision as one", () => {
      expect(oracle({ at: "timestamp(6)" }, "2026-09-01 10:30:00.5")).toContain(
        `VALUES (TO_TIMESTAMP('2026-09-01 10:30:00.5', 'YYYY-MM-DD HH24:MI:SS.FF'));`,
      );
    });

    test("writes a BC year through the signed year mask", () => {
      expect(oracle({ at: "DATE" }, "-0044-03-15 00:00:00")).toContain(
        `VALUES (TO_DATE('-0044-03-15 00:00:00', 'SYYYY-MM-DD HH24:MI:SS'));`,
      );
    });

    // The declaration is what makes the text a date. A VARCHAR2 holding the same
    // characters is text, and converting it would store the NLS rendering of a
    // timestamp in its place; a zoned column never receives this text from the provider.
    test("leaves the same text quoted in a column not declared DATE or TIMESTAMP", () => {
      const text = "2026-09-01 10:30:00";
      expect(oracle({ at: "VARCHAR2" }, text)).toContain(`VALUES ('2026-09-01 10:30:00');`);
      expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, text)).toContain(`VALUES ('2026-09-01 10:30:00');`);
      expect(oracle(undefined, text)).toContain(`VALUES ('2026-09-01 10:30:00');`);
    });

    test("leaves text that is not the provider's form quoted", () => {
      expect(oracle({ at: "DATE" }, "01-SEP-26")).toContain(`VALUES ('01-SEP-26');`);
      // A DATE has no fraction, so a fraction is not a DATE's text.
      expect(oracle({ at: "DATE" }, "2026-09-01 10:30:00.5")).toContain(`VALUES ('2026-09-01 10:30:00.5');`);
    });

    // The text goes into TO_DATE / TO_TIMESTAMP unquoted, so the match has to cover the
    // whole cell: a valid wall clock with anything before or after it is ordinary text.
    test("leaves a wall clock with text before or after it quoted and escaped", () => {
      expect(oracle({ at: "DATE" }, "2026-09-01 10:30:00'); DROP TABLE x; --")).toContain(
        `VALUES ('2026-09-01 10:30:00''); DROP TABLE x; --');`,
      );
      expect(oracle({ at: "TIMESTAMP" }, "x'); DROP TABLE x; -- 2026-09-01 10:30:00")).toContain(
        `VALUES ('x''); DROP TABLE x; -- 2026-09-01 10:30:00');`,
      );
    });
  });

  // A zoned column still reaches the export as the driver's `Date` in-process, but over
  // HTTP the row has been through JSON, so the same cell arrives as the text
  // `Date#toISOString` wrote. Quoted, Oracle refuses it on replay with ORA-01843 (#1224).
  describe("a zoned timestamp's ISO text, as it arrives over HTTP (#1224)", () => {
    const fromTz = `VALUES (FROM_TZ(TO_TIMESTAMP('2026-08-24 17:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC'));`;

    test("writes the text as the same FROM_TZ literal the Date of that instant gets", () => {
      for (const declared of [
        "TIMESTAMP WITH TIME ZONE",
        "TIMESTAMP WITH LOCAL TIME ZONE",
        "timestamp(6) with time zone",
        "TIMESTAMP(9) WITH LOCAL TIME ZONE",
      ]) {
        const overHttp = oracle({ at: declared }, instant.toISOString());
        expect(overHttp).toContain(fromTz);
        expect(overHttp).toBe(oracle({ at: declared }, instant));
      }
    });

    test("pads the fields of an early year the way the Date path does", () => {
      expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, "0099-01-02T03:04:05.006Z")).toContain(
        `VALUES (FROM_TZ(TO_TIMESTAMP('0099-01-02 03:04:05.006', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC'));`,
      );
    });

    // The declaration is what makes the text an instant, as it is for #1131's text.
    test("leaves the same text quoted in a column not declared a zoned timestamp", () => {
      const text = instant.toISOString();
      for (const columnTypes of [{ at: "TIMESTAMP" }, { at: "TIMESTAMP(6)" }, { at: "DATE" }, { at: "VARCHAR2" }]) {
        expect(oracle(columnTypes, text)).toContain(`VALUES ('2026-08-24T17:11:12.345Z');`);
      }
      expect(oracle(undefined, text)).toContain(`VALUES ('2026-08-24T17:11:12.345Z');`);
      // Ending in `TIME ZONE`, or in the whole zoned name, is not being a zoned timestamp: the
      // Date path's fallback reads both as zoned, but only the declared type takes this path.
      expect(oracle({ at: "VARCHAR2 TIME ZONE" }, text)).toContain(`VALUES ('2026-08-24T17:11:12.345Z');`);
      expect(oracle({ at: "VARCHAR2 TIMESTAMP WITH TIME ZONE" }, text)).toContain(
        `VALUES ('2026-08-24T17:11:12.345Z');`,
      );
    });

    // Only the exact form `Date#toISOString` writes is an instant the driver handed over.
    test("leaves zoned text that is not exactly the ISO form quoted", () => {
      for (const text of [
        "2026-08-24T17:11:12.345+00:00",
        "2026-08-24T17:11:12Z",
        "2026-08-24T17:11:12.345678Z",
        "2026-08-24 17:11:12.345Z",
        "2026-08-24T17:11:12.345z",
        "2026-08-24 10:11:12.345 -07:00",
      ]) {
        expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, text)).toContain(`VALUES ('${text}');`);
      }
    });

    // The form fits, but no `Date` writes it: there is no 30 February, and `24:00` is the
    // next day's `00:00` to `toISOString`.
    test("leaves text in the ISO form that is not a real instant quoted", () => {
      for (const text of ["2026-02-30T00:00:00.000Z", "2026-09-01T24:00:00.000Z", "2026-13-01T00:00:00.000Z"]) {
        expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, text)).toContain(`VALUES ('${text}');`);
      }
    });

    // `toISOString` writes a year outside 0000-9999 with a sign and six digits. Oracle has
    // no year after 9999, and a BC instant does not replay through the Date path either,
    // so both stay quoted rather than taking a literal the Date path does not write.
    test("leaves a six-digit signed year quoted", () => {
      for (const text of ["-000044-03-15T10:30:00.000Z", "+012026-09-01T07:30:00.000Z"]) {
        expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, text)).toContain(`VALUES ('${text}');`);
      }
    });

    // The literal is built from the parsed instant, and the match has to cover the whole
    // cell: a valid ISO instant with anything before or after it is ordinary text.
    test("leaves an ISO instant with text before or after it quoted and escaped", () => {
      expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, "2026-08-24T17:11:12.345Z'); DROP TABLE x; --")).toContain(
        `VALUES ('2026-08-24T17:11:12.345Z''); DROP TABLE x; --');`,
      );
      expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, "x'); DROP TABLE x; -- 2026-08-24T17:11:12.345Z")).toContain(
        `VALUES ('x''); DROP TABLE x; -- 2026-08-24T17:11:12.345Z');`,
      );
      expect(oracle({ at: "TIMESTAMP WITH TIME ZONE" }, "2026-08-24T17:11:12.345Z\n")).toContain(
        `VALUES ('2026-08-24T17:11:12.345Z\n');`,
      );
    });
  });
});

describe("buildResultExport: a cell whose literal depends on its declared type (#1386)", () => {
  // Each row below is the shape the value has after the trip through JSON that every
  // result takes to the browser, and the declared type is what the provider reports in
  // `columnTypes`. The literal is the one replayed into the engine's own copy of the table
  // on 2026-10-04.
  const insert = (
    dialect: Parameters<typeof buildResultExport>[1]["dialect"],
    row: Record<string, unknown>,
    columnTypes: Record<string, string>,
  ) => buildResultExport("sql-insert", source({ rows: [row], fields: Object.keys(row), dialect, columnTypes })).content;

  test("writes a Postgres array as an array literal, not as JSON", () => {
    expect(insert("postgres", { a: [1, 2, 3] }, { a: "integer[]" })).toContain(`VALUES ('{"1","2","3"}');`);
    expect(insert("postgres", { a: [] }, { a: "integer[]" })).toContain(`VALUES ('{}');`);
    expect(
      insert(
        "postgres",
        {
          a: [
            [1, 2],
            [3, null],
          ],
        },
        { a: "integer[]" },
      ),
    ).toContain(`VALUES ('{{"1","2"},{"3",NULL}}');`);
  });

  test("escapes a Postgres text element that holds a quote, a comma, a brace or the word NULL", () => {
    const content = insert(
      "postgres",
      { a: ["q'x", "a,b", "{b}", "NULL", null, 'say "hi"', "back\\slash"] },
      { a: "text[]" },
    );

    expect(content).toContain(`VALUES ('{"q''x","a,b","{b}","NULL",NULL,"say \\"hi\\"","back\\\\slash"}');`);
  });

  test("writes each element of a json or jsonb array as one document, arrays included", () => {
    expect(insert("postgres", { a: [{ a: 1 }, [1, 2]] }, { a: "jsonb[]" })).toContain(
      `VALUES ('{"{\\"a\\":1}","[1,2]"}');`,
    );
  });

  test("leaves an array in a jsonb column as the JSON document it is", () => {
    expect(insert("postgres", { a: [1, 2] }, { a: "jsonb" })).toContain(`VALUES ('[1,2]');`);
    expect(insert("postgres", { a: [1, 2] }, {})).toContain(`VALUES ('[1,2]');`);
  });

  test("writes a Postgres interval as interval text", () => {
    expect(insert("postgres", { a: { days: 1, hours: 2 } }, { a: "interval" })).toContain(`VALUES ('1 days 2 hours');`);
    expect(
      insert("postgres", { a: { years: -1, months: -2, days: 3, seconds: -1, milliseconds: -500 } }, { a: "interval" }),
    ).toContain(`VALUES ('-1 years -2 months 3 days -1 seconds -500 milliseconds');`);
    expect(insert("postgres", { a: {} }, { a: "interval" })).toContain(`VALUES ('0 seconds');`);
  });

  test("writes a Postgres point and circle in their input syntax", () => {
    expect(insert("postgres", { a: { x: 1, y: 2 } }, { a: "point" })).toContain(`VALUES ('(1,2)');`);
    expect(insert("postgres", { a: { x: 1, y: 2, radius: 3 } }, { a: "circle" })).toContain(`VALUES ('<(1,2),3>');`);
  });

  test("writes the elements of an interval, point or bytea array in their own text forms", () => {
    expect(insert("postgres", { a: [{ days: 1 }, {}] }, { a: "interval[]" })).toContain(
      `VALUES ('{"1 days","0 seconds"}');`,
    );
    expect(insert("postgres", { a: [{ x: 1, y: 2 }] }, { a: "point[]" })).toContain(`VALUES ('{"(1,2)"}');`);
    expect(insert("postgres", { a: [{ type: "Buffer", data: [1, 255] }] }, { a: "bytea[]" })).toContain(
      `VALUES ('{"\\\\x01ff"}');`,
    );
    expect(insert("postgres", { a: [true, false] }, { a: "boolean[]" })).toContain(`VALUES ('{"true","false"}');`);
  });

  // The MySQL date writer is left out until the provider reads the server's own date text
  // (#1388), since it would have to guess the connection's timezone.
  test("leaves a MySQL date to the generic writer", () => {
    expect(insert("mysql", { a: "2024-12-31T23:59:59.999Z" }, { a: "datetime" })).toContain(
      "VALUES ('2024-12-31T23:59:59.999Z');",
    );
  });

  test("writes a SQL Server BIT as 1 and 0, since T-SQL has no true or false", () => {
    expect(insert("mssql", { a: true, b: false }, { a: "bit", b: "bit" })).toContain("VALUES (1, 0);");
  });

  test("still writes true and false where the dialect reads them", () => {
    expect(insert("postgres", { a: true }, { a: "boolean" })).toContain("VALUES (true);");
  });

  test("writes a ClickHouse Array, Map and Tuple as ClickHouse literals", () => {
    expect(insert("clickhouse", { a: [1, 2, 3] }, { a: "Array(Int32)" })).toContain("VALUES ([1, 2, 3]);");
    expect(insert("clickhouse", { a: { k: 1, "it's": 2 } }, { a: "Map(String, Int32)" })).toContain(
      "VALUES (map('k', 1, 'it''s', 2));",
    );
    expect(insert("clickhouse", { a: {} }, { a: "Map(String, Int32)" })).toContain("VALUES (map());");
    expect(insert("clickhouse", { a: [1, "x"] }, { a: "Tuple(Int32, String)" })).toContain("VALUES (tuple(1, 'x'));");
    expect(insert("clickhouse", { a: { b: ["p"], a: 7 } }, { a: "Tuple(a Int32, b Array(String))" })).toContain(
      "VALUES (tuple(7, ['p']));",
    );
    expect(insert("clickhouse", { a: [[1, null], []] }, { a: "Array(Array(Nullable(Int32)))" })).toContain(
      "VALUES ([[1, NULL], []]);",
    );
  });

  test("writes a quoted 64-bit integer inside a ClickHouse container bare", () => {
    expect(insert("clickhouse", { a: ["18446744073709551615"] }, { a: "Array(UInt64)" })).toContain(
      "VALUES ([18446744073709551615]);",
    );
    expect(insert("clickhouse", { a: { "1": "2.5" } }, { a: "Map(UInt8, Decimal(9, 2))" })).toContain(
      "VALUES (map(1, 2.5));",
    );
  });

  test("leaves a dialect with no typed form, and a scalar ClickHouse column, to the generic writer", () => {
    expect(insert("sqlite", { a: [1, 2] }, { a: "integer[]" })).toContain(`VALUES ('[1,2]');`);
    expect(insert("clickhouse", { a: "18446744073709551615" }, { a: "UInt64" })).toContain(
      "VALUES ('18446744073709551615');",
    );
  });
});

describe("buildResultExport: Trino, DuckDB and Cassandra literals (#1386)", () => {
  // Each value is the shape the provider hands over after the trip through JSON, and each
  // literal replayed into the engine's own copy of the table on 2026-10-04.
  const insert = (
    dialect: Parameters<typeof buildResultExport>[1]["dialect"],
    row: Record<string, unknown>,
    columnTypes: Record<string, string>,
  ) => buildResultExport("sql-insert", source({ rows: [row], fields: Object.keys(row), dialect, columnTypes })).content;

  test("writes each Trino type by its own literal, since INSERT coerces no varchar into it", () => {
    const content = insert(
      "trino",
      {
        b: "9007199254740993",
        dec: "1.5",
        r: 0.1,
        d: "2024-02-29",
        t: "13:14:15.123",
        ts: "2024-12-31 23:59:59.999",
        tz: "2024-12-31 23:59:59.999 Europe/Istanbul",
        j: '{"s":"it\'s"}',
        u: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        ip: "10.0.0.1",
        vb: "AQL/",
        v: "x",
      },
      {
        b: "bigint",
        dec: "decimal(20, 4)",
        r: "real",
        d: "date",
        t: "time",
        ts: "timestamp(3)",
        tz: "timestamp with time zone",
        j: "json",
        u: "uuid",
        ip: "ipaddress",
        vb: "varbinary",
        v: "varchar",
      },
    );

    expect(content).toContain(
      "VALUES (9007199254740993, DECIMAL '1.5', REAL '0.1', DATE '2024-02-29', TIME '13:14:15.123', " +
        "TIMESTAMP '2024-12-31 23:59:59.999', TIMESTAMP '2024-12-31 23:59:59.999 Europe/Istanbul', " +
        `JSON '{"s":"it''s"}', UUID 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', IPADDRESS '10.0.0.1', X'0102ff', 'x');`,
    );
  });

  test("writes a Trino array, map and row, nested and empty", () => {
    expect(insert("trino", { a: [[1, null], []] }, { a: "array(array(integer))" })).toContain(
      "VALUES (ARRAY[ARRAY[1, NULL], ARRAY[]]);",
    );
    expect(
      insert("trino", { a: { p: [1.5, ["q"]] } }, { a: "map(varchar, row(x double, y array(varchar)))" }),
    ).toContain("VALUES (MAP(ARRAY['p'], ARRAY[ROW(1.5, ARRAY['q'])]));");
    expect(insert("trino", { a: {} }, { a: "map(varchar, integer)" })).toContain("VALUES (MAP());");
    expect(insert("trino", { a: { k: { s: 1 } } }, { a: "map(varchar, json)" })).toContain(
      `VALUES (MAP(ARRAY['k'], ARRAY[JSON '{"s":1}']));`,
    );
  });

  test("writes a DuckDB INTERVAL, MAP, STRUCT and list as DuckDB literals", () => {
    expect(insert("duckdb", { a: { months: 14, days: 3, micros: "14706000001" } }, { a: "INTERVAL" })).toContain(
      "VALUES (INTERVAL '14 months 3 days 14706000001 microseconds');",
    );
    expect(
      insert(
        "duckdb",
        {
          a: [
            { key: "k", value: 1 },
            { key: "it's", value: 2 },
          ],
        },
        { a: "MAP(VARCHAR, INTEGER)" },
      ),
    ).toContain("VALUES (MAP {'k': 1, 'it''s': 2});");
    expect(insert("duckdb", { a: [] }, { a: "MAP(VARCHAR, INTEGER)" })).toContain("VALUES (MAP {});");
    expect(insert("duckdb", { a: { b: ["p"], a: "7" } }, { a: 'STRUCT("a" BIGINT, "b" VARCHAR[])' })).toContain(
      "VALUES ({'a': 7, 'b': ['p']});",
    );
    expect(insert("duckdb", { a: [[1, null], []] }, { a: "INTEGER[][]" })).toContain("VALUES ([[1, NULL], []]);");
    expect(insert("duckdb", { a: [1, 2, 3] }, { a: "INTEGER[3]" })).toContain("VALUES ([1, 2, 3]);");
  });

  test("leaves a quoted DuckDB scalar, which DuckDB reads back, to the generic writer", () => {
    expect(insert("duckdb", { a: "170141183460469231731687303715884105727" }, { a: "HUGEINT" })).toContain(
      "VALUES ('170141183460469231731687303715884105727');",
    );
  });

  test("writes CQL collections, tuples, UDTs, wide numbers, uuids and durations unquoted", () => {
    const content = insert(
      "cassandra",
      {
        li: [1, 2],
        st: ["a", "it's"],
        mp: { "1": ["x"] },
        tup: [7, "x"],
        addr: { street: "Main", zip: 1 },
        b: "9007199254740993",
        vi: "-1",
        u: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        du: "1mo2d3h",
        nl: [[1], []],
      },
      {
        li: "list<int>",
        st: "set<varchar>",
        mp: "map<int, frozen<set<varchar>>>",
        tup: "tuple<int, varchar>",
        addr: "address",
        b: "bigint",
        vi: "varint",
        u: "uuid",
        du: "duration",
        nl: "list<list<int>>",
      },
    );

    expect(content).toContain(
      `VALUES ([1, 2], {'a', 'it''s'}, {1: {'x'}}, (7, 'x'), {"street": 'Main', "zip": 1}, 9007199254740993, -1, ` +
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11, 1mo2d3h, [[1], []]);",
    );
  });

  test("freezes a collection nested in a CQL collection in the DDL", () => {
    const ddl = buildResultExport(
      "sql-ddl",
      source({
        rows: [{ a: null, b: null, c: null, d: null }],
        fields: ["a", "b", "c", "d"],
        dialect: "cassandra",
        columnTypes: {
          a: "list<list<int>>",
          b: "map<int, set<varchar>>",
          c: "list<address>",
          d: "list<frozen<list<int>>>",
        },
      }),
    ).content;

    expect(ddl).toContain('"a" list<frozen<list<int>>>');
    expect(ddl).toContain('"b" map<int, frozen<set<varchar>>>');
    expect(ddl).toContain('"c" list<frozen<address>>');
    expect(ddl).toContain('"d" list<frozen<list<int>>>');
  });

  test("still completes a bare CQL name the frozen rewrite leaves alone", () => {
    const ddl = buildResultExport(
      "sql-ddl",
      source({ rows: [{ a: null }], fields: ["a"], dialect: "cassandra", columnTypes: { a: "character varying" } }),
    ).content;

    expect(ddl).toContain('"a" TEXT');
  });

  test("keeps a DuckDB STRUCT, fixed array and nested list type in the DDL", () => {
    const ddl = buildResultExport(
      "sql-ddl",
      source({
        rows: [{ a: null, b: null, c: null }],
        fields: ["a", "b", "c"],
        dialect: "duckdb",
        columnTypes: { a: 'STRUCT("a" INTEGER, "b" VARCHAR[])', b: "INTEGER[3]", c: "MAP(INTEGER, VARCHAR[])" },
      }),
    ).content;

    expect(ddl).toContain('"a" STRUCT("a" INTEGER, "b" VARCHAR[])');
    expect(ddl).toContain('"b" INTEGER[3]');
    expect(ddl).toContain('"c" MAP(INTEGER, VARCHAR[])');
  });
});

describe("buildResultExport: a row with a cell the dialect has no literal for (#1386)", () => {
  test("skips that row with a comment naming the column, and writes the others", () => {
    const content = buildResultExport(
      "sql-insert",
      source({
        rows: [{ t: [7, "x"] }, { t: [7] }, { t: [8, "y"] }],
        fields: ["t"],
        dialect: "cassandra",
        columnTypes: { t: "tuple<int, varchar>" },
      }),
    ).content;

    expect(content).toBe(
      [
        `INSERT INTO users ("t") VALUES ((7, 'x'));`,
        `-- Row 2 skipped: column "t" holds a tuple that does not have its declared length, which cassandra has no literal for.`,
        `INSERT INTO users ("t") VALUES ((8, 'y'));`,
      ].join("\n"),
    );
  });

  test("cannot let a column name end the comment", () => {
    const content = buildResultExport(
      "sql-insert",
      source({
        rows: [{ "a\nDROP TABLE x; --\u2028": "not a list" }],
        fields: ["a\nDROP TABLE x; --\u2028"],
        dialect: "trino",
        columnTypes: { "a\nDROP TABLE x; --\u2028": "array(integer)" },
      }),
    ).content;

    expect(content.split("\n")).toHaveLength(1);
    expect(content).toBe(
      '-- Row 1 skipped: column "a\\nDROP TABLE x; --?" holds an array that is not a list, which trino has no literal for.',
    );
  });
});

describe("buildResultExport: the table the producing query read (#1386)", () => {
  test("names the one table a SELECT reads, ahead of the tab's title", () => {
    const content = buildResultExport(
      "sql-insert",
      source({ tabName: "Query 1", query: "SELECT * FROM public.orders WHERE id > 1" }),
    ).content;

    expect(content).toContain("INSERT INTO public.orders (");
  });

  test("falls back to the tab's title for a join, a quoted name or no query", () => {
    const name = (query: string | undefined) =>
      buildResultExport("sql-insert", source({ tabName: "users", query })).content.split(" (")[0];

    expect(name("SELECT * FROM a JOIN b ON a.id = b.id")).toBe("INSERT INTO users");
    expect(name('SELECT * FROM "Order Items"')).toBe("INSERT INTO users");
    expect(name(undefined)).toBe("INSERT INTO users");
  });
});

describe("resultExportFileName", () => {
  test("names a file the user's own query produced after the result", () => {
    expect(resultExportFileName("csv")).toBe("query_result_export.csv");
  });

  // B34: a file carrying an agent run's rows must not be indistinguishable from one
  // the user ran, so the run it came from is in the name.
  test("names a run's own file after the run", () => {
    expect(resultExportFileName("json", "arun_7f3c")).toBe("agent_run_arun_7f3c_export.json");
  });

  test("keeps a run id out of the path and off the extension", () => {
    expect(resultExportFileName("csv", "../../etc/passwd")).toBe("agent_run_etc-passwd_export.csv");
    expect(resultExportFileName("csv", "run.2026/08")).toBe("agent_run_run-2026-08_export.csv");
  });

  test("still says the file came from a run when the id contributes nothing nameable", () => {
    // The attribution is the point; a run id made entirely of characters a file name
    // cannot carry leaves the attribution and drops the id.
    expect(resultExportFileName("csv", "///")).toBe("agent_run_export.csv");
  });

  test("caps how much of a run id reaches the name", () => {
    const name = resultExportFileName("csv", "r".repeat(200));
    expect(name).toBe(`agent_run_${"r".repeat(64)}_export.csv`);
  });
});

describe("buildResultExport — markdown and html", () => {
  test("writes a Markdown table with the shared mime type and extension", () => {
    const file = buildResultExport("markdown", source());
    expect(file.content).toBe("| id | name |\n| --- | --- |\n| 1 | Ada |");
    expect(file.mimeType).toBe("text/markdown;charset=utf-8");
    expect(file.extension).toBe("md");
  });

  test("writes an HTML table with the shared mime type and extension", () => {
    const file = buildResultExport("html", source());
    expect(file.content).toContain("<tr><th>id</th><th>name</th></tr>");
    expect(file.content).toContain("<tr><td>1</td><td>Ada</td></tr>");
    expect(file.mimeType).toBe("text/html;charset=utf-8");
    expect(file.extension).toBe("html");
  });

  test("ignores the dialect for the two text formats, which name no engine", () => {
    const markdown = buildResultExport("markdown", source({ dialect: "oracle" }));
    const html = buildResultExport("html", source({ dialect: "mssql" }));
    expect(markdown.content).toBe("| id | name |\n| --- | --- |\n| 1 | Ada |");
    expect(html.content).toContain("<tr><td>1</td><td>Ada</td></tr>");
  });

  test("returns text content, never a binary blob", () => {
    expect(typeof buildResultExport("markdown", source()).content).toBe("string");
    expect(typeof buildResultExport("html", source()).content).toBe("string");
  });
});
