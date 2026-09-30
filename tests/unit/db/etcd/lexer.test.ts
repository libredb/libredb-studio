/**
 * The etcd editor text read as words (spec 3.3, 5.1.1, 5.1.2, 5.1.4, 6.4).
 *
 * Every rule of the two word rules is a row here, and every row was measured before it was
 * written: the shell rows against bash 5.2.21, dash and zsh 5.9, the txn rows against etcdctl
 * v3.7.2's own `txn` (the bytes pinned in tests/fixtures/etcd/grammar-corpus.ts). A refusal is
 * pinned with its whole sentence, because the sentence is what the user reads in the editor.
 *
 * The corpus at the end is the one the tokens provider's test reads too, so the editor and the
 * parser are held to the same word boundaries, sections and bytes (R11 ARCH-9).
 */
import { describe, expect, test } from "bun:test";
import {
  INITIAL_LEX_STATE,
  isFlagText,
  type LexState,
  type LexToken,
  type LexTokenKind,
  lexLogicalLine,
  lexStatesEqual,
  quoteGoString,
  quoteTxnWord,
  quoteWord,
  type SplitLine,
  type SplitText,
  splitWords,
  tokenizeLine,
  type Word,
} from "@/lib/db/providers/keyvalue/etcd/lexer";
import { type CorpusWord, GRAMMAR_CORPUS } from "../../../fixtures/etcd/grammar-corpus";

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (digits: string): Uint8Array =>
  new Uint8Array((digits.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

function split(text: string): SplitText {
  const result = splitWords(text);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to read, got: ${result.refusal.message}`);
  return result.split;
}

const commandWords = (text: string): string[] => split(text).command.map((word) => word.text);

function refusalOf(text: string) {
  const result = splitWords(text);
  if (result.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return result.refusal;
}

/** The line a txn body case puts its one interesting line on, read back. */
function bodyLine(text: string, line: number): SplitLine {
  const found = split(text).lines.find((entry) => entry.line === line);
  if (found === undefined) throw new Error(`no line ${line}`);
  return found;
}

/** Reads a whole text through tokenizeLine, as the editor's tokens provider does, line by line. */
function tokenizeAll(text: string): { section: string; tokens: readonly LexToken[]; after: LexState }[] {
  let state = INITIAL_LEX_STATE;
  return text.split(/\r\n|\r|\n/).map((line) => {
    const reading = tokenizeLine(line, state);
    const row = { section: state.section, tokens: reading.tokens, after: reading.state };
    state = reading.state;
    return row;
  });
}

// ============================================================================
// 5.1.1: the command line's word rule
// ============================================================================

/** Each row measured with printf '[%s]' in bash, dash and zsh, which read it the same way. */
const WORD_RULES: readonly [rule: string, text: string, words: readonly string[]][] = [
  ["unquoted spaces and tabs separate words", "get  a\tb", ["get", "a", "b"]],
  [
    "single quotes keep everything literally, up to the next single quote",
    "put k 'a $b `c` \\d \"e\" #f ~g'",
    ["put", "k", 'a $b `c` \\d "e" #f ~g'],
  ],
  ["single quotes carry a newline", "put k 'a\nb'", ["put", "k", "a\nb"]],
  [
    'inside double quotes a backslash escapes only ", \\, $ and a backquote',
    'put k "a\\"b\\\\c\\$d\\`e"',
    ["put", "k", 'a"b\\c$d`e'],
  ],
  ["inside double quotes every other backslash is data", 'put k "a\\qb\\nc\\\'d"', ["put", "k", "a\\qb\\nc\\'d"]],
  ["inside double quotes a backslash-newline is removed", 'put k "a\\\nb"', ["put", "k", "ab"]],
  ["inside double quotes a newline is data", 'put k "a\nb"', ["put", "k", "a\nb"]],
  [
    "outside quotes a backslash escapes the next character",
    "put k a\\ b\\'c\\\"d\\$e\\#f\\~g\\;h",
    ["put", "k", "a b'c\"d$e#f~g;h"],
  ],
  ["outside quotes a backslash-newline joins two lines inside a word", "put k ab\\\ncd", ["put", "k", "abcd"]],
  ["a backslash-newline between words joins nothing", "put \\\nk v", ["put", "k", "v"]],
  ["a backslash-newline before a blank ends the word", "put k ab\\\n cd", ["put", "k", "ab", "cd"]],
  ["a backslash-newline that ends the text is removed", "put k ab\\\n", ["put", "k", "ab"]],
  ["adjacent parts join into one word", "put k 'a'\"b\"c", ["put", "k", "abc"]],
  ["two quotes make the empty word", "put k '' \"\"", ["put", "k", "", ""]],
  ["a single quote inside single quotes, as a shell writes it", "put k 'it'\\''s'", ["put", "k", "it's"]],
  ["a # that begins a word starts a comment to the end of the line", "get a #b c", ["get", "a"]],
  ["a # inside a word is data", "get a#b", ["get", "a#b"]],
  ["a quoted or escaped # is data", "get '#b' \\#c", ["get", "#b", "#c"]],
  ["a backslash in a comment continues nothing", "get a # c \\\n", ["get", "a"]],
  [
    "glob characters are data, as a shell passes them when nothing matches",
    "get /a/* ?x [y]",
    ["get", "/a/*", "?x", "[y]"],
  ],
  ["a $ before a blank, a tab or the end of a word is data", "put k $ a$\tb", ["put", "k", "$", "a$", "b"]],
  [
    "a $ before a closing double quote or a blank inside double quotes is data",
    'put k "a$" "$ b"',
    ["put", "k", "a$", "$ b"],
  ],
  ["a $ at the end of a line inside double quotes is data", 'put k "a$\nb"', ["put", "k", "a$\nb"]],
  ["a ~ inside a word is data", "put k a~b", ["put", "k", "a~b"]],
  ["a ~ not right after the = or a : of a NAME= word is data", "put k a=b~c a=x:y~", ["put", "k", "a=b~c", "a=x:y~"]],
  [
    "a word whose name is quoted or escaped is no NAME= word",
    'put k "a"=~ a\\=~ 1a=~/x',
    ["put", "k", "a=~", "a=~", "1a=~/x"],
  ],
  ["braces without a comma or .. are data", "put k {a} a{b", ["put", "k", "{a}", "a{b"]],
  [
    "escaped or quoted braces and commas are data",
    "put k \\{a,b} {a\\,b} '{a,b}'",
    ["put", "k", "{a,b}", "{a,b}", "{a,b}"],
  ],
  ["JSON with double quotes loses them, as quote removal does in a shell", 'put k {"a":1}', ["put", "k", "{a:1}"]],
  ["a no-break space is data, not a separator", "get a\u00a0b", ["get", "a\u00a0b"]],
  ["a word that begins with - is a word", "get -- -a", ["get", "--", "-a"]],
];

describe("the command line's word rule (spec 5.1.1)", () => {
  test.each(WORD_RULES)("%s", (_rule, text, words) => {
    expect(commandWords(text)).toEqual([...words]);
  });

  test("a word's bytes are its text as UTF-8", () => {
    const [, , value] = split("put k 'é 日本 𝄞'").command;
    expect(hex(value.bytes)).toBe(hex(utf8("é 日本 𝄞")));
  });

  test("an unquoted flag word is tokenized as a flag, and a quoted one as a string", () => {
    expect(tokenizeLine("get --prefix '--x'", INITIAL_LEX_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "flag", start: 4, end: 12 },
      { kind: "whitespace", start: 12, end: 13 },
      { kind: "string", start: 13, end: 18 },
    ]);
  });
});

