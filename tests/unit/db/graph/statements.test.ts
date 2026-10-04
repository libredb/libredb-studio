/**
 * The Cypher statement splitter (spec 3.2): where a text splits, which statements are dropped, what
 * a statement's text and tokens hold, and the CYPHER, EXPLAIN and PROFILE prefixes it reads.
 */
import { describe, expect, test } from "bun:test";
import { lexCypher } from "@/lib/db/graph/cypher/lexer";
import { type CypherStatement, splitCypherStatements } from "@/lib/db/graph/cypher/statements";

const split = (text: string): CypherStatement[] => splitCypherStatements(lexCypher(text));
const texts = (text: string): string[] => split(text).map((statement) => statement.text);
const tokenTexts = (statement: CypherStatement): string[] => statement.tokens.map((token) => token.text);

describe("splitCypherStatements: where a text splits", () => {
  test("one statement without a semicolon", () => {
    expect(texts("MATCH (n) RETURN n")).toEqual(["MATCH (n) RETURN n"]);
  });

  test("splits on each semicolon", () => {
    expect(texts("RETURN 1; RETURN 2;RETURN 3")).toEqual(["RETURN 1", "RETURN 2", "RETURN 3"]);
  });

  test("a semicolon inside a string, a backtick name or a comment never splits", () => {
    expect(texts("RETURN 'a;b', \"c;d\"")).toEqual(["RETURN 'a;b', \"c;d\""]);
    expect(texts("MATCH (n:`A;B`) RETURN n")).toEqual(["MATCH (n:`A;B`) RETURN n"]);
    expect(texts("MATCH (n) // x; y\nRETURN n")).toEqual(["MATCH (n) // x; y\nRETURN n"]);
    expect(texts("MATCH (n) /* x; y */ RETURN n")).toEqual(["MATCH (n) /* x; y */ RETURN n"]);
  });

  test("a trailing semicolon, an empty statement and a comment-only tail yield nothing", () => {
    expect(texts("RETURN 1;")).toEqual(["RETURN 1"]);
    expect(texts("RETURN 1;;  ; RETURN 2")).toEqual(["RETURN 1", "RETURN 2"]);
    expect(texts("RETURN 1; // done\n/* really */")).toEqual(["RETURN 1"]);
  });

  test("an empty, blank or comment-only text yields no statement", () => {
    expect(split("")).toEqual([]);
    expect(split("  \n\t ")).toEqual([]);
    expect(split("// nothing\n/* at all */;")).toEqual([]);
  });
});

describe("splitCypherStatements: a statement's text and tokens", () => {
  test("the text runs from the first to the last significant token, leading and trailing comments excluded", () => {
    expect(texts("  /* lead */ MATCH (n)\n  RETURN n // tail\n ; ")).toEqual(["MATCH (n)\n  RETURN n"]);
  });

  test("an inner comment stays in the text", () => {
    expect(texts("MATCH (n) /* inner */ RETURN n")).toEqual(["MATCH (n) /* inner */ RETURN n"]);
  });

  test("the tokens are the significant ones only, without the semicolon", () => {
    const [first, second] = split("MATCH (n) /* c */ RETURN n; RETURN 2");
    expect(tokenTexts(first)).toEqual(["MATCH", "(", "n", ")", "RETURN", "n"]);
    expect(tokenTexts(second)).toEqual(["RETURN", "2"]);
    expect(second.tokens[0].start).toBe(28);
  });

  test("a plain statement has no version and neither prefix", () => {
    const [statement] = split("MATCH (n) RETURN n");
    expect(statement.cypherVersion).toBeUndefined();
    expect(statement.explain).toBe(false);
    expect(statement.profile).toBe(false);
  });
});

describe("splitCypherStatements: prefixes", () => {
  test("CYPHER followed by a number sets the version", () => {
    const [statement] = split("CYPHER 5 MATCH (n) RETURN n");
    expect(statement.cypherVersion).toBe("5");
    expect(statement.explain).toBe(false);
    expect(statement.profile).toBe(false);
    expect(split("cypher 25 RETURN 1")[0].cypherVersion).toBe("25");
  });

  test("EXPLAIN and PROFILE, in any case", () => {
    const [explain] = split("EXPLAIN MATCH (n) RETURN n");
    expect(explain.explain).toBe(true);
    expect(explain.profile).toBe(false);
    const [profile] = split("profile MATCH (n) RETURN n");
    expect(profile.explain).toBe(false);
    expect(profile.profile).toBe(true);
  });

  test("a version prefix then EXPLAIN or PROFILE", () => {
    const [explain] = split("CYPHER 5 EXPLAIN RETURN 1");
    expect(explain.cypherVersion).toBe("5");
    expect(explain.explain).toBe(true);
    const [profile] = split("/* c */ CYPHER 25 /* d */ PROFILE RETURN 1");
    expect(profile.cypherVersion).toBe("25");
    expect(profile.profile).toBe(true);
  });

  test("EXPLAIN before CYPHER is not read as a version prefix", () => {
    const [statement] = split("EXPLAIN CYPHER 5 RETURN 1");
    expect(statement.explain).toBe(true);
    expect(statement.cypherVersion).toBeUndefined();
  });

  test("CYPHER followed by an option sets no version and keeps the words in the tokens", () => {
    const [statement] = split("CYPHER runtime=slotted EXPLAIN MATCH (n) RETURN n");
    expect(statement.cypherVersion).toBeUndefined();
    expect(statement.explain).toBe(false);
    expect(tokenTexts(statement).slice(0, 5)).toEqual(["CYPHER", "runtime", "=", "slotted", "EXPLAIN"]);
  });

  test("a CYPHER at the end of a statement sets no version", () => {
    const [statement] = split("CYPHER");
    expect(statement.cypherVersion).toBeUndefined();
    expect(tokenTexts(statement)).toEqual(["CYPHER"]);
  });

  test("the prefixes stay in the tokens and the text", () => {
    const [statement] = split("CYPHER 5 PROFILE RETURN 1;");
    expect(statement.text).toBe("CYPHER 5 PROFILE RETURN 1");
    expect(tokenTexts(statement)).toEqual(["CYPHER", "5", "PROFILE", "RETURN", "1"]);
  });

  test("each statement reads its own prefixes", () => {
    const [first, second] = split("EXPLAIN RETURN 1; CYPHER 5 PROFILE RETURN 2");
    expect(first.explain).toBe(true);
    expect(first.cypherVersion).toBeUndefined();
    expect(second.explain).toBe(false);
    expect(second.profile).toBe(true);
    expect(second.cypherVersion).toBe("5");
  });
});
