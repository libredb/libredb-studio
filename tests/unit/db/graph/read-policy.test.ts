/**
 * The Cypher read policy (spec 5.2): every corpus case's verdict, subject and message under a test
 * profile, the details a caller reads (isShow, callsProcedure, positions), and an empty profile that
 * proves the policy holds no engine names of its own.
 *
 * The test profile is this file's own fixed list, written so each rule of the policy has a case; it
 * is not the shipped Neo4j profile and claims no parity with it. The shipped lists are held to the
 * same corpus verdicts by tests/unit/db/neo4j/profile.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { type CypherReadVerdict, type CypherRefusal, checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";
import { CYPHER_CORPUS } from "../../../fixtures/graph/cypher-corpus";

const ALLOWED_PROCEDURES = [
  "db.labels",
  "db.relationshipTypes",
  "db.propertyKeys",
  "db.schema.nodeTypeProperties",
  "db.schema.relTypeProperties",
  "dbms.components",
];

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
      ["ALTER"],
      ["RENAME"],
      ["GRANT"],
      ["DENY"],
      ["REVOKE"],
      ["LOAD"],
      ["FOREACH"],
      ["USE"],
      ["TERMINATE"],
      ["START"],
      ["STOP"],
      ["IN", "TRANSACTIONS"],
      // `IN [n] CONCURRENT TRANSACTIONS`: the optional number sits between IN and CONCURRENT.
      ["CONCURRENT", "TRANSACTIONS"],
      // A count between IN and the word would let either sequence above miss a batch form.
      ["ROWS"],
      ["TRANSACTIONS"],
    ],
    deniedNamespaces: ["apoc.", "gds."],
    allowedProcedures: ALLOWED_PROCEDURES,
    allowedQualifiedFunctions: ["date.truncate", "datetime.truncate", "duration.between", "point.distance"],
    allowedShowForms: [
      ["INDEX"],
      ["INDEXES"],
      ["CONSTRAINT"],
      ["CONSTRAINTS"],
      ["DATABASE"],
      ["DATABASES"],
      ["DATABASE", "*"],
      ["DEFAULT", "DATABASE"],
      ["HOME", "DATABASE"],
      ["PROCEDURES"],
      ["FUNCTIONS"],
    ],
    refusedPrefixes: ["EXPLAIN", "PROFILE"],
  },
  dialect: { supportsVersionPrefix: true, offsetKeyword: "SKIP" },
};

const EMPTY_PROFILE: GraphPolicyProfile = {
  engineLabel: "Nothing",
  readPolicy: {
    deniedWords: [],
    deniedNamespaces: [],
    allowedProcedures: [],
    allowedQualifiedFunctions: [],
    allowedShowForms: [],
    refusedPrefixes: [],
  },
  dialect: { supportsVersionPrefix: false, offsetKeyword: "SKIP" },
};

const refusalOf = (text: string, profile: GraphPolicyProfile = TEST_PROFILE): CypherRefusal => {
  const verdict = checkCypherRead(text, profile);
  if (verdict.allowed) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return verdict.refusal;
};

const allowedOf = (
  text: string,
  profile: GraphPolicyProfile = TEST_PROFILE,
): Extract<CypherReadVerdict, { allowed: true }> => {
  const verdict = checkCypherRead(text, profile);
  if (!verdict.allowed) throw new Error(`expected ${JSON.stringify(text)} to be allowed: ${verdict.refusal.message}`);
  return verdict;
};

/** The denied word as the case types it, where that differs from the uppercased subject. */
const TYPED_WORD: Record<string, string> = {
  "a denied word as a property and as a map key": "set",
  "create in lower case": "create",
  "a denied word as a bare property": "set",
  "a denied word as a map key": "create",
};

