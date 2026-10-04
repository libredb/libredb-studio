/**
 * The InfluxQL lexer, read as the influxql v1.4.1 scanner reads text (SPEC 5.3, E1, R13).
 *
 * On 1.x and 2.x the read policy is the only boundary before `DROP DATABASE`, and the policy sees
 * a text only through these tokens, so every case here pins one place where a plausible lexer and
 * the server's scanner part ways: a lone `\r` ending a `--` comment, a `\\` in a regex, a `/`
 * after `::field`, a NUL. The keyword list is pinned to `token.go` as captured at the tag
 * (`tests/fixtures/influxdb/influxql-v1.4.1-keywords.json`), so a list that drifts fails here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  foldAscii,
  INFLUXQL_KEYWORDS,
  INITIAL_INFLUXQL_LINE_STATE,
  type InfluxqlLexFault,
  type InfluxqlLineState,
  type InfluxqlToken,
  type InfluxqlTokenKind,
  lexInfluxql,
  normaliseInfluxqlNewlines,
  tokenizeInfluxqlLine,
} from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";

const KEYWORD_FIXTURE = path.resolve(import.meta.dir, "../../../fixtures/influxdb/influxql-v1.4.1-keywords.json");

interface KeywordFixture {
  readonly keywords: readonly string[];
  readonly comparedWith: { readonly addedInV141: readonly string[]; readonly removedInV141: readonly string[] };
}

/** Lexes the normalised text, as the policy does. */
function lex(text: string): readonly InfluxqlToken[] {
  return lexInfluxql(normaliseInfluxqlNewlines(text));
}

/** `kind:slice` for every token, faults as `invalid(fault):slice`. */
function shape(text: string, significantOnly = true): string[] {
  const normalised = normaliseInfluxqlNewlines(text);
  return lexInfluxql(normalised)
    .filter((token) => !significantOnly || !["whitespace", "line-comment", "block-comment"].includes(token.kind))
    .map((token) => {
      const kind = token.fault ? `invalid(${token.fault})` : token.kind;
      return `${kind}:${normalised.slice(token.start, token.end)}`;
    });
}

/** The fault of the first invalid token, or undefined. */
function firstFault(text: string): InfluxqlLexFault | undefined {
  return lex(text).find((token) => token.kind === "invalid")?.fault;
}

describe("normalisation", () => {
  test("\\r\\n and a lone \\r both become \\n, and nothing else changes", () => {
    expect(normaliseInfluxqlNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normaliseInfluxqlNewlines("\r\r\n\n")).toBe("\n\n\n");
    expect(normaliseInfluxqlNewlines("plain")).toBe("plain");
  });

  test("offsets are into the normalised text", () => {
    const tokens = lex("a\r\nb");
    expect(tokens.map((token) => [token.kind, token.start, token.end])).toEqual([
      ["identifier", 0, 1],
      ["whitespace", 1, 2],
      ["identifier", 2, 3],
    ]);
  });

  test("a lone \\r ends a -- comment (B1)", () => {
    expect(shape("SELECT count(temp) FROM home -- c\r; SHOW DATABASES", false)).toEqual([
      "keyword:SELECT",
      "whitespace: ",
      "identifier:count",
      "punctuation:(",
      "identifier:temp",
      "punctuation:)",
      "whitespace: ",
      "keyword:FROM",
      "whitespace: ",
      "identifier:home",
      "whitespace: ",
      "line-comment:-- c",
      "whitespace:\n",
      "semicolon:;",
      "whitespace: ",
      "keyword:SHOW",
      "whitespace: ",
      "keyword:DATABASES",
    ]);
  });
});

