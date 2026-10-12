/**
 * The Firestore provider's labels. Pure, and shipped to the browser: `getLabels()` answers before connect.
 * `statementLanguage` tells a model what a Firestore statement is written in, with one example; maintenance is off, so
 * `vacuumActionOperation` and the `reindexGlobal*` members are not declared.
 */
import type { ProviderLabels } from "@/lib/db/types";

export const FIRESTORE_STATEMENT_LANGUAGE =
  'one Firestore Admin SDK read chain starting at db, written inline and never run as JavaScript, for example db.collection("users").where("age", ">=", 18).orderBy("age").limit(100); the chain may end in .get(), .count(), .aggregate({ total: AggregateField.sum("amount") }), .findNearest({ ... }) or .explain(), and db.doc("users/alice").get(), db.listCollections(), db.collection("users").listDocuments() and db.getAll(db.doc("users/alice"), ...) are also accepted; writes are refused';

export const FIRESTORE_LABELS: ProviderLabels = Object.freeze({
  entityName: "Collection",
  entityNamePlural: "Collections",
  rowName: "Document",
  rowNamePlural: "Documents",
  selectAction: "Preview Documents",
  generateAction: "Generate Query",
  // Never rendered (maintenance is off); worded true anyway.
  analyzeAction: "Statistics",
  vacuumAction: "Maintenance",
  searchPlaceholder: "Search collections...",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "Firestore keeps its own index statistics; Studio has none to update.",
  vacuumGlobalLabel: "Maintenance",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Studio sends Firestore no maintenance: this version only reads.",
  statementLanguage: FIRESTORE_STATEMENT_LANGUAGE,
  slowQueriesEmptyState: "Studio reads no Firestore query statistics",
  sessionsEmptyState: "Firestore does not list client sessions",
});
