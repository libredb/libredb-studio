/**
 * Every result shape of spec 5.2 over the outcomes execute.ts and watch.ts produce, the warnings of
 * 5.3 and 5.4, and E9's classifier on every value-bearing field: a put's and a delete's previous
 * pair, a watch event's previous value and a txn's answers each hold a withheld class here, driven
 * through fake answers because E8 refuses those writes before they are sent (spec E9).
 */
import { describe, expect, test } from "bun:test";
import type {
  EtcdBytes,
  EtcdKeyValue,
  EtcdPermission,
  EtcdResponseHeader,
  EtcdStatus,
  EtcdTxnRequest,
} from "@/lib/db/providers/keyvalue/etcd/client";
import { type CommandOutcome, commandResult, type WatchOutcome } from "@/lib/db/providers/keyvalue/etcd/results";

const utf8 = (text: string): EtcdBytes => new TextEncoder().encode(text);
const bytes = (...parts: ReadonlyArray<string | readonly number[]>): EtcdBytes =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? Array.from(utf8(part)) : Array.from(part))));
const SECRET = "libredb-fixture-secret";
/** An envelope whose TypeMeta reads (v1, Pod) and whose raw object carries the secret marker. */
const ENVELOPE = bytes(
  [0x6b, 0x38, 0x73, 0x00, 0x0a, 0x09, 0x0a, 0x02],
  "v1",
  [0x12, 0x03],
  "Pod",
  [0x12, SECRET.length],
  SECRET,
);
const ENCRYPTED = bytes("k8s:enc:aescbc:v1:key1:", SECRET);
const CONTEXT = { executionTime: 7, cellLimit: 65_536 };
const MEMBER = "10276657743932975437"; // 8e9e05c52164694d
const LEASE = "7587863092875085000"; // 694d8147df1dc4c8

const header = (revision = "42"): EtcdResponseHeader => ({
  clusterId: "14841639068965178418",
  memberId: MEMBER,
  revision,
  raftTerm: "2",
});
const pair = (key: EtcdBytes | string, value: EtcdBytes | string, over: Partial<EtcdKeyValue> = {}): EtcdKeyValue => ({
  key: typeof key === "string" ? utf8(key) : key,
  value: typeof value === "string" ? utf8(value) : value,
  createRevision: "10",
  modRevision: "12",
  version: "3",
  lease: "0",
  ...over,
});
const result = (outcome: CommandOutcome, cellLimit = CONTEXT.cellLimit) =>
  commandResult(outcome, { ...CONTEXT, cellLimit });
const getOutcome = (over: Partial<Extract<CommandOutcome, { kind: "get" }>> = {}): CommandOutcome => ({
  kind: "get",
  kvs: [],
  keysOnly: false,
  countOnly: false,
  more: false,
  header: header(),
  ...over,
});

