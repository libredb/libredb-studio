/**
 * The Oxia editor text as words and as the editor draws it (SB2-3.1): the lead a docs line carries before its verb,
 * the role of each token, and the rule that the line-by-line reading draws the lead and the verb the whole-text
 * reading finds.
 */
import { describe, expect, test } from "bun:test";
import type { ShellLineState, ShellWord } from "@/lib/db/console/shell-words";
import { INITIAL_SHELL_LINE_STATE, readShellCommand } from "@/lib/db/console/shell-words";
import {
  INITIAL_OXIA_LEX_STATE,
  OXIA_PROMPTS,
  OXIA_VALUE_GLOBAL_FLAGS,
  type OxiaToken,
  oxiaWords,
  tokenizeOxiaLine,
} from "@/lib/db/providers/keyvalue/oxia/lexer";

function split(text: string): {
  readonly lead: string[];
  readonly words: string[];
} {
  const read = oxiaWords(text);
  if (!read.ok) throw new Error(`expected ${JSON.stringify(text)} to read, got: ${read.refusal.message}`);
  return {
    lead: read.lead.map((word) => word.text),
    words: read.words.map((word) => word.text),
  };
}

/** Each token of one line as `role:text`, whitespace left out. */
function roles(line: string, state: ShellLineState = INITIAL_OXIA_LEX_STATE): string[] {
  return tokenizeOxiaLine(line, state)
    .tokens.filter((token) => token.role !== "whitespace")
    .map((token) => `${token.role}:${line.slice(token.start, token.end)}`);
}

describe("oxiaWords: the lead a documented command line carries", () => {
  test.each([
    ["get /a", [], ["get", "/a"]],
    ["oxia client get /a", ["oxia", "client"], ["get", "/a"]],
    ["$ oxia client get /a", ["$", "oxia", "client"], ["get", "/a"]],
    ["% get /a", ["%"], ["get", "/a"]],
    ["oxia get /a", ["oxia"], ["get", "/a"]],
    ["client get /a", [], ["client", "get", "/a"]],
    ["oxia client get oxia", ["oxia", "client"], ["get", "oxia"]],
    ["'oxia' client get /a", [], ["oxia", "client", "get", "/a"]],
    ["oxia 'client' get /a", ["oxia"], ["client", "get", "/a"]],
    ["\\$ get /a", [], ["$", "get", "/a"]],
    ["$ $ get /a", ["$"], ["$", "get", "/a"]],
    ["oxia oxia client get /a", ["oxia"], ["oxia", "client", "get", "/a"]],
    ["# a docs line\noxia client list --prefix /a/", ["oxia", "client"], ["list", "--prefix", "/a/"]],
    ["", [], []],
  ])("%j", (text, lead, words) => {
    expect(split(text)).toEqual({ lead, words });
  });

  test("a refusal of the shared reader is the answer, unchanged", () => {
    expect(oxiaWords("oxia client get $HOME")).toEqual(readShellCommand("oxia client get $HOME") as never);
    expect(oxiaWords("get a\nget b")).toMatchObject({
      ok: false,
      refusal: { code: "second-command", line: 2 },
    });
  });

  test("the prompts and the initial state are the shared reader's", () => {
    expect([...OXIA_PROMPTS].sort()).toEqual(["$", "%"]);
    expect(INITIAL_OXIA_LEX_STATE).toBe(INITIAL_SHELL_LINE_STATE);
  });

  test("the persistent flags that take a value are the CLI's five, in both spellings", () => {
    expect([...OXIA_VALUE_GLOBAL_FLAGS].sort()).toEqual([
      "--auth-token",
      "--auth-token-file",
      "--namespace",
      "--request-timeout",
      "--service-address",
      "-a",
      "-n",
    ]);
  });
});

