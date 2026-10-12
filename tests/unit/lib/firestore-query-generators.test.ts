import { describe, expect, test } from "bun:test";
import { countStatement, previewStatement } from "@/lib/db/providers/document/firestore/console/generators";
import { offersCountQuery, type ProviderCapabilities } from "@/lib/db/types";
import { generateCountQuery, generateSelectQuery, generateTableQuery } from "@/lib/query-generators";

const FIRESTORE: ProviderCapabilities = {
  queryLanguage: "json",
  queryDialect: "firestore",
  supportsExplain: true,
  explainFormat: "firestore-explain",
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  schemaRefreshPattern: "(?!)",
  defaultPort: null,
  containerLevels: [],
};

describe("the firestore record of DIALECT_GENERATORS (Firestore spec 3.2, 5.4)", () => {
  test("a tree click and Generate Query write the 100-document preview of the clicked collection", () => {
    expect(generateTableQuery(["users"], FIRESTORE)).toBe('db.collection("users").limit(100)');
    expect(generateSelectQuery(["users"], [], FIRESTORE)).toBe('db.collection("users").limit(100)');
    expect(generateTableQuery(['Order"Items'], FIRESTORE)).toBe(previewStatement(['Order"Items']));
  });

  test("Generate Count Query writes the count() statement, never MongoDB's count document", () => {
    expect(offersCountQuery(FIRESTORE)).toBe(true);
    expect(generateCountQuery(["users"], FIRESTORE)).toBe('db.collection("users").count()');
    expect(generateCountQuery(['Order"Items'], FIRESTORE)).toBe(countStatement(['Order"Items']));
  });

  test("only the object's own segment is addressed, the collection id the tree lists", () => {
    expect(generateTableQuery(["c0", "users"], FIRESTORE)).toBe('db.collection("users").limit(100)');
    expect(generateCountQuery(["c0", "users"], FIRESTORE)).toBe('db.collection("users").count()');
  });

  test("a dialect whose record offers a count and writes none is refused by name", () => {
    expect(() =>
      generateCountQuery(["users"], FIRESTORE, { firestore: { table: () => "", select: () => "" } }),
    ).toThrow("the firestore dialect offers Generate Count Query and writes no count statement");
  });
});
