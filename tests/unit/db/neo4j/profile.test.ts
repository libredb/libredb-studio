/**
 * The Neo4j read policy's lists (spec 5.2; revisions SR7, SR9): every allowlisted procedure and SHOW form
 * passes `checkCypherRead`, every denied word and namespace is refused, the qualified functions are exactly
 * the ones 5.26.31 lists as built in, and the shared corpus gives its recorded verdict under this profile.
 */
import { describe, expect, test } from "bun:test";
import { checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import { CYPHER_CORPUS } from "../../../fixtures/graph/cypher-corpus";
import { neo4jCapture } from "../../../helpers/neo4j-fixtures";

const policy = NEO4J_POLICY_PROFILE.readPolicy;

const refusalOf = (text: string) => {
  const verdict = checkCypherRead(text, NEO4J_POLICY_PROFILE);
  if (verdict.allowed) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return verdict.refusal;
};

const allowedOf = (text: string) => {
  const verdict = checkCypherRead(text, NEO4J_POLICY_PROFILE);
  if (!verdict.allowed) throw new Error(`expected ${JSON.stringify(text)} to be allowed: ${verdict.refusal.message}`);
  return verdict;
};

describe("NEO4J_POLICY_PROFILE", () => {
  test("names the engine and its dialect", () => {
    expect(NEO4J_POLICY_PROFILE.engineLabel).toBe("Neo4j");
    expect(NEO4J_POLICY_PROFILE.dialect).toEqual({ supportsVersionPrefix: true, offsetKeyword: "SKIP" });
    expect(policy.refusedPrefixes).toEqual(["EXPLAIN", "PROFILE"]);
    expect(policy.deniedNamespaces).toEqual(["apoc.", "gds."]);
  });

  test("allows a CALL of every allowlisted procedure", () => {
    expect(policy.allowedProcedures).toEqual([
      "db.labels",
      "db.relationshipTypes",
      "db.propertyKeys",
      "db.schema.visualization",
      "db.schema.nodeTypeProperties",
      "db.schema.relTypeProperties",
      "db.ping",
      "dbms.components",
    ]);
    for (const procedure of policy.allowedProcedures) {
      const verdict = allowedOf(`CALL ${procedure}()`);
      expect(verdict.callsProcedure).toBe(true);
      expect(verdict.isShow).toBe(false);
    }
  });

  test("allows every SHOW form, a name in place of *", () => {
    expect(policy.allowedShowForms.map((form) => form.join(" "))).toEqual([
      "INDEXES",
      "INDEX",
      "ALL INDEXES",
      "RANGE INDEXES",
      "TEXT INDEXES",
      "POINT INDEXES",
      "LOOKUP INDEXES",
      "FULLTEXT INDEXES",
      "VECTOR INDEXES",
      "CONSTRAINTS",
      "CONSTRAINT",
      "ALL CONSTRAINTS",
      "UNIQUE CONSTRAINTS",
      "NODE UNIQUENESS CONSTRAINTS",
      "RELATIONSHIP UNIQUENESS CONSTRAINTS",
      "EXISTENCE CONSTRAINTS",
      "KEY CONSTRAINTS",
      "PROPERTY TYPE CONSTRAINTS",
      "DATABASES",
      "DATABASE *",
      "DEFAULT DATABASE",
      "HOME DATABASE",
      "PROCEDURES",
      "FUNCTIONS",
      "ALL FUNCTIONS",
      "BUILT IN FUNCTIONS",
      "USER DEFINED FUNCTIONS",
    ]);
    for (const form of policy.allowedShowForms) {
      const typed = form.map((word) => (word === "*" ? "neo4j" : word)).join(" ");
      expect(allowedOf(`SHOW ${typed}`).isShow).toBe(true);
      expect(allowedOf(`SHOW ${typed} YIELD name`).isShow).toBe(true);
    }
  });

  test("refuses SHOW TRANSACTIONS in every spelling (SR9)", () => {
    for (const text of ["SHOW TRANSACTIONS", "SHOW TRANSACTION", "SHOW TRANSACTIONS 'neo4j-transaction-1'"]) {
      expect(refusalOf(text).code).toBe("denied-show");
    }
  });

  test("refuses every denied word", () => {
    expect(policy.deniedWords.map((words) => words.join(" "))).toEqual([
      "CREATE",
      "MERGE",
      "SET",
      "DELETE",
      "DETACH",
      "REMOVE",
      "DROP",
      "FOREACH",
      "LOAD",
      "ALTER",
      "RENAME",
      "GRANT",
      "DENY",
      "REVOKE",
      "START",
      "STOP",
      "ENABLE",
      "TERMINATE",
      "USE",
      "INSERT",
      "IN TRANSACTIONS",
    ]);
    for (const words of policy.deniedWords) {
      const refusal = refusalOf(`MATCH (n) ${words.join(" ")} n`);
      expect(refusal.code).toBe("denied-word");
      expect(refusal.subject).toBe(words.join(" "));
    }
  });

  test("refuses GQL's INSERT, which Neo4j 5.18 and later accept in place of CREATE", () => {
    const refusal = refusalOf("INSERT (n:X) RETURN n");
    expect(refusal.code).toBe("denied-word");
    expect(refusal.subject).toBe("INSERT");
  });

  test("refuses the apoc and gds namespaces as procedures and as functions", () => {
    expect(refusalOf("CALL apoc.help('x')").subject).toBe("apoc.");
    expect(refusalOf("RETURN gds.version()").subject).toBe("gds.");
  });

  test("allows exactly the qualified built-in functions 5.26.31 lists (SR7)", () => {
    const capture = neo4jCapture("functions-built-in");
    expect(capture.statement).toBe(
      "SHOW FUNCTIONS YIELD name, isBuiltIn WHERE isBuiltIn AND name CONTAINS '.' RETURN name ORDER BY name",
    );
    const captured = (capture.result?.rows ?? []).map((row) => String(row.name));
    expect(captured.length).toBeGreaterThan(0);
    const expected = captured
      .map((name) => name.toLowerCase())
      .filter((name) => !name.startsWith("apoc.") && !name.startsWith("gds."));
    expect(policy.allowedQualifiedFunctions).toEqual(expected);
    for (const name of captured) expect(allowedOf(`RETURN ${name}()`).allowed).toBe(true);
    expect(refusalOf("RETURN custom.fetch('x')").code).toBe("denied-function");
  });

  describe("gives every corpus case its recorded verdict", () => {
    for (const corpusCase of CYPHER_CORPUS) {
      const expected = corpusCase.verdict;
      if (expected === undefined) continue;
      test(corpusCase.name, () => {
        const verdict = checkCypherRead(corpusCase.text, NEO4J_POLICY_PROFILE);
        if (expected === "allowed") {
          expect(verdict.allowed).toBe(true);
          return;
        }
        if (verdict.allowed) throw new Error(`${JSON.stringify(corpusCase.text)} was allowed`);
        expect(verdict.refusal.code).toBe(expected);
        if (corpusCase.subject !== undefined) expect(verdict.refusal.subject).toBe(corpusCase.subject);
      });
    }
  });
});