// ============================================================================
// 5.1.1: text a shell would expand, or refuse, is refused
// ============================================================================

const dollar = (line: number, column: number) =>
  `Studio runs no shell, so it refuses the $ at line ${line}, column ${column}, which a shell may expand: put a backslash before the $, or write the text between single quotes, to keep it as written.`;
const backquote = (line: number, column: number) =>
  `Studio runs no shell, so it refuses the backquote at line ${line}, column ${column}, which a shell reads as a command to run: write the text between single quotes to keep it as written.`;
const tilde = (line: number, column: number) =>
  `Studio runs no shell, so it refuses the ~ that begins the word at line ${line}, column ${column}, which a shell expands to a home directory: write the word between single quotes to keep it as written.`;
const assignmentTilde = (line: number, column: number) =>
  `Studio runs no shell, so it refuses the ~ after the = or a : of the word at line ${line}, column ${column}, which bash expands to a home directory: write the word between single quotes to keep it as written.`;
const braces = (line: number, column: number) =>
  `Studio runs no shell, so it refuses the braces in the word at line ${line}, column ${column}, which bash and zsh expand into several words: write the word between single quotes to keep it as written.`;
const operator = (char: string, line: number, column: number) =>
  `Studio runs one etcdctl command and no shell, so it refuses the ${char} at line ${line}, column ${column}: write the text between single quotes to keep it as written.`;

/**
 * The spec's list (a name, a digit, {, (, @, *, #, ?, -, $ and ! after a $) plus what the
 * measurement found it missed: bash and zsh read $'..' as ANSI-C quoting, bash reads $".." and
 * $[..], zsh reads $=x, $^x, $~x and $+x, bash (outside POSIX mode) expands a ~ after the = or a :
 * of a NAME= word, and bash and zsh expand braces holding a comma or "..".
 */
const SHELL_REFUSALS: readonly [form: string, text: string, code: string, column: number, message: string][] = [
  ["$NAME", "put k $HOME", "shell-expansion", 6, dollar(1, 7)],
  ["$_", "put k $_x", "shell-expansion", 6, dollar(1, 7)],
  ["${", "put k ${x}", "shell-expansion", 6, dollar(1, 7)],
  ["$(", "put k $(ls)", "shell-expansion", 6, dollar(1, 7)],
  ["$1", "put k $1", "shell-expansion", 6, dollar(1, 7)],
  ["$@", "put k $@", "shell-expansion", 6, dollar(1, 7)],
  ["$*", "put k $*", "shell-expansion", 6, dollar(1, 7)],
  ["$#", "put k $#", "shell-expansion", 6, dollar(1, 7)],
  ["$?", "put k $?", "shell-expansion", 6, dollar(1, 7)],
  ["$-", "put k $-", "shell-expansion", 6, dollar(1, 7)],
  ["$$", "put k $$", "shell-expansion", 6, dollar(1, 7)],
  ["$!", "put k $!", "shell-expansion", 6, dollar(1, 7)],
  ["$' (bash and zsh ANSI-C quoting)", "put k $'a'", "shell-expansion", 6, dollar(1, 7)],
  ['$" (bash)', 'put k $"a"', "shell-expansion", 6, dollar(1, 7)],
  ["$[ (bash and zsh arithmetic)", "put k $[1+1]", "shell-expansion", 6, dollar(1, 7)],
  ["$= (zsh)", "put k $=x", "shell-expansion", 6, dollar(1, 7)],
  ["$ before a backslash-newline", "put k a$\\\nb", "shell-expansion", 7, dollar(1, 8)],
  ["$NAME inside double quotes", 'put k "a $HOME"', "shell-expansion", 9, dollar(1, 10)],
  ["$( inside double quotes", 'put k "$(ls)"', "shell-expansion", 7, dollar(1, 8)],
  ["a backquote", "put k `ls`", "shell-expansion", 6, backquote(1, 7)],
  ["a backquote inside double quotes", 'put k "a `ls`"', "shell-expansion", 9, backquote(1, 10)],
  ["a ~ that begins a word", "get ~/x", "shell-expansion", 4, tilde(1, 5)],
  ["a lone ~", "get ~", "shell-expansion", 4, tilde(1, 5)],
  ["a ~ right after the = of a NAME= word", "put k a=~/x", "shell-expansion", 6, assignmentTilde(1, 7)],
  ["a ~ right after a : of a NAME= word", "put k a=b:~/x", "shell-expansion", 6, assignmentTilde(1, 7)],
  ["braces holding a comma", "put k {a,b}", "shell-expansion", 6, braces(1, 7)],
  ["braces holding ..", "put k {1..3}", "shell-expansion", 6, braces(1, 7)],
  ["braces inside a word", "put k x{a,b}y", "shell-expansion", 6, braces(1, 7)],
  ["nested braces whose inner pair holds the comma", "put k {a{b,c}}", "shell-expansion", 6, braces(1, 7)],
  ["an empty alternative", "put k {a,}", "shell-expansion", 6, braces(1, 7)],
  ["unquoted JSON with a comma, which bash splits in two", 'put k {"a":1,"b":2}', "shell-expansion", 6, braces(1, 7)],
  [";", "get a; get b", "shell-operator", 5, operator(";", 1, 6)],
  ["&", "get a &", "shell-operator", 6, operator("&", 1, 7)],
  ["|", "get a | tee x", "shell-operator", 6, operator("|", 1, 7)],
  ["<", "put k < file", "shell-operator", 6, operator("<", 1, 7)],
  [">", "get a > file", "shell-operator", 6, operator(">", 1, 7)],
  ["(", "put k (v)", "shell-operator", 6, operator("(", 1, 7)],
  [")", "put k v)", "shell-operator", 7, operator(")", 1, 8)],
];

