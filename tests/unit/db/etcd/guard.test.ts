/**
 * The classification the confirmation gate and the provider share (spec 5.1.3, 5.5, E8).
 *
 * Every row of 5.1.3's Class and Gate columns is a row here, driven from the text a user types
 * through the real parser, so what asks and what runs are one parse. The typed text is pinned in the
 * quoting of the rule the key was written under, and the gate's reader is held to the Gate column
 * over the whole grammar corpus.
 */
import { describe, expect, test } from "bun:test";
import type { EtcdBytes } from "@/lib/db/providers/keyvalue/etcd/client";
import { ETCD_COMMAND_TABLE, type EtcdCommand, parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import {
  assessCommand,
  type CommandAssessment,
  ETCD_DESTRUCTIVE_OPERATIONS,
  etcdTypedConfirmation,
  readEtcdOperations,
} from "@/lib/db/providers/keyvalue/etcd/guard";
import { protectedHit } from "@/lib/db/providers/keyvalue/etcd/keys";
import { describeRange } from "@/lib/db/providers/keyvalue/etcd/permissions";
import { GRAMMAR_CORPUS } from "../../../fixtures/etcd/grammar-corpus";

const LIMITS = { maxLimit: 500, txnRangeLimit: 50, maxCommandTimeoutMs: 60_000, maxWatchWindowMs: 55_000 };
const utf8 = (text: string): EtcdBytes => new TextEncoder().encode(text);
const hex = (bytes: EtcdBytes | undefined): string | undefined =>
  bytes === undefined ? undefined : Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const texts = (keys: readonly EtcdBytes[]): string[] => keys.map((key) => new TextDecoder().decode(key));

function commandOf(text: string): EtcdCommand {
  const parsed = parseEtcdCommand(text, LIMITS);
  if (!parsed.ok) throw new Error(`expected ${JSON.stringify(text)} to parse, got: ${parsed.refusal.message}`);
  return parsed.parsed.command;
}

const assess = (text: string): CommandAssessment => assessCommand(commandOf(text));
/** The three columns and the typed text, as 5.1.3's table and 5.5 write them. */
const gateRow = (text: string) => {
  const { class: kind, destructive, gate, typedConfirmation } = assess(text);
  return { class: kind, destructive, gate, typedConfirmation };
};

describe("the Gate column of spec 5.1.3, row by row", () => {
  test.each([
    ["get /app/ --prefix", "read", false, "none"],
    ["put /app/cfg v", "write", false, "one-click"],
    ["put /app/cfg --ignore-value", "write", false, "one-click"],
    ["del /app/cfg", "write", false, "one-click"],
    ["watch /apisix/routes/ --prefix", "read", false, "none"],
    ["lease grant 60", "write", false, "none"],
    ["lease timetolive 694d8147df1dc4c8 --keys", "read", false, "none"],
    ["lease list", "read", false, "none"],
    ["lease keep-alive --once 694d8147df1dc4c8", "write", false, "none"],
    ["member list", "read", false, "none"],
    ["member list --consistency=s", "read", false, "none"],
    ["endpoint status", "read", false, "none"],
    ["endpoint health", "read", false, "none"],
    ["alarm list", "read", false, "none"],
    ["auth status", "read", false, "none"],
    ["user list", "read", false, "none"],
    ["user get reader --detail", "read", false, "none"],
    ["role list", "read", false, "none"],
    ["role get reader", "read", false, "none"],
  ])("%s: class %s, destructive %p, gate %s", (text, kind, destructive, gate) => {
    expect(gateRow(text)).toEqual({
      class: kind as "read" | "write",
      destructive,
      gate: gate as "none",
      typedConfirmation: undefined,
    });
  });

  test.each([
    ["del /app/ --prefix", "/app/"],
    ["del /App/ --prefix", "/App/"],
    ["del /a /b", "/a"],
    ["del /a --from-key", "/a"],
    ["del --range /a /b", "/a"],
    ["del ' a' --prefix", "' a'"],
    ['del " a" --prefix', "' a'"],
    ["del ' ' --prefix", "' '"],
    ['del "it\'s/" --prefix', "'it'\\''s/'"],
    ["del --prefix -- -dash/", "-dash/"],
    ["del --prefix '/a\nb/'", '"/a\\nb/"'],
    // A zero-width space is invisible bare and between single quotes, so the text to type spells it (spec 5.5).
    ["del --prefix '/app/\u200bcfg'", '"/app/\\u200bcfg"'],
  ])("%j asks for the typed text %s, in the quoting of the command line", (text, typed) => {
    expect(gateRow(text)).toEqual({
      class: "write",
      destructive: true,
      gate: "typed",
      typedConfirmation: { type: "text", text: typed },
    });
  });

  test.each(["del '' --prefix", "del '' --from-key", 'del "" --prefix'])(
    "%j, the whole key space, asks for the connection's name with every key listed (R13 D2)",
    (text) => {
      expect(gateRow(text)).toEqual({
        class: "write",
        destructive: true,
        gate: "typed",
        typedConfirmation: { type: "connection-name", targets: ["every key"] },
      });
    },
  );

  test("lease revoke asks for the lease id, written as lease list prints it whatever padding and case were typed", () => {
    expect(gateRow("lease revoke 00694D8147DF1DC4C8")).toEqual({
      class: "write",
      destructive: true,
      gate: "typed",
      typedConfirmation: { type: "text", text: "694d8147df1dc4c8" },
    });
  });
});

describe("a txn (spec 5.1.3, 5.1.4, 5.5)", () => {
  const txn = (...lines: string[]) => `txn\n${lines.join("\n")}`;

  test("a txn whose branches only read is a read and asks nothing", () => {
    expect(gateRow(txn('mod("k") > "0"', "", "get k", "", "get k2 --prefix"))).toEqual({
      class: "read",
      destructive: false,
      gate: "none",
      typedConfirmation: undefined,
    });
  });

  test("a read-only txn's operations are txn and its request words, as a txn that writes names them", () => {
    expect(readEtcdOperations(txn('mod("k") > "0"', "", "get k", "", "get k2 --prefix"))).toEqual(["txn", "get"]);
  });

  test("a txn with no request at all is a read", () => {
    expect(gateRow(txn('mod("k") > "0"'))).toMatchObject({ class: "read", gate: "none" });
  });

  test("a write in either branch makes the whole txn a write with one click, the failure branch included", () => {
    expect(gateRow(txn('mod("k") = "5"', "", "", "put k v2"))).toEqual({
      class: "write",
      destructive: false,
      gate: "one-click",
      typedConfirmation: undefined,
    });
  });

  test("two single-key deletes in the branches ask one click, as each does at top level", () => {
    expect(gateRow(txn("", "del /a", "", "del /b"))).toMatchObject({
      class: "write",
      destructive: false,
      gate: "one-click",
    });
  });

  test("one destructive target asks for its prefix, in the Go quoting of a txn request", () => {
    expect(gateRow(txn("", 'del "/a b/" --prefix'))).toEqual({
      class: "write",
      destructive: true,
      gate: "typed",
      typedConfirmation: { type: "text", text: '"/a b/"' },
    });
    expect(gateRow(txn("", "del /app/ --prefix")).typedConfirmation).toEqual({ type: "text", text: "/app/" });
  });

  test("the same destructive range in both branches, however it is spelled, is one target", () => {
    expect(gateRow(txn("", "del /app/ --prefix", "", "del /app/ /app0")).typedConfirmation).toEqual({
      type: "text",
      text: "/app/",
    });
    expect(gateRow(txn("", 'del "" --prefix', "", 'del "" --from-key')).typedConfirmation).toEqual({
      type: "connection-name",
      targets: ["every key"],
    });
  });

  test("two destructive ranges from one key to different ends are two targets, both listed (R13 D2)", () => {
    expect(gateRow(txn("", "del /a --prefix", "del /a --from-key")).typedConfirmation).toEqual({
      type: "connection-name",
      targets: ["/a (prefix)", "/a (from key)"],
    });
    expect(gateRow(txn("", "del /a /b", "", "del /a /c")).typedConfirmation).toEqual({
      type: "connection-name",
      targets: ["/a to /b (range)", "/a to /c (range)"],
    });
  });

  test("two different prefix deletes ask for the connection's name and list both prefixes", () => {
    expect(gateRow(txn("", "del /a/ --prefix", "", "del /b/ --prefix")).typedConfirmation).toEqual({
      type: "connection-name",
      targets: ["/a/ (prefix)", "/b/ (prefix)"],
    });
  });

  test("a range from 0x00 to the end is the whole key space too, however the key is written", () => {
    expect(gateRow(txn("", 'del "\\x00" --from-key')).typedConfirmation).toEqual({
      type: "connection-name",
      targets: ["every key"],
    });
    expect(gateRow("del --from-key '\u0000'").typedConfirmation).toEqual({
      type: "connection-name",
      targets: ["every key"],
    });
    expect(gateRow(txn("", 'del "\\x00" --prefix')).typedConfirmation).toEqual({ type: "text", text: '"\\x00"' });
    expect(gateRow(txn("", 'del "\\x01" --from-key')).typedConfirmation).toEqual({ type: "text", text: '"\\x01"' });
  });

  test("a txn whose one destructive target is the whole key space asks for the connection's name with every key", () => {
    expect(gateRow(txn("", 'del "" --prefix'))).toEqual({
      class: "write",
      destructive: true,
      gate: "typed",
      typedConfirmation: { type: "connection-name", targets: ["every key"] },
    });
  });

  test("every kind of destructive target is listed as it was written", () => {
    expect(
      gateRow(txn("", "del /a /b", "del /c --from-key", "", 'del "/q\\nr/" --prefix', 'del "" --from-key'))
        .typedConfirmation,
    ).toEqual({
      type: "connection-name",
      targets: ["/a to /b (range)", "/c (from key)", '"/q\\nr/" (prefix)', "every key"],
    });
  });

  test("several targets are each listed in the Go quoting of a txn request, never the command line's", () => {
    expect(
      gateRow(txn("", 'del "/a b/" --prefix', 'del "/c d" "/c e"', "", 'del "/f g" --from-key')).typedConfirmation,
    ).toEqual({
      type: "connection-name",
      targets: ['"/a b/" (prefix)', '"/c d" to "/c e" (range)', '"/f g" (from key)'],
    });
  });

  test("a target's listing reads as describeRange writes the same range, one vocabulary in both places", () => {
    // `del /a /c`: `/a /b` would be the prefix range of /a, which describeRange, reading bytes, calls a prefix.
    const listed = gateRow(txn("", "del /a /c", "del /c --from-key", "del /p/ --prefix")).typedConfirmation;
    expect(listed).toEqual({
      type: "connection-name",
      targets: [
        describeRange({ key: utf8("/a"), rangeEnd: utf8("/c") }),
        describeRange({ key: utf8("/c"), rangeEnd: Uint8Array.of(0) }),
        describeRange({ key: utf8("/p/"), rangeEnd: utf8("/p0") }),
      ],
    });
  });
});

describe("the single-key targets and the write ranges (spec E8)", () => {
  test("a put and a single-key del name their key; a ranged del names none and writes its range", () => {
    expect(texts(assess("put /app/cfg v").singleKeyTargets)).toEqual(["/app/cfg"]);
    expect(texts(assess("put /app/cfg --lease=694d8147df1dc4c8 v").singleKeyTargets)).toEqual(["/app/cfg"]);
    expect(texts(assess("del /app/cfg").singleKeyTargets)).toEqual(["/app/cfg"]);
    const prefix = assess("del /app/ --prefix");
    expect(prefix.singleKeyTargets).toEqual([]);
    expect(prefix.writeRanges.map((each) => [hex(each.key), hex(each.rangeEnd)])).toEqual([
      [hex(utf8("/app/")), hex(utf8("/app0"))],
    ]);
  });

  test("a txn's targets are deduplicated in the order written, both branches, and every write's range is listed", () => {
    const assessed = assess(`txn\n\nput /a 1\ndel /b\nput /a 2\nget /z\n\ndel /c\ndel /d/ --prefix\nput /b 3`);
    expect(texts(assessed.singleKeyTargets)).toEqual(["/a", "/b", "/c"]);
    expect(
      assessed.writeRanges.map((each) => [
        new TextDecoder().decode(each.key),
        each.rangeEnd && new TextDecoder().decode(each.rangeEnd),
      ]),
    ).toEqual([
      ["/a", undefined],
      ["/b", undefined],
      ["/a", undefined],
      ["/c", undefined],
      ["/d/", "/d0"],
      ["/b", undefined],
    ]);
  });

  test("a protected key written with Go escapes in a txn branch is the same bytes, which E8's check meets (R11 ETCD-5)", () => {
    const assessed = assess('txn\n\n\nput "\\x2fregistry/x" v');
    expect(texts(assessed.singleKeyTargets)).toEqual(["/registry/x"]);
    expect(assessed.writeRanges.map(protectedHit)).toEqual([{ kind: "prefix", name: "/registry/" }]);
  });

  test("the whole key space's write range meets every protected root, which is why E8 refuses it", () => {
    const [written] = assess("del '' --prefix").writeRanges;
    expect([hex(written.key), hex(written.rangeEnd)]).toEqual(["00", "00"]);
    expect(protectedHit(written)).toEqual({ kind: "prefix", name: "/registry/" });
  });

  test("a put writes the one key it names, which E8's prefix check reads", () => {
    const assessed = assess("put /registry/x v");
    expect(assessed.writeRanges.map((each) => [hex(each.key), hex(each.rangeEnd)])).toEqual([
      [hex(utf8("/registry/x")), undefined],
    ]);
    expect(assessed.writeRanges.map(protectedHit)).toEqual([{ kind: "prefix", name: "/registry/" }]);
  });

  test("a read and a lease command name no key and write no range", () => {
    for (const text of ["get /a", "lease grant 60", "lease revoke 694d8147df1dc4c8", "lease keep-alive --once 1"]) {
      expect(assess(text)).toMatchObject({ singleKeyTargets: [], writeRanges: [] });
    }
  });
});

/** The words of 5.1.3's write rows. */
const WRITE_WORDS: ReadonlySet<string> = new Set(["put", "del", "lease grant", "lease revoke", "lease keep-alive"]);

describe("the gate's vocabulary (spec 5.5)", () => {
  test("ETCD_DESTRUCTIVE_OPERATIONS names the writes that change or remove keys", () => {
    expect([...ETCD_DESTRUCTIVE_OPERATIONS].sort()).toEqual(["del", "lease revoke", "put"]);
  });

  test("the operations are the command's words from the grammar's own table", () => {
    expect(assess("lease keep-alive --once 1").operations).toEqual(["lease keep-alive"]);
    expect(assess("endpoint health").operations).toEqual(["endpoint health"]);
    expect(assess(`txn\n\nget /a\nput /b 1\nget /c\n\ndel /d`).operations).toEqual(["txn", "get", "put", "del"]);
    const words = ETCD_COMMAND_TABLE.map((entry) => entry.words.join(" "));
    expect(new Set(words).size).toBe(words.length);
  });

  test("across the grammar corpus, the gate asks exactly where the Gate column is not none", () => {
    let parsed = 0;
    for (const entry of GRAMMAR_CORPUS) {
      const result = parseEtcdCommand(entry.text, LIMITS);
      if (!result.ok) continue;
      parsed += 1;
      const assessed = assessCommand(result.parsed.command);
      const asks = assessed.operations.some((name) => ETCD_DESTRUCTIVE_OPERATIONS.has(name));
      expect({ text: entry.text, asks }).toEqual({ text: entry.text, asks: assessed.gate !== "none" });
      expect(assessed.typedConfirmation !== undefined).toBe(assessed.gate === "typed");
      expect(assessed.class === "write").toBe(assessed.operations.some((name) => WRITE_WORDS.has(name)));
    }
    expect(parsed).toBeGreaterThan(10);
  });

  test("readEtcdOperations reads the text with no cap it cannot know, so a limit above the row limit still names its operation", () => {
    expect(readEtcdOperations("get /app/ --prefix --limit=100000")).toEqual(["get"]);
    expect(readEtcdOperations("del /app/ --prefix --command-timeout=10h")).toEqual(["del"]);
    expect(readEtcdOperations("  # a comment\n\ndel /a")).toEqual(["del"]);
  });

  test("the gate's reader holds no txn row cap and no watch window, so a delete beside a wide ranged get still asks", () => {
    const text = "txn\n\nget /a/ --prefix --limit=100\ndel /b/ --prefix";
    expect(readEtcdOperations(text)).toEqual(["txn", "get", "del"]);
    expect(etcdTypedConfirmation(text)).toEqual({ type: "text", text: "/b/" });
    expect(readEtcdOperations("watch /a --command-timeout=10h")).toEqual(["watch"]);
  });

  /**
   * A timing guard, because a txn's single-key targets and its destructive ranges were once
   * deduplicated with a findIndex scan per request, quadratic in the requests, and the browser's gate
   * reads every txn it is shown twice before the provider's own parse refuses a branch past its row
   * limit: in isDangerousQuery when Run is pressed, and in the dialog's typed confirmation. Measured
   * with that scan, with bun 1.4.2 on an i7-13650HX, readEtcdOperations took:
   *
   *    5,000 puts      70ms
   *   10,000 puts     307ms
   *   20,000 puts    1035ms (313 KiB)
   *
   * Both readers answer from one assessCommand of the gate's parse, so the assessment is timed alone,
   * over a command parsed as the gate parses it, with no cap it cannot know; the parse of these texts
   * is linear (44 to 61ms) and is not what this guards. The bound leaves measured room on both sides
   * at the 50,000 requests below: the scan took 4.6s over the puts, 3.1 times the bound, and 8.9s over
   * the deletes, past bun's default 5s test timeout as well, while the assessment as it is took at
   * most 63ms alone and 87ms under coverage, 17 times below the bound. Each answer is asserted with
   * its time: a fast wrong answer is not a pass.
   */
  test("the gate's assessment of a txn grows with its requests, not with their square", () => {
    const BOUND_MS = 1_500;
    const REQUESTS = 50_000;
    const unbounded = {
      maxLimit: Number.POSITIVE_INFINITY,
      txnRangeLimit: Number.POSITIVE_INFINITY,
      maxCommandTimeoutMs: Number.POSITIVE_INFINITY,
      maxWatchWindowMs: Number.POSITIVE_INFINITY,
    };
    const askedOf = ({ gate, operations, typedConfirmation }: CommandAssessment) => ({
      gate,
      operations,
      typedConfirmation,
    });
    type Asked = ReturnType<typeof askedOf>;
    const numbered = (index: number) => String(index).padStart(6, "0");
    const keys = Array.from({ length: REQUESTS }, (_unused, index) => `/k/${numbered(index)}`);
    const prefixes = Array.from({ length: REQUESTS }, (_unused, index) => `/d/${numbered(index)}/`);
    const cases: [label: string, text: string, expected: Asked, targets: number][] = [
      [
        "50,000 puts of distinct keys",
        `txn\n\n${keys.map((key) => `put ${key} v`).join("\n")}`,
        { gate: "one-click", operations: ["txn", "put"], typedConfirmation: undefined },
        REQUESTS,
      ],
      [
        "50,000 deletes of distinct prefixes",
        `txn\n\n${prefixes.map((prefix) => `del ${prefix} --prefix`).join("\n")}`,
        {
          gate: "typed",
          operations: ["txn", "del"],
          typedConfirmation: { type: "connection-name", targets: prefixes.map((prefix) => `${prefix} (prefix)`) },
        },
        0,
      ],
    ];

    for (const [label, text, expected, targets] of cases) {
      const parsed = parseEtcdCommand(text, unbounded);
      if (!parsed.ok) throw new Error(`expected ${label} to parse, got: ${parsed.refusal.message}`);
      const started = performance.now();
      const assessed = assessCommand(parsed.parsed.command);
      const elapsed = performance.now() - started;

      expect(askedOf(assessed), label).toEqual(expected);
      expect([assessed.singleKeyTargets.length, assessed.writeRanges.length], label).toEqual([targets, REQUESTS]);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });

  test("text the parser refuses names no operation and asks nothing, because it will not run", () => {
    for (const text of ["", "   ", "compaction 5", "del", "get /a; del /b", "put /a $HOME", "frobnicate"]) {
      expect(readEtcdOperations(text)).toEqual([]);
      expect(etcdTypedConfirmation(text)).toBeUndefined();
    }
  });

  test("etcdTypedConfirmation answers the typed ask only where the gate is typed", () => {
    expect(etcdTypedConfirmation("del /app/ --prefix")).toEqual({ type: "text", text: "/app/" });
    expect(etcdTypedConfirmation("del '' --from-key")).toEqual({ type: "connection-name", targets: ["every key"] });
    expect(etcdTypedConfirmation("lease revoke 694d8147df1dc4c8")).toEqual({ type: "text", text: "694d8147df1dc4c8" });
    expect(etcdTypedConfirmation("del /app/cfg")).toBeUndefined();
    expect(etcdTypedConfirmation("put /app/cfg v")).toBeUndefined();
    expect(etcdTypedConfirmation("get /app/ --prefix")).toBeUndefined();
    expect(etcdTypedConfirmation("lease grant 60")).toBeUndefined();
  });

  test("the typed text reads back through the parser as the key it names", () => {
    for (const written of ["/app/", " a", "it's/", "-dash/", "a#b$c/"]) {
      const dashes = written.startsWith("-") ? "-- " : "";
      const ask = etcdTypedConfirmation(`del --prefix ${dashes}'${written.split("'").join("'\\''")}'`);
      if (ask?.type !== "text") throw new Error(`expected a typed text for ${JSON.stringify(written)}`);
      const retyped = commandOf(`del --prefix ${dashes}${ask.text}`);
      expect(retyped.kind === "del" && new TextDecoder().decode(retyped.key)).toBe(written);
    }
  });
});