/** The message each refusal code carries for a subject, written out from the task's exact text. */
function expectedMessage(code: string, subject: string | undefined, typed: string | undefined): string {
  switch (code) {
    case "empty":
      return "There is no statement to run.";
    case "multiple-statements":
      return `Neo4j runs one statement at a time, and this text holds ${subject}. Run them one by one.`;
    case "denied-prefix":
      return `${subject} is not supported on Neo4j connections in this version.`;
    case "denied-word":
      return `${subject} is not allowed: Neo4j connections are read-only in this version. If ${subject} is a name here (a property, a map key or a label), write it in backticks, as \`${typed ?? subject}\`.`;
    case "denied-procedure":
      return `CALL ${subject} is not allowed: a read-only Neo4j connection can call only ${ALLOWED_PROCEDURES.join(", ")}.`;
    case "denied-namespace":
      return `${subject}* is not allowed on Neo4j connections in this version, because its procedures and functions can reach the network or the file system. A name starting ${subject} is refused in any position, called or not, so a variable named ${subject?.slice(0, -1)} must be renamed.`;
    case "denied-show":
      return `${subject} is not allowed on a read-only Neo4j connection.`;
    case "denied-function":
      return `${subject}() is not allowed: a read-only Neo4j connection calls only built-in functions.`;
    case "unicode-escape":
      return `The statement holds the escape ${subject}, which the server decodes before it reads the text, so it could end a name, a string or a comment early and the server would run a statement other than the one checked. It was not run: type the character itself.`;
    case "parameters-unsupported":
      return `Parameters such as ${subject} are not supported on Neo4j connections in this version: write the value into the statement.`;
    default:
      throw new Error(`no message written for ${code}`);
  }
}

describe("the shared corpus", () => {
  test("every case carries a verdict", () => {
    for (const entry of CYPHER_CORPUS) expect(entry.verdict, entry.name).toBeDefined();
  });

  for (const entry of CYPHER_CORPUS) {
    test(`${entry.name}: ${entry.verdict}`, () => {
      const verdict = checkCypherRead(entry.text, TEST_PROFILE);
      if (entry.verdict === "allowed") {
        expect(verdict.allowed ? undefined : verdict.refusal).toBeUndefined();
        expect(entry.subject).toBeUndefined();
        return;
      }
      if (verdict.allowed) throw new Error(`expected ${JSON.stringify(entry.text)} to be refused`);
      expect(verdict.refusal.code).toBe(entry.verdict as CypherRefusal["code"]);
      expect(verdict.refusal.subject).toBe(entry.subject ?? "");
      expect(verdict.refusal.message).toBe(
        expectedMessage(verdict.refusal.code, entry.subject, TYPED_WORD[entry.name]),
      );
    });
  }
});

describe("lex errors", () => {
  // Not a corpus case: every corpus reader lexes every text, and this one does not lex.
  test("an unterminated string is refused with its reason and the character it starts at", () => {
    expect(refusalOf("RETURN 'unterminated")).toEqual({
      code: "lex-error",
      subject: "unterminated-string",
      position: 7,
      message: "The statement could not be read: unterminated string at character 8.",
    });
  });

  test("each reason in words", () => {
    expect(refusalOf("RETURN 1 /* open").message).toBe(
      "The statement could not be read: unterminated comment at character 10.",
    );
    expect(refusalOf("MATCH (n:`open").message).toBe(
      "The statement could not be read: unterminated backtick name at character 10.",
    );
    expect(refusalOf(String.raw`RETURN 'a\qb'`).message).toMatch(
      /^The statement could not be read: invalid escape at character \d+\.$/,
    );
    expect(refusalOf("RETURN 1 # 2").message).toMatch(
      /^The statement could not be read: unexpected character at character \d+\.$/,
    );
  });
});

describe("positions", () => {
  test("a denied word points at its first word", () => {
    expect(refusalOf("MATCH (n) RETURN n.set").position).toBe(19);
    expect(refusalOf("MATCH (n) CALL { RETURN n } IN TRANSACTIONS RETURN n").position).toBe(28);
  });

  test("a procedure, a namespace, a function and a parameter point at their names", () => {
    expect(refusalOf("CALL dbms.listConfig()").position).toBe(5);
    expect(refusalOf("RETURN 1, apoc.text.join(['a'], ',')").position).toBe(10);
    expect(refusalOf("RETURN custom.fetch('x')").position).toBe(7);
    expect(refusalOf("RETURN 1 + $p").position).toBe(11);
  });

  test("a prefix, a SHOW form and a second statement point where they start", () => {
    expect(refusalOf("CYPHER 5 EXPLAIN MATCH (n) RETURN n").position).toBe(9);
    expect(refusalOf("  SHOW USERS").position).toBe(2);
    expect(refusalOf("RETURN 1;  RETURN 2").position).toBe(11);
  });

  test("an empty text has no position", () => {
    expect(refusalOf("  ").position).toBeUndefined();
  });

  test("three statements are counted", () => {
    expect(refusalOf("RETURN 1; RETURN 2; RETURN 3").subject).toBe("3");
  });
});

