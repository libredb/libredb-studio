/**
 * The Firestore console lexer: tokens and their offsets, strings with JavaScript escapes, decimal numbers, the
 * bounds of spec S11 at exactly each limit, and the position every refusal names.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  describePosition,
  firestoreQueryError,
  LEXER_SENTENCES,
  lex,
} from "@/lib/db/providers/document/firestore/console/lexer";
import { FIRESTORE_TYPE, LIMITS } from "@/lib/db/providers/document/firestore/constants";
import { refusal } from "../../../helpers/firestore-console";

const kinds = (text: string): [string, string][] => lex(text).map((token) => [token.kind, token.text]);
const strings = (text: string): (string | undefined)[] =>
  lex(text)
    .filter((token) => token.kind === "string")
    .map((token) => token.value);
const refusedWith = (text: string, sentence: string, position: number): void => {
  const error = refusal(() => lex(text));
  expect(error.message.startsWith(sentence)).toBe(true);
  expect(error.position).toBe(position);
};

describe("the bounds of spec S11", () => {
  test("the limits the sentences quote", () => {
    expect([LIMITS.maxConsoleBytes, LIMITS.maxConsoleDepth, LIMITS.maxConsoleTokens]).toEqual([65_536, 32, 10_000]);
  });

  test("exactly 64 KiB of UTF-8 is read and one byte more is refused", () => {
    const ascii = `db${" ".repeat(65_534)}`;
    expect(lex(ascii)).toHaveLength(2);
    refusedWith(`${ascii} `, LEXER_SENTENCES.tooLong, 0);
    const wide = `//${"é".repeat(32_767)}`;
    expect(lex(wide)).toHaveLength(1);
    refusedWith(`${wide}x`, LEXER_SENTENCES.tooLong, 0);
  });

  test("exactly 10,000 tokens are read and the next one is refused at its offset", () => {
    expect(lex("a,".repeat(5_000))).toHaveLength(10_001);
    refusedWith(`${"a,".repeat(5_000)}a`, LEXER_SENTENCES.tooManyTokens, 10_000);
  });

  test("brackets nest 32 deep and the 33rd opener is refused", () => {
    expect(lex(`${"(".repeat(32)}${")".repeat(32)}`)).toHaveLength(65);
    expect(lex("()".repeat(100))).toHaveLength(201);
    refusedWith("[{(".repeat(11), LEXER_SENTENCES.tooDeep, 32);
    refusedWith(`${")".repeat(5)}${"(".repeat(33)}`, LEXER_SENTENCES.tooDeep, 37);
  });
});

describe("tokens", () => {
  test("a chain reads as identifiers, strings, numbers and punctuation", () => {
    expect(kinds(`db.collection("users").limit(5)`)).toEqual([
      ["identifier", "db"],
      ["punctuation", "."],
      ["identifier", "collection"],
      ["punctuation", "("],
      ["string", '"users"'],
      ["punctuation", ")"],
      ["punctuation", "."],
      ["identifier", "limit"],
      ["punctuation", "("],
      ["number", "5"],
      ["punctuation", ")"],
      ["eof", ""],
    ]);
  });

  test("offsets count UTF-16 code units and the eof token sits at the end", () => {
    const [db, dot] = lex("  db .");
    expect([db.start, db.end, dot.start, dot.end]).toEqual([2, 4, 5, 6]);
    expect(lex("db").at(-1)).toEqual({ kind: "eof", text: "", start: 2, end: 2 });
  });

  test("whitespace, a no-break space and both comment forms are skipped", () => {
    expect(kinds("db // c\n/* x\n y */ .\u00a0\ufeffx")).toEqual([
      ["identifier", "db"],
      ["punctuation", "."],
      ["identifier", "x"],
      ["eof", ""],
    ]);
  });

  test("every ASCII symbol is punctuation, so the parser can name a near miss", () => {
    expect(kinds("=>!#@").map(([kind]) => kind)).toEqual(Array(5).fill("punctuation").concat("eof"));
  });

  test("identifiers are ASCII and any other character outside a string is refused", () => {
    refusedWith("db.café", LEXER_SENTENCES.nonAscii, 6);
    refusedWith("db\u0001", LEXER_SENTENCES.badCharacter, 2);
  });
});

