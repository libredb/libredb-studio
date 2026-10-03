/**
 * The Db2 catalog statements and their row readers (#786).
 *
 * Every row shape here was measured through db2-node 1.0.22 on Db2 LUW 12.1.0.0, and the catalog
 * reads were re-run live through 1.0.24 on 12.1.0.0 and 11.5.9.0: the HEX of
 * `Grüße` (`4772C3BCC39F65`), the CODEUNITS32 column whose LENGTH is 40 and whose declared length
 * is 10, the 16-byte DECFLOAT(34), the default `0` padded with 253 blanks by SUBSTRING and the
 * NULL definition of an EXTERNAL routine.
 */

import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import * as catalog from "@/lib/db/providers/sql/db2/catalog";
import {
  CODE_PAGE_SQL,
  COUNT_KINDS,
  DEFAULT_BYTE_LIMIT,
  OBJECT_FOREIGN_KEYS_SQL,
  SOURCE_BYTE_LIMIT,
  UTF8_CODE_PAGE,
  bulkDetailSql,
  bulkTargetSql,
  columnType,
  decodeCatalogBytes,
  decodeCatalogHex,
  decodeCatalogRow,
  objectDetailFromRows,
  objectStatus,
  sourceLength,
  sourceText,
} from "@/lib/db/providers/sql/db2/catalog";

const hex = (text: string): string => Buffer.from(text, "utf8").toString("hex").toUpperCase();

/** Every SQL text the module exports, constants and builders alike. */
function everyStatement(): [string, string][] {
  const statements: [string, string][] = [];
  for (const [name, value] of Object.entries(catalog)) {
    if (typeof value === "string" && /\bSELECT\b/.test(value)) statements.push([name, value]);
    // The source reads are head and tail pairs.
    if (typeof value === "object" && value !== null && "head" in value && "tail" in value) {
      statements.push([`${name}.head`, String(value.head)], [`${name}.tail`, String(value.tail)]);
    }
  }
  for (const bounded of [false, true]) {
    statements.push([`bulkTargetSql(${bounded})`, bulkTargetSql(bounded)]);
    for (const [part, sql] of Object.entries(bulkDetailSql(bounded))) {
      statements.push([`bulkDetailSql(${bounded}).${part}`, sql]);
    }
  }
  return statements;
}

