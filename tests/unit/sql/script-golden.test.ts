import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasUnterminatedSpan } from "@/lib/sql/spans";
import { isMultiStatement, splitStatements } from "@/lib/sql/statement-splitter";
import type { DatabaseType } from "@/lib/types";

// How every row that reads SQL text splits, counts and bounds one fixed corpus of scripts. The rows fall into a few
// classes, each written out below with its own expected table, so a change to one row's grammar shows up as that row
// leaving its class and every other row staying where it is. The class of a row is written here, never derived from
// the grammar, which would make the test agree with whatever the grammar says.
const CORPUS: readonly string[] = [
  "BEGIN;\nSELECT 1;\nCOMMIT;",
  "BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;",
  "BEGIN RETURN 1; END;\nSELECT 2;",
  "DECLARE x INT; BEGIN x := 1; RETURN x; END;\nSELECT 2;",
  "BEGIN\n FOR i IN 1 TO 3 DO\n SELECT 1;\n END FOR;\n RETURN 1;\nEND;\nSELECT 2;",
  "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$;\nSELECT 2;",
  "CREATE FUNCTION f() RETURNS INT AS 'SELECT 1';\nSELECT 2;",
  "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS BEGIN RETURN 1; END;\nSELECT 2;",
  "EXECUTE IMMEDIATE $$BEGIN RETURN 1; END;$$;\nSELECT 2;",
  "SELECT $t$x;y$t$;\nSELECT 2;",
  "SELECT $$x;y$$;\nSELECT 2;",
  'SELECT 1 AS "a\\";\nSELECT 2 AS "b";',
  "DECLARE\n  x NUMBER;\nBEGIN\n  x := 1;\nEND;\nSELECT 1 FROM dual;",
  "CREATE OR REPLACE PROCEDURE p AS LANGUAGE JAVA NAME 'a.b()';\nSELECT 1 FROM dual;",
  "CREATE OR REPLACE PACKAGE pkg AS\n  PROCEDURE p;\n  FUNCTION f RETURN NUMBER;\nEND pkg;\nSELECT 1 FROM dual;",
  "BEGIN\n  x := (CASE WHEN a THEN 1 END);\nEND;\nSELECT 1 FROM dual;",
  "CREATE FUNCTION f(p_end NUMBER) RETURN NUMBER IS BEGIN RETURN 1; END;\nSELECT 2;",
  "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1;\n  DELETE FROM u;\nEND;\nSELECT 1;",
  "SELECT 1;\nGO\nSELECT 2;",
  "BEGIN\n  NULL;\nEND;\n/\nSELECT 1 FROM dual;",
];

interface Reading {
  statements: { sql: string; start: number; end: number; startLine: number }[];
  multi: boolean;
  unterminated: boolean;
}

// The classes, named by what tells them apart on this corpus:
// - every-code-semicolon: every `;` in code ends a statement, and a `GO` or `/` line is statement text.
// - trigger-body-whole: a `CREATE TRIGGER ... BEGIN ... END` body is one statement.
// - pl-sql-units: a PL/SQL block or unit is one statement with its closing `;`, and a `/` line separates.
// - go-batches: a `GO` line separates and is never sent.
// - pair-dollar-plain-quote: a tagged `$t$` run is code, so its `;` ends a statement, and a backslash inside `"..."`
//   is part of the name, so the quote after it closes the name.
const ROW_CLASS: Readonly<Record<string, string>> = {
  "(no dialect)": "every-code-semicolon",
  postgres: "every-code-semicolon",
  bigquery: "every-code-semicolon",
  snowflake: "pair-dollar-plain-quote",
  mysql: "every-code-semicolon",
  sqlite: "trigger-body-whole",
  libsql: "trigger-body-whole",
  duckdb: "every-code-semicolon",
  oracle: "pl-sql-units",
  db2: "every-code-semicolon",
  mssql: "go-batches",
  clickhouse: "every-code-semicolon",
  druid: "every-code-semicolon",
  trino: "every-code-semicolon",
  cassandra: "every-code-semicolon",
  elasticsearch: "every-code-semicolon",
  opensearch: "every-code-semicolon",
  couchbase: "every-code-semicolon",
  influxdb3: "every-code-semicolon",
  databend: "every-code-semicolon",
  libredb: "every-code-semicolon",
};

