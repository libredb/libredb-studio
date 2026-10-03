/**
 * The Cypher lexer (spec 3.2): one test per rule, the shared corpus, every refusal with its
 * position, and the line tokenizer the editor calls held to the whole-text reading.
 */
import { describe, expect, test } from "bun:test";
import {
  CYPHER_INITIAL_STATE,
  CYPHER_KEYWORDS,
  CypherLexError,
  type CypherLineState,
  type CypherToken,
  lexCypher,
  tokenizeCypherLine,
} from "@/lib/db/graph/cypher/lexer";
import { CYPHER_CORPUS } from "../../../fixtures/graph/cypher-corpus";

const significant = (text: string): CypherToken[] => lexCypher(text).filter((token) => token.kind !== "whitespace");
const pairs = (text: string): [string, string][] => significant(text).map((token) => [token.kind, token.text]);
const only = (text: string): CypherToken => {
  const tokens = significant(text);
  if (tokens.length !== 1) throw new Error(`expected one token in ${JSON.stringify(text)}, got ${tokens.length}`);
  return tokens[0];
};

function lexErrorOf(text: string): CypherLexError {
  try {
    lexCypher(text);
  } catch (error) {
    if (error instanceof CypherLexError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(text)} to throw`);
}

/** Reads a text line by line through tokenizeCypherLine, as the editor's tokens provider does. */
function byLines(text: string): { tokens: CypherToken[]; states: CypherLineState[] } {
  let state = CYPHER_INITIAL_STATE;
  let offset = 0;
  const tokens: CypherToken[] = [];
  const states: CypherLineState[] = [];
  for (const line of text.split("\n")) {
    const result = tokenizeCypherLine(line, state, offset);
    tokens.push(...result.tokens);
    state = result.state;
    states.push(state);
    offset += line.length + 1;
  }
  return { tokens, states };
}

describe("the shared corpus", () => {
  for (const entry of CYPHER_CORPUS) {
    const expected = entry.tokens;
    if (expected === undefined) continue;
    test(entry.name, () => {
      expect(pairs(entry.text)).toEqual(expected.map(([kind, text]) => [kind, text]));
    });
  }

  test("every corpus text is reproduced exactly by its tokens, with contiguous spans", () => {
    for (const entry of CYPHER_CORPUS) {
      const tokens = lexCypher(entry.text);
      expect(tokens.map((token) => token.text).join("")).toBe(entry.text);
      let at = 0;
      for (const token of tokens) {
        expect(token.start).toBe(at);
        expect(entry.text.slice(token.start, token.end)).toBe(token.text);
        at = token.end;
      }
      expect(at).toBe(entry.text.length);
    }
  });

  test("the corpus values a reader relies on", () => {
    expect(only("`Weird Label`").value).toBe("Weird Label");
    expect(only("`Back``tick`").value).toBe("Back`tick");
    expect(only("$`odd name`").value).toBe("odd name");
    expect(only("$name").value).toBe("name");
    expect(only("$0").value).toBe("0");
    expect(only("Kişi").value).toBe("KIŞI");
    expect(only("'a;b'").value).toBe("a;b");
  });
});

describe("words", () => {
  test("a letter or underscore, then letters, digits and underscores; the value is uppercased", () => {
    expect(only("_a1_b").value).toBe("_A1_B");
    expect(only("match").value).toBe("MATCH");
    expect(only("Straße").text).toBe("Straße");
    expect(pairs("1abc")).toEqual([
      ["number", "1"],
      ["word", "abc"],
    ]);
  });

  test("Unicode letters count as letters, also beyond the basic plane", () => {
    expect(only("çğışöü").kind).toBe("word");
    expect(only("𝒜b").text).toBe("𝒜b");
  });
});

describe("backtick identifiers", () => {
  test("a doubled backtick is one literal backtick", () => {
    expect(only("````").value).toBe("`");
    expect(only("`a````b`").value).toBe("a``b");
  });

  test("an empty pair is an empty name", () => {
    expect(pairs("`` x")).toEqual([
      ["backtick", "``"],
      ["word", "x"],
    ]);
  });

  test("a backtick identifier may span lines", () => {
    const token = only("`a\nb`");
    expect(token).toEqual({ kind: "backtick", text: "`a\nb`", value: "a\nb", start: 0, end: 5 });
  });
});

