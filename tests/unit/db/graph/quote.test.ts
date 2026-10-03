/**
 * Cypher quoting (spec 3.2, E11): a name always in backticks with each backtick doubled, a name the
 * server could read differently refused, a string literal escaped, and both held to the lexer by a
 * round trip over a fixed list of samples.
 */
import { describe, expect, test } from "bun:test";
import { lexCypher } from "@/lib/db/graph/cypher/lexer";
import { CypherNameError, quoteCypherName, quoteCypherString } from "@/lib/db/graph/cypher/quote";
import { CYPHER_CORPUS } from "../../../fixtures/graph/cypher-corpus";

function nameErrorOf(name: string): CypherNameError {
  try {
    quoteCypherName(name);
  } catch (error) {
    if (error instanceof CypherNameError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(name)} to be refused`);
}

/** The names and strings the corpus spells, as their decoded values. */
const corpusTokens = CYPHER_CORPUS.flatMap((corpusCase) => lexCypher(corpusCase.text));
const corpusNames = corpusTokens
  .filter((token) => token.kind === "word" || token.kind === "backtick")
  .map((token) => (token.kind === "word" ? token.text : token.value))
  // The corpus spells the escape backslash-u0060 inside backtick names to test the read policy, and quoting refuses it.
  .filter((name) => !/\\u0060/i.test(name));
const corpusStrings = corpusTokens.filter((token) => token.kind === "string").map((token) => token.value);

const NAME_SAMPLES: readonly string[] = [
  ...corpusNames,
  "Person",
  "Back`tick",
  "Weird Label",
  "Kişi",
  "``",
  "`",
  "a`",
  "`a",
  "x``y```z",
  "MATCH",
  "123",
  "a;b",
  "a'b\"c",
  "a\\b",
  "\\u0061",
  "\\u006",
  "\\x60",
  "/* not a comment */",
  "// nor this",
  "$param",
  "~!@#%^&*()-+={}[]|:<>,.?",
  "Straße",
  "Ελληνικά",
  "日本語のラベル",
  "\u{1F600} emoji",
  " no-break space",
  " line separator",
  "\u0080 C1",
  "\uD800 lone surrogate",
];

const STRING_SAMPLES: readonly string[] = [
  ...corpusStrings,
  "",
  "it's",
  'say "hi"',
  "a\\b",
  "\\",
  "'",
  "\\'",
  "line\nbreak\r\ttab",
  "\u0000\u0001\u001F",
  "\u007F",
  "\b\f",
  "\\u0060",
  "`backtick`",
  "a;b // c /* d */",
  "Kişi",
  "Ελληνικά 日本語",
  "\u{1F600}",
  "  ",
  "\uDFFF",
  "$p",
];

describe("quoteCypherName", () => {
  test("always backticks, doubles each backtick, keeps spaces and non-ASCII letters", () => {
    expect(quoteCypherName("Person")).toBe("`Person`");
    expect(quoteCypherName("Back`tick")).toBe("`Back``tick`");
    expect(quoteCypherName("Weird Label")).toBe("`Weird Label`");
    expect(quoteCypherName("Kişi")).toBe("`Kişi`");
    expect(quoteCypherName("``")).toBe("``````");
  });

  test("refuses an empty name", () => {
    const error = nameErrorOf("");
    expect(error.name_).toBe("");
    expect(error.name).toBe("CypherNameError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("empty");
  });

  test("refuses every character below U+0020 and U+007F", () => {
    for (let code = 0; code < 0x20; code += 1) {
      const name = `a${String.fromCharCode(code)}b`;
      expect(nameErrorOf(name).name_).toBe(name);
    }
    expect(nameErrorOf("a\u007Fb").message).toContain("control character");
    expect(nameErrorOf("line\nbreak").message).toContain("control character");
  });

  test("refuses a backslash-u0060 escape sequence in any case, anywhere in the name", () => {
    for (const name of ["\\u0060", "a\\u0060b", "\\U0060", "x\\u0060", "\\u0060\\u0060"]) {
      const error = nameErrorOf(name);
      expect(error.name_).toBe(name);
      expect(error.message).toContain("\\u0060");
    }
  });

  test("accepts near misses of the escape sequence", () => {
    expect(quoteCypherName("\\u0061")).toBe("`\\u0061`");
    expect(quoteCypherName("u0060")).toBe("`u0060`");
    expect(quoteCypherName("\\u006")).toBe("`\\u006`");
  });

  test("round trip: every accepted sample lexes to one backtick token whose value is the name", () => {
    expect(corpusNames).toContain("Weird Label");
    expect(corpusNames).toContain("Back`tick");
    for (const name of NAME_SAMPLES) {
      const tokens = lexCypher(quoteCypherName(name));
      expect(tokens.map((token) => [token.kind, token.value])).toEqual([["backtick", name]]);
    }
  });
});

describe("quoteCypherString", () => {
  test("single quotes, with a quote and a backslash escaped", () => {
    expect(quoteCypherString("it's")).toBe("'it\\'s'");
    expect(quoteCypherString("a\\b")).toBe("'a\\\\b'");
    expect(quoteCypherString('say "hi"')).toBe("'say \"hi\"'");
    expect(quoteCypherString("")).toBe("''");
  });

  test("characters below U+0020 become \\uXXXX escapes", () => {
    expect(quoteCypherString("a\nb")).toBe("'a\\u000Ab'");
    expect(quoteCypherString("\u0000\u001F")).toBe("'\\u0000\\u001F'");
    expect(quoteCypherString("\t")).toBe("'\\u0009'");
  });

  test("other characters stay as written", () => {
    expect(quoteCypherString("Kişi \u007F `x` \u{1F600}")).toBe("'Kişi \u007F `x` \u{1F600}'");
  });

  test("round trip: every sample lexes to one string token whose value is the string", () => {
    expect(corpusStrings.length).toBeGreaterThan(0);
    for (const value of STRING_SAMPLES) {
      const tokens = lexCypher(quoteCypherString(value));
      expect(tokens.map((token) => [token.kind, token.value])).toEqual([["string", value]]);
    }
  });
});