describe("one case per lexer rule", () => {
  test("space, tab and \\n are one whitespace token", () => {
    expect(shape(" \t\n a", false)).toEqual(["whitespace: \t\n ", "identifier:a"]);
  });

  test("-- is a line comment to the next \\n, or to the end", () => {
    expect(shape("a -- x / 'y\nb", false)).toEqual([
      "identifier:a",
      "whitespace: ",
      "line-comment:-- x / 'y",
      "whitespace:\n",
      "identifier:b",
    ]);
    expect(shape("a --", false)).toEqual(["identifier:a", "whitespace: ", "line-comment:--"]);
    // A single `-` is the operator.
    expect(shape("a - b")).toEqual(["identifier:a", "operator:-", "identifier:b"]);
  });

  test("a / in a regex place is a regex, scanned to the next unescaped /", () => {
    expect(shape("SELECT * FROM /cpu.*/")).toEqual(["keyword:SELECT", "operator:*", "keyword:FROM", "regex:/cpu.*/"]);
    const regex = lex("FROM /a/").find((token) => token.kind === "regex");
    expect(regex).toEqual({ kind: "regex", start: 5, end: 8 });
  });

  test("/* opens a block comment in every position, a regex place too (R32)", () => {
    // At the parser's true regex places (after SELECT, FROM) the server reads `/* x */` as a regex
    // whose body `* x *` never compiles, so it fails the whole request; reading a comment changes nothing.
    expect(shape("SELECT /* x */ count(temp) FROM /* y */ home", false)).toEqual([
      "keyword:SELECT",
      "whitespace: ",
      "block-comment:/* x */",
      "whitespace: ",
      "identifier:count",
      "punctuation:(",
      "identifier:temp",
      "punctuation:)",
      "whitespace: ",
      "keyword:FROM",
      "whitespace: ",
      "block-comment:/* y */",
      "whitespace: ",
      "identifier:home",
    ]);
    for (const before of ["WHERE", "AND", "OR", "LIMIT", "=", "<", "+", "(", ",", "=~"]) {
      expect([before, shape(`a ${before} /* c */ 1`, false)]).toEqual([
        before,
        expect.arrayContaining(["block-comment:/* c */"]),
      ]);
    }
    // A lone / in a regex place still opens a regex.
    expect(shape("SELECT a FROM m WHERE b = /x/")).toContain("regex:/x/");
  });

  test("a regex body cannot start with *: the old regex reading of /* is gone", () => {
    expect(shape("SELECT /* x */ count(temp) FROM home")).toEqual([
      "keyword:SELECT",
      "identifier:count",
      "punctuation:(",
      "identifier:temp",
      "punctuation:)",
      "keyword:FROM",
      "identifier:home",
    ]);
  });

  test("/* after an operand end opens a block comment, which does not nest", () => {
    expect(shape("SELECT count(temp) /* x */ FROM home -- y", false)).toContain("block-comment:/* x */");
    expect(shape("a /* /* b */ c", false)).toEqual([
      "identifier:a",
      "whitespace: ",
      "block-comment:/* /* b */",
      "whitespace: ",
      "identifier:c",
    ]);
    expect(shape("a /**/ b", false)).toContain("block-comment:/**/");
    expect(shape("a /***/ b", false)).toContain("block-comment:/***/");
  });

  test("/* at the text's start and right after ; is a comment; a lone / there is an operator", () => {
    expect(shape("/* c */ SELECT 1", false)).toEqual([
      "block-comment:/* c */",
      "whitespace: ",
      "keyword:SELECT",
      "whitespace: ",
      "number:1",
    ]);
    expect(shape("SELECT 1;/* c */", false)).toEqual([
      "keyword:SELECT",
      "whitespace: ",
      "number:1",
      "semicolon:;",
      "block-comment:/* c */",
    ]);
    expect(shape("/ 2")).toEqual(["operator:/", "number:2"]);
    expect(shape("SELECT 1; / 2")).toEqual(["keyword:SELECT", "number:1", "semicolon:;", "operator:/", "number:2"]);
  });

  test("/ after an operand end is division (kiro F5)", () => {
    expect(shape("1/2")).toEqual(["number:1", "operator:/", "number:2"]);
    expect(shape("1 / 2")).toEqual(["number:1", "operator:/", "number:2"]);
    expect(shape("x /* c */ / 2", false)).toEqual([
      "identifier:x",
      "whitespace: ",
      "block-comment:/* c */",
      "whitespace: ",
      "operator:/",
      "whitespace: ",
      "number:2",
    ]);
  });

  test("a regex after FROM, after =~ and !~, and after WITH MEASUREMENT = (kiro F5, R13)", () => {
    expect(shape("SELECT a FROM /m/")).toContain("regex:/m/");
    expect(shape("WHERE a =~ /x/")).toContain("regex:/x/");
    expect(shape("WHERE a !~ /x/")).toContain("regex:/x/");
    expect(shape('SHOW MEASUREMENTS ON "db" WITH MEASUREMENT = /cpu.*/')).toEqual([
      "keyword:SHOW",
      "keyword:MEASUREMENTS",
      "keyword:ON",
      'quoted-identifier:"db"',
      "keyword:WITH",
      "keyword:MEASUREMENT",
      "operator:=",
      "regex:/cpu.*/",
    ]);
  });

  test("a regex after ( , . and every operator but *", () => {
    expect(shape("f(/a/, /b/)")).toEqual([
      "identifier:f",
      "punctuation:(",
      "regex:/a/",
      "punctuation:,",
      "regex:/b/",
      "punctuation:)",
    ]);
    expect(shape('"db"."rp"./m/')).toContain("regex:/m/");
    expect(shape("a + /b/")).toContain("regex:/b/");
  });

  test("::field then / is division (B3): any word directly after :: ends an operand", () => {
    expect(
      shape("SELECT temp::field / 2 FROM home LIMIT 1; SHOW DATABASES; SELECT temp::field / 2 FROM home LIMIT 1"),
    ).toEqual([
      "keyword:SELECT",
      "identifier:temp",
      "operator:::",
      "keyword:field",
      "operator:/",
      "number:2",
      "keyword:FROM",
      "identifier:home",
      "keyword:LIMIT",
      "number:1",
      "semicolon:;",
      "keyword:SHOW",
      "keyword:DATABASES",
      "semicolon:;",
      "keyword:SELECT",
      "identifier:temp",
      "operator:::",
      "keyword:field",
      "operator:/",
      "number:2",
      "keyword:FROM",
      "identifier:home",
      "keyword:LIMIT",
      "number:1",
    ]);
    expect(shape("x::tag / 2")).toContain("operator:/");
    expect(shape("x::float / 2")).toContain("operator:/");
  });

  test("a word is directly after :: only when nothing separates them, as the parser reads the cast", () => {
    // parser.go:2588-2589 reads the type with `p.Scan()`, which returns whitespace, so `:: field`
    // is a parse error on the server; here FIELD is an ordinary keyword and the `/` a regex place.
    expect(shape("x:: field /a/")).toEqual(["identifier:x", "operator:::", "keyword:field", "regex:/a/"]);
    expect(shape("x::/* c */field /a/")).toEqual(["identifier:x", "operator:::", "keyword:field", "regex:/a/"]);
  });

  test("' is a string with exactly the escapes \\n \\\\ \\\" \\', its value unescaped", () => {
    const [token] = lex("'a\\nb\\\\c\\\"d\\'e'");
    expect(token).toEqual({ kind: "string", start: 0, end: 15, value: "a\nb\\c\"d'e" });
    expect(firstFault("'a\\tb'")).toBe("bad-escape");
    expect(firstFault("'a\nb'")).toBe("newline-in-string");
    expect(firstFault("'ab")).toBe("unterminated-string");
  });

  test('" is a quoted identifier with the same escapes and faults, never a keyword', () => {
    const [token] = lex('"select"');
    expect(token).toEqual({ kind: "quoted-identifier", start: 0, end: 8, value: "select" });
    expect(lex('"we\\"ird name;x"')[0]).toEqual({
      kind: "quoted-identifier",
      start: 0,
      end: 16,
      value: 'we"ird name;x',
    });
    expect(firstFault('"a\\qb"')).toBe("bad-escape");
    expect(firstFault('"a\nb"')).toBe("newline-in-identifier");
    expect(firstFault('"ab')).toBe("unterminated-identifier");
  });

  test("an ASCII word is a keyword when its ASCII fold is in INFLUXQL_KEYWORDS, else an identifier", () => {
    expect(lex("sElEcT")[0]).toEqual({ kind: "keyword", start: 0, end: 6, value: "SELECT" });
    expect(lex("_temp_2")[0]).toEqual({ kind: "identifier", start: 0, end: 7, value: "_temp_2" });
    expect(lex("Into")[0]?.value).toBe("INTO");
    expect(lex("and")[0]?.value).toBe("AND");
    expect(lex("true")[0]?.value).toBe("TRUE");
  });

  test("a number, a decimal, and a number with a duration unit", () => {
    expect(shape("12 1.5 .5 10ns 3u 4ms 5s 6m 7h 8d 9w")).toEqual([
      "number:12",
      "number:1.5",
      "number:.5",
      "duration:10ns",
      "duration:3u",
      "duration:4ms",
      "duration:5s",
      "duration:6m",
      "duration:7h",
      "duration:8d",
      "duration:9w",
    ]);
  });

  test("µ after a number is non-ascii", () => {
    expect(shape("10µs")).toEqual(["number:10", "invalid(non-ascii):µ", "identifier:s"]);
  });

  test("$ then a word is a bound parameter", () => {
    expect(shape("WHERE a = $value")).toEqual([
      "keyword:WHERE",
      "identifier:a",
      "operator:=",
      "bound-parameter:$value",
    ]);
  });

  test("every operator, every punctuation mark and the semicolon", () => {
    expect(shape("=~ !~ != <> <= >= :: = < > + - * % & | ^ :")).toEqual(
      ["=~", "!~", "!=", "<>", "<=", ">=", "::", "=", "<", ">", "+", "-", "*", "%", "&", "|", "^", ":"].map(
        (op) => `operator:${op}`,
      ),
    );
    expect(shape("a(b),c.d;")).toEqual([
      "identifier:a",
      "punctuation:(",
      "identifier:b",
      "punctuation:)",
      "punctuation:,",
      "identifier:c",
      "punctuation:.",
      "identifier:d",
      "semicolon:;",
    ]);
  });

  test("every printable ASCII character the scanner has no token for is illegal-character", () => {
    for (const ch of ["{", "}", "[", "]", "?", "@", "#", "`", "\\", "~", "!"]) {
      expect(shape(`a ${ch} b`)).toEqual(["identifier:a", `invalid(illegal-character):${ch}`, "identifier:b"]);
    }
  });

  test("any other character outside a quote, regex or comment is non-ascii, one code point per token", () => {
    expect(shape("a ı b")).toEqual(["identifier:a", "invalid(non-ascii):ı", "identifier:b"]);
    expect(shape("a \u{1F600} b")).toEqual(["identifier:a", "invalid(non-ascii):\u{1F600}", "identifier:b"]);
    expect(shape("a \u0085 b")).toEqual(["identifier:a", "invalid(non-ascii):\u0085", "identifier:b"]);
    // Inside a string, a quoted identifier, a regex or a comment, any non-ASCII text is fine.
    expect(shape("'ı' \"ı\" FROM /ı/ -- ı\n/* ı */")).toEqual([
      "string:'ı'",
      'quoted-identifier:"ı"',
      "keyword:FROM",
      "regex:/ı/",
    ]);
  });

  test("a C0 control other than tab and \\n, or DEL, is control-character anywhere, including inside quotes", () => {
    expect(shape("a \u0001 b")).toEqual(["identifier:a", "invalid(control-character):\u0001", "identifier:b"]);
    expect(shape("a \u007f b")).toEqual(["identifier:a", "invalid(control-character):\u007f", "identifier:b"]);
    expect(firstFault("'a\u0000b'")).toBe("control-character");
    expect(firstFault('"a\u0000b"')).toBe("control-character");
    expect(firstFault("FROM /a\u0000b/")).toBe("control-character");
    // An unnormalised \r is a control character too: callers normalise first.
    expect(lexInfluxql("a\rb").map((token) => token.fault ?? token.kind)).toEqual([
      "identifier",
      "control-character",
      "identifier",
    ]);
  });

  test("a control character inside a comment is its own invalid token and the comment goes on around it", () => {
    expect(shape("a -- x\u0000y", false)).toEqual([
      "identifier:a",
      "whitespace: ",
      "line-comment:-- x",
      "invalid(control-character):\u0000",
      "line-comment:y",
    ]);
    expect(shape("a /*\u0007*/ b", false)).toEqual([
      "identifier:a",
      "whitespace: ",
      "block-comment:/*",
      "invalid(control-character):\u0007",
      "block-comment:*/",
      "whitespace: ",
      "identifier:b",
    ]);
  });

  test("a faulty string, quoted identifier or regex is one invalid token from its opening character", () => {
    expect(shape("'C:\\temp' x")).toEqual(["invalid(bad-escape):'C:\\temp'", "identifier:x"]);
    // The first fault by position decides.
    expect(firstFault("'\\q\u0000'")).toBe("bad-escape");
    expect(firstFault("'\u0000\\q'")).toBe("control-character");
    expect(firstFault("'\u0000")).toBe("control-character");
    expect(firstFault("'\u0000\nx'")).toBe("control-character");
    expect(firstFault("'a\\")).toBe("bad-escape");
    expect(firstFault("FROM /a\u0000")).toBe("control-character");
    expect(firstFault("FROM /a\u0000\n")).toBe("control-character");
  });
});

