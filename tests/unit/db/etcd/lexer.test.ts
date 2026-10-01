/**
 * The etcd editor text read as words (spec 3.3, 5.1.1, 5.1.2, 5.1.4, 6.4).
 *
 * Every rule of the two word rules is a row here, and every row was measured before it was
 * written: the shell rows against bash 5.2.21, dash and zsh 5.9, the txn rows against etcdctl
 * v3.7.2's own `txn` (the bytes pinned in tests/fixtures/etcd/grammar-corpus.ts). A refusal is
 * pinned with its whole sentence, because the sentence is what the user reads in the editor.
 *
 * The corpus near the end is the one the tokens provider's test reads too, so the editor and the
 * parser are held to the same word boundaries, sections and bytes (R11 ARCH-9). The last section
 * holds the refresh pattern the lexer builds from these rules to the parser (spec 6.2).
 */
import { describe, expect, test } from "bun:test";
import { type EtcdParseLimits, parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import { ETCD_READ_BOUNDS } from "@/lib/db/providers/keyvalue/etcd/execute";
import {
  ETCD_SCHEMA_REFRESH_PATTERN,
  holdsUnprintedRune,
  INITIAL_LEX_STATE,
  isFlagText,
  type LexLeadWord,
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
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { shouldRefreshSchema } from "@/lib/query-generators";
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

/** The state tokenizeLine leaves after each of `lines`, as the editor's tokens provider keeps one per line. */
function statesAfter(lines: readonly string[]): LexState[] {
  let state = INITIAL_LEX_STATE;
  return lines.map((line) => {
    state = tokenizeLine(line, state).state;
    return state;
  });
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
  ["a lone =, and an = followed only by empty quotes, is data", "put k = =''", ["put", "k", "=", "="]],
  [
    "a quoted or escaped = that begins a word is data, and so is an = inside a word",
    "put k \\=ls '='ls x==ls",
    ["put", "k", "=ls", "=ls", "x==ls"],
  ],
  ["a ~ not right after the = or a : of a NAME= word is data", "put k a=b~c a=x:y~", ["put", "k", "a=b~c", "a=x:y~"]],
  [
    "a ~ after a quoted or escaped : of a NAME= word, or itself quoted or escaped, is data",
    "put k a=b':'~/x a=b\\:~/y a=\\~/z a='~'/w",
    ["put", "k", "a=b:~/x", "a=b:~/y", "a=~/z", "a=~/w"],
  ],
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
  ["a form feed and a vertical tab are data, not separators", "put k a\fb c\vd", ["put", "k", "a\fb", "c\vd"]],
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
const equals = (line: number, column: number) =>
  `Studio runs no shell, so it refuses the = that begins the word at line ${line}, column ${column}, which zsh expands to a command's path: write the word between single quotes to keep it as written.`;
const braces = (line: number, column: number) =>
  `Studio runs no shell, so it refuses the braces in the word at line ${line}, column ${column}, which a shell may expand into several words: write the word between single quotes to keep it as written.`;
const operator = (char: string, line: number, column: number) =>
  `Studio runs one etcdctl command and no shell, so it refuses the ${char} at line ${line}, column ${column}: write the text between single quotes to keep it as written.`;

/**
 * The spec's list (a name, a digit, {, (, @, *, #, ?, -, $ and ! after a $) plus what the
 * measurement found it missed: bash and zsh read $'..' as ANSI-C quoting, bash reads $".." and
 * $[..], zsh reads $=x, $^x, $~x and $+x, bash (outside POSIX mode) expands a ~ after the = or a :
 * of a NAME= word, zsh expands a word that begins with an unquoted = and holds more than it to a
 * command's path, and bash and zsh expand braces holding a comma or "..".
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
  // Measured: bash 5.2.21 echoed a1=~/x and A1_B2=~/y with the ~ expanded, and 1a=~/z as written.
  [
    "a ~ after the = of a NAME= word whose name holds a digit",
    "put k a1=~/x",
    "shell-expansion",
    6,
    assignmentTilde(1, 7),
  ],
  ["a ~ right after a : of a NAME= word", "put k a=b:~/x", "shell-expansion", 6, assignmentTilde(1, 7)],
  // Measured: zsh 5.9 read =ls, ='ls' and =l"s" as /usr/bin/ls and failed on =nosuchcmd, == and =/x with
  // "not found", under -c, under -i and in a script, where bash 5.2.21 and dash passed each as written.
  ["an = that begins a word (zsh)", "put k =ls", "shell-expansion", 6, equals(1, 7)],
  ["an = that begins a word whose rest is quoted (zsh)", "put k ='ls'", "shell-expansion", 6, equals(1, 7)],
  ["an = that begins a key (zsh)", "get =ls", "shell-expansion", 4, equals(1, 5)],
  ["== (zsh)", "put k ==", "shell-expansion", 6, equals(1, 7)],
  ["braces holding a comma", "put k {a,b}", "shell-expansion", 6, braces(1, 7)],
  ["braces holding ..", "put k {1..3}", "shell-expansion", 6, braces(1, 7)],
  ["braces inside a word", "put k x{a,b}y", "shell-expansion", 6, braces(1, 7)],
  ["nested braces whose inner pair holds the comma", "put k {a{b,c}}", "shell-expansion", 6, braces(1, 7)],
  ["an empty alternative", "put k {a,}", "shell-expansion", 6, braces(1, 7)],
  ["unquoted JSON with a comma, which bash splits in two", 'put k {"a":1,"b":2}', "shell-expansion", 6, braces(1, 7)],
  // Measured: zsh 5.9 expands a sequence whatever the quoting of its dots ({1.'.'3}, {1'..'3} and {1\..3}
  // each gave 1, 2 and 3), where bash 5.2.21 and dash pass the text as written.
  ["a sequence with a quoted dot, which zsh expands", "put k {1.'.'3}", "shell-expansion", 6, braces(1, 7)],
  ["a sequence with both dots quoted, which zsh expands", "put k {1'..'3}", "shell-expansion", 6, braces(1, 7)],
  ["a sequence with an escaped dot, which zsh expands", "put k {1\\..3}", "shell-expansion", 6, braces(1, 7)],
  ["a sequence of letters with a quoted dot, which zsh expands", "put k {a.'.'c}", "shell-expansion", 6, braces(1, 7)],
  ["a sequence inside a word, which zsh expands", "put k x{1'..'3}y", "shell-expansion", 6, braces(1, 7)],
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
    // One prompt: a second $ is the command word.
    expect(split("$ $ get").lead).toEqual({ roles: ["prompt"], commandIndex: 1 });
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

  test("a name begins with a letter or _, goes on with letters, digits and _, and ends at an unquoted =, and only txn itself is txn", () => {
    expect(split("1A=2 get").lead).toEqual({ roles: [], commandIndex: 0 });
    // A word that begins with = holds no name; a lone = is the one such word the command line reads.
    expect(split("= get").lead).toEqual({ roles: [], commandIndex: 0 });
    expect(split("_A=2 get").lead).toEqual({ roles: ["assignment"], commandIndex: 1 });
    // Measured: bash 5.2.21, dash and zsh 5.9 each passed A1=x and A1_B2=3 to env as assignments.
    expect(split("A1=x get").lead).toEqual({ roles: ["assignment"], commandIndex: 1 });
    expect(sectionsOf("A1_B2=x txn\n")).toEqual(["command", "compares"]);
    expect(sectionsOf("txnx\n")).toEqual(["command", "after-command"]);
    expect(sectionsOf("t'x'n\n")).toEqual(["command", "compares"]);
  });

  test("an etcdctl word comes before the global flags, and after them it is the command word", () => {
    expect(split("--debug etcdctl get").lead).toEqual({ roles: ["flag"], commandIndex: 1 });
  });

  test("--command-timeout with no word after it takes nothing", () => {
    expect(split("--command-timeout").lead).toEqual({ roles: ["flag"], commandIndex: 1 });
  });

  test("a leading token or the command word may run over lines, and is read whole", () => {
    expect(split("%\\\n get a").lead).toEqual({ roles: ["prompt"], commandIndex: 1 });
    expect(split("A_NAME_LONGER_THAN_EIGH\\\nTEEN_UNITS=1 get a").lead).toEqual({
      roles: ["assignment"],
      commandIndex: 1,
    });
    expect(split("/opt/a/long/path/to/et\\\ncdctl get a").lead).toEqual({ roles: ["etcdctl"], commandIndex: 1 });
    expect(split("--command-\\\ntimeout 5s get a").lead).toEqual({ roles: ["flag", "flag-value"], commandIndex: 2 });
    expect(sectionsOf('tx\\\nn\nmod("k") > "0"')).toEqual(["command", "command", "compares"]);
    expect(sectionsOf("ETCDCTL_API='3\n' txn\n")).toEqual(["command", "command", "compares"]);
    // A newline inside quotes is part of the word, so this command word is not txn.
    expect(sectionsOf("'tx\nn'\nx")).toEqual(["command", "command", "after-command"]);
  });

  test("a leading word split by a backslash-newline anywhere reads as the word whole", () => {
    const words = [
      "$",
      "env",
      "ETCDCTL_API=3",
      "A_NAME_LONGER_THAN_EIGHTEEN_UNITS=1",
      "A1_B2=3",
      "1A=2",
      "etcdctl",
      "./etcdctl",
      "/usr/local/bin/etcdctl",
      "/opt/etcdctl-3.7/bin/etcdctl",
      "--command-timeout",
      "--command-timeout=5s",
      "--debug",
      "-",
      "txn",
      "get",
    ];
    for (const word of words) {
      const whole = `${word} 5s txn`;
      for (let at = 1; at < word.length; at++) {
        const text = `${word.slice(0, at)}\\\n${word.slice(at)} 5s txn`;
        expect(split(text).lead).toEqual(split(whole).lead);
        expect(sectionsOf(`${text}\n`).pop()).toBe(sectionsOf(`${whole}\n`).pop());
      }
    }
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
    // The line a first word begins on and runs past is a command line, though it finishes no word.
    expect(rolesOf("'ge\nt' k")).toEqual(["command", "command"]);
    expect(rolesOf("ge\\\nt k")).toEqual(["command", "command"]);
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
  // Measured with Go 1.27: strconv.Unquote refuses \udfff, the last surrogate, as it refuses \ud800.
  ["\\u may not name the last surrogate either", '"\\udfff"', "\\udfff"],
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

/**
 * Go's unicode.IsSpace, the set strings.TrimSpace trims and fmt's scanner splits on, but for LF and CR,
 * which end the line before either reads it. Measured with Go 1.27 for each: TrimSpace("x"+c) is "x", and
 * fmt.Sscanf of `"k") >` + c + `"0"` with "%q) %s %q" reads the operator > and the value 0.
 */
const GO_SPACES: readonly number[] = [
  0x09, 0x0b, 0x0c, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];

describe("Go's space set, where a txn line is trimmed and a compare is split (spec 5.1.4)", () => {
  test.each(GO_SPACES.map((code) => [code.toString(16).padStart(4, "0"), String.fromCharCode(code)] as const))(
    "U+%s",
    (_code, space) => {
      // Trimmed from the end of a request line, where Argify alone would keep it in the last word.
      expect(requestBytes(`put k x${space}`)[2]).toBe("78");
      // It separates a compare's operator from its value, and the ) from the operator.
      expect(compareOf(`mod("k") >${space}"0"`)).toMatchObject({ operator: ">", value: "30" });
      expect(compareOf(`mod("k")${space}> "0"`)).toMatchObject({ operator: ">", value: "30" });
      // So a word ending in it is quoted, and reads back whole as the last word of a request line.
      const quoted = quoteTxnWord(utf8(`x${space}`));
      expect(quoted).not.toBe(`x${space}`);
      expect(requestBytes(`put k ${quoted}`)[2]).toBe(hex(utf8(`x${space}`)));
    },
  );

  test("U+200B, which Go does not count as a space, is kept at a line's end and splits nothing", () => {
    expect(requestBytes("put k x\u200b")[2]).toBe(hex(utf8("x\u200b")));
    expect(bodyLine('txn\nmod("k") >\u200b"0"', 2).refusal?.message).toBe(
      compareShape(2, "no value follows the operator"),
    );
    expect(bodyLine('txn\nmod("k")\u200b> "0"', 2).refusal?.message).toBe(compareShape(2, "no space follows the )"));
  });
});

// ============================================================================
// 3.3: tokenizeLine and its state, as the tokens provider calls it
// ============================================================================

describe("tokenizeLine (spec 3.3)", () => {
  test("the initial state is the command line with nothing open and no word read", () => {
    expect(INITIAL_LEX_STATE).toEqual({
      section: "command",
      quote: "none",
      continued: false,
      inWord: false,
      lead: "prompt",
    });
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

  test("a refused $ inside double quotes is invalid, not a string", () => {
    expect(tokenizeLine('put k "a$x"', INITIAL_LEX_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "word", start: 4, end: 5 },
      { kind: "whitespace", start: 5, end: 6 },
      { kind: "string", start: 6, end: 8 },
      { kind: "invalid", start: 8, end: 9 },
      { kind: "string", start: 9, end: 11 },
    ]);
  });

  test("a flag word is drawn as a flag on the line it begins, and as a word on the lines it runs on to", () => {
    const open = tokenizeLine("put k --a\\", INITIAL_LEX_STATE);
    expect(open.tokens.slice(-1)).toEqual([{ kind: "flag", start: 6, end: 10 }]);
    expect(tokenizeLine("b", open.state).tokens).toEqual([{ kind: "word", start: 0, end: 1 }]);
  });

  test("a backslash-newline between words is whitespace", () => {
    expect(tokenizeLine("get \\", INITIAL_LEX_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 5 },
    ]);
  });

  test("a quote open at the end of a line carries into the next, as a string", () => {
    const first = tokenizeLine("put k 'ab", INITIAL_LEX_STATE);
    // The command word is read, so of the open word the state keeps only that it is open.
    expect(first.state).toEqual({
      section: "command",
      quote: "single",
      continued: false,
      inWord: true,
      lead: "command",
    });
    const second = tokenizeLine("cd' e", first.state);
    expect(second.tokens).toEqual([
      { kind: "string", start: 0, end: 3 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "word", start: 4, end: 5 },
    ]);
    expect(second.state).toEqual({ ...INITIAL_LEX_STATE, section: "after-command" });
  });

  test("a double quote open at the end of a line carries a newline, and a backslash-newline carries none", () => {
    const open = tokenizeLine('put k "a', INITIAL_LEX_STATE).state;
    expect(open).toMatchObject({ quote: "double", continued: false });
    const escaped = tokenizeLine('put k "a\\', INITIAL_LEX_STATE).state;
    expect(escaped).toMatchObject({ quote: "double", continued: true });
    expect(commandWords('put k "a\nb"')[2]).toBe("a\nb");
    expect(commandWords('put k "a\\\nb"')[2]).toBe("ab");
  });

  test("a backslash-newline carries where the words stand, and whether one is open", () => {
    const after = { section: "command", quote: "none", continued: true, lead: "command" } as const;
    expect(tokenizeLine("get \\", INITIAL_LEX_STATE).state).toEqual({ ...after, inWord: false });
    expect(tokenizeLine("get ab\\", INITIAL_LEX_STATE).state).toEqual({ ...after, inWord: true });
  });

  test("before the command word the state keeps what the leading tokens read of an open word, and no more", () => {
    const open = tokenizeLine("etc\\", INITIAL_LEX_STATE).state;
    expect(open).toEqual({
      section: "command",
      quote: "none",
      continued: true,
      inWord: true,
      lead: "prompt",
      leadWord: { head: "etc", quoting: "uuu", tail: "", assignment: "name" },
    });
    expect(tokenizeLine("dctl txn", open).state.section).toBe("compares");
    // Its first 18 units, one more than --command-timeout; its longest end that /etcdctl begins with; whether
    // it begins NAME=.
    expect(tokenizeLine("ETCDCTL_API='x/etcd", INITIAL_LEX_STATE).state.leadWord).toEqual({
      head: "ETCDCTL_API=x/etcd",
      quoting: "uuuuuuuuuuuuqqqqqq",
      tail: "/etcd",
      assignment: "yes",
    });
    expect(tokenizeLine("ETCDCTL_API='x/etcdc", INITIAL_LEX_STATE).state.leadWord).toEqual({
      head: "ETCDCTL_API=x/etcd",
      quoting: "uuuuuuuuuuuuqqqqqq",
      tail: "/etcdc",
      assignment: "yes",
    });
    expect(tokenizeLine("'A'=\\", INITIAL_LEX_STATE).state.leadWord).toMatchObject({ assignment: "no" });
    // The value of --command-timeout is read by no leading token, so nothing of it is kept.
    expect(tokenizeLine("--command-timeout '5", INITIAL_LEX_STATE).state).toEqual({
      section: "command",
      quote: "single",
      continued: false,
      inWord: true,
      lead: "flag-value",
    });
  });

  test("the state inside a quoted value is the same on each of its lines, however they run", () => {
    const after = statesAfter(["put /app/cfg '", "a", "b", `${"x".repeat(80)} line 3`, '  {"key": 1},', "'"]);
    expect(lexStatesEqual(after[1], after[2])).toBe(true);
    expect(lexStatesEqual(after[2], after[3])).toBe(true);
    expect(lexStatesEqual(after[3], after[4])).toBe(true);
    expect(lexStatesEqual(after[4], after[5])).toBe(false);
  });

  test("a state's size does not grow with the number of lines it has read", () => {
    const size = (lines: readonly string[]) => JSON.stringify(statesAfter(lines)[lines.length - 1]).length;
    const numbered = (count: number, line: (index: number) => string) =>
      Array.from({ length: count }, (_, index) => line(index));
    // A quoted value after the command word, a quoted value in a leading assignment, and a run of
    // assignments joined by backslash-newlines, each read to ten lines and to a thousand.
    const value = (count: number) => ["put /app/cfg '", ...numbered(count, (index) => `{"key": "line ${index}"},`)];
    const assignment = (count: number) => ["FOO='", ...numbered(count, (index) => `line ${index}`)];
    const assignments = (count: number) => numbered(count, (index) => `A${index}=${index} \\`);
    for (const lines of [value, assignment, assignments]) expect(size(lines(1000))).toBe(size(lines(10)));
  });

  test("the command word decides the section after the command line", () => {
    expect(tokenizeLine("txn", INITIAL_LEX_STATE).state).toEqual({ ...INITIAL_LEX_STATE, section: "compares" });
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
    const open = tokenizeLine("ETCDCTL_API='x/etcd", INITIAL_LEX_STATE).state;
    expect(lexStatesEqual(open, tokenizeLine("ETCDCTL_API='x/etcd", INITIAL_LEX_STATE).state)).toBe(true);
    expect(lexStatesEqual(INITIAL_LEX_STATE, { ...INITIAL_LEX_STATE })).toBe(true);
    const changed: readonly Partial<LexState>[] = [
      { section: "compares" },
      { quote: "single" },
      { continued: true },
      { inWord: true },
      { lead: "flag" },
    ];
    for (const change of changed)
      expect(lexStatesEqual(INITIAL_LEX_STATE, { ...INITIAL_LEX_STATE, ...change })).toBe(false);
    expect(lexStatesEqual(open, { ...open, leadWord: undefined })).toBe(false);
    expect(lexStatesEqual({ ...open, leadWord: undefined }, open)).toBe(false);
    const word = open.leadWord as LexLeadWord;
    for (const field of ["head", "quoting", "tail"] as const) {
      expect(lexStatesEqual(open, { ...open, leadWord: { ...word, [field]: `${word[field]}x` } })).toBe(false);
    }
    expect(lexStatesEqual(open, { ...open, leadWord: { ...word, assignment: "no" } })).toBe(false);
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
    // A whole word's own refusals: a ~ that begins it, a ~ after the = of a NAME= word, braces a shell expands.
    expect(lexLogicalLine("put k ~/x", 0)).toEqual({
      ok: false,
      refusal: { code: "shell-expansion", line: 1, column: 6, message: tilde(1, 7) },
    });
    expect(lexLogicalLine("put k {a,b}", 0)).toEqual({
      ok: false,
      refusal: { code: "shell-expansion", line: 1, column: 6, message: braces(1, 7) },
    });
    expect(lexLogicalLine("put k A=~/x", 0)).toEqual({
      ok: false,
      refusal: { code: "shell-expansion", line: 1, column: 6, message: assignmentTilde(1, 7) },
    });
    // A word that runs over a backslash-newline is refused at its first character, on the line it starts on.
    expect(lexLogicalLine("put k ~a\\\nb", 0)).toEqual({
      ok: false,
      refusal: { code: "shell-expansion", line: 1, column: 6, message: tilde(1, 7) },
    });
    expect(lexLogicalLine("get 'x", 0)).toMatchObject({ ok: false, refusal: { code: "unclosed-quote" } });
    expect(lexLogicalLine("get x\\", 0)).toMatchObject({ ok: false, refusal: { code: "trailing-backslash" } });
    expect(lexLogicalLine("get \ud800", 0)).toMatchObject({ ok: false, refusal: { code: "not-text" } });
  });
});

// ============================================================================
// The quoting functions (spec 5.5, 6.4)
// ============================================================================

/**
 * Runes Go's strconv.IsPrint does not print, each with strconv.Quote("a" + rune + "b") as Go 1.27
 * (Unicode 17.0.0) printed it: format characters (a bidi override, a zero-width space, a soft hyphen, an
 * isolate, a tag, the Arabic letter mark, the Mongolian vowel separator, an interlinear annotation), an
 * ASCII control and two C1 controls (U+0080, the first rune past ASCII, and U+0090), private use,
 * unassigned code points and a noncharacter, and spaces. Bun 1.4.2 and Node 24.14.0 classify every scalar
 * value as Go 1.27 does (measured over all of them).
 */
const NOT_PRINTED: readonly [name: string, char: string, goQuoted: string][] = [
  ["U+001F, an ASCII control", "\u001f", '"a\\x1fb"'],
  ["U+0080, a C1 control and the first rune past ASCII", "\u0080", '"a\\u0080b"'],
  ["U+FFFF, a noncharacter", "\uffff", '"a\\uffffb"'],
  ["U+202E, a right-to-left override", "\u202e", '"a\\u202eb"'],
  ["U+200B, a zero-width space", "\u200b", '"a\\u200bb"'],
  ["U+00AD, a soft hyphen", "\u00ad", '"a\\u00adb"'],
  ["U+2066, a left-to-right isolate", "\u2066", '"a\\u2066b"'],
  ["U+E0001, a language tag", "\u{e0001}", '"a\\U000e0001b"'],
  ["U+061C, the Arabic letter mark", "\u061c", '"a\\u061cb"'],
  ["U+180E, the Mongolian vowel separator", "\u180e", '"a\\u180eb"'],
  ["U+FFF9, an interlinear annotation anchor", "\ufff9", '"a\\ufff9b"'],
  ["U+FEFF, a byte order mark", "\ufeff", '"a\\ufeffb"'],
  ["U+0090, a C1 control", "\u0090", '"a\\u0090b"'],
  ["U+E000, private use", "\ue000", '"a\\ue000b"'],
  ["U+0378, unassigned", "\u0378", '"a\\u0378b"'],
  ["U+10FFFF, unassigned in the last plane", "\u{10ffff}", '"a\\U0010ffffb"'],
  ["U+3000, an ideographic space", "\u3000", '"a\\u3000b"'],
  ["U+2029, a paragraph separator", "\u2029", '"a\\u2029b"'],
];

/** Runes Go prints as themselves: letters, marks, numbers, punctuation and symbols past ASCII. */
const PRINTED: readonly [name: string, char: string, goQuoted: string][] = [
  ["U+00E9, a letter", "é", '"aéb"'],
  ["U+1D11E, a symbol past the first plane", "𝄞", '"a𝄞b"'],
  ["U+0301, a combining mark", "\u0301", '"a\u0301b"'],
  ["U+00BF, a punctuation mark", "\u00bf", '"a\u00bfb"'],
  ["U+00B2, a superscript digit", "\u00b2", '"a\u00b2b"'],
  ["U+0663, an Arabic-Indic digit", "\u0663", '"a\u0663b"'],
];

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
  "=ls",
  "a=b",
  "/app/config/",
  "/registry/pods/default/nginx",
  ...NOT_PRINTED.map(([, char]) => `/app/${char}x`),
  ...PRINTED.map(([, char]) => `/app/${char}x`),
];

describe("holdsUnprintedRune, Go's strconv.IsPrint over a text (spec 5.5)", () => {
  test.each(NOT_PRINTED)("a text holding %s holds a rune Go's %%q escapes", (_name, char) => {
    expect(holdsUnprintedRune(`a${char}b`)).toBe(true);
    expect(holdsUnprintedRune(char)).toBe(true);
  });

  test.each(["\u0000", "\n", "\t", "\u007f"])("the ASCII control %j is one too", (char) => {
    expect(holdsUnprintedRune(`a${char}`)).toBe(true);
  });

  test.each(PRINTED)("a text of %s and printable ASCII holds none", (_name, char) => {
    expect(holdsUnprintedRune(`a${char}b`)).toBe(false);
  });

  test("printable ASCII, the space, the quote and the backslash among it, holds none", () => {
    let ascii = "";
    for (let code = 0x20; code < 0x7f; code++) ascii += String.fromCharCode(code);
    expect(holdsUnprintedRune(ascii)).toBe(false);
    expect(holdsUnprintedRune("")).toBe(false);
  });
});

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
    // Glob characters are not in the bare set: zsh 5.9 refused a bare ?, [a] and [a in an empty directory, where
    // bash and dash passed them (measured). Nor are ! and ].
    ["*", "'*'"],
    ["?", "'?'"],
    ["[a]", "'[a]'"],
    ["[a", "'[a'"],
    ["a]", "'a]'"],
    ["!", "'!'"],
    // zsh expands a word that begins with = and holds more than it to a command's path: a bare =ls read /usr/bin/ls
    // in zsh 5.9, and == failed with "= not found" (measured), where bash and dash passed both as written; a lone =
    // is quoted as well, which reads back the same.
    ["=ls", "'=ls'"],
    ["==", "'=='"],
    ["=", "'='"],
  ])("%j is single-quoted as %j", (text, quoted) => {
    expect(quoteWord(text)).toBe(quoted);
  });

  test.each(NOT_PRINTED)("a word holding %s is single-quoted, never left bare", (_name, char) => {
    expect(quoteWord(`/app/${char}x`)).toBe(`'/app/${char}x'`);
  });

  test.each(PRINTED)("a word holding %s may stay bare", (_name, char) => {
    expect(quoteWord(`/app/${char}x`)).toBe(`/app/${char}x`);
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
    expect(quoteTxnWord(utf8("=ls"))).toBe('"=ls"');
    expect(quoteTxnWord(utf8("a=b"))).toBe("a=b");
    expect(quoteTxnWord(new Uint8Array([0xff]))).toBe('"\\xff"');
  });

  test("Go quoting escapes what etcdctl would not read back literally", () => {
    expect(quoteGoString(utf8("k"))).toBe('"k"');
    expect(quoteGoString(utf8('\u0007\b\f\n\r\t\v\\"'))).toBe('"\\a\\b\\f\\n\\r\\t\\v\\\\\\""');
    expect(quoteGoString(utf8("\u0000\u0001\u007f"))).toBe('"\\x00\\x01\\x7f"');
    expect(quoteGoString(utf8("\u0085\u00a0\u2028\ufeff"))).toBe('"\\u0085\\u00a0\\u2028\\ufeff"');
    expect(quoteGoString(utf8("é日本𝄞$'"))).toBe('"é日本𝄞$\'"');
  });

  /**
   * strconv.Quote of bytes that are not all UTF-8, as Go 1.27 printed it: each byte that begins no character
   * (a lead that cannot begin one, an overlong or surrogate form, a code point past U+10FFFF, a sequence cut
   * short) as \xNN, one byte at a time, and every character around them as Go writes a character.
   */
  test.each([
    ["61ffc3a90a", '"a\\xffé\\n"'],
    ["e697a5ff", '"日\\xff"'],
    ["61e280aeff", '"a\\u202e\\xff"'],
    ["f09d849eff", '"𝄞\\xff"'],
    ["ffc3a9", '"\\xffé"'],
    ["efbbbfff", '"\\ufeff\\xff"'],
    ["c0af", '"\\xc0\\xaf"'],
    ["e08080", '"\\xe0\\x80\\x80"'],
    ["eda080", '"\\xed\\xa0\\x80"'],
    ["f4908080", '"\\xf4\\x90\\x80\\x80"'],
    ["f09f", '"\\xf0\\x9f"'],
    ["e241", '"\\xe2A"'],
    ["2fffe2fe2f", '"/\\xff\\xe2\\xfe/"'],
  ])("the bytes %s are quoted as strconv.Quote quotes them, %s", (bytes, goQuoted) => {
    expect(quoteGoString(fromHex(bytes))).toBe(goQuoted);
    expect(quoteTxnWord(fromHex(bytes))).toBe(goQuoted);
  });

  // Characters at the edges of the UTF-8 lengths (U+007F, U+07FF, U+0800, U+FFF9 and U+10000), each followed by
  // another, as Go 1.27's strconv.Quote printed them: a character's span is read from its first byte.
  test.each([
    ["7f41", '"\\x7fA"'],
    ["dfbf41", '"\u07ffA"'],
    ["e0a08041", '"\u0800A"'],
    ["efbfb941", '"\\ufff9A"'],
    ["f090808041", '"\u{10000}A"'],
  ])("the bytes %s are quoted as %s, one character at a time", (bytes, goQuoted) => {
    expect(quoteGoString(fromHex(bytes))).toBe(goQuoted);
  });

  test.each(NOT_PRINTED)(
    "%s is escaped as Go's %%q escapes it, so the text shown is the text typed",
    (_name, char, goQuoted) => {
      expect(quoteGoString(utf8(`a${char}b`))).toBe(goQuoted);
      expect(quoteTxnWord(utf8(`a${char}b`))).toBe(goQuoted);
    },
  );

  test.each(PRINTED)("%s is printed as itself, as Go's %%q prints it", (_name, char, goQuoted) => {
    expect(quoteGoString(utf8(`a${char}b`))).toBe(goQuoted);
    expect(quoteTxnWord(utf8(`a${char}b`))).toBe(`a${char}b`);
  });

  // strconv.Quote of each rune alone, as Go 1.27 printed it: an ASCII control as \x, a noncharacter as \u, and
  // two runes past ASCII that are numbers, so Go prints them and a txn word may hold them bare.
  test.each([
    ["U+001F", "\u001f", '"\\x1f"', '"\\x1f"'],
    ["U+FFFF", "\uffff", '"\\uffff"', '"\\uffff"'],
    ["U+00B2", "\u00b2", '"\u00b2"', "\u00b2"],
    ["U+0663", "\u0663", '"\u0663"', "\u0663"],
  ])(
    "%s alone is Go-quoted as %%q quotes it, and bare in a txn only where Go prints it",
    (_name, char, goQuoted, txnWord) => {
      expect(quoteGoString(utf8(char))).toBe(goQuoted);
      expect(quoteTxnWord(utf8(char))).toBe(txnWord);
    },
  );

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

