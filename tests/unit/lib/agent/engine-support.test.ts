import { describe, expect, test } from "bun:test";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { MySQLProvider } from "@/lib/db/providers/sql/mysql";
import { ClickHouseProvider } from "@/lib/db/providers/sql/clickhouse";
import type { DatabaseType } from "@/lib/types";

/**
 * The constant is a CLAIM about the providers, not a second source of truth. The factory's
 * real gate is `typeof provider.queryReadOnly === "function"`
 * (`src/lib/db/factory.ts`, PROFILE_UNSUPPORTED_BY_PROVIDER), so these tests measure the
 * prototypes and fail the moment the list and the drivers disagree in either direction.
 *
 * The negative cases are the two SQL providers that pull no native driver in at module scope.
 * Oracle and SQL Server are deliberately absent because they import `oracledb` / `mssql`
 * there, and MongoDB because `bson` calls `node:v8 isBuildingSnapshot` at import time, which
 * Bun does not implement. This test file is the only place a provider module is imported for
 * this constant at all - the constant itself imports nothing but the type union, so it stays
 * client-safe for the unauthenticated login page.
 */
describe("AGENT_EXECUTION_ENGINES", () => {
  test("names exactly the engines whose provider implements queryReadOnly", () => {
    expect([...AGENT_EXECUTION_ENGINES]).toEqual(["postgres", "sqlite"]);
  });

  test("every named engine's provider implements queryReadOnly", () => {
    const prototypes: Record<string, object> = {
      postgres: PostgresProvider.prototype,
      sqlite: SQLiteProvider.prototype,
    };
    for (const type of AGENT_EXECUTION_ENGINES) {
      const prototype = prototypes[type] as { queryReadOnly?: unknown };
      expect(typeof prototype.queryReadOnly).toBe("function");
    }
  });

  test("engines outside the list have no database-native read-only path", () => {
    const excluded: [DatabaseType, object][] = [
      ["mysql", MySQLProvider.prototype],
      ["clickhouse", ClickHouseProvider.prototype],
    ];
    for (const [type, prototype] of excluded) {
      expect(AGENT_EXECUTION_ENGINES).not.toContain(type);
      expect(typeof (prototype as { queryReadOnly?: unknown }).queryReadOnly).not.toBe("function");
    }
  });
});