describe("the regex body", () => {
  test("\\/ is the only escape; every other backslash is literal and the next character is read again", () => {
    expect(shape("FROM /a\\/b/")).toEqual(["keyword:FROM", "regex:/a\\/b/"]);
    expect(shape("FROM /a\\db/")).toEqual(["keyword:FROM", "regex:/a\\db/"]);
    // `\\` is a literal backslash, then `\/` an escaped slash: the regex goes on (B2).
    expect(shape("FROM /a\\\\/ x/")).toEqual(["keyword:FROM", "regex:/a\\\\/ x/"]);
  });

  test("a \\n inside is newline-in-regex; the end of text is unterminated-regex", () => {
    expect(shape("FROM /a\nb/")).toEqual([
      "keyword:FROM",
      "invalid(newline-in-regex):/a",
      "identifier:b",
      "operator:/",
    ]);
    expect(firstFault("FROM /a")).toBe("unterminated-regex");
    expect(firstFault("FROM /a\\")).toBe("unterminated-regex");
    expect(firstFault("FROM /a\\\nb/")).toBe("newline-in-regex");
  });

  test("an empty regex is a regex", () => {
    expect(shape("FROM //")).toEqual(["keyword:FROM", "regex://"]);
  });
});

describe("faults", () => {
  test("every fault kind, once", () => {
    const cases: ReadonlyArray<readonly [string, InfluxqlLexFault]> = [
      ["\u0001", "control-character"],
      ["é", "non-ascii"],
      ["@", "illegal-character"],
      ["'a", "unterminated-string"],
      ['"a', "unterminated-identifier"],
      ["FROM /a", "unterminated-regex"],
      ["/* a", "unterminated-comment"],
      ["'a\nb", "newline-in-string"],
      ['"a\nb', "newline-in-identifier"],
      ["FROM /a\nb", "newline-in-regex"],
      ["'\\x'", "bad-escape"],
    ];
    for (const [text, fault] of cases) expect([text, firstFault(text)]).toEqual([text, fault]);
  });

  test("lexing goes on after a fault, and the tokens tile the text", () => {
    expect(shape("@ SELECT")).toEqual(["invalid(illegal-character):@", "keyword:SELECT"]);
    expect(shape("a /* never closed")).toEqual(["identifier:a", "invalid(unterminated-comment):/* never closed"]);
  });

  test("never throws, and the tokens tile any text without a gap or an overlap", () => {
    const alphabet = [
      "a",
      "S",
      "1",
      ".",
      "/",
      "*",
      "-",
      "'",
      '"',
      "\\",
      "\n",
      " ",
      ":",
      ";",
      "$",
      "(",
      ")",
      "=",
      "~",
      "!",
      "µ",
      "\u0000",
      "é",
      "_",
      "h",
    ];
    let seed = 0x2f6b;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 2000; round += 1) {
      let text = "";
      const length = next() % 24;
      for (let i = 0; i < length; i += 1) text += alphabet[next() % alphabet.length];
      const tokens = lexInfluxql(text);
      let at = 0;
      for (const token of tokens) {
        expect(token.start).toBe(at);
        expect(token.end).toBeGreaterThan(token.start);
        at = token.end;
      }
      expect(at).toBe(text.length);
    }
  });
});

