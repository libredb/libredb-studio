/**
 * One parsed command, run within its bounds (spec 5.1.3, 5.3, 5.4, 5.5, E6, E8, E14), through the
 * shared fake client (plan C12), which records every call before its stub runs. The commands are
 * parsed from etcdctl text by commands.ts, as the provider parses them, and the refusals are the
 * pure decisions of write-policy.ts, compared with what that module answers for the same facts, so
 * each test pins what execute.ts sends, in what order, and what it hands the policy.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import {
  type EtcdByteRange,
  type EtcdCallOptions,
  type EtcdClient,
  type EtcdCompare,
  EtcdError,
  type EtcdKeyValue,
  type EtcdRangeRequest,
  type EtcdRangeResponse,
  type EtcdRequestOp,
  type EtcdResponseHeader,
  type EtcdTxnRequest,
  type EtcdTxnResponse,
  type EtcdWatchBatch,
  type EtcdWatchEnd,
  type EtcdWatchEvent,
} from "@/lib/db/providers/keyvalue/etcd/client";
import { type EtcdParseLimits, type ParsedCommand, parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import { type EtcdErrorConnection, toEtcdError } from "@/lib/db/providers/keyvalue/etcd/errors";
import {
  ETCD_READ_BOUNDS,
  type ExecutionBounds,
  type ExecutionContext,
  executeCommand,
} from "@/lib/db/providers/keyvalue/etcd/execute";
import { assessCommand } from "@/lib/db/providers/keyvalue/etcd/guard";
import { commandRange } from "@/lib/db/providers/keyvalue/etcd/keys";
import { describeRange } from "@/lib/db/providers/keyvalue/etcd/permissions";
import type { CommandOutcome } from "@/lib/db/providers/keyvalue/etcd/results";
import {
  type ReadOnlySource,
  readOnlySentence,
  refuseBeforeSend,
  refuseLeaseRevoke,
  refuseStoredValues,
} from "@/lib/db/providers/keyvalue/etcd/write-policy";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../../helpers/etcd-fake-client";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
/** Bytes from text and byte values, in order. */
function cat(...parts: ReadonlyArray<string | readonly number[]>): Uint8Array {
  const bytes: number[] = [];
  for (const part of parts) bytes.push(...(typeof part === "string" ? enc(part) : part));
  return Uint8Array.from(bytes);
}

const UNKNOWN_OUTCOME = "The write may have been applied: read the key again before you run the command again.";
/** A lease id past 2^53, in the hexadecimal etcdctl prints and the decimal the seam carries. */
const LEASE_HEX = "694d8147df1dc4c8";
const LEASE_ID = "7587863092875085000";

const CONNECTION: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 16 * 1024 * 1024,
  timeoutMs: 60_000,
};
const BOUNDS: ExecutionBounds = { ...ETCD_READ_BOUNDS, rowLimit: 500, queryTimeoutMs: 60_000 };
/** Small bounds, so a few keys cross every page boundary: P 2, a ceiling of 4, 5 rows, 1,000 bytes. */
const SMALL: ExecutionBounds = {
  rowLimit: 5,
  firstPageSize: 2,
  maxPageSize: 4,
  byteBudget: 1_000,
  cellLimit: 100,
  watchMarginMs: 1_000,
  queryTimeoutMs: 60_000,
};

/** The parse limits the provider builds from the same bounds (plan Task 19). */
function limitsOf(bounds: ExecutionBounds): EtcdParseLimits {
  return {
    maxLimit: bounds.rowLimit,
    txnRangeLimit: bounds.firstPageSize,
    maxCommandTimeoutMs: bounds.queryTimeoutMs,
    maxWatchWindowMs: bounds.queryTimeoutMs - bounds.watchMarginMs,
  };
}

function parse(text: string, bounds: ExecutionBounds = BOUNDS): ParsedCommand {
  const parsed = parseEtcdCommand(text, limitsOf(bounds));
  if (!parsed.ok) throw new Error(`the test's command does not parse: ${parsed.refusal.message}`);
  return parsed.parsed;
}

/** A header whose ids are past 2^53, as a real cluster's are, so they can only travel as strings. */
function header(revision: string): EtcdResponseHeader {
  return { clusterId: "14841639068965178418", memberId: "10276657743932975437", revision, raftTerm: "2" };
}

function kv(key: string | Uint8Array, value: string | Uint8Array, modRevision = "41", lease = "0"): EtcdKeyValue {
  return {
    key: typeof key === "string" ? enc(key) : key,
    value: typeof value === "string" ? enc(value) : value,
    createRevision: "30",
    modRevision,
    version: "3",
    lease,
  };
}

function rangeAnswer(kvs: readonly EtcdKeyValue[], more = false, revision = "57"): EtcdRangeResponse {
  return { header: header(revision), kvs, more, count: String(kvs.length) };
}

interface Timer {
  readonly ms: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** The context the provider builds per command, with an injected clock and timers the test fires by hand. */
function harness(overrides: Partial<ExecutionContext> = {}) {
  const controller = new AbortController();
  const timers: Timer[] = [];
  const clock = { now: 1_000 };
  const sent = { writes: 0 };
  const context: ExecutionContext = {
    bounds: BOUNDS,
    signal: controller.signal,
    endpoint: "etcd.test:2379",
    now: () => clock.now,
    setTimer: (ms, fn) => {
      const timer: Timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    errors: CONNECTION,
    onWriteSent: () => {
      sent.writes += 1;
    },
    ...overrides,
  };
  return { context, controller, timers, clock, sent };
}

/** Every recorded call as its method and the arguments before its call options, a watch's callback left out. */
function sent(fake: FakeEtcdClient): unknown[][] {
  return fake.calls.map(({ method, args }) => [
    method,
    ...args.slice(0, -1).filter((argument) => typeof argument !== "function"),
  ]);
}

/** The signal the call at `index` carried. */
function signalOf(fake: FakeEtcdClient, index: number): AbortSignal {
  return (fake.calls[index].args.at(-1) as EtcdCallOptions).signal;
}

async function failure(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the command was expected to fail");
}

function run(fake: FakeEtcdClient, text: string, h = harness()): Promise<CommandOutcome> {
  return executeCommand(fake, parse(text, h.context.bounds), h.context);
}

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
};

function inside(key: Uint8Array, range: EtcdByteRange): boolean {
  if (range.rangeEnd === undefined) return compareBytes(key, range.key) === 0;
  const toEnd = range.rangeEnd.length === 1 && range.rangeEnd[0] === 0;
  return compareBytes(key, range.key) >= 0 && (toEnd || compareBytes(key, range.rangeEnd) < 0);
}

/** A pair as a keys-only read answers it: the value left empty. */
const withoutValue = (entry: EtcdKeyValue): EtcdKeyValue => ({ ...entry, value: new Uint8Array() });

/**
 * One revision of a key space, answering Range as etcd does: key order, cut at the limit, `more` and the count,
 * and a header that names the store's current revision whatever revision the request reads at (etcd v3.7.2,
 * measured: a Range at revision 2 answered header revision 46, the member's current one).
 */
function store(
  entries: readonly EtcdKeyValue[],
  revision = "57",
): (request: EtcdRangeRequest) => Promise<EtcdRangeResponse> {
  const sorted = [...entries].sort((a, b) => compareBytes(a.key, b.key));
  return async (request: EtcdRangeRequest) => {
    const matching = sorted.filter((entry) => inside(entry.key, request));
    const page = matching.slice(0, request.limit).map((entry) => (request.keysOnly ? withoutValue(entry) : entry));
    return {
      header: header(revision),
      kvs: page,
      more: matching.length > request.limit,
      count: String(matching.length),
    };
  };
}

const keys = (count: number, prefix = "/app/k", value = "v"): EtcdKeyValue[] =>
  Array.from({ length: count }, (_, index) => kv(`${prefix}${String(index).padStart(2, "0")}`, value));

const after = (key: string): Uint8Array => cat(key, [0]);
const APP = { key: enc("/app/"), rangeEnd: enc("/app0") };
const denied = (): EtcdError => new EtcdError("permission-denied", "etcdserver: permission denied", 7);

function txnAnswer(succeeded: boolean, responses: EtcdTxnResponse["responses"], revision = "58"): EtcdTxnResponse {
  return { header: header(revision), succeeded, responses };
}

describe("ETCD_READ_BOUNDS (KE4, KE5)", () => {
  test("holds the values Task 22's measurement kept: P 100, a ceiling of 500, 8 MiB, 64 KiB and a 1 s watch margin", () => {
    expect(ETCD_READ_BOUNDS).toEqual({
      firstPageSize: 100,
      maxPageSize: 500,
      byteBudget: 8 * 1024 * 1024,
      cellLimit: 64 * 1024,
      watchMarginMs: 1_000,
    });
  });
});

describe("E6: a read-only connection refuses every write before any request", () => {
  const writes = [
    "put /app/cfg v",
    "put /app/cfg --ignore-value",
    "del /app/cfg",
    "del /app/ --prefix",
    'txn\nmod("/app/cfg") = "7"\n\nput /app/cfg v\n',
    "lease grant 60",
    `lease revoke ${LEASE_HEX}`,
    `lease keep-alive --once ${LEASE_HEX}`,
  ];
  const sources: readonly ReadOnlySource[] = ["seed", "connection", "execution-profile"];
  for (const source of sources) {
    for (const text of writes) {
      test(`${JSON.stringify(text)} under the ${source} arm sends nothing and names where the mode was set`, async () => {
        const fake = createFakeEtcdClient();
        const h = harness({ readOnly: source });
        const error = await failure(run(fake, text, h));
        const policy = refuseBeforeSend(assessCommand(parse(text).command), { readOnly: source });
        expect(error).toBeInstanceOf(QueryError);
        expect(error.message).toBe(policy?.message as string);
        expect(error.message).toContain(readOnlySentence(source));
        expect(fake.calls).toEqual([]);
        expect(h.sent.writes).toBe(0);
        expect(h.timers).toEqual([]);
      });
    }
  }

  test("a read still runs on a read-only connection, a read-only txn among them", async () => {
    const fake = createFakeEtcdClient({
      range: store([kv("/app/cfg", "v")]),
      txn: async () => txnAnswer(true, []),
    });
    const h = harness({ readOnly: "seed" });
    await run(fake, "get /app/cfg", h);
    await run(fake, 'txn\nmod("/app/cfg") = "7"\n\nget /app/cfg\n', h);
    expect(sent(fake).map(([method]) => method)).toEqual(["range", "txn"]);
  });
});

describe("E8: the protected prefixes and key, refused with no request at all", () => {
  const spellings: ReadonlyArray<readonly [string, string]> = [
    ["the exact key", "put /registry/pods/default/nginx v"],
    ["a single-key del", "del /registry/pods/default/nginx"],
    ["a range ending inside the prefix", "del /a /registry/x"],
    ["a range from before the prefix to after it", "del /a /z"],
    ["--prefix of the parent /", "del / --prefix"],
    ["--prefix of /reg", "del /reg --prefix"],
    ["--from-key from a smaller key", "del /a --from-key"],
    ["the whole key space by --prefix", "del '' --prefix"],
    ["the whole key space by --from-key", "del '' --from-key"],
    [
      "a txn whose failure branch writes",
      'txn\nmod("/app/x") = "1"\n\nput /app/x v\n\nput /registry/configmaps/default/x v\n',
    ],
    ["a protected key written with Go escapes in a txn", 'txn\n\nput "\\x2fregistry/x" v\n'],
    ["a put --lease on a protected key", `put --lease=${LEASE_HEX} /registry/leases/x v`],
    ["del compact_rev_key", "del compact_rev_key"],
    ["put compact_rev_key", "put compact_rev_key 1"],
    ["del c d", "del c d"],
    ["del compact --prefix", "del compact --prefix"],
    ["a txn whose failure branch deletes compact_rev_key", 'txn\nmod("/app/x") = "1"\n\n\ndel compact_rev_key\n'],
  ];
  for (const [name, text] of spellings) {
    test(`${name} (${JSON.stringify(text)}) is refused with the policy's sentence and zero requests`, async () => {
      const fake = createFakeEtcdClient();
      const h = harness();
      const error = await failure(run(fake, text, h));
      const policy = refuseBeforeSend(assessCommand(parse(text).command), {});
      expect(policy).toBeDefined();
      expect(["protected-prefix", "protected-key"]).toContain(policy?.reason as string);
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(policy?.message as string);
      expect(fake.calls).toEqual([]);
      expect(h.sent.writes).toBe(0);
    });
  }
});

describe("E8: lease revoke reads the lease's keys first", () => {
  test("a lease holding one protected key among others is refused after exactly one LeaseTimeToLive with keys", async () => {
    const leased = [enc("/leases/session-2"), enc("/registry/events/default/nginx.1")];
    const fake = createFakeEtcdClient({
      leaseTimeToLive: async () => ({
        header: header("57"),
        id: LEASE_ID,
        ttl: "600",
        grantedTtl: "3600",
        keys: leased,
      }),
    });
    const h = harness();
    const error = await failure(run(fake, `lease revoke ${LEASE_HEX}`, h));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(refuseLeaseRevoke(leased)?.message as string);
    expect(sent(fake)).toEqual([["leaseTimeToLive", LEASE_ID, true]]);
    expect(h.sent.writes).toBe(0);
  });

  test("a lease whose keys etcd will not show is refused, and nothing is revoked", async () => {
    const fake = createFakeEtcdClient({
      leaseTimeToLive: async () => {
        throw denied();
      },
    });
    const error = await failure(run(fake, `lease revoke ${LEASE_HEX}`));
    expect(error.message).toBe(refuseLeaseRevoke("unreadable")?.message as string);
    expect(sent(fake)).toEqual([["leaseTimeToLive", LEASE_ID, true]]);
  });

  test("a lease of plain keys is revoked after the read, onWriteSent between the two", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      leaseTimeToLive: async () => {
        expect(h.sent.writes).toBe(0);
        return { header: header("57"), id: LEASE_ID, ttl: "600", grantedTtl: "3600", keys: [enc("/leases/session-1")] };
      },
      leaseRevoke: async () => {
        expect(h.sent.writes).toBe(1);
        return { header: header("58") };
      },
    });
    expect(await run(fake, `lease revoke ${LEASE_HEX}`, h)).toEqual({ kind: "lease-revoke", id: LEASE_ID });
    expect(sent(fake)).toEqual([
      ["leaseTimeToLive", LEASE_ID, true],
      ["leaseRevoke", LEASE_ID],
    ]);
    expect(h.sent.writes).toBe(1);
  });

  test("a lease etcd does not hold is lease not found, and nothing is revoked", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      leaseTimeToLive: async () => ({ header: header("57"), id: LEASE_ID, ttl: "-1", grantedTtl: "0", keys: [] }),
    });
    const error = await failure(run(fake, `lease revoke ${LEASE_HEX}`, h));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(`etcd answered the lease revoke: lease ${LEASE_HEX} not found or expired.`);
    expect(sent(fake)).toEqual([["leaseTimeToLive", LEASE_ID, true]]);
    expect(h.sent.writes).toBe(0);
  });

  test("a failed read of the lease's keys is a read's failure: nothing was revoked", async () => {
    const fake = createFakeEtcdClient({
      leaseTimeToLive: async () => {
        throw new EtcdError("unavailable", "etcdserver: leader changed", 14);
      },
    });
    const error = await failure(run(fake, `lease revoke ${LEASE_HEX}`));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe("etcd did not answer the read before the lease revoke. (etcd: leader changed)");
  });
});

