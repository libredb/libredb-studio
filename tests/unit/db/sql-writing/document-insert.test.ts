import { describe, expect, test } from "bun:test";
import { SQL_WRITING, sqlWritingFor } from "@/lib/db/sql-writing";

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
});
