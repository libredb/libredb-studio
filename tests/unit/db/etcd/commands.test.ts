/**
 * The etcdctl subset: editor text to one typed command (spec 5.1, 5.1.2, 5.1.3, 5.1.4).
 *
 * Tests as data over every row of 5.1.3, every rule of 5.1.2 and 5.1.4 and every refusal with its
 * whole sentence. The etcdctl facts behind them were read from etcdctl's own source at v3.7.2
 * (ctl.go, global.go, util.go and each command's file) and, where the source left a question,
 * measured with etcdctl v3.7.2 itself against a private gcr.io/etcd-development/etcd:v3.7.2:
 * --limit=010 read 8 rows (pflag parses integers in base 0), --limit=2 --limit=5 read five (the last
 * one wins), `get a b c` ignored c, `txn` ignored text after a compare's value and dropped an open
 * quote, and a lease compare panicked with "bad value".
 */
import { describe, expect, test } from "bun:test";
import {
  ETCD_COMMAND_TABLE,
  ETCD_GLOBAL_FLAG,
  ETCD_REFUSED_COMMANDS,
  ETCD_REFUSED_GLOBAL_FLAGS,
  type EtcdCommand,
  type EtcdParseLimits,
  type ParsedCommand,
  parseEtcdCommand,
} from "@/lib/db/providers/keyvalue/etcd/commands";
import { GRAMMAR_CORPUS } from "../../../fixtures/etcd/grammar-corpus";

const LIMITS: EtcdParseLimits = {
  maxLimit: 500,
  txnRangeLimit: 100,
  maxCommandTimeoutMs: 60_000,
  maxWatchWindowMs: 55_000,
};

const encoder = new TextEncoder();
const b = (text: string): Uint8Array => encoder.encode(text);