describe("E8: the content rule under a prefix the list does not name", () => {
  const ENVELOPED = "/tenant-a/configmaps/default/cm";
  const ENCRYPTED = "/tenant-a/configmaps/default/cm-encrypted";
  // A Kubernetes protobuf envelope: the magic, a runtime.Unknown TypeMeta (v1, ConfigMap), then raw bytes.
  const ENVELOPE = cat(
    "k8s",
    [0x00, 0x0a, 0x0f, 0x0a, 0x02],
    "v1",
    [0x12, 0x09],
    "ConfigMap",
    [0x12, 0x13],
    "tenant-secret-bytes",
  );
  const SEALED = cat("k8s:enc:aescbc:v1:key1:", [0xde, 0xad, 0xbe, 0xef], "tenant-secret-bytes");
  const commands = (key: string) => [
    `put ${key} v`,
    `put ${key} --ignore-value`,
    `del ${key}`,
    `txn\nmod("${key}") = "0"\n\n\nput ${key} v\n`,
  ];
  for (const [key, value] of [
    [ENVELOPED, ENVELOPE],
    [ENCRYPTED, SEALED],
  ] as const) {
    for (const text of commands(key)) {
      test(`${JSON.stringify(text)} over a stored Kubernetes value is refused after one read, the value unnamed`, async () => {
        const fake = createFakeEtcdClient({ range: async () => rangeAnswer([kv(key, value)]) });
        const h = harness();
        const error = await failure(run(fake, text, h));
        expect(error).toBeInstanceOf(QueryError);
        expect(error.message).toBe(refuseStoredValues([{ key: enc(key), stored: value }])?.message as string);
        expect(error.message).not.toContain("tenant-secret-bytes");
        expect(sent(fake)).toEqual([["range", { key: enc(key), limit: 1 }]]);
        expect(h.sent.writes).toBe(0);
      });
    }
  }

  for (const text of commands(ENVELOPED)) {
    test(`${JSON.stringify(text)} over a plain JSON value runs, its write sent once after the read`, async () => {
      const fake = createFakeEtcdClient({
        range: async () => rangeAnswer([kv(ENVELOPED, '{"a":1}', "41")]),
        txn: async (request: EtcdTxnRequest) =>
          txnAnswer(
            true,
            request.success.map((op) =>
              op.op === "put"
                ? { op: "put", response: { header: header("58") } }
                : { op: "delete", response: { header: header("58"), deleted: "1", prevKvs: [] } },
            ),
          ),
      });
      const h = harness();
      await run(fake, text, h);
      expect(sent(fake).map(([method]) => method)).toEqual(["range", "txn"]);
      expect(h.sent.writes).toBe(1);
    });
  }

  test("a target whose read etcd refuses is refused as unreadable, before any write", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw denied();
      },
    });
    const error = await failure(run(fake, "put /app/cfg v"));
    expect(error.message).toBe(refuseStoredValues([{ key: enc("/app/cfg"), stored: "unreadable" }])?.message as string);
    expect(sent(fake)).toEqual([["range", { key: enc("/app/cfg"), limit: 1 }]]);
  });

  test("more than 128 distinct targets are read in read-only Txns of at most 128 Range ops, and the txn then runs", async () => {
    const success = Array.from({ length: 100 }, (_, index) => `put /app/s${String(index).padStart(3, "0")} v`);
    const failed = Array.from({ length: 100 }, (_, index) => `put /app/f${String(index).padStart(3, "0")} v`);
    const text = `txn\nmod("/app/s000") = "0"\n\n${success.join("\n")}\n\n${failed.join("\n")}\n`;
    const fake = createFakeEtcdClient({
      txn: async (request: EtcdTxnRequest) =>
        request.compare.length === 0
          ? txnAnswer(
              true,
              request.success.map(() => ({ op: "range", response: rangeAnswer([]) })),
            )
          : txnAnswer(true, []),
    });
    const h = harness();
    await run(fake, text, h);
    const txns = fake.calls.map((call) => call.args[0] as EtcdTxnRequest);
    expect(txns.map((request) => [request.compare.length, request.success.length, request.failure.length])).toEqual([
      [0, 128, 0],
      [0, 72, 0],
      [1, 100, 100],
    ]);
    const read = [...txns[0].success, ...txns[1].success];
    expect(read[0]).toEqual({ op: "range", request: { key: enc("/app/s000"), limit: 1 } });
    expect(read[100]).toEqual({ op: "range", request: { key: enc("/app/f000"), limit: 1 } });
    expect(h.sent.writes).toBe(1);
  });

  test("a batch etcd refuses as a whole is read key by key, up to the key it refuses, which the refusal names", async () => {
    const text = 'txn\nmod("/app/a") = "0"\n\nput /app/a v\nput /app/b v\nput /app/c v\n';
    const fake = createFakeEtcdClient({
      txn: async () => {
        throw denied();
      },
      range: async (request: EtcdRangeRequest) => {
        if (new TextDecoder().decode(request.key) === "/app/b") throw denied();
        return rangeAnswer([kv(request.key, "v")]);
      },
    });
    const error = await failure(run(fake, text));
    expect(error.message).toBe(
      refuseStoredValues([
        { key: enc("/app/a"), stored: enc("v") },
        { key: enc("/app/b"), stored: "unreadable" },
      ])?.message as string,
    );
    expect(sent(fake).map(([method]) => method)).toEqual(["txn", "range", "range"]);
  });

  test("a key etcd refuses in the first batch ends the read: no later batch is sent", async () => {
    const puts = Array.from({ length: 130 }, (_, index) => `put /app/t${String(index).padStart(3, "0")} v`);
    const fake = createFakeEtcdClient({
      txn: async () => {
        throw denied();
      },
      range: async () => {
        throw denied();
      },
    });
    const error = await failure(run(fake, `txn\n\n${puts.join("\n")}\n`));
    expect(error.message).toBe(
      refuseStoredValues([{ key: enc("/app/t000"), stored: "unreadable" }])?.message as string,
    );
    expect(sent(fake).map(([method]) => method)).toEqual(["txn", "range"]);
    expect((fake.calls[0].args[0] as EtcdTxnRequest).success).toHaveLength(128);
  });

  test("a read-only Txn answered without its Range responses is refused, and nothing is written", async () => {
    const fake = createFakeEtcdClient({ txn: async () => txnAnswer(true, []) });
    const h = harness();
    const error = await failure(run(fake, "txn\n\nput /app/a v\nput /app/b v\n", h));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The read before the txn failed. (etcd's txn answer holds no range response at position 1)",
    );
    expect(h.sent.writes).toBe(0);
  });

  test("a read-only Txn answered with responses of another op is refused the same way, and nothing is written", async () => {
    const put = { op: "put" as const, response: { header: header("58") } };
    const fake = createFakeEtcdClient({ txn: async () => txnAnswer(true, [put, put]) });
    const h = harness();
    const error = await failure(run(fake, "txn\n\nput /app/a v\nput /app/b v\n", h));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The read before the txn failed. (etcd's txn answer holds no range response at position 1)",
    );
    expect(sent(fake).map(([method]) => method)).toEqual(["txn"]);
    expect(h.sent.writes).toBe(0);
  });

  test("a range del under the unprotected prefix is sent unchanged, not read first: the documented limit", async () => {
    const fake = createFakeEtcdClient({
      deleteRange: async () => ({ header: header("58"), deleted: "2", prevKvs: [] }),
    });
    const h = harness();
    const outcome = await run(fake, "del /tenant-a/ --prefix", h);
    expect(sent(fake)).toEqual([
      ["deleteRange", { key: enc("/tenant-a/"), rangeEnd: enc("/tenant-a0"), prevKv: false }],
    ]);
    expect(outcome).toEqual({ kind: "del", response: { header: header("58"), deleted: "2", prevKvs: [] } });
    expect(h.sent.writes).toBe(1);
  });

  test("a del with a range end or --from-key is one DeleteRange too, not read first", async () => {
    const fake = createFakeEtcdClient({
      deleteRange: async () => ({ header: header("58"), deleted: "0", prevKvs: [] }),
    });
    const h = harness();
    await run(fake, "del /tenant-a/x /tenant-a/y", h);
    await run(fake, "del tenant-a/ --from-key", h);
    expect(sent(fake)).toEqual([
      ["deleteRange", { key: enc("/tenant-a/x"), rangeEnd: enc("/tenant-a/y"), prevKv: false }],
      ["deleteRange", { key: enc("tenant-a/"), rangeEnd: Uint8Array.of(0), prevKv: false }],
    ]);
    expect(h.sent.writes).toBe(2);
  });

  test("a txn whose writes all name ranges has no single-key target, so nothing is read before it", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ txn: async () => txnAnswer(true, []) });
    await run(fake, "txn\n\ndel /app/old/ --prefix\n", h);
    const deletes: EtcdRequestOp[] = [
      { op: "delete", request: { key: enc("/app/old/"), rangeEnd: enc("/app/old0"), prevKv: false } },
    ];
    expect(sent(fake)).toEqual([["txn", { compare: [], success: deletes, failure: [] }]]);
    expect(h.sent.writes).toBe(1);
  });

  test("a batch's answers are read by position: the second target's Kubernetes value refuses the txn, named by its own key", async () => {
    const fake = createFakeEtcdClient({
      txn: async () =>
        txnAnswer(true, [
          { op: "range", response: rangeAnswer([kv("/app/plain", '{"a":1}')]) },
          { op: "range", response: rangeAnswer([kv(ENVELOPED, ENVELOPE)]) },
        ]),
    });
    const h = harness();
    const error = await failure(run(fake, `txn\n\nput /app/plain v\nput ${ENVELOPED} v\n`, h));
    expect(error.message).toBe(
      refuseStoredValues([
        { key: enc("/app/plain"), stored: enc('{"a":1}') },
        { key: enc(ENVELOPED), stored: ENVELOPE },
      ])?.message as string,
    );
    expect(sent(fake).map(([method]) => method)).toEqual(["txn"]);
    expect(h.sent.writes).toBe(0);
  });

  test("KE4: a read-only Txn answered past the receive cap refuses the txn before any write, as a read", async () => {
    const fake = createFakeEtcdClient({
      txn: async () => {
        throw new EtcdError("resource-exhausted", "Received message larger than max (17825792 vs 16777216)", 8);
      },
    });
    const h = harness();
    const error = await failure(run(fake, "txn\n\nput /app/a v\nput /app/b v\n", h));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "etcd's answer to the read before the txn is larger than this connection's receive cap of 16 MiB: narrow the read. (Received message larger than max (17825792 vs 16777216))",
    );
    expect(sent(fake).map(([method]) => method)).toEqual(["txn"]);
    expect(h.sent.writes).toBe(0);
  });
});