describe("text a shell would expand or refuse is refused (spec 5.1.1)", () => {
  test.each(SHELL_REFUSALS)("%s", (_form, text, code, column, message) => {
    expect(refusalOf(text)).toEqual({ code, message, line: 1, column } as never);
  });

  test("the earliest refusal in the text is the one reported, a word's own included", () => {
    // The braces are found only when the word ends, after the $ inside it was seen: still first.
    expect(refusalOf("put {a,b}$x").column).toBe(4);
    expect(refusalOf("put a$x ;").column).toBe(5);
    expect(refusalOf("get a\\\n$b").line).toBe(2);
  });

  test("a refusal on a later line of a multi-line word names that line", () => {
    expect(refusalOf("put k 'a\nb' $c")).toMatchObject({ code: "shell-expansion", line: 2, column: 3 });
  });

  test("a word-level refusal names the word's first line when the word spans lines", () => {
    expect(refusalOf("put k {a,\\\nb}")).toMatchObject({ code: "shell-expansion", line: 1, column: 6 });
  });

  test("a lone surrogate is refused as not being text", () => {
    expect(refusalOf("put k a\ud800")).toEqual({
      code: "not-text",
      line: 1,
      column: 7,
      message: "The text holds a lone UTF-16 surrogate at line 1, column 8, which is not a character: remove it.",
    });
    expect(refusalOf("get a\nput k \udc00x")).toMatchObject({ code: "not-text", line: 2, column: 6 });
    // A pair is a character.
    expect(commandWords("put k \ud834\udd1e")).toEqual(["put", "k", "𝄞"]);
  });
});

describe("the end of the text (spec 5.1.1)", () => {
  test("a quote never closed is refused, naming the word it opens", () => {
    expect(refusalOf("put k 'a")).toEqual({
      code: "unclosed-quote",
      line: 1,
      column: 6,
      message: "The single quote in the word at line 1, column 7 is never closed: close it before the end of the text.",
    });
    expect(refusalOf('put k x"a\nb')).toEqual({
      code: "unclosed-quote",
      line: 1,
      column: 6,
      message: "The double quote in the word at line 1, column 7 is never closed: close it before the end of the text.",
    });
  });

  test("a backslash that ends the text is refused: bash keeps it and zsh drops it", () => {
    expect(refusalOf("put k a\\")).toEqual({
      code: "trailing-backslash",
      line: 1,
      column: 7,
      message:
        "The backslash at line 1, column 8 ends the text and escapes nothing, which shells read differently (bash keeps it and zsh drops it): remove it, or write it between single quotes.",
    });
    expect(refusalOf("get a \\")).toMatchObject({ code: "trailing-backslash", line: 1, column: 6 });
    expect(refusalOf('put k "a\\')).toMatchObject({ code: "unclosed-quote" });
  });

  test("a word that runs on past the last line with a backslash-newline and an empty last line ends there", () => {
    expect(commandWords("put k a\\\n")).toEqual(["put", "k", "a"]);
  });
});

// ============================================================================
// 5.1.2: the leading tokens and the command word
// ============================================================================

describe("the leading tokens a documented command carries (spec 5.1.2)", () => {
  test("a prompt, env, assignments, an etcdctl word and global flags come before the command word", () => {
    expect(split("$ env ETCDCTL_API=3 X=1 ./etcdctl --command-timeout 5s --debug get a").lead).toEqual({
      roles: ["prompt", "env", "assignment", "assignment", "etcdctl", "flag", "flag-value", "flag"],
      commandIndex: 8,
    });
    expect(split("% /usr/local/bin/etcdctl --command-timeout=5s lease grant 5").lead).toEqual({
      roles: ["prompt", "etcdctl", "flag"],
      commandIndex: 3,
    });
  });

  test("each leading token is optional", () => {
    expect(split("get a").lead).toEqual({ roles: [], commandIndex: 0 });
    expect(split("ETCDCTL_API=3 get a").lead).toEqual({ roles: ["assignment"], commandIndex: 1 });
    expect(split("etcdctl").lead).toEqual({ roles: ["etcdctl"], commandIndex: 1 });
  });

  test("a quoted prompt or a quoted name is no leading token, as a shell reads it", () => {
    expect(split("'$' get").lead).toEqual({ roles: [], commandIndex: 0 });
    expect(split('"A"=1 get').lead).toEqual({ roles: [], commandIndex: 0 });
    expect(split('A="1 2" get').lead).toEqual({ roles: ["assignment"], commandIndex: 1 });
  });

  test("the prompt is only the first word, and env only before the assignments", () => {
    expect(split("get $ a").lead.commandIndex).toBe(0);
    expect(split("A=1 env get").lead).toEqual({ roles: ["assignment"], commandIndex: 1 });
  });

  test.each([
    ["-a", true],
    ["--", true],
    ["--x=1", true],
    ["-", false],
    ["", false],
    ["a-", false],
  ] as const)("isFlagText(%j) is %p, pflag's reading", (text, flag) => {
    expect(isFlagText(text)).toBe(flag);
  });

  test("a lone - is an argument, not a flag", () => {
    expect(split("- get").lead).toEqual({ roles: [], commandIndex: 0 });
  });

  test("--command-timeout with no word after it takes nothing", () => {
    expect(split("--command-timeout").lead).toEqual({ roles: ["flag"], commandIndex: 1 });
  });
});

// ============================================================================
// 3.3, 5.1.2, 5.1.4: the section of every line
// ============================================================================

const sectionsOf = (text: string) => split(text).lines.map((line) => line.section);
const rolesOf = (text: string) => split(text).lines.map((line) => line.role);

