/**
 * The Cypher generators (spec 6.5, E11, SR5): the exact statements a tree click writes, the limit
 * bound, the segment arm, and a round trip of every output through the lexer and the read policy.
 */
import { describe, expect, test } from "bun:test";
import {
  GRAPH_SAMPLE_LIMIT,
  cypherForSegment,
  cypherSelectLabel,
  cypherSelectRelationship,
} from "@/lib/db/graph/cypher/generators";
import { checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import { graphObjectSegment } from "@/lib/db/graph/objects";
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";

const TEST_PROFILE: GraphPolicyProfile = {
  engineLabel: "Neo4j",
  readPolicy: {
    deniedWords: [
      ["CREATE"],
      ["MERGE"],
      ["SET"],
      ["DELETE"],
      ["DETACH"],
      ["REMOVE"],
      ["DROP"],
      ["LOAD"],
      ["FOREACH"],
      ["USE"],
      ["IN", "TRANSACTIONS"],
    ],
    deniedNamespaces: ["apoc.", "gds."],
    allowedProcedures: ["db.labels", "db.relationshipTypes"],
    allowedQualifiedFunctions: [],
    allowedShowForms: [["INDEXES"], ["CONSTRAINTS"]],
    refusedPrefixes: ["EXPLAIN", "PROFILE"],
  },
  dialect: { supportsVersionPrefix: true, offsetKeyword: "SKIP" },
};

const NAMES = ["Person", "Weird Label", "Back`tick", "Kişi"];

describe("cypherSelectLabel and cypherSelectRelationship", () => {
  test("write the sample reads with the default limit", () => {
    expect(GRAPH_SAMPLE_LIMIT).toBe(100);
    expect(cypherSelectLabel("Person")).toBe("MATCH (n:`Person`) RETURN n LIMIT 100");
    expect(cypherSelectRelationship("KNOWS")).toBe("MATCH (a)-[r:`KNOWS`]->(b) RETURN a, r, b LIMIT 100");
  });

  test("quote awkward names and honour an explicit limit", () => {
    expect(cypherSelectLabel("Back`tick", 5)).toBe("MATCH (n:`Back``tick`) RETURN n LIMIT 5");
    expect(cypherSelectRelationship("Weird Label", 1)).toBe("MATCH (a)-[r:`Weird Label`]->(b) RETURN a, r, b LIMIT 1");
  });

  test("refuse a limit that is not a positive safe integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => cypherSelectLabel("Person", limit)).toThrow(RangeError);
      expect(() => cypherSelectRelationship("KNOWS", limit)).toThrow(RangeError);
    }
  });

  test("every output passes the read policy", () => {
    for (const name of NAMES) {
      for (const text of [cypherSelectLabel(name), cypherSelectRelationship(name)]) {
        const verdict = checkCypherRead(text, TEST_PROFILE);
        expect(verdict.allowed).toBe(true);
      }
    }
  });
});

describe("cypherForSegment", () => {
  test("reads kind and name from the segment", () => {
    for (const name of NAMES) {
      expect(cypherForSegment(graphObjectSegment("label", name))).toBe(cypherSelectLabel(name));
      expect(cypherForSegment(graphObjectSegment("relationship_type", name), 7)).toBe(
        cypherSelectRelationship(name, 7),
      );
    }
  });

  test("answers undefined for an index, a constraint and an unknown segment", () => {
    expect(cypherForSegment(graphObjectSegment("index", "person_name"))).toBeUndefined();
    expect(cypherForSegment(graphObjectSegment("constraint", "person_id"))).toBeUndefined();
    expect(cypherForSegment("foo")).toBeUndefined();
  });
});
