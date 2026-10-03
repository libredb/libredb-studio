/**
 * The Neo4j provider's labels (spec 6.3): the exact sentences, and a statement-language sentence that names
 * every procedure the read policy allows, so the two cannot drift.
 */
import { describe, expect, test } from "bun:test";
import { neo4jLabels } from "@/lib/db/providers/graph/neo4j/labels";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";

const STATEMENT_LANGUAGE =
  "Read-only Cypher for Neo4j 5: one statement per run, no writes, no LOAD CSV, no APOC or GDS. CALL is limited to db.labels, db.relationshipTypes, db.propertyKeys, db.schema.visualization, db.schema.nodeTypeProperties, db.schema.relTypeProperties, db.ping and dbms.components. SHOW is limited to indexes, constraints, databases, procedures and functions. Only built-in functions can be called; parameters are not supported. Quote labels, relationship types and property names that are not plain words with backticks.";

describe("neo4jLabels", () => {
  const labels = neo4jLabels();

  // The inventory is labels, relationship types, indexes and constraints, and plan mode counts them all
  // under this noun ("14 graph objects read"), so it names the four kinds, never only the first.
  test("names graph objects and nodes", () => {
    expect(labels.entityName).toBe("graph object");
    expect(labels.entityNamePlural).toBe("graph objects");
    expect(labels.rowName).toBe("node");
    expect(labels.rowNamePlural).toBe("nodes");
  });

  test("states the statement language exactly", () => {
    expect(labels.statementLanguage).toBe(STATEMENT_LANGUAGE);
  });

  test("names every allowlisted procedure in the statement language", () => {
    const sentence = labels.statementLanguage ?? "";
    const called = sentence.slice(sentence.indexOf("CALL is limited to "), sentence.indexOf(". SHOW"));
    const named = called
      .replace("CALL is limited to ", "")
      .split(/, | and /)
      .map((name) => name.trim());
    expect(named).toEqual([...NEO4J_POLICY_PROFILE.readPolicy.allowedProcedures]);
  });

  test("words the empty monitoring panels and the table statistics in Neo4j's terms", () => {
    expect(labels.slowQueriesEmptyState).toBe(
      "Neo4j Community keeps no query log, and this version does not read the Enterprise query log.",
    );
    expect(labels.sessionsEmptyState).toBe("No transaction is running.");
    expect(labels.tableStatsCaption).toBe("Node counts per label, from the count store.");
  });

  test("fills every required field with text", () => {
    for (const field of [
      "selectAction",
      "generateAction",
      "analyzeAction",
      "vacuumAction",
      "searchPlaceholder",
      "analyzeGlobalLabel",
      "analyzeGlobalTitle",
      "analyzeGlobalDesc",
      "vacuumGlobalLabel",
      "vacuumGlobalTitle",
      "vacuumGlobalDesc",
    ] as const) {
      expect(labels[field].length).toBeGreaterThan(0);
    }
  });

  test("answers a fresh object each call", () => {
    expect(neo4jLabels()).not.toBe(labels);
    expect(neo4jLabels()).toEqual(labels);
  });
});