function parsed(text: string, limits: EtcdParseLimits = LIMITS): ParsedCommand {
  const result = parseEtcdCommand(text, limits);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to parse, got: ${result.refusal.message}`);
  return result.parsed;
}

const command = (text: string): EtcdCommand => parsed(text).command;

function refusal(text: string, limits: EtcdParseLimits = LIMITS) {
  const result = parseEtcdCommand(text, limits);
  if (result.ok) throw new Error(`expected ${JSON.stringify(text)} to be refused`);
  return result.refusal;
}

const GET = { prefix: false, fromKey: false, keysOnly: false, countOnly: false, consistency: "l" } as const;
const PUT = { prevKv: false, ignoreValue: false, ignoreLease: false } as const;
const DEL = { prefix: false, fromKey: false, prevKv: false } as const;

// ============================================================================
// 5.1.3: every command and every flag it takes
// ============================================================================

const ACCEPTED: readonly [text: string, command: EtcdCommand][] = [
  ["get /a", { kind: "get", key: b("/a"), ...GET }],
  ["get /a /b", { kind: "get", key: b("/a"), rangeEnd: b("/b"), ...GET }],
  ["get /a --prefix", { kind: "get", key: b("/a"), ...GET, prefix: true }],
  ["get /a --from-key", { kind: "get", key: b("/a"), ...GET, fromKey: true }],
  ["get /a --limit=10", { kind: "get", key: b("/a"), ...GET, limit: 10 }],
  ["get /a --limit 10", { kind: "get", key: b("/a"), ...GET, limit: 10 }],
  ["get /a --limit=500", { kind: "get", key: b("/a"), ...GET, limit: 500 }],
  ["get /a --limit=0", { kind: "get", key: b("/a"), ...GET }],
  ["get /a --rev=42", { kind: "get", key: b("/a"), ...GET, revision: "42" }],
  ["get /a --rev 9223372036854775807", { kind: "get", key: b("/a"), ...GET, revision: "9223372036854775807" }],
  ["get /a --keys-only", { kind: "get", key: b("/a"), ...GET, keysOnly: true }],
  ["get /a --count-only", { kind: "get", key: b("/a"), ...GET, countOnly: true }],
  ["get /a --consistency=s", { kind: "get", key: b("/a"), ...GET, consistency: "s" }],
  ["get /a --consistency l", { kind: "get", key: b("/a"), ...GET, consistency: "l" }],
  ["get --prefix /a", { kind: "get", key: b("/a"), ...GET, prefix: true }],
  ["get /a --prefix=true", { kind: "get", key: b("/a"), ...GET, prefix: true }],
  ["get /a --prefix=false", { kind: "get", key: b("/a"), ...GET }],
  ["get /a --prefix=T --keys-only=1", { kind: "get", key: b("/a"), ...GET, prefix: true, keysOnly: true }],
  ["get '' --prefix", { kind: "get", key: b(""), ...GET, prefix: true }],
  ["get '' --from-key", { kind: "get", key: b(""), ...GET, fromKey: true }],
  ["get -- -a", { kind: "get", key: b("-a"), ...GET }],
  ["get - -- --prefix", { kind: "get", key: b("-"), rangeEnd: b("--prefix"), ...GET }],
  ["put /a v", { kind: "put", key: b("/a"), value: b("v"), ...PUT }],
  ["put /a 'a b'", { kind: "put", key: b("/a"), value: b("a b"), ...PUT }],
  ["put /a ''", { kind: "put", key: b("/a"), value: b(""), ...PUT }],
  [
    "put /a v --lease=694d77aa9e38260f",
    { kind: "put", key: b("/a"), value: b("v"), ...PUT, lease: "694d77aa9e38260f" },
  ],
  ["put /a v --lease 1234ABCD", { kind: "put", key: b("/a"), value: b("v"), ...PUT, lease: "000000001234abcd" }],
  ["put /a v --lease=0", { kind: "put", key: b("/a"), value: b("v"), ...PUT }],
  ["put /a v --lease=0000 --ignore-lease", { kind: "put", key: b("/a"), value: b("v"), ...PUT, ignoreLease: true }],
  ["put /a v --prev-kv", { kind: "put", key: b("/a"), value: b("v"), ...PUT, prevKv: true }],
  ["put /a --ignore-value", { kind: "put", key: b("/a"), value: b(""), ...PUT, ignoreValue: true }],
  ["put /a v --ignore-lease", { kind: "put", key: b("/a"), value: b("v"), ...PUT, ignoreLease: true }],
  ["put /a -- -v", { kind: "put", key: b("/a"), value: b("-v"), ...PUT }],
  ["put -- -k v", { kind: "put", key: b("-k"), value: b("v"), ...PUT }],
  ["del /a", { kind: "del", key: b("/a"), ...DEL }],
  ["del /a /b", { kind: "del", key: b("/a"), rangeEnd: b("/b"), ...DEL }],
  ["del /a /b --range", { kind: "del", key: b("/a"), rangeEnd: b("/b"), ...DEL }],
  ["del /a --prefix", { kind: "del", key: b("/a"), ...DEL, prefix: true }],
  ["del /a --from-key", { kind: "del", key: b("/a"), ...DEL, fromKey: true }],
  ["del /a --prev-kv", { kind: "del", key: b("/a"), ...DEL, prevKv: true }],
  ["del '' --prefix", { kind: "del", key: b(""), ...DEL, prefix: true }],
  ["watch /a", { kind: "watch", key: b("/a"), prefix: false, prevKv: false }],
  ["watch /a /b", { kind: "watch", key: b("/a"), rangeEnd: b("/b"), prefix: false, prevKv: false }],
  ["watch /a --prefix --rev=7 --prev-kv", { kind: "watch", key: b("/a"), prefix: true, revision: "7", prevKv: true }],
  ["watch '' --prefix", { kind: "watch", key: b(""), prefix: true, prevKv: false }],
  ["lease grant 60", { kind: "lease-grant", ttlSeconds: 60 }],
  ["lease grant +010", { kind: "lease-grant", ttlSeconds: 10 }],
  // The largest TTL a number holds exactly is taken; etcd's own ceiling, 9000000000 seconds, stays etcd's to report.
  ["lease grant 9007199254740991", { kind: "lease-grant", ttlSeconds: Number.MAX_SAFE_INTEGER }],
  ["lease revoke 694d77aa9e38260f", { kind: "lease-revoke", leaseHex: "694d77aa9e38260f" }],
  ["lease revoke 00ff", { kind: "lease-revoke", leaseHex: "00000000000000ff" }],
  ["lease timetolive 694D77AA9E38260F", { kind: "lease-timetolive", leaseHex: "694d77aa9e38260f", keys: false }],
  ["lease timetolive 1 --keys", { kind: "lease-timetolive", leaseHex: "0000000000000001", keys: true }],
  ["lease list", { kind: "lease-list" }],
  ["lease keep-alive --once 7fffffffffffffff", { kind: "lease-keep-alive-once", leaseHex: "7fffffffffffffff" }],
  ["member list", { kind: "member-list", consistency: "l" }],
  ["member list --consistency=s", { kind: "member-list", consistency: "s" }],
  ["endpoint status", { kind: "endpoint-status" }],
  ["endpoint health", { kind: "endpoint-health" }],
  ["alarm list", { kind: "alarm-list" }],
  ["auth status", { kind: "auth-status" }],
  ["user list", { kind: "user-list" }],
  ["user get alice", { kind: "user-get", name: "alice", detail: false }],
  ["user get alice --detail", { kind: "user-get", name: "alice", detail: true }],
  ["role list", { kind: "role-list" }],
  ["role get reader", { kind: "role-get", name: "reader" }],
];

describe("every command of 5.1.3, with every flag it takes", () => {
  test.each(ACCEPTED)("%s", (text, expected) => {
    expect(command(text)).toEqual(expected);
  });

  test("the parsed command carries the line of its command word", () => {
    expect(parsed("\n\nget /a")).toEqual({ command: { kind: "get", key: b("/a"), ...GET }, line: 3 });
  });
});

// ============================================================================
// 5.1.3: the flags etcdctl has and the subset refuses, each with its reason
// ============================================================================

const WHOLE_RANGE = "the server loads the whole range into memory for it, whatever the limit (spec E14)";

const REFUSED_FLAGS: readonly [text: string, sentence: string][] = [
  ["get /a --sort-by=KEY", `get does not take --sort-by: ${WHOLE_RANGE}.`],
  ["get /a --order DESCEND", `get does not take --order: ${WHOLE_RANGE}.`],
  ["get /a --min-mod-rev=1", `get does not take --min-mod-rev: ${WHOLE_RANGE}.`],
  ["get /a --max-mod-rev=1", `get does not take --max-mod-rev: ${WHOLE_RANGE}.`],
  ["get /a --min-create-rev=1", `get does not take --min-create-rev: ${WHOLE_RANGE}.`],
  ["get /a --max-create-rev=1", `get does not take --max-create-rev: ${WHOLE_RANGE}.`],
  [
    "get /a --print-value-only",
    "get does not take --print-value-only: it shapes etcdctl's terminal output, and the result grid shows the value column.",
  ],
  [
    "get /a --stream",
    "get does not take --stream: it calls the RangeStream RPC, which Studio does not call; the same command without it answers the same rows within the result's bounds.",
  ],
  [
    "txn -i",
    "txn does not take --interactive: Studio has no terminal to prompt in; write the compares and the requests on the lines below txn.",
  ],
  [
    "txn --interactive=false",
    "txn does not take --interactive: Studio has no terminal to prompt in; write the compares and the requests on the lines below txn.",
  ],
  ["watch /a -i", "watch does not take --interactive: Studio has no terminal to prompt in."],
  [
    "watch /a --progress-notify",
    "watch does not take --progress-notify: a watch in Studio is bounded and returns its events when its window closes, with no progress notices.",
  ],
  [
    "endpoint status --cluster",
    "endpoint status does not take --cluster: Studio dials only the configured endpoint, never the addresses the members advertise (spec E3).",
  ],
  [
    "endpoint health --cluster",
    "endpoint health does not take --cluster: Studio dials only the configured endpoint, never the addresses the members advertise (spec E3).",
  ],
  [
    "get /a --help",
    "get does not take --help: Studio prints no help, and the provider doc lists every command and flag.",
  ],
  [
    "lease list -h",
    "lease list does not take --help: Studio prints no help, and the provider doc lists every command and flag.",
  ],
];

describe("flags etcdctl has and the subset refuses are refused by name, with the reason (spec 5.1)", () => {
  test.each(REFUSED_FLAGS)("%s", (text, message) => {
    expect(refusal(text)).toMatchObject({ code: "refused-flag", message });
  });

  test("the refusal places the flag", () => {
    expect(refusal("get /a\\\n  --stream")).toMatchObject({ line: 2, column: 2 });
  });
});

describe("a flag etcdctl does not have is refused as unknown (spec 5.1.3)", () => {
  test.each([
    [
      "get /a --pefix",
      "get has no flag --pefix: the flags get takes are --prefix, --from-key, --limit=<n>, --rev=<n>, --keys-only, --count-only and --consistency=l|s. A word that begins with - and is not a flag is written after --, as in get -- -key.",
    ],
    [
      "put /a -1",
      "put has no flag -1: the flags put takes are --lease=<hex id>, --prev-kv, --ignore-value and --ignore-lease. A word that begins with - and is not a flag is written after --, as in put -- -key -value.",
    ],
    ["lease grant 5 --x", "lease grant has no flag --x: it takes no flags."],
    [
      "user get alice --x",
      "user get has no flag --x: the flag user get takes is --detail. A word that begins with - and is not a flag is written after --, as in user get -- -name.",
    ],
    ["member list --foo=bar", "member list has no flag --foo: the flag member list takes is --consistency=l|s."],
    ["alarm list -z", "alarm list has no flag -z: it takes no flags."],
    ["watch /a --since=1", "watch has no flag --since: the flags watch takes are --prefix, --rev=<n> and --prev-kv."],
    [
      "get /a ---prefix",
      "get has no flag ---prefix: the flags get takes are --prefix, --from-key, --limit=<n>, --rev=<n>, --keys-only, --count-only and --consistency=l|s. A word that begins with - and is not a flag is written after --, as in get -- -key.",
    ],
    [
      "get /a --=x",
      "get has no flag --: the flags get takes are --prefix, --from-key, --limit=<n>, --rev=<n>, --keys-only, --count-only and --consistency=l|s. A word that begins with - and is not a flag is written after --, as in get -- -key.",
    ],
  ])("%s", (text, message) => {
    expect(refusal(text)).toMatchObject({ code: "unknown-flag", message });
  });

  test("a flag's value is never echoed, only its name", () => {
    expect(refusal("get /a --secret=hunter2").message).not.toContain("hunter2");
    expect(refusal("get /a --secret=hunter2").message).toContain("--secret");
  });
});

// ============================================================================
// 5.1.2: global flags, --command-timeout, leading tokens, one command per run
// ============================================================================

const WHERE = "the connection, not the command, decides where Studio connects and as whom";

describe("every global flag but --command-timeout is refused by name (spec 5.1.2)", () => {
  const reasonOf = (name: string): string => {
    if (["dial-timeout", "keepalive-time", "keepalive-timeout"].includes(name))
      return "the connection decides how Studio keeps its channel to etcd";
    if (["max-request-bytes", "max-recv-bytes"].includes(name))
      return "Studio bounds every request and every answer itself";
    if (["write-out", "hex"].includes(name)) return "the result grid decides the output";
    if (name === "debug") return "it switches on etcdctl's own client logging, which Studio does not have";
    return WHERE;
  };

  test("the refused set is etcdctl v3.7.2's global flags (ctl.go) but --command-timeout", () => {
    expect(ETCD_REFUSED_GLOBAL_FLAGS.map((flag) => flag.flag)).toEqual([
      "--endpoints",
      "--user",
      "--password",
      "--cacert",
      "--cert",
      "--key",
      "--insecure-transport",
      "--insecure-skip-tls-verify",
      "--insecure-discovery",
      "--discovery-srv",
      "--discovery-srv-name",
      "--dial-timeout",
      "--keepalive-time",
      "--keepalive-timeout",
      "--max-request-bytes",
      "--max-recv-bytes",
      "--auth-jwt-token",
      "--write-out",
      "--hex",
      "--debug",
    ]);
  });

  test.each(ETCD_REFUSED_GLOBAL_FLAGS.map((flag) => [flag.flag.slice(2)]))("--%s", (name) => {
    const message = `The global flag --${name} is refused: ${reasonOf(name)}. The one global flag a command takes is --command-timeout.`;
    expect(ETCD_REFUSED_GLOBAL_FLAGS.find((flag) => flag.flag === `--${name}`)?.reason).toBe(reasonOf(name));
    expect(refusal(`get /a --${name}=x`)).toMatchObject({ code: "global-flag", message });
    expect(refusal(`etcdctl --${name}=x get /a`)).toMatchObject({ code: "global-flag", message, column: 8 });
  });

  test("member list refuses --hex as the global flag it is (spec 5.1.3)", () => {
    expect(refusal("member list --hex")).toMatchObject({
      code: "global-flag",
      message:
        "The global flag --hex is refused: the result grid decides the output. The one global flag a command takes is --command-timeout.",
    });
  });

  test("the two shorthands, -w and -d", () => {
    expect(refusal("etcdctl -w json get /a").message).toContain("The global flag --write-out is refused");
    expect(refusal("get /a -wjson").message).toContain("The global flag --write-out is refused");
    expect(refusal("get /a -d x").message).toContain("The global flag --discovery-srv is refused");
  });

  test("a password in a flag is never echoed", () => {
    const { message } = refusal("etcdctl --user=root:hunter2 get /a");
    expect(message).not.toContain("hunter2");
    expect(refusal("etcdctl --password hunter2 get /a").message).not.toContain("hunter2");
  });
});

describe("--command-timeout, the one global flag (spec 5.1.2)", () => {
  test("is spelled as 5.1.2 writes it", () => {
    expect(ETCD_GLOBAL_FLAG).toBe("--command-timeout=<duration>");
  });

  test.each([
    ["get /a --command-timeout=5s", 5_000],
    ["get /a --command-timeout 500ms", 500],
    ["--command-timeout=1m30s get /a", 90_000],
    ["etcdctl --command-timeout 1.5s get /a", 1_500],
    ["lease --command-timeout 5s grant 10", 5_000],
    ["get --command-timeout=2h /a", 60_000 * 120],
    ["get /a --command-timeout=1us", 1],
    ["get /a --command-timeout=1500µs", 2],
    ["get /a --command-timeout=1500μs", 2],
    ["get /a --command-timeout=+.5s", 500],
    ["get /a --command-timeout=5.s", 5_000],
    ["get /a --command-timeout=60s", 60_000],
    // Go 1.27's time.ParseDuration, measured: 0.067s is 67000000 ns, 1.1m 66000000000 and 0.0011h 3960000000.
    ["get /a --command-timeout=0.067s", 67],
    ["get /a --command-timeout=1.1m", 66_000],
    ["get /a --command-timeout=0.0011h", 3_960],
    // The largest duration Go holds, 2^63 - 1 ns, in two spellings.
    ["get /a --command-timeout=9223372036854775807ns", 9_223_372_036_855],
    ["get /a --command-timeout=2562047h47m16.854775807s", 9_223_372_036_855],
    // Go keeps a fraction's digits only while they fit its integer, then adds the fraction in floating point:
    // it reads 0.999999999999999999999ns as 1 ns (measured), where all 21 digits would make 0 ns.
    ["get /a --command-timeout=0.999999999999999999999ns", 1],
  ])("%s is %d ms", (text, ms) => {
    const limits = { ...LIMITS, maxCommandTimeoutMs: Number.POSITIVE_INFINITY };
    expect(parsed(text, limits).commandTimeoutMs).toBe(ms);
  });

  test("every exact millisecond from 0.001s to 20.000s is that many milliseconds, as time.ParseDuration reads it", () => {
    const limits = { ...LIMITS, maxCommandTimeoutMs: Number.POSITIVE_INFINITY };
    const wrong: string[] = [];
    for (let ms = 1; ms <= 20_000; ms++) {
      const text = `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}s`;
      const read = parseEtcdCommand(`get /a --command-timeout=${text}`, limits);
      if (!read.ok || read.parsed.commandTimeoutMs !== ms) wrong.push(text);
    }
    expect(wrong).toEqual([]);
  });

  test("a duration exactly at the cap is taken, and one a millisecond past it is refused", () => {
    const cap = { ...LIMITS, maxCommandTimeoutMs: 2_011 };
    expect(parsed("get /a --command-timeout=2.011s", cap).commandTimeoutMs).toBe(2_011);
    expect(parsed("get /a --command-timeout=2011ms", cap).commandTimeoutMs).toBe(2_011);
    expect(refusal("get /a --command-timeout=2.012s", cap).code).toBe("limit-too-large");
    expect(parsed("get /a --command-timeout=60000ms").commandTimeoutMs).toBe(60_000);
    expect(refusal("get /a --command-timeout=60001ms")).toEqual({
      code: "limit-too-large",
      line: 1,
      column: 7,
      message:
        "--command-timeout=60001ms is above this connection's query timeout, 60 s: lower it, or raise Query Timeout in the connection's settings.",
    });
  });

  test("absent, it is absent", () => {
    expect(parsed("get /a").commandTimeoutMs).toBeUndefined();
  });

  test.each(["5", "5x", "", "abc", ".s", "1.5", "1h-2m", "--", "-", "5ss"])("%j is no Go duration", (value) => {
    expect(refusal(`get /a --command-timeout=${value}`)).toMatchObject({
      code: "bad-argument",
      message: "--command-timeout takes a Go duration such as 500ms, 5s or 1m30s.",
    });
  });

  // Go reads 0.0000000000000000000000000001h as 0 ns (measured), so it is no timeout at all, and it holds
  // -2^63 ns, one nanosecond more than it holds above zero.
  test.each(["0", "0s", "-5s", "-0", "0.0000000000000000000000000001h", "-9223372036854775808ns"])(
    "%s is not longer than zero",
    (value) => {
      expect(refusal(`get /a --command-timeout=${value}`)).toMatchObject({
        code: "bad-argument",
        message: "--command-timeout must be longer than zero.",
      });
    },
  );

  test("a duration past what Go holds is no duration", () => {
    expect(refusal("get /a --command-timeout=3000000h").code).toBe("bad-argument");
    for (const past of ["9223372036854775808ns", "2562047h47m16.854775808s", "-9223372036854775809ns"]) {
      expect(refusal(`get /a --command-timeout=${past}`)).toMatchObject({
        code: "bad-argument",
        message: "--command-timeout takes a Go duration such as 500ms, 5s or 1m30s.",
      });
    }
  });

  test("above the connection's query timeout it is refused, naming the cap", () => {
    expect(refusal("get /a --command-timeout=61s")).toEqual({
      code: "limit-too-large",
      line: 1,
      column: 7,
      message:
        "--command-timeout=61s is above this connection's query timeout, 60 s: lower it, or raise Query Timeout in the connection's settings.",
    });
    expect(refusal("get /a --command-timeout=1500ms", { ...LIMITS, maxCommandTimeoutMs: 1_200 }).message).toContain(
      "query timeout, 1200 ms:",
    );
  });

  test("on watch it is the window, capped by the watch's own bound", () => {
    expect(parsed("watch /a --command-timeout=55s").commandTimeoutMs).toBe(55_000);
    expect(refusal("watch /a --command-timeout=56s")).toMatchObject({
      code: "limit-too-large",
      message:
        "--command-timeout=56s sets the watch window, which is at most 55 s on this connection, its query timeout less the time a watch needs to return its events: lower it, or raise Query Timeout in the connection's settings.",
    });
  });

  test("given twice it is refused", () => {
    expect(refusal("--command-timeout=5s get /a --command-timeout=6s")).toMatchObject({
      code: "conflicting-flags",
      message: "--command-timeout is given twice: give it once.",
      column: 28,
    });
  });

  test("with no value it is refused", () => {
    expect(refusal("get /a --command-timeout")).toMatchObject({
      code: "bad-argument",
      message: "--command-timeout needs a value, as in --command-timeout=5s.",
    });
    expect(refusal("etcdctl --command-timeout")).toMatchObject({ code: "bad-argument" });
  });

  test("after -- it is an argument", () => {
    expect(command("put /a -- --command-timeout=5s")).toMatchObject({ value: b("--command-timeout=5s") });
  });
});

describe("the leading tokens a documented command carries (spec 5.1.2)", () => {
  test.each([
    "$ get /a",
    "% get /a",
    "env get /a",
    "ETCDCTL_API=3 get /a",
    "ETCDCTL_API=3 ETCDCTL_API=3 get /a",
    "etcdctl get /a",
    "./etcdctl get /a",
    "/usr/local/bin/etcdctl get /a",
    "$ env ETCDCTL_API=3 /opt/etcd/etcdctl get /a",
    'ETCDCTL_API="3" etcdctl get /a',
  ])("%s", (text) => {
    expect(command(text)).toEqual({ kind: "get", key: b("/a"), ...GET });
  });

  test.each([
    ["ETCDCTL_ENDPOINTS=10.0.0.5:2379 etcdctl get /a", "ETCDCTL_ENDPOINTS"],
    ["ETCDCTL_API=2 etcdctl get /a", "ETCDCTL_API"],
    ["ETCDCTL_PASSWORD=hunter2 etcdctl get /a", "ETCDCTL_PASSWORD"],
    ["env FOO=bar get /a", "FOO"],
  ])("%s is refused by name, without its value", (text, name) => {
    const found = refusal(text);
    expect(found).toMatchObject({
      code: "global-flag",
      message: `The environment variable ${name} is refused: before a command Studio accepts only ETCDCTL_API=3, because ${WHERE}.`,
    });
    expect(found.message).not.toContain("hunter2");
  });

  test("every assignment is checked, not only the first", () => {
    expect(refusal("ETCDCTL_API=3 ETCDCTL_ENDPOINTS=x etcdctl get /a")).toEqual({
      code: "global-flag",
      line: 1,
      column: 14,
      message: `The environment variable ETCDCTL_ENDPOINTS is refused: before a command Studio accepts only ETCDCTL_API=3, because ${WHERE}.`,
    });
  });

  test("every flag before the command word is read, the one after --command-timeout's value included", () => {
    expect(refusal("etcdctl --command-timeout 5s --endpoints=x get /a")).toEqual({
      code: "global-flag",
      line: 1,
      column: 29,
      message: `The global flag --endpoints is refused: ${WHERE}. The one global flag a command takes is --command-timeout.`,
    });
  });

  // Measured with etcdctl v3.7.2: --prefix=true get /a/ printed both keys, endpoint --cluster status and
  // member --consistency=s list ran, and only the spaced --prefix get /a/ failed, with unknown command "/a/".
  // Studio takes a command's own flag in one place, after the command and its subcommand.
  test("a command's own flag before the command word is refused", () => {
    expect(refusal("etcdctl --prefix get /a")).toEqual({
      code: "unknown-flag",
      line: 1,
      column: 8,
      message:
        "--prefix comes before the command word, and Studio takes a command's own flags only after the command and its subcommand: write it after them.",
    });
    expect(refusal("etcdctl --prefix=true get /a").message).toBe(
      "--prefix comes before the command word, and Studio takes a command's own flags only after the command and its subcommand: write it after them.",
    );
    expect(refusal("-- get /a")).toMatchObject({
      code: "unknown-flag",
      message: expect.stringContaining("-- comes before"),
    });
  });

  test("a flag between a command and its subcommand is refused, but --command-timeout", () => {
    const between = (flag: string, group: string) =>
      `${flag} comes between ${group} and its subcommand, and Studio takes a command's own flags only after both: write it after ${group} and its subcommand.`;
    expect(refusal("lease --keys timetolive 1")).toEqual({
      code: "unknown-flag",
      line: 1,
      column: 6,
      message: between("--keys", "lease"),
    });
    expect(refusal("lease --command-timeout 5s --keys timetolive 1")).toEqual({
      code: "unknown-flag",
      line: 1,
      column: 27,
      message: between("--keys", "lease"),
    });
    expect(refusal("member --consistency=s list")).toMatchObject({
      code: "unknown-flag",
      message: between("--consistency", "member"),
    });
    expect(refusal("member --endpoints=x list").code).toBe("global-flag");
    expect(refusal("member --help list")).toMatchObject({
      code: "refused-flag",
      message: "member does not take --help: Studio prints no help, and the provider doc lists every command and flag.",
    });
    expect(refusal("etcdctl --help")).toMatchObject({
      code: "refused-flag",
      message: "--help is refused: Studio prints no help, and the provider doc lists every command and flag.",
    });
    expect(parsed("member --command-timeout=5s list")).toMatchObject({ commandTimeoutMs: 5_000 });
  });

  test("a group's own flag between it and its subcommand is refused by name, with the reason (spec 5.1, E3)", () => {
    // etcdctl v3.7.2 declares --cluster on the endpoint group (ep_command.go, NewEndpointCommand).
    const cluster =
      "endpoint does not take --cluster: Studio dials only the configured endpoint, never the addresses the members advertise (spec E3).";
    expect(refusal("endpoint --cluster status")).toEqual({
      code: "refused-flag",
      line: 1,
      column: 9,
      message: cluster,
    });
    expect(refusal("endpoint --cluster=false health")).toMatchObject({ code: "refused-flag", message: cluster });
    expect(refusal("etcdctl endpoint --command-timeout 5s --cluster status")).toMatchObject({
      code: "refused-flag",
      column: 38,
      message: cluster,
    });
  });

  test("the text holds no command", () => {
    const empty = {
      code: "empty",
      message: "The editor holds no etcd command: write one, such as get /app/ --prefix.",
    };
    expect(refusal("")).toMatchObject(empty);
    expect(refusal("\n  \n# only a comment\n")).toMatchObject(empty);
    expect(refusal("$ ETCDCTL_API=3 etcdctl")).toMatchObject(empty);
    expect(refusal("etcdctl --command-timeout=5s")).toMatchObject(empty);
  });
});

