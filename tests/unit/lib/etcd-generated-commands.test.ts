import { describe, expect, test } from "bun:test";
import { type EtcdCommand, type EtcdParseLimits, parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import { ETCD_READ_BOUNDS } from "@/lib/db/providers/keyvalue/etcd/execute";
import { assessCommand } from "@/lib/db/providers/keyvalue/etcd/guard";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import type { ObjectReadRange } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { generateSelectQuery, generateTableQuery, shouldRefreshSchema } from "@/lib/query-generators";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * Every text the tree writes for an etcd group, sent through the provider's own parser, so "runs as is" and
 * "parses once uncommented" are tests and not claims (#1089, sections 6.4 and 10); and the provider's refresh
 * pattern held to that parser over one corpus, which holds every one of those texts (#1089 6.2, section 10).
 */

/** The real provider's declaration: its constructor validates and opens nothing (#1089 3.1). */
const CAPABILITIES = new EtcdProvider(CENSUS_CONNECTION.etcd).getCapabilities();

/** The bounds the provider parses a command under (keyvalue/etcd/index.ts `parseLimits`), at a 30 s query timeout. */
const LIMITS: EtcdParseLimits = {
  maxLimit: DEFAULT_QUERY_LIMIT,
  txnRangeLimit: ETCD_READ_BOUNDS.firstPageSize,
  maxCommandTimeoutMs: 30_000,
  maxWatchWindowMs: 30_000 - ETCD_READ_BOUNDS.watchMarginMs,
};

/** The command the provider runs for `text`, or the sentence it refuses the text with. */
function commandOf(text: string): EtcdCommand {
  const parsed = parseEtcdCommand(text, LIMITS);
  if (!parsed.ok) throw new Error(`the provider refuses ${JSON.stringify(text)}: ${parsed.refusal.message}`);
  return parsed.parsed.command;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A commented form written back as it runs: each `# ` line without its mark, and each `#` line blank. */
function uncomment(form: string): string {
  return form
    .split("\n")
    .map((line) => {
      if (line === "#") return "";
      if (!line.startsWith("# "))
        throw new Error(`a line of a commented form is not a comment: ${JSON.stringify(line)}`);
      return line.slice(2);
    })
    .join("\n");
}

/**
 * A generated text's parts (#1089 6.4): the read, every line before the first comment line, and the commented
 * forms below it, a blank line apart. A commented form holds no blank line, since a blank line of a form is
 * written `#`; no prefix below holds a newline followed by `#`, which would begin a line of the read with one.
 */
function partsOf(text: string): { readonly read: string; readonly forms: readonly string[] } {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("#"));
  if (first < 0) return { read: text, forms: [] };
  return { read: lines.slice(0, first).join("\n"), forms: lines.slice(first).join("\n").split("\n\n") };
}

/** The prefixes of section 10's round trip: a space, both quote characters, a newline, a leading `-`, a `#` and a `$`. */
const PREFIXES: readonly (readonly [label: string, prefix: string])[] = [
  ["nothing to quote", "/app/config/"],
  ["a space", "/my app/"],
  ["a single quote", "/it's/"],
  ["a double quote", '/say "hi"/'],
  ["a newline", "/line\nbreak/"],
  ["a leading -", "-app/"],
  ["a #", "/a#b/"],
  ["a $", "/$HOME/"],
  ["a carriage return", "/cr\rhere/"],
  ["a line separator", "/ls\u2028here/"],
  ["a paragraph separator", "/ps\u2029here/"],
];

/**
 * What Studio's editor does not keep as the command line spells it: a carriage return, at which it ends a line,
 * and a line or paragraph separator, which Monaco offers to remove the moment the text lands, as an unusual line
 * terminator; accepting leaves a form that names other bytes. A generated text holds none of them as itself.
 */
const UNKEPT = /[\r\u2028\u2029]/;

const sampleKey = (prefix: string): string => `${prefix}example`;

describe("Generate Command runs its read as is, and each commented form parses once uncommented (#1089 6.4)", () => {
  test.each(PREFIXES)("a prefix holding %s", (_label, prefix) => {
    const text = generateSelectQuery([`${prefix}*`], [], CAPABILITIES);
    const { read, forms } = partsOf(text);
    expect(text).not.toMatch(UNKEPT);

    // The whole buffer runs the read, so a write needs an edit first.
    const whole = commandOf(text);
    expect(whole).toEqual(commandOf(read));
    expect(assessCommand(whole).class).toBe("read");
    if (UNKEPT.test(prefix)) {
      // No command-line spelling the editor keeps reads the character back, so the read is a txn's get, whose Go
      // quoting escapes it (lexer.ts quoteWord, quoteGoString).
      expect(whole).toMatchObject({ kind: "txn", compares: [], failure: [] });
      expect(whole.kind === "txn" ? whole.success : []).toEqual([
        expect.objectContaining({ kind: "get", key: bytes(prefix), prefix: true }),
      ]);
    } else {
      expect(whole).toMatchObject({ kind: "get", key: bytes(prefix), prefix: true, limit: 50 });
    }

    const commands = forms.map((form) => commandOf(uncomment(form)));
    const key = bytes(sampleKey(prefix));
    const put = expect.objectContaining({ kind: "put", key, value: bytes("value") });
    const get = expect.objectContaining({ kind: "get", key, prefix: false, fromKey: false });
    const txn = expect.objectContaining({
      kind: "txn",
      compares: [{ target: "create", key, operator: "=", operand: "0" }],
      success: [put],
      failure: [get],
    });
    const del = expect.objectContaining({ kind: "del", key, prefix: false, fromKey: false });
    const watch = expect.objectContaining({ kind: "watch", key: bytes(prefix), prefix: true });
    if (UNKEPT.test(prefix)) expect(commands).toEqual([txn]);
    // The one form 6.4 does not write, left out: see the test below for why no spelling of it parses.
    else if (prefix.startsWith("-")) expect(commands).toEqual([put, del, txn]);
    else expect(commands).toEqual([put, del, watch, txn]);
    expect(commands.map((command) => assessCommand(command).class)).toEqual(
      commands.map((command) => (command.kind === "watch" ? "read" : "write")),
    );
  });

  test("a prefix that begins with - gets no # watch, because on watch no spelling of it parses", () => {
    // On `watch`, `--` introduces the command etcdctl runs for each event, which Studio refuses; without it,
    // etcdctl reads the prefix as a flag.
    for (const text of ["watch -- -app/ --prefix", "watch --prefix -- -app/", "watch -app/ --prefix"]) {
      expect(parseEtcdCommand(text, LIMITS).ok).toBe(false);
    }
    expect(generateSelectQuery(["-app/*"], [], CAPABILITIES)).not.toContain("watch");
  });

  test("the read-only form is the read alone, with its pieces (E6)", () => {
    const text = generateSelectQuery(["/app/config/*"], [], CAPABILITIES, { readOnly: true });
    expect(partsOf(text)).toEqual({ read: "get /app/config/ --prefix --limit=50", forms: [] });
  });
});

/** Pieces a user who is not root may read (#1089 4.7), one of each shape, over the same awkward text. */
const PIECES: readonly (readonly [label: string, piece: ObjectReadRange])[] = [
  ["a key", { key: "/config/a key" }],
  ["a prefix", { prefix: "/config/it's/" }],
  ["a range", { start: '/config/"a"', end: "/config/$b" }],
  ["a key that begins with -", { key: "-config" }],
  // "+" sorts before "-", so a range may end, and not start, at a key that begins with "-".
  ["a range whose end alone begins with -", { start: "+config", end: "-config" }],
  ["a prefix holding a newline", { prefix: "/config/new\nline/" }],
  ["a key holding a carriage return", { key: "/config/cr\rkey" }],
  ["a key holding a line separator", { key: "/config/ls\u2028key" }],
  ["a prefix holding a paragraph separator", { prefix: "/config/ps\u2029/" }],
];

/** What a piece's read reads: a get of its keys, as etcdctl reads the three shapes. */
function readOf(piece: ObjectReadRange) {
  if ("key" in piece)
    return expect.objectContaining({ kind: "get", key: bytes(piece.key), prefix: false, fromKey: false });
  if ("prefix" in piece) return expect.objectContaining({ kind: "get", key: bytes(piece.prefix), prefix: true });
  return expect.objectContaining({ kind: "get", key: bytes(piece.start), rangeEnd: bytes(piece.end) });
}

/** A piece's read runs as a get, or as a txn holding one where a key holds a character the editor does not keep. */
function expectReads(command: EtcdCommand, piece: ObjectReadRange): void {
  const keys = "key" in piece ? [piece.key] : "prefix" in piece ? [piece.prefix] : [piece.start, piece.end];
  if (keys.some((key) => UNKEPT.test(key))) {
    expect(command).toMatchObject({ kind: "txn", compares: [], failure: [] });
    expect(command.kind === "txn" ? command.success : []).toEqual([readOf(piece)]);
  } else {
    expect(command).toEqual(readOf(piece));
    expect(command.kind === "get" ? command.limit : undefined).toBe(50);
  }
  expect(assessCommand(command).class).toBe("read");
}

describe("the click reads each piece a user who is not root may read, as is or once uncommented (#1089 4.7, 6.4)", () => {
  test.each(PIECES)("the first piece, %s, runs, and the others parse once uncommented", (_label, first) => {
    const others = PIECES.map(([, piece]) => piece).filter((piece) => piece !== first);
    const text = generateTableQuery(["/config/*"], CAPABILITIES, [], { readRanges: [first, ...others] });
    const { read, forms } = partsOf(text);
    expect(text).not.toMatch(UNKEPT);
    expectReads(commandOf(text), first);
    expect(commandOf(text)).toEqual(commandOf(read));
    expect(forms).toHaveLength(others.length);
    forms.forEach((form, index) => expectReads(commandOf(uncomment(form)), others[index]));
  });
});

// ============================================================================
// The refresh corpus (#1089 6.2, section 10)
// ============================================================================

const REFRESH_PATTERN = CAPABILITIES.schemaRefreshPattern;

/** The command kinds whose run reloads the tree: a new or removed key can add or remove a prefix group or a lease. */
const REFRESHING: ReadonlySet<EtcdCommand["kind"]> = new Set(["put", "del", "txn", "lease-grant", "lease-revoke"]);

/**
 * Section 10's hand-written corpus, each text written plainly: the lines and leading tokens the command word may
 * follow (comment and blank lines, CRLF endings, a prompt, env, ETCDCTL_API=3, a path to etcdctl and
 * --command-timeout), commands that reload the tree and commands that do not, and keys named like a verb. A word
 * spelled in quotes, with an escape or across a line join is held to the parser by the refresh pattern's own
 * agreement corpus, in tests/unit/db/etcd/lexer.test.ts.
 */
const WRITTEN: readonly (readonly [label: string, text: string])[] = [
  ["a leading comment line", "# write it\nput /a b"],
  ["a comment line with leading whitespace", "   # write it\nput /a b"],
  ["blank lines and CRLF line endings before the command", "\r\n\r\n# note\r\n\r\ndel /a"],
  ["a leading etcdctl", "etcdctl put /a b"],
  ["a path-spelled etcdctl", "/usr/local/bin/etcdctl del /a"],
  ["a prompt", "$ etcdctl put /a b"],
  ["env and ETCDCTL_API=3", "env ETCDCTL_API=3 etcdctl put /a b"],
  ["--command-timeout=5s before the command word", "etcdctl --command-timeout=5s put /a b"],
  ["--command-timeout 5s before the command word", "--command-timeout 5s del /a"],
  ["--command-timeout=5s between lease and revoke", "lease --command-timeout=5s revoke 694d8147df1dc4c8"],
  ["--command-timeout 5s between lease and revoke", "lease --command-timeout 5s revoke 694d8147df1dc4c8"],
  ["a lease grant, whose lease the Leases folder shows", "lease grant 60"],
  ["a txn", 'txn\nmod("/a") > "0"\n\nput /a b\n\n'],
  ["a key named like a verb", "get /app/del"],
  ["a key named like Redis's verb", "get user:del"],
  ["a key named like a txn", "get /txn/x"],
  ["a key named like a lease grant", "get /lease/grant"],
  ["a commented write above a read", "# put /a b\nget /a"],
  ["a watch", "watch /app/ --prefix"],
  ["a lease keep-alive, which changes no key", "lease keep-alive --once 694d8147df1dc4c8"],
];

/**
 * Every Generate Command output of 6.4 as generated, and with each commented form uncommented as a whole,
 * every physical line of a form that spans lines included, and the read line removed.
 */
const GENERATED: readonly (readonly [label: string, text: string])[] = PREFIXES.flatMap(([label, prefix]) => {
  const text = generateSelectQuery([`${prefix}*`], [], CAPABILITIES);
  const { forms } = partsOf(text);
  const asGenerated: readonly [string, string] = [`Generate Command for a prefix holding ${label}, as generated`, text];
  const uncommented = forms.map((_form, index): readonly [string, string] => [
    `Generate Command for a prefix holding ${label}, its form ${index + 1} uncommented`,
    forms.map((other, at) => (at === index ? uncomment(other) : other)).join("\n\n"),
  ]);
  return [asGenerated].concat(uncommented);
});

describe("the refresh pattern matches exactly the texts that parse to a put, del, txn, lease grant or lease revoke", () => {
  test.each([...WRITTEN, ...GENERATED])("%s", (_label, text) => {
    const command = commandOf(text);
    expect(shouldRefreshSchema(text, REFRESH_PATTERN)).toBe(REFRESHING.has(command.kind));
  });

  test("the corpus holds texts on both sides of the pattern, the generated writes among them", () => {
    const refreshing = [...WRITTEN, ...GENERATED].filter(([, text]) => shouldRefreshSchema(text, REFRESH_PATTERN));
    expect(refreshing.length).toBeGreaterThan(0);
    expect(refreshing.length).toBeLessThan(WRITTEN.length + GENERATED.length);
    expect(GENERATED.filter(([, text]) => shouldRefreshSchema(text, REFRESH_PATTERN)).length).toBeGreaterThan(0);
  });
});