describe("scanner behaviour the lexer table does not state", () => {
  test('a word directly followed by "..." is one quoted identifier holding the quoted part (scanner.go scanIdent)', () => {
    expect(lex('SELECT"x"')).toEqual([{ kind: "quoted-identifier", start: 0, end: 9, value: "x" }]);
    expect(shape('ab"c"d"e"')).toEqual(['quoted-identifier:ab"c"', 'quoted-identifier:d"e"']);
    expect(shape('"a"b')).toEqual(['quoted-identifier:"a"', "identifier:b"]);
    expect(firstFault('ab"c')).toBe("unterminated-identifier");
  });

  test("digits then letters are one duration token, as scanNumber reads them; a decimal takes no unit", () => {
    expect(shape("10m30s 10abc 10s_x 1.5s")).toEqual([
      "duration:10m30s",
      "duration:10abc",
      "duration:10s",
      "identifier:_x",
      "number:1.5",
      "identifier:s",
    ]);
  });

  test("a number's trailing . is part of the number when no digit follows it (scanNumber)", () => {
    expect(shape("1. 1.x 1..2")).toEqual(["number:1.", "number:1.", "identifier:x", "number:1.", "number:.2"]);
  });

  test('a lone $ and a $"quoted" name are bound parameters (scanIdent(false))', () => {
    expect(shape('$ $"a b" $a"b"')).toEqual(["bound-parameter:$", 'bound-parameter:$"a b"', 'bound-parameter:$a"b"']);
    expect(firstFault('$"a')).toBe("unterminated-identifier");
    expect(firstFault('$"\\q"')).toBe("bad-escape");
  });
});

