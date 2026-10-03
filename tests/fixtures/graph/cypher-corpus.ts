/**
 * Cypher texts read one way by the lexer, the read policy and the editor (spec 3.2).
 *
 * One corpus for every reader of `src/lib/db/graph/cypher/lexer.ts`: tests/unit/db/graph/lexer.test.ts
 * holds each case's significant tokens to `lexCypher`, and the read policy's and the editor's tests
 * extend the cases with the verdict the policy gives, so the word the editor draws is the word the
 * policy judges.
 *
 * A case's `tokens` are the tokens `lexCypher` returns without the whitespace ones, as
 * [kind, exact source text]. A token that spans lines holds its newlines.
 */
import type { CypherTokenKind } from "@/lib/db/graph/cypher/lexer";

export interface CorpusCase {
  readonly name: string;
  readonly text: string;
  /** Significant tokens (no whitespace) as [kind, text]. */
  readonly tokens?: readonly (readonly [CypherTokenKind, string])[];
  /** "allowed" or a refusal code; the read policy's task narrows this to its refusal code type. */
  readonly verdict?: string;
  /** The word, procedure, namespace, form or prefix a refusal names. */
  readonly subject?: string;
}

export const CYPHER_CORPUS: readonly CorpusCase[] = [
  {
    name: "a simple MATCH",
    text: "MATCH (n:Person) RETURN n.name LIMIT 10",
    tokens: [
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ":"],
      ["word", "Person"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "n"],
      ["punct", "."],
      ["word", "name"],
      ["word", "LIMIT"],
      ["number", "10"],
    ],
  },
  {
    name: "a label with a space in backticks",
    text: "MATCH (n:`Weird Label`) RETURN n",
    tokens: [
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ":"],
      ["backtick", "`Weird Label`"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "n"],
    ],
  },
  {
    name: "a backticked name with a doubled backtick",
    text: "MATCH (n:`Back``tick`) RETURN n",
    tokens: [
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ":"],
      ["backtick", "`Back``tick`"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "n"],
    ],
  },
  {
    name: "strings with each escape",
    text: String.raw`RETURN 'a\\b\'c\"d\ne\rf\tg\bh\fiçj\U0001F600k', "x\"y\'z"`,
    tokens: [
      ["word", "RETURN"],
      ["string", String.raw`'a\\b\'c\"d\ne\rf\tg\bh\fiçj\U0001F600k'`],
      ["punct", ","],
      ["string", String.raw`"x\"y\'z"`],
    ],
  },
  {
    name: "a line comment hiding CREATE",
    text: "MATCH (n) // CREATE (m)\nRETURN n",
    tokens: [
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ")"],
      ["comment", "// CREATE (m)"],
      ["word", "RETURN"],
      ["word", "n"],
    ],
  },
  {
    name: "a block comment over two lines hiding DELETE",
    text: "MATCH (n) /* first\nDELETE n */ RETURN n",
    tokens: [
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ")"],
      ["comment", "/* first\nDELETE n */"],
      ["word", "RETURN"],
      ["word", "n"],
    ],
  },
  {
    name: "a comment between LOAD and CSV",
    text: "LOAD /* x */ CSV FROM 'file:///a.csv' AS row RETURN row",
    tokens: [
      ["word", "LOAD"],
      ["comment", "/* x */"],
      ["word", "CSV"],
      ["word", "FROM"],
      ["string", "'file:///a.csv'"],
      ["word", "AS"],
      ["word", "row"],
      ["word", "RETURN"],
      ["word", "row"],
    ],
  },
  {
    name: "a number set, the minus sign apart",
    text: "RETURN 123, 1.5, .5, 1e10, 1.5E-3, 0x1F, 0o17, -7",
    tokens: [
      ["word", "RETURN"],
      ["number", "123"],
      ["punct", ","],
      ["number", "1.5"],
      ["punct", ","],
      ["number", ".5"],
      ["punct", ","],
      ["number", "1e10"],
      ["punct", ","],
      ["number", "1.5E-3"],
      ["punct", ","],
      ["number", "0x1F"],
      ["punct", ","],
      ["number", "0o17"],
      ["punct", ","],
      ["punct", "-"],
      ["number", "7"],
    ],
  },
  {
    name: "a range in a variable-length pattern",
    text: "MATCH p=(a)-[*1..3]->(b) RETURN p",
    tokens: [
      ["word", "MATCH"],
      ["word", "p"],
      ["punct", "="],
      ["punct", "("],
      ["word", "a"],
      ["punct", ")"],
      ["punct", "-"],
      ["punct", "["],
      ["punct", "*"],
      ["number", "1"],
      ["punct", ".."],
      ["number", "3"],
      ["punct", "]"],
      ["punct", "->"],
      ["punct", "("],
      ["word", "b"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "p"],
    ],
  },
  {
    name: "parameters plain and backticked",
    text: "RETURN $name, $0, $`odd name`",
    tokens: [
      ["word", "RETURN"],
      ["parameter", "$name"],
      ["punct", ","],
      ["parameter", "$0"],
      ["punct", ","],
      ["parameter", "$`odd name`"],
    ],
  },
  {
    name: "a lone parameter",
    text: "RETURN $p",
    tokens: [
      ["word", "RETURN"],
      ["parameter", "$p"],
    ],
  },
  {
    name: "a denied word as a property and as a map key",
    text: "MATCH (n) RETURN n.set, {create: 1}",
    tokens: [
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "n"],
      ["punct", "."],
      ["word", "set"],
      ["punct", ","],
      ["punct", "{"],
      ["word", "create"],
      ["punct", ":"],
      ["number", "1"],
      ["punct", "}"],
    ],
  },
  {
    name: "a semicolon inside a string",
    text: "RETURN 'a;b'",
    tokens: [
      ["word", "RETURN"],
      ["string", "'a;b'"],
    ],
  },
  {
    name: "two statements",
    text: "RETURN 1; RETURN 2",
    tokens: [
      ["word", "RETURN"],
      ["number", "1"],
      ["punct", ";"],
      ["word", "RETURN"],
      ["number", "2"],
    ],
  },
  {
    name: "a Unicode label",
    text: "MATCH (k:Kişi) RETURN k",
    tokens: [
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "k"],
      ["punct", ":"],
      ["word", "Kişi"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "k"],
    ],
  },
  {
    name: "a qualified procedure call",
    text: "CALL db.labels()",
    tokens: [
      ["word", "CALL"],
      ["word", "db"],
      ["punct", "."],
      ["word", "labels"],
      ["punct", "("],
      ["punct", ")"],
    ],
  },
  {
    name: "an unqualified procedure call",
    text: "CALL ping()",
    tokens: [
      ["word", "CALL"],
      ["word", "ping"],
      ["punct", "("],
      ["punct", ")"],
    ],
  },
  {
    name: "a CALL subquery",
    text: "CALL { MATCH (n) RETURN n } RETURN 1",
    tokens: [
      ["word", "CALL"],
      ["punct", "{"],
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "n"],
      ["punct", "}"],
      ["word", "RETURN"],
      ["number", "1"],
    ],
  },
  {
    name: "a scoped CALL subquery with an undirected-then-directed arrow",
    text: "CALL (n) { MATCH (n)-->(m) RETURN m } RETURN 1",
    tokens: [
      ["word", "CALL"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ")"],
      ["punct", "{"],
      ["word", "MATCH"],
      ["punct", "("],
      ["word", "n"],
      ["punct", ")"],
      ["punct", "-"],
      ["punct", "->"],
      ["punct", "("],
      ["word", "m"],
      ["punct", ")"],
      ["word", "RETURN"],
      ["word", "m"],
      ["punct", "}"],
      ["word", "RETURN"],
      ["number", "1"],
    ],
  },
  {
    name: "a qualified built-in function",
    text: "RETURN date.truncate('day', date())",
    tokens: [
      ["word", "RETURN"],
      ["word", "date"],
      ["punct", "."],
      ["word", "truncate"],
      ["punct", "("],
      ["string", "'day'"],
      ["punct", ","],
      ["word", "date"],
      ["punct", "("],
      ["punct", ")"],
      ["punct", ")"],
    ],
  },
  {
    name: "two quotes in a row end a string and start another",
    text: "RETURN 'it''s'",
    tokens: [
      ["word", "RETURN"],
      ["string", "'it'"],
      ["string", "'s'"],
    ],
  },
  {
    name: "a word that only looks outside a string",
    text: "RETURN 'a'' CREATE (n) //'",
    tokens: [
      ["word", "RETURN"],
      ["string", "'a'"],
      ["string", "' CREATE (n) //'"],
    ],
  },
  {
    name: "block comments do not nest",
    text: "/* a /* b */ CREATE */",
    tokens: [
      ["comment", "/* a /* b */"],
      ["word", "CREATE"],
      ["punct", "*"],
      ["punct", "/"],
    ],
  },
];