describe("one command per run (spec 5.1.2)", () => {
  test("blank and comment lines around the command are fine", () => {
    expect(command("# read one key\n\nget /a # the key\n\n  # done\n")).toEqual({ kind: "get", key: b("/a"), ...GET });
  });

  test("a second command is refused, naming its line and its first word only", () => {
    expect(refusal("get /a\n\nput /db/password hunter2")).toEqual({
      code: "second-command",
      line: 3,
      column: 0,
      message:
        "Line 3 holds a second command, which begins with put: Studio runs one command per run. Select the line to run it, and the editor sends the selection.",
    });
    expect(refusal("get /a\n  del /b").column).toBe(2);
    expect(refusal("get /a\nFOO=secret-value").message).toContain("begins with FOO:");
    // The first word ends at a tab as at a space.
    expect(refusal("get /a\nput\t/db/password hunter2").message).toContain("begins with put:");
  });

  test("a long first word is cut", () => {
    expect(refusal(`get /a\n${"x".repeat(80)}`).message).toContain(`begins with ${"x".repeat(40)}...:`);
  });

  test("a name is cut after 40 characters, and never inside one", () => {
    // U+1D11E is two UTF-16 units: a cut at the 40th unit would leave half of it.
    expect(refusal(`${"x".repeat(39)}𝄞𝄞 /a`).message).toBe(
      `${"x".repeat(39)}𝄞... is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`,
    );
    expect(refusal(`${"x".repeat(39)}𝄞 /a`).message).toBe(
      `${"x".repeat(39)}𝄞 is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`,
    );
  });
});

