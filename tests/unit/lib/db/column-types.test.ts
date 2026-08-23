/**
 * The declared-type maps for the four drivers that hand back a wire code instead of
 * a type name. Every expectation here was measured against a live engine - the
 * probe tables and the verbatim driver metadata are in the module's own comments.
 */

import { describe, test, expect } from "bun:test";
import {
  declaredColumnTypes,
  mssqlColumnTypes,
  mysqlColumnType,
  mysqlColumnTypes,
  oracleColumnTypes,
  postgresColumnType,
  postgresColumnTypes,
} from "@/lib/db/providers/sql/column-types";

describe("declaredColumnTypes", () => {
  test("omits the key entirely when no column declared a type", () => {
    expect(declaredColumnTypes([["a", undefined]])).toEqual({});
  });

  test("keeps only the columns that declared one", () => {
    expect(
      declaredColumnTypes([
        ["a", "bigint"],
        ["b", undefined],
      ]),
    ).toEqual({ columnTypes: { a: "bigint" } });
  });

  test("an empty column list declares nothing", () => {
    expect(declaredColumnTypes([])).toEqual({});
  });

  test("the last declaration wins for a duplicated column name", () => {
    // `SELECT 1 AS c, 'x' AS c` really declares two columns called `c`, and the row
    // object the driver builds keeps the LAST one's value - so the last one's type is
    // the one that describes what the grid shows.
    expect(
      declaredColumnTypes([
        ["c", "integer"],
        ["c", "text"],
      ]),
    ).toEqual({ columnTypes: { c: "text" } });
  });

  test("a column named __proto__ becomes an own property, not the prototype", () => {
    const built = declaredColumnTypes([["__proto__", "text"]]);
    expect(Object.hasOwn(built.columnTypes!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(built.columnTypes!)).toBe(Object.prototype);
  });
});

describe("postgresColumnType", () => {
  test("names the built-in OIDs the way PostgreSQL names them", () => {
    // Measured on PostgreSQL 18.4 over `r5_types`: pg reports these OIDs, and
    // `format_type(oid, NULL)` spells them like this.
    expect(postgresColumnType(20)).toBe("bigint");
    expect(postgresColumnType(1700)).toBe("numeric");
    expect(postgresColumnType(701)).toBe("double precision");
    expect(postgresColumnType(16)).toBe("boolean");
    expect(postgresColumnType(1043)).toBe("character varying");
    expect(postgresColumnType(25)).toBe("text");
    expect(postgresColumnType(1114)).toBe("timestamp without time zone");
    expect(postgresColumnType(1184)).toBe("timestamp with time zone");
    expect(postgresColumnType(1082)).toBe("date");
    expect(postgresColumnType(3802)).toBe("jsonb");
    expect(postgresColumnType(2950)).toBe("uuid");
    expect(postgresColumnType(17)).toBe("bytea");
    expect(postgresColumnType(23)).toBe("integer");
  });

  test("names a built-in array type", () => {
    expect(postgresColumnType(1009)).toBe("text[]");
  });

  test("is absent for an OID it cannot name rather than guessing", () => {
    // dvdrental's `film.rating` is the enum `mpaa_rating`, OID 16504 in that database.
    // A user-defined OID is per-database, so no static table can name it.
    expect(postgresColumnType(16504)).toBeUndefined();
  });
});

describe("mysqlColumnType", () => {
  test("names the numeric and temporal codes", () => {
    expect(mysqlColumnType({ columnType: 8 })).toBe("bigint");
    expect(mysqlColumnType({ columnType: 246, decimals: 2 })).toBe("decimal");
    expect(mysqlColumnType({ columnType: 5 })).toBe("double");
    expect(mysqlColumnType({ columnType: 4 })).toBe("float");
    expect(mysqlColumnType({ columnType: 1, columnLength: 1 })).toBe("tinyint");
    expect(mysqlColumnType({ columnType: 2 })).toBe("smallint");
    expect(mysqlColumnType({ columnType: 9 })).toBe("mediumint");
    expect(mysqlColumnType({ columnType: 3 })).toBe("int");
    expect(mysqlColumnType({ columnType: 0 })).toBe("decimal");
    expect(mysqlColumnType({ columnType: 16, flags: 32 })).toBe("bit");
    expect(mysqlColumnType({ columnType: 7 })).toBe("timestamp");
    expect(mysqlColumnType({ columnType: 12 })).toBe("datetime");
    expect(mysqlColumnType({ columnType: 10 })).toBe("date");
    expect(mysqlColumnType({ columnType: 11 })).toBe("time");
    expect(mysqlColumnType({ columnType: 13, flags: 96 })).toBe("year");
    expect(mysqlColumnType({ columnType: 14 })).toBe("date");
    expect(mysqlColumnType({ columnType: 245 })).toBe("json");
    expect(mysqlColumnType({ columnType: 255 })).toBe("geometry");
    expect(mysqlColumnType({ columnType: 242 })).toBe("vector");
    expect(mysqlColumnType({ columnType: 6 })).toBe("null");
  });

  test("the binary charset is what separates a string from a byte string", () => {
    expect(mysqlColumnType({ columnType: 253, characterSet: 224 })).toBe("varchar");
    expect(mysqlColumnType({ columnType: 253, characterSet: 63, flags: 128 })).toBe("varbinary");
    expect(mysqlColumnType({ columnType: 254, characterSet: 224 })).toBe("char");
    expect(mysqlColumnType({ columnType: 254, characterSet: 63, flags: 128 })).toBe("binary");
  });

  test("the ENUM and SET flags outrank the string code that carries them", () => {
    expect(mysqlColumnType({ columnType: 254, characterSet: 224, flags: 256 })).toBe("enum");
    expect(mysqlColumnType({ columnType: 254, characterSet: 224, flags: 2048 })).toBe("set");
  });

  test("the blob tier comes from the column length, which is the only thing that carries it", () => {
    // Measured on MySQL 26.7.0: TINYTEXT..LONGTEXT and TINYBLOB..LONGBLOB all arrive
    // as code 252. utf8mb4 multiplies the byte ceiling by 4.
    expect(mysqlColumnType({ columnType: 252, characterSet: 224, columnLength: 1020, flags: 16 })).toBe("tinytext");
    expect(mysqlColumnType({ columnType: 252, characterSet: 224, columnLength: 262140, flags: 16 })).toBe("text");
    expect(mysqlColumnType({ columnType: 252, characterSet: 224, columnLength: 67108860, flags: 16 })).toBe(
      "mediumtext",
    );
    expect(mysqlColumnType({ columnType: 252, characterSet: 224, columnLength: 4294967295, flags: 16 })).toBe(
      "longtext",
    );
    expect(mysqlColumnType({ columnType: 252, characterSet: 63, columnLength: 255, flags: 144 })).toBe("tinyblob");
    expect(mysqlColumnType({ columnType: 252, characterSet: 63, columnLength: 65535, flags: 144 })).toBe("blob");
    expect(mysqlColumnType({ columnType: 252, characterSet: 63, columnLength: 16777215, flags: 144 })).toBe(
      "mediumblob",
    );
    expect(mysqlColumnType({ columnType: 252, characterSet: 63, columnLength: 4294967295, flags: 144 })).toBe(
      "longblob",
    );
  });

  test("a blob code with no length at all still names the family", () => {
    expect(mysqlColumnType({ columnType: 252, characterSet: 63 })).toBe("blob");
  });

  test("the legacy per-tier blob codes are honoured when a server sends them", () => {
    expect(mysqlColumnType({ columnType: 249, characterSet: 63 })).toBe("tinyblob");
    expect(mysqlColumnType({ columnType: 250, characterSet: 224 })).toBe("mediumtext");
    expect(mysqlColumnType({ columnType: 251, characterSet: 63 })).toBe("longblob");
  });

  test("MariaDB's extended type name wins, because it is the only spelling of it", () => {
    expect(mysqlColumnType({ columnType: 254, characterSet: 63, extendedTypeName: "uuid" })).toBe("uuid");
  });

  test("falls back to `type` when the packet carries no `columnType`", () => {
    expect(mysqlColumnType({ type: 8 })).toBe("bigint");
  });

  test("is absent for a code it cannot name", () => {
    expect(mysqlColumnType({ columnType: 200 })).toBeUndefined();
    expect(mysqlColumnType({})).toBeUndefined();
  });

  test("the string-array flags form declares nothing rather than misreading a number", () => {
    // mysql2's typings allow `flags: string[]`; measured, the driver hands a number.
    expect(mysqlColumnType({ columnType: 254, characterSet: 224, flags: [] })).toBe("char");
  });
});

describe("the per-driver result wrappers", () => {
  test("postgres: names what it can and skips the field that carries no OID", () => {
    expect(postgresColumnTypes([{ name: "a", dataTypeID: 20 }, { name: "b" }])).toEqual({
      columnTypes: { a: "bigint" },
    });
  });

  test("postgres: a result with no fields at all declares nothing", () => {
    expect(postgresColumnTypes(undefined)).toEqual({});
  });

  test("mysql: reads the packets", () => {
    expect(mysqlColumnTypes([{ name: "id", columnType: 8 }])).toEqual({ columnTypes: { id: "bigint" } });
    expect(mysqlColumnTypes(undefined)).toEqual({});
  });

  test("oracle: dbTypeName is Oracle's own spelling, taken as it comes", () => {
    expect(oracleColumnTypes([{ name: "ID", dbTypeName: "NUMBER" }, { name: "X" }])).toEqual({
      columnTypes: { ID: "NUMBER" },
    });
    expect(oracleColumnTypes(undefined)).toEqual({});
  });

  test("mssql: the declaration is read off a type object and off a type factory alike", () => {
    const factory = Object.assign(() => ({}), { declaration: "nvarchar" });
    expect(mssqlColumnTypes({ id: { type: { declaration: "bigint" } }, name: { type: factory }, x: {} })).toEqual({
      columnTypes: { id: "bigint", name: "nvarchar" },
    });
    expect(mssqlColumnTypes(undefined)).toEqual({});
  });
});
