/**
 * The shell-word reader against the command-line half of the etcd lexer, the reader its rules were taken from
 * (SB2-2.3): for every command-line case of `tests/unit/db/etcd/lexer.test.ts` that holds no etcd lead token and no
 * txn, both readers give the same words at the same places, or the same refusal code at the same place.
 *
 * The texts are written again here, because that file exports nothing and is not edited: the `text` column of its
 * two tables, `WORD_RULES` and `SHELL_REFUSALS`, in their order, and the texts of its cases outside the tables. The
 * first test counts the tables' rows in that file, so a row added there fails here until it is added too.
 *
 * This file is the evidence the BACKLOG entry about the two copies of the POSIX-shell refusal rules cites.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readShellCommand } from "@/lib/db/console/shell-words";
import { splitWords } from "@/lib/db/providers/keyvalue/etcd/lexer";

const ETCD_LEXER_TEST = join(import.meta.dir, "..", "etcd", "lexer.test.ts");

const WORD_RULE_TEXTS: readonly string[] = [
  "get  a\tb",
  "put k 'a $b `c` \\d \"e\" #f ~g'",
  "put k 'a\nb'",
  'put k "a\\"b\\\\c\\$d\\`e"',
  'put k "a\\qb\\nc\\\'d"',
  'put k "a\\\nb"',
  'put k "a\nb"',
  "put k a\\ b\\'c\\\"d\\$e\\#f\\~g\\;h",
  "put k ab\\\ncd",
  "put \\\nk v",
  "put k ab\\\n cd",
  "put k ab\\\n",
  "put k 'a'\"b\"c",
  "put k '' \"\"",
  "put k 'it'\\''s'",
  "get a #b c",
  "get a#b",
  "get '#b' \\#c",
  "get a # c \\\n",
  "get /a/* ?x [y]",
  "put k $ a$\tb",
  'put k "a$" "$ b"',
  'put k "a$\nb"',
  "put k a~b",
  "put k = =''",
  "put k \\=ls '='ls x==ls",
  "put k a=b~c a=x:y~",
  "put k a=b':'~/x a=b\\:~/y a=\\~/z a='~'/w",
  'put k "a"=~ a\\=~ 1a=~/x',
  "put k {a} a{b",
  "put k \\{a,b} {a\\,b} '{a,b}'",
  'put k {"a":1}',
  "get a\u00a0b",
  "put k a\fb c\u000bd",
  "get -- -a",
];

const REFUSAL_TEXTS: readonly string[] = [
  "put k $HOME",
  "put k $_x",
  "put k ${x}",
  "put k $(ls)",
  "put k $1",
  "put k $@",
  "put k $*",
  "put k $#",
  "put k $?",
  "put k $-",
  "put k $$",
  "put k $!",
  "put k $'a'",
  'put k $"a"',
  "put k $[1+1]",
  "put k $=x",
  "put k a$\\\nb",
  'put k "a $HOME"',
  'put k "$(ls)"',
  "put k `ls`",
  'put k "a `ls`"',
  "get ~/x",
  "get ~",
  "put k a=~/x",
  "put k a1=~/x",
  "put k a=b:~/x",
  "put k =ls",
  "put k ='ls'",
  "get =ls",
  "put k ==",
  "put k {a,b}",
  "put k {1..3}",
  "put k x{a,b}y",
  "put k {a{b,c}}",
  "put k {a,}",
  'put k {"a":1,"b":2}',
  "put k {1.'.'3}",
  "put k {1'..'3}",
  "put k {1\\..3}",
  "put k {a.'.'c}",
  "put k x{1'..'3}y",
  "get a; get b",
  "get a &",
  "get a | tee x",
  "put k < file",
  "get a > file",
  "put k (v)",
  "put k v)",
];

/** The command-line cases that file holds outside its two tables, and the edges of a text. */
const OTHER_TEXTS: readonly string[] = [
  "put {a,b}$x",
  "put a$x ;",
  "get a\\\n$b",
  "put k 'a\nb' $c",
  "put k {a,\\\nb}",
  "put k a\ud800",
  "get a\nput k \udc00x",
  "put k 𝄞",
  "put k 'a",
  'put k x"a\nb',
  "put k a\\",
  "get a \\",
  'put k "a\\',
  "put k a\\\n",
  "put k 'é 日本 𝄞'",
  "get --prefix '--x'",
  "",
  "   ",
  "# only a comment",
  "\n\nget a",
  "get a\r\n",
  "get a # c\n# d\n",
];

/** How many rows a table of that file holds: each row starts a line with two spaces and a bracket. */
function tableRows(source: string, name: string): number {
  const start = source.indexOf(`const ${name}:`);
  if (start < 0) throw new Error(`${ETCD_LEXER_TEST} declares no table ${name}`);
  const end = source.indexOf("\n];", start);
  return source
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("  [")).length;
}

/** What both readers say of a word: its text and where it starts and ends. */
interface PlacedWord {
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}
const placed = ({ text, line, column, endLine, endColumn }: PlacedWord): PlacedWord => ({
  text,
  line,
  column,
  endLine,
  endColumn,
});

/** The one wording the shared reader changes: it names no engine, so "one etcdctl command" reads "one command". */
const neutral = (message: string): string => message.replace("one etcdctl command", "one command");

describe("the shell-word reader and the etcd lexer's command line", () => {
  test("this file holds every row of the etcd lexer test's two command-line tables", () => {
    const source = readFileSync(ETCD_LEXER_TEST, "utf8");
    expect(tableRows(source, "WORD_RULES")).toBe(WORD_RULE_TEXTS.length);
    expect(tableRows(source, "SHELL_REFUSALS")).toBe(REFUSAL_TEXTS.length);
  });

  const corpus = [...WORD_RULE_TEXTS, ...REFUSAL_TEXTS, ...OTHER_TEXTS];

  test.each(corpus.map((text) => [JSON.stringify(text), text] as const))("%s", (_shown, text) => {
    const etcd = splitWords(text);
    const shared = readShellCommand(text);
    if (etcd.ok) {
      // The rule this corpus is held to: no etcd lead token, and no txn, whose body is etcdctl's own grammar.
      expect(etcd.split.lead.roles).toEqual([]);
      expect(etcd.split.command[etcd.split.lead.commandIndex]?.text).not.toBe("txn");
      expect(shared.ok ? shared.words.map(placed) : shared.refusal).toEqual(etcd.split.command.map(placed));
      return;
    }
    // The etcd lexer's code union is wider (its txn codes), so the answer is compared as a value.
    const answer: unknown = shared.ok ? shared.words : shared.refusal;
    expect(answer).toEqual({
      ...etcd.refusal,
      message: neutral(etcd.refusal.message),
    });
  });

  test("the operator sentence is the one sentence that differs, by the engine's name alone", () => {
    const etcd = splitWords("get a; get b");
    const shared = readShellCommand("get a; get b");
    expect(etcd.ok || shared.ok).toBe(false);
    if (etcd.ok || shared.ok) return;
    expect(etcd.refusal.message).toContain("one etcdctl command");
    expect(shared.refusal.message).toBe(neutral(etcd.refusal.message));
    expect(shared.refusal.message).not.toBe(etcd.refusal.message);
  });
});
