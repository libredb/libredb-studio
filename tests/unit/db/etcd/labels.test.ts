/**
 * The etcd provider's labels (#1089, spec 6.3).
 *
 * Plan mode states `statementLanguage` verbatim after "Write it in" (`src/lib/agent/investigation.ts`), so
 * every example in it is parsed with the provider's own parser and classified with the confirmation gate's
 * classifier, every read it offers is one the parser's table declares with the flags it takes, and every
 * command it keeps from plan mode is one the classifier calls a write.
 */
import { describe, expect, test } from "bun:test";
import {
  ETCD_COMMAND_TABLE,
  type EtcdCommandKind,
  type EtcdParseLimits,
  parseEtcdCommand,
} from "@/lib/db/providers/keyvalue/etcd/commands";
import { assessCommand } from "@/lib/db/providers/keyvalue/etcd/guard";
import { ETCD_DRAFTED_READS, ETCD_LABELS, ETCD_STATEMENT_EXAMPLES } from "@/lib/db/providers/keyvalue/etcd/labels";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

const LIMITS: EtcdParseLimits = {
  maxLimit: DEFAULT_QUERY_LIMIT,
  txnRangeLimit: 100,
  maxCommandTimeoutMs: 60_000,
  maxWatchWindowMs: 55_000,
};

/** One runnable text per command of the parser's table, so each kind is classified from a real parse. */
const REPRESENTATIVE: Readonly<Record<EtcdCommandKind, string>> = {
  get: "get /app/config/ --prefix --limit=50",
  put: "put /app/config/example value",
  del: "del /app/config/example",
  txn: 'txn\nmod("/app/config/example") > "0"\n\nput /app/config/example value\n\nget /app/config/example',
  watch: "watch /app/config/ --prefix",
  "lease-grant": "lease grant 60",
  "lease-revoke": "lease revoke 694d8147df1dc4c8",
  "lease-timetolive": "lease timetolive 694d8147df1dc4c8 --keys",
  "lease-list": "lease list",
  "lease-keep-alive-once": "lease keep-alive --once 694d8147df1dc4c8",
  "member-list": "member list --consistency=s",
  "endpoint-status": "endpoint status",
  "endpoint-health": "endpoint health",
  "alarm-list": "alarm list",
  "auth-status": "auth status",
  "user-list": "user list",
  "user-get": "user get reader --detail",
  "role-list": "role list",
  "role-get": "role get reader",
};

function assessed(text: string) {
  const result = parseEtcdCommand(text, LIMITS);
  if (!result.ok) throw new Error(`${JSON.stringify(text)} does not parse: ${result.refusal.message}`);
  return { kind: result.parsed.command.kind, assessment: assessCommand(result.parsed.command) };
}

/** A command as the sentence writes it: its words, its arguments, then each flag in brackets. */
function usage(row: (typeof ETCD_COMMAND_TABLE)[number]): string {
  return [...row.words, ...(row.arguments === "" ? [] : [row.arguments]), ...row.flags.map((flag) => `[${flag}]`)].join(
    " ",
  );
}

const SENTENCE = ETCD_LABELS.statementLanguage ?? "";