describe("prefixes", () => {
  test("a CYPHER version prefix before EXPLAIN is read past", () => {
    expect(refusalOf("CYPHER 5 PROFILE MATCH (n) RETURN n").subject).toBe("PROFILE");
  });

  test("a prefix the profile does not refuse passes, and the walk starts after it", () => {
    const profile: GraphPolicyProfile = {
      ...TEST_PROFILE,
      readPolicy: { ...TEST_PROFILE.readPolicy, refusedPrefixes: ["PROFILE"] },
    };
    expect(allowedOf("EXPLAIN SHOW INDEXES", profile).isShow).toBe(true);
    expect(refusalOf("EXPLAIN CREATE (n)", profile).subject).toBe("CREATE");
  });

  test("a CYPHER version prefix is refused where the dialect has none, and allowed where it has one", () => {
    const profile: GraphPolicyProfile = {
      ...TEST_PROFILE,
      engineLabel: "Memgraph",
      dialect: { ...TEST_PROFILE.dialect, supportsVersionPrefix: false },
    };
    expect(refusalOf("  CYPHER 5 MATCH (n) RETURN n", profile)).toEqual({
      code: "denied-prefix",
      subject: "CYPHER 5",
      position: 2,
      message: "CYPHER 5 is not supported on Memgraph connections in this version.",
    });
    expect(allowedOf("MATCH (n) RETURN n", profile).statement.cypherVersion).toBeUndefined();
    expect(allowedOf("CYPHER 25 MATCH (n) RETURN n").statement.cypherVersion).toBe("25");
  });
});

describe("isShow and callsProcedure", () => {
  test("isShow is true only when SHOW comes first after the prefix", () => {
    expect(allowedOf("SHOW INDEXES").isShow).toBe(true);
    expect(allowedOf("CYPHER 5 SHOW CONSTRAINTS YIELD name RETURN name").isShow).toBe(true);
    expect(allowedOf("MATCH (n) RETURN n").isShow).toBe(false);
  });

  test("callsProcedure is true when an allowlisted CALL is present", () => {
    expect(allowedOf("CALL db.labels()").callsProcedure).toBe(true);
    expect(allowedOf("MATCH (n) CALL db.labels() YIELD label RETURN label").callsProcedure).toBe(true);
    expect(allowedOf("CALL { MATCH (n) RETURN n } RETURN 1").callsProcedure).toBe(false);
    expect(allowedOf("MATCH (n) RETURN n").callsProcedure).toBe(false);
  });

  test("the allowed verdict carries the statement", () => {
    expect(allowedOf("MATCH (n) RETURN n;").statement.text).toBe("MATCH (n) RETURN n");
  });
});