describe("the section and the role of every line (spec 3.3)", () => {
  test("blank and comment lines before the command stay in the command section", () => {
    expect(sectionsOf("\n# c\n  \nget a")).toEqual(["command", "command", "command", "command"]);
    expect(rolesOf("\n# c\n  \nget a")).toEqual(["blank", "comment", "blank", "command"]);
  });

  test("after a command other than txn, lines are blank, comment or content", () => {
    expect(sectionsOf("get a\n\n  # c\n x")).toEqual(["command", "after-command", "after-command", "after-command"]);
    expect(rolesOf("get a\n\n  # c\n x")).toEqual(["command", "blank", "comment", "content"]);
  });

  test("the lines of one logical command line are all command lines", () => {
    expect(rolesOf("put k 'a\nb'\nget")).toEqual(["command", "command", "content"]);
    expect(rolesOf("\\\nget a")).toEqual(["blank", "command"]);
  });

  test("txn's body: each empty line ends a list, a # line ends none", () => {
    const text = 'txn\n# c\nmod("k") > "0"\n\nput a b\n  \t\u00a0\nget a\n\n# end\nput x y';
    expect(sectionsOf(text)).toEqual([
      "command",
      "compares",
      "compares",
      "compares",
      "success",
      "success",
      "failure",
      "failure",
      "after-body",
      "after-body",
    ]);
    expect(rolesOf(text)).toEqual([
      "command",
      "comment",
      "compare",
      "blank",
      "request",
      "blank",
      "request",
      "blank",
      "comment",
      "content",
    ]);
  });

  test("each line carries its text and where its first token that is not whitespace starts", () => {
    const lines = split("  get a\n\t\n  # c\n").lines;
    expect(lines.map(({ text, start }) => [text, start])).toEqual([
      ["  get a", 2],
      ["\t", 1],
      ["  # c", 2],
      ["", 0],
    ]);
    const body = split('txn\n  mod("k") > "0"\n\u00a0\n put x').lines;
    expect(body.map(({ start }) => start)).toEqual([0, 2, 1, 1]);
  });

  test("txn's command line may run on over several lines before its body", () => {
    expect(sectionsOf('txn \\\n--command-timeout=5s\nmod("k") > "0"')).toEqual(["command", "command", "compares"]);
  });

  test("the command word decides the body, past the leading tokens", () => {
    expect(sectionsOf("ETCDCTL_API=3 etcdctl --command-timeout 5s txn\n\n")).toEqual([
      "command",
      "compares",
      "success",
    ]);
    expect(sectionsOf("etcdctl\nx")).toEqual(["command", "after-command"]);
  });
});

// ============================================================================
// 5.1.4: the txn body
// ============================================================================

/** The request words of a txn whose one request line is `line`, read back as byte strings. */
function requestBytes(line: string): string[] {
  const read = bodyLine(`txn\n\n${line}`, 3);
  expect(read.role).toBe("request");
  return (read.words ?? []).map((word) => hex(word.bytes));
}

function requestRefusal(line: string) {
  const read = bodyLine(`txn\n\n${line}`, 3);
  if (read.refusal === undefined) throw new Error(`expected ${line} to be refused`);
  return read.refusal;
}

const escapeRefusal = (line: number, escape: string) =>
  `Line ${line} of the txn holds ${escape} in a double-quoted string, which is not an escape in Go's quoting, the quoting etcdctl reads a txn with: write \\\\ for a backslash.`;

/** strconv.Unquote's rules, each row a value measured through etcdctl where it was run (the corpus). */
const GO_STRINGS: readonly [rule: string, quoted: string, bytes: string][] = [
  ["a letter is its byte", '"a"', "61"],
  ["the named escapes", '"\\a\\b\\f\\n\\r\\t\\v\\\\\\""', "07080c0a0d090b5c22"],
  ["\\xNN is one byte, in either case", '"\\x00\\xff\\x4A"', "00ff4a"],
  ["\\u is a code point as UTF-8", '"\\u00e9\\u4e2d"', "c3a9e4b8ad"],
  ["\\U is a code point as UTF-8", '"\\U0001D11E"', "f09d849e"],
  ["an octal escape is one byte", '"\\351\\000\\377"', "e900ff"],
  ["a literal character is its UTF-8", '"é𝄞"', "c3a9f09d849e"],
  ["a single quote needs no escape", '"it\'s"', "69742773"],
  ["a $ needs no escape", '"$HOME"', "24484f4d45"],
];

const GO_BAD_ESCAPES: readonly [rule: string, quoted: string, escape: string][] = [
  ["\\q is no escape", '"\\q"', "\\q"],
  ["\\$ is no escape", '"\\$"', "\\$"],
  ["\\' is no escape inside double quotes", '"\\\'"', "\\'"],
  ["\\x needs two hex digits", '"\\x4"', "\\x4"],
  ["\\x takes only hex digits", '"\\xg0"', "\\xg0"],
  ["\\u needs four hex digits", '"\\u12"', "\\u12"],
  ["\\u may not name a surrogate", '"\\ud800"', "\\ud800"],
  ["\\U may not pass U+10FFFF", '"\\U00110000"', "\\U00110000"],
  ["an octal escape may not pass 255", '"\\400"', "\\400"],
  ["an octal escape takes only octal digits", '"\\08"', "\\08"],
  ["an octal escape needs three digits", '"\\1"', "\\1"],
];

describe("Go quoted strings in a txn decode to bytes (spec 5.1.4)", () => {
  test.each(GO_STRINGS)("%s", (_rule, quoted, bytes) => {
    expect(requestBytes(`put k ${quoted}`)[2]).toBe(bytes);
  });

  test.each(GO_BAD_ESCAPES)("%s, refused", (_rule, quoted, escape) => {
    expect(requestRefusal(`put k ${quoted}`)).toEqual({
      code: "txn-quoting",
      line: 3,
      column: 7,
      message: escapeRefusal(3, escape),
    });
  });

  test("a compare's key and value decode by the same rules", () => {
    const compare = bodyLine('txn\nval("\\x2f\\u00e9") = "a\\nb"', 2).compare;
    expect(compare && hex(compare.key.bytes)).toBe("2fc3a9");
    expect(compare && hex(compare.value.bytes)).toBe("610a62");
    expect(bodyLine('txn\nval("\\q") = "a"', 2).refusal?.message).toBe(escapeRefusal(2, "\\q"));
  });
});

const openQuote = (line: number, column: number) =>
  `Line ${line} of the txn opens a quote at column ${column} that is never closed, which etcdctl would drop and read on: close it.`;
const adjacent = (line: number, column: number) =>
  `Line ${line} of the txn has text right after the closing quote at column ${column}, where etcdctl starts a new word and a shell would join them: put a space after the quote, or move the text inside the quotes.`;