describe("J1 1.2 bypass shapes, tokenised", () => {
  test("B1: a lone \\r ends the -- comment, so the ; is a token", () => {
    expect(shape("SELECT count(temp) FROM home -- c\r; SHOW DATABASES")).toEqual([
      "keyword:SELECT",
      "identifier:count",
      "punctuation:(",
      "identifier:temp",
      "punctuation:)",
      "keyword:FROM",
      "identifier:home",
      "semicolon:;",
      "keyword:SHOW",
      "keyword:DATABASES",
    ]);
  });

  test("B2: \\\\ inside a regex is a literal backslash, so the regex runs on to the next /", () => {
    expect(shape("SELECT count(temp) FROM /a\\\\/ 'x/; SHOW DATABASES -- '")).toEqual([
      "keyword:SELECT",
      "identifier:count",
      "punctuation:(",
      "identifier:temp",
      "punctuation:)",
      "keyword:FROM",
      "regex:/a\\\\/ 'x/",
      "semicolon:;",
      "keyword:SHOW",
      "keyword:DATABASES",
    ]);
  });

  test("B3: / after ::field is division, so the ; between is a token", () => {
    const semicolons = shape(
      "SELECT temp::field / 2 FROM home LIMIT 1; SHOW DATABASES; SELECT temp::field / 2 FROM home LIMIT 1",
    ).filter((token) => token === "semicolon:;");
    expect(semicolons).toHaveLength(2);
  });

  test("B4: \\\\ inside a string is an escaped backslash, so the string ends at the next '", () => {
    expect(shape("SELECT count(temp) FROM home WHERE room = 'a\\\\'; SHOW DATABASES -- '")).toEqual([
      "keyword:SELECT",
      "identifier:count",
      "punctuation:(",
      "identifier:temp",
      "punctuation:)",
      "keyword:FROM",
      "identifier:home",
      "keyword:WHERE",
      "identifier:room",
      "operator:=",
      "string:'a\\\\'",
      "semicolon:;",
      "keyword:SHOW",
      "keyword:DATABASES",
    ]);
    expect(lex("'a\\\\'")[0]?.value).toBe("a\\");
  });

  test("B5: a NUL is an invalid token and lexing goes on past it", () => {
    expect(shape("SELECT count(temp) FROM home\u0000; SHOW DATABASES")).toEqual([
      "keyword:SELECT",
      "identifier:count",
      "punctuation:(",
      "identifier:temp",
      "punctuation:)",
      "keyword:FROM",
      "identifier:home",
      "invalid(control-character):\u0000",
      "semicolon:;",
      "keyword:SHOW",
      "keyword:DATABASES",
    ]);
  });
});