describe("qualified names", () => {
  test("the namespace check wins over the procedure check", () => {
    const profile: GraphPolicyProfile = {
      ...TEST_PROFILE,
      readPolicy: { ...TEST_PROFILE.readPolicy, allowedProcedures: ["apoc.help"] },
    };
    expect(refusalOf("CALL apoc.help('x')", profile).code).toBe("denied-namespace");
  });

  test("the namespace check compares lowercased names", () => {
    expect(refusalOf("CALL APOC.load.json('x')").subject).toBe("apoc.");
    expect(refusalOf("RETURN Gds.version()").subject).toBe("gds.");
  });

  test("a qualified name whose second part is backticked", () => {
    expect(allowedOf("CALL db.`labels`()").callsProcedure).toBe(true);
    expect(refusalOf("CALL apoc.`load`.json('x')").code).toBe("denied-namespace");
    expect(refusalOf("CALL db.`createLabel`('X')").subject).toBe("db.createLabel");
  });

  test("procedure names compare case-sensitively, function names lowercased", () => {
    expect(refusalOf("CALL db.Labels()").subject).toBe("db.Labels");
    expect(allowedOf("RETURN Date.Truncate('day', date())").allowed).toBe(true);
  });

  test("a property chain is not a function call", () => {
    expect(allowedOf("MATCH (n) RETURN n.address.city").allowed).toBe(true);
  });

  test("CALL with no name after it is refused as a procedure", () => {
    expect(refusalOf("CALL").code).toBe("denied-procedure");
    expect(refusalOf("CALL").subject).toBe("CALL");
    expect(refusalOf("CALL 5").subject).toBe("CALL");
  });

  test("a scoped CALL with an unclosed scope still walks the tokens after CALL", () => {
    expect(refusalOf("CALL (n, CREATE").subject).toBe("CREATE");
  });

  test("a scoped CALL walks nested parentheses in its scope", () => {
    expect(allowedOf("MATCH (n) CALL ((n)) { RETURN 1 AS x } RETURN x").allowed).toBe(true);
    expect(allowedOf("MATCH (n) CALL (*) { RETURN 1 AS x } RETURN x").allowed).toBe(true);
  });

  test("a scoped CALL's scope is read by the same rules as the rest of the statement", () => {
    expect(refusalOf("CALL (x, set) { RETURN 1 AS y } RETURN y").subject).toBe("SET");
    expect(refusalOf("CALL ($p) { RETURN 1 AS y } RETURN y").code).toBe("parameters-unsupported");
    expect(refusalOf("CALL (apoc.load.json('x')) { RETURN 1 AS y } RETURN y").subject).toBe("apoc.");
    expect(refusalOf("CALL (custom.fetch('x')) { RETURN 1 AS y } RETURN y").subject).toBe("custom.fetch");
  });

  test("one backticked name holding dots, called, is read as a qualified function name", () => {
    expect(refusalOf("RETURN `Apoc.text.join`(['a'], ',')").subject).toBe("apoc.");
    expect(refusalOf("RETURN 1, `custom.fetch`('x')").position).toBe(10);
    expect(allowedOf("RETURN `date.truncate`('day', date())").allowed).toBe(true);
  });

  test("one backticked name holding dots, not called, is a plain name", () => {
    expect(allowedOf("MATCH (`apoc.x`) RETURN `apoc.x`").allowed).toBe(true);
    expect(allowedOf("MATCH (n) RETURN n.`custom.fetch`").allowed).toBe(true);
  });

  test("a name starting a denied namespace is refused uncalled too, and the refusal says to rename it", () => {
    expect(refusalOf("MATCH (`apoc`) RETURN `apoc`.name").message).toBe(
      "apoc.* is not allowed on Neo4j connections in this version, because its procedures and functions can reach the network or the file system. A name starting apoc. is refused in any position, called or not, so a variable named apoc must be renamed.",
    );
  });

  test("CALL and SHOW after a dot or before a colon are names, not clauses", () => {
    expect(allowedOf("MATCH (n) RETURN n.call").callsProcedure).toBe(false);
    expect(allowedOf("MATCH (n) RETURN n.show").isShow).toBe(false);
    expect(allowedOf("RETURN {call: 1, show: 2}").allowed).toBe(true);
    expect(allowedOf("MATCH (n) RETURN n.CALL, n.SHOW").allowed).toBe(true);
  });

  test("CALL used as a label names CALL, not an empty procedure, and advises the backtick form", () => {
    expect(refusalOf("MATCH (n:CALL) RETURN n")).toEqual({
      code: "denied-procedure",
      subject: "CALL",
      position: 9,
      message: `CALL is not allowed here: a read-only Neo4j connection can call only ${ALLOWED_PROCEDURES.join(", ")}. If CALL is a name here (a property, a map key or a label), write it in backticks, as \`CALL\`.`,
    });
    expect(refusalOf("MATCH (call) RETURN 1").message).toEndWith("write it in backticks, as `call`.");
    expect(allowedOf("MATCH (n:`CALL`) RETURN n").callsProcedure).toBe(false);
  });

  test("CALL before a keyword is a name too, refused as CALL with the backtick advice", () => {
    const refusal = refusalOf("MATCH (n) WITH n AS call RETURN call");
    expect([refusal.subject, refusal.position]).toEqual(["CALL", 20]);
    expect(refusal.message).toEndWith("write it in backticks, as `call`.");
    expect(refusalOf("CALL myproc()").message).toBe(
      `CALL myproc is not allowed: a read-only Neo4j connection can call only ${ALLOWED_PROCEDURES.join(", ")}.`,
    );
  });

  test("SHOW used as a name names only SHOW and the words after it, and advises the backtick form", () => {
    expect(refusalOf("MATCH (n:SHOW) RETURN n")).toEqual({
      code: "denied-show",
      subject: "SHOW",
      position: 9,
      message:
        "SHOW is not allowed on a read-only Neo4j connection. If SHOW is a name here (a property, a map key or a label), write it in backticks, as `SHOW`.",
    });
    expect(refusalOf("MATCH (show) RETURN show").message).toBe(
      "SHOW is not allowed on a read-only Neo4j connection. If SHOW is a name here (a property, a map key or a label), write it in backticks, as `show`.",
    );
    expect(refusalOf("SHOW USERS").message).toBe("SHOW USERS is not allowed on a read-only Neo4j connection.");
    expect(refusalOf("SHOW DATABASE 'a' , `b`").subject).toBe("SHOW DATABASE 'a' `b`");
    expect(allowedOf("MATCH (n:`SHOW`) RETURN n").isShow).toBe(false);
  });

  test("CALL after a dot and called is still a qualified function outside the allowlist", () => {
    expect(refusalOf("MATCH (n) RETURN n.call('x')").subject).toBe("n.call");
    expect(refusalOf("RETURN apoc.call('x')").subject).toBe("apoc.");
  });
});