describe("E8: a top-level single-key put or del is sent as the guarded Txn", () => {
  const KEY = enc("/app/cfg");
  const guard = (modRevision: string): EtcdCompare[] => [
    { key: KEY, target: "mod", result: "equal", operand: modRevision },
  ];
  const readBack: EtcdRequestOp[] = [{ op: "range", request: { key: KEY, limit: 1 } }];

  test("a put of an existing key compares the mod_revision it read, puts, and reads the key on failure", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => {
        expect(h.sent.writes).toBe(0);
        return rangeAnswer([kv("/app/cfg", "old", "41")]);
      },
      txn: async () => {
        expect(h.sent.writes).toBe(1);
        return txnAnswer(true, [{ op: "put", response: { header: header("0") } }]);
      },
    });
    const outcome = await run(fake, "put /app/cfg new", h);
    expect(sent(fake)).toEqual([
      ["range", { key: KEY, limit: 1 }],
      [
        "txn",
        {
          compare: guard("41"),
          success: [
            {
              op: "put",
              request: { key: KEY, value: enc("new"), prevKv: false, ignoreValue: false, ignoreLease: false },
            },
          ],
          failure: readBack,
        },
      ],
    ]);
    // The answer carries the Txn's own header, the revision the put created.
    expect(outcome).toEqual({ kind: "put", key: KEY, response: { header: header("58") } });
    expect(h.sent.writes).toBe(1);
  });

  test("a put of a key that does not exist compares mod against 0, the create shape kine accepts", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      txn: async () => txnAnswer(true, [{ op: "put", response: { header: header("58") } }]),
    });
    await run(fake, "put /app/cfg v");
    expect((fake.calls[1].args[0] as EtcdTxnRequest).compare).toEqual(guard("0"));
  });

  test("the put's flags travel on its op: the lease in decimal, --prev-kv, and the previous pair answered", async () => {
    const previous = kv("/app/cfg", "old", "41");
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([previous]),
      txn: async () => txnAnswer(true, [{ op: "put", response: { header: header("58"), prevKv: previous } }]),
    });
    const outcome = await run(fake, `put /app/cfg v --lease=${LEASE_HEX} --prev-kv`);
    expect((fake.calls[1].args[0] as EtcdTxnRequest).success).toEqual([
      {
        op: "put",
        request: { key: KEY, value: enc("v"), lease: LEASE_ID, prevKv: true, ignoreValue: false, ignoreLease: false },
      },
    ]);
    expect(outcome).toEqual({ kind: "put", key: KEY, response: { header: header("58"), prevKv: previous } });
  });

  test("--ignore-value and --ignore-lease travel as they were typed, with an empty value", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([kv("/app/cfg", "old", "41")]),
      txn: async () => txnAnswer(true, [{ op: "put", response: { header: header("58") } }]),
    });
    await run(fake, "put /app/cfg --ignore-value --ignore-lease");
    expect((fake.calls[1].args[0] as EtcdTxnRequest).success).toEqual([
      {
        op: "put",
        request: { key: KEY, value: new Uint8Array(), prevKv: false, ignoreValue: true, ignoreLease: true },
      },
    ]);
  });

  test("a single-key del deletes on success, with --prev-kv answering the deleted pair", async () => {
    const previous = kv("/app/cfg", "old", "41");
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([previous]),
      txn: async () =>
        txnAnswer(true, [{ op: "delete", response: { header: header("0"), deleted: "1", prevKvs: [previous] } }]),
    });
    const outcome = await run(fake, "del /app/cfg --prev-kv");
    expect(fake.calls[1].args[0]).toEqual({
      compare: guard("41"),
      success: [{ op: "delete", request: { key: KEY, prevKv: true } }],
      failure: readBack,
    });
    expect(outcome).toEqual({ kind: "del", response: { header: header("58"), deleted: "1", prevKvs: [previous] } });
  });

  test("a key changed after the read is refused naming the mod_revision the failure branch read, never the value", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([kv("/app/cfg", "old", "41")]),
      txn: async () =>
        txnAnswer(false, [{ op: "range", response: rangeAnswer([kv("/app/cfg", "someone-elses-value", "44")]) }]),
    });
    const error = await failure(run(fake, "put /app/cfg mine", h));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      `etcd did not apply the put, because ${describeRange({ key: KEY })} changed after Studio read it, and etcd now holds it at mod_revision 44. Nothing was written: read the key again, then run the put again.`,
    );
    expect(error.message).not.toContain("someone-elses-value");
    expect(sent(fake).map(([method]) => method)).toEqual(["range", "txn"]);
  });

  test("a key deleted after the read is refused saying so", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([kv("/app/cfg", "old", "41")]),
      txn: async () => txnAnswer(false, [{ op: "range", response: rangeAnswer([]) }]),
    });
    const error = await failure(run(fake, "del /app/cfg"));
    expect(error.message).toBe(
      `etcd did not apply the del, because ${describeRange({ key: KEY })} was deleted after Studio read it. Nothing was written: read the key again, then run the del again.`,
    );
  });

  test("a Txn answered without its op's response is raised as a write whose outcome is unknown", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      txn: async () => txnAnswer(true, []),
    });
    const error = await failure(run(fake, "put /app/cfg v"));
    expect(error.message).toBe(
      `The put failed. (etcd's txn answer holds no put response at position 1) ${UNKNOWN_OUTCOME}`,
    );
  });

  test("a Txn answered with another op's response where its op's belongs is raised the same way, never read as the put's answer", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      txn: async () => txnAnswer(true, [{ op: "range", response: rangeAnswer([]) }]),
    });
    const error = await failure(run(fake, "put /app/cfg v"));
    expect(error.message).toBe(
      `The put failed. (etcd's txn answer holds no put response at position 1) ${UNKNOWN_OUTCOME}`,
    );
  });

  test("Review Focus 3: the member stopping after the Txn left says the write may have been applied", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      txn: async () => {
        throw new EtcdError("unavailable", "etcdserver: request timed out", 14);
      },
    });
    const error = await failure(run(fake, "put /app/cfg v", h));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      `etcd did not confirm the put: the connection failed after the request was sent. (etcd: request timed out) ${UNKNOWN_OUTCOME}`,
    );
    expect(h.sent.writes).toBe(1);
  });

  for (const verb of ["put", "del"] as const) {
    test(`E14: a ${verb} answered past the receive cap is reported as applied, never as failed`, async () => {
      const fake = createFakeEtcdClient({
        range: async () => rangeAnswer([]),
        txn: async () => {
          throw new EtcdError("resource-exhausted", "Received message larger than max (17825792 vs 16777216)", 8);
        },
      });
      const error = await failure(run(fake, verb === "put" ? "put /app/cfg v" : "del /app/cfg"));
      expect(error.message).toBe(
        `etcd applied the ${verb}, but its answer is larger than this connection's receive cap of 16 MiB and was not read. (Received message larger than max (17825792 vs 16777216)) Read the keys back to see the result.`,
      );
    });
  }

  test("a failed read before the write is a read's failure: nothing was sent, and no write is counted", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => {
        throw new EtcdError("unavailable", "etcdserver: leader changed", 14);
      },
    });
    const error = await failure(run(fake, "put /app/cfg v", h));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe("etcd did not answer the read before the put. (etcd: leader changed)");
    expect(sent(fake).map(([method]) => method)).toEqual(["range"]);
    expect(h.sent.writes).toBe(0);
  });

  test("a cancelQuery between the read and the write sends no write, so cancelQuery's true is right", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => {
        h.controller.abort();
        return rangeAnswer([]);
      },
    });
    const error = await failure(run(fake, "put /app/cfg v", h));
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("The put was cancelled.");
    expect(sent(fake).map(([method]) => method)).toEqual(["range"]);
    expect(h.sent.writes).toBe(0);
  });

  test("a write etcd refuses for permission names the key or the range it writes (spec 5.6)", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      txn: async () => {
        throw denied();
      },
      deleteRange: async () => {
        throw denied();
      },
    });
    const refusal = async (text: string): Promise<string> => (await failure(run(fake, text))).message;
    const granted = ": this connection's etcd user is not granted all of it. (etcd: permission denied)";
    expect(await refusal("put /app/cfg v")).toBe(`etcd refused the put on ${describeRange({ key: KEY })}${granted}`);
    expect(await refusal("del /app/cfg")).toBe(`etcd refused the del on ${describeRange({ key: KEY })}${granted}`);
    const prefix = describeRange(commandRange({ key: enc("/tenant-a/"), prefix: true, fromKey: false }));
    expect(await refusal("del /tenant-a/ --prefix")).toBe(`etcd refused the del on ${prefix}${granted}`);
  });
});

