/**
 * The Cypher generators (spec 6.5, E11, SR5): the exact statements a tree click writes, the limit
 * bound, the segment arm, a round trip of every output through the lexer and the read policy, and the
 * quoting and the policy agreeing on which names hold a unicode escape (#1295).
 */
import { describe, expect, test } from "bun:test";
import {
  GRAPH_SAMPLE_LIMIT,
  cypherForSegment,
  cypherSelectLabel,
  cypherSelectRelationship,
} from "@/lib/db/graph/cypher/generators";
import { CypherNameError, quoteCypherName } from "@/lib/db/graph/cypher/quote";
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
        if (!verdict.allowed) continue;
        // The whole generated text is the one statement the lexer read, so nothing was split off.
        expect(verdict.statement.text).toBe(text);
      }
    }
  });
});

/**
 * Every spelling of a backslash run before a u or a U, bare and inside a name, with and without the hex
 * digits that complete an escape.
 */
const ESCAPE_NAMES: readonly string[] = [0, 1, 2, 3, 4].flatMap((run) =>
  ["u", "U"].flatMap((letter) =>
    ["0060", "0061", "00e9", "006", ""].flatMap((digits) => {
      const spelled = `${"\\".repeat(run)}${letter}${digits}`;
      return [spelled, `a${spelled}b`, `Back\`tick ${spelled}`];
    }),
  ),
);

describe("the quoting and the read policy agree on unicode escapes (#1295)", () => {
  test("quoteCypherName refuses a name exactly when the policy refuses it backticked as a unicode escape", () => {
    expect(ESCAPE_NAMES.length).toBe(150);
    let refused = 0;
    for (const name of [...ESCAPE_NAMES, ...NAMES]) {
      // The name backticked by hand, as quoteCypherName would write it were it accepted.
      const text = `MATCH (n:\`${name.replaceAll("`", "``")}\`) RETURN n LIMIT 1`;
      const verdict = checkCypherRead(text, TEST_PROFILE);
      const policyRefuses = !verdict.allowed && verdict.refusal.code === "unicode-escape";
      let quotingRefuses = false;
      try {
        quoteCypherName(name);
      } catch (error) {
        if (!(error instanceof CypherNameError)) throw error;
        quotingRefuses = true;
      }
      expect([name, quotingRefuses]).toEqual([name, policyRefuses]);
      if (quotingRefuses) refused += 1;
    }
    // Both arms are exercised: odd runs before a lower-case u are refused, everything else is accepted.
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(ESCAPE_NAMES.length);
  });

  test("a tree click on a name holding an escape raises the name refusal, not a statement the policy refuses", () => {
    for (const name of ["\\u0061", "x\\u0060y", "Caf\\u00e9"]) {
      expect(() => cypherSelectLabel(name)).toThrow(CypherNameError);
      expect(() => cypherSelectRelationship(name)).toThrow(CypherNameError);
      expect(() => cypherForSegment(graphObjectSegment("label", name))).toThrow(CypherNameError);
    }
    for (const name of ["\\\\u0061", "\\U0061"]) {
      const text = cypherSelectLabel(name);
      expect(checkCypherRead(text, TEST_PROFILE).allowed).toBe(true);
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