describe("a txn request line is split the way etcdctl's Argify splits it (spec 5.1.4)", () => {
  test("words are separated by the regular expression's \\s: space, tab, form feed, CR and LF", () => {
    expect(requestBytes("put  k\tv\fw")).toEqual(["707574", "6b", "76", "77"]);
  });

  test("a vertical tab and a no-break space are word characters there", () => {
    expect(requestBytes("put a\vb c\u00a0d")).toEqual(["707574", hex(utf8("a\vb")), hex(utf8("c\u00a0d"))]);
  });

  test("the line is trimmed as Go trims it, Unicode spaces included", () => {
    expect(requestBytes("\u00a0\u3000put k v\u2028\u0085")).toEqual(["707574", "6b", "76"]);
  });

  test("an unquoted word is taken as written: backslashes, quotes, $, #, ; and the rest", () => {
    expect(requestBytes("put k it's")[2]).toBe(hex(utf8("it's")));
    expect(requestBytes("put k a\\nb")[2]).toBe(hex(utf8("a\\nb")));
    expect(requestBytes('put k a"b c"')).toEqual(["707574", "6b", hex(utf8('a"b')), hex(utf8('c"'))]);
    expect(requestBytes("put k $x;#&|<>")[2]).toBe(hex(utf8("$x;#&|<>")));
  });

  test("a single-quoted word is literal", () => {
    expect(requestBytes("put k 'a\\n b'")[2]).toBe(hex(utf8("a\\n b")));
  });

  test("a quoted word followed directly by other text is refused, since Argify splits it", () => {
    expect(requestRefusal('put k "a"b')).toEqual({
      code: "txn-quoting",
      line: 3,
      column: 9,
      message: adjacent(3, 10),
    });
    expect(requestRefusal("put k 'a'b")).toMatchObject({ code: "txn-quoting", column: 9 });
    expect(requestRefusal("put k 'a'\"b\"")).toMatchObject({ code: "txn-quoting", column: 9 });
  });

  test("a quote left open is refused, since Argify drops it", () => {
    expect(requestRefusal('put k "abc')).toEqual({ code: "txn-quoting", line: 3, column: 6, message: openQuote(3, 7) });
    expect(requestRefusal("put k 'abc")).toMatchObject({ code: "txn-quoting", column: 6 });
    // The backslash protects the quote, so the string never closes.
    expect(requestRefusal('put k "a\\"')).toMatchObject({ code: "txn-quoting", column: 6 });
  });

  test("the first refusal on a request line is the one reported", () => {
    expect(requestRefusal('put "\\q" \'x')).toMatchObject({ column: 5 });
  });
});

const compareShape = (line: number, what: string) =>
  `Line ${line} of the txn is not a compare etcdctl reads: ${what}. A compare is written as mod("key1") > "0": a target, the key in quotes inside parentheses, then an operator and a quoted value, each after a space.`;

function compareOf(line: string) {
  const read = bodyLine(`txn\n${line}`, 2);
  if (read.compare === undefined) throw new Error(`expected ${line} to read as a compare: ${read.refusal?.message}`);
  const { target, key, operator: op, value, rest } = read.compare;
  return { target: target.text, key: hex(key.bytes), operator: op.text, value: hex(value.bytes), rest };
}

describe("a txn compare is read the way etcdctl's ParseCompare reads it (spec 5.1.4)", () => {
  test("target, key, operator and value", () => {
    expect(compareOf('mod("k") > "0"')).toEqual({ target: "mod", key: "6b", operator: ">", value: "30", rest: "" });
  });

  test("spaces: any number, Unicode spaces too, and spaces after the (", () => {
    expect(compareOf('mod( "k")   !=\u00a0"0"')).toEqual({
      target: "mod",
      key: "6b",
      operator: "!=",
      value: "30",
      rest: "",
    });
  });

  test("the key and the value may be in backquotes, taken raw", () => {
    expect(compareOf("val(`a\\n`) = `$b`")).toMatchObject({ key: hex(utf8("a\\n")), value: hex(utf8("$b")) });
  });

  test("the target is everything before the first (, spaces included, and text after the value is kept", () => {
    expect(compareOf('mod ("k") > "0"').target).toBe("mod ");
    expect(compareOf('mod("k") = "0" trailing').rest).toBe(" trailing");
    expect(compareOf('mod("k") = "0"x').rest).toBe("x");
  });

  test.each([
    ["no (", 'put k "v"', "it holds no ("],
    ["an unquoted key", 'mod(k) > "0"', "the key is not a quoted string"],
    ["a key whose quote never closes", 'mod("k > 0', "the key's quote is never closed"],
    ["a key whose backquote never closes", 'mod(`k) > "0"', "the key's quote is never closed"],
    ["a space before the )", 'mod("k" ) > "0"', "no ) follows the key's closing quote"],
    ["a quote swallowing the )", 'mod("k) > "0"', "no ) follows the key's closing quote"],
    ["no space after the )", 'mod("k")> "0"', "no space follows the )"],
    ["nothing after the )", 'mod("k")', "no operator follows the key"],
    ["no value", 'mod("k") >', "no value follows the operator"],
    ["an operator run into the value", 'mod("k") >"0"', "no value follows the operator"],
    ["an unquoted value", 'mod("k") > 0', "the value is not a quoted string"],
    ["a value whose quote never closes", 'mod("k") > "0', "the value's quote is never closed"],
  ])("%s is refused", (_case, line, what) => {
    expect(bodyLine(`txn\n${line}`, 2).refusal).toEqual({
      code: "txn-syntax",
      line: 2,
      column: 0,
      message: compareShape(2, what),
    });
  });

  test("a compare after leading spaces names its column", () => {
    expect(bodyLine("txn\n  mod(k)", 2).refusal).toMatchObject({ code: "txn-syntax", column: 2 });
  });
});

// ============================================================================
// 3.3: tokenizeLine and its state, as the tokens provider calls it
// ============================================================================