describe("M1: no catalog statement selects a LOB", () => {
  test("every statement was found", () => {
    expect(everyStatement().length).toBeGreaterThanOrEqual(20);
  });

  test.each(everyStatement())(
    "%s reads DEFAULT and TEXT only through VARCHAR(SUBSTRING(...)) or LENGTH(...)",
    (_name, sql) => {
      // Remove every allowed read, then nothing naming the two LOB columns may be left.
      const stripped = sql
        .replace(/VARCHAR\(SUBSTRING\((?:v\.)?(?:TEXT|"DEFAULT"), \d+, \d+, OCTETS\), \d+\)/g, "")
        .replace(/LENGTH\((?:v\.)?(?:TEXT|"DEFAULT")\)/g, "");
      expect(stripped).not.toMatch(/"DEFAULT"/);
      expect(stripped).not.toMatch(/\b(?:v\.)?TEXT\b/);
      expect(sql).not.toContain("STMT_TEXT");
      // The form that desynchronises the driver on a long definition (measured).
      expect(sql).not.toMatch(/CAST\(\s*(?:v\.)?TEXT/);
    },
  );
});

describe("M5: blank-padded CHAR columns are trimmed in the statement", () => {
  test.each([
    ["CONTAINERS_SQL", "HEX(RTRIM(SCHEMANAME))"],
    ["LIST_TABLES_SQL", "RTRIM(t.STATUS)"],
    ["LIST_TABLES_SQL", "RTRIM(v.VALID)"],
    ["LIST_ROUTINES_SQL", "RTRIM(VALID)"],
    ["LIST_TRIGGERS_SQL", "RTRIM(VALID)"],
    ["OBJECT_FOREIGN_KEYS_SQL", "HEX(RTRIM(r.REFTABSCHEMA))"],
    ["OBJECT_INDEXES_SQL", "HEX(RTRIM(i.INDSCHEMA))"],
    ["OBJECT_INDEXES_SQL", "RTRIM(i.UNIQUERULE)"],
    ["OBJECT_COLUMNS_SQL", "RTRIM(NULLS)"],
    ["COUNTS_SQL", "RTRIM('TABLES:' CONCAT TYPE)"],
    ["COUNTS_SQL", "RTRIM('ROUTINES:' CONCAT ROUTINETYPE)"],
  ])("%s carries %s", (name, fragment) => {
    expect((catalog as Record<string, unknown>)[name]).toContain(fragment);
  });

  test("the routine source read trims ORIGIN", () => {
    expect(catalog.ROUTINE_SOURCE.head).toContain("RTRIM(ORIGIN)");
  });
});

describe("the foreign key read", () => {
  test("joins the referenced key columns by table as well as by constraint name", () => {
    // Two tables can each have a key named PK; without the table term both joined.
    expect(OBJECT_FOREIGN_KEYS_SQL).toContain("pk.TABNAME = r.REFTABNAME");
    expect(bulkDetailSql(false).foreignKeys).toContain("pk.TABNAME = r.REFTABNAME");
  });
});

describe("the count statement", () => {
  test("binds the schema five times", () => {
    expect(catalog.COUNTS_SQL.match(/\?/g)).toHaveLength(5);
  });

  test("names nine kinds", () => {
    expect(Object.values(COUNT_KINDS).sort()).toEqual(
      [
        "alias",
        "function",
        "materialized_query_table",
        "module",
        "procedure",
        "sequence",
        "table",
        "trigger",
        "view",
      ].sort(),
    );
  });
});

describe("the bulk statements", () => {
  test("the target is bound by FETCH FIRST only when the caller bounds it", () => {
    expect(bulkTargetSql(false)).not.toContain("FETCH FIRST");
    expect(bulkTargetSql(true)).toContain("ORDER BY TABNAME FETCH FIRST ? ROWS ONLY");
    expect(bulkTargetSql(true).match(/\?/g)).toHaveLength(3);
  });

  test("each detail read scopes itself to the target set and binds the schema once more", () => {
    const detail = bulkDetailSql(true);
    expect(detail.columns).toContain("TABNAME IN (SELECT OBJECT_NAME FROM TARGET)");
    expect(detail.foreignKeys).toContain("r.TABNAME IN (SELECT OBJECT_NAME FROM TARGET)");
    expect(detail.indexes).toContain("i.TABNAME IN (SELECT OBJECT_NAME FROM TARGET)");
    for (const sql of Object.values(detail)) expect(sql.match(/\?/g)).toHaveLength(4);
    for (const sql of Object.values(bulkDetailSql(false))) expect(sql.match(/\?/g)).toHaveLength(3);
  });
});

describe("decoding catalog text", () => {
  test("the code page is read off a column every database has", () => {
    expect(CODE_PAGE_SQL).toContain("TABNAME = 'SYSDUMMY1'");
    expect(UTF8_CODE_PAGE).toBe(1208);
  });

  test("a non-ASCII name decodes exactly in a Unicode database (measured HEX)", () => {
    expect(decodeCatalogHex("4772C3BCC39F65", UTF8_CODE_PAGE)).toBe("Grüße");
  });

  test("a cut inside a character drops the incomplete character", () => {
    // "ü" is C3 BC; cutting after C3 leaves half of it.
    expect(decodeCatalogHex("4772C3BC", UTF8_CODE_PAGE, 3)).toBe("Gr");
  });

  test("ASCII decodes in any code page", () => {
    expect(decodeCatalogBytes(Buffer.from("ORDERS"), 819)).toBe("ORDERS");
  });

  test("non-ASCII text in a non-Unicode database is refused, never guessed", () => {
    expect(() => decodeCatalogBytes(Buffer.from([0x47, 0xfc]), 819)).toThrow(QueryError);
    expect(() => decodeCatalogBytes(Buffer.from([0x47, 0xfc]), 819)).toThrow(/code page is 819/);
  });

  test("a row's _HEX columns decode under their own names and the rest pass through", () => {
    const row = decodeCatalogRow({ NAME_HEX: hex("Mixed Case"), PARENT_HEX: null, VALID: "Y", N: 3 }, UTF8_CODE_PAGE);
    expect(row).toEqual({ NAME: "Mixed Case", PARENT: null, VALID: "Y", N: 3 });
  });
});

describe("objectStatus", () => {
  test.each([
    [{ VALID: "N" }, { status: "INVALID" }],
    [{ VALID: "X" }, { status: "INOPERATIVE" }],
    [{ STATUS: "X", VALID: "Y" }, { status: "INOPERATIVE" }],
    [{ STATUS: "C" }, { status: "SET INTEGRITY PENDING" }],
    [{ STATUS: "N", VALID: "Y" }, {}],
    [{}, {}],
  ])("%p reads as %p", (row, expected) => {
    expect(objectStatus(row)).toEqual(expected);
  });
});

describe("columnType", () => {
  const row = (fields: Record<string, unknown>) => ({ CODEPAGE: 1208, ...fields });

  test.each([
    [{ TYPENAME: "VARCHAR", LENGTH: 50, TYPESTRINGUNITS: "OCTETS", STRINGUNITSLENGTH: 50 }, "VARCHAR(50)"],
    [
      { TYPENAME: "VARCHAR", LENGTH: 40, TYPESTRINGUNITS: "CODEUNITS32", STRINGUNITSLENGTH: 10 },
      "VARCHAR(10 CODEUNITS32)",
    ],
    [
      { TYPENAME: "CHARACTER", LENGTH: 16, TYPESTRINGUNITS: "CODEUNITS32", STRINGUNITSLENGTH: 4 },
      "CHARACTER(4 CODEUNITS32)",
    ],
    [{ TYPENAME: "CHARACTER", LENGTH: 10, TYPESTRINGUNITS: "OCTETS", STRINGUNITSLENGTH: 10 }, "CHARACTER(10)"],
    [{ TYPENAME: "CHARACTER", LENGTH: 4, CODEPAGE: 0, TYPESTRINGUNITS: null }, "CHARACTER(4) FOR BIT DATA"],
    [{ TYPENAME: "VARCHAR", LENGTH: 8, CODEPAGE: 0, TYPESTRINGUNITS: null }, "VARCHAR(8) FOR BIT DATA"],
    [
      { TYPENAME: "GRAPHIC", LENGTH: 5, CODEPAGE: 1200, TYPESTRINGUNITS: "CODEUNITS16", STRINGUNITSLENGTH: 5 },
      "GRAPHIC(5)",
    ],
    [
      { TYPENAME: "VARGRAPHIC", LENGTH: 40, CODEPAGE: 1200, TYPESTRINGUNITS: "CODEUNITS32", STRINGUNITSLENGTH: 20 },
      "VARGRAPHIC(20 CODEUNITS32)",
    ],
    [
      { TYPENAME: "CLOB", LENGTH: 4096, TYPESTRINGUNITS: "CODEUNITS32", STRINGUNITSLENGTH: 1024 },
      "CLOB(1024 CODEUNITS32)",
    ],
    [
      { TYPENAME: "DBCLOB", LENGTH: 100, CODEPAGE: 1200, TYPESTRINGUNITS: "CODEUNITS16", STRINGUNITSLENGTH: 100 },
      "DBCLOB(100)",
    ],
    [{ TYPENAME: "BLOB", LENGTH: 1048576, CODEPAGE: 0, TYPESTRINGUNITS: null }, "BLOB(1048576)"],
    [{ TYPENAME: "VARBINARY", LENGTH: 16, CODEPAGE: 0, TYPESTRINGUNITS: null }, "VARBINARY(16)"],
    [{ TYPENAME: "BINARY", LENGTH: 4, CODEPAGE: 0, TYPESTRINGUNITS: null }, "BINARY(4)"],
    [{ TYPENAME: "DECIMAL", LENGTH: 12, SCALE: 2 }, "DECIMAL(12,2)"],
    [{ TYPENAME: "TIMESTAMP", LENGTH: 10, SCALE: 6 }, "TIMESTAMP"],
    [{ TYPENAME: "TIMESTAMP", LENGTH: 13, SCALE: 12 }, "TIMESTAMP(12)"],
    [{ TYPENAME: "TIMESTAMP", LENGTH: 7, SCALE: 0 }, "TIMESTAMP(0)"],
    [{ TYPENAME: "DECFLOAT", LENGTH: 16 }, "DECFLOAT(34)"],
    [{ TYPENAME: "DECFLOAT", LENGTH: 8 }, "DECFLOAT(16)"],
    [{ TYPENAME: "INTEGER  ", LENGTH: 4 }, "INTEGER"],
    [{ TYPENAME: "XML", LENGTH: 0 }, "XML"],
  ])("%p is %p", (fields, expected) => {
    expect(columnType(row(fields))).toBe(expected);
  });
});

describe("objectDetailFromRows", () => {
  const column = (fields: Record<string, unknown>) => ({
    TYPENAME: "INTEGER",
    LENGTH: 4,
    SCALE: 0,
    CODEPAGE: 0,
    TYPESTRINGUNITS: null,
    STRINGUNITSLENGTH: null,
    NULLS: "Y",
    DEFAULT_BYTES: null,
    DEFAULT_LENGTH: null,
    KEYSEQ: null,
    ...fields,
  });

  test("columns, keys, defaults, indexes and references", () => {
    const detail = objectDetailFromRows(
      ["APP", "ORDERS"],
      "APP",
      {
        columns: [
          column({ COLUMN_NAME: "ID", NULLS: "N", KEYSEQ: 1 }),
          // The measured default: `0` padded to 254 bytes by SUBSTRING, with its real length beside it.
          column({
            COLUMN_NAME: "TOTAL",
            TYPENAME: "DECIMAL",
            LENGTH: 12,
            SCALE: 2,
            DEFAULT_BYTES: `30${"20".repeat(253)}`,
            DEFAULT_LENGTH: 1,
          }),
          column({ COLUMN_NAME: "NOTE", DEFAULT_BYTES: hex("'é'"), DEFAULT_LENGTH: 4 }),
        ],
        foreignKeys: [
          { COLUMN_NAME: "CUSTOMER_ID", REF_SCHEMA: "APP", REF_TABLE: "CUSTOMERS", REF_COLUMN: "ID" },
          { COLUMN_NAME: "DAY_ID", REF_SCHEMA: "REPORTING", REF_TABLE: "DAYS", REF_COLUMN: "ID" },
        ],
        indexes: [
          { INDEX_SCHEMA: "APP", INDEX_NAME: "ORDERS_CUSTOMER_IX", UNIQUERULE: "D", COLUMN_NAME: "CUSTOMER_ID" },
          { INDEX_SCHEMA: "APP", INDEX_NAME: "ORDERS_CUSTOMER_IX", UNIQUERULE: "D", COLUMN_NAME: "TOTAL" },
          { INDEX_SCHEMA: "SYSIBM", INDEX_NAME: "SQL123", UNIQUERULE: "P", COLUMN_NAME: "ID" },
          { INDEX_SCHEMA: "APP", INDEX_NAME: "UQ", UNIQUERULE: "U", COLUMN_NAME: "NOTE" },
        ],
      },
      UTF8_CODE_PAGE,
    );

    expect(detail).toEqual({
      path: ["APP", "ORDERS"],
      columns: [
        { name: "ID", type: "INTEGER", nullable: false, isPrimary: true },
        { name: "TOTAL", type: "DECIMAL(12,2)", nullable: true, isPrimary: false, defaultValue: "0" },
        { name: "NOTE", type: "INTEGER", nullable: true, isPrimary: false, defaultValue: "'é'" },
      ],
      indexes: [
        { name: "ORDERS_CUSTOMER_IX", columns: ["CUSTOMER_ID", "TOTAL"], unique: false },
        { name: "SYSIBM.SQL123", columns: ["ID"], unique: true },
        { name: "UQ", columns: ["NOTE"], unique: true },
      ],
      foreignKeys: [
        { columnName: "CUSTOMER_ID", referencedTable: "CUSTOMERS", referencedColumn: "ID" },
        { columnName: "DAY_ID", referencedTable: "REPORTING.DAYS", referencedColumn: "ID" },
      ],
    });
  });

  test("a default longer than the byte bound is left out rather than shown cut", () => {
    const detail = objectDetailFromRows(
      ["APP", "T"],
      "APP",
      {
        columns: [
          column({ COLUMN_NAME: "C", DEFAULT_BYTES: "41".repeat(254), DEFAULT_LENGTH: DEFAULT_BYTE_LIMIT + 1 }),
        ],
        foreignKeys: [],
        indexes: [],
      },
      UTF8_CODE_PAGE,
    );

    expect(detail.columns[0]).not.toHaveProperty("defaultValue");
  });
});

describe("the source statements", () => {
  test.each([
    ["VIEW_SOURCE", catalog.VIEW_SOURCE],
    ["ROUTINE_SOURCE", catalog.ROUTINE_SOURCE],
    ["TABLE_TRIGGER_SOURCE", catalog.TABLE_TRIGGER_SOURCE],
    ["SCHEMA_TRIGGER_SOURCE", catalog.SCHEMA_TRIGGER_SOURCE],
  ])("%s reads one chunk per row: the head with the length, the tail alone", (_name, statements) => {
    // The tail is read only when a definition needs it, so a short one carries no padding chunk.
    for (const sql of [statements.head, statements.tail]) expect(sql.match(/AS TEXT_BYTES/g)).toHaveLength(1);
    expect(statements.head).toContain("SUBSTRING(");
    expect(statements.head).toContain(", 1, 16336, OCTETS)");
    expect(statements.head).toContain("AS TEXT_LENGTH");
    expect(statements.tail).toContain(", 16337, 16336, OCTETS)");
    expect(statements.tail).not.toContain("TEXT_LENGTH");
    // The same rows, bound the same way.
    expect(statements.head.slice(statements.head.indexOf("FROM "))).toBe(
      statements.tail.slice(statements.tail.indexOf("FROM ")),
    );
  });
});

describe("sourceLength", () => {
  test("a NULL definition has no length", () => {
    expect(sourceLength({ TEXT_BYTES: null, TEXT_LENGTH: null })).toBeNull();
  });

  test("a definition's length is its byte length", () => {
    expect(sourceLength({ TEXT_BYTES: "41", TEXT_LENGTH: 1 })).toBe(1);
  });

  test("any other shape raises rather than reading as a missing definition", () => {
    expect(() => sourceLength({ TEXT_BYTES: 7, TEXT_LENGTH: 1 })).toThrow(QueryError);
    expect(() => sourceLength({ TEXT_BYTES: "41", TEXT_LENGTH: "1" })).toThrow(/not the hex text and byte length/);
    expect(() => sourceLength({ TEXT_BYTES: null, TEXT_LENGTH: 4 })).toThrow(QueryError);
  });
});

describe("sourceText", () => {
  test("a short definition is cut to its own length, dropping SUBSTRING's padding", () => {
    const text = "CREATE VIEW APP.V AS SELECT 'Grüße' AS G FROM SYSIBM.SYSDUMMY1";
    const bytes = Buffer.byteLength(text);

    expect(sourceText([{ TEXT_BYTES: `${hex(text)}${"20".repeat(40)}` }], bytes, UTF8_CODE_PAGE)).toBe(text);
  });

  test("a definition over the byte bound is read up to the bound from its two chunks", () => {
    const text = sourceText(
      [{ TEXT_BYTES: "41".repeat(16336) }, { TEXT_BYTES: "42".repeat(16336) }],
      40868,
      UTF8_CODE_PAGE,
    );

    expect(text.length).toBe(SOURCE_BYTE_LIMIT);
    expect(text.startsWith("A")).toBe(true);
    expect(text.endsWith("B")).toBe(true);
  });

  test("a chunk that is not hex text raises", () => {
    expect(() => sourceText([{ TEXT_BYTES: "41" }, { TEXT_BYTES: null }], 2, UTF8_CODE_PAGE)).toThrow(QueryError);
  });
});