describe("strings", () => {
  test("each escape decodes", () => {
    const [, single, , double] = significant(
      CYPHER_CORPUS.find((entry) => entry.name === "strings with each escape")!.text,
    );
    expect(single.value).toBe("a\\b'c\"d\ne\rf\tg\bh\fiçj😀k");
    expect(double.value).toBe("x\"y'z");
    expect(only('"plain"').value).toBe("plain");
  });

  test("an escape lexCypher does not know is an invalid-escape at its backslash", () => {
    for (const [text, position] of [
      [String.raw`RETURN 'a\qb'`, 9],
      [String.raw`RETURN "\x"`, 8],
      [String.raw`'\u12'`, 1],
      [String.raw`'\u12G4'`, 1],
      [String.raw`'\U0011FFFF'`, 1],
      [String.raw`'\U0001F60'`, 1],
    ] as const) {
      const error = lexErrorOf(text);
      expect(error.reason).toBe("invalid-escape");
      expect(error.position).toBe(position);
      expect(error.name).toBe("CypherLexError");
      expect(error.message).toContain(String(position));
    }
  });

  test("the line tokenizer never throws on an invalid escape and still closes the string at the quote", () => {
    const { tokens, state } = tokenizeCypherLine(String.raw`RETURN 'a\qb', 1`, CYPHER_INITIAL_STATE);
    expect(state).toEqual({ in: "code" });
    const string = tokens.find((token) => token.kind === "string")!;
    expect(string.text).toBe(String.raw`'a\qb'`);
    expect(string.value).toBe(String.raw`a\qb`);
    expect(tokenizeCypherLine(String.raw`'\u12'`, CYPHER_INITIAL_STATE).tokens[0].value).toBe(String.raw`\u12`);
  });

  test("an escaped quote does not close the string", () => {
    expect(only(String.raw`'a\'b'`).value).toBe("a'b");
    expect(only(String.raw`"a\"b"`).value).toBe('a"b');
    expect(only(`"it's"`).value).toBe("it's");
  });

  test("a string may span lines and keeps the newline in its value", () => {
    const token = only("'a\nb'");
    expect(token).toEqual({ kind: "string", text: "'a\nb'", value: "a\nb", start: 0, end: 5 });
  });

  test("a backslash at the end of a line is an invalid escape of the newline", () => {
    const error = lexErrorOf("'a\\\n'");
    expect(error.reason).toBe("invalid-escape");
    expect(error.position).toBe(2);
    const { tokens, state } = tokenizeCypherLine("'a\\", CYPHER_INITIAL_STATE);
    expect(tokens[0].text).toBe("'a\\");
    expect(state).toEqual({ in: "string", quote: "'" });
  });
});

describe("comments", () => {
  test("a line comment runs to the end of the line, not including the newline", () => {
    expect(lexCypher("// x\n1").map((token) => [token.kind, token.text])).toEqual([
      ["comment", "// x"],
      ["whitespace", "\n"],
      ["number", "1"],
    ]);
  });

  test("a block comment may span lines and does not nest", () => {
    expect(only("/* a\n\nb */").text).toBe("/* a\n\nb */");
    expect(pairs("/**/1")).toEqual([
      ["comment", "/**/"],
      ["number", "1"],
    ]);
  });
});

describe("numbers", () => {
  test("integers, decimals, exponents, hex and octal", () => {
    for (const text of ["123", "1.5", ".5", "1e10", "1.5E-3", "2e+4", ".5e3", "0x1F", "0o17"]) {
      expect(only(text)).toEqual({ kind: "number", text, value: text, start: 0, end: text.length });
    }
  });

  test("a minus sign is punctuation, and a dot without a digit after it is not part of the number", () => {
    expect(pairs("-1")).toEqual([
      ["punct", "-"],
      ["number", "1"],
    ]);
    expect(pairs("1.x")).toEqual([
      ["number", "1"],
      ["punct", "."],
      ["word", "x"],
    ]);
    expect(pairs("1e")).toEqual([
      ["number", "1"],
      ["word", "e"],
    ]);
  });
});