describe("SHOW forms", () => {
  test("a star in a form matches one name token of any kind", () => {
    expect(allowedOf("SHOW DATABASE neo4j").isShow).toBe(true);
    expect(allowedOf("SHOW DATABASE `neo4j`").isShow).toBe(true);
    expect(allowedOf("SHOW DATABASE 'neo4j'").isShow).toBe(true);
    expect(refusalOf("SHOW DATABASE a b").subject).toBe("SHOW DATABASE A B");
  });

  test("words are compared uppercased, and each clause word ends the form", () => {
    expect(allowedOf("show indexes yield name order by name skip 1 limit 2").isShow).toBe(true);
    expect(allowedOf("SHOW FUNCTIONS RETURN 1").isShow).toBe(true);
    expect(allowedOf("SHOW PROCEDURES WHERE name = 'x'").isShow).toBe(true);
  });

  test("a refused form names the words as uppercased and the other tokens as typed", () => {
    expect(refusalOf("show users").subject).toBe("SHOW USERS");
    expect(refusalOf("SHOW USER `bob` PRIVILEGES").subject).toBe("SHOW USER `bob` PRIVILEGES");
    expect(refusalOf("SHOW").subject).toBe("SHOW");
  });

  test("SHOW later in a statement is still checked", () => {
    expect(refusalOf("MATCH (n) SHOW USERS").code).toBe("denied-show");
  });
});

describe("denied words", () => {
  test("a sequence matches only consecutive words", () => {
    expect(allowedOf("MATCH (n) WHERE n.x IN [1] RETURN n").allowed).toBe(true);
    expect(refusalOf("MATCH (n) CALL { RETURN n } IN CONCURRENT TRANSACTIONS RETURN n").subject).toBe(
      "CONCURRENT TRANSACTIONS",
    );
    expect(allowedOf("MATCH (n) WITH n AS CONCURRENT RETURN CONCURRENT").allowed).toBe(true);
  });

  test("a sequence typed in mixed case advises the backtick form as typed", () => {
    expect(refusalOf("MATCH (n) CALL { RETURN n } in Transactions RETURN n").message).toBe(
      "IN TRANSACTIONS is not allowed: Neo4j connections are read-only in this version. If IN TRANSACTIONS is a name here (a property, a map key or a label), write it in backticks, as `in Transactions`.",
    );
  });
});