describe("a typed txn (spec 5.1.4, E14)", () => {
  test("a read-only txn is one Txn, as written: every compare, and each get bounded in the request", async () => {
    const text = [
      "txn",
      'create("/a") > "0"',
      'mod("/a") < "10"',
      'version("/a") != "2"',
      'value("/a") = "v1"',
      `lease("/a") = "${LEASE_HEX}"`,
      "",
      "get /a",
      "get /app/ --prefix",
      "get /app/ --prefix --limit=7 --rev=3 --keys-only --consistency=s",
      "get /b --count-only",
      "get /app/ --prefix --count-only --limit=9",
      "",
    ].join("\n");
    const h = harness();
    const fake = createFakeEtcdClient({ txn: async () => txnAnswer(true, []) });
    const outcome = await run(fake, text, h);
    const request: EtcdTxnRequest = {
      compare: [
        { key: enc("/a"), target: "create", result: "greater", operand: "0" },
        { key: enc("/a"), target: "mod", result: "less", operand: "10" },
        { key: enc("/a"), target: "version", result: "not-equal", operand: "2" },
        { key: enc("/a"), target: "value", result: "equal", operand: enc("v1") },
        { key: enc("/a"), target: "lease", result: "equal", operand: LEASE_ID },
      ],
      success: [
        { op: "range", request: { key: enc("/a"), limit: 1, keysOnly: false, countOnly: false, serializable: false } },
        // A ranged get with no --limit is sent with P (spec 5.1.4).
        { op: "range", request: { ...APP, limit: 100, keysOnly: false, countOnly: false, serializable: false } },
        {
          op: "range",
          request: { ...APP, limit: 7, revision: "3", keysOnly: true, countOnly: false, serializable: true },
        },
        { op: "range", request: { key: enc("/b"), limit: 1, keysOnly: false, countOnly: true, serializable: false } },
        // A count carries limit 1, typed --limit or not: etcd counts the whole range whatever the limit.
        { op: "range", request: { ...APP, limit: 1, keysOnly: false, countOnly: true, serializable: false } },
      ],
      failure: [],
    };
    expect(sent(fake)).toEqual([["txn", request]]);
    expect(outcome).toEqual({ kind: "txn", request, response: txnAnswer(true, []) });
    expect(h.sent.writes).toBe(0);
  });

  test("a txn that writes reads its one target first, then runs as written, onWriteSent before the send", async () => {
    const text = [
      "txn",
      'mod("/app/cfg") = "7"',
      "",
      `put /app/cfg v2 --lease=${LEASE_HEX} --prev-kv`,
      "del /app/old/ --prefix",
      "",
      "del /app/cfg --prev-kv",
      "",
    ].join("\n");
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([kv("/app/cfg", "v1", "7")]),
      txn: async () => {
        expect(h.sent.writes).toBe(1);
        return txnAnswer(true, []);
      },
    });
    await run(fake, text, h);
    expect(sent(fake)).toEqual([
      ["range", { key: enc("/app/cfg"), limit: 1 }],
      [
        "txn",
        {
          compare: [{ key: enc("/app/cfg"), target: "mod", result: "equal", operand: "7" }],
          success: [
            {
              op: "put",
              request: {
                key: enc("/app/cfg"),
                value: enc("v2"),
                lease: LEASE_ID,
                prevKv: true,
                ignoreValue: false,
                ignoreLease: false,
              },
            },
            { op: "delete", request: { key: enc("/app/old/"), rangeEnd: enc("/app/old0"), prevKv: false } },
          ],
          failure: [{ op: "delete", request: { key: enc("/app/cfg"), prevKv: true } }],
        },
      ],
    ]);
    expect(h.sent.writes).toBe(1);
  });

  test("E14: a txn that writes answered past the receive cap says one of its branches ran, never that it failed", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      txn: async () => {
        throw new EtcdError("resource-exhausted", "Received message larger than max (17825792 vs 16777216)", 8);
      },
    });
    const error = await failure(run(fake, "txn\n\nput /app/cfg v\n"));
    expect(error.message).toBe(
      "One branch of the txn ran, but etcd's answer, which names the branch, is larger than this connection's receive cap of 16 MiB and was not read. (Received message larger than max (17825792 vs 16777216)) Read the keys back to see the result.",
    );
  });

  test("a read-only txn that fails is a read's failure", async () => {
    const fake = createFakeEtcdClient({
      txn: async () => {
        throw new EtcdError("unavailable", "etcdserver: leader changed", 14);
      },
    });
    const error = await failure(run(fake, "txn\n\nget /app/cfg\n"));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe("etcd did not answer the txn. (etcd: leader changed)");
  });

  test("a get with a range end or --from-key inside a txn is ranged, sent with P, and a single-key get keeps its --limit", async () => {
    const fake = createFakeEtcdClient({ txn: async () => txnAnswer(true, []) });
    await run(fake, "txn\n\nget /app/a /app/z\nget /app/ --from-key\nget /a --limit=5\n");
    const flags = { keysOnly: false, countOnly: false, serializable: false };
    expect((fake.calls[0].args[0] as EtcdTxnRequest).success).toEqual([
      { op: "range", request: { key: enc("/app/a"), rangeEnd: enc("/app/z"), limit: 100, ...flags } },
      { op: "range", request: { key: enc("/app/"), rangeEnd: Uint8Array.of(0), limit: 100, ...flags } },
      { op: "range", request: { key: enc("/a"), limit: 5, ...flags } },
    ]);
  });
});