describe("R32: a /* that the server reads as a comment hides no statement", () => {
  /** The statement keywords right after each semicolon token, as a policy splitting on `;` sees them. */
  function statements(text: string): string[] {
    const tokens = lex(text).filter((token) => !["whitespace", "line-comment", "block-comment"].includes(token.kind));
    const firsts: string[] = [];
    let atStart = true;
    for (const token of tokens) {
      if (token.kind === "semicolon") {
        atStart = true;
        continue;
      }
      if (atStart) firsts.push(token.value ?? token.kind);
      atStart = false;
    }
    return firsts;
  }

  test("the R32 shape after AND reads as two statements, the second a DROP", () => {
    const text = "SELECT x FROM m WHERE x > 1 AND /* a/ ' */ x > 0; DROP DATABASE d -- '";
    expect(shape(text, false)).toContain("block-comment:/* a/ ' */");
    expect(shape(text)).toContain("semicolon:;");
    expect(statements(text)).toEqual(["SELECT", "DROP"]);
  });

  test("its variants after OR, WHERE, =, a , inside a WHERE and ( read as two statements too", () => {
    for (const text of [
      "SELECT x FROM m WHERE x > 1 OR /* a/ ' */ x > 0; DROP DATABASE d -- '",
      "SELECT x FROM m WHERE /* a/ ' */ x > 0; DROP DATABASE d -- '",
      "SELECT x FROM m WHERE x = /* a/ ' */ 1; DROP DATABASE d -- '",
      "SELECT x FROM m WHERE x =~ /a/ AND y IN (1, /* a/ ' */ 2); DROP DATABASE d -- '",
      "SELECT x FROM m WHERE (/* a/ ' */ x > 0); DROP DATABASE d -- '",
      "SELECT x FROM m LIMIT /* a/ ' */ 1; DROP DATABASE d -- '",
    ]) {
      expect([text, statements(text)]).toEqual([text, ["SELECT", "DROP"]]);
    }
  });

  test("the T03 review payload shows the second statement and the third", () => {
    const text = "SELECT v FROM m WHERE a = /* / ' */ 1; DROP DATABASE x; SHOW MEASUREMENTS WITH MEASUREMENT =~ /'/";
    expect(statements(text)).toEqual(["SELECT", "DROP", "SHOW"]);
    expect(shape(text)).toContain("regex:/'/");
  });
});

describe("INFLUXQL_KEYWORDS and foldAscii", () => {
  const fixture = JSON.parse(readFileSync(KEYWORD_FIXTURE, "utf8")) as KeywordFixture;

  test("equals the keywords map of influxql v1.4.1 token.go", () => {
    expect([...INFLUXQL_KEYWORDS].sort()).toEqual([...fixture.keywords]);
    expect(INFLUXQL_KEYWORDS.size).toBe(83);
  });

  test("the only difference from v1.3.0 is FUTURE and PAST, neither a first keyword, INTO nor an operand end", () => {
    expect(fixture.comparedWith.addedInV141).toEqual(["FUTURE", "PAST"]);
    expect(fixture.comparedWith.removedInV141).toEqual([]);
    for (const word of fixture.comparedWith.addedInV141) {
      expect(["SELECT", "SHOW", "EXPLAIN", "INTO", "TRUE", "FALSE"]).not.toContain(word);
    }
  });

  test("foldAscii folds a to z only, never by locale", () => {
    expect(foldAscii("select")).toBe("SELECT");
    expect(foldAscii("Into_9")).toBe("INTO_9");
    expect(foldAscii("ı")).toBe("ı");
    expect(foldAscii("i")).toBe("I");
    expect(foldAscii("ß")).toBe("ß");
  });
});