// ============================================================================
// 5.1.3: refused commands, unknown commands
// ============================================================================

const COMMAND_LIST =
  "get, put, del, txn, watch, lease grant, lease revoke, lease timetolive, lease list, lease keep-alive, member list, endpoint status, endpoint health, alarm list, auth status, user list, user get, role list and role get";

describe("commands the subset refuses by name, each with its reason (spec 5.1.3)", () => {
  const maintenance = (words: string, card: string) =>
    `${words} is a maintenance operation: an admin runs it from the ${card} card in the Global Operations section of Admin > Operations, which asks for a typed confirmation.`;
  const notOffered = (words: string, reason: string) => `${words} is not offered in this version: ${reason}.`;
  const MEMBERSHIP = "Studio changes no cluster membership and moves no leader";
  const ACCOUNTS = "Studio writes no users or roles; it reads them with user list, user get, role list and role get";
  const INFO = "it prints etcdctl's own information, and the provider doc lists the commands Studio runs";

  const CASES: readonly [text: string, code: string, message: string][] = [
    ["compaction 42", "maintenance-command", maintenance("compaction", "Compact history")],
    ["defrag", "maintenance-command", maintenance("defrag", "Defragment")],
    ["alarm disarm", "maintenance-command", maintenance("alarm disarm", "Disarm alarms")],
    ["member add m4 --peer-urls=http://x:2380", "not-offered", notOffered("member add", MEMBERSHIP)],
    ["member remove 8e9e05c52164694d", "not-offered", notOffered("member remove", MEMBERSHIP)],
    ["member update 1 --peer-urls=x", "not-offered", notOffered("member update", MEMBERSHIP)],
    ["member promote 1", "not-offered", notOffered("member promote", MEMBERSHIP)],
    ["move-leader 1", "not-offered", notOffered("move-leader", MEMBERSHIP)],
    [
      "snapshot save /tmp/s.db",
      "not-offered",
      notOffered("snapshot save", "Studio takes no snapshot, which etcdctl writes to a file on its own machine"),
    ],
    ["downgrade validate 3.6", "not-offered", notOffered("downgrade validate", "Studio changes no cluster version")],
    ["downgrade enable 3.6", "not-offered", notOffered("downgrade enable", "Studio changes no cluster version")],
    ["downgrade cancel", "not-offered", notOffered("downgrade cancel", "Studio changes no cluster version")],
    ["auth enable", "not-offered", notOffered("auth enable", "Studio does not turn authentication on or off")],
    ["auth disable", "not-offered", notOffered("auth disable", "Studio does not turn authentication on or off")],
    ["user add bob", "not-offered", notOffered("user add", ACCOUNTS)],
    ["user delete bob", "not-offered", notOffered("user delete", ACCOUNTS)],
    ["user passwd bob", "not-offered", notOffered("user passwd", ACCOUNTS)],
    ["user grant-role bob root", "not-offered", notOffered("user grant-role", ACCOUNTS)],
    ["user revoke-role bob root", "not-offered", notOffered("user revoke-role", ACCOUNTS)],
    ["role add r", "not-offered", notOffered("role add", ACCOUNTS)],
    ["role delete r", "not-offered", notOffered("role delete", ACCOUNTS)],
    ["role grant-permission r read /a", "not-offered", notOffered("role grant-permission", ACCOUNTS)],
    ["role revoke-permission r /a", "not-offered", notOffered("role revoke-permission", ACCOUNTS)],
    ["lock mylock", "blocking-command", "lock blocks until another client acts, and Studio holds no session for it."],
    ["elect e p", "blocking-command", "elect blocks until another client acts, and Studio holds no session for it."],
    ["make-mirror dest:2379", "not-offered", notOffered("make-mirror", "Studio copies no keys to another cluster")],
    ["check perf", "not-offered", notOffered("check perf", "Studio puts no test load on the cluster")],
    ["check datascale", "not-offered", notOffered("check datascale", "Studio puts no test load on the cluster")],
    ["endpoint hashkv", "not-offered", notOffered("endpoint hashkv", "Studio reads no history hash")],
    ["version", "not-offered", notOffered("version", INFO)],
    ["completion bash", "not-offered", notOffered("completion", INFO)],
    ["options", "not-offered", notOffered("options", INFO)],
    ["help get", "not-offered", notOffered("help", INFO)],
  ];

  test.each(CASES)("%s", (text, code, message) => {
    expect(refusal(text)).toMatchObject({ code, message });
  });

  test("the refused table is the list of 5.1.3", () => {
    expect(ETCD_REFUSED_COMMANDS.map((entry) => entry.words.join(" "))).toEqual(
      CASES.map(([text]) => {
        const [first, second] = text.split(" ");
        const grouped = ["member", "snapshot", "downgrade", "auth", "user", "role", "check", "endpoint", "alarm"];
        return grouped.includes(first) ? `${first} ${second}` : first;
      }),
    );
  });

  test("a refused command is refused before its flags and arguments are read", () => {
    expect(refusal("compaction --physical --endpoints=x").code).toBe("maintenance-command");
  });
});