describe("get (spec 5.2)", () => {
  test("one row per key with the fixed fields; revisions stay decimal strings and a lease is its hex id or null", () => {
    const answer = result(
      getOutcome({
        kvs: [
          pair("/apisix/routes/1", '{"uri":"/*"}'),
          pair("/service/batman/leader", "postgresql0", { lease: LEASE }),
        ],
      }),
    );
    expect(answer).toEqual({
      fields: ["key", "value", "value_encoding", "create_revision", "mod_revision", "version", "lease"],
      rows: [
        {
          key: "/apisix/routes/1",
          value: '{"uri":"/*"}',
          value_encoding: "json",
          create_revision: "10",
          mod_revision: "12",
          version: "3",
          lease: null,
        },
        {
          key: "/service/batman/leader",
          value: "postgresql0",
          value_encoding: "text",
          create_revision: "10",
          mod_revision: "12",
          version: "3",
          lease: "694d8147df1dc4c8",
        },
      ],
      rowCount: 2,
      executionTime: 7,
    });
  });

  test("--keys-only leaves value and value_encoding empty", () => {
    const [row] = result(getOutcome({ keysOnly: true, kvs: [pair("/a", "")] })).rows;
    expect(row).toMatchObject({ key: "/a", value: "", value_encoding: "" });
  });

  test("--count-only answers one row with count", () => {
    expect(result(getOutcome({ countOnly: true, count: "1234" }))).toMatchObject({
      fields: ["count"],
      rows: [{ count: "1234" }],
      rowCount: 1,
    });
    expect(() => result(getOutcome({ countOnly: true }))).toThrow(
      "A --count-only outcome carries the count etcd answered",
    );
  });

  test("a key that is not UTF-8 is base64 in its row, and adds key_encoding to every row of the result", () => {
    const answer = result(getOutcome({ kvs: [pair("/a", "x"), pair(bytes("/", [0xff, 0xfe], "/x"), "y")] }));
    expect(answer.fields).toEqual([
      "key",
      "key_encoding",
      "value",
      "value_encoding",
      "create_revision",
      "mod_revision",
      "version",
      "lease",
    ]);
    expect(answer.rows.map((row) => [row.key, row.key_encoding])).toEqual([
      ["/a", "text"],
      [Buffer.from(bytes("/", [0xff, 0xfe], "/x")).toString("base64"), "base64"],
    ]);
  });

  test("E9: a secret, an envelope and an encrypted value are withheld behind their labels, the metadata kept", () => {
    const token = `{"token":"${SECRET}"}`;
    const answer = result(
      getOutcome({
        kvs: [
          pair("/registry/secrets/default/token", token),
          pair("/registry/pods/default/nginx", ENVELOPE),
          pair("/tenant-a/configmaps/default/cm-encrypted", ENCRYPTED),
        ],
      }),
    );
    expect(answer.rows.map((row) => [row.value, row.value_encoding, row.mod_revision])).toEqual([
      [`Kubernetes secret, ${utf8(token).length} bytes`, "withheld", "12"],
      [`Kubernetes protobuf (v1, Pod), ${ENVELOPE.length} bytes`, "withheld", "12"],
      [`Kubernetes encrypted (aescbc, key1), ${ENCRYPTED.length} bytes`, "withheld", "12"],
    ]);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test("a value past the cell bound is cut, its encoding gains ', cut', and one warning counts the cut cells", () => {
    const answer = result(
      getOutcome({ kvs: [pair("/a", "abcdefgh"), pair("/b", "ab"), pair("/c", '{"k":"vwxyz"}')] }),
      4,
    );
    expect(answer.rows.map((row) => [row.value, row.value_encoding])).toEqual([
      ["abcd", "text, cut"],
      ["ab", "text"],
      ['{"k"', "json, cut"],
    ]);
    expect(answer.warnings).toEqual([
      { message: `2 values passed the cell bound of 4 characters and are shown cut: the encoding says ", cut".` },
    ]);
    expect(result(getOutcome({ kvs: [pair("/a", "abcdefgh")] }), 1).warnings).toEqual([
      { message: `1 value passed the cell bound of 1 character and is shown cut: the encoding says ", cut".` },
    ]);
    expect(result(getOutcome({ kvs: [pair("/a", "x".repeat(65_537))] })).warnings).toEqual([
      { message: `1 value passed the cell bound of 65,536 characters and is shown cut: the encoding says ", cut".` },
    ]);
  });

  test("a read the row limit stopped says so, naming the key it stopped before, and sets wasLimited", () => {
    const answer = result(
      getOutcome({
        kvs: [pair("/a", "1"), pair("/b", "2")],
        more: true,
        stopped: { by: "rows", beforeKey: utf8("/c d") },
      }),
    );
    expect(answer.warnings).toEqual([
      {
        message:
          "The read stopped at 2 rows, the most a result holds, before the key '/c d': narrow the range, or read on from that key.",
      },
    ]);
    expect(answer.pagination).toEqual({ limit: 2, offset: 0, hasMore: false, totalReturned: 2, wasLimited: true });
  });

  test("a read the byte budget stopped says so", () => {
    const answer = result(
      getOutcome({ kvs: [pair("/a", "1")], more: true, stopped: { by: "bytes", beforeKey: bytes("/", [0xff]) } }),
    );
    expect(answer.warnings).toEqual([
      {
        message:
          'The read stopped at its byte budget after 1 row, before the key "/\\xff": narrow the range, read it with --keys-only, or read on from that key.',
      },
    ]);
    expect(answer.pagination?.wasLimited).toBe(true);
  });

  test("more: true without a stop is a --limit cut, with the count etcd holds when it is known (spec 5.4)", () => {
    expect(result(getOutcome({ kvs: [pair("/a", "1"), pair("/b", "2")], more: true, count: "1234" })).warnings).toEqual(
      [{ message: "etcd holds 1,234 keys in this range, and the read's --limit stopped it at 2 keys." }],
    );
    expect(result(getOutcome({ kvs: [pair("/a", "1")], more: true })).warnings).toEqual([
      { message: "etcd holds more keys in this range than the read's --limit let it return (1 key)." },
    ]);
    expect(result(getOutcome({ kvs: [pair("/a", "1")], more: true })).pagination).toBeUndefined();
  });

  test("a read that found nothing answers no row and the same columns", () => {
    expect(result(getOutcome())).toMatchObject({
      rows: [],
      rowCount: 0,
      fields: ["key", "value", "value_encoding", "create_revision", "mod_revision", "version", "lease"],
    });
  });
});

describe("put and del (spec 5.2)", () => {
  test("a put answers one row with its key and the revision it wrote", () => {
    expect(result({ kind: "put", key: utf8("/app/cfg"), response: { header: header("43") } })).toMatchObject({
      fields: ["key", "revision"],
      rows: [{ key: "/app/cfg", revision: "43" }],
    });
  });

  test("a put --prev-kv answers the previous value, E9's classes withheld", () => {
    const shown = result({
      kind: "put",
      key: utf8("/app/cfg"),
      response: { header: header("43"), prevKv: pair("/app/cfg", "old") },
    });
    expect(shown).toMatchObject({
      fields: ["key", "revision", "prev_value", "prev_value_encoding", "prev_mod_revision"],
      rows: [
        { key: "/app/cfg", revision: "43", prev_value: "old", prev_value_encoding: "text", prev_mod_revision: "12" },
      ],
    });
    for (const [key, value, label] of [
      ["/registry/secrets/a/b", "x", "Kubernetes secret, 1 byte"],
      ["/tenant-a/cm", ENVELOPE, `Kubernetes protobuf (v1, Pod), ${ENVELOPE.length} bytes`],
      ["/tenant-a/cm", ENCRYPTED, `Kubernetes encrypted (aescbc, key1), ${ENCRYPTED.length} bytes`],
    ] as const) {
      const answer = result({ kind: "put", key: utf8(key), response: { header: header(), prevKv: pair(key, value) } });
      expect(answer.rows[0]).toMatchObject({ prev_value: label, prev_value_encoding: "withheld" });
      expect(JSON.stringify(answer)).not.toContain(SECRET);
    }
  });

  test("a del answers one row with the count it deleted and the revision, even when it deleted nothing", () => {
    expect(result({ kind: "del", response: { header: header("44"), deleted: "0", prevKvs: [] } })).toMatchObject({
      fields: ["deleted", "revision"],
      rows: [{ deleted: "0", revision: "44" }],
      rowCount: 1,
    });
  });

  test("a single-key del --prev-kv answers the deleted pair's get fields, E9's classes withheld", () => {
    const answer = result({
      kind: "del",
      response: { header: header("44"), deleted: "1", prevKvs: [pair("/tenant-a/cm", ENVELOPE)] },
    });
    expect(answer.fields).toEqual([
      "deleted",
      "revision",
      "key",
      "value",
      "value_encoding",
      "create_revision",
      "mod_revision",
      "version",
      "lease",
    ]);
    expect(answer.rows).toEqual([
      {
        deleted: "1",
        revision: "44",
        key: "/tenant-a/cm",
        value: `Kubernetes protobuf (v1, Pod), ${ENVELOPE.length} bytes`,
        value_encoding: "withheld",
        create_revision: "10",
        mod_revision: "12",
        version: "3",
        lease: null,
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    for (const [key, value, label] of [
      ["/registry/secrets/a/b", "x", "Kubernetes secret, 1 byte"],
      ["/tenant-a/cm-encrypted", ENCRYPTED, `Kubernetes encrypted (aescbc, key1), ${ENCRYPTED.length} bytes`],
    ] as const) {
      const other = result({ kind: "del", response: { header: header(), deleted: "1", prevKvs: [pair(key, value)] } });
      expect(other.rows[0]).toMatchObject({ value: label, value_encoding: "withheld" });
      expect(JSON.stringify(other)).not.toContain(SECRET);
    }
  });
});

describe("txn (spec 5.2, 5.1.4)", () => {
  const request: EtcdTxnRequest = {
    compare: [{ key: utf8("/a"), target: "mod", result: "equal", operand: "5" }],
    success: [
      { op: "range", request: { key: utf8("/r/"), rangeEnd: utf8("/r0"), limit: 50 } },
      { op: "put", request: { key: utf8("/tenant-a/cm"), value: utf8("v"), prevKv: true } },
      { op: "delete", request: { key: utf8("/d") } },
    ],
    failure: [
      { op: "range", request: { key: utf8("/c/"), rangeEnd: utf8("/c0"), limit: 50, countOnly: true } },
      { op: "range", request: { key: utf8("/none"), limit: 1 } },
      { op: "range", request: { key: utf8("/k/"), rangeEnd: utf8("/k0"), limit: 2, keysOnly: true } },
      { op: "delete", request: { key: utf8("/p"), prevKv: true } },
    ],
  };

  test("the succeeded row, then per executed request its index, branch, op and fields, E9 on the put's previous value", () => {
    const answer = result({
      kind: "txn",
      request,
      response: {
        header: header("45"),
        succeeded: true,
        responses: [
          {
            op: "range",
            response: {
              header: header("45"),
              kvs: [pair("/r/1", "one"), pair("/r/2", "two")],
              more: false,
              count: "2",
            },
          },
          { op: "put", response: { header: header("45"), prevKv: pair("/tenant-a/cm", ENVELOPE) } },
          { op: "delete", response: { header: header("45"), deleted: "1", prevKvs: [] } },
        ],
      },
    });
    expect(answer.fields).toEqual([
      "succeeded",
      "revision",
      "index",
      "branch",
      "op",
      "key",
      "value",
      "value_encoding",
      "create_revision",
      "mod_revision",
      "version",
      "lease",
      "count",
      "deleted",
      "prev_value",
      "prev_value_encoding",
      "prev_mod_revision",
    ]);
    const cells = (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
    expect(answer.rows.map(cells)).toEqual([
      { succeeded: true, revision: "45" },
      {
        index: 1,
        branch: "success",
        op: "get",
        key: "/r/1",
        value: "one",
        value_encoding: "text",
        create_revision: "10",
        mod_revision: "12",
        version: "3",
      },
      {
        index: 1,
        branch: "success",
        op: "get",
        key: "/r/2",
        value: "two",
        value_encoding: "text",
        create_revision: "10",
        mod_revision: "12",
        version: "3",
      },
      {
        index: 2,
        branch: "success",
        op: "put",
        key: "/tenant-a/cm",
        prev_value: `Kubernetes protobuf (v1, Pod), ${ENVELOPE.length} bytes`,
        prev_value_encoding: "withheld",
        prev_mod_revision: "12",
      },
      { index: 3, branch: "success", op: "del", deleted: "1" },
    ]);
    expect(answer.warnings).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test("the failure branch: a count, a get that found nothing, keys only, a del's pairs, and the more warning", () => {
    const answer = result({
      kind: "txn",
      request,
      response: {
        header: header("46"),
        succeeded: false,
        responses: [
          { op: "range", response: { header: header("46"), kvs: [], more: false, count: "7" } },
          { op: "range", response: { header: header("46"), kvs: [], more: false, count: "0" } },
          {
            op: "range",
            response: { header: header("46"), kvs: [pair("/k/1", ""), pair("/k/2", "")], more: true, count: "9" },
          },
          { op: "delete", response: { header: header("46"), deleted: "1", prevKvs: [pair("/p", ENCRYPTED)] } },
        ],
      },
    });
    const cells = (row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
    expect(answer.rows.map(cells)).toEqual([
      { succeeded: false, revision: "46" },
      { index: 1, branch: "failure", op: "get", count: "7" },
      { index: 2, branch: "failure", op: "get", count: "0" },
      {
        index: 3,
        branch: "failure",
        op: "get",
        key: "/k/1",
        value: "",
        value_encoding: "",
        create_revision: "10",
        mod_revision: "12",
        version: "3",
      },
      {
        index: 3,
        branch: "failure",
        op: "get",
        key: "/k/2",
        value: "",
        value_encoding: "",
        create_revision: "10",
        mod_revision: "12",
        version: "3",
      },
      {
        index: 4,
        branch: "failure",
        op: "del",
        deleted: "1",
        key: "/p",
        value: `Kubernetes encrypted (aescbc, key1), ${ENCRYPTED.length} bytes`,
        value_encoding: "withheld",
        create_revision: "10",
        mod_revision: "12",
        version: "3",
      },
    ]);
    expect(answer.warnings).toEqual([
      {
        message:
          "Request 3 of the failure list is a get sent with a limit of 2 keys, and etcd holds more keys in its range: narrow the range, or read it with get on its own, which reads page by page.",
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test("a txn that ran an empty branch still answers its succeeded row", () => {
    expect(
      result({
        kind: "txn",
        request: { compare: [], success: [], failure: [] },
        response: { header: header(), succeeded: true, responses: [] },
      }).rows,
    ).toEqual([expect.objectContaining({ succeeded: true, revision: "42" })]);
  });

  test("an answer that does not match the branch that ran is a decoding fault, raised", () => {
    const put = { op: "put", response: { header: header() } } as const;
    expect(() =>
      result({
        kind: "txn",
        request: { compare: [], success: [], failure: [] },
        response: { header: header(), succeeded: true, responses: [put] },
      }),
    ).toThrow("A txn's answer holds one response per request of the branch that ran");
    expect(() =>
      result({
        kind: "txn",
        request: { compare: [], success: [{ op: "delete", request: { key: utf8("/a") } }], failure: [] },
        response: { header: header(), succeeded: true, responses: [put] },
      }),
    ).toThrow("A txn's answer holds its responses in the order of the requests");
  });
});

describe("watch (spec 5.2, 5.3)", () => {
  const watch = (over: Partial<WatchOutcome>): CommandOutcome => ({
    kind: "watch",
    outcome: { events: [], endedBy: "window", rangeLabel: "/apisix/routes/ (prefix)", windowMs: 5_000, ...over },
  });

  test("a quiet window answers no row and its end reason as the one warning", () => {
    expect(result(watch({}))).toMatchObject({
      rows: [],
      rowCount: 0,
      fields: [
        "revision",
        "type",
        "key",
        "value",
        "value_encoding",
        "create_revision",
        "mod_revision",
        "version",
        "lease",
      ],
      warnings: [{ message: "Watched /apisix/routes/ (prefix) for 5 s: no event." }],
    });
    expect(result(watch({})).pagination).toBeUndefined();
  });

  test("one row per event, a DELETE with no value, and previous values with E9's classes withheld", () => {
    const answer = result(
      watch({
        events: [
          {
            type: "put",
            kv: pair("/apisix/routes/1", '{"uri":"/a"}', { modRevision: "50" }),
            prevKv: pair("/apisix/routes/1", ENVELOPE),
          },
          { type: "delete", kv: pair("/apisix/routes/2", "", { modRevision: "51", version: "0" }) },
        ],
      }),
    );
    expect(answer.fields).toEqual([
      "revision",
      "type",
      "key",
      "value",
      "value_encoding",
      "create_revision",
      "mod_revision",
      "version",
      "lease",
      "prev_value",
      "prev_value_encoding",
    ]);
    expect(answer.rows).toEqual([
      {
        revision: "50",
        type: "PUT",
        key: "/apisix/routes/1",
        value: '{"uri":"/a"}',
        value_encoding: "json",
        create_revision: "10",
        mod_revision: "50",
        version: "3",
        lease: null,
        prev_value: `Kubernetes protobuf (v1, Pod), ${ENVELOPE.length} bytes`,
        prev_value_encoding: "withheld",
      },
      {
        revision: "51",
        type: "DELETE",
        key: "/apisix/routes/2",
        value: null,
        value_encoding: null,
        create_revision: "10",
        mod_revision: "51",
        version: "0",
        lease: null,
        prev_value: null,
        prev_value_encoding: null,
      },
    ]);
    expect(answer.warnings).toEqual([{ message: "Watched /apisix/routes/ (prefix) for 5 s: 2 events." }]);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test("a watch stopped at the row limit or the byte budget says so and sets wasLimited", () => {
    const events = [{ type: "put" as const, kv: pair("/a", "1") }];
    const rows = result(watch({ events, endedBy: "rows" }));
    expect(rows.warnings).toEqual([{ message: "Watched /apisix/routes/ (prefix): stopped at 1 event." }]);
    expect(rows.pagination?.wasLimited).toBe(true);
    expect(result(watch({ events, endedBy: "bytes" })).warnings).toEqual([
      { message: "Watched /apisix/routes/ (prefix): stopped at its byte budget after 1 event." },
    ]);
  });

  test("a window the query timeout capped says so, and how to watch longer (R12 UX-13)", () => {
    expect(result(watch({ windowMs: 4_000, capped: { queryTimeoutMs: 5_000 } })).warnings).toEqual([
      {
        message:
          "Watched /apisix/routes/ (prefix) for 4 s: no event. The window was capped at 4 s by this connection's query timeout (5 s); raise Query Timeout in the connection to watch longer.",
      },
    ]);
    expect(result(watch({ windowMs: 1_500, capped: { queryTimeoutMs: 2_250 } })).warnings?.[0].message).toContain(
      "for 1500 ms: no event. The window was capped at 1500 ms by this connection's query timeout (2250 ms)",
    );
  });
});

describe("leases (spec 5.2)", () => {
  test("lease grant, revoke and keep-alive answer one row each, the id as lease list prints it", () => {
    expect(result({ kind: "lease-grant", response: { header: header(), id: LEASE, ttl: "60" } }).rows).toEqual([
      { lease: "694d8147df1dc4c8", ttl: "60" },
    ]);
    expect(result({ kind: "lease-revoke", id: LEASE }).rows).toEqual([{ lease: "694d8147df1dc4c8", revoked: true }]);
    expect(result({ kind: "lease-keep-alive-once", response: { id: LEASE, ttl: "31536000" } }).rows).toEqual([
      { lease: "694d8147df1dc4c8", ttl: "31536000" },
    ]);
  });

  test("lease timetolive answers one row, or one per key with --keys, and one row for a lease with no key", () => {
    const response = {
      header: header(),
      id: LEASE,
      ttl: "3599",
      grantedTtl: "3600",
      keys: [utf8("/leases/a"), bytes("/leases/", [0xff])],
    };
    expect(result({ kind: "lease-timetolive", response, keys: false })).toMatchObject({
      fields: ["lease", "ttl", "granted_ttl"],
      rows: [{ lease: "694d8147df1dc4c8", ttl: "3599", granted_ttl: "3600" }],
    });
    const withKeys = result({ kind: "lease-timetolive", response, keys: true });
    expect(withKeys.fields).toEqual(["lease", "ttl", "granted_ttl", "key", "key_encoding"]);
    expect(withKeys.rows.map((row) => [row.key, row.key_encoding])).toEqual([
      ["/leases/a", "text"],
      [Buffer.from(bytes("/leases/", [0xff])).toString("base64"), "base64"],
    ]);
    expect(result({ kind: "lease-timetolive", response: { ...response, keys: [] }, keys: true })).toMatchObject({
      fields: ["lease", "ttl", "granted_ttl", "key"],
      rows: [{ lease: "694d8147df1dc4c8", ttl: "3599", granted_ttl: "3600", key: null }],
    });
  });

  test("lease list answers one row per lease", () => {
    expect(result({ kind: "lease-list", ids: [LEASE, "1"] }).rows).toEqual([
      { lease: "694d8147df1dc4c8" },
      { lease: "0000000000000001" },
    ]);
    // etcd grants a lease id a client chooses, a negative one included, and lease list prints it as Go's %016x.
    expect(result({ kind: "lease-list", ids: ["-5"] }).rows).toEqual([{ lease: "-000000000000005" }]);
    expect(result({ kind: "lease-list", ids: [] })).toMatchObject({ rows: [], fields: ["lease"] });
  });
});

describe("the cluster and access rows (spec 5.2)", () => {
  test("member list: the id unpadded, etcdctl's started and unstarted, the URLs joined as etcdctl joins them", () => {
    const answer = result({
      kind: "member-list",
      members: [
        {
          id: MEMBER,
          name: "etcd-1",
          peerUrls: ["http://a:2380", "http://b:2380"],
          clientUrls: ["http://a:2379"],
          isLearner: false,
        },
        { id: "255", name: "", peerUrls: ["http://c:2380"], clientUrls: [], isLearner: true },
      ],
    });
    expect(answer.fields).toEqual(["id", "name", "status", "peer_urls", "client_urls", "is_learner"]);
    expect(answer.rows).toEqual([
      {
        id: "8e9e05c52164694d",
        name: "etcd-1",
        status: "started",
        peer_urls: "http://a:2380,http://b:2380",
        client_urls: "http://a:2379",
        is_learner: false,
      },
      { id: "ff", name: "", status: "unstarted", peer_urls: "http://c:2380", client_urls: "", is_learner: true },
    ]);
  });

  test("endpoint status: one row for the configured endpoint, is_leader from the header's member id", () => {
    const status: EtcdStatus = {
      header: header(),
      version: "3.7.2",
      dbSize: "24576",
      dbSizeInUse: "20480",
      dbSizeQuota: "2147483648",
      leader: MEMBER,
      raftIndex: "100",
      raftTerm: "2",
      raftAppliedIndex: "100",
      errors: ["memberID:1 alarm:NOSPACE", "second"],
      isLearner: false,
      storageVersion: "3.7.0",
    };
    expect(result({ kind: "endpoint-status", endpoint: "127.0.0.1:2379", status }).rows).toEqual([
      {
        endpoint: "127.0.0.1:2379",
        id: "8e9e05c52164694d",
        version: "3.7.2",
        storage_version: "3.7.0",
        db_size: "24576",
        db_size_in_use: "20480",
        db_size_quota: "2147483648",
        is_leader: true,
        is_learner: false,
        raft_term: "2",
        raft_index: "100",
        raft_applied_index: "100",
        errors: "memberID:1 alarm:NOSPACE, second",
      },
    ]);
    expect(
      result({ kind: "endpoint-status", endpoint: "e:1", status: { ...status, leader: "1" } }).rows[0].is_leader,
    ).toBe(false);
  });

  test("endpoint health: one row, healthy or with etcdctl's error", () => {
    expect(result({ kind: "endpoint-health", endpoint: "127.0.0.1:2379", healthy: true, tookMs: 3 }).rows).toEqual([
      { endpoint: "127.0.0.1:2379", health: true, took: "3 ms", error: null },
    ]);
    expect(
      result({
        kind: "endpoint-health",
        endpoint: "e:1",
        healthy: false,
        tookMs: 12,
        error: "Active Alarm(s): NOSPACE",
      }).rows[0],
    ).toMatchObject({ health: false, error: "Active Alarm(s): NOSPACE" });
  });

  test("alarm list: one row per alarm, the member id in hex and the type as etcd names it", () => {
    expect(
      result({
        kind: "alarm-list",
        alarms: [
          { memberId: MEMBER, alarm: "nospace" },
          { memberId: "1", alarm: "corrupt" },
        ],
      }).rows,
    ).toEqual([
      { member_id: "8e9e05c52164694d", alarm: "NOSPACE" },
      { member_id: "1", alarm: "CORRUPT" },
    ]);
  });

  test("auth status, user list and role list", () => {
    expect(result({ kind: "auth-status", status: { enabled: true, authRevision: "11" } }).rows).toEqual([
      { enabled: true, auth_revision: "11" },
    ]);
    expect(result({ kind: "user-list", names: ["reader", "root"] }).rows).toEqual([
      { name: "reader" },
      { name: "root" },
    ]);
    expect(result({ kind: "role-list", names: ["reader"] })).toMatchObject({
      fields: ["name"],
      rows: [{ name: "reader" }],
    });
  });

  const permissions: EtcdPermission[] = [
    { type: "read", key: utf8("/app/"), rangeEnd: utf8("/app0") },
    { type: "readwrite", key: utf8("/config/a") },
    { type: "write", key: utf8("/m"), rangeEnd: Uint8Array.of(0) },
    { type: "read", key: utf8("/a"), rangeEnd: utf8("/c") },
  ];

  test("user get: its roles, and with --detail one row per permission", () => {
    expect(result({ kind: "user-get", name: "reader", roles: ["reader", "extra"] })).toMatchObject({
      fields: ["name", "roles"],
      rows: [{ name: "reader", roles: "reader, extra" }],
    });
    const detail = result({
      kind: "user-get",
      name: "reader",
      roles: ["reader"],
      permissions: [{ role: "reader", permission: permissions[0] }],
    });
    expect(detail.fields).toEqual(["name", "roles", "role", "type", "key", "range_end", "prefix"]);
    expect(detail.rows).toEqual([
      { name: "reader", roles: "reader", role: "reader", type: "READ", key: "/app/", range_end: "/app0", prefix: true },
    ]);
    expect(result({ kind: "user-get", name: "nobody", roles: [], permissions: [] }).rows).toEqual([
      { name: "nobody", roles: "", role: null, type: null, key: null, range_end: null, prefix: null },
    ]);
  });

  test("role get: one row per permission, a prefix flagged, a single key with no range end, an open end as its 0x00 byte", () => {
    const answer = result({ kind: "role-get", name: "reader", permissions });
    expect(answer.fields).toEqual(["role", "type", "key", "range_end", "prefix"]);
    expect(answer.rows).toEqual([
      { role: "reader", type: "READ", key: "/app/", range_end: "/app0", prefix: true },
      { role: "reader", type: "READWRITE", key: "/config/a", range_end: null, prefix: false },
      { role: "reader", type: "WRITE", key: "/m", range_end: "\u0000", prefix: false },
      { role: "reader", type: "READ", key: "/a", range_end: "/c", prefix: false },
    ]);
  });

  test("role get: a key or range end that is not UTF-8 adds its encoding column, and a role with no permission answers its name", () => {
    const binary = result({
      kind: "role-get",
      name: "r",
      permissions: [{ type: "read", key: bytes("/", [0xff]), rangeEnd: bytes("/", [0xff, 0x00]) }],
    });
    expect(binary.fields).toEqual(["role", "type", "key", "key_encoding", "range_end", "range_end_encoding", "prefix"]);
    expect(binary.rows[0]).toMatchObject({ key_encoding: "base64", range_end_encoding: "base64", prefix: false });
    expect(result({ kind: "role-get", name: "empty", permissions: [] }).rows).toEqual([
      { role: "empty", type: null, key: null, range_end: null, prefix: null },
    ]);
  });

  test("role get: an empty range end is the one key, and an empty key is no prefix, as etcdctl prints them", () => {
    // SRC review-lens-etcd/etcdctl__ctlv3__command__printer_simple.go, RoleGet: an empty range end prints
    // the one key, and "(prefix ...)" is printed only beside a key that is not empty.
    const answer = result({
      kind: "role-get",
      name: "r",
      permissions: [
        { type: "readwrite", key: utf8("/config/b"), rangeEnd: new Uint8Array() },
        { type: "read", key: new Uint8Array(), rangeEnd: Uint8Array.of(0) },
      ],
    });
    expect(answer.rows).toEqual([
      { role: "r", type: "READWRITE", key: "/config/b", range_end: null, prefix: false },
      { role: "r", type: "READ", key: "", range_end: "\u0000", prefix: false },
    ]);
  });
});

describe("the rules every result keeps (spec 5.2)", () => {
  test("every write answers at least one row", () => {
    const writes: CommandOutcome[] = [
      { kind: "put", key: utf8("/a"), response: { header: header() } },
      { kind: "del", response: { header: header(), deleted: "0", prevKvs: [] } },
      {
        kind: "txn",
        request: { compare: [], success: [], failure: [] },
        response: { header: header(), succeeded: false, responses: [] },
      },
      { kind: "lease-grant", response: { header: header(), id: LEASE, ttl: "60" } },
      { kind: "lease-revoke", id: LEASE },
      { kind: "lease-keep-alive-once", response: { id: LEASE, ttl: "60" } },
    ];
    for (const outcome of writes) expect(result(outcome).rowCount).toBeGreaterThanOrEqual(1);
  });

  test("every row carries every field, a field the row has no value for as null", () => {
    const answer = result({ kind: "user-get", name: "u", roles: [], permissions: [] });
    for (const row of answer.rows) expect(Object.keys(row)).toEqual(answer.fields);
  });
});
