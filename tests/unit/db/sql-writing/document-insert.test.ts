import { describe, expect, test } from "bun:test";
import { createDatabaseProvider } from "@/lib/db/factory";
import { SQL_WRITING, sqlWritingFor } from "@/lib/db/sql-writing";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

/**
 * The document insert of the SQL writing contract: the request an engine whose console text is a JSON request takes
 * to insert generated documents, which the test data generator writes in place of an INSERT. It is declared on the
 * engine's own row, so the generator names no engine's request grammar.
 */
describe("insertDocuments", () => {
  test("is declared by MongoDB's row alone", () => {
    const declaring = Object.entries(SQL_WRITING)
      .filter(([, spec]) => spec.insertDocuments !== undefined)
      .map(([id]) => id);
    expect(declaring).toEqual(["mongodb"]);
  });

  test("MongoDB's writes one insertMany request at the address, the documents in order", () => {
    const write = sqlWritingFor("mongodb").insertDocuments;
    expect(write).toBeDefined();
    const text = write?.({ database: "shop", collection: "users" }, [{ name: "a" }, { name: "b" }]) ?? "";
    expect(JSON.parse(text)).toEqual({
      database: "shop",
      collection: "users",
      operation: "insertMany",
      documents: [{ name: "a" }, { name: "b" }],
    });
    // Indented by two, as the generator has always shown it.
    expect(text).toContain('\n  "collection": "users"');
  });

  test("is declared by neither named spec", () => {
    expect(sqlWritingFor(undefined).insertDocuments).toBeUndefined();
    expect(sqlWritingFor("not-an-engine").insertDocuments).toBeUndefined();
  });

  test("is declared by every engine whose console text is JSON and that offers test data generation", async () => {
    // The generator refuses such an engine without the row, so no engine may offer the action and leave it out.
    const missing: DatabaseType[] = [];
    for (const type of Object.keys(CENSUS_CONNECTION) as DatabaseType[]) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      if (capabilities.queryLanguage !== "json" || capabilities.supportsTestDataGeneration !== true) continue;
      if (sqlWritingFor(type).insertDocuments === undefined) missing.push(type);
    }
    expect(missing).toEqual([]);
  });
});
