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
    expect(file.mimeType).toBe("text/csv");
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

  test("emits nothing for a result with no rows", () => {
    const file = buildResultExport("sql-insert", source({ rows: [] }));

    expect(file.content).toBe("");
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
      'CREATE TABLE users (\n  "id" INTEGER,\n  "score" NUMERIC,\n  "ok" BOOLEAN,\n  "at" TIMESTAMP\n);',
    );
  });

  test("falls back to TEXT for a column that is null in every row", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [{ note: null }], fields: ["note"] }));

    expect(file.content).toContain('"note" TEXT');
  });

  test("types a bigint as an integer column", () => {
    const file = buildResultExport("sql-ddl", source({ rows: [{ n: BigInt(10) }], fields: ["n"] }));

    expect(file.content).toContain('"n" INTEGER');
  });

  test("quotes column names for the dialect", () => {
    const file = buildResultExport("sql-ddl", source({ dialect: "mssql" }));

    expect(file.content).toContain("[id] INTEGER");
    expect(file.content).toContain("[name] TEXT");
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