describe("a get, paged and pinned (spec 5.4, E14)", () => {
  test("pages start at P and double while small; each later page is a whole request, past the last key held and at the first page's revision, so the adapter's one renewal resends it unchanged (Review Focus 3)", async () => {
    const h = harness({ bounds: SMALL });
    const fake = createFakeEtcdClient({ range: store(keys(12)) });
    const outcome = await run(fake, "get /app/ --prefix", h);
    const page = { keysOnly: false, countOnly: false, serializable: false };
    expect(sent(fake)).toEqual([
      ["range", { ...APP, limit: 2, ...page }],
      // The second page starts past the last key the first held, at the first page's revision.
      ["range", { key: after("/app/k01"), rangeEnd: enc("/app0"), limit: 4, revision: "57", ...page }],
    ]);
    // Without a typed --limit a page asks for one key past the row limit, and that key is the one the read stopped before.
    expect(outcome).toEqual({
      kind: "get",
      kvs: keys(12).slice(0, 5),
      keysOnly: false,
      countOnly: false,
      more: true,
      stopped: { by: "rows", beforeKey: enc("/app/k05") },
      header: header("57"),
    });
  });

  test("the page size never passes its ceiling, and the last page asks only for the rows still wanted", async () => {
    const bounds = { ...SMALL, rowLimit: 12 };
    const fake = createFakeEtcdClient({ range: store(keys(12)) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds }));
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2, 4, 4, 3]);
    expect(outcome).toMatchObject({ kvs: keys(12), more: false });
  });

  test("a range that ends at the row limit exactly answers every key, and says nothing was cut", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(5)) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL }));
    expect(outcome).toMatchObject({ kvs: keys(5), more: false });
    expect(outcome).not.toHaveProperty("stopped");
  });

  test("a typed --limit narrows the read, asks for no key past it, and `more` says whether it cut the range", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(12)) });
    const outcome = await run(fake, "get /app/ --prefix --limit=3", harness({ bounds: SMALL }));
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2, 1]);
    expect(outcome).toMatchObject({ kvs: keys(12).slice(0, 3), more: true });
    expect(outcome).not.toHaveProperty("stopped");
  });

  test("the byte budget stops the read before the row that would pass it, and the page size stops growing", async () => {
    // Each row holds an 8-byte key and a 400-byte value: two fit in 1,000 bytes, and a third does not.
    const fake = createFakeEtcdClient({ range: store(keys(6, "/app/k", "x".repeat(400))) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL }));
    // Two of the first page's 816 bytes would not fit in the 184 left, so the second page stays at 2.
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2, 2]);
    expect(outcome).toMatchObject({
      kvs: keys(6, "/app/k", "x".repeat(400)).slice(0, 2),
      more: true,
      stopped: { by: "bytes", beforeKey: enc("/app/k02") },
    });
  });

  test("rows that fill the byte budget exactly are held, and the next row is the one it stops before", async () => {
    // An 8-byte key and a 492-byte value: two rows are 1,000 bytes, the whole budget.
    const entries = keys(3, "/app/k", "x".repeat(492));
    const fake = createFakeEtcdClient({ range: store(entries) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL }));
    expect(outcome).toMatchObject({
      kvs: entries.slice(0, 2),
      more: true,
      stopped: { by: "bytes", beforeKey: enc("/app/k02") },
    });
  });

  /**
   * The store behind a receive cap: an answer whose rows take more than `cap` bytes is refused as grpc-js
   * refuses one past the channel's maximum receive size (KE4, measured: twenty values of 1 MiB answered
   * 20,972,150 bytes past a 16 MiB cap).
   */
  const capped =
    (entries: readonly EtcdKeyValue[], cap: number) =>
    async (request: EtcdRangeRequest): Promise<EtcdRangeResponse> => {
      const answer = await store(entries)(request);
      const bytes = answer.kvs.reduce((sum, entry) => sum + entry.key.byteLength + entry.value.byteLength, 0);
      if (bytes > cap)
        throw new EtcdError("resource-exhausted", `Received message larger than max (${bytes} vs ${cap})`, 8);
      return answer;
    };

  test("KE4: a page the receive cap refuses is asked again from the same key and revision with half its limit", async () => {
    // An 8-byte key and a 300-byte value: two rows are 616 bytes, past a 500-byte cap, and one row is 308.
    const entries = keys(4, "/app/k", "x".repeat(300));
    const fake = createFakeEtcdClient({ range: capped(entries, 500) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL }));
    const requests = sent(fake).map((call) => call[1] as EtcdRangeRequest);
    // The size the read goes on from is the halved one, and it grows again while the pages stay small.
    expect(requests.map((request) => request.limit)).toEqual([2, 1, 2, 1, 1, 1]);
    expect(requests[2]).toEqual({ ...requests[3], limit: 2 });
    expect(requests[3]).toMatchObject({ key: after("/app/k00"), revision: "57" });
    expect(outcome).toMatchObject({
      kvs: entries.slice(0, 3),
      more: true,
      stopped: { by: "bytes", beforeKey: enc("/app/k03") },
    });
  });

  test("KE4: the limit is halved, not stepped down, so a large first page reaches one that fits in few asks", async () => {
    // Three rows are 924 bytes, past a 700-byte cap, and two are 616: the first page of three (the row limit
    // and one key past it) is asked again for one, where stepping down would ask for two.
    const entries = keys(4, "/app/k", "x".repeat(300));
    const fake = createFakeEtcdClient({ range: capped(entries, 700) });
    const bounds = { ...SMALL, firstPageSize: 4, rowLimit: 2 };
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds }));
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([3, 1, 2]);
    expect(outcome).toMatchObject({ kvs: entries.slice(0, 2), stopped: { by: "rows", beforeKey: enc("/app/k02") } });
  });

  test("KE4: a key the receive cap refuses on its own raises the cap's sentence, after a page of one key", async () => {
    const fake = createFakeEtcdClient({ range: capped([kv("/app/k00", "y".repeat(600))], 500) });
    const raised = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL })).catch((error: unknown) => error);
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2, 1]);
    expect(raised).toBeInstanceOf(QueryError);
    expect((raised as QueryError).message).toBe(
      "etcd's answer to the get is larger than this connection's receive cap of 16 MiB: narrow the read. (Received message larger than max (608 vs 500))",
    );
  });

  test("KE4, the control: another failure of a page is raised at once, never asked again with a smaller limit", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw new EtcdError("too-many-requests", "etcdserver: too many requests", 8);
      },
    });
    const raised = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL })).catch((error: unknown) => error);
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2]);
    expect(raised).toBeInstanceOf(Error);
  });

  test("a first row larger than the budget is held, so its value still answers one row", async () => {
    const entries = [kv("/app/k00", "y".repeat(2_000)), kv("/app/k01", "z")];
    const fake = createFakeEtcdClient({ range: store(entries) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL }));
    expect(outcome).toMatchObject({
      kvs: [entries[0]],
      more: true,
      stopped: { by: "bytes", beforeKey: enc("/app/k01") },
    });
  });

  test("--keys-only, --consistency=s and a typed --rev travel on every page", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(4)) });
    const outcome = await run(
      fake,
      "get /app/ --prefix --keys-only --consistency=s --rev=42",
      harness({ bounds: SMALL }),
    );
    const page = { revision: "42", keysOnly: true, countOnly: false, serializable: true };
    expect(sent(fake)).toEqual([
      ["range", { ...APP, limit: 2, ...page }],
      ["range", { key: after("/app/k01"), rangeEnd: enc("/app0"), limit: 4, ...page }],
    ]);
    // The first page's header, which names the store's current revision, not the typed --rev.
    expect(outcome).toMatchObject({ keysOnly: true, more: false, header: header("57") });
  });

  test("a single key is one Range", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(3)) });
    const outcome = await run(fake, "get /app/k01");
    expect(sent(fake)).toEqual([
      ["range", { key: enc("/app/k01"), limit: 100, keysOnly: false, countOnly: false, serializable: false }],
    ]);
    expect(outcome).toMatchObject({ kvs: [keys(3)[1]], more: false });
  });

  test("--count-only is one count_only Range, whose count is the answer", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(12)) });
    const outcome = await run(fake, "get /app/ --prefix --count-only");
    expect(sent(fake)).toEqual([
      ["range", { ...APP, limit: 1, keysOnly: false, countOnly: true, serializable: false }],
    ]);
    expect(outcome).toEqual({
      kind: "get",
      kvs: [],
      count: "12",
      keysOnly: false,
      countOnly: true,
      more: false,
      header: header("57"),
    });
  });

  test("a page with no keys that says more follow ends the read instead of asking for it again", async () => {
    const fake = createFakeEtcdClient({ range: async () => rangeAnswer([], true) });
    const error = await failure(run(fake, "get /app/ --prefix"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "etcd answered a page of the get with no keys and more to follow, so Studio stopped the read: run it again.",
    );
    expect(fake.calls).toHaveLength(1);
  });

  test("Review Focus 2: a compaction between the pages of a pinned read says so, shows no row, and is not 5.6's typed sentence", async () => {
    const first = store(keys(12));
    const fake = createFakeEtcdClient({
      range: async (request: EtcdRangeRequest) => {
        if (request.revision === undefined) return first(request);
        throw new EtcdError("compacted", "etcdserver: mvcc: required revision has been compacted", 11);
      },
    });
    const error = await failure(run(fake, "get /app/ --prefix", harness({ bounds: SMALL })));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "A compaction overtook the get: etcd compacted revision 57, the revision its pages are pinned to, after the first page was read, so the rows read are not the whole answer and none is shown. Run the get again. (etcd: mvcc: required revision has been compacted)",
    );
    expect(error.message).not.toContain("ask for a later revision");
    expect(fake.calls).toHaveLength(2);
  });

  test("Review Focus 2: a --rev read that a compaction overtakes after its first page says so, and to read a later --rev", async () => {
    let pages = 0;
    const fake = createFakeEtcdClient({
      range: async (request: EtcdRangeRequest) => {
        pages += 1;
        if (pages === 1) return store(keys(12))(request);
        throw new EtcdError("compacted", "etcdserver: mvcc: required revision has been compacted", 11);
      },
    });
    const error = await failure(run(fake, "get /app/ --prefix --rev=42", harness({ bounds: SMALL })));
    expect(error.message).toBe(
      "A compaction overtook the get: etcd compacted revision 42, the --rev it reads at, after the first page was read, so the rows read are not the whole answer and none is shown. Run the get again with a later --rev. (etcd: mvcc: required revision has been compacted)",
    );
  });

  test("Review Focus 2, the control: a typed --rev etcd had compacted before the first page is 5.6's sentence", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw new EtcdError("compacted", "etcdserver: mvcc: required revision has been compacted", 11);
      },
    });
    const error = await failure(run(fake, "get /app/ --prefix --rev=3"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The get asked for a revision etcd has compacted: ask for a later revision. (etcd: mvcc: required revision has been compacted)",
    );
  });

  test("Review Focus 3: a page the adapter could not renew for raises the sign-in error, and no row is shown", async () => {
    const answer = store(keys(12));
    const fake = createFakeEtcdClient({
      range: async (request: EtcdRangeRequest) => {
        if (request.revision === undefined) return answer(request);
        throw new EtcdError("unauthenticated", "etcdserver: invalid auth token", 16);
      },
    });
    const error = await failure(run(fake, "get /app/ --prefix", harness({ bounds: SMALL })));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(
      "etcd did not accept this connection's sign-in for the get: connect again. (etcd: invalid auth token)",
    );
  });

  test("Review Focus 3: a leader change between pages is a read's failure, retryable, with no partial answer", async () => {
    const answer = store(keys(12));
    const fake = createFakeEtcdClient({
      range: async (request: EtcdRangeRequest) => {
        if (request.revision === undefined) return answer(request);
        throw new EtcdError("unavailable", "etcdserver: leader changed", 14);
      },
    });
    const error = await failure(run(fake, "get /app/ --prefix", harness({ bounds: SMALL })));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe("etcd did not answer the get. (etcd: leader changed)");
  });

  test("a refused read names the range asked for and what the user may read (spec 5.6)", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw denied();
      },
    });
    const h = harness({ readable: { user: "reader", ranges: "/app/ (prefix), /config/a" } });
    const error = await failure(run(fake, "get /registry/ --prefix", h));
    expect(error).toBeInstanceOf(QueryError);
    const range = describeRange(commandRange({ key: enc("/registry/"), prefix: true, fromKey: false }));
    expect(error.message).toBe(
      `etcd refused the get on ${range}: this connection's etcd user is not granted all of it. (etcd: permission denied) etcd user reader may read: /app/ (prefix), /config/a.`,
    );
  });

  test("a read that reaches no etcd names the configured endpoint (spec 5.6)", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw new EtcdError("not-connected", "No connection established. Last error: connect ECONNREFUSED", 14);
      },
    });
    const error = await failure(run(fake, "get /app/cfg"));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toStartWith("No etcd answered a plaintext connection at etcd.test:2379.");
  });

  test("the answer carries the first page's header, the revision its pages are pinned to, though later pages answer at a later revision", async () => {
    const answer = store(keys(12));
    const fake = createFakeEtcdClient({
      range: async (request: EtcdRangeRequest) => {
        const page = await answer(request);
        // etcd's header names the store's current revision, whatever revision the request reads at.
        return request.revision === undefined ? page : { ...page, header: header("60") };
      },
    });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL }));
    expect((fake.calls[1].args[0] as EtcdRangeRequest).revision).toBe("57");
    expect(outcome).toMatchObject({ header: header("57") });
  });

  test("a typed --limit below P is the first page's limit, so no key past it is asked", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(12)) });
    const outcome = await run(fake, "get /app/ --prefix --limit=3");
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([3]);
    expect(outcome).toMatchObject({ kvs: keys(12).slice(0, 3), more: true });
    expect(outcome).not.toHaveProperty("stopped");
  });

  test("a --limit above the connection's row limit, from text parsed with other limits, is held to the row limit", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(12)) });
    // Parsed with the default bounds, whose row limit is 500, and run under SMALL's 5.
    const outcome = await executeCommand(
      fake,
      parse("get /app/ --prefix --limit=8"),
      harness({ bounds: SMALL }).context,
    );
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2, 3]);
    expect(outcome).toMatchObject({ kvs: keys(12).slice(0, 5), more: true });
  });

  test("a row's key counts toward the byte budget as well as its value", async () => {
    // An 8-byte key and a 330-byte value: two rows are 676 bytes, and a third would take them to 1,014.
    const entries = keys(4, "/app/k", "x".repeat(330));
    const fake = createFakeEtcdClient({ range: store(entries) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: SMALL }));
    expect(outcome).toMatchObject({
      kvs: entries.slice(0, 2),
      more: true,
      stopped: { by: "bytes", beforeKey: enc("/app/k02") },
    });
  });

  test("the page size doubles when twice the page just read fits the budget left exactly", async () => {
    // A 150-byte row: the first page's 300 bytes, doubled, are the 600 a 900-byte budget has left.
    const entries = keys(5, "/app/k", "x".repeat(142));
    const fake = createFakeEtcdClient({ range: store(entries) });
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds: { ...SMALL, byteBudget: 900 } }));
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2, 4]);
    expect(outcome).toMatchObject({ kvs: entries, more: false });
  });

  test("the page size doubles, and no faster, from P to its ceiling", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(30)) });
    const bounds = { ...SMALL, rowLimit: 20, maxPageSize: 8 };
    const outcome = await run(fake, "get /app/ --prefix", harness({ bounds }));
    expect(sent(fake).map((call) => (call[1] as EtcdRangeRequest).limit)).toEqual([2, 4, 8, 7]);
    expect(outcome).toMatchObject({
      kvs: keys(30).slice(0, 20),
      stopped: { by: "rows", beforeKey: enc("/app/k20") },
    });
  });

  test("--count-only with --rev counts at that revision", async () => {
    const fake = createFakeEtcdClient({ range: store(keys(12)) });
    const outcome = await run(fake, "get /app/ --prefix --count-only --rev=42");
    expect(sent(fake)).toEqual([
      ["range", { ...APP, limit: 1, revision: "42", keysOnly: false, countOnly: true, serializable: false }],
    ]);
    expect(outcome).toMatchObject({ count: "12", countOnly: true, header: header("57") });
  });
});