describe("statementLanguage (spec 6.3)", () => {
  test("every representative text is the command it stands for", () => {
    for (const kind of Object.keys(REPRESENTATIVE) as EtcdCommandKind[]) {
      const text = REPRESENTATIVE[kind];
      expect({ text, kind: assessed(text).kind }).toEqual({ text, kind });
    }
    // The control that the table is the whole grammar: a row per kind, and the record names every kind.
    expect(ETCD_COMMAND_TABLE.map((row): string => row.kind).sort()).toEqual(Object.keys(REPRESENTATIVE).sort());
  });

  test("the drafted reads are exactly the table's reads, in its order, with txn left to the user", () => {
    const reads = ETCD_COMMAND_TABLE.map((row) => row.kind).filter(
      (kind) => kind !== "txn" && assessed(REPRESENTATIVE[kind]).assessment.class === "read",
    );
    expect([...ETCD_DRAFTED_READS]).toEqual(reads);
    // A txn of reads is a read, and it is still not drafted: its class turns on what its branches hold.
    expect(assessed("txn\n\nget /app/config/example\n\n").assessment.class).toBe("read");
    expect(ETCD_DRAFTED_READS).not.toContain("txn");
  });

  test("no drafted read asks anything of the confirmation gate", () => {
    for (const kind of ETCD_DRAFTED_READS) {
      expect({ kind, gate: assessed(REPRESENTATIVE[kind]).assessment.gate }).toEqual({ kind, gate: "none" });
    }
  });

  test("the sentence offers each drafted read with the flags the parser takes, and no command that writes", () => {
    for (const row of ETCD_COMMAND_TABLE) {
      if (ETCD_DRAFTED_READS.includes(row.kind)) expect(SENTENCE).toContain(usage(row));
      else if (row.arguments !== "") expect(SENTENCE).not.toContain(usage(row));
    }
    expect(SENTENCE).toContain(`with --limit at most ${DEFAULT_QUERY_LIMIT}`);
    expect(assessed(`get /app/config/ --prefix --limit=${DEFAULT_QUERY_LIMIT}`).kind).toBe("get");
    const over = parseEtcdCommand(`get /app/config/ --prefix --limit=${DEFAULT_QUERY_LIMIT + 1}`, LIMITS);
    expect(over.ok ? "parsed" : over.refusal.code).toBe("limit-too-large");
  });

  test("the two examples are reads the gate asks nothing about, and the sentence carries both", () => {
    expect(SENTENCE).toContain(`for example ${ETCD_STATEMENT_EXAMPLES[0]} or ${ETCD_STATEMENT_EXAMPLES[1]}`);
    for (const example of ETCD_STATEMENT_EXAMPLES) {
      const { kind, assessment } = assessed(example);
      expect({
        example,
        drafted: ETCD_DRAFTED_READS.includes(kind),
        class: assessment.class,
        gate: assessment.gate,
      }).toEqual({
        example,
        drafted: true,
        class: "read",
        gate: "none",
      });
    }
  });

  test("the commands it keeps from plan mode are the user's to type, and each is a write", () => {
    expect(SENTENCE).toContain(
      "a txn and every write (put, del, lease grant, lease revoke, lease keep-alive) is typed by the user in the editor and never drafted",
    );
    for (const kind of ["put", "del", "txn", "lease-grant", "lease-revoke", "lease-keep-alive-once"] as const) {
      expect({ kind, class: assessed(REPRESENTATIVE[kind]).assessment.class }).toEqual({ kind, class: "write" });
    }
  });

  test("a prefix row is read with --prefix and never with a * in the key, because the * is a byte of the key", () => {
    expect(SENTENCE).toContain(
      "a key-prefix row such as /app/config/* is read with get /app/config/ --prefix, never with a * in the key",
    );
    const withPrefix = parseEtcdCommand("get /app/config/ --prefix", LIMITS);
    const withStar = parseEtcdCommand("get /app/config/*", LIMITS);
    expect(withPrefix.ok && withPrefix.parsed.command.kind === "get" && withPrefix.parsed.command.prefix).toBe(true);
    expect(withStar.ok && withStar.parsed.command.kind === "get" && withStar.parsed.command.prefix).toBe(false);
  });

  test("one command per run, and no flag that says where the command runs", () => {
    expect(SENTENCE).toStartWith("the etcdctl command this editor runs: exactly one command per run");
    expect(SENTENCE).toContain("no connection flag such as --endpoints or --cacert");
    for (const text of ["get /a --endpoints=https://10.0.0.5:2379", "get /a --cacert=/tmp/ca.pem"]) {
      const result = parseEtcdCommand(text, LIMITS);
      expect(result.ok ? "parsed" : result.refusal.code).toBe("global-flag");
    }
    const second = parseEtcdCommand("get /a\nget /b", LIMITS);
    expect(second.ok ? "parsed" : second.refusal.code).toBe("second-command");
  });
});

describe("the labels of spec 6.3", () => {
  test("name the rows and the actions in etcd's words", () => {
    expect(ETCD_LABELS).toMatchObject({
      entityName: "Key Prefix",
      entityNamePlural: "Key Prefixes",
      rowName: "Key",
      rowNamePlural: "Keys",
      selectAction: "Get Keys",
      generateAction: "Generate Command",
      searchPlaceholder: "Search key prefixes...",
      slowQueriesEmptyState: "etcd keeps no query log",
      sessionsEmptyState: "etcd does not report client sessions",
      tableStatsCaption: "The key-prefix groups; a key in no group is counted in the Overview and not here",
    });
  });

  test("the analyze and vacuum triads, never rendered, are worded true for etcd anyway", () => {
    expect(ETCD_LABELS).toMatchObject({
      analyzeAction: "Key Prefix Statistics",
      vacuumAction: "Compact History",
      analyzeGlobalLabel: "Statistics",
      analyzeGlobalTitle: "Not available",
      analyzeGlobalDesc:
        "etcd keeps no statistics to update; the Tables tab counts each key-prefix group when it opens.",
      vacuumGlobalLabel: "Compact",
      vacuumGlobalTitle: "Not available",
      vacuumGlobalDesc:
        "Compaction is the Compact history card of Global Operations, which asks for a typed confirmation.",
    });
    // No reindex triad: etcd declares no reindex, and the Operations tab draws that card only for one.
    expect(ETCD_LABELS.reindexGlobalLabel).toBeUndefined();
  });
});
