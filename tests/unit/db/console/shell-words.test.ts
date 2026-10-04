/**
 * The engine-neutral shell-word reader: the POSIX shell's quoting, the refusals of text a shell would expand or
 * reject, one command line per text, and the rule that the editor's line-by-line reading and the parser's
 * whole-text reading are one reading.
 */
import { describe, expect, test } from "bun:test";
import {
  INITIAL_SHELL_LINE_STATE,
  quoteShellWord,
  readShellCommand,
  type ShellLineState,
  type ShellRefusal,
  type ShellWord,
  shellLineStatesEqual,
  tokenizeShellLine,
} from "@/lib/db/console/shell-words";

function words(text: string): readonly ShellWord[] {
  const reading = readShellCommand(text);
  if (!reading.ok) throw new Error(`expected ${JSON.stringify(text)} to read, got: ${reading.refusal.message}`);
  return reading.words;
}

const texts = (text: string): string[] => words(text).map((word) => word.text);

function refusalOf(text: string): ShellRefusal {
  const reading = readShellCommand(text);
  if (reading.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return reading.refusal;
}

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
  `Studio runs one command and no shell, so it refuses the ${char} at line ${line}, column ${column}: write the text between single quotes to keep it as written.`;

/** Each refusal of SB2-2.3 with the text that meets it, its place, its sentence, and a quoted twin that reads. */
const REFUSALS: readonly [
  name: string,
  text: string,
  code: string,
  column: number,
  message: string,
  twin: string,
  twinWords: readonly string[],
][] = [
  ["a $ before a name", "get $HOME", "shell-expansion", 4, dollar(1, 5), "get '$HOME'", ["get", "$HOME"]],
  ["a $ inside double quotes", 'get "a$b"', "shell-expansion", 6, dollar(1, 7), 'get "a\\$b"', ["get", "a$b"]],
  ["a $ before a quote", "get $'a'", "shell-expansion", 4, dollar(1, 5), "get \\$'a'", ["get", "$a"]],
  ["a backquote", "get `ls`", "shell-expansion", 4, backquote(1, 5), "get '`ls`'", ["get", "`ls`"]],
  [
    "a backquote inside double quotes",
    'get "a `ls`"',
    "shell-expansion",
    7,
    backquote(1, 8),
    'get "a \\`ls\\`"',
    ["get", "a `ls`"],
  ],
  ["a ~ that begins a word", "get ~/x", "shell-expansion", 4, tilde(1, 5), "get '~/x'", ["get", "~/x"]],
  [
    "a ~ after the = of a NAME= word",
    "get a=~/x",
    "shell-expansion",
    4,
    assignmentTilde(1, 5),
    "get 'a=~/x'",
    ["get", "a=~/x"],
  ],
  [
    "a ~ after a : of a NAME= word",
    "get a=b:~/x",
    "shell-expansion",
    4,
    assignmentTilde(1, 5),
    "get a=b':'~/x",
    ["get", "a=b:~/x"],
  ],
  ["an = that begins a word", "get =ls", "shell-expansion", 4, equals(1, 5), "get '=ls'", ["get", "=ls"]],
  ["braces holding a comma", "get {a,b}", "shell-expansion", 4, braces(1, 5), "get '{a,b}'", ["get", "{a,b}"]],
  ["braces holding ..", "get {1..3}", "shell-expansion", 4, braces(1, 5), "get '{1..3}'", ["get", "{1..3}"]],
  [
    "braces holding a quoted dot, which zsh expands",
    "get {1.'.'3}",
    "shell-expansion",
    4,
    braces(1, 5),
    "get '{1..3}'",
    ["get", "{1..3}"],
  ],
  [";", "get a; get b", "shell-operator", 5, operator(";", 1, 6), "get 'a; get b'", ["get", "a; get b"]],
  ["&", "get a &", "shell-operator", 6, operator("&", 1, 7), "get a '&'", ["get", "a", "&"]],
  ["|", "get a | tee x", "shell-operator", 6, operator("|", 1, 7), "get a \\| tee x", ["get", "a", "|", "tee", "x"]],
  ["<", "get a < f", "shell-operator", 6, operator("<", 1, 7), 'get a "<" f', ["get", "a", "<", "f"]],
  [">", "get a > f", "shell-operator", 6, operator(">", 1, 7), "get a '>' f", ["get", "a", ">", "f"]],
  ["(", "get (a", "shell-operator", 4, operator("(", 1, 5), "get '(a'", ["get", "(a"]],
  [")", "get a)", "shell-operator", 5, operator(")", 1, 6), "get 'a)'", ["get", "a)"]],
];

describe("text a shell would expand or reject is refused, and its quoted twin reads", () => {
  test.each(REFUSALS)("%s", (_name, text, code, column, message, twin, twinWords) => {
    expect(refusalOf(text)).toEqual({ code, message, line: 1, column } as ShellRefusal);
    expect(texts(twin)).toEqual([...twinWords]);
  });

  test("a quote never closed names the word it opens in, single or double", () => {
    expect(refusalOf("get 'a")).toEqual({
      code: "unclosed-quote",
      line: 1,
      column: 4,
      message: "The single quote in the word at line 1, column 5 is never closed: close it before the end of the text.",
    });
    expect(refusalOf('get x"a\nb')).toEqual({
      code: "unclosed-quote",
      line: 1,
      column: 4,
      message: "The double quote in the word at line 1, column 5 is never closed: close it before the end of the text.",
    });
    expect(texts("get 'a'")).toEqual(["get", "a"]);
  });

  test("a backslash that ends the text is refused, inside a word or after a blank", () => {
    expect(refusalOf("get a\\")).toEqual({
      code: "trailing-backslash",
      line: 1,
      column: 5,
      message:
        "The backslash at line 1, column 6 ends the text and escapes nothing, which shells read differently (bash keeps it and zsh drops it): remove it, or write it between single quotes.",
    });
    expect(refusalOf("get a \\")).toMatchObject({ code: "trailing-backslash", line: 1, column: 6 });
    // Inside double quotes the open quote is the earlier problem.
    expect(refusalOf('get "a\\')).toMatchObject({ code: "unclosed-quote", line: 1, column: 4 });
    expect(texts("get 'a\\'")).toEqual(["get", "a\\"]);
  });

  test("a lone surrogate is refused first, wherever it stands, and a pair is a character", () => {
    expect(refusalOf("get a\ud800")).toEqual({
      code: "not-text",
      line: 1,
      column: 5,
      message: "The text holds a lone UTF-16 surrogate at line 1, column 6, which is not a character: remove it.",
    });
    // The $ on line 1 is earlier in the text; the surrogate is still the refusal.
    expect(refusalOf("get $x\nget \udc00")).toMatchObject({ code: "not-text", line: 2, column: 4 });
    expect(texts("get 𝄞")).toEqual(["get", "𝄞"]);
  });

  test("a line after the command line that is not blank or a comment is a second command", () => {
    expect(refusalOf("get a\n  list")).toEqual({
      code: "second-command",
      line: 2,
      column: 2,
      message:
        "Line 2 holds a second command: Studio runs one command per run. Select the line to run it, and the editor sends the selection.",
    });
    expect(refusalOf("# c\nget a\n\n# d\nget b\nget c")).toMatchObject({ code: "second-command", line: 5, column: 0 });
    expect(texts("# c\nget a\n\n  # d\n")).toEqual(["get", "a"]);
  });

  test("the earliest refusal in the text is the one reported, a word's own included", () => {
    // The braces are found only when the word ends, after the $ inside it was seen: still first.
    expect(refusalOf("get {a,b}$x").column).toBe(4);
    expect(refusalOf("get a$x ;").column).toBe(5);
    expect(refusalOf("get a\\\n$b")).toMatchObject({ line: 2, column: 0 });
    expect(refusalOf("get $a\nget b")).toMatchObject({ code: "shell-expansion", line: 1 });
    // A word's own refusal names the word's first line when the word spans lines.
    expect(refusalOf("get {a,\\\nb}")).toMatchObject({ code: "shell-expansion", line: 1, column: 4 });
    expect(refusalOf("get 'a\nb' $c")).toMatchObject({ code: "shell-expansion", line: 2, column: 3 });
  });
});

/** Each row measured with printf '[%s]' in bash, dash and zsh, which read it the same way. */
const WORD_RULES: readonly [rule: string, text: string, words: readonly string[]][] = [
  ["unquoted spaces and tabs separate words", "get  a\tb", ["get", "a", "b"]],
  ["single quotes keep everything", "get 'a $b `c` \\d \"e\" #f ~g'", ["get", 'a $b `c` \\d "e" #f ~g']],
  ['double quotes escape only ", \\, $ and a backquote', 'get "a\\"b\\\\c\\$d\\`e"', ["get", 'a"b\\c$d`e']],
  ["inside double quotes every other backslash is data", 'get "a\\qb\\nc"', ["get", "a\\qb\\nc"]],
  ["outside quotes a backslash escapes the next character", "get a\\ b\\'c\\#d", ["get", "a b'c#d"]],
  ["a $ at the end of a word is data", "get a$", ["get", "a$"]],
  ["a $ before a closing double quote is data", 'get "a$"', ["get", "a$"]],
  ["a $ before a blank is data", "get a$ b", ["get", "a$", "b"]],
  ["a $ before a blank inside double quotes is data", 'get "$ b"', ["get", "$ b"]],
  ["braces without a comma or .. are data", "get {a} a{b", ["get", "{a}", "a{b"]],
  ["quoted braces are data", "get '{a,b}' {a\\,b}", ["get", "{a,b}", "{a,b}"]],
  ["a lone = and an = inside a word are data", "get = x==y \\=ls", ["get", "=", "x==y", "=ls"]],
  ["a ~ inside a word is data", "get a~b a=b~c", ["get", "a~b", "a=b~c"]],
  ["a word whose name is quoted is no NAME= word", 'get "a"=~ 1a=~/x', ["get", "a=~", "1a=~/x"]],
  ["glob characters are data", "get /a/* ?x [y]", ["get", "/a/*", "?x", "[y]"]],
  ["adjacent parts join into one word", "get 'a'\"b\"c", ["get", "abc"]],
  ["two quotes make the empty word", "get '' \"\"", ["get", "", ""]],
  ["a single quote inside single quotes, as a shell writes it", "get 'it'\\''s'", ["get", "it's"]],
  ["a backslash-newline joins two lines inside a word", "get ab\\\ncd", ["get", "abcd"]],
  ["a backslash-newline between words joins nothing", "get \\\na b", ["get", "a", "b"]],
  ["a backslash-newline before a blank ends the word", "get ab\\\n cd", ["get", "ab", "cd"]],
  ["a backslash-newline that ends the text is removed", "get ab\\\n", ["get", "ab"]],
  ["inside double quotes a backslash-newline is removed", 'get "a\\\nb"', ["get", "ab"]],
  ["a single quote spanning two lines keeps the break", "get 'a\nb'", ["get", "a\nb"]],
  ["a double quote spanning two lines keeps the break", 'get "a\nb" c', ["get", "a\nb", "c"]],
  ["a # inside a word is data", "get /a#b", ["get", "/a#b"]],
  ["a # inside quotes is data", "get '#b' \"#c\" \\#d", ["get", "#b", "#c", "#d"]],
  ["a # after a blank starts a comment", "get my-key -v     # include the version metadata", ["get", "my-key", "-v"]],
  ["a # on its own line is a comment line, before and after", "# before\nget a\n# after", ["get", "a"]],
  ["a backslash in a comment continues nothing", "get a # c \\\n", ["get", "a"]],
  ["a # right after a backslash-newline inside a word is data", "get ab\\\n#c", ["get", "ab#c"]],
  ["a no-break space, a form feed and a vertical tab are data", "get a b c\fd e\vf", ["get", "a b", "c\fd", "e\vf"]],
  ["a U+0000 is data here", "get a\u0000b", ["get", "a\u0000b"]],
  ["a word that begins with - is a word", "get -- -a", ["get", "--", "-a"]],
  ["blank and comment lines only", "\n  \n# c\n", []],
  ["the empty text", "", []],
  ["nine words on one line", "a b c d e f g h i", ["a", "b", "c", "d", "e", "f", "g", "h", "i"]],
  ["a word that runs over three lines", "get a\\\nb\\\nc d", ["get", "abc", "d"]],
  ["an open quote over an empty line", "get 'a\n\nb'", ["get", "a\n\nb"]],
];

describe("the word rule", () => {
  test.each(WORD_RULES)("%s", (_rule, text, expected) => {
    expect(texts(text)).toEqual([...expected]);
  });

  test("CRLF, CR and LF line ends give the same words", () => {
    const lines = ["# c", "get 'a", "b' \\", "  c"];
    const expected = words(lines.join("\n"));
    expect(expected.map((word) => word.text)).toEqual(["get", "a\nb", "c"]);
    expect(words(lines.join("\r\n"))).toEqual(expected);
    expect(words(lines.join("\r"))).toEqual(expected);
  });

  test("a word carries where it starts and ends, and whether any of it was quoted or escaped", () => {
    expect(words("  get '' --pre\\\nfix a\\ b \"-x\"")).toEqual([
      { text: "get", quoted: false, line: 1, column: 2, endLine: 1, endColumn: 5 },
      { text: "", quoted: true, line: 1, column: 6, endLine: 1, endColumn: 8 },
      // A backslash-newline quotes nothing: the word is still a flag to a parser.
      { text: "--prefix", quoted: false, line: 1, column: 9, endLine: 2, endColumn: 3 },
      { text: "a b", quoted: true, line: 2, column: 4, endLine: 2, endColumn: 8 },
      { text: "-x", quoted: true, line: 2, column: 9, endLine: 2, endColumn: 13 },
    ]);
    // A word that ends with a backslash-newline on the last line ends at the backslash.
    expect(words("get ab\\\n")[1]).toEqual({ text: "ab", quoted: false, line: 1, column: 4, endLine: 1, endColumn: 7 });
  });

  test("a word quoted only on a line after its first is quoted", () => {
    expect(words("get -\\\n'-'")[1]).toEqual({
      text: "--",
      quoted: true,
      line: 1,
      column: 4,
      endLine: 2,
      endColumn: 3,
    });
  });
});

/** A word as the tokens draw it: every token that is not whitespace or a comment, joined while they touch. */
interface Span {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** A text read the way the editor reads it: line by line, each from the state the line before left. */
function spansByTokens(text: string): { readonly spans: Span[]; readonly indexes: (number | undefined)[] } {
  const spans: Span[] = [];
  const indexes: (number | undefined)[] = [];
  let state = INITIAL_SHELL_LINE_STATE;
  let open: Span | undefined;
  text.split(/\r\n|\r|\n/).forEach((lineText, index) => {
    const line = index + 1;
    const reading = tokenizeShellLine(lineText, state);
    let current = state.inWord ? open : undefined;
    const close = () => {
      if (current !== undefined) spans.push(current);
      current = undefined;
    };
    for (const token of reading.tokens) {
      if (token.kind === "whitespace" || token.kind === "comment") {
        close();
        continue;
      }
      if (current === undefined) {
        current = { line, column: token.start, endLine: line, endColumn: token.end };
        indexes.push(token.wordIndex);
      } else {
        current = { ...current, endLine: line, endColumn: token.end };
      }
    }
    if (reading.state.inWord) open = current;
    else close();
    state = reading.state;
  });
  return { spans, indexes };
}

describe("tokenizeShellLine and readShellCommand are one reading", () => {
  const readable = [...WORD_RULES.map(([, text]) => text), ...REFUSALS.map((row) => row[5])];

  test.each(readable.map((text) => [JSON.stringify(text), text] as const))(
    "%s: the tokens draw the words the parser reads",
    (_shown, text) => {
      const { spans, indexes } = spansByTokens(text);
      const read = words(text);
      expect(spans).toEqual(read.map(({ line, column, endLine, endColumn }) => ({ line, column, endLine, endColumn })));
      // A word's index is known for the first eight words, and absent past them.
      expect(indexes).toEqual(read.map((_word, index) => (index < 8 ? index : undefined)));
    },
  );

  test("a refused text still tokenizes, with the refused character marked invalid", () => {
    for (const [, text] of REFUSALS) {
      let state = INITIAL_SHELL_LINE_STATE;
      for (const line of text.split("\n")) state = tokenizeShellLine(line, state).state;
    }
    expect(tokenizeShellLine('get $x "a`b" c;d', INITIAL_SHELL_LINE_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3, wordIndex: 0 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "invalid", start: 4, end: 5, wordIndex: 1 },
      { kind: "word", start: 5, end: 6, wordIndex: 1 },
      { kind: "whitespace", start: 6, end: 7 },
      { kind: "string", start: 7, end: 9, wordIndex: 2 },
      { kind: "invalid", start: 9, end: 10, wordIndex: 2 },
      { kind: "string", start: 10, end: 12, wordIndex: 2 },
      { kind: "whitespace", start: 12, end: 13 },
      { kind: "word", start: 13, end: 14, wordIndex: 3 },
      { kind: "invalid", start: 14, end: 15 },
      { kind: "word", start: 15, end: 16, wordIndex: 4 },
    ]);
  });
});

describe("tokenizeShellLine", () => {
  test("the initial state is before the command line, with nothing open and no word read", () => {
    expect(INITIAL_SHELL_LINE_STATE).toEqual({
      section: "before",
      quote: "none",
      continued: false,
      inWord: false,
      wordsBefore: 0,
    });
    expect(Object.isFrozen(INITIAL_SHELL_LINE_STATE)).toBe(true);
  });

  test("a flag word is drawn as a flag where it begins, a quoted one as a string, and an escape as its word", () => {
    expect(tokenizeShellLine("get --prefix '--x' a\\ b # c", INITIAL_SHELL_LINE_STATE)).toEqual({
      tokens: [
        { kind: "word", start: 0, end: 3, wordIndex: 0 },
        { kind: "whitespace", start: 3, end: 4 },
        { kind: "flag", start: 4, end: 12, wordIndex: 1 },
        { kind: "whitespace", start: 12, end: 13 },
        { kind: "string", start: 13, end: 18, wordIndex: 2 },
        { kind: "whitespace", start: 18, end: 19 },
        { kind: "word", start: 19, end: 23, wordIndex: 3 },
        { kind: "whitespace", start: 23, end: 24 },
        { kind: "comment", start: 24, end: 27 },
      ],
      state: { section: "after", quote: "none", continued: false, inWord: false, wordsBefore: 0 },
    });
  });

  test("only a word that begins with an unquoted - is a flag, and its quoted parts stay strings", () => {
    expect(tokenizeShellLine("get '-'x -'a'b", INITIAL_SHELL_LINE_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3, wordIndex: 0 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "string", start: 4, end: 7, wordIndex: 1 },
      { kind: "word", start: 7, end: 8, wordIndex: 1 },
      { kind: "whitespace", start: 8, end: 9 },
      { kind: "flag", start: 9, end: 10, wordIndex: 2 },
      { kind: "string", start: 10, end: 13, wordIndex: 2 },
      { kind: "flag", start: 13, end: 14, wordIndex: 2 },
    ]);
  });

  test("touching tokens of one kind stay apart when only one belongs to a word", () => {
    expect(tokenizeShellLine("get $;", INITIAL_SHELL_LINE_STATE).tokens).toEqual([
      { kind: "word", start: 0, end: 3, wordIndex: 0 },
      { kind: "whitespace", start: 3, end: 4 },
      { kind: "invalid", start: 4, end: 5, wordIndex: 1 },
      { kind: "invalid", start: 5, end: 6 },
    ]);
  });

  test("blank and comment lines before the command line leave the initial state", () => {
    expect(tokenizeShellLine("", INITIAL_SHELL_LINE_STATE)).toEqual({ tokens: [], state: INITIAL_SHELL_LINE_STATE });
    expect(tokenizeShellLine("  # c", INITIAL_SHELL_LINE_STATE)).toEqual({
      tokens: [
        { kind: "whitespace", start: 0, end: 2 },
        { kind: "comment", start: 2, end: 5 },
      ],
      state: INITIAL_SHELL_LINE_STATE,
    });
  });

  test("a backslash-newline carries the words read so far, and whether one is open", () => {
    const between = tokenizeShellLine("get a \\", INITIAL_SHELL_LINE_STATE);
    // The blank and the backslash that joins the lines are one run of whitespace.
    expect(between.tokens[between.tokens.length - 1]).toEqual({ kind: "whitespace", start: 5, end: 7 });
    expect(between.state).toEqual({
      section: "command",
      quote: "none",
      continued: true,
      inWord: false,
      wordsBefore: 2,
    });
    const inside = tokenizeShellLine("get --pre\\", INITIAL_SHELL_LINE_STATE);
    expect(inside.tokens[inside.tokens.length - 1]).toEqual({ kind: "flag", start: 4, end: 10, wordIndex: 1 });
    expect(inside.state).toEqual({ section: "command", quote: "none", continued: true, inWord: true, wordsBefore: 1 });
    // The rest of the word is drawn as a word on the line it runs on to, under the same index.
    expect(tokenizeShellLine("fix b", inside.state)).toEqual({
      tokens: [
        { kind: "word", start: 0, end: 3, wordIndex: 1 },
        { kind: "whitespace", start: 3, end: 4 },
        { kind: "word", start: 4, end: 5, wordIndex: 2 },
      ],
      state: { section: "after", quote: "none", continued: false, inWord: false, wordsBefore: 0 },
    });
    // A lone backslash before any word opens the command line and reads none: a blank line after it ends nothing.
    const lone = tokenizeShellLine("\\", INITIAL_SHELL_LINE_STATE);
    expect(lone.state).toEqual({ section: "command", quote: "none", continued: true, inWord: false, wordsBefore: 0 });
    expect(tokenizeShellLine("", lone.state).state).toEqual(INITIAL_SHELL_LINE_STATE);
  });

  test("a quote open at the end of a line carries into the next, as a string", () => {
    const first = tokenizeShellLine("get 'a", INITIAL_SHELL_LINE_STATE);
    expect(first.state).toEqual({
      section: "command",
      quote: "single",
      continued: false,
      inWord: true,
      wordsBefore: 1,
    });
    expect(tokenizeShellLine("b' c", first.state)).toEqual({
      tokens: [
        { kind: "string", start: 0, end: 2, wordIndex: 1 },
        { kind: "whitespace", start: 2, end: 3 },
        { kind: "word", start: 3, end: 4, wordIndex: 2 },
      ],
      state: { section: "after", quote: "none", continued: false, inWord: false, wordsBefore: 0 },
    });
    const double = tokenizeShellLine('get "a\\', INITIAL_SHELL_LINE_STATE);
    expect(double.state).toEqual({
      section: "command",
      quote: "double",
      continued: true,
      inWord: true,
      wordsBefore: 1,
    });
    expect(tokenizeShellLine('b"', double.state).tokens).toEqual([{ kind: "string", start: 0, end: 2, wordIndex: 1 }]);
  });

  test("a line after the command line is whitespace, a comment, or content marked invalid", () => {
    const after = tokenizeShellLine("get a", INITIAL_SHELL_LINE_STATE).state;
    expect(tokenizeShellLine("   ", after)).toEqual({
      tokens: [{ kind: "whitespace", start: 0, end: 3 }],
      state: after,
    });
    expect(tokenizeShellLine("", after)).toEqual({ tokens: [], state: after });
    expect(tokenizeShellLine(" # c", after)).toEqual({
      tokens: [
        { kind: "whitespace", start: 0, end: 1 },
        { kind: "comment", start: 1, end: 4 },
      ],
      state: after,
    });
    expect(tokenizeShellLine(" get b", after)).toEqual({
      tokens: [
        { kind: "whitespace", start: 0, end: 1 },
        { kind: "invalid", start: 1, end: 6 },
      ],
      state: after,
    });
  });

  test("the words counted before a line stop at eight, and a word past them carries no index", () => {
    const first = tokenizeShellLine("a b c d e f g h i j \\", INITIAL_SHELL_LINE_STATE);
    expect(first.state.wordsBefore).toBe(8);
    const indexes = first.tokens.filter((token) => token.kind === "word").map((token) => token.wordIndex);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, undefined, undefined]);
    const second = tokenizeShellLine("k", first.state);
    expect(second.tokens).toEqual([{ kind: "word", start: 0, end: 1 }]);
  });

  test("the state stays the same size however long a word runs", () => {
    // A 100,000-character word across 1,000 lines: each line ends with a backslash-newline inside the word.
    const line = `${"a".repeat(99)}\\`;
    let state: ShellLineState = INITIAL_SHELL_LINE_STATE;
    const sizes = new Set<number>();
    const keys = new Set<string>();
    for (let index = 0; index < 1_000; index++) {
      state = tokenizeShellLine(line, state).state;
      sizes.add(JSON.stringify(state).length);
      keys.add(Object.keys(state).sort().join(","));
    }
    expect([...sizes]).toHaveLength(1);
    expect([...keys]).toEqual(["continued,inWord,quote,section,wordsBefore"]);
    expect(state).toEqual({ section: "command", quote: "none", continued: true, inWord: true, wordsBefore: 0 });
  });

  test("shellLineStatesEqual compares every field", () => {
    const base: ShellLineState = { section: "command", quote: "double", continued: true, inWord: true, wordsBefore: 3 };
    expect(shellLineStatesEqual(base, { ...base })).toBe(true);
    expect(shellLineStatesEqual(base, { ...base, section: "after" })).toBe(false);
    expect(shellLineStatesEqual(base, { ...base, quote: "single" })).toBe(false);
    expect(shellLineStatesEqual(base, { ...base, continued: false })).toBe(false);
    expect(shellLineStatesEqual(base, { ...base, inWord: false })).toBe(false);
    expect(shellLineStatesEqual(base, { ...base, wordsBefore: 4 })).toBe(false);
  });
});

