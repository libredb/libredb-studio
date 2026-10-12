/**
 * The Firestore labels, shipped to the browser before connect, and the plan-mode statement-language sentence.
 */
import { describe, expect, test } from "bun:test";
import { FIRESTORE_LABELS, FIRESTORE_STATEMENT_LANGUAGE } from "@/lib/db/providers/document/firestore/labels";

describe("FIRESTORE_LABELS", () => {
  test("collections and documents in this engine's own words", () => {
    expect(FIRESTORE_LABELS.entityName).toBe("Collection");
    expect(FIRESTORE_LABELS.entityNamePlural).toBe("Collections");
    expect(FIRESTORE_LABELS.rowName).toBe("Document");
    expect(FIRESTORE_LABELS.rowNamePlural).toBe("Documents");
    expect(FIRESTORE_LABELS.selectAction).toBe("Preview Documents");
    expect(FIRESTORE_LABELS.searchPlaceholder).toBe("Search collections...");
    expect(FIRESTORE_LABELS.vacuumActionOperation).toBeUndefined();
    expect(FIRESTORE_LABELS.reindexGlobalLabel).toBeUndefined();
    expect(Object.isFrozen(FIRESTORE_LABELS)).toBe(true);
  });

  test("the statement language names the chain, its read-only reach and one example", () => {
    expect(FIRESTORE_LABELS.statementLanguage).toBe(FIRESTORE_STATEMENT_LANGUAGE);
    expect(FIRESTORE_STATEMENT_LANGUAGE).toBe(
      'one Firestore Admin SDK read chain starting at db, written inline and never run as JavaScript, for example db.collection("users").where("age", ">=", 18).orderBy("age").limit(100); the chain may end in .get(), .count(), .aggregate({ total: AggregateField.sum("amount") }), .findNearest({ ... }) or .explain(), and db.doc("users/alice").get(), db.listCollections(), db.collection("users").listDocuments() and db.getAll(db.doc("users/alice"), ...) are also accepted; writes are refused',
    );
  });

  test("no sentence carries an em dash or an en dash", () => {
    for (const value of Object.values(FIRESTORE_LABELS)) {
      if (typeof value === "string") expect(value).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
