/**
 * RUNSTATS and REORG statements for Db2 (#786).
 *
 * The statement is a plain `CALL SYSPROC.ADMIN_CMD('...')`: db2-node 1.0.24 runs a `CALL`
 * through EXCSQLSTT, measured on 12.1.0.0 and 11.5.9.0 against `APP."O'Brien"` and
 * `APP."Mixed Case"`, where 1.0.22 failed every bare `CALL` (K9) and the provider wrapped it in a
 * compound block. The command inside it is a string literal, which is why a quote in a table name
 * is doubled twice: once as an identifier and once as a literal.
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

describe("maintenanceStatement", () => {
  test("analyze is a plain CALL of RUNSTATS", () => {
    const statement = maintenanceStatement("analyze", "ORDERS", "APP");

    expect(statement.sql).toBe(
      `CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE "APP"."ORDERS" WITH DISTRIBUTION AND DETAILED INDEXES ALL')`,
    );
    expect(statement.message).toBe("RUNSTATS completed on APP.ORDERS");
  });

  test("optimize is a plain CALL of REORG", () => {
    const statement = maintenanceStatement("optimize", "O'Brien", "APP");

    expect(statement.sql).toBe(`CALL SYSPROC.ADMIN_CMD('REORG TABLE "APP"."O''Brien"')`);
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