describe("tokenizeLine (spec 3.3)", () => {
  test("the initial state is the command line with nothing open", () => {
    expect(INITIAL_LEX_STATE).toEqual({ section: "command", quote: "none", continued: false, words: [] });
  });

  test("a command line's tokens", () => {
    expect(tokenizeLine("get /a --prefix # note", INITIAL_LEX_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "word", start: 4, end: 6 },
      { kind: "whitespace", start: 6, end: 7 },
      { kind: "flag", start: 7, end: 15 },
      { kind: "whitespace", start: 15, end: 16 },
      { kind: "comment", start: 16, end: 22 },
    ]);
  });

  test("quoted parts are strings, and refused characters are invalid", () => {
    expect(tokenizeLine("put k 'a b'\"c\"d $H;", INITIAL_LEX_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "word", start: 4, end: 5 },
      { kind: "whitespace", start: 5, end: 6 },
      { kind: "string", start: 6, end: 14 },
      { kind: "word", start: 14, end: 15 },
      { kind: "whitespace", start: 15, end: 16 },
      { kind: "invalid", start: 16, end: 17 },
      { kind: "word", start: 17, end: 18 },
      { kind: "invalid", start: 18, end: 19 },
    ]);
  });

  test("a quote open at the end of a line carries into the next, as a string", () => {
    const first = tokenizeLine("put k 'ab", INITIAL_LEX_STATE);
    expect(first.state).toMatchObject({ section: "command", quote: "single", continued: false });
    expect(first.state.partial).toMatchObject({ text: "ab", quoting: "qq", column: 6, linesBack: 0 });
    const second = tokenizeLine("cd' e", first.state);
    expect(second.tokens).toEqual([
      { kind: "string", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "word", start: 4, end: 5 },
    ]);
    expect(second.state).toEqual({ section: "after-command", quote: "none", continued: false, words: [] });
  });

  test("a double quote open at the end of a line carries a newline, and a backslash-newline carries none", () => {
    const open = tokenizeLine('put k "a', INITIAL_LEX_STATE).state;
    expect(open).toMatchObject({ quote: "double", continued: false });
    const escaped = tokenizeLine('put k "a\\', INITIAL_LEX_STATE).state;
    expect(escaped).toMatchObject({ quote: "double", continued: true });
    expect(commandWords('put k "a\nb"')[2]).toBe("a\nb");
    expect(commandWords('put k "a\\\nb"')[2]).toBe("ab");
  });

  test("a backslash-newline carries the words read so far and the word it is inside", () => {
    const between = tokenizeLine("get \\", INITIAL_LEX_STATE).state;
    expect(between).toMatchObject({ section: "command", continued: true, words: [{ text: "get", quoting: "uuu" }] });
    expect(between.partial).toBeUndefined();
    const inside = tokenizeLine("get ab\\", INITIAL_LEX_STATE).state;
    expect(inside.partial).toMatchObject({ text: "ab", column: 4 });
  });

  test("the command word decides the section after the command line", () => {
    expect(tokenizeLine("txn", INITIAL_LEX_STATE).state).toEqual({
      section: "compares",
      quote: "none",
      continued: false,
      words: [],
    });
    expect(tokenizeLine("get a", INITIAL_LEX_STATE).state.section).toBe("after-command");
    expect(tokenizeLine("# c", INITIAL_LEX_STATE).state).toEqual(INITIAL_LEX_STATE);
  });

  test("a txn body's lines", () => {
    const compares = tokenizeLine("txn", INITIAL_LEX_STATE).state;
    expect(tokenizeLine(' mod("k") > "0" x', compares).tokens).toEqual([
      { kind: "whitespace", start: 0, end: 1 },
      { kind: "word", start: 1, end: 4 },
      { kind: "operator", start: 4, end: 5 },
      { kind: "string", start: 5, end: 8 },
      { kind: "operator", start: 8, end: 9 },
      { kind: "whitespace", start: 9, end: 10 },
      { kind: "operator", start: 10, end: 11 },
      { kind: "whitespace", start: 11, end: 12 },
      { kind: "string", start: 12, end: 15 },
      { kind: "invalid", start: 15, end: 17 },
    ]);
    const success = tokenizeLine("", compares).state;
    expect(success.section).toBe("success");
    expect(tokenizeLine("get k --prefix \"v\" 'w'", success).tokens).toEqual([
      { kind: "word", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "word", start: 4, end: 5 },
      { kind: "whitespace", start: 5, end: 6 },
      { kind: "flag", start: 6, end: 14 },
      { kind: "whitespace", start: 14, end: 15 },
      { kind: "string", start: 15, end: 18 },
      { kind: "whitespace", start: 18, end: 19 },
      { kind: "string", start: 19, end: 22 },
    ]);
    expect(tokenizeLine("  # note", success)).toEqual({
      tokens: [
        { kind: "whitespace", start: 0, end: 2 },
        { kind: "comment", start: 2, end: 8 },
      ],
      state: success,
    });
    expect(tokenizeLine('put "a', success).tokens).toEqual([
      { kind: "word", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "invalid", start: 4, end: 5 },
      { kind: "word", start: 5, end: 6 },
    ]);
    const failure = tokenizeLine(" ", success).state;
    const after = tokenizeLine("", failure).state;
    expect(after.section).toBe("after-body");
    expect(tokenizeLine("", after).state.section).toBe("after-body");
    expect(tokenizeLine(" put x", after).tokens).toEqual([
      { kind: "whitespace", start: 0, end: 1 },
      { kind: "invalid", start: 1, end: 6 },
    ]);
  });

  test("a line after another command is whitespace, a comment, or content marked invalid", () => {
    const after = tokenizeLine("get a", INITIAL_LEX_STATE).state;
    expect(tokenizeLine("\t# c", after).tokens).toEqual([
      { kind: "whitespace", start: 0, end: 1 },
      { kind: "comment", start: 1, end: 4 },
    ]);
    expect(tokenizeLine("  put b c", after).tokens).toEqual([
      { kind: "whitespace", start: 0, end: 2 },
      { kind: "invalid", start: 2, end: 9 },
    ]);
    expect(tokenizeLine("", after)).toEqual({ tokens: [], state: after });
  });

  test("lexStatesEqual compares every field", () => {
    const carried = tokenizeLine("put 'a", INITIAL_LEX_STATE).state;
    expect(lexStatesEqual(carried, tokenizeLine("put 'a", INITIAL_LEX_STATE).state)).toBe(true);
    expect(lexStatesEqual(INITIAL_LEX_STATE, { ...INITIAL_LEX_STATE })).toBe(true);
    expect(lexStatesEqual(INITIAL_LEX_STATE, { ...INITIAL_LEX_STATE, section: "compares" })).toBe(false);
    expect(lexStatesEqual(INITIAL_LEX_STATE, { ...INITIAL_LEX_STATE, quote: "single" })).toBe(false);
    expect(lexStatesEqual(INITIAL_LEX_STATE, { ...INITIAL_LEX_STATE, continued: true })).toBe(false);
    expect(lexStatesEqual(INITIAL_LEX_STATE, { ...INITIAL_LEX_STATE, words: [{ text: "a", quoting: "u" }] })).toBe(
      false,
    );
    const one = { ...INITIAL_LEX_STATE, words: [{ text: "a", quoting: "u" }] };
    expect(lexStatesEqual(one, { ...INITIAL_LEX_STATE, words: [{ text: "b", quoting: "u" }] })).toBe(false);
    expect(lexStatesEqual(one, { ...INITIAL_LEX_STATE, words: [{ text: "a", quoting: "q" }] })).toBe(false);
    expect(lexStatesEqual(carried, { ...carried, partial: undefined })).toBe(false);
    expect(lexStatesEqual({ ...carried, partial: undefined }, carried)).toBe(false);
    const partial = carried.partial;
    if (partial === undefined) throw new Error("expected a partial word");
    for (const field of ["text", "quoting", "column", "linesBack", "lastLinesBack", "lastEnd", "flag"] as const) {
      const changed = { ...partial, [field]: field === "flag" ? !partial.flag : `${partial[field]}x` };
      expect(lexStatesEqual(carried, { ...carried, partial: changed })).toBe(false);
    }
  });
});

