/**
 * The kubectl console text as words and as the editor draws it: the lead a pasted line carries before its command,
 * the role of each token, and the rule that the line-by-line reading draws the lead and the command the whole-text
 * reading finds.
 */
import { describe, expect, test } from "bun:test";
import { readShellCommand } from "@/lib/db/console/shell-words";
import {
  commandWordIndex,
  INITIAL_KUBECTL_LEX_STATE,
  isKubectlFlagText,
  KUBECTL_PROMPTS,
  KUBECTL_VALUE_GLOBAL_FLAGS,
  kubectlWords,
  tokenizeKubectlLine,
} from "@/lib/db/providers/platform/kubernetes/console/lexer";

function split(text: string): { readonly lead: string[]; readonly words: string[] } {
  const read = kubectlWords(text);
  if (!read.ok) throw new Error(`expected ${JSON.stringify(text)} to read, got: ${read.refusal.message}`);
  return { lead: read.lead.map((word) => word.text), words: read.words.map((word) => word.text) };
}

/** Each token of one line as `role:text`, whitespace left out. */
function roles(line: string, state = INITIAL_KUBECTL_LEX_STATE): string[] {
  return tokenizeKubectlLine(line, state)
    .tokens.filter((token) => token.role !== "whitespace")
    .map((token) => `${token.role}:${line.slice(token.start, token.end)}`);
}

describe("kubectlWords: the lead a pasted line carries", () => {
  test.each([
    ["get pods", [], ["get", "pods"]],
    ["kubectl get pods", ["kubectl"], ["get", "pods"]],
    ["$ kubectl get pods -n shop", ["$", "kubectl"], ["get", "pods", "-n", "shop"]],
    ["% get pods", ["%"], ["get", "pods"]],
    ["'kubectl' get pods", [], ["kubectl", "get", "pods"]],
    ["kubectl kubectl get pods", ["kubectl"], ["kubectl", "get", "pods"]],
    ["# the pods of shop\nkubectl get pods -n shop", ["kubectl"], ["get", "pods", "-n", "shop"]],
    ["kubectl get pods \\\n  -n shop", ["kubectl"], ["get", "pods", "-n", "shop"]],
    ["kubectl get pods -l 'app=web'", ["kubectl"], ["get", "pods", "-l", "app=web"]],
    ["", [], []],
  ])("%j", (text, lead, words) => {
    expect(split(text)).toEqual({ lead, words });
  });

  test("a refusal of the shared reader is the answer, unchanged", () => {
    expect(kubectlWords("kubectl get pods | head")).toEqual(readShellCommand("kubectl get pods | head") as never);
    expect(kubectlWords("get pods\nget nodes")).toMatchObject({ ok: false, refusal: { code: "second-command" } });
  });

  test("the prompts and the value-taking global flags", () => {
    expect([...KUBECTL_PROMPTS]).toEqual(["$", "%"]);
    expect(KUBECTL_VALUE_GLOBAL_FLAGS.has("-n")).toBe(true);
    expect(KUBECTL_VALUE_GLOBAL_FLAGS.has("--token")).toBe(true);
    expect(KUBECTL_VALUE_GLOBAL_FLAGS.has("-A")).toBe(false);
  });
});

describe("tokenizeKubectlLine: the role of each token", () => {
  test("the lead, the command, flags, words, strings and a comment", () => {
    expect(roles("$ kubectl get pods -n shop -l 'app=web' # note")).toEqual([
      "lead:$",
      "lead:kubectl",
      "verb:get",
      "word:pods",
      "flag:-n",
      "word:shop",
      "flag:-l",
      "string:'app=web'",
      "comment:# note",
    ]);
  });

  test("a global flag's value before the command is not the command", () => {
    expect(roles("kubectl -n shop get pods")).toEqual([
      "lead:kubectl",
      "flag:-n",
      "word:shop",
      "verb:get",
      "word:pods",
    ]);
    expect(roles("kubectl -A get pods")).toEqual(["lead:kubectl", "flag:-A", "verb:get", "word:pods"]);
  });

  test("a quoted flag is a flag, as the parser reads it, so its value is not the command either", () => {
    expect(roles('kubectl "-n" shop get pods')).toEqual([
      "lead:kubectl",
      'string:"-n"',
      "word:shop",
      "verb:get",
      "word:pods",
    ]);
    expect(roles("kubectl '--namespace' shop get pods")).toContain("verb:get");
    expect(roles("kubectl -n=shop get pods")).toContain("verb:get");
    expect(roles("kubectl -- get pods")).toEqual(["lead:kubectl", "flag:--", "verb:get", "word:pods"]);
  });

  test("commandWordIndex: the parser's and the editor's one rule", () => {
    expect(commandWordIndex(["-n", "shop", "get"])).toBe(2);
    expect(commandWordIndex(["-n=shop", "get"])).toBe(1);
    expect(commandWordIndex(["-A", "get"])).toBe(1);
    expect(commandWordIndex(["--", "-x"])).toBe(1);
    expect(commandWordIndex(["--"])).toBeUndefined();
    expect(commandWordIndex(["-", "get"])).toBe(0);
    expect(commandWordIndex(["-n", undefined, "get"])).toBe(2);
    expect(commandWordIndex([undefined, "get"])).toBeUndefined();
    expect(commandWordIndex(["-n"])).toBeUndefined();
    expect(commandWordIndex(["-l", "app=web", "pod"])).toBe(1);
    expect(commandWordIndex(["-l", "app=web", "pod"], new Set(["-l"]))).toBe(2);
    expect(isKubectlFlagText("-n")).toBe(true);
    expect(isKubectlFlagText("-")).toBe(false);
  });

  test("a refused character is drawn invalid", () => {
    expect(roles("get pods | head")).toEqual(["verb:get", "word:pods", "invalid:|", "word:head"]);
  });

  test("a line after the command line draws no command, and a second command is invalid", () => {
    const first = tokenizeKubectlLine("get pods", INITIAL_KUBECTL_LEX_STATE);
    expect(first.state.section).toBe("after");
    expect(roles("get nodes", first.state)).toEqual(["invalid:get nodes"]);
  });

  test("a continued line draws its words but no lead or command", () => {
    const first = tokenizeKubectlLine("kubectl \\", INITIAL_KUBECTL_LEX_STATE);
    expect(roles("get pods", first.state)).toEqual(["word:get", "word:pods"]);
  });

  test("a word that runs on past the line decides nothing", () => {
    expect(roles("kubectl 'get")).toEqual(["lead:kubectl", "string:'get"]);
  });

  test("a quoted or escaped lead word is the command itself, as kubectlWords reads it", () => {
    expect(roles("'kubectl' get")).toEqual(["string:'kubectl'", "word:get"]);
    expect(roles("kube\\ctl get")).toEqual(["verb:kube\\ctl", "word:get"]);
  });
});