describe("a unicode escape the server decodes before it reads the text", () => {
  test("is refused at its backslash, before the text is lexed", () => {
    expect(refusalOf(String.raw`RETURN 'x`)).toMatchObject({ code: "lex-error" });
    expect(refusalOf(String.raw`RETURN 'x\u0027`)).toMatchObject({ code: "unicode-escape", position: 9 });
  });

  test("an odd run of backslashes before u is an escape, an even run is not", () => {
    expect(refusalOf(String.raw`RETURN '\\\u0027' AS s`).position).toBe(10);
    expect(allowedOf(String.raw`RETURN '\\u0027' AS s`).allowed).toBe(true);
  });

  test("is refused under a profile that denies nothing", () => {
    expect(refusalOf(String.raw`RETURN 1 // \u000a`, EMPTY_PROFILE).code).toBe("unicode-escape");
  });

  test("an upper-case U, which the server keeps as written, is not one", () => {
    expect(allowedOf("RETURN 1 AS `x\\U0060y`").allowed).toBe(true);
  });
});

describe("a line comment ended by a carriage return", () => {
  test("hides nothing: the text after the carriage return is code, as the server reads it", () => {
    for (const [text, code, subject] of [
      ["WITH 1 AS x //\rLOAD CSV FROM 'http://h/x' AS row\nRETURN x", "denied-word", "LOAD"],
      ["MATCH (n) //\rCREATE (m)\nRETURN n", "denied-word", "CREATE"],
      ["RETURN 1 //\rTERMINATE TRANSACTIONS 'neo4j-transaction-1'\n", "denied-word", "TERMINATE"],
      ["RETURN 1 //\rCALL apoc.load.json('http://h/x') YIELD value\nRETURN 1", "denied-namespace", "apoc."],
      ["RETURN 1 //\rSHOW USERS\n", "denied-show", "SHOW USERS"],
      ["RETURN 1 // x\r\nCREATE (n)", "denied-word", "CREATE"],
    ] as const) {
      const refusal = refusalOf(text);
      expect([refusal.code, refusal.subject], JSON.stringify(text)).toEqual([code, subject]);
    }
  });
});

describe("an empty profile", () => {
  test("its empty deny lists refuse nothing: the policy holds no denied word, prefix or namespace", () => {
    for (const text of [
      "CREATE (n)",
      "EXPLAIN MATCH (n) RETURN n",
      "MATCH (n) DETACH DELETE n",
      "USE system MATCH (n) RETURN n",
    ]) {
      expect(allowedOf(text, EMPTY_PROFILE).allowed).toBe(true);
    }
  });

  test("its empty allow lists allow nothing: the policy holds no procedure, function or SHOW form", () => {
    expect(refusalOf("CALL db.labels()", EMPTY_PROFILE).code).toBe("denied-procedure");
    expect(refusalOf("CALL apoc.load.json('http://x')", EMPTY_PROFILE).code).toBe("denied-procedure");
    expect(refusalOf("RETURN date.truncate('day', date())", EMPTY_PROFILE).code).toBe("denied-function");
    expect(refusalOf("SHOW INDEXES", EMPTY_PROFILE).code).toBe("denied-show");
  });

  test("still refuses a lex error, an empty text, two statements and parameters", () => {
    expect(refusalOf("RETURN 'x", EMPTY_PROFILE).code).toBe("lex-error");
    expect(refusalOf("", EMPTY_PROFILE).code).toBe("empty");
    expect(refusalOf("RETURN 1; RETURN 2", EMPTY_PROFILE).message).toBe(
      "Nothing runs one statement at a time, and this text holds 2. Run them one by one.",
    );
    expect(refusalOf("RETURN $p", EMPTY_PROFILE).message).toBe(
      "Parameters such as $p are not supported on Nothing connections in this version: write the value into the statement.",
    );
  });

  test("a CALL with an empty allowlist names no procedure", () => {
    expect(refusalOf("CALL ping()", EMPTY_PROFILE).message).toBe(
      "CALL ping is not allowed: a read-only Nothing connection can call only .",
    );
  });
});
