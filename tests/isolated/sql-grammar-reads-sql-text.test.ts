/**
 * `readsSqlText` is a fact each engine's grammar module states, and the provider states the same
 * fact a second way as `queryLanguage`. This holds the two to each other for every shipped type
 * id, built unconnected through the real factory, so neither can drift alone.
 *
 * One exception is recorded: `libredb` declares `queryLanguage: "json"` and reads SQL text all the
 * same. The exception list is asserted to be exactly that one id, so a second engine that splits
 * the two facts has to be written down here.
 *
 * MEASURED when this landed: 20 providers declare `queryLanguage: "sql"` (13 explicitly; postgres,
 * mysql, mssql, oracle, sqlite, duckdb and libsql through `base-provider.ts`), which with libredb
 * are the 21 `true` facts. It runs under `tests/isolated/` because it builds every provider through
 * `createDatabaseProvider`, which the api layer's tests mock (the reason
 * `tests/isolated/object-source-declarations.test.ts` gives).
 */
import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

const EXCEPTIONS: readonly DatabaseType[] = ["libredb"];

async function queryLanguages(): Promise<Map<DatabaseType, string>> {
  const realLog = console.log;
  // The factory logs one line per provider it builds.
  console.log = () => undefined;
  try {
    const providers = await Promise.all(
      SHIPPED_DATABASE_TYPES.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])),
    );
    return new Map(
      SHIPPED_DATABASE_TYPES.map((type, index) => [type, providers[index].getCapabilities().queryLanguage]),
    );
  } finally {
    console.log = realLog;
  }
}

describe("readsSqlText against each provider's queryLanguage", () => {
  test("every shipped type id has a grammar row", () => {
    expect(Object.keys(SQL_GRAMMAR).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test("readsSqlText is queryLanguage === sql for every id but the recorded exception", async () => {
    const languages = await queryLanguages();
    const split: DatabaseType[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      if (SQL_GRAMMAR[type].readsSqlText !== (languages.get(type) === "sql")) split.push(type);
    }
    expect(split).toEqual([...EXCEPTIONS]);
    expect(languages.get("libredb")).toBe("json");
    expect(SQL_GRAMMAR.libredb.readsSqlText).toBe(true);
  });

  test("the measured counts: 20 providers read sql, 21 grammar rows read SQL text", async () => {
    const languages = await queryLanguages();
    expect([...languages.values()].filter((language) => language === "sql").length).toBe(20);
    expect(Object.values(SQL_GRAMMAR).filter((spec) => spec.readsSqlText).length).toBe(21);
  });
});