/** What a / reads as right after the probe: "ends an operand" (division) or "regex place". */
function classify(probe: string): string {
  const tokens = shape(`${probe} /x/ 1`);
  const probeTokens = shape(probe);
  const after = tokens[probeTokens.length];
  if (after === "operator:/") return "ends an operand";
  if (after === "regex:/x/") return "regex place";
  return `third answer: ${after}`;
}

describe("the operand classification (E1, R13)", () => {
  test("every significant token kind ends an operand or is a regex place, with no third answer", () => {
    const table: ReadonlyArray<readonly [InfluxqlTokenKind, string, string]> = [
      ["identifier", "a", "ends an operand"],
      ["quoted-identifier", '"a"', "ends an operand"],
      ["number", "1", "ends an operand"],
      ["duration", "1h", "ends an operand"],
      ["string", "'a'", "ends an operand"],
      ["bound-parameter", "$a", "ends an operand"],
      ["regex", "FROM /a/", "ends an operand"],
      ["punctuation", "f(a)", "ends an operand"],
      ["punctuation", "f(", "regex place"],
      ["punctuation", "f(a,", "regex place"],
      ["punctuation", "a.", "regex place"],
      ["operator", "a *", "ends an operand"],
      ["keyword", "SELECT", "regex place"],
      ["keyword", "TRUE", "ends an operand"],
      ["keyword", "x::field", "ends an operand"],
      // A statement start reads a / as the scanner does, the same answer as an operand end.
      ["semicolon", "SELECT 1;", "ends an operand"],
      // A text with a fault is refused whatever follows; a / after one reads as division.
      ["invalid", "@", "ends an operand"],
    ];
    for (const [kind, probe, answer] of table) {
      const last = lex(probe).at(-1);
      expect([probe, last?.kind]).toEqual([probe, kind]);
      expect([probe, classify(probe)]).toEqual([probe, answer]);
    }
    expect(classify("")).toBe("ends an operand");
  });

  test("every operator but * is a regex place, and :: before a separated word too", () => {
    for (const op of ["=~", "!~", "!=", "<>", "<=", ">=", "::", "=", "<", ">", "+", "-", "%", "&", "|", "^", ":"]) {
      expect([op, classify(`a ${op}`)]).toEqual([op, "regex place"]);
    }
    expect(classify("a *")).toBe("ends an operand");
  });

  test("every keyword of INFLUXQL_KEYWORDS is a regex place except TRUE and FALSE, and every one ends an operand after ::", () => {
    for (const word of INFLUXQL_KEYWORDS) {
      const expected = word === "TRUE" || word === "FALSE" ? "ends an operand" : "regex place";
      expect([word, classify(word)]).toEqual([word, expected]);
      expect([word, classify(`x::${word.toLowerCase()}`)]).toEqual([word, "ends an operand"]);
    }
  });

  test("whitespace and comments are not significant: the answer before them stands", () => {
    for (const filler of [" ", "\n", "-- c\n", "/* c */"]) {
      expect([filler, classify(`a ${filler}`)]).toEqual([filler, "ends an operand"]);
    }
    // After a regex place too: a /* there is a comment (R32).
    for (const filler of [" ", "\n", "-- c\n", "/* c */"]) {
      expect([filler, classify(`= ${filler}`)]).toEqual([filler, "regex place"]);
    }
  });
});

/** Every line's tokens, offset by the line start and joined; and lexInfluxql's, cut at the line ends. */
function compareByLine(text: string): { joined: string[]; whole: string[] } {
  const lines = text.split("\n");
  const joined: string[] = [];
  let state: InfluxqlLineState = INITIAL_INFLUXQL_LINE_STATE;
  let lineStart = 0;
  const lineRanges: Array<readonly [number, number]> = [];
  for (const line of lines) {
    const result = tokenizeInfluxqlLine(line, state);
    for (const token of result.tokens) joined.push(`${token.kind}@${lineStart + token.start}-${lineStart + token.end}`);
    state = result.state;
    lineRanges.push([lineStart, lineStart + line.length]);
    lineStart += line.length + 1;
  }
  const whole: string[] = [];
  for (const token of lexInfluxql(text)) {
    for (const [from, to] of lineRanges) {
      const start = Math.max(token.start, from);
      const end = Math.min(token.end, to);
      if (start < end) whole.push(`${token.kind}@${start}-${end}`);
    }
  }
  return { joined, whole };
}