describe("parameters", () => {
  test("plain, numbered and backticked", () => {
    expect(only("$_p1")).toEqual({ kind: "parameter", text: "$_p1", value: "_p1", start: 0, end: 4 });
    expect(only("$`a``b`").value).toBe("a`b");
  });

  test("a backticked parameter may span lines", () => {
    expect(only("$`a\nb`")).toEqual({ kind: "parameter", text: "$`a\nb`", value: "a\nb", start: 0, end: 6 });
  });

  test("a dollar sign alone is an unexpected character", () => {
    const error = lexErrorOf("RETURN $ 1");
    expect(error.reason).toBe("unexpected-character");
    expect(error.position).toBe(7);
  });
});

describe("punctuation", () => {
  test("two-character punctuation is matched first", () => {
    expect(pairs("<> <= >= =~ -> <- .. += <--").map(([, text]) => text)).toEqual([
      "<>",
      "<=",
      ">=",
      "=~",
      "->",
      "<-",
      "..",
      "+=",
      "<-",
      "-",
    ]);
  });

  test("every single character", () => {
    const characters = [..."()[]{},.:;=<>+-*/%^|!?"];
    expect(pairs(characters.join(" "))).toEqual(characters.map((character) => ["punct", character]));
  });

  test("any other character is unexpected in lexCypher and a one-character punct in the line tokenizer", () => {
    for (const [text, position] of [
      ["RETURN 1 @", 9],
      ["#", 0],
      ["a ~ b", 2],
      ["\\", 0],
    ] as const) {
      const error = lexErrorOf(text);
      expect(error.reason).toBe("unexpected-character");
      expect(error.position).toBe(position);
    }
    expect(tokenizeCypherLine("a@", CYPHER_INITIAL_STATE).tokens[1]).toEqual({
      kind: "punct",
      text: "@",
      value: "@",
      start: 1,
      end: 2,
    });
  });

  test("an unexpected character outside the basic plane is one token of two code units", () => {
    const [token] = tokenizeCypherLine("😀", CYPHER_INITIAL_STATE).tokens;
    expect(token).toEqual({ kind: "punct", text: "😀", value: "😀", start: 0, end: 2 });
    expect(lexErrorOf("1 😀").position).toBe(2);
  });
});

describe("unterminated constructs at the end of the text", () => {
  test("each carries its reason and the position where it starts", () => {
    for (const [text, reason, position] of [
      ["RETURN 'abc", "unterminated-string", 7],
      ['RETURN "a\nb', "unterminated-string", 7],
      ["MATCH (n) /* x", "unterminated-comment", 10],
      ["/* a\n\n", "unterminated-comment", 0],
      ["MATCH (n:`L", "unterminated-backtick", 9],
      ["RETURN $`p\nq", "unterminated-backtick", 7],
    ] as const) {
      const error = lexErrorOf(text);
      expect(error.reason).toBe(reason);
      expect(error.position).toBe(position);
    }
  });
});