describe("--command-timeout (spec 5.1.2)", () => {
  /** A read that settles only when its signal aborts, rejecting as the adapter does: grpc-js's CANCELLED, read by its signal. */
  const hanging = async (_request: EtcdRangeRequest, options: EtcdCallOptions): Promise<EtcdRangeResponse> =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const cancelled = Object.assign(new Error("1 CANCELLED: Cancelled on client"), {
          code: 1,
          details: "Cancelled on client",
        });
        reject(toEtcdError(cancelled, options.signal));
      });
    });

  test("is the deadline of the command's calls, set on the injected clock, and named when it ends a read", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ range: hanging });
    const pending = run(fake, "get /app/ --prefix --command-timeout=5s", h);
    await Promise.resolve();
    expect(h.timers.map((timer) => timer.ms)).toEqual([5_000]);
    expect(signalOf(fake, 0)).not.toBe(h.context.signal);
    h.timers[0].fn();
    const error = await failure(pending);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("The get reached its deadline of 5,000 ms. (Cancelled on client)");
    expect(h.timers[0].cancelled).toBe(true);
  });

  test("still lets the caller's cancelQuery through, as a cancellation", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ range: hanging });
    const pending = run(fake, "get /app/ --prefix --command-timeout=5s", h);
    await Promise.resolve();
    h.controller.abort();
    expect(await failure(pending)).toBeInstanceOf(QueryCancelledError);
  });

  test("a deadline that passed before a write is sent sends nothing, and says so as a read's deadline", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => {
        h.timers[0].fn();
        return rangeAnswer([]);
      },
    });
    const error = await failure(run(fake, "put /app/cfg v --command-timeout=5s", h));
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toContain("The put reached its deadline of 5,000 ms.");
    expect(sent(fake).map(([method]) => method)).toEqual(["range"]);
    expect(h.sent.writes).toBe(0);
  });

  test("without it every call carries the caller's own signal, and no timer is set", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ range: store(keys(1)) });
    await run(fake, "get /app/k00", h);
    expect(signalOf(fake, 0)).toBe(h.context.signal);
    expect(h.timers).toEqual([]);
  });

  test("is released when the command answers before it", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ range: store(keys(1)) });
    await run(fake, "get /app/k00 --command-timeout=5s", h);
    expect(h.timers.map((timer) => [timer.ms, timer.cancelled])).toEqual([[5_000, true]]);
  });

  test("is never set for a command refused before any request", async () => {
    const h = harness();
    const fake = createFakeEtcdClient();
    const error = await failure(run(fake, "put /registry/x v --command-timeout=5s", h));
    expect(error).toBeInstanceOf(QueryError);
    expect(fake.calls).toEqual([]);
    expect(h.timers).toEqual([]);
  });
});

describe("leases (spec 5.1.3)", () => {
  test("lease grant sends its TTL, a write counted once", async () => {
    const h = harness();
    const granted = { header: header("58"), id: LEASE_ID, ttl: "60" };
    const fake = createFakeEtcdClient({ leaseGrant: async () => granted });
    expect(await run(fake, "lease grant 60", h)).toEqual({ kind: "lease-grant", response: granted });
    expect(sent(fake)).toEqual([["leaseGrant", 60]]);
    expect(h.sent.writes).toBe(1);
  });

  test("a lease grant that meets a lost connection after it left says the write may have been applied", async () => {
    const fake = createFakeEtcdClient({
      leaseGrant: async () => {
        throw new EtcdError("unavailable", "Connection dropped", 14);
      },
    });
    const error = await failure(run(fake, "lease grant 60"));
    expect(error.message).toContain(UNKNOWN_OUTCOME);
  });

  test("lease timetolive --keys reads the lease in decimal with its keys", async () => {
    const lease = {
      header: header("57"),
      id: LEASE_ID,
      ttl: "600",
      grantedTtl: "3600",
      keys: [enc("/leases/session-1")],
    };
    const fake = createFakeEtcdClient({ leaseTimeToLive: async () => lease });
    expect(await run(fake, `lease timetolive ${LEASE_HEX} --keys`)).toEqual({
      kind: "lease-timetolive",
      response: lease,
      keys: true,
    });
    expect(sent(fake)).toEqual([["leaseTimeToLive", LEASE_ID, true]]);
  });

  test("lease timetolive of a lease etcd does not hold, a TTL of -1, is lease not found", async () => {
    const fake = createFakeEtcdClient({
      leaseTimeToLive: async () => ({ header: header("57"), id: LEASE_ID, ttl: "-1", grantedTtl: "0", keys: [] }),
    });
    const error = await failure(run(fake, `lease timetolive ${LEASE_HEX}`));
    expect(error.message).toBe(`etcd answered the lease timetolive: lease ${LEASE_HEX} not found or expired.`);
    expect(sent(fake)).toEqual([["leaseTimeToLive", LEASE_ID, false]]);
  });

  test("lease timetolive without --keys reads the lease alone, and the answer says so", async () => {
    const lease = { header: header("57"), id: LEASE_ID, ttl: "600", grantedTtl: "3600", keys: [] };
    const fake = createFakeEtcdClient({ leaseTimeToLive: async () => lease });
    expect(await run(fake, `lease timetolive ${LEASE_HEX}`)).toEqual({
      kind: "lease-timetolive",
      response: lease,
      keys: false,
    });
    expect(sent(fake)).toEqual([["leaseTimeToLive", LEASE_ID, false]]);
  });

  test("lease list answers the ids", async () => {
    const fake = createFakeEtcdClient({ leaseLeases: async () => ({ header: header("57"), ids: [LEASE_ID] }) });
    expect(await run(fake, "lease list")).toEqual({ kind: "lease-list", ids: [LEASE_ID] });
  });

  test("lease keep-alive --once is one exchange, a write, and a TTL of 0 is lease not found", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ leaseKeepAliveOnce: async () => ({ id: LEASE_ID, ttl: "60" }) });
    expect(await run(fake, `lease keep-alive --once ${LEASE_HEX}`, h)).toEqual({
      kind: "lease-keep-alive-once",
      response: { id: LEASE_ID, ttl: "60" },
    });
    expect(sent(fake)).toEqual([["leaseKeepAliveOnce", LEASE_ID]]);
    expect(h.sent.writes).toBe(1);
    const expired = createFakeEtcdClient({ leaseKeepAliveOnce: async () => ({ id: LEASE_ID, ttl: "0" }) });
    const error = await failure(run(expired, `lease keep-alive --once ${LEASE_HEX}`));
    expect(error.message).toBe(`etcd answered the lease keep-alive: lease ${LEASE_HEX} not found or expired.`);
  });

  test("a lease id that is not hexadecimal, from a caller that built the command itself, is refused before any request", async () => {
    const fake = createFakeEtcdClient();
    const h = harness();
    const parsed: ParsedCommand = { command: { kind: "lease-revoke", leaseHex: "not-hex" }, line: 1 };
    const error = await failure(executeCommand(fake, parsed, h.context));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe("The lease id is not hexadecimal: write it as lease list prints it.");
    expect(fake.calls).toEqual([]);
  });
});

describe("the cluster and auth reads (spec 5.1.3)", () => {
  test("member list is linearizable by default and serializable with --consistency=s", async () => {
    const members = [{ id: "10276657743932975437", name: "etcd-1", peerUrls: [], clientUrls: [], isLearner: false }];
    const fake = createFakeEtcdClient({ memberList: async () => ({ header: header("57"), members }) });
    expect(await run(fake, "member list")).toEqual({ kind: "member-list", members });
    await run(fake, "member list --consistency=s");
    expect(sent(fake)).toEqual([
      ["memberList", { linearizable: true }],
      ["memberList", { linearizable: false }],
    ]);
  });

  test("endpoint status answers for the configured endpoint", async () => {
    const status = {
      header: header("57"),
      version: "3.7.2",
      dbSize: "20480",
      dbSizeInUse: "16384",
      dbSizeQuota: "2147483648",
      leader: "10276657743932975437",
      raftIndex: "90",
      raftTerm: "2",
      raftAppliedIndex: "90",
      errors: [],
      isLearner: false,
      storageVersion: "3.7.0",
    };
    const fake = createFakeEtcdClient({ status: async () => status });
    expect(await run(fake, "endpoint status")).toEqual({ kind: "endpoint-status", endpoint: "etcd.test:2379", status });
  });

  test("alarm list, auth status, user list, role list and role get are each their one call", async () => {
    const permissions = [{ type: "read" as const, key: enc("/app/"), rangeEnd: enc("/app0") }];
    const fake = createFakeEtcdClient({
      alarmList: async () => [{ memberId: "10276657743932975437", alarm: "nospace" }],
      authStatus: async () => ({ enabled: true, authRevision: "9" }),
      userList: async () => ["reader", "root"],
      roleList: async () => ["reader", "root"],
      roleGet: async () => permissions,
    });
    expect(await run(fake, "alarm list")).toEqual({
      kind: "alarm-list",
      alarms: [{ memberId: "10276657743932975437", alarm: "nospace" }],
    });
    expect(await run(fake, "auth status")).toEqual({
      kind: "auth-status",
      status: { enabled: true, authRevision: "9" },
    });
    expect(await run(fake, "user list")).toEqual({ kind: "user-list", names: ["reader", "root"] });
    expect(await run(fake, "role list")).toEqual({ kind: "role-list", names: ["reader", "root"] });
    expect(await run(fake, "role get reader")).toEqual({ kind: "role-get", name: "reader", permissions });
    expect(sent(fake)).toEqual([["alarmList"], ["authStatus"], ["userList"], ["roleList"], ["roleGet", "reader"]]);
  });

  test("user get answers the roles, and with --detail each role's permissions in the user's order", async () => {
    const read = { type: "read" as const, key: enc("/app/"), rangeEnd: enc("/app0") };
    const write = { type: "readwrite" as const, key: enc("/config/a") };
    const fake = createFakeEtcdClient({
      userGet: async () => ["reader", "writer"],
      roleGet: async (name: string) => (name === "reader" ? [read] : [write]),
    });
    expect(await run(fake, "user get reader")).toEqual({
      kind: "user-get",
      name: "reader",
      roles: ["reader", "writer"],
    });
    expect(await run(fake, "user get reader --detail")).toEqual({
      kind: "user-get",
      name: "reader",
      roles: ["reader", "writer"],
      permissions: [
        { role: "reader", permission: read },
        { role: "writer", permission: write },
      ],
    });
    expect(sent(fake)).toEqual([
      ["userGet", "reader"],
      ["userGet", "reader"],
      ["roleGet", "reader"],
      ["roleGet", "writer"],
    ]);
  });

  test("a read that fails is a read's failure, in the command's own words", async () => {
    const fake = createFakeEtcdClient({
      alarmList: async () => {
        throw new EtcdError("unavailable", "etcdserver: leader changed", 14);
      },
    });
    const error = await failure(run(fake, "alarm list"));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe("etcd did not answer the alarm list. (etcd: leader changed)");
  });
});