// ============================================================================
// The corpus the tokens provider shares (spec 3.3, 10)
// ============================================================================

const WORDISH: ReadonlySet<LexTokenKind> = new Set(["word", "flag", "string"]);

/** The kind of the token covering column `column` of a line, or undefined past its end. */
const kindAt = (tokens: readonly LexToken[], column: number) =>
  tokens.find((token) => token.start <= column && column < token.end)?.kind;

function corpusBytes(word: CorpusWord): string {
  if (word.hex !== undefined) return word.hex;
  return hex(utf8(word.text ?? ""));
}

function readWords(text: SplitText): Word[] {
  const request = text.lines.flatMap((line) => line.words ?? []);
  return [...text.command, ...request];
}

describe("the shared grammar corpus (spec 3.3, 10)", () => {
  for (const entry of GRAMMAR_CORPUS) {
    describe(entry.name, () => {
      const rows = tokenizeAll(entry.text);

      test("every line's section, read the tokens provider's way and the parser's way", () => {
        expect(rows.map((row) => row.section)).toEqual([...entry.sections]);
        const result = splitWords(entry.text);
        if (result.ok) expect(result.split.lines.map((line) => line.section)).toEqual([...entry.sections]);
      });

      test("the tokens cover every line, in order, with nothing overlapping", () => {
        const lines = entry.text.split(/\r\n|\r|\n/);
        rows.forEach((row, index) => {
          let at = 0;
          for (const token of row.tokens) {
            expect(token.start).toBe(at);
            expect(token.end).toBeGreaterThan(token.start);
            at = token.end;
          }
          expect(at).toBe(lines[index].length);
        });
      });

      if (entry.lexRefusal !== undefined) {
        test("the lexer refuses the text", () => {
          expect(refusalOf(entry.text)).toMatchObject(entry.lexRefusal as object);
        });
        return;
      }

      test("the words, their boundaries and their bytes", () => {
        const words = readWords(split(entry.text)).map((word) => ({
          line: word.line,
          column: word.column,
          endLine: word.endLine,
          endColumn: word.endColumn,
          bytes: hex(word.bytes),
        }));
        expect(words).toEqual(
          entry.words.map((word) => ({
            line: word.line,
            column: word.column,
            endLine: word.endLine,
            endColumn: word.endColumn,
            bytes: corpusBytes(word),
          })),
        );
      });

      test("the tokens provider draws each word as one word: word tokens inside, none touching it", () => {
        for (const word of entry.words) {
          const first = rows[word.line - 1].tokens;
          const last = rows[word.endLine - 1].tokens;
          expect(WORDISH.has(kindAt(first, word.column) as LexTokenKind)).toBe(true);
          expect(WORDISH.has(kindAt(last, word.endColumn - 1) as LexTokenKind)).toBe(true);
          const before = kindAt(first, word.column - 1);
          const after = kindAt(last, word.endColumn);
          expect(before === undefined || !WORDISH.has(before)).toBe(true);
          expect(after === undefined || !WORDISH.has(after)).toBe(true);
          for (let line = word.line; line <= word.endLine; line++) {
            for (const token of rows[line - 1].tokens) {
              const from = line === word.line ? word.column : 0;
              const to = line === word.endLine ? word.endColumn : Number.POSITIVE_INFINITY;
              if (token.end > from && token.start < to) expect(WORDISH.has(token.kind)).toBe(true);
            }
          }
        }
      });

      test("the compares", () => {
        const compares = split(entry.text)
          .lines.filter((line) => line.compare !== undefined)
          .map((line) => ({
            line: line.line,
            target: line.compare?.target.text,
            keyHex: hex(line.compare?.key.bytes ?? new Uint8Array()),
            operator: line.compare?.operator.text,
            valueHex: hex(line.compare?.value.bytes ?? new Uint8Array()),
          }));
        expect(compares).toEqual([...(entry.compares ?? [])]);
      });
    });
  }
});

// ============================================================================
// lexLogicalLine
// ============================================================================

describe("lexLogicalLine", () => {
  const texts = (result: ReturnType<typeof lexLogicalLine>) => {
    if (!result.ok) throw new Error(result.refusal.message);
    return { words: result.words.map((word) => [word.text, word.line, word.column]), next: result.nextOffset };
  };

  test("one logical line from an offset, and where the next one starts", () => {
    expect(texts(lexLogicalLine("get a b\nput c", 0))).toEqual({
      words: [
        ["get", 1, 0],
        ["a", 1, 4],
        ["b", 1, 6],
      ],
      next: 8,
    });
    expect(texts(lexLogicalLine("get a b\nput c", 8))).toEqual({
      words: [
        ["put", 2, 0],
        ["c", 2, 4],
      ],
      next: 13,
    });
  });

  test("an offset inside a line keeps the line's own columns", () => {
    expect(texts(lexLogicalLine("xx\nyy get a", 6))).toEqual({
      words: [
        ["get", 2, 3],
        ["a", 2, 7],
      ],
      next: 11,
    });
  });

  test("a blank or comment line has no words", () => {
    expect(texts(lexLogicalLine("\nget", 0))).toEqual({ words: [], next: 1 });
    expect(texts(lexLogicalLine("# c\r\nget", 0))).toEqual({ words: [], next: 5 });
  });

  test("a quote and a backslash-newline carry the logical line on", () => {
    expect(texts(lexLogicalLine("put 'a\nb' c\\\n d\nget", 0))).toEqual({
      words: [
        ["put", 1, 0],
        ["a\nb", 1, 4],
        ["c", 2, 3],
        ["d", 3, 1],
      ],
      next: 16,
    });
  });

  test("its refusals", () => {
    expect(lexLogicalLine("get $x\nput", 0)).toEqual({
      ok: false,
      refusal: { code: "shell-expansion", line: 1, column: 4, message: dollar(1, 5) },
    });
    expect(lexLogicalLine("get 'x", 0)).toMatchObject({ ok: false, refusal: { code: "unclosed-quote" } });
    expect(lexLogicalLine("get x\\", 0)).toMatchObject({ ok: false, refusal: { code: "trailing-backslash" } });
    expect(lexLogicalLine("get \ud800", 0)).toMatchObject({ ok: false, refusal: { code: "not-text" } });
  });
});