describe("tokenizeInfluxqlLine", () => {
  const TEXTS = [
    "SELECT a /* spans\nthree\nlines */ FROM home",
    "SELECT a\n/ 2 FROM home",
    "SELECT a FROM\n/m/",
    "SELECT count(temp)\n/* c */ FROM home",
    "x\n/* c */\n/ 2",
    'SHOW MEASUREMENTS ON "db"\nWITH MEASUREMENT =\n/cpu.*/',
    "SELECT 1;\n/* c */ SELECT 2",
    "SELECT 1;\n/ 2",
    "SELECT temp::field\n/ 2",
    "SELECT temp::\nfield /x/",
    "a -- c\n/ 2",
    "= -- c\n/x/",
    "SELECT 'a\nb' FROM home",
    'SELECT "a\nb" FROM home',
    "SELECT a FROM /a\nb/",
    "a /*\n\n*/ / 2",
    "a /* x\u0000\ny\u0001 */ / 2",
    "WHERE t = true\n/ 2",
    "SELECT 'C:\\\nx'",
    "SELECT x FROM m WHERE x = /* a/\n' */ 1; SHOW DATABASES",
    '\n\n  SELECT\t*\n\tFROM   "db".."m"  \n',
  ];

  test("joined across lines, the tokens equal lexInfluxql's in kinds and boundaries (R28 SR1 F9)", () => {
    expect(TEXTS).toHaveLength(21);
    for (const text of TEXTS) {
      const { joined, whole } = compareByLine(text);
      expect([text, joined]).toEqual([text, whole]);
    }
  });

  test("the same holds for generated texts whose block comments close", () => {
    const alphabet = [
      "a",
      "true",
      "1",
      ".",
      "/",
      "*",
      "-",
      "'",
      '"',
      "\\",
      "\n",
      "\n",
      " ",
      ":",
      ";",
      "$",
      ")",
      "(",
      "=",
      "FROM",
      "\u0000",
    ];
    let seed = 0x51ed;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    let compared = 0;
    for (let round = 0; round < 3000; round += 1) {
      let text = "";
      const length = next() % 20;
      for (let i = 0; i < length; i += 1) text += alphabet[next() % alphabet.length];
      if (lexInfluxql(text).some((token) => token.fault === "unterminated-comment")) continue;
      const { joined, whole } = compareByLine(text);
      expect([text, joined]).toEqual([text, whole]);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(1000);
  });

  test("the state carries an open block comment and the last significant token's class", () => {
    expect(INITIAL_INFLUXQL_LINE_STATE).toEqual({ inBlockComment: false, previous: "start" });
    expect(tokenizeInfluxqlLine("SELECT a /* open", INITIAL_INFLUXQL_LINE_STATE).state).toEqual({
      inBlockComment: true,
      previous: "operand",
    });
    expect(tokenizeInfluxqlLine("still open", { inBlockComment: true, previous: "other" })).toEqual({
      tokens: [{ kind: "block-comment", start: 0, end: 10 }],
      state: { inBlockComment: true, previous: "other" },
    });
    expect(tokenizeInfluxqlLine("", { inBlockComment: true, previous: "other" })).toEqual({
      tokens: [],
      state: { inBlockComment: true, previous: "other" },
    });
    expect(
      tokenizeInfluxqlLine("*/ /x/", { inBlockComment: true, previous: "other" }).tokens.map((token) => token.kind),
    ).toEqual(["block-comment", "whitespace", "regex"]);
    expect(tokenizeInfluxqlLine("FROM", INITIAL_INFLUXQL_LINE_STATE).state.previous).toBe("other");
    expect(tokenizeInfluxqlLine("SELECT 1;", INITIAL_INFLUXQL_LINE_STATE).state.previous).toBe("start");
    expect(tokenizeInfluxqlLine("  -- c", { inBlockComment: false, previous: "operand" }).state.previous).toBe(
      "operand",
    );
  });

  test("an open block comment at the end of the text is a block comment line by line, which only the whole text can call unterminated", () => {
    expect(lexInfluxql("a /* x\ny").at(-1)).toEqual({
      kind: "invalid",
      start: 2,
      end: 8,
      fault: "unterminated-comment",
    });
    const first = tokenizeInfluxqlLine("a /* x", INITIAL_INFLUXQL_LINE_STATE);
    expect(first.tokens.at(-1)).toEqual({ kind: "block-comment", start: 2, end: 6 });
    expect(tokenizeInfluxqlLine("y", first.state).tokens).toEqual([{ kind: "block-comment", start: 0, end: 1 }]);
  });

  test("a quoted part cut by a line end is unterminated line by line and newline-in in the whole text, same boundaries", () => {
    expect(lexInfluxql("'a\nb").at(0)).toEqual({ kind: "invalid", start: 0, end: 2, fault: "newline-in-string" });
    expect(tokenizeInfluxqlLine("'a", INITIAL_INFLUXQL_LINE_STATE).tokens).toEqual([
      { kind: "invalid", start: 0, end: 2, fault: "unterminated-string" },
    ]);
    expect(lexInfluxql('"a\nb').at(0)?.fault).toBe("newline-in-identifier");
    expect(tokenizeInfluxqlLine('"a', INITIAL_INFLUXQL_LINE_STATE).tokens.at(0)?.fault).toBe("unterminated-identifier");
  });
});