describe("a list etcd answers whole holds at most the row limit (spec 5.4, E14)", () => {
  // SMALL holds 5 rows, and each list below answers one entry more. Only the receive cap held these
  // answers before: on etcd v3.7.2, lease timetolive --keys of a lease holding 600 keys answered 600 rows.
  const OVER = SMALL.rowLimit + 1;
  const names = Array.from({ length: OVER }, (_unused, index) => `name-${index}`);
  const ids = Array.from({ length: OVER }, (_unused, index) => String(index + 1));
  const leaseKeys = Array.from({ length: OVER }, (_unused, index) => enc(`/leases/session-${index}`));
  const permissions = Array.from({ length: OVER }, (_unused, index) => ({
    type: "read" as const,
    key: enc(`/app/${index}`),
  }));

  test("lease timetolive --keys and lease list hold the first rows, and say how many etcd answered", async () => {
    const h = harness({ bounds: SMALL });
    const lease = { header: header("57"), id: LEASE_ID, ttl: "600", grantedTtl: "3600", keys: leaseKeys };
    const fake = createFakeEtcdClient({
      leaseTimeToLive: async () => lease,
      leaseLeases: async () => ({ header: header("57"), ids }),
    });
    expect(await run(fake, `lease timetolive ${LEASE_HEX} --keys`, h)).toEqual({
      kind: "lease-timetolive",
      response: { ...lease, keys: leaseKeys.slice(0, 5) },
      keys: true,
      answered: OVER,
    });
    expect(await run(fake, "lease list", h)).toEqual({ kind: "lease-list", ids: ids.slice(0, 5), answered: OVER });
  });

  test("user list, role list, user get --detail and role get hold the same bound", async () => {
    const h = harness({ bounds: SMALL });
    const fake = createFakeEtcdClient({
      userList: async () => names,
      roleList: async () => names,
      userGet: async () => ["reader", "writer"],
      roleGet: async (name: string) =>
        name === "reader" ? permissions.slice(0, 4) : name === "writer" ? permissions.slice(4) : permissions,
    });
    expect(await run(fake, "user list", h)).toEqual({ kind: "user-list", names: names.slice(0, 5), answered: OVER });
    expect(await run(fake, "role list", h)).toEqual({ kind: "role-list", names: names.slice(0, 5), answered: OVER });
    // The permissions of every role count together, in the user's order of roles.
    expect(await run(fake, "user get alice --detail", h)).toEqual({
      kind: "user-get",
      name: "alice",
      roles: ["reader", "writer"],
      permissions: [
        ...permissions.slice(0, 4).map((permission) => ({ role: "reader", permission })),
        { role: "writer", permission: permissions[4] },
      ],
      answered: OVER,
    });
    expect(await run(fake, "role get admin", h)).toEqual({
      kind: "role-get",
      name: "admin",
      permissions: permissions.slice(0, 5),
      answered: OVER,
    });
  });

  test("a list that ends at the row limit exactly is answered whole, and says nothing was cut", async () => {
    const h = harness({ bounds: SMALL });
    const fake = createFakeEtcdClient({
      leaseLeases: async () => ({ header: header("57"), ids: ids.slice(0, 5) }),
      userList: async () => names.slice(0, 5),
    });
    const leases = await run(fake, "lease list", h);
    expect(leases).toEqual({ kind: "lease-list", ids: ids.slice(0, 5) });
    expect(leases).not.toHaveProperty("answered");
    expect(await run(fake, "user list", h)).not.toHaveProperty("answered");
  });
});

describe("endpoint health, etcdctl's probe (spec 5.1.3)", () => {
  const probe = { key: enc("health"), limit: 1, keysOnly: true };

  test("a healthy member: one keys-only Range of health, then the alarms, the read's duration as took, and no Status", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({
      range: async () => {
        h.clock.now += 12;
        return rangeAnswer([]);
      },
      alarmList: async () => {
        h.clock.now += 30;
        return [];
      },
    });
    expect(await run(fake, "endpoint health", h)).toEqual({
      kind: "endpoint-health",
      endpoint: "etcd.test:2379",
      healthy: true,
      tookMs: 12,
    });
    expect(sent(fake)).toEqual([["range", probe], ["alarmList"]]);
  });

  test("PermissionDenied on the read counts as healthy, after one alarm read", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw denied();
      },
      alarmList: async () => [],
    });
    expect(await run(fake, "endpoint health")).toMatchObject({ healthy: true });
    expect(sent(fake).map(([method]) => method)).toEqual(["range", "alarmList"]);
  });

  test("an alarm on any member is unhealthy, named in etcdctl's words", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      alarmList: async () => [
        { memberId: "9372538179322589801", alarm: "nospace" },
        { memberId: "10276657743932975437", alarm: "corrupt" },
      ],
    });
    expect(await run(fake, "endpoint health")).toMatchObject({
      healthy: false,
      error: "Active Alarm(s): NOSPACE CORRUPT",
    });
  });

  test("an alarm type etcdctl does not name is UNKNOWN", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      alarmList: async () => [{ memberId: "1", alarm: "none" as unknown as "nospace" }],
    });
    expect(await run(fake, "endpoint health")).toMatchObject({ healthy: false, error: "Active Alarm(s): UNKNOWN" });
  });

  test("a failed alarm read is unhealthy, in etcdctl's words", async () => {
    const fake = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      alarmList: async () => {
        throw new EtcdError("no-leader", "etcdserver: no leader", 14);
      },
    });
    expect(await run(fake, "endpoint health")).toMatchObject({
      healthy: false,
      error: "Unable to fetch the alarm list",
    });
  });

  test("no leader on the read is unhealthy with that error, and no alarm read follows", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw new EtcdError("no-leader", "etcdserver: no leader", 14);
      },
    });
    const outcome = await run(fake, "endpoint health");
    expect(outcome).toMatchObject({ kind: "endpoint-health", healthy: false });
    expect((outcome as { error: string }).error).toContain("(etcd: no leader)");
    expect(sent(fake).map(([method]) => method)).toEqual(["range"]);
  });

  test("the caller's own cancel is still a cancellation, on the read and on the alarm read", async () => {
    const cancelled = () => new EtcdError("cancelled", "Cancelled on client", 1);
    const onRead = createFakeEtcdClient({
      range: async () => {
        throw cancelled();
      },
    });
    expect(await failure(run(onRead, "endpoint health"))).toBeInstanceOf(QueryCancelledError);
    const onAlarms = createFakeEtcdClient({
      range: async () => rangeAnswer([]),
      alarmList: async () => {
        throw cancelled();
      },
    });
    expect(await failure(run(onAlarms, "endpoint health"))).toBeInstanceOf(QueryCancelledError);
  });

  test("a failure that is not etcd's is raised as itself", async () => {
    const fake = createFakeEtcdClient({
      range: async () => {
        throw new TypeError("a defect in the adapter");
      },
    });
    const error = await failure(run(fake, "endpoint health"));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("a defect in the adapter");
  });

  test("every unhealthy row names the configured endpoint and the read's duration alone", async () => {
    const h = harness();
    const timed = (overrides: Partial<EtcdClient>): FakeEtcdClient =>
      createFakeEtcdClient({
        range: async () => {
          h.clock.now += 7;
          return rangeAnswer([]);
        },
        ...overrides,
      });
    const row = { kind: "endpoint-health" as const, endpoint: "etcd.test:2379", healthy: false, tookMs: 7 };
    const alarmed = timed({ alarmList: async () => [{ memberId: "1", alarm: "nospace" }] });
    expect(await run(alarmed, "endpoint health", h)).toEqual({ ...row, error: "Active Alarm(s): NOSPACE" });
    const unlisted = timed({
      alarmList: async () => {
        throw new EtcdError("no-leader", "etcdserver: no leader", 14);
      },
    });
    expect(await run(unlisted, "endpoint health", h)).toEqual({ ...row, error: "Unable to fetch the alarm list" });
    const leaderless = timed({
      range: async () => {
        h.clock.now += 7;
        throw new EtcdError("no-leader", "etcdserver: no leader", 14);
      },
    });
    expect(await run(leaderless, "endpoint health", h)).toEqual({
      ...row,
      error:
        "The etcd member this connection reaches has no leader: the cluster has lost quorum, so nothing was applied. Bring the stopped members back, then run the command again. (etcd: no leader)",
    });
  });
});