// ============================================================================
// 6.2: the refresh pattern
// ============================================================================

/**
 * The pattern the provider declares as `schemaRefreshPattern`, built in the lexer from the word rules it restates,
 * held to the parser: a text reloads the tree exactly when it parses to a put, del, txn, lease grant or lease
 * revoke, but for the limits its docblock states (spec 5.1.1, 5.1.2, 6.2).
 */
describe("the refresh pattern, held to the parser (spec 5.1.1, 5.1.2, 6.2)", () => {
  /** The bounds the provider parses a command under (keyvalue/etcd/index.ts `parseLimits`), at a 5 s query timeout. */
  const LIMITS: EtcdParseLimits = {
    maxLimit: DEFAULT_QUERY_LIMIT,
    txnRangeLimit: ETCD_READ_BOUNDS.firstPageSize,
    maxCommandTimeoutMs: 5_000,
    maxWatchWindowMs: 5_000 - ETCD_READ_BOUNDS.watchMarginMs,
  };

  test("the refresh pattern agrees with the parser on writes and reads whose words are quoted, escaped or joined across lines, or whose path to etcdctl holds blanks (spec 5.1.1, 5.1.2, 6.2)", () => {
    const pattern = ETCD_SCHEMA_REFRESH_PATTERN;
    const refreshing: ReadonlySet<string> = new Set(["put", "del", "txn", "lease-grant", "lease-revoke"]);
    const texts = [
      // A line join among the blanks between two words, the documented multi-line forms among them.
      "ETCDCTL_API=3 etcdctl \\\n  del /app/x",
      "etcdctl \\\nput /newgroup/a v",
      "etcdctl \\\r\nput /newgroup/a v",
      "etcdctl\\\n  put /app/x v",
      "etcdctl --command-timeout=5s \\\n  del /app/x",
      "etcdctl \\\n  --command-timeout=5s \\\n  put /app/x v",
      "--command-timeout \\\n5s put /a b",
      "$ \\\nput /a b",
      "  \\\n  put /a b",
      "lease \\\ngrant 60",
      "lease\\\n revoke 694d77aa9e38260f",
      "lease --command-timeout 5s \\\ngrant 60",
      // A line join before the blanks between two words and another after them.
      "etcdctl\\\n \\\nput /a b",
      "lease\\\r\n\t\\\r grant 60",
      // A path to etcdctl that holds blanks, quoted or escaped, a quoted line break or a no-break space, its last
      // slash bare, escaped or in quotes.
      '"/opt/my tools/etcdctl" put /a b',
      "/opt/my\\ tools/etcdctl del /a",
      "'/Applications/etcd tools/etcdctl' lease revoke 694d77aa9e38260f",
      "'/opt/my tools/'etcdctl put /a b",
      "/usr/local/bin\\/etcdctl put /a b",
      '"/usr/bin\\/etcdctl" put /a b',
      '"/opt/my\ttools/etc"dctl lease grant 60',
      "/opt/'my tools'/etcdctl \\\n  del /a",
      "'/opt/my\ntools/etcdctl' put /a b",
      "/opt/my\u00a0tools/etcdctl put /a b",
      '$ env ETCDCTL_API=3 "/opt/my tools/etcdctl" --command-timeout=5s txn\nmod("/a") > "0"\n\nput /a b\n\n',
      // Quote marks and escapes inside a word, which the lexer removes.
      "'put' /app/x v",
      '"del" /a',
      "p'ut' /a b",
      "pu\\t /a b",
      "'lease' 'grant' 60",
      '\'txn\'\nmod("/a") > "0"\n\nput /a b\n\n',
      "ETCDCTL_API='3' etcdctl put /a b",
      'ETCDCTL_API="3" put /a b',
      "'env' ETCDCTL_API=3 put /a b",
      '"./etcdctl" put /a b',
      "/usr/local/bin/'etcdctl' del /a",
      "'--command-timeout'=5s put /a b",
      // A comment line that a lone CR ends, as the lexer ends a line at a CRLF, a CR or an LF.
      "# a comment\rput /a b",
      "# c\rdel /a",
      "# c\rlease grant 60",
      "\\\r# c\rput /a b",
      // A comment line whose first word is a path to etcdctl followed by a write, above a read.
      "#/usr/bin/etcdctl del /a\nget /a",
      // A command word followed by a character other than a blank, which the lexer keeps in the word, here a path
      // to etcdctl.
      "put\u00a0/etcdctl get /a",
      "del\f/etcdctl member list",
      "put\u2028/etcdctl get /a",
      // The same spellings around a command that writes nothing, and a key named like a verb.
      "etcdctl \\\nget /app/del",
      "'get' /app/put",
      "ETCDCTL_API='3' etcdctl get /put",
      "get \\\n  put",
      "lease \\\nkeep-alive --once 694d8147df1dc4c8",
      "lease 'timetolive' 694d8147df1dc4c8",
      "etcdctl \\\n  member list",
      "etcdctl\\\n \\\nget /app/del",
      '"/opt/my tools/etcdctl" get /put',
      "/opt/my\\ tools/etcdctl member list",
      "'/opt/my tools/'etcdctl lease list",
    ];
    const parsed = texts.map((text) => {
      const result = parseEtcdCommand(text, LIMITS);
      if (!result.ok) throw new Error(`${JSON.stringify(text)} is refused: ${result.refusal.message}`);
      return { text, refreshes: refreshing.has(result.parsed.command.kind) };
    });
    expect(texts.map((text) => ({ text, refreshes: shouldRefreshSchema(text, pattern) }))).toEqual(parsed);
    // The corpus holds texts on both sides of the pattern.
    expect(parsed.filter((entry) => entry.refreshes).length).toBeGreaterThan(0);
    expect(parsed.filter((entry) => !entry.refreshes).length).toBeGreaterThan(0);
  });

  test("the refresh pattern's stated limits: a line join inside a word, two side by side or after a second run of blanks, and a quoted path that holds a write command (spec 6.2)", () => {
    const pattern = ETCD_SCHEMA_REFRESH_PATTERN;
    const reading = (text: string) => {
      const parsed = parseEtcdCommand(text, LIMITS);
      const kind = parsed.ok ? parsed.parsed.command.kind : parsed.refusal.message;
      return { text, kind, refreshes: shouldRefreshSchema(text, pattern) };
    };
    // Writes the parser runs after which the tree is not reloaded.
    const unread = [
      "pu\\\nt /a b",
      "/opt/my\\\ntools/etcdctl put /a b",
      '"/opt/my\\\ntools/etcdctl" put /a b',
      "etcdctl \\\n\\\nput /a b",
      "etcdctl\\\n\\\n put /a b",
      "etcdctl \\\n \\\nput /a b",
      "etcdctl\\\n \\\n \\\nput /a b",
    ];
    expect(unread.map(reading)).toEqual(unread.map((text) => ({ text, kind: "put", refreshes: false })));
    // A read the parser runs after which the tree is reloaded.
    const read = "'/etcdctl put /x/etcdctl' get /a";
    expect(reading(read)).toEqual({ text: read, kind: "get", refreshes: true });
  });

  test("the refresh pattern reads a path of 300,000 characters, which a pattern of one unit at a time stops matching in JavaScriptCore, the engine of Bun (spec 6.2)", () => {
    const pattern = ETCD_SCHEMA_REFRESH_PATTERN;
    const text = `/opt/${"x".repeat(300_000)}/etcdctl put /a b`;
    expect(parseEtcdCommand(text, LIMITS)).toMatchObject({ ok: true, parsed: { command: { kind: "put" } } });
    expect(shouldRefreshSchema(text, pattern)).toBe(true);
  });
});
