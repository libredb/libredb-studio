/**
 * RUNSTATS and REORG statements for Db2 (#786).
 *
 * M2: every `CALL` through db2-node 1.0.22 fails with SQLSTATE 07005 SQLCODE -517 (K9), and the
 * same `CALL` inside a compound block runs, measured on 12.1.0.0 against `APP."Mixed Case"`. So
 * the statement is `BEGIN CALL SYSPROC.ADMIN_CMD('...'); END`, and the command inside it is a
 * string literal, which is why a quote in a table name is doubled twice: once as an identifier
 * and once as a literal.
 */

import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  MAINTAINED_TABLE_TYPES,
  adminCommandTarget,
  maintenanceStatement,
} from "@/lib/db/providers/sql/db2/maintenance";

describe("adminCommandTarget", () => {
  test("schema and table are each a delimited identifier", () => {
    expect(adminCommandTarget("APP", "Mixed Case")).toBe('"APP"."Mixed Case"');
  });

  test("a single quote is doubled, because the target sits inside a string literal", () => {
    expect(adminCommandTarget("APP", "O'Brien")).toBe(`"APP"."O''Brien"`);
  });

  test("a double quote is doubled, because the target is a delimited identifier", () => {
    expect(adminCommandTarget('A"B', 'x"y')).toBe('"A""B"."x""y"');
  });
});

describe("maintenanceStatement (M2)", () => {
  test("analyze is RUNSTATS inside a compound block", () => {
    const statement = maintenanceStatement("analyze", "ORDERS", "APP");

    expect(statement.sql).toBe(
      `BEGIN CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE "APP"."ORDERS" WITH DISTRIBUTION AND DETAILED INDEXES ALL'); END`,
    );
    expect(statement.sql.startsWith("BEGIN CALL ")).toBe(true);
    expect(statement.sql.endsWith("; END")).toBe(true);
    expect(statement.message).toBe("RUNSTATS completed on APP.ORDERS");
  });

  test("optimize is REORG inside a compound block", () => {
    const statement = maintenanceStatement("optimize", "O'Brien", "APP");

    expect(statement.sql).toBe(`BEGIN CALL SYSPROC.ADMIN_CMD('REORG TABLE "APP"."O''Brien"'); END`);
    expect(statement.message).toBe("REORG completed on APP.O'Brien");
  });

  test.each([
    ["analyze", "A table name is required for RUNSTATS"],
    ["optimize", "A table name is required for REORG"],
  ] as const)("%s without a target is refused", (type, message) => {
    expect(() => maintenanceStatement(type, undefined, "APP")).toThrow(new DatabaseConfigError(message, "db2"));
    expect(() => maintenanceStatement(type, "", "APP")).toThrow(message);
  });

  test.each([
    ["analyze", "A schema is required for RUNSTATS on Db2"],
    ["optimize", "A schema is required for REORG on Db2"],
  ] as const)("%s without a schema is refused (M4: no session schema stands in)", (type, message) => {
    expect(() => maintenanceStatement(type, "ORDERS", undefined)).toThrow(message);
    expect(() => maintenanceStatement(type, "ORDERS", "")).toThrow(DatabaseConfigError);
  });

  test("any other operation is refused by name", () => {
    expect(() => maintenanceStatement("vacuum", "ORDERS", "APP")).toThrow(
      "Unsupported maintenance operation for Db2: vacuum",
    );
  });

  test("tables and materialized query tables are the catalog types maintenance runs on", () => {
    expect(MAINTAINED_TABLE_TYPES).toEqual({ T: "table", S: "materialized query table" });
  });
});