describe("watch, through execute (spec 5.3, KE5)", () => {
  /** An adapter watch that stays open until its signal aborts. */
  const open: EtcdClient["watch"] = (_request, _onBatch, options) =>
    new Promise<EtcdWatchEnd>((resolve) => {
      options.signal.addEventListener("abort", () => resolve({ reason: "aborted" }), { once: true });
    });

  test("the default window is 5 seconds, the request carries the range, and the call's deadline stays the query timeout", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ watch: open });
    const pending = run(fake, "watch /app/ --prefix", h);
    await Promise.resolve();
    expect(sent(fake)).toEqual([["watch", { ...APP, prevKv: false }]]);
    expect(h.timers.map((timer) => timer.ms)).toEqual([5_000]);
    h.timers[0].fn();
    expect(await pending).toEqual({
      kind: "watch",
      outcome: { events: [], endedBy: "window", rangeLabel: describeRange(APP), windowMs: 5_000 },
    });
  });

  test("a query timeout that leaves less than 5 seconds after the margin caps the window, and the outcome says by what", async () => {
    const h = harness({ bounds: { ...BOUNDS, queryTimeoutMs: 5_000 } });
    const fake = createFakeEtcdClient({ watch: open });
    const pending = run(fake, "watch /app/ --prefix", h);
    await Promise.resolve();
    expect(h.timers.map((timer) => timer.ms)).toEqual([4_000]);
    h.timers[0].fn();
    expect(await pending).toMatchObject({ outcome: { windowMs: 4_000, capped: { queryTimeoutMs: 5_000 } } });
  });

  test("--command-timeout is the window and sets no deadline; --rev and --prev-kv travel on the request", async () => {
    const h = harness({ bounds: { ...BOUNDS, queryTimeoutMs: 5_000 } });
    const fake = createFakeEtcdClient({ watch: open });
    const pending = executeCommand(
      fake,
      parse("watch /app/ --prefix --command-timeout=2s --rev=42 --prev-kv"),
      h.context,
    );
    await Promise.resolve();
    expect(sent(fake)).toEqual([["watch", { ...APP, startRevision: "42", prevKv: true }]]);
    expect(h.timers.map((timer) => timer.ms)).toEqual([2_000]);
    h.timers[0].fn();
    const outcome = await pending;
    expect(outcome).toMatchObject({ outcome: { windowMs: 2_000 } });
    expect((outcome as { outcome: object }).outcome).not.toHaveProperty("capped");
  });

  /** An adapter watch that hands one batch at once, then stays open until its signal aborts. */
  const burst =
    (events: EtcdWatchEvent[]): EtcdClient["watch"] =>
    (_request, onBatch, options) =>
      new Promise<EtcdWatchEnd>((resolve) => {
        if (onBatch({ header: header("88"), events }) === "stop") return resolve({ reason: "stopped" });
        options.signal.addEventListener("abort", () => resolve({ reason: "aborted" }), { once: true });
      });
  const event = (key: string, value: string): EtcdWatchEvent => ({ type: "put", kv: kv(key, value, "81") });

  test("the watch stops at the connection's row limit and byte budget", async () => {
    const h = harness({ bounds: SMALL });
    const many = keys(6).map((entry) => ({ type: "put" as const, kv: entry }));
    const rows = executeCommand(
      createFakeEtcdClient({ watch: burst(many) }),
      parse("watch /app/ --prefix", SMALL),
      h.context,
    );
    h.timers[0].fn();
    expect(await rows).toMatchObject({ outcome: { events: many.slice(0, 5), endedBy: "rows" } });
    const large = ["/app/k00", "/app/k01", "/app/k02"].map((key) => event(key, "x".repeat(400)));
    const g = harness({ bounds: SMALL });
    const bytes = executeCommand(
      createFakeEtcdClient({ watch: burst(large) }),
      parse("watch /app/ --prefix", SMALL),
      g.context,
    );
    g.timers[0].fn();
    expect(await bytes).toMatchObject({ outcome: { events: large.slice(0, 2), endedBy: "bytes" } });
  });

  test("a watch etcd cancels for permission names what the user may read", async () => {
    const h = harness({ readable: { user: "reader", ranges: "/app/ (prefix)" } });
    const fake = createFakeEtcdClient({
      watch: async () => ({
        reason: "canceled",
        cancelReason: "rpc error: code = PermissionDenied desc = etcdserver: permission denied",
      }),
    });
    const error = await failure(executeCommand(fake, parse("watch /registry/ --prefix"), h.context));
    expect(error.message).toContain("etcd user reader may read: /app/ (prefix).");
  });

  test("KE5: a query timeout at or below the margin leaves no window, and the watch is refused with no request", async () => {
    const h = harness({ bounds: { ...BOUNDS, queryTimeoutMs: 1_000 } });
    const fake = createFakeEtcdClient({ watch: open });
    const error = await failure(executeCommand(fake, parse("watch /app/ --prefix"), h.context));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "This connection's query timeout of 1 s leaves a watch no window, because a watch keeps its last 1 s to return its events: raise Query Timeout in the connection's settings to watch.",
    );
    expect(fake.calls).toEqual([]);
  });

  test("a typed window above the cap is refused as the parser refuses it, whatever limits the text was parsed with", async () => {
    const h = harness({ bounds: { ...BOUNDS, queryTimeoutMs: 5_000 } });
    const fake = createFakeEtcdClient({ watch: open });
    const error = await failure(
      executeCommand(fake, parse("watch /app/ --prefix --command-timeout=4500ms"), h.context),
    );
    expect(error.message).toBe(
      "The watch window of 4,500 ms that --command-timeout sets is above 4 s, this connection's query timeout less the 1 s a watch keeps to return its events: lower it, or raise Query Timeout in the connection's settings.",
    );
    expect(fake.calls).toEqual([]);
  });

  test("a typed window equal to the cap is the window", async () => {
    const h = harness({ bounds: { ...BOUNDS, queryTimeoutMs: 5_000 } });
    const fake = createFakeEtcdClient({ watch: open });
    const pending = executeCommand(fake, parse("watch /app/ --prefix --command-timeout=4s"), h.context);
    await Promise.resolve();
    expect(h.timers.map((timer) => timer.ms)).toEqual([4_000]);
    h.timers[0].fn();
    expect(await pending).toMatchObject({ outcome: { windowMs: 4_000 } });
  });

  test("a query timeout that leaves exactly 5 seconds after the margin does not shorten the window, so it is not capped", async () => {
    const h = harness({ bounds: { ...BOUNDS, queryTimeoutMs: 6_000 } });
    const fake = createFakeEtcdClient({ watch: open });
    const pending = run(fake, "watch /app/ --prefix", h);
    await Promise.resolve();
    expect(h.timers.map((timer) => timer.ms)).toEqual([5_000]);
    h.timers[0].fn();
    const outcome = await pending;
    expect(outcome).toMatchObject({ outcome: { windowMs: 5_000 } });
    expect((outcome as { outcome: object }).outcome).not.toHaveProperty("capped");
  });

  test("a watch of one key or of a range end watches exactly that", async () => {
    const h = harness();
    const fake = createFakeEtcdClient({ watch: open });
    const one = run(fake, "watch /app/cfg", h);
    const ranged = run(fake, "watch /app/a /app/z", h);
    await Promise.resolve();
    expect(sent(fake)).toEqual([
      ["watch", { key: enc("/app/cfg"), prevKv: false }],
      ["watch", { key: enc("/app/a"), rangeEnd: enc("/app/z"), prevKv: false }],
    ]);
    for (const timer of h.timers) timer.fn();
    expect(await one).toMatchObject({ outcome: { rangeLabel: describeRange({ key: enc("/app/cfg") }) } });
    expect(await ranged).toMatchObject({
      outcome: { rangeLabel: describeRange({ key: enc("/app/a"), rangeEnd: enc("/app/z") }) },
    });
  });

  test("the window runs on the injected clock: a batch that arrives once it has run out is not held", async () => {
    const h = harness();
    const stream: { push?: (batch: EtcdWatchBatch) => void } = {};
    const fake = createFakeEtcdClient({
      watch: (_request, onBatch, options) =>
        new Promise<EtcdWatchEnd>((resolve) => {
          stream.push = (batch) => {
            if (onBatch(batch) === "stop") resolve({ reason: "stopped" });
          };
          options.signal.addEventListener("abort", () => resolve({ reason: "aborted" }), { once: true });
        }),
    });
    const pending = run(fake, "watch /app/ --prefix", h);
    await Promise.resolve();
    h.clock.now += 5_000;
    stream.push?.({ header: header("88"), events: [event("/app/k00", "late")] });
    expect(await pending).toEqual({
      kind: "watch",
      outcome: { events: [], endedBy: "window", rangeLabel: describeRange(APP), windowMs: 5_000 },
    });
  });

  test("the caller's query timeout and cancelQuery reach the watch, as a deadline and as a cancellation", async () => {
    const timed = harness();
    const deadline = run(createFakeEtcdClient({ watch: open }), "watch /app/ --prefix", timed);
    await Promise.resolve();
    timed.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const expired = await failure(deadline);
    expect(expired).toBeInstanceOf(TimeoutError);
    expect(expired.message).toBe("The watch reached its deadline of 60,000 ms. (The operation timed out.)");
    const cancelled = harness();
    const stopped = run(createFakeEtcdClient({ watch: open }), "watch /app/ --prefix", cancelled);
    await Promise.resolve();
    cancelled.controller.abort();
    expect(await failure(stopped)).toBeInstanceOf(QueryCancelledError);
  });
});

describe("a read never counts as a sent write, so cancelQuery still answers true while it runs (spec 5.5)", () => {
  /** An adapter watch that stays open until its signal aborts, as the end of the window aborts it. */
  const untilAborted: EtcdClient["watch"] = (_request, _onBatch, options) =>
    new Promise<EtcdWatchEnd>((resolve) => {
      options.signal.addEventListener("abort", () => resolve({ reason: "aborted" }), { once: true });
    });
  const lease = { header: header("57"), id: LEASE_ID, ttl: "600", grantedTtl: "3600", keys: [] };
  const status = {
    header: header("57"),
    version: "3.7.2",
    dbSize: "20480",
    dbSizeInUse: "16384",
    dbSizeQuota: "2147483648",
    leader: "10276657743932975437",
    raftIndex: "90",
    raftTerm: "2",
    raftAppliedIndex: "90",
    errors: [],
    isLearner: false,
    storageVersion: "3.7.0",
  };
  /** Each read, the stubs it needs and the calls it makes, run under SMALL, so the get reads more than one page. */
  const reads: ReadonlyArray<readonly [string, Partial<EtcdClient>, string[]]> = [
    ["get /app/ --prefix", { range: store(keys(12)) }, ["range", "range"]],
    ["get /app/ --prefix --count-only", { range: store(keys(12)) }, ["range"]],
    ["endpoint health", { range: async () => rangeAnswer([]), alarmList: async () => [] }, ["range", "alarmList"]],
    ["watch /app/ --prefix", { watch: untilAborted }, ["watch"]],
    [`lease timetolive ${LEASE_HEX}`, { leaseTimeToLive: async () => lease }, ["leaseTimeToLive"]],
    ["lease list", { leaseLeases: async () => ({ header: header("57"), ids: [LEASE_ID] }) }, ["leaseLeases"]],
    ["member list", { memberList: async () => ({ header: header("57"), members: [] }) }, ["memberList"]],
    ["endpoint status", { status: async () => status }, ["status"]],
    ["alarm list", { alarmList: async () => [] }, ["alarmList"]],
    ["auth status", { authStatus: async () => ({ enabled: true, authRevision: "9" }) }, ["authStatus"]],
    ["user list", { userList: async () => ["reader"] }, ["userList"]],
    ["user get reader --detail", { userGet: async () => ["reader"], roleGet: async () => [] }, ["userGet", "roleGet"]],
    ["role list", { roleList: async () => ["reader"] }, ["roleList"]],
    ["role get reader", { roleGet: async () => [] }, ["roleGet"]],
  ];
  for (const [text, stubs, methods] of reads) {
    test(`${JSON.stringify(text)} answers with no write counted`, async () => {
      const h = harness({ bounds: SMALL });
      const fake = createFakeEtcdClient(stubs);
      const pending = run(fake, text, h);
      await Promise.resolve();
      // The watch's window closes when its timer fires; no other read here sets a timer.
      for (const timer of h.timers) timer.fn();
      await pending;
      expect(sent(fake).map(([method]) => method)).toEqual(methods);
      expect(h.sent.writes).toBe(0);
    });
  }
});

describe("every error this module words is a QueryError tagged etcd (src/lib/db/errors.ts)", () => {
  const providerOf = (error: Error): unknown => (error as { provider?: unknown }).provider;
  const compacted = (): EtcdError =>
    new EtcdError("compacted", "etcdserver: mvcc: required revision has been compacted", 11);
  const pinned = store(keys(12));
  const cases: ReadonlyArray<readonly [string, () => Promise<CommandOutcome>]> = [
    ["a policy refusal", () => run(createFakeEtcdClient(), "put /registry/x v")],
    [
      "a lease id that is not hexadecimal",
      () =>
        executeCommand(
          createFakeEtcdClient(),
          { command: { kind: "lease-revoke", leaseHex: "not-hex" }, line: 1 },
          harness().context,
        ),
    ],
    [
      "a guarded write whose compare failed",
      () =>
        run(
          createFakeEtcdClient({
            range: async () => rangeAnswer([kv("/app/cfg", "old", "41")]),
            txn: async () => txnAnswer(false, [{ op: "range", response: rangeAnswer([kv("/app/cfg", "new", "44")]) }]),
          }),
          "put /app/cfg v",
        ),
    ],
    [
      "a compaction between the pages of a read",
      () =>
        run(
          createFakeEtcdClient({
            range: async (request: EtcdRangeRequest) => {
              if (request.revision === undefined) return pinned(request);
              throw compacted();
            },
          }),
          "get /app/ --prefix",
          harness({ bounds: SMALL }),
        ),
    ],
    [
      "a page with no keys and more to follow",
      () => run(createFakeEtcdClient({ range: async () => rangeAnswer([], true) }), "get /app/ --prefix"),
    ],
    [
      "a query timeout that leaves a watch no window",
      () =>
        run(createFakeEtcdClient(), "watch /app/ --prefix", harness({ bounds: { ...BOUNDS, queryTimeoutMs: 1_000 } })),
    ],
    [
      "a typed watch window above the cap",
      () =>
        executeCommand(
          createFakeEtcdClient(),
          parse("watch /app/ --prefix --command-timeout=4500ms"),
          harness({ bounds: { ...BOUNDS, queryTimeoutMs: 5_000 } }).context,
        ),
    ],
  ];
  for (const [name, attempt] of cases) {
    test(name, async () => {
      const error = await failure(attempt());
      expect(error).toBeInstanceOf(QueryError);
      expect(providerOf(error)).toBe("etcd");
    });
  }
});