describe("strings", () => {
  test("single, double and backtick quotes take JavaScript escapes", () => {
    expect(
      strings(String.raw`"a\n\t\\\"\x41\u0042\u{20000}\q" 'it\'s' "line\
join" '\0'`),
    ).toEqual(['a\n\t\\"AB𠀀q', "it's", "linejoin", "\0"]);
    expect(strings("`a\r\nb` `x\\${y`")).toEqual(["a\nb", "x${y"]);
  });

  test("a ${ placeholder is refused where it starts", () => {
    refusedWith("db.collection(`users/${uid}`)", LEXER_SENTENCES.placeholder, 21);
  });

  test("an unterminated string, a raw newline and a bad escape are refused", () => {
    refusedWith('"abc', LEXER_SENTENCES.unterminatedString, 0);
    refusedWith('"a\nb"', LEXER_SENTENCES.newlineInString, 2);
    refusedWith(String.raw`"\1"`, LEXER_SENTENCES.badEscape, 1);
    refusedWith(String.raw`"\01"`, LEXER_SENTENCES.badEscape, 1);
    refusedWith(String.raw`"\x4"`, LEXER_SENTENCES.badEscape, 1);
    refusedWith(String.raw`"\u12"`, LEXER_SENTENCES.badEscape, 1);
    refusedWith(String.raw`"\u{110000}"`, LEXER_SENTENCES.badEscape, 1);
    refusedWith('"\\', LEXER_SENTENCES.badEscape, 1);
  });

  test("an unterminated comment is refused where it opens", () => {
    refusedWith("db /* x", LEXER_SENTENCES.unterminatedComment, 3);
  });
});

describe("numbers", () => {
  test("decimal digits, a fraction and an exponent make one number token", () => {
    expect(kinds("0 0.5 12e3 1E-2 7.25e+10").filter(([kind]) => kind === "number")).toHaveLength(5);
    expect(kinds("-5").slice(0, 2)).toEqual([
      ["punctuation", "-"],
      ["number", "5"],
    ]);
    expect(kinds("1.5.2").slice(0, 3)).toEqual([
      ["number", "1.5"],
      ["punctuation", "."],
      ["number", "2"],
    ]);
  });

  test("a leading zero, a bare exponent and a trailing letter are refused", () => {
    refusedWith("007", LEXER_SENTENCES.leadingZero, 0);
    refusedWith("x(1e)", LEXER_SENTENCES.badNumber, 2);
    refusedWith("1x", LEXER_SENTENCES.badNumber, 0);
    refusedWith("0x10", LEXER_SENTENCES.badNumber, 0);
  });
});

describe("positions", () => {
  test("line and column are 1-based and follow LF, CRLF and CR", () => {
    expect(describePosition("db\n  .collection(x)", 17)).toBe('line 2, column 15: "x)"');
    expect(describePosition("a\r\nb", 3)).toBe('line 2, column 1: "b"');
    expect(describePosition("a\rb", 2)).toBe('line 2, column 1: "b"');
  });

  test("the excerpt stops at the line end, at 20 code units, and never splits a surrogate pair", () => {
    expect(describePosition("db", 2)).toBe("line 1, column 3: end of text");
    expect(describePosition("ab\ncd", 2)).toBe("line 1, column 3: end of line");
    expect(describePosition("x".repeat(30), 0)).toBe(`line 1, column 1: "${"x".repeat(20)}..."`);
    expect(describePosition(`a${"𠀀".repeat(15)}`, 0)).toBe(`line 1, column 1: "a${"𠀀".repeat(9)}..."`);
  });

  test("firestoreQueryError carries the sentence, the position and the provider", () => {
    const error = firestoreQueryError("db.x", 3, "Some sentence");
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe('Some sentence (line 1, column 4: "x")');
    expect(error.position).toBe(3);
    expect(error.provider).toBe(FIRESTORE_TYPE);
    expect(firestoreQueryError("db", 99, "S").position).toBe(2);
  });
});