const EXPECTED: Readonly<Record<string, readonly Reading[]>> = {
  "every-code-semicolon": [
    {
      statements: [
        { sql: "BEGIN", start: 0, end: 5, startLine: 0 },
        { sql: "SELECT 1", start: 7, end: 15, startLine: 1 },
        { sql: "COMMIT", start: 17, end: 23, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN TRANSACTION", start: 0, end: 17, startLine: 0 },
        { sql: "SELECT 1", start: 19, end: 27, startLine: 1 },
        { sql: "COMMIT", start: 29, end: 35, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN RETURN 1", start: 0, end: 14, startLine: 0 },
        { sql: "END", start: 16, end: 19, startLine: 0 },
        { sql: "SELECT 2", start: 21, end: 29, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "DECLARE x INT", start: 0, end: 13, startLine: 0 },
        { sql: "BEGIN x := 1", start: 15, end: 27, startLine: 0 },
        { sql: "RETURN x", start: 29, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n FOR i IN 1 TO 3 DO\n SELECT 1", start: 0, end: 35, startLine: 0 },
        { sql: "END FOR", start: 38, end: 45, startLine: 3 },
        { sql: "RETURN 1", start: 48, end: 56, startLine: 4 },
        { sql: "END", start: 58, end: 61, startLine: 5 },
        { sql: "SELECT 2", start: 63, end: 71, startLine: 6 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$",
          start: 0,
          end: 86,
          startLine: 0,
        },
        { sql: "SELECT 2", start: 88, end: 96, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f() RETURNS INT AS 'SELECT 1'", start: 0, end: 45, startLine: 0 },
        { sql: "SELECT 2", start: 47, end: 55, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS BEGIN RETURN 1",
          start: 0,
          end: 74,
          startLine: 0,
        },
        { sql: "END", start: 76, end: 79, startLine: 0 },
        { sql: "SELECT 2", start: 81, end: 89, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "EXECUTE IMMEDIATE $$BEGIN RETURN 1; END;$$", start: 0, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $t$x;y$t$", start: 0, end: 16, startLine: 0 },
        { sql: "SELECT 2", start: 18, end: 26, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $$x;y$$", start: 0, end: 14, startLine: 0 },
        { sql: "SELECT 2", start: 16, end: 24, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [{ sql: 'SELECT 1 AS "a\\";\nSELECT 2 AS "b";', start: 0, end: 34, startLine: 0 }],
      multi: false,
      unterminated: true,
    },
    {
      statements: [
        { sql: "DECLARE\n  x NUMBER", start: 0, end: 18, startLine: 0 },
        { sql: "BEGIN\n  x := 1", start: 20, end: 34, startLine: 2 },
        { sql: "END", start: 36, end: 39, startLine: 4 },
        { sql: "SELECT 1 FROM dual", start: 41, end: 59, startLine: 5 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PROCEDURE p AS LANGUAGE JAVA NAME 'a.b()'", start: 0, end: 59, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 61, end: 79, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PACKAGE pkg AS\n  PROCEDURE p", start: 0, end: 46, startLine: 0 },
        { sql: "FUNCTION f RETURN NUMBER", start: 50, end: 74, startLine: 2 },
        { sql: "END pkg", start: 76, end: 83, startLine: 3 },
        { sql: "SELECT 1 FROM dual", start: 85, end: 103, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  x := (CASE WHEN a THEN 1 END)", start: 0, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 2 },
        { sql: "SELECT 1 FROM dual", start: 44, end: 62, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f(p_end NUMBER) RETURN NUMBER IS BEGIN RETURN 1", start: 0, end: 63, startLine: 0 },
        { sql: "END", start: 65, end: 68, startLine: 0 },
        { sql: "SELECT 2", start: 70, end: 78, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1", start: 0, end: 62, startLine: 0 },
        { sql: "DELETE FROM u", start: 66, end: 79, startLine: 2 },
        { sql: "END", start: 81, end: 84, startLine: 3 },
        { sql: "SELECT 1", start: 86, end: 94, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT 1", start: 0, end: 8, startLine: 0 },
        { sql: "GO\nSELECT 2", start: 10, end: 21, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  NULL", start: 0, end: 12, startLine: 0 },
        { sql: "END", start: 14, end: 17, startLine: 2 },
        { sql: "/\nSELECT 1 FROM dual", start: 19, end: 39, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
  ],
  "trigger-body-whole": [
    {
      statements: [
        { sql: "BEGIN", start: 0, end: 5, startLine: 0 },
        { sql: "SELECT 1", start: 7, end: 15, startLine: 1 },
        { sql: "COMMIT", start: 17, end: 23, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN TRANSACTION", start: 0, end: 17, startLine: 0 },
        { sql: "SELECT 1", start: 19, end: 27, startLine: 1 },
        { sql: "COMMIT", start: 29, end: 35, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN RETURN 1", start: 0, end: 14, startLine: 0 },
        { sql: "END", start: 16, end: 19, startLine: 0 },
        { sql: "SELECT 2", start: 21, end: 29, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "DECLARE x INT", start: 0, end: 13, startLine: 0 },
        { sql: "BEGIN x := 1", start: 15, end: 27, startLine: 0 },
        { sql: "RETURN x", start: 29, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n FOR i IN 1 TO 3 DO\n SELECT 1", start: 0, end: 35, startLine: 0 },
        { sql: "END FOR", start: 38, end: 45, startLine: 3 },
        { sql: "RETURN 1", start: 48, end: 56, startLine: 4 },
        { sql: "END", start: 58, end: 61, startLine: 5 },
        { sql: "SELECT 2", start: 63, end: 71, startLine: 6 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$",
          start: 0,
          end: 86,
          startLine: 0,
        },
        { sql: "SELECT 2", start: 88, end: 96, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f() RETURNS INT AS 'SELECT 1'", start: 0, end: 45, startLine: 0 },
        { sql: "SELECT 2", start: 47, end: 55, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS BEGIN RETURN 1",
          start: 0,
          end: 74,
          startLine: 0,
        },
        { sql: "END", start: 76, end: 79, startLine: 0 },
        { sql: "SELECT 2", start: 81, end: 89, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "EXECUTE IMMEDIATE $$BEGIN RETURN 1; END;$$", start: 0, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $t$x;y$t$", start: 0, end: 16, startLine: 0 },
        { sql: "SELECT 2", start: 18, end: 26, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $$x;y$$", start: 0, end: 14, startLine: 0 },
        { sql: "SELECT 2", start: 16, end: 24, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [{ sql: 'SELECT 1 AS "a\\";\nSELECT 2 AS "b";', start: 0, end: 34, startLine: 0 }],
      multi: false,
      unterminated: true,
    },
    {
      statements: [
        { sql: "DECLARE\n  x NUMBER", start: 0, end: 18, startLine: 0 },
        { sql: "BEGIN\n  x := 1", start: 20, end: 34, startLine: 2 },
        { sql: "END", start: 36, end: 39, startLine: 4 },
        { sql: "SELECT 1 FROM dual", start: 41, end: 59, startLine: 5 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PROCEDURE p AS LANGUAGE JAVA NAME 'a.b()'", start: 0, end: 59, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 61, end: 79, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PACKAGE pkg AS\n  PROCEDURE p", start: 0, end: 46, startLine: 0 },
        { sql: "FUNCTION f RETURN NUMBER", start: 50, end: 74, startLine: 2 },
        { sql: "END pkg", start: 76, end: 83, startLine: 3 },
        { sql: "SELECT 1 FROM dual", start: 85, end: 103, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  x := (CASE WHEN a THEN 1 END)", start: 0, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 2 },
        { sql: "SELECT 1 FROM dual", start: 44, end: 62, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f(p_end NUMBER) RETURN NUMBER IS BEGIN RETURN 1", start: 0, end: 63, startLine: 0 },
        { sql: "END", start: 65, end: 68, startLine: 0 },
        { sql: "SELECT 2", start: 70, end: 78, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1;\n  DELETE FROM u;\nEND",
          start: 0,
          end: 84,
          startLine: 0,
        },
        { sql: "SELECT 1", start: 86, end: 94, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT 1", start: 0, end: 8, startLine: 0 },
        { sql: "GO\nSELECT 2", start: 10, end: 21, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  NULL", start: 0, end: 12, startLine: 0 },
        { sql: "END", start: 14, end: 17, startLine: 2 },
        { sql: "/\nSELECT 1 FROM dual", start: 19, end: 39, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
  ],
  "pl-sql-units": [
    {
      statements: [{ sql: "BEGIN;\nSELECT 1;\nCOMMIT;", start: 0, end: 24, startLine: 0 }],
      multi: false,
      unterminated: false,
    },
    {
      statements: [{ sql: "BEGIN TRANSACTION;\nSELECT 1;\nCOMMIT;", start: 0, end: 36, startLine: 0 }],
      multi: false,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN RETURN 1; END;", start: 0, end: 20, startLine: 0 },
        { sql: "SELECT 2", start: 21, end: 29, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "DECLARE x INT; BEGIN x := 1; RETURN x; END;", start: 0, end: 43, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n FOR i IN 1 TO 3 DO\n SELECT 1;\n END FOR;", start: 0, end: 46, startLine: 0 },
        { sql: "RETURN 1", start: 48, end: 56, startLine: 4 },
        { sql: "END", start: 58, end: 61, startLine: 5 },
        { sql: "SELECT 2", start: 63, end: 71, startLine: 6 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$;\nSELECT 2;",
          start: 0,
          end: 97,
          startLine: 0,
        },
      ],
      multi: false,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f() RETURNS INT AS 'SELECT 1';\nSELECT 2;", start: 0, end: 56, startLine: 0 },
      ],
      multi: false,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS BEGIN RETURN 1; END;",
          start: 0,
          end: 80,
          startLine: 0,
        },
        { sql: "SELECT 2", start: 81, end: 89, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "EXECUTE IMMEDIATE $$BEGIN RETURN 1; END;$$", start: 0, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $t$x;y$t$", start: 0, end: 16, startLine: 0 },
        { sql: "SELECT 2", start: 18, end: 26, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $$x;y$$", start: 0, end: 14, startLine: 0 },
        { sql: "SELECT 2", start: 16, end: 24, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [{ sql: 'SELECT 1 AS "a\\";\nSELECT 2 AS "b";', start: 0, end: 34, startLine: 0 }],
      multi: false,
      unterminated: true,
    },
    {
      statements: [
        { sql: "DECLARE\n  x NUMBER;\nBEGIN\n  x := 1;\nEND;", start: 0, end: 40, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 41, end: 59, startLine: 5 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PROCEDURE p AS LANGUAGE JAVA NAME 'a.b()';", start: 0, end: 60, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 61, end: 79, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PACKAGE pkg AS\n  PROCEDURE p;\n  FUNCTION f RETURN NUMBER;\nEND pkg;",
          start: 0,
          end: 84,
          startLine: 0,
        },
        { sql: "SELECT 1 FROM dual", start: 85, end: 103, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  x := (CASE WHEN a THEN 1 END);\nEND;", start: 0, end: 43, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 44, end: 62, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE FUNCTION f(p_end NUMBER) RETURN NUMBER IS BEGIN RETURN 1; END;",
          start: 0,
          end: 69,
          startLine: 0,
        },
        { sql: "SELECT 2", start: 70, end: 78, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1;\n  DELETE FROM u;\nEND;",
          start: 0,
          end: 85,
          startLine: 0,
        },
        { sql: "SELECT 1", start: 86, end: 94, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT 1", start: 0, end: 8, startLine: 0 },
        { sql: "GO\nSELECT 2", start: 10, end: 21, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  NULL;\nEND;", start: 0, end: 18, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 21, end: 39, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
  ],
  "go-batches": [
    {
      statements: [
        { sql: "BEGIN", start: 0, end: 5, startLine: 0 },
        { sql: "SELECT 1", start: 7, end: 15, startLine: 1 },
        { sql: "COMMIT", start: 17, end: 23, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN TRANSACTION", start: 0, end: 17, startLine: 0 },
        { sql: "SELECT 1", start: 19, end: 27, startLine: 1 },
        { sql: "COMMIT", start: 29, end: 35, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN RETURN 1", start: 0, end: 14, startLine: 0 },
        { sql: "END", start: 16, end: 19, startLine: 0 },
        { sql: "SELECT 2", start: 21, end: 29, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "DECLARE x INT", start: 0, end: 13, startLine: 0 },
        { sql: "BEGIN x := 1", start: 15, end: 27, startLine: 0 },
        { sql: "RETURN x", start: 29, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n FOR i IN 1 TO 3 DO\n SELECT 1", start: 0, end: 35, startLine: 0 },
        { sql: "END FOR", start: 38, end: 45, startLine: 3 },
        { sql: "RETURN 1", start: 48, end: 56, startLine: 4 },
        { sql: "END", start: 58, end: 61, startLine: 5 },
        { sql: "SELECT 2", start: 63, end: 71, startLine: 6 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$",
          start: 0,
          end: 86,
          startLine: 0,
        },
        { sql: "SELECT 2", start: 88, end: 96, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f() RETURNS INT AS 'SELECT 1'", start: 0, end: 45, startLine: 0 },
        { sql: "SELECT 2", start: 47, end: 55, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS BEGIN RETURN 1",
          start: 0,
          end: 74,
          startLine: 0,
        },
        { sql: "END", start: 76, end: 79, startLine: 0 },
        { sql: "SELECT 2", start: 81, end: 89, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "EXECUTE IMMEDIATE $$BEGIN RETURN 1; END;$$", start: 0, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $t$x;y$t$", start: 0, end: 16, startLine: 0 },
        { sql: "SELECT 2", start: 18, end: 26, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $$x;y$$", start: 0, end: 14, startLine: 0 },
        { sql: "SELECT 2", start: 16, end: 24, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [{ sql: 'SELECT 1 AS "a\\";\nSELECT 2 AS "b";', start: 0, end: 34, startLine: 0 }],
      multi: false,
      unterminated: true,
    },
    {
      statements: [
        { sql: "DECLARE\n  x NUMBER", start: 0, end: 18, startLine: 0 },
        { sql: "BEGIN\n  x := 1", start: 20, end: 34, startLine: 2 },
        { sql: "END", start: 36, end: 39, startLine: 4 },
        { sql: "SELECT 1 FROM dual", start: 41, end: 59, startLine: 5 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PROCEDURE p AS LANGUAGE JAVA NAME 'a.b()'", start: 0, end: 59, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 61, end: 79, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PACKAGE pkg AS\n  PROCEDURE p", start: 0, end: 46, startLine: 0 },
        { sql: "FUNCTION f RETURN NUMBER", start: 50, end: 74, startLine: 2 },
        { sql: "END pkg", start: 76, end: 83, startLine: 3 },
        { sql: "SELECT 1 FROM dual", start: 85, end: 103, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  x := (CASE WHEN a THEN 1 END)", start: 0, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 2 },
        { sql: "SELECT 1 FROM dual", start: 44, end: 62, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f(p_end NUMBER) RETURN NUMBER IS BEGIN RETURN 1", start: 0, end: 63, startLine: 0 },
        { sql: "END", start: 65, end: 68, startLine: 0 },
        { sql: "SELECT 2", start: 70, end: 78, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1", start: 0, end: 62, startLine: 0 },
        { sql: "DELETE FROM u", start: 66, end: 79, startLine: 2 },
        { sql: "END", start: 81, end: 84, startLine: 3 },
        { sql: "SELECT 1", start: 86, end: 94, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT 1", start: 0, end: 8, startLine: 0 },
        { sql: "SELECT 2", start: 13, end: 21, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  NULL", start: 0, end: 12, startLine: 0 },
        { sql: "END", start: 14, end: 17, startLine: 2 },
        { sql: "/\nSELECT 1 FROM dual", start: 19, end: 39, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
  ],
  "pair-dollar-plain-quote": [
    {
      statements: [
        { sql: "BEGIN", start: 0, end: 5, startLine: 0 },
        { sql: "SELECT 1", start: 7, end: 15, startLine: 1 },
        { sql: "COMMIT", start: 17, end: 23, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN TRANSACTION", start: 0, end: 17, startLine: 0 },
        { sql: "SELECT 1", start: 19, end: 27, startLine: 1 },
        { sql: "COMMIT", start: 29, end: 35, startLine: 2 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN RETURN 1", start: 0, end: 14, startLine: 0 },
        { sql: "END", start: 16, end: 19, startLine: 0 },
        { sql: "SELECT 2", start: 21, end: 29, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "DECLARE x INT", start: 0, end: 13, startLine: 0 },
        { sql: "BEGIN x := 1", start: 15, end: 27, startLine: 0 },
        { sql: "RETURN x", start: 29, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n FOR i IN 1 TO 3 DO\n SELECT 1", start: 0, end: 35, startLine: 0 },
        { sql: "END FOR", start: 38, end: 45, startLine: 3 },
        { sql: "RETURN 1", start: 48, end: 56, startLine: 4 },
        { sql: "END", start: 58, end: 61, startLine: 5 },
        { sql: "SELECT 2", start: 63, end: 71, startLine: 6 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END; $$",
          start: 0,
          end: 86,
          startLine: 0,
        },
        { sql: "SELECT 2", start: 88, end: 96, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f() RETURNS INT AS 'SELECT 1'", start: 0, end: 45, startLine: 0 },
        { sql: "SELECT 2", start: 47, end: 55, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        {
          sql: "CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE SQL AS BEGIN RETURN 1",
          start: 0,
          end: 74,
          startLine: 0,
        },
        { sql: "END", start: 76, end: 79, startLine: 0 },
        { sql: "SELECT 2", start: 81, end: 89, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "EXECUTE IMMEDIATE $$BEGIN RETURN 1; END;$$", start: 0, end: 42, startLine: 0 },
        { sql: "SELECT 2", start: 44, end: 52, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $t$x", start: 0, end: 11, startLine: 0 },
        { sql: "y$t$", start: 12, end: 16, startLine: 0 },
        { sql: "SELECT 2", start: 18, end: 26, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT $$x;y$$", start: 0, end: 14, startLine: 0 },
        { sql: "SELECT 2", start: 16, end: 24, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: 'SELECT 1 AS "a\\"', start: 0, end: 16, startLine: 0 },
        { sql: 'SELECT 2 AS "b"', start: 18, end: 33, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "DECLARE\n  x NUMBER", start: 0, end: 18, startLine: 0 },
        { sql: "BEGIN\n  x := 1", start: 20, end: 34, startLine: 2 },
        { sql: "END", start: 36, end: 39, startLine: 4 },
        { sql: "SELECT 1 FROM dual", start: 41, end: 59, startLine: 5 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PROCEDURE p AS LANGUAGE JAVA NAME 'a.b()'", start: 0, end: 59, startLine: 0 },
        { sql: "SELECT 1 FROM dual", start: 61, end: 79, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE OR REPLACE PACKAGE pkg AS\n  PROCEDURE p", start: 0, end: 46, startLine: 0 },
        { sql: "FUNCTION f RETURN NUMBER", start: 50, end: 74, startLine: 2 },
        { sql: "END pkg", start: 76, end: 83, startLine: 3 },
        { sql: "SELECT 1 FROM dual", start: 85, end: 103, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  x := (CASE WHEN a THEN 1 END)", start: 0, end: 37, startLine: 0 },
        { sql: "END", start: 39, end: 42, startLine: 2 },
        { sql: "SELECT 1 FROM dual", start: 44, end: 62, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE FUNCTION f(p_end NUMBER) RETURN NUMBER IS BEGIN RETURN 1", start: 0, end: 63, startLine: 0 },
        { sql: "END", start: 65, end: 68, startLine: 0 },
        { sql: "SELECT 2", start: 70, end: 78, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1", start: 0, end: 62, startLine: 0 },
        { sql: "DELETE FROM u", start: 66, end: 79, startLine: 2 },
        { sql: "END", start: 81, end: 84, startLine: 3 },
        { sql: "SELECT 1", start: 86, end: 94, startLine: 4 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "SELECT 1", start: 0, end: 8, startLine: 0 },
        { sql: "GO\nSELECT 2", start: 10, end: 21, startLine: 1 },
      ],
      multi: true,
      unterminated: false,
    },
    {
      statements: [
        { sql: "BEGIN\n  NULL", start: 0, end: 12, startLine: 0 },
        { sql: "END", start: 14, end: 17, startLine: 2 },
        { sql: "/\nSELECT 1 FROM dual", start: 19, end: 39, startLine: 3 },
      ],
      multi: true,
      unterminated: false,
    },
  ],
};

const NO_DIALECT = "(no dialect)";
const SQL_TYPES = [...EXTERNAL_DATABASE_TYPES, "libredb" as DatabaseType].filter((type) => readsSqlText(type));

function read(text: string, type: DatabaseType | undefined): Reading {
  const grammar = resolveSqlGrammar(type);
  return {
    statements: splitStatements(text, grammar).map(({ sql, start, end, startLine }) => ({
      sql,
      start,
      end,
      startLine,
    })),
    multi: isMultiStatement(text, grammar),
    unterminated: hasUnterminatedSpan(text, grammar),
  };
}

describe("script golden readings", () => {
  test("every row that reads SQL text has a class, and every class a table for every text", () => {
    expect(Object.keys(ROW_CLASS).sort()).toEqual([NO_DIALECT, ...SQL_TYPES].sort());
    for (const name of new Set(Object.values(ROW_CLASS))) expect(EXPECTED[name]).toHaveLength(CORPUS.length);
  });

  describe.each(Object.entries(ROW_CLASS))("%s (%s)", (row, name) => {
    const type = row === NO_DIALECT ? undefined : (row as DatabaseType);
    test.each(CORPUS.map((text, index) => [index, text] as const))("text %d: %j", (index, text) => {
      expect(read(text, type)).toEqual(EXPECTED[name][index]);
    });
  });
});