describe("tokenizeOxiaLine: the role of each token", () => {
  test.each([
    ["get /a", ["verb:get", "word:/a"]],
    ["oxia client get /a -v", ["lead:oxia", "lead:client", "verb:get", "word:/a", "flag:-v"]],
    [
      "$ oxia client list --prefix /a/",
      ["lead:$", "lead:oxia", "lead:client", "verb:list", "flag:--prefix", "word:/a/"],
    ],
    ["oxia client -a h:6648 get /a", ["lead:oxia", "lead:client", "flag:-a", "word:h:6648", "verb:get", "word:/a"]],
    ["oxia client --namespace=ns get /a", ["lead:oxia", "lead:client", "flag:--namespace=ns", "verb:get", "word:/a"]],
    ["get 'a b' # read it", ["verb:get", "string:'a b'", "comment:# read it"]],
    ["'oxia' get", ["string:'oxia'", "word:get"]],
    ["get $HOME", ["verb:get", "invalid:$", "word:HOME"]],
    ["get a; list", ["verb:get", "word:a", "invalid:;", "word:list"]],
    ["# only a comment", ["comment:# only a comment"]],
    ["-t floor get k", ["flag:-t", "verb:floor", "word:get", "word:k"]],
  ])("%j", (line, expected) => {
    expect(roles(line)).toEqual(expected);
  });

  test("a quoted verb is drawn as a string, and a quoted part makes a lead word the verb", () => {
    expect(roles("'get' /a")).toEqual(["string:'get'", "word:/a"]);
    // `ox'ia'` is the word oxia, quoted, so it is no lead: it is the first word, and its bare part is drawn as the verb.
    expect(roles("ox'ia' get")).toEqual(["verb:ox", "string:'ia'", "word:get"]);
  });

  test("lines after the command line carry no lead and no verb, and a second command is invalid", () => {
    const after = tokenizeOxiaLine("get /a", INITIAL_OXIA_LEX_STATE).state;
    expect(roles("# done", after)).toEqual(["comment:# done"]);
    expect(roles("oxia client get /b", after)).toEqual(["invalid:oxia client get /b"]);
  });

  test("a command line that runs on is read for its lead and its verb on the line it begins only", () => {
    // The shared state counts the words before a line and keeps none of their text (SB2-2.2), so the line a
    // backslash-newline continues draws plain words; the parser reads the whole text and is not limited.
    const first = tokenizeOxiaLine("oxia client \\", INITIAL_OXIA_LEX_STATE);
    expect(roles("oxia client \\")).toEqual(["lead:oxia", "lead:client"]);
    expect(roles("get /a", first.state)).toEqual(["word:get", "word:/a"]);
    expect(split("oxia client \\\nget /a")).toEqual({
      lead: ["oxia", "client"],
      words: ["get", "/a"],
    });
    // A word still open at the end of the line decides nothing on it.
    expect(roles("oxi\\")).toEqual(["word:oxi\\"]);
    expect(roles("oxia client get 'a")).toEqual(["lead:oxia", "lead:client", "verb:get", "string:'a"]);
  });

  test("the state handed on is the shared reader's own", () => {
    expect(tokenizeOxiaLine("oxia client get 'a", INITIAL_OXIA_LEX_STATE).state).toEqual({
      section: "command",
      quote: "single",
      continued: false,
      inWord: true,
      wordsBefore: 3,
    });
  });
});

/** The verb the whole-text reading finds: the first word after the lead that is no flag and no global's value. */
function verbOf(words: readonly ShellWord[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const flag = !word.quoted && word.text.length > 1 && word.text.startsWith("-");
    if (!flag) return word.quoted ? undefined : word.text;
    if (OXIA_VALUE_GLOBAL_FLAGS.has(word.text)) index += 1;
  }
  return undefined;
}

describe("the two readings agree on one-line command lines", () => {
  test.each([
    "get /a",
    "oxia client get /a",
    "$ oxia client list --prefix /a/ --limit 50",
    "% oxia get -t floor /a",
    "oxia client -a host:6648 -n ns get /a",
    "oxia client --request-timeout 5s get /a",
    "oxia client --namespace=ns range-scan a b",
    "'oxia' client get /a",
    "oxia 'client' get /a",
    "oxia client 'get' /a",
    "-v get /a",
    "oxia client put k v",
    "oxia admin list",
    "get my-key -v     # include the version metadata",
  ])("%j", (line) => {
    const read = oxiaWords(line);
    if (!read.ok) throw new Error(read.refusal.message);
    const tokens = tokenizeOxiaLine(line, INITIAL_OXIA_LEX_STATE).tokens;
    const span = (role: OxiaToken["role"]) =>
      tokens.filter((token) => token.role === role).map((token) => line.slice(token.start, token.end));
    expect(span("lead")).toEqual(read.lead.map((word) => word.text));
    const verb = verbOf(read.words);
    expect(span("verb")).toEqual(verb === undefined ? [] : [verb]);
  });
});