describe("anything else is an unknown command, with the list of commands the provider runs (spec 5.1.3)", () => {
  test.each([
    ["migrate", `migrate is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
    ["snapshot restore x", `snapshot restore is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
    ["snapshot status x", `snapshot status is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
    ["ge /a", `ge is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
    ["GET /a", `GET is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
    ["- /a", `- is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
    // Only etcdctl itself, or a path ending in /etcdctl, is the etcdctl word.
    ["myetcdctl get /a", `myetcdctl is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
    [
      "etcdctl ETCDCTL_PASSWORD=hunter2 get",
      `ETCDCTL_PASSWORD is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`,
    ],
  ])("%s", (text, message) => {
    expect(refusal(text)).toMatchObject({ code: "unknown-command", message });
  });

  test.each([
    ["lease", "lease needs a subcommand: grant, revoke, timetolive, list or keep-alive."],
    ["lease --command-timeout=5s", "lease needs a subcommand: grant, revoke, timetolive, list or keep-alive."],
    ["member", "member needs a subcommand: list."],
    ["endpoint", "endpoint needs a subcommand: status or health."],
    ["alarm", "alarm needs a subcommand: list."],
    ["auth", "auth needs a subcommand: status."],
    ["user", "user needs a subcommand: list or get."],
    ["role", "role needs a subcommand: list or get."],
    ["snapshot", "snapshot needs a subcommand, and Studio runs none of its subcommands."],
    [
      "lease show 1",
      "lease has no subcommand show that Studio runs: the lease subcommands are grant, revoke, timetolive, list and keep-alive.",
    ],
    ["user ls", "user has no subcommand ls that Studio runs: the user subcommands are list and get."],
    ["member foo", "member has no subcommand foo that Studio runs: the member subcommand is list."],
    ["check foo", `check foo is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`],
  ])("%s", (text, message) => {
    expect(refusal(text)).toMatchObject({ code: "unknown-command", message });
  });
});

// ============================================================================
// 5.1.3: etcdctl's own argument rules
// ============================================================================

const PREFIX_FROM_KEY = "`--prefix` and `--from-key` cannot be set at the same time, choose one.";
const KEYS_COUNT = "`--keys-only` and `--count-only` cannot be set at the same time, choose one.";
const PLAIN_LIMIT =
  "--limit takes a whole number written in plain decimal digits, such as --limit=50: etcdctl reads 010 as octal 8 and 0x10 as 16, so Studio takes only the plain form.";
const PLAIN_REV =
  "--rev takes a revision, a whole number of 1 or more written in plain decimal digits, such as --rev=42.";
const UNSIGNED_LEASE =
  "as lease list prints the ids etcd grants, such as 694d77aa9e38260f: Studio does not address a negative id, which etcd holds only when a client chose it";

const ARGUMENT_RULES: readonly [text: string, code: string, message: string][] = [
  ["get /a --prefix --from-key", "conflicting-flags", PREFIX_FROM_KEY],
  ["del /a --prefix --from-key", "conflicting-flags", PREFIX_FROM_KEY],
  ["get /a --keys-only --count-only", "conflicting-flags", KEYS_COUNT],
  [
    "get /a /b --prefix",
    "bad-argument",
    "get takes no range end beside --prefix or --from-key: they name the range themselves.",
  ],
  [
    "get /a /b --from-key",
    "bad-argument",
    "get takes no range end beside --prefix or --from-key: they name the range themselves.",
  ],
  [
    "del /a /b --prefix",
    "bad-argument",
    "del takes no range end beside --prefix or --from-key: they name the range themselves.",
  ],
  ["watch /a /b --prefix", "conflicting-flags", "`range_end` and `--prefix` are mutually exclusive."],
  [
    "get /a --limit=501",
    "limit-too-large",
    "--limit=501 is above the most rows a result holds, 500: ask for 500 or fewer.",
  ],
  ["get /a --limit=010", "bad-argument", PLAIN_LIMIT],
  ["get /a --limit=0x10", "bad-argument", PLAIN_LIMIT],
  ["get /a --limit=1_000", "bad-argument", PLAIN_LIMIT],
  ["get /a --limit=-1", "bad-argument", PLAIN_LIMIT],
  ["get /a --limit=", "bad-argument", PLAIN_LIMIT],
  ["get /a --limit", "bad-argument", "--limit needs a value, as in --limit=50."],
  ["get /a --rev=0", "bad-argument", PLAIN_REV],
  ["get /a --rev=-5", "bad-argument", PLAIN_REV],
  ["get /a --rev=010", "bad-argument", PLAIN_REV],
  ["watch /a --rev=x", "bad-argument", PLAIN_REV],
  [
    "get /a --rev=9223372036854775808",
    "bad-argument",
    "--rev is past the largest revision etcd holds, 9223372036854775807.",
  ],
  ["get /a --consistency=x", "bad-argument", "--consistency takes l (linearizable) or s (serializable)."],
  ["member list --consistency=L", "bad-argument", "--consistency takes l (linearizable) or s (serializable)."],
  ["get /a --prefix=yes", "bad-argument", "--prefix takes true or false, as in --prefix=true."],
  ["get /a --limit=5 --limit=6", "conflicting-flags", "--limit is given twice: give it once."],
  ["get /a --prefix --prefix=false", "conflicting-flags", "--prefix is given twice: give it once."],
  ["get", "bad-argument", "get needs a key and takes at most a range end: get <key> [<range_end>]."],
  ["get /a /b /c", "bad-argument", "get needs a key and takes at most a range end: get <key> [<range_end>]."],
  [
    "get ''",
    "bad-argument",
    'get needs a key that is not empty, as etcd answers "key is not provided": an empty key with --prefix or --from-key reads every key.',
  ],
  [
    "get '' /b",
    "bad-argument",
    'get needs a key that is not empty, as etcd answers "key is not provided": an empty key with --prefix or --from-key reads every key.',
  ],
  [
    "del ''",
    "bad-argument",
    'del needs a key that is not empty, as etcd answers "key is not provided": an empty key with --prefix or --from-key reads every key.',
  ],
  [
    "watch ''",
    "bad-argument",
    'watch needs a key that is not empty, as etcd answers "key is not provided": an empty key with --prefix watches every key.',
  ],
  ["put '' v", "bad-argument", 'put needs a key that is not empty, as etcd answers "key is not provided".'],
  [
    "get /a ''",
    "bad-argument",
    "The range end of get is empty, which etcd reads as the key alone: leave it out, or write the key the range ends before.",
  ],
  [
    "del /a ''",
    "bad-argument",
    "The range end of del is empty, which etcd reads as the key alone: leave it out, or write the key the range ends before.",
  ],
  [
    "watch /a ''",
    "bad-argument",
    "The range end of watch is empty, which etcd reads as the key alone: leave it out, or write the key the range ends before.",
  ],
  ["put", "bad-argument", "put needs a key and a value: put <key> <value>, or put <key> --ignore-value."],
  [
    "put /a",
    "bad-argument",
    "put needs a value after the key, since Studio has no standard input to read it from: write the value after the key, or use --ignore-value to keep the current one.",
  ],
  [
    "put /a v --ignore-value",
    "bad-argument",
    "put takes no value beside --ignore-value, which keeps the key's current value.",
  ],
  [
    "put /a v w",
    "bad-argument",
    "put takes a key and a value, and the word at line 1, column 10 is a third: quote a value that holds spaces, as in put /key 'a b'.",
  ],
  [
    "put /a v --lease=1 --ignore-lease",
    "bad-argument",
    'put takes no --lease beside --ignore-lease, which keeps the key\'s current lease: etcd would answer "lease is provided".',
  ],
  [
    "put /a v --lease=xyz",
    "bad-argument",
    "--lease takes a lease id in hexadecimal, as lease list prints it, such as 694d77aa9e38260f; 0 means no lease.",
  ],
  ["put /a v --lease=8000000000000000", "bad-argument", "--lease is past the largest lease id, 7fffffffffffffff."],
  ["del", "bad-argument", "del needs a key and takes at most a range end: del <key> [<range_end>]."],
  ["del /a /b /c", "bad-argument", "del needs a key and takes at most a range end: del <key> [<range_end>]."],
  [
    "del /a --prefix --prev-kv",
    "conflicting-flags",
    "del refuses --prev-kv beside a range end, --prefix or --from-key: etcd would read every deleted pair with no limit and return them all in one answer (spec E14). Delete without --prev-kv, or read the range with get first.",
  ],
  [
    "del /a --from-key --prev-kv",
    "conflicting-flags",
    "del refuses --prev-kv beside a range end, --prefix or --from-key: etcd would read every deleted pair with no limit and return them all in one answer (spec E14). Delete without --prev-kv, or read the range with get first.",
  ],
  [
    "del /a /b --prev-kv",
    "conflicting-flags",
    "del refuses --prev-kv beside a range end, --prefix or --from-key: etcd would read every deleted pair with no limit and return them all in one answer (spec E14). Delete without --prev-kv, or read the range with get first.",
  ],
  ["txn x", "bad-argument", "txn takes nothing on its line: write its compares and requests on the lines below it."],
  ["watch", "bad-argument", "watch needs a key and takes at most a range end: watch <key> [<range_end>]."],
  ["watch /a /b /c", "bad-argument", "watch needs a key and takes at most a range end: watch <key> [<range_end>]."],
  [
    "watch /a -- echo hi",
    "bad-argument",
    "watch runs no program: Studio refuses -- and the command after it, which etcdctl runs for each event.",
  ],
  ["lease grant", "bad-argument", "lease grant needs one TTL in seconds: lease grant <ttl>."],
  ["lease grant 1 2", "bad-argument", "lease grant needs one TTL in seconds: lease grant <ttl>."],
  ["lease grant x", "bad-argument", "lease grant takes a TTL in whole seconds, 1 or more, such as 60."],
  ["lease grant 0", "bad-argument", "lease grant takes a TTL in whole seconds, 1 or more, such as 60."],
  ["lease grant -- -5", "bad-argument", "lease grant takes a TTL in whole seconds, 1 or more, such as 60."],
  [
    "lease grant 9007199254740992",
    "bad-argument",
    "The TTL of lease grant is too large to send exactly; etcd grants at most 9000000000 seconds.",
  ],
  ["lease revoke", "bad-argument", "lease revoke needs one lease id: lease revoke <hex id>."],
  [
    "lease revoke xyz",
    "bad-argument",
    "lease revoke takes a lease id in hexadecimal, as lease list prints it, such as 694d77aa9e38260f.",
  ],
  // Measured on etcd v3.7.2: a grant carrying the id -5 was granted, and etcdctl's lease list printed it as
  // -000000000000005; the ids etcd picks itself are positive (v3_server.go LeaseGrant).
  ["lease revoke +ff", "bad-argument", `lease revoke takes a lease id without a sign, ${UNSIGNED_LEASE}.`],
  ["lease timetolive -- -5", "bad-argument", `lease timetolive takes a lease id without a sign, ${UNSIGNED_LEASE}.`],
  [
    "lease keep-alive --once -- -000000000000005",
    "bad-argument",
    `lease keep-alive takes a lease id without a sign, ${UNSIGNED_LEASE}.`,
  ],
  ["put /a v --lease=-5", "bad-argument", `--lease takes a lease id without a sign, ${UNSIGNED_LEASE}.`],
  [
    "lease revoke 18000000000000000",
    "bad-argument",
    "lease revoke's lease id is past the largest lease id, 7fffffffffffffff.",
  ],
  ["lease timetolive", "bad-argument", "lease timetolive needs one lease id: lease timetolive <hex id>."],
  [
    "lease keep-alive 1",
    "bad-argument",
    "lease keep-alive needs --once: without it the keep-alive never ends, and Studio sends one exchange.",
  ],
  ["lease keep-alive --once", "bad-argument", "lease keep-alive needs one lease id: lease keep-alive <hex id>."],
  [
    "lease keep-alive --once=false 1",
    "bad-argument",
    "lease keep-alive needs --once: without it the keep-alive never ends, and Studio sends one exchange.",
  ],
  ["lease list x", "bad-argument", "lease list takes no arguments."],
  ["member list x", "bad-argument", "member list takes no arguments."],
  ["endpoint status x", "bad-argument", "endpoint status takes no arguments."],
  ["endpoint health x", "bad-argument", "endpoint health takes no arguments."],
  ["alarm list x", "bad-argument", "alarm list takes no arguments."],
  ["auth status x", "bad-argument", "auth status takes no arguments."],
  ["user list x", "bad-argument", "user list takes no arguments."],
  ["role list x", "bad-argument", "role list takes no arguments."],
  ["user get", "bad-argument", "user get needs one user name: user get <name> [--detail]."],
  ["user get a b", "bad-argument", "user get needs one user name: user get <name> [--detail]."],
  ["user get ''", "bad-argument", "user get needs a user name that is not empty."],
  ["role get", "bad-argument", "role get needs one role name: role get <name>."],
  ["role get ''", "bad-argument", "role get needs a role name that is not empty."],
];

describe("etcdctl's argument rules, each with its sentence (spec 5.1.3)", () => {
  test.each(ARGUMENT_RULES)("%s", (text, code, message) => {
    expect(refusal(text)).toMatchObject({ code, message });
  });

  test("a lease id with more leading zeros than 16 digits is the same id", () => {
    expect(command("put /a v --lease=00000000000000000abc")).toMatchObject({ lease: "0000000000000abc" });
  });

  test("a revision may be the largest INT64 and no more", () => {
    expect(command("watch /a --rev=9223372036854775807")).toMatchObject({ revision: "9223372036854775807" });
  });

  test("the limit bound is the caller's", () => {
    expect(parsed("get /a --limit=900", { ...LIMITS, maxLimit: 1_000 }).command).toMatchObject({ limit: 900 });
    expect(refusal("get /a --limit=2", { ...LIMITS, maxLimit: 1 }).message).toBe(
      "--limit=2 is above the most rows a result holds, 1: ask for 1 or fewer.",
    );
  });

  test("a refusal points at the word it is about", () => {
    // Two flags that conflict: the later one.
    expect(refusal("get --count-only /a --keys-only")).toMatchObject({ line: 1, column: 20 });
    expect(refusal("get --keys-only /a --count-only")).toMatchObject({ line: 1, column: 19 });
    // A third positional: that word; no key: the command word.
    expect(refusal("get /a /b /c")).toMatchObject({ line: 1, column: 10 });
    expect(refusal("$ get")).toMatchObject({ line: 1, column: 2 });
    // The later of two flags is the one on the later line, whatever the columns.
    expect(refusal("get /a --keys-only \\\n --count-only")).toMatchObject({ line: 2, column: 1 });
    expect(refusal("get --count-only \\\n /a --keys-only")).toMatchObject({ line: 2, column: 4 });
  });

  test("a value flag written as two words takes the one word after it, and reading goes on", () => {
    expect(command("get /a --limit 10 --prefix")).toEqual({
      kind: "get",
      key: b("/a"),
      ...GET,
      prefix: true,
      limit: 10,
    });
    expect(command("put --lease 1234 /a v")).toEqual({
      kind: "put",
      key: b("/a"),
      value: b("v"),
      ...PUT,
      lease: "0000000000001234",
    });
    expect(command("del /a --command-timeout 5s --prefix")).toEqual({
      kind: "del",
      key: b("/a"),
      ...DEL,
      prefix: true,
    });
  });

  test("P, the first page size, bounds a ranged get only inside a txn (spec 5.1.4)", () => {
    expect(command("get /a --prefix --limit=200")).toEqual({
      kind: "get",
      key: b("/a"),
      ...GET,
      prefix: true,
      limit: 200,
    });
    expect(command("get /a /z --limit=500")).toMatchObject({ rangeEnd: b("/z"), limit: 500 });
  });

  test("a boolean flag never takes the next word", () => {
    expect(command("get --prefix /a")).toMatchObject({ key: b("/a"), prefix: true });
    expect(command("get /a --keys-only false")).toMatchObject({ key: b("/a"), rangeEnd: b("false"), keysOnly: true });
  });

  test("a value flag takes the next word, whatever it is", () => {
    expect(refusal("put /a v --lease --prev-kv").message).toBe(
      "--lease takes a lease id in hexadecimal, as lease list prints it, such as 694d77aa9e38260f; 0 means no lease.",
    );
  });

  test("every boolean spelling Go's ParseBool reads", () => {
    for (const spelling of ["1", "t", "T", "true", "TRUE", "True"]) {
      expect(command(`get /a --prefix=${spelling}`)).toMatchObject({ prefix: true });
    }
    for (const spelling of ["0", "f", "F", "false", "FALSE", "False"]) {
      expect(command(`get /a --prefix=${spelling}`)).toMatchObject({ prefix: false });
    }
  });
});

// ============================================================================
// 5.1.4: the txn body
// ============================================================================

const txn = (body: string, limits: EtcdParseLimits = LIMITS) => {
  const result = parsed(`txn\n${body}`, limits).command;
  if (result.kind !== "txn") throw new Error("expected a txn");
  return result;
};
const txnRefusal = (body: string, limits: EtcdParseLimits = LIMITS) => refusal(`txn\n${body}`, limits);

describe("the txn body (spec 5.1.4)", () => {
  test("compares, success and failure, each ended by an empty line", () => {
    expect(txn('mod("k") > "0"\n\nput k a\n\nput k b\nget k\n')).toEqual({
      kind: "txn",
      compares: [{ target: "mod", key: b("k"), operator: ">", operand: "0" }],
      success: [{ kind: "put", key: b("k"), value: b("a"), ...PUT }],
      failure: [
        { kind: "put", key: b("k"), value: b("b"), ...PUT },
        { kind: "get", key: b("k"), ...GET },
      ],
    });
  });

  test("a section the text does not reach is empty, and so is one two empty lines leave", () => {
    expect(txn("")).toEqual({ kind: "txn", compares: [], success: [], failure: [] });
    expect(parsed("txn")).toEqual({ command: { kind: "txn", compares: [], success: [], failure: [] }, line: 1 });
    expect(txn('mod("k") = "5"\n\n\nput k v2')).toMatchObject({
      success: [],
      failure: [{ kind: "put", value: b("v2") }],
    });
  });

  test("every target and its short name", () => {
    const targets = (line: string) => txn(line).compares[0]?.target;
    expect(targets('c("k") = "1"')).toBe("create");
    expect(targets('create("k") = "1"')).toBe("create");
    expect(targets('m("k") = "1"')).toBe("mod");
    expect(targets('mod("k") = "1"')).toBe("mod");
    expect(targets('ver("k") = "1"')).toBe("version");
    expect(targets('version("k") = "1"')).toBe("version");
    expect(targets('val("k") = "1"')).toBe("value");
    expect(targets('value("k") = "1"')).toBe("value");
    expect(targets('lease("k") = "0"')).toBe("lease");
  });

  test("every operator", () => {
    for (const operator of ["=", "!=", "<", ">"]) {
      expect(txn(`mod("k") ${operator} "1"`).compares[0]).toMatchObject({ operator });
    }
  });

  test("operands: a revision or a version is a decimal integer, as ParseInt reads it", () => {
    expect(txn('mod("k") > "+007"').compares[0]).toMatchObject({ operand: "7" });
    expect(txn('mod("k") > "-1"').compares[0]).toMatchObject({ operand: "-1" });
    expect(txn('ver("k") = "-0"').compares[0]).toMatchObject({ operand: "0" });
    expect(txn('c("k") < "9223372036854775807"').compares[0]).toMatchObject({ operand: "9223372036854775807" });
    expect(txn('c("k") > "-9223372036854775808"').compares[0]).toMatchObject({ operand: "-9223372036854775808" });
  });

  test("a value compare takes any bytes, and a lease compare a hexadecimal lease id", () => {
    expect(txn('val("k") = "a\\x00\\xff"').compares[0]).toEqual({
      target: "value",
      key: b("k"),
      operator: "=",
      operand: new Uint8Array([0x61, 0x00, 0xff]),
    });
    expect(txn('lease("k") = "694D77AA9E38260F"').compares[0]).toEqual({
      target: "lease",
      key: b("k"),
      operator: "=",
      operand: "694d77aa9e38260f",
    });
    expect(txn('lease("k") != "0"').compares[0]).toMatchObject({ operand: "0000000000000000" });
  });

  test("keys are bytes, Go escapes included", () => {
    expect(txn('mod("\\x2fregistry/x") > "0"').compares[0]).toMatchObject({ key: b("/registry/x") });
    expect(txn('\nput "\\x2fregistry/x" v').success[0]).toMatchObject({ key: b("/registry/x") });
  });

  test("requests take the flags and the argument rules of 5.1.3", () => {
    expect(txn("\nget k --prefix --limit=100 --keys-only --consistency=s --rev=3").success[0]).toEqual({
      kind: "get",
      key: b("k"),
      ...GET,
      prefix: true,
      keysOnly: true,
      consistency: "s",
      limit: 100,
      revision: "3",
    });
    expect(txn("\nput k v --prev-kv --lease=1").success[0]).toMatchObject({ prevKv: true, lease: "0000000000000001" });
    expect(txn("\ndel k z").success[0]).toEqual({ kind: "del", key: b("k"), rangeEnd: b("z"), ...DEL });
    expect(txn("\nput k -- -v").success[0]).toMatchObject({ value: b("-v") });
    expect(txnRefusal("\nget k --prefix --from-key")).toMatchObject({
      code: "conflicting-flags",
      message: PREFIX_FROM_KEY,
      line: 3,
    });
    expect(txnRefusal("\nput k")).toMatchObject({ code: "bad-argument", line: 3 });
  });

  test("the del --prev-kv refusal holds inside a txn (spec E14)", () => {
    expect(txnRefusal("\ndel k --prefix --prev-kv")).toMatchObject({ code: "conflicting-flags", line: 3 });
    expect(txn("\ndel k --prev-kv").success[0]).toMatchObject({ prevKv: true });
  });

  test("a third positional is refused, although etcdctl's put ignores it", () => {
    expect(txnRefusal("\nput k a b")).toMatchObject({
      code: "bad-argument",
      message:
        'put takes a key and a value, and the word at line 3, column 9 is a third: quote a value that holds spaces, as in put /key "a b".',
    });
  });

  test("a ranged get is bounded by P, the first page size, and one past it is refused", () => {
    expect(txn("\nget a --prefix").success[0]).toMatchObject({ prefix: true });
    expect(txnRefusal("\nget a --prefix --limit=101")).toEqual({
      code: "limit-too-large",
      line: 3,
      column: 15,
      message:
        "--limit=101 on line 3 is above 100, the most rows a ranged get inside a txn reads, because etcd builds a txn's whole answer at once: ask for 100 or fewer.",
    });
    expect(txnRefusal("\nget a z --limit=101").code).toBe("limit-too-large");
    expect(txnRefusal("\nget a --from-key --limit=101").code).toBe("limit-too-large");
    // A single-key get and a count read no rows past one, so P does not bound them.
    expect(txn("\nget a --limit=101").success[0]).toMatchObject({ limit: 101 });
    expect(txn("\nget a --prefix --count-only --limit=101").success[0]).toMatchObject({ limit: 101 });
  });

  test("a branch whose rows could pass the row limit is refused: the succeeded row, each get at its limit, one row per other request", () => {
    const five = "\nget a --prefix\nget b --prefix\nget c --prefix\nget d --prefix\nget e --prefix";
    expect(txnRefusal(five)).toEqual({
      code: "limit-too-large",
      line: 3,
      column: 0,
      message:
        "The success list of the txn could answer 501 rows, above the 500 a result holds, counting the succeeded row, each get at its limit (a single-key get as one row, a ranged get with no --limit as 100) and one row for each other request: lower the limits, or split the txn.",
    });
    const fourAndTwo = "\nget a --prefix\nget b --prefix\nget c --prefix\nget d --prefix\nput k v\ndel k";
    expect(txn(fourAndTwo).success).toHaveLength(6);
    expect(txn(`${fourAndTwo}\nget z --prefix --limit=97`).success).toHaveLength(7);
    expect(txnRefusal(`${fourAndTwo}\nget z --prefix --limit=98`)).toMatchObject({
      message: expect.stringContaining("could answer 501 rows"),
    });
    expect(txnRefusal(`\n\n${five.slice(1)}`)).toMatchObject({
      code: "limit-too-large",
      line: 4,
      message: expect.stringContaining("The failure list"),
    });
    expect(txn("\nget a --prefix --limit=10\nget b --prefix --count-only\nget c").success).toHaveLength(3);
    expect(txnRefusal("\nget a --prefix --limit=1", { ...LIMITS, maxLimit: 1 }).message).toContain(
      "could answer 2 rows",
    );
    expect(txnRefusal("\nput k v", { ...LIMITS, maxLimit: 1 }).code).toBe("limit-too-large");
    expect(txn("", { ...LIMITS, maxLimit: 1 }).success).toEqual([]);
    // The refusal points at the branch's first request line, where it starts.
    expect(txnRefusal(`\n  ${five.slice(1)}`)).toMatchObject({ code: "limit-too-large", line: 3, column: 2 });
  });

  test("in the branch count, a range end and --from-key make a get ranged, and a --count-only get is one row", () => {
    const branch = (request: (n: number) => string) => `\n${[1, 2, 3, 4, 5].map(request).join("\n")}`;
    expect(txnRefusal(branch((n) => `get a${n} z${n}`)).message).toContain("could answer 501 rows");
    expect(txnRefusal(branch((n) => `get a${n} --from-key`)).message).toContain("could answer 501 rows");
    expect(txn(branch((n) => `get a${n} --prefix --count-only`)).success).toHaveLength(5);
    expect(txn(branch((n) => `get a${n}`)).success).toHaveLength(5);
  });

  test("a compare's target, operator and operand are checked", () => {
    expect(txnRefusal('mod ("k") > "0"')).toEqual({
      code: "txn-syntax",
      line: 2,
      column: 0,
      message:
        "Line 2 of the txn compares mod , which is no target: the targets are create (c), mod (m), version (ver), value (val) and lease.",
    });
    expect(txnRefusal('modrev("k") > "0"').message).toContain("compares modrev, which is no target");
    expect(txnRefusal('mod("k") == "0"')).toMatchObject({
      code: "txn-syntax",
      message: "Line 2 of the txn compares with ==, which is no operator: the operators are =, !=, < and >.",
    });
    expect(txnRefusal('mod("k") > "x"')).toMatchObject({
      code: "txn-syntax",
      message:
        'Line 2 of the txn compares mod with a value that is not a decimal revision: write a whole number, as in mod("key1") > "0".',
    });
    expect(txnRefusal('ver("k") > "1.5"').message).toBe(
      'Line 2 of the txn compares version with a value that is not a decimal version: write a whole number, as in version("key1") > "0".',
    );
    expect(txnRefusal('c("k") > "9223372036854775808"').message).toContain("not a decimal revision");
    expect(txnRefusal('c("k") > "-9223372036854775809"').message).toContain("not a decimal revision");
    expect(txnRefusal('lease("k") = "x"')).toMatchObject({
      code: "txn-syntax",
      message:
        'Line 2 of the txn compares lease with a value that is not a hexadecimal lease id: write the id as lease list prints it, or "0" for a key with no lease.',
    });
    expect(txnRefusal('lease("k") = "8000000000000000"').message).toContain("not a hexadecimal lease id");
    expect(txnRefusal('lease("k") = "-5"')).toMatchObject({
      code: "txn-syntax",
      message: `Line 2 of the txn compares lease with a signed id: write the id without a sign, as lease list prints the ids etcd grants, or "0" for a key with no lease. Studio does not address a negative id, which etcd holds only when a client chose it.`,
    });
    expect(txnRefusal('mod("k") = "0" trailing')).toMatchObject({
      code: "txn-syntax",
      message: "Line 2 of the txn has text after the compared value, which etcdctl ignores: remove it.",
    });
    expect(txnRefusal('mod("") > "0"')).toMatchObject({
      code: "txn-syntax",
      message: 'Line 2 of the txn compares an empty key: etcd answers "key is not provided".',
    });
  });

  test("a request is get, put or del, spelled whole", () => {
    expect(txnRefusal("\np k v")).toEqual({
      code: "txn-syntax",
      line: 3,
      column: 0,
      message: "Line 3 of the txn requests p, which a txn does not take: a request is get, put or del.",
    });
    expect(txnRefusal("\nlease grant 5").message).toContain("requests lease,");
    // Argify unquotes a quoted word before cobra reads it, so a quoted put is a put.
    expect(txn('\n"put" k v').success[0]).toMatchObject({ kind: "put", key: b("k") });
    // No other command of the subset is a request, the bounded watch and txn itself included.
    expect(txnRefusal("\nwatch k")).toEqual({
      code: "txn-syntax",
      line: 3,
      column: 0,
      message: "Line 3 of the txn requests watch, which a txn does not take: a request is get, put or del.",
    });
    expect(txnRefusal("\ntxn").message).toBe(
      "Line 3 of the txn requests txn, which a txn does not take: a request is get, put or del.",
    );
  });

  test("global flags are refused inside a request, --command-timeout with the place it belongs", () => {
    expect(txnRefusal("\nget k --command-timeout=5s")).toMatchObject({
      code: "global-flag",
      message: "--command-timeout is a flag of the txn line, not of a request in its body: write it on the txn line.",
    });
    expect(txnRefusal("\nget k --endpoints=x").message).toContain("The global flag --endpoints is refused");
    expect(parsed("txn --command-timeout=5s\n\nget k").commandTimeoutMs).toBe(5_000);
  });

  test("a # line directly above a compare or a request is removed, and so is a trailing run", () => {
    expect(txn('# compares\nmod("k") > "0"\n\n# yes\nput k a\n\n# no\nput k b\n\n# done\n\n# really\n')).toMatchObject({
      compares: [{ target: "mod" }],
      success: [{ kind: "put", value: b("a") }],
      failure: [{ kind: "put", value: b("b") }],
    });
  });

  test("any other # line is refused, naming it and the rule it breaks", () => {
    const misplaced = (line: number) =>
      `Line ${line} of the txn is a # line that is neither directly above a compare or a request nor followed only by # and empty lines, and a # line above an empty line could read as a list of its own: move it directly above a compare or a request, or remove it.`;
    expect(txnRefusal('mod("k") > "0"\n\n# yes\n\nput k v')).toEqual({
      code: "txn-syntax",
      line: 4,
      column: 0,
      message: misplaced(4),
    });
    expect(txnRefusal('mod("k") > "0"\n\n# a\n# b\n\nput k v').line).toBe(4);
    expect(txnRefusal('mod("k") > "0"\n  # yes\n\nput k v')).toMatchObject({ line: 3, column: 2 });
    // A # line that ends a list, and one past the failure list: the rule, not a change of list, refuses them.
    expect(txnRefusal('mod("k") > "0"\n\nput k a\n# trailing\n\nput k b').message).toBe(misplaced(5));
    expect(txnRefusal("\n\n\n# c\n\nput x y").message).toBe(misplaced(5));
  });

  test("a line past the failure list is refused, naming it", () => {
    expect(txnRefusal("\n\n\nput k v")).toEqual({
      code: "txn-syntax",
      line: 5,
      column: 0,
      message:
        "Line 5 comes after the txn's failure list, which the third empty line ended, and etcdctl never reads it: remove the line, or an empty line above it.",
    });
  });

  test("the first problem in the body, in line order, is the one reported", () => {
    expect(txnRefusal('mod("k") == "0"\n\nput k "\\q"').line).toBe(2);
    expect(txnRefusal('mod("k") = "0"\n\nput k "\\q"\nput k v w')).toMatchObject({ code: "txn-quoting", line: 4 });
    expect(txnRefusal('mod(k) > "0"\n\nput k a b')).toMatchObject({ code: "txn-syntax", line: 2 });
  });

  test("a request line's lexer refusal is the parse's", () => {
    expect(txnRefusal('\nput k "abc')).toMatchObject({ code: "txn-quoting", line: 3, column: 6 });
  });

  test("txn's own command line comes first", () => {
    expect(refusal('txn x\nmod(k) > "0"')).toMatchObject({ code: "bad-argument", line: 1 });
  });
});

// ============================================================================
// The declared table (spec 5.1.3), for the provider doc and statementLanguage
// ============================================================================

describe("ETCD_COMMAND_TABLE is 5.1.3's table", () => {
  test("every command, its arguments, its flags and its refused flags", () => {
    expect(
      ETCD_COMMAND_TABLE.map((row) => ({
        command: row.words.join(" "),
        kind: row.kind,
        arguments: row.arguments,
        flags: row.flags,
        refused: row.refusedFlags.map((flag) => flag.flag),
      })),
    ).toEqual([
      {
        command: "get",
        kind: "get",
        arguments: "<key> [<range_end>]",
        flags: [
          "--prefix",
          "--from-key",
          "--limit=<n>",
          "--rev=<n>",
          "--keys-only",
          "--count-only",
          "--consistency=l|s",
        ],
        refused: [
          "--sort-by",
          "--order",
          "--min-mod-rev",
          "--max-mod-rev",
          "--min-create-rev",
          "--max-create-rev",
          "--print-value-only",
          "--stream",
        ],
      },
      {
        command: "put",
        kind: "put",
        arguments: "<key> <value>",
        flags: ["--lease=<hex id>", "--prev-kv", "--ignore-value", "--ignore-lease"],
        refused: [],
      },
      {
        command: "del",
        kind: "del",
        arguments: "<key> [<range_end>]",
        flags: ["--prefix", "--from-key", "--prev-kv", "--range"],
        refused: [],
      },
      { command: "txn", kind: "txn", arguments: "", flags: [], refused: ["--interactive"] },
      {
        command: "watch",
        kind: "watch",
        arguments: "<key> [<range_end>]",
        flags: ["--prefix", "--rev=<n>", "--prev-kv"],
        refused: ["--interactive", "--progress-notify"],
      },
      { command: "lease grant", kind: "lease-grant", arguments: "<ttl seconds>", flags: [], refused: [] },
      { command: "lease revoke", kind: "lease-revoke", arguments: "<hex id>", flags: [], refused: [] },
      { command: "lease timetolive", kind: "lease-timetolive", arguments: "<hex id>", flags: ["--keys"], refused: [] },
      { command: "lease list", kind: "lease-list", arguments: "", flags: [], refused: [] },
      {
        command: "lease keep-alive",
        kind: "lease-keep-alive-once",
        arguments: "<hex id>",
        flags: ["--once"],
        refused: [],
      },
      { command: "member list", kind: "member-list", arguments: "", flags: ["--consistency=l|s"], refused: [] },
      { command: "endpoint status", kind: "endpoint-status", arguments: "", flags: [], refused: ["--cluster"] },
      { command: "endpoint health", kind: "endpoint-health", arguments: "", flags: [], refused: ["--cluster"] },
      { command: "alarm list", kind: "alarm-list", arguments: "", flags: [], refused: [] },
      { command: "auth status", kind: "auth-status", arguments: "", flags: [], refused: [] },
      { command: "user list", kind: "user-list", arguments: "", flags: [], refused: [] },
      { command: "user get", kind: "user-get", arguments: "<name>", flags: ["--detail"], refused: [] },
      { command: "role list", kind: "role-list", arguments: "", flags: [], refused: [] },
      { command: "role get", kind: "role-get", arguments: "<name>", flags: [], refused: [] },
    ]);
  });

  test("the refused flags' reasons are the parser's", () => {
    const get = ETCD_COMMAND_TABLE[0];
    expect(get.refusedFlags[0]).toEqual({ flag: "--sort-by", reason: WHOLE_RANGE });
    const interactive = ETCD_COMMAND_TABLE[3].refusedFlags[0];
    expect(interactive).toEqual({
      flag: "--interactive",
      shorthand: "-i",
      reason: "Studio has no terminal to prompt in; write the compares and the requests on the lines below txn",
    });
  });
});

describe("the parser answers every row of ETCD_COMMAND_TABLE as the row states it (spec 5.1.3)", () => {
  /** One sample per placeholder the table names; a new placeholder fails here until it has one. */
  const SAMPLE_ARGUMENT: Readonly<Partial<Record<string, string>>> = {
    key: "/a",
    range_end: "/z",
    value: "v",
    "ttl seconds": "60",
    "hex id": "694d77aa9e38260f",
    name: "alice",
  };
  const SAMPLE_VALUE: Readonly<Partial<Record<string, string>>> = { "<n>": "1", "<hex id>": "1", "l|s": "s" };
  // What the table's columns cannot say, from 5.1.3's rows: keep-alive runs only with --once, and put takes
  // its key alone beside --ignore-value.
  const REQUIRED_FLAG: Readonly<Partial<Record<string, string>>> = { "lease-keep-alive-once": "--once" };
  const DROPS_VALUE = "--ignore-value";
  const PLACEHOLDER = /\[<([^>]+)>\]|<([^>]+)>/g;

  const sample = (table: Readonly<Partial<Record<string, string>>>, name: string): string => {
    const found = table[name];
    if (found === undefined) throw new Error(`no sample for ${name}`);
    return found;
  };

  test.each(ETCD_COMMAND_TABLE.map((row) => [row.words.join(" "), row] as const))("%s", (label, row) => {
    expect(row.arguments.replace(PLACEHOLDER, "").trim()).toBe("");
    const places = [...row.arguments.matchAll(PLACEHOLDER)];
    const required = places.filter((place) => place[2] !== undefined).length;
    const values = places.map((place) => sample(SAMPLE_ARGUMENT, place[1] ?? place[2] ?? ""));
    const needed = REQUIRED_FLAG[row.kind];
    const text = (args: readonly string[], flags: readonly string[] = []) =>
      [label, ...(needed === undefined || flags.includes(needed) ? [] : [needed]), ...flags, ...args].join(" ");
    const accepts = (args: readonly string[], flags?: readonly string[]) => {
      const result = parseEtcdCommand(text(args, flags), LIMITS);
      expect(result.ok ? result.parsed.command.kind : result.refusal.message).toBe(row.kind);
    };

    // The fewest and the most arguments the template states parse; one more, and one fewer, do not.
    accepts(values.slice(0, required));
    accepts(values);
    expect(refusal(text([...values, "/extra"])).code).toBe("bad-argument");
    if (required > 0) expect(refusal(text(values.slice(0, required - 1))).code).toBe("bad-argument");

    for (const flag of row.flags) {
      const [name, placeholder] = flag.split("=");
      const spelled = placeholder === undefined ? name : `${name}=${sample(SAMPLE_VALUE, placeholder)}`;
      accepts(flag === DROPS_VALUE ? values.slice(0, 1) : values.slice(0, required), [spelled]);
    }
    for (const refused of row.refusedFlags) {
      const message = `${label} does not take ${refused.flag}: ${refused.reason}.`;
      const spellings = refused.shorthand === undefined ? [refused.flag] : [refused.flag, refused.shorthand];
      for (const spelling of spellings) {
        expect(refusal(text(values.slice(0, required), [spelling]))).toMatchObject({ code: "refused-flag", message });
      }
    }
  });
});

// ============================================================================
// The shared corpus (spec 3.3, 10)
// ============================================================================

describe("the shared grammar corpus parses as it says (spec 10)", () => {
  test.each(GRAMMAR_CORPUS.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const result = parseEtcdCommand(entry.text, LIMITS);
    if (entry.parse.ok) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parsed.command.kind as string).toBe(entry.parse.kind);
        expect(result.parsed.line).toBe(entry.parse.line);
      }
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal).toMatchObject({ code: entry.parse.code, line: entry.parse.line });
    }
  });

  test("the README's txn parses to the requests etcdctl ran (measured: FAILURE, then two puts)", () => {
    const readme = GRAMMAR_CORPUS.find((entry) => entry.name.startsWith("the README's non-interactive txn"));
    expect(readme && command(readme.text)).toEqual({
      kind: "txn",
      compares: [{ target: "mod", key: b("key1"), operator: ">", operand: "0" }],
      success: [{ kind: "put", key: b("key1"), value: b("overwrote-key1"), ...PUT }],
      failure: [
        { kind: "put", key: b("key1"), value: b("created-key1"), ...PUT },
        { kind: "put", key: b("key2"), value: b("some extra key"), ...PUT },
      ],
    });
  });
});
