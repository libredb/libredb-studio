import { describe, test, expect } from "bun:test";
import { buildResultExport, deriveTableName, FALLBACK_TABLE_NAME } from "@/lib/export/result-export";

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

  test("writes a non-finite number as NULL, because NaN is not a SQL number", () => {
    const file = buildResultExport("sql-insert", source({ rows: [{ a: NaN, b: Infinity }], fields: ["a", "b"] }));

    expect(file.content).toContain("VALUES (NULL, NULL);");
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

  test("refuses a declared type holding a quote", () => {
    const file = buildResultExport(
      "sql-ddl",
      source({ rows: [{ a: 1 }], fields: ["a"], columnTypes: { a: 'ENUM("a")' } }),
    );

    expect(file.content).toContain('"a" BIGINT');
  });

  test("refuses an empty declared type", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [{ a: 1 }], fields: ["a"], columnTypes: { a: "" } }));

    expect(file.content).toContain('"a" BIGINT');
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
    for (const dialect of ["mysql", "sqlite", "trino", "druid"] as const) {
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
    for (const bare of ["text", "longtext", "blob", "tinyblob", "datetime", "timestamp", "year"]) {
      expect(ddl({ c: bare }, "mysql")).toContain(`\`c\` ${bare}`);
    }
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

  // Only the four dialects whose bare spellings were measured are completed. SQLite's
  // column types are advisory affinities, and the wire formats of the other engines
  // spell their own types out (`Nullable(String)`), so there is nothing to complete.
  test("leaves a bare type alone for a dialect that was not measured", () => {
    expect(ddl({ c: "varchar" }, "sqlite")).toContain('"c" varchar');
    expect(ddl({ c: "varchar" }, "clickhouse")).toContain('"c" varchar');
    expect(ddl({ c: "varchar" }, undefined)).toContain('"c" varchar');
  });

  // The completion tables are looked up with `Object.hasOwn`: a column declared
  // `constructor` would otherwise read `Object.prototype.constructor` — a function —
  // as its family and write `undefined` into the statement.
  test("does not read a family off the prototype chain", () => {
    expect(ddl({ c: "constructor" }, "mysql")).toContain("`c` constructor");
    expect(ddl({ c: "toString" }, "postgres")).toContain('"c" toString');
  });
});
