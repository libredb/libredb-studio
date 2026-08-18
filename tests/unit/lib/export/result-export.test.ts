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