describe("tokenizeCypherLine", () => {
  test("token spans are offset-based, and the offset defaults to zero", () => {
    expect(
      tokenizeCypherLine("RETURN 1", CYPHER_INITIAL_STATE, 100).tokens.map((token) => [token.start, token.end]),
    ).toEqual([
      [100, 106],
      [106, 107],
      [107, 108],
    ]);
    expect(tokenizeCypherLine("x", CYPHER_INITIAL_STATE).tokens[0].start).toBe(0);
  });

  test("an empty line gives no token and keeps its state", () => {
    expect(tokenizeCypherLine("", CYPHER_INITIAL_STATE)).toEqual({ tokens: [], state: { in: "code" } });
    expect(tokenizeCypherLine("", { in: "block-comment" })).toEqual({ tokens: [], state: { in: "block-comment" } });
  });

  test("the state carries across a block comment", () => {
    const { tokens, states } = byLines("MATCH /* a\nCREATE\nb */ RETURN 1");
    expect(states).toEqual([{ in: "block-comment" }, { in: "block-comment" }, { in: "code" }]);
    expect(tokens.filter((token) => token.kind === "comment").map((token) => token.text)).toEqual([
      "/* a",
      "CREATE",
      "b */",
    ]);
    expect(tokens.some((token) => token.kind === "word" && token.value === "CREATE")).toBe(false);
  });

  test("the state carries across a string, and a continuation's value holds only its own text", () => {
    const { tokens, states } = byLines("RETURN 'a\n;\nb' AS x");
    expect(states).toEqual([{ in: "string", quote: "'" }, { in: "string", quote: "'" }, { in: "code" }]);
    expect(tokens.filter((token) => token.kind === "string").map((token) => [token.text, token.value])).toEqual([
      ["'a", "a"],
      [";", ";"],
      ["b'", "b"],
    ]);
    expect(byLines('"a\nb"').states[0]).toEqual({ in: "string", quote: '"' });
    expect(tokenizeCypherLine("'", { in: "string", quote: '"' }).tokens[0].value).toBe("'");
  });

  test("the state carries across a backtick", () => {
    const { tokens, states } = byLines("MATCH (n:`a\nb``c`) RETURN n");
    expect(states).toEqual([{ in: "backtick" }, { in: "code" }]);
    expect(tokens.filter((token) => token.kind === "backtick").map((token) => [token.text, token.value])).toEqual([
      ["`a", "a"],
      ["b``c`", "b`c"],
    ]);
    expect(tokenizeCypherLine("x``", { in: "backtick" })).toEqual({
      tokens: [{ kind: "backtick", text: "x``", value: "x`", start: 0, end: 3 }],
      state: { in: "backtick" },
    });
  });

  test("a construct that closes can be followed by one that opens on the same line", () => {
    const text = "/* a\nb */ 'c\nd'";
    expect(byLines(text).states).toEqual([{ in: "block-comment" }, { in: "string", quote: "'" }, { in: "code" }]);
    expect(pairs(text)).toEqual([
      ["comment", "/* a\nb */"],
      ["string", "'c\nd'"],
    ]);
  });

  test("lexCypher's offsets agree with the joined line tokens", () => {
    for (const text of [
      ...CYPHER_CORPUS.map((entry) => entry.text),
      "MATCH /* a\n\nCREATE\nb */ RETURN '1\n2', `x\ny`, $`p\nq`\r\nRETURN 1",
    ]) {
      const whole = lexCypher(text);
      const { tokens: lines } = byLines(text);
      // Each whole token but a newline is its line tokens joined by the newlines between them.
      let covered = 0;
      for (const token of whole) {
        if (token.text === "\n") continue;
        const inside = lines.filter((part) => part.start >= token.start && part.end <= token.end);
        expect(inside[0].start).toBe(token.start);
        expect(inside[inside.length - 1].end).toBe(token.end);
        let rest = token.text;
        for (const part of inside.toReversed()) {
          expect(text.slice(part.start, part.end)).toBe(part.text);
          rest = rest.slice(0, part.start - token.start) + rest.slice(part.end - token.start);
        }
        expect(rest).toMatch(/^\n*$/);
        covered += inside.length;
      }
      expect(covered).toBe(lines.length);
      expect(whole.map((token) => token.text).join("")).toBe(text);
    }
  });

  test("a newline in code is a whitespace token, and a carriage return stays whitespace", () => {
    expect(lexCypher("1\r\n2").map((token) => [token.kind, token.text])).toEqual([
      ["number", "1"],
      ["whitespace", "\r"],
      ["whitespace", "\n"],
      ["number", "2"],
    ]);
    expect(lexCypher("")).toEqual([]);
  });
});

describe("CYPHER_KEYWORDS", () => {
  test("holds the Cypher 5 clause and operator keywords, uppercased", () => {
    const expected =
      "MATCH OPTIONAL WHERE RETURN WITH UNWIND ORDER BY SKIP LIMIT OFFSET ASC ASCENDING DESC DESCENDING DISTINCT AS AND OR XOR NOT IN IS NULL TRUE FALSE CASE WHEN THEN ELSE END CALL YIELD UNION ALL EXISTS COUNT SHOW CREATE MERGE SET DELETE DETACH REMOVE DROP FOREACH LOAD CSV FROM HEADERS FIELDTERMINATOR USE ON INDEX INDEXES CONSTRAINT CONSTRAINTS DATABASE DATABASES PROCEDURES FUNCTIONS TRANSACTIONS TERMINATE EXPLAIN PROFILE CYPHER STARTS ENDS CONTAINS".split(
        " ",
      );
    for (const keyword of expected) expect(CYPHER_KEYWORDS.has(keyword)).toBe(true);
    for (const keyword of CYPHER_KEYWORDS) expect(keyword).toBe(keyword.toUpperCase());
  });
});
