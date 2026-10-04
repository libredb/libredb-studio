/**
 * The Oxia command table and its parser (SB2-3.2 to SB2-3.4): every row of the table in each spelling, every
 * refusal sentence word for word, the -a and -n matching rules, the defaults, and the docs lines a user pastes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteShellWord } from "@/lib/db/console/shell-words";
import {
  type OxiaCommand,
  type OxiaParseContext,
  type OxiaRefusal,
  OXIA_COMMAND_TABLE,
  OXIA_INTERNAL_KEY_SENTENCE,
  OXIA_REFUSED_COMMANDS,
  OXIA_REFUSED_FLAGS,
  type ParsedOxiaCommand,
  parseOxiaCommand,
  writeCommandSentence,
} from "@/lib/db/providers/keyvalue/oxia/commands";
import {
  OXIA_LIST_DEFAULT_LIMIT,
  OXIA_MAX_LIMIT,
  OXIA_MAX_TEXT_BYTES,
  OXIA_SCAN_DEFAULT_LIMIT,
} from "@/lib/db/providers/keyvalue/oxia/constants";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

/** The browser's context: no connection is known. */
const BROWSER: OxiaParseContext = {};
/** A server-side context, as index.ts builds it. */
const SERVER: OxiaParseContext = {
  endpoint: "server0.example.com:6648",
  namespace: "default",
  readOnly: false,
};