/** A small deterministic generator (mulberry32), so a failure names a string that fails again. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Every character the reader treats specially, and text it does not, without CR, U+0000 or a lone surrogate. */
const ALPHABET: readonly string[] = [..."aB7_-./:@%+=,^ \t\n'\"\\$`~{};&|<>()#*?[]!", "é", "日", "𝄞", " ", "​", "﻿"];

describe("quoteShellWord", () => {
  test.each(["/app/config", "a-b_c.d:e@f%g+h=i,j^k", "-x", "é", "日本語", "0"])("%s stays bare", (text) => {
    expect(quoteShellWord(text)).toBe(text);
  });

  test.each([
    ["", "''"],
    ["a b", "'a b'"],
    ["it's", "'it'\\''s'"],
    ["=ls", "'=ls'"],
    ["=", "'='"],
    ["$HOME", "'$HOME'"],
    ["a*", "'a*'"],
    ["#c", "'#c'"],
    ["a\nb", "'a\nb'"],
    ["a b", "'a b'"],
    ["a​b", "'a​b'"],
  ])("%j is written between single quotes", (text, quoted) => {
    expect(quoteShellWord(text)).toBe(quoted);
  });

  test("2,000 generated strings read back as themselves", () => {
    const random = generator(20_261_004);
    for (let round = 0; round < 2_000; round++) {
      const length = Math.floor(random() * 13);
      let text = "";
      for (let index = 0; index < length; index++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      const reading = readShellCommand(`x ${quoteShellWord(text)}`);
      expect(reading.ok ? reading.words.map((word) => word.text) : reading.refusal.message).toEqual(["x", text]);
    }
  });

  test("a carriage return, a U+0000 and a lone surrogate have no spelling, so quoting each throws", () => {
    expect(() => quoteShellWord("a\rb")).toThrow(
      "A carriage return has no spelling on a command line, where the editor ends a line at it",
    );
    expect(() => quoteShellWord("a\u0000b")).toThrow(
      "A NUL character has no spelling on a command line: a shell ends a word at it",
    );
    expect(() => quoteShellWord("a\ud800")).toThrow("A lone UTF-16 surrogate is not text, so no quoting reads it back");
  });
});