// ============================================================================
// The quoting functions (spec 5.5, 6.4)
// ============================================================================

/** Texts a key or a value holds, chosen to break a quoting function. */
const HARD_TEXTS: readonly string[] = [
  "",
  " ",
  " a",
  "a b",
  "'",
  '"',
  "\\",
  "\n",
  "a\nb",
  "\t",
  "-x",
  "--",
  "--prefix",
  "#x",
  "a#b",
  "$",
  "$HOME",
  "a$",
  "`x`",
  "~",
  "~/x",
  "a=~/x",
  "{a,b}",
  "{a}",
  "a;b",
  "a|b&c",
  "(x)",
  "<>",
  "*",
  "?",
  "[a]",
  "!",
  "é",
  "日本語",
  "𝄞",
  "\u00a0",
  "\u2028",
  "\ufeff",
  "\u0085",
  "\u0001",
  "\u007f",
  "it's",
  "'\\''",
  "\\n",
  "a\\",
  "/app/config/",
  "/registry/pods/default/nginx",
];

describe("quoteWord, the command line's quoting (spec 5.5, 6.4)", () => {
  test.each(["/app/config", "a-b_c.d:e@f%g+h=i,j^k", "-x", "é", "日本語", "0"])("%s stays bare", (text) => {
    expect(quoteWord(text)).toBe(text);
  });

  test.each([
    ["", "''"],
    [" a", "' a'"],
    [" ", "' '"],
    ["a b", "'a b'"],
    ["it's", "'it'\\''s'"],
    ["$HOME", "'$HOME'"],
    ["~/x", "'~/x'"],
    ["{a,b}", "'{a,b}'"],
    ["a\nb", "'a\nb'"],
    ["\u00a0", "'\u00a0'"],
    ["\u0085", "'\u0085'"],
    ["\ufeff", "'\ufeff'"],
    ["\u0080", "'\u0080'"],
    ["\u009f", "'\u009f'"],
    ["*", "'*'"],
  ])("%j is single-quoted as %j", (text, quoted) => {
    expect(quoteWord(text)).toBe(quoted);
  });

  test.each([...HARD_TEXTS])("%j reads back as itself", (text) => {
    const quoted = quoteWord(text);
    const read = lexLogicalLine(quoted, 0);
    if (!read.ok) throw new Error(read.refusal.message);
    expect(read.words.map((word) => word.text)).toEqual([text]);
    expect(read.nextOffset).toBe(quoted.length);
  });

  test("a carriage return or a lone surrogate has no command-line spelling, so quoting it throws", () => {
    expect(() => quoteWord("a\rb")).toThrow(
      "A carriage return has no spelling on the etcd command line, where the editor ends a line at it: write the word in a txn, where quoteTxnWord escapes it",
    );
    expect(() => quoteWord("a\ud800")).toThrow("A lone UTF-16 surrogate is not text, so no quoting reads it back");
  });
});

describe("quoteTxnWord and quoteGoString, the txn body's quoting (spec 4.5, 6.4)", () => {
  test("a txn word stays bare when it is safe text, and is Go-quoted otherwise", () => {
    expect(quoteTxnWord(utf8("/app/cfg"))).toBe("/app/cfg");
    expect(quoteTxnWord(utf8("é"))).toBe("é");
    expect(quoteTxnWord(utf8(""))).toBe('""');
    expect(quoteTxnWord(utf8("a b"))).toBe('"a b"');
    expect(quoteTxnWord(utf8("it's"))).toBe('"it\'s"');
    expect(quoteTxnWord(utf8("#x"))).toBe('"#x"');
    expect(quoteTxnWord(new Uint8Array([0xff]))).toBe('"\\xff"');
  });

  test("Go quoting escapes what etcdctl would not read back literally", () => {
    expect(quoteGoString(utf8("k"))).toBe('"k"');
    expect(quoteGoString(utf8('\u0007\b\f\n\r\t\v\\"'))).toBe('"\\a\\b\\f\\n\\r\\t\\v\\\\\\""');
    expect(quoteGoString(utf8("\u0000\u0001\u007f"))).toBe('"\\x00\\x01\\x7f"');
    expect(quoteGoString(utf8("\u0085\u00a0\u2028\ufeff"))).toBe('"\\u0085\\u00a0\\u2028\\ufeff"');
    expect(quoteGoString(utf8("é日本𝄞$'"))).toBe('"é日本𝄞$\'"');
  });

  test("bytes that are not UTF-8 are written byte by byte", () => {
    expect(quoteGoString(new Uint8Array([0x61, 0xff, 0xc3, 0xa9, 0x0a]))).toBe('"a\\xff\\xc3\\xa9\\n"');
  });

  const HARD_BYTES: readonly Uint8Array[] = [
    ...HARD_TEXTS.map(utf8),
    new Uint8Array([0x00]),
    new Uint8Array([0xff]),
    new Uint8Array([0x80, 0x61]),
    new Uint8Array([0xc3]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    utf8("a\rb"),
  ];

  test.each(HARD_BYTES.map((bytes) => [hex(bytes), bytes] as const))(
    "%s reads back through a txn request and a compare",
    (_hex, bytes) => {
      const request = bodyLine(`txn\n\nput ${quoteTxnWord(bytes)} v`, 3);
      expect(request.words && hex(request.words[1].bytes)).toBe(hex(bytes));
      const quoted = quoteGoString(bytes);
      const compare = bodyLine(`txn\nval(${quoted}) = ${quoted}`, 2).compare;
      expect(compare && hex(compare.key.bytes)).toBe(hex(bytes));
      expect(compare && hex(compare.value.bytes)).toBe(hex(bytes));
    },
  );

  test("a word's text is its bytes as UTF-8, marked where they are not", () => {
    const [, , value] = bodyLine('txn\n\nput k "\\xffa"', 3).words ?? [];
    expect(value.text).toBe("\ufffda");
    expect(hex(value.bytes)).toBe("ff61");
    expect(fromHex("ff61")).toEqual(value.bytes);
  });

  test("a word's text keeps a leading U+FEFF, which a default decoder would drop", () => {
    const [, , value] = bodyLine('txn\n\nput k "\\ufeffa"', 3).words ?? [];
    expect(value.text).toBe("\ufeffa");
    expect(hex(value.bytes)).toBe("efbbbf61");
  });
});