function parsed(text: string, context: OxiaParseContext = BROWSER): ParsedOxiaCommand {
  const result = parseOxiaCommand(text, context);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to parse, got: ${result.refusal.message}`);
  return result.parsed;
}

const command = (text: string, context: OxiaParseContext = BROWSER): OxiaCommand => parsed(text, context).command;

function refusal(text: string, context: OxiaParseContext = BROWSER): OxiaRefusal {
  const result = parseOxiaCommand(text, context);
  if (result.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return result.refusal;
}

describe("the constants the table reads", () => {
  test("the most rows and the list default are DEFAULT_QUERY_LIMIT, held equal and not imported (decision D8)", () => {
    expect(OXIA_MAX_LIMIT).toBe(DEFAULT_QUERY_LIMIT);
    expect(OXIA_LIST_DEFAULT_LIMIT).toBe(DEFAULT_QUERY_LIMIT);
    expect(OXIA_SCAN_DEFAULT_LIMIT).toBe(100);
    expect(OXIA_MAX_TEXT_BYTES).toBe(65_536);
  });
});

describe("OXIA_COMMAND_TABLE", () => {
  test("holds the three read verbs, their aliases, arguments and flags in the order of SB2-3.3", () => {
    expect(OXIA_COMMAND_TABLE).toEqual([
      {
        verb: "get",
        aliases: [],
        arguments: "KEY",
        flags: ["-t|--comparison-type", "-p|--partition-key", "--index", "--hex", "-v|--include-version"],
      },
      {
        verb: "list",
        aliases: ["ls"],
        arguments: "[MIN [MAX]]",
        flags: ["-s|--key-min", "-e|--key-max", "-p|--partition-key", "--index", "--prefix", "--limit"],
      },
      {
        verb: "range-scan",
        aliases: ["scan"],
        arguments: "[MIN [MAX]]",
        flags: [
          "-s|--key-min",
          "-e|--key-max",
          "-p|--partition-key",
          "--index",
          "--prefix",
          "--limit",
          "-v|--include-version",
          "--hex",
        ],
      },
    ]);
    expect(Object.isFrozen(OXIA_COMMAND_TABLE)).toBe(true);
  });
});

describe("get", () => {
  test("one key, equal, no hex, by default", () => {
    expect(parsed("get /a")).toEqual({
      command: { kind: "get", key: "/a", comparison: "equal", hex: false },
      matched: [],
      line: 1,
    });
  });

  test.each([
    ["get -t floor /a"],
    ["get --comparison-type floor /a"],
    ["get --comparison-type=floor /a"],
    ["get -tfloor /a"],
    ["get -t=floor /a"],
    ["get /a -t floor"],
  ])("%s reads the comparison in every spelling and place", (text) => {
    expect(command(text)).toEqual({
      kind: "get",
      key: "/a",
      comparison: "floor",
      hex: false,
    });
  });

  test.each(["equal", "floor", "ceiling", "lower", "higher"])("-t %s", (comparison) => {
    expect(command(`get -t ${comparison} /a`)).toMatchObject({ comparison });
  });

  test("-p, --index, --hex and -v in both spellings, -v accepted and ignored", () => {
    expect(command("get -p pk --index by-email --hex -v /a")).toEqual({
      kind: "get",
      key: "/a",
      comparison: "equal",
      partitionKey: "pk",
      index: "by-email",
      hex: true,
    });
    expect(command("get --partition-key=pk --include-version /a")).toEqual({
      kind: "get",
      key: "/a",
      comparison: "equal",
      partitionKey: "pk",
      hex: false,
    });
  });

  test("a run of shorthands is read one letter at a time, as pflag reads it", () => {
    expect(command("get -vp pk /a")).toMatchObject({ partitionKey: "pk" });
    expect(command("get -vppk /a")).toMatchObject({ partitionKey: "pk" });
  });

  test("-- ends the flags, so a key may begin with -", () => {
    expect(command("get -- -x")).toMatchObject({ key: "-x" });
    expect(command("get '-x'")).toMatchObject({ key: "-x" });
    expect(command("get -")).toMatchObject({ key: "-" });
  });

  test("an empty key reads for an equal get", () => {
    expect(command("get ''")).toMatchObject({ key: "", comparison: "equal" });
  });

  test("the verb's line is the line it stands on", () => {
    expect(parsed("# read one key\n\nget /a").line).toBe(3);
  });
});

describe("list and range-scan", () => {
  test("bounds as MIN and MAX, or as -s and -e, each empty by default", () => {
    expect(command("list")).toEqual({
      kind: "list",
      range: { kind: "bounds", min: "", max: "" },
      limit: 500,
    });
    expect(command("list a")).toMatchObject({
      range: { kind: "bounds", min: "a", max: "" },
    });
    expect(command("list a b")).toMatchObject({
      range: { kind: "bounds", min: "a", max: "b" },
    });
    expect(command("list -s a -e b")).toMatchObject({
      range: { kind: "bounds", min: "a", max: "b" },
    });
    expect(command("list --key-min=a --key-max b")).toMatchObject({
      range: { kind: "bounds", min: "a", max: "b" },
    });
    expect(command("list -e b")).toMatchObject({
      range: { kind: "bounds", min: "", max: "b" },
    });
  });

  test("ls and scan are the aliases", () => {
    expect(command("ls /a/ /b/")).toMatchObject({ kind: "list" });
    expect(command("scan /a/ /b/")).toMatchObject({ kind: "range-scan" });
  });

  test("--prefix, -p, --index and --limit", () => {
    expect(command("list --prefix /admin/ --limit 50")).toEqual({
      kind: "list",
      range: { kind: "prefix", prefix: "/admin/" },
      limit: 50,
    });
    expect(command("range-scan -p pk --index idx a b --limit=500 --hex -v")).toEqual({
      kind: "range-scan",
      range: { kind: "bounds", min: "a", max: "b" },
      partitionKey: "pk",
      index: "idx",
      limit: 500,
      hex: true,
    });
  });

  test("the two --limit defaults: 500 for list, 100 for range-scan", () => {
    expect(command("list")).toMatchObject({ limit: OXIA_LIST_DEFAULT_LIMIT });
    expect(command("range-scan")).toMatchObject({
      limit: OXIA_SCAN_DEFAULT_LIMIT,
      hex: false,
    });
  });

  test("--index with a non-empty MAX reads, in both bound spellings", () => {
    expect(command("list --index by-email a b")).toMatchObject({
      index: "by-email",
    });
    expect(command("range-scan --index by-email -e b")).toMatchObject({
      index: "by-email",
    });
  });
});

const BROWSER_WRITE = (verb: string) =>
  `${verb} writes, and Studio's Oxia support reads only in this version: write with the oxia CLI.`;
const READ_ONLY_WRITE = (verb: string) =>
  `${verb} writes, and this connection is read-only. Studio's Oxia support also reads only in this version, so turning the mode off would not run it: write with the oxia CLI.`;
const STREAM = (verb: string) =>
  `${verb} keeps a stream open until it is stopped, and Studio runs one bounded read per command: run it with the oxia CLI.`;
const GET_FLAGS = "-t|--comparison-type, -p|--partition-key, --index, --hex and -v|--include-version";
const LIST_FLAGS = "-s|--key-min, -e|--key-max, -p|--partition-key, --index, --prefix and --limit";

/** Every refusal of SB2-3.3, word for word, with its place (0-based column of the word it names). */
const REFUSALS: readonly [text: string, code: string, message: string, column: number | null][] = [
  ["", "empty", "The editor holds no command: write one Oxia read, such as get /admin or list --prefix /admin/.", null],
  [
    "  # only a comment\n",
    "empty",
    "The editor holds no command: write one Oxia read, such as get /admin or list --prefix /admin/.",
    null,
  ],
  [
    "oxia client",
    "empty",
    "The editor holds no command: write one Oxia read, such as get /admin or list --prefix /admin/.",
    null,
  ],
  [
    "-v",
    "empty",
    "The editor holds no command: write one Oxia read, such as get /admin or list --prefix /admin/.",
    null,
  ],
  ...["admin", "standalone", "shell", "coordinator", "server", "perf", "pprof", "health", "version"].map(
    (word): [string, string, string, number] => [
      `oxia ${word} x`,
      "not-client",
      `oxia ${word} is not a client read: Studio runs oxia client get, list and range-scan, and the oxia CLI runs the rest.`,
      5,
    ],
  ),
  [
    "admin x",
    "unknown-command",
    "admin is not a command Studio runs on Oxia: it runs get, list (ls) and range-scan (scan).",
    0,
  ],
  [
    "oxia client admin x",
    "unknown-command",
    "admin is not a command Studio runs on Oxia: it runs get, list (ls) and range-scan (scan).",
    12,
  ],
  [
    `${"x".repeat(41)} a`,
    "unknown-command",
    `${"x".repeat(40)}... is not a command Studio runs on Oxia: it runs get, list (ls) and range-scan (scan).`,
    0,
  ],
  ...["put", "delete", "del", "delete-range"].map((verb): [string, string, string, number] => [
    `${verb} k v`,
    "write-command",
    BROWSER_WRITE(verb),
    0,
  ]),
  ...["notifications", "sequence-updates"].map((verb): [string, string, string, number] => [
    `oxia client ${verb}`,
    "stream-command",
    STREAM(verb),
    12,
  ]),
  [
    "list --internal-keys",
    "refused-flag",
    "--internal-keys lists Oxia's own bookkeeping keys under __oxia/, which Studio never reads.",
    5,
  ],
  [
    "list --internal-keys=false",
    "refused-flag",
    "--internal-keys lists Oxia's own bookkeeping keys under __oxia/, which Studio never reads.",
    5,
  ],
  [
    "get --request-timeout 5s /a",
    "refused-flag",
    "--request-timeout is refused: the connection's Query Timeout bounds every command.",
    4,
  ],
  [
    "--request-timeout 5s get /a",
    "refused-flag",
    "--request-timeout is refused: the connection's Query Timeout bounds every command.",
    0,
  ],
  [
    "--auth-token SECRET-TOKEN get /a",
    "refused-flag",
    "--auth-token is refused: the connection's Token field authenticates every call, and a token typed here would be kept in the query history.",
    0,
  ],
  [
    "get --auth-token-file=/t /a",
    "refused-flag",
    "--auth-token-file is refused: the connection's Token field authenticates every call, and a token typed here would be kept in the query history.",
    4,
  ],
  ["get -h", "refused-flag", "Studio prints no help: the provider doc lists every command and flag Studio runs.", 4],
  [
    "list --help",
    "refused-flag",
    "Studio prints no help: the provider doc lists every command and flag Studio runs.",
    5,
  ],
  ["get --limit 5 /a", "unknown-flag", `get takes no flag --limit: it takes ${GET_FLAGS}.`, 4],
  ["get -x /a", "unknown-flag", `get takes no flag -x: it takes ${GET_FLAGS}.`, 4],
  ["list --hex", "unknown-flag", `list takes no flag --hex: it takes ${LIST_FLAGS}.`, 5],
  ["list --bogus=secret", "unknown-flag", `list takes no flag --bogus: it takes ${LIST_FLAGS}.`, 5],
  [
    `list --${"b".repeat(41)}=v`,
    "unknown-flag",
    `list takes no flag --${"b".repeat(38)}...: it takes ${LIST_FLAGS}.`,
    5,
  ],
  ["list -t floor", "unknown-flag", `list takes no flag -t: it takes ${LIST_FLAGS}.`, 5],
  ["get -t floor -t ceiling /a", "repeated-flag", "--comparison-type is given twice: give it once.", 13],
  ["get --hex --hex /a", "repeated-flag", "--hex is given twice: give it once.", 10],
  ["get -a h:1 -a h:1 /a", "repeated-flag", "-a is given twice: give it once.", 11],
  ["get", "bad-argument", "get takes one key: write get followed by the key, in single quotes if it holds a space.", 0],
  [
    "get a b",
    "bad-argument",
    "get takes one key, and 1 more word follows it: write the key between single quotes if it holds a space.",
    6,
  ],
  [
    "get my key here",
    "bad-argument",
    "get takes one key, and 2 more words follow it: write the key between single quotes if it holds a space.",
    7,
  ],
  [
    "range-scan a b c",
    "bad-argument",
    "range-scan takes at most two keys, MIN and MAX: write a key between single quotes if it holds a space.",
    15,
  ],
  ["get -t first /a", "bad-argument", "-t takes equal, floor, ceiling, lower or higher.", 4],
  ["get -t FLOOR /a", "bad-argument", "-t takes equal, floor, ceiling, lower or higher.", 4],
  ["get -p '' /a", "bad-argument", "-p takes a value that is not empty.", 4],
  ["get --index= /a", "bad-argument", "--index takes a value that is not empty.", 4],
  ["list --prefix ''", "bad-argument", "--prefix takes a value that is not empty.", 5],
  [
    "get --index a/b /a",
    "bad-argument",
    "--index takes an index name, which cannot hold /: Oxia stores each index under its name.",
    4,
  ],
  [
    "get -t floor ''",
    "bad-argument",
    "A floor, ceiling, lower or higher get needs a key that is not empty: Oxia answers the empty key differently under each key order. For the first key, use list --limit 1.",
    13,
  ],
  ["get --hex=true /a", "bad-argument", "--hex takes no value: write --hex alone.", 4],
  ["get -v=1 /a", "bad-argument", "-v takes no value: write -v alone.", 4],
  ["get /a -t", "bad-argument", "-t takes a value: write it after -t.", 7],
  ["list -s", "bad-argument", "-s takes a value: write it after -s.", 5],
  // The verb is no flag's value (rule 2), so a value flag written just before it has no value.
  ["-p get k", "bad-argument", "-p takes a value: write it after -p.", 0],
  ["-vp get k", "bad-argument", "-p takes a value: write it after -p.", 0],
  ["--prefix ls", "bad-argument", "--prefix takes a value: write it after --prefix.", 0],
  ["get /a -n", "bad-argument", "-n takes a value: write it after -n.", 7],
  ["list a -e b", "conflicting-flags", "list takes its bounds either as MIN and MAX or as -s and -e, not both.", 5],
  [
    "scan -s a b",
    "conflicting-flags",
    "range-scan takes its bounds either as MIN and MAX or as -s and -e, not both.",
    10,
  ],
  [
    "list --prefix /a/ -s b",
    "conflicting-flags",
    "--prefix reads every key beginning with its text, so it takes no -s, -e, MIN or MAX.",
    5,
  ],
  [
    "list --prefix /a/ x",
    "conflicting-flags",
    "--prefix reads every key beginning with its text, so it takes no -s, -e, MIN or MAX.",
    5,
  ],
  [
    "list --prefix /a/ --index i",
    "conflicting-flags",
    "--prefix reads primary keys, so it does not combine with --index, whose bounds are secondary keys.",
    5,
  ],
  [
    "list --index by-email",
    "bad-argument",
    "--index needs an upper bound: Oxia reads index keys up to MAX (or -e), and an empty upper bound reads nothing.",
    5,
  ],
  [
    "list --index by-email a",
    "bad-argument",
    "--index needs an upper bound: Oxia reads index keys up to MAX (or -e), and an empty upper bound reads nothing.",
    5,
  ],
  [
    "range-scan --index by-email -s a -e ''",
    "bad-argument",
    "--index needs an upper bound: Oxia reads index keys up to MAX (or -e), and an empty upper bound reads nothing.",
    11,
  ],
  // Rule 1: --index without an upper bound comes before internal-key.
  [
    "list --index i __oxia/x",
    "bad-argument",
    "--index needs an upper bound: Oxia reads index keys up to MAX (or -e), and an empty upper bound reads nothing.",
    5,
  ],
  ["get __oxia/assignments", "internal-key", OXIA_INTERNAL_KEY_SENTENCE, 4],
  ["list __oxia/ ''", "internal-key", OXIA_INTERNAL_KEY_SENTENCE, 5],
  ["list '' __oxia/x", "internal-key", OXIA_INTERNAL_KEY_SENTENCE, 8],
  ["list -e __oxia/x", "internal-key", OXIA_INTERNAL_KEY_SENTENCE, 5],
  ["scan --prefix __oxia/", "internal-key", OXIA_INTERNAL_KEY_SENTENCE, 5],
  ["list --limit 0", "limit-out-of-range", "--limit takes a whole number from 1 to 500.", 5],
  ["list --limit 501", "limit-out-of-range", "--limit takes a whole number from 1 to 500.", 5],
  ["list --limit 050", "limit-out-of-range", "--limit takes a whole number from 1 to 500.", 5],
  ["list --limit=1e2", "limit-out-of-range", "--limit takes a whole number from 1 to 500.", 5],
  ["scan --limit -5", "limit-out-of-range", "--limit takes a whole number from 1 to 500.", 5],
];

describe("every refusal of SB2-3.3, word for word, at its place", () => {
  test.each(REFUSALS)("%j", (text, code, message, column) => {
    const found = refusal(text);
    expect(found.code).toBe(code as OxiaRefusal["code"]);
    expect(found.message).toBe(message);
    // A refusal of the whole text names no place; every other names the word it is about.
    if (column === null) expect([found.line, found.column]).toEqual([undefined, undefined]);
    else
      expect({ line: found.line, column: found.column }).toEqual({
        line: 1,
        column,
      });
  });

  test("a NUL in a key, a bound, a prefix and a flag value is refused at its own word", () => {
    const nul = (column: number) =>
      `The word at line 1, column ${column} holds a NUL character, which no command line can pass: open such a key from the Keys panel, where its Source tab reads it.`;
    expect(refusal("get a\u0000b")).toEqual({
      code: "nul-character",
      message: nul(5),
      line: 1,
      column: 4,
    });
    expect(refusal("list a b\u0000")).toEqual({
      code: "nul-character",
      message: nul(8),
      line: 1,
      column: 7,
    });
    expect(refusal("list --prefix \u0000")).toEqual({
      code: "nul-character",
      message: nul(15),
      line: 1,
      column: 14,
    });
    expect(refusal("get -p p\u0000 k")).toEqual({
      code: "nul-character",
      message: nul(8),
      line: 1,
      column: 7,
    });
    expect(refusal("get a \\\nb\u0000c")).toEqual({
      code: "nul-character",
      message:
        "The word at line 2, column 1 holds a NUL character, which no command line can pass: open such a key from the Keys panel, where its Source tab reads it.",
      line: 2,
      column: 0,
    });
  });

  test("the text bound: 65,536 UTF-8 bytes read, one more is refused before it is read as words", () => {
    const longest = `get ${"a".repeat(OXIA_MAX_TEXT_BYTES - 4)}`;
    expect(command(longest)).toMatchObject({ kind: "get" });
    // A $ would be refused by the reader; the bound comes first, and names no place.
    expect(refusal(`get $${"é".repeat(32_766)}`)).toEqual({
      code: "too-large",
      message: "The command is longer than 65,536 bytes, the most an Oxia command holds in Studio: shorten it.",
    });
  });

  test("a refusal of the shared reader is the answer, with its code, sentence and place", () => {
    expect(refusal("get $HOME")).toEqual({
      code: "shell-expansion",
      message:
        "Studio runs no shell, so it refuses the $ at line 1, column 5, which a shell may expand: put a backslash before the $, or write the text between single quotes, to keep it as written.",
      line: 1,
      column: 4,
    });
    expect(refusal("get a | head")).toMatchObject({
      code: "shell-operator",
      line: 1,
      column: 6,
    });
    expect(refusal("get a\nget b")).toMatchObject({
      code: "second-command",
      line: 2,
      column: 0,
    });
  });

  test("a typed token is never echoed", () => {
    expect(refusal("--auth-token SECRET-TOKEN get /a").message).not.toContain("SECRET");
    expect(refusal("list --bogus=secret").message).not.toContain("secret");
  });
});

describe("write-command: the read-only mode is named while it holds (O1)", () => {
  test("by the server's context, and by the browser's", () => {
    expect(refusal("put k v", { ...SERVER, readOnly: true }).message).toBe(READ_ONLY_WRITE("put"));
    expect(refusal("put k v", { ...SERVER, readOnly: false }).message).toBe(BROWSER_WRITE("put"));
    expect(refusal("put k v", BROWSER).message).toBe(BROWSER_WRITE("put"));
  });

  test("writeCommandSentence answers the same three", () => {
    expect(writeCommandSentence("del", true)).toBe(READ_ONLY_WRITE("del"));
    expect(writeCommandSentence("del", false)).toBe(BROWSER_WRITE("del"));
    expect(writeCommandSentence("del", undefined)).toBe(BROWSER_WRITE("del"));
  });

  test("the refused verbs are listed with the browser's sentences", () => {
    expect(OXIA_REFUSED_COMMANDS).toEqual([
      { verb: "put", code: "write-command", message: BROWSER_WRITE("put") },
      {
        verb: "delete",
        code: "write-command",
        message: BROWSER_WRITE("delete"),
      },
      { verb: "del", code: "write-command", message: BROWSER_WRITE("del") },
      {
        verb: "delete-range",
        code: "write-command",
        message: BROWSER_WRITE("delete-range"),
      },
      {
        verb: "notifications",
        code: "stream-command",
        message: STREAM("notifications"),
      },
      {
        verb: "sequence-updates",
        code: "stream-command",
        message: STREAM("sequence-updates"),
      },
    ]);
  });

  test("the refused flags are listed with their sentences", () => {
    expect(OXIA_REFUSED_FLAGS.map((flag) => [flag.flag, flag.shorthand])).toEqual([
      ["--internal-keys", undefined],
      ["--request-timeout", undefined],
      ["--auth-token", undefined],
      ["--auth-token-file", undefined],
      ["--help", "-h"],
    ]);
  });
});

describe("-a and -n", () => {
  test("the browser accepts any value and records no match", () => {
    expect(parsed("-a anything:1 -n other get /a")).toEqual({
      command: { kind: "get", key: "/a", comparison: "equal", hex: false },
      matched: [],
      line: 1,
    });
  });

  test.each([
    ["server0.example.com:6648"],
    ["SERVER0.Example.COM:6648"],
    ["server0.example.com"],
    ["--service-address=server0.example.com:6648"],
  ])("-a %s matches the connection's endpoint", (value) => {
    const text = value.startsWith("--") ? `${value} get /a` : `-a ${value} get /a`;
    expect(parsed(text, SERVER).matched).toEqual(["service-address"]);
  });

  test("an IPv6 endpoint matches only in the bracketed RFC 5952 form the context carries", () => {
    const context = { ...SERVER, endpoint: "[::1]:6648" };
    expect(parsed("-a [::1]:6648 get /a", context).matched).toEqual(["service-address"]);
    expect(parsed("-a [::1] get /a", context).matched).toEqual(["service-address"]);
    for (const value of ["[0:0:0:0:0:0:0:1]:6648", "::1", "[::1", "[::1]x", "[]:6648"]) {
      expect(refusal(`-a '${value}' get /a`, context)).toMatchObject({
        code: "connection-flag",
      });
    }
  });

  test.each([
    ["other:6648"],
    ["server0.example.com:6649"],
    ["server0.example.com:0"],
    ["server0.example.com:65536"],
    [":6648"],
    ["server0.example.com:"],
    ["server0.example.com:66x"],
    ["a:b:c"],
  ])("-a %s is refused with the connection's own endpoint", (value) => {
    expect(refusal(`get -a ${value} /a`, SERVER)).toEqual({
      code: "connection-flag",
      message:
        "-a names another address than this connection's server0.example.com:6648: Host and Port on the connection decide where Studio connects.",
      line: 1,
      column: 4,
    });
  });

  test("-n matches byte for byte, case sensitive, and the context carries default for an empty namespace", () => {
    expect(parsed("-n default get /a", SERVER).matched).toEqual(["namespace"]);
    expect(parsed("--namespace=default -a server0.example.com get /a", SERVER).matched).toEqual([
      "namespace",
      "service-address",
    ]);
    expect(refusal("get --namespace Default /a", SERVER)).toEqual({
      code: "connection-flag",
      // Plain text, as the result panel shows it: no Markdown backticks (ruling R34).
      message:
        "-n names a namespace other than this connection's default: Namespace is set on the connection, and empty means default.",
      line: 1,
      column: 4,
    });
    expect(refusal("-n '' get /a", SERVER)).toMatchObject({
      code: "connection-flag",
    });
    // The connection's namespace as quoteShellWord writes it, so a name with a space reads back as one word.
    expect(refusal("-n other get /a", { ...SERVER, namespace: "team a" })).toMatchObject({
      code: "connection-flag",
      message:
        "-n names a namespace other than this connection's 'team a': Namespace is set on the connection, and empty means default.",
    });
  });
});

describe("a pasted oxia client line (SB2-3.4)", () => {
  test("oxia client list -s /xyz/ -e /xyz//", () => {
    expect(command("oxia client list -s /xyz/ -e /xyz//")).toEqual({
      kind: "list",
      range: { kind: "bounds", min: "/xyz/", max: "/xyz//" },
      limit: 500,
    });
  });

  test("oxia client get my-key -v     # include the version metadata", () => {
    expect(command("oxia client get my-key -v     # include the version metadata")).toEqual({
      kind: "get",
      key: "my-key",
      comparison: "equal",
      hex: false,
    });
  });

  test("oxia client --namespace my-namespace put my-key my-value", () => {
    expect(refusal("oxia client --namespace my-namespace put my-key my-value")).toMatchObject({
      code: "write-command",
    });
  });

  test("oxia client -a server0.example.com:6648 get /hello", () => {
    const text = "oxia client -a server0.example.com:6648 get /hello";
    expect(refusal(text, { ...SERVER, endpoint: "localhost:6648" })).toMatchObject({ code: "connection-flag" });
    expect(parsed(text, SERVER)).toEqual({
      command: { kind: "get", key: "/hello", comparison: "equal", hex: false },
      matched: ["service-address"],
      line: 1,
    });
  });

  test("oxia client list -s a -e b --index by-email", () => {
    expect(command("oxia client list -s a -e b --index by-email")).toEqual({
      kind: "list",
      range: { kind: "bounds", min: "a", max: "b" },
      index: "by-email",
      limit: 500,
    });
  });

  test("oxia client list --index by-email", () => {
    expect(refusal("oxia client list --index by-email")).toMatchObject({
      code: "bad-argument",
    });
  });

  test("$ oxia client get /a", () => {
    expect(command("$ oxia client get /a")).toMatchObject({
      kind: "get",
      key: "/a",
    });
  });
});

/** A small deterministic generator (mulberry32), so a failure names a key that fails again. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const KEY_ALPHABET: readonly string[] = [..."aZ9/_-.:@%+=,^ \t\n'\"\\$`~{};&|<>()#*?[]!", "é", "日", "𝄞", " "];

describe("a key quoted with quoteShellWord reads back as itself", () => {
  test("500 generated keys without CR, U+0000 or a lone surrogate, none beginning with - or __oxia/", () => {
    const random = generator(424);
    for (let round = 0; round < 500; round++) {
      const length = 1 + Math.floor(random() * 12);
      let key = "";
      for (let index = 0; index < length; index++) key += KEY_ALPHABET[Math.floor(random() * KEY_ALPHABET.length)];
      // A bare word beginning with - is a flag; such a key is written after -- (tested above).
      if (key.startsWith("-")) key = `k${key}`;
      expect(command(`get ${quoteShellWord(key)}`)).toEqual({
        kind: "get",
        key,
        comparison: "equal",
        hex: false,
      });
    }
  });
});

describe("the console modules branch on no type id", () => {
  test.each(["lexer", "commands", "guard"])('%s.ts holds no === "oxia"', (module) => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "src/lib/db/providers/keyvalue/oxia", `${module}.ts`),
      "utf8",
    );
    expect(source).not.toContain('=== "oxia"');
  });
});
