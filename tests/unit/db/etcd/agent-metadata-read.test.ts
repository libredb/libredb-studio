/**
 * The etcd agent's metadata-only projection over what etcd v3.7.2 answered (reader-range.json), and the wording of
 * every failure: no key, value, address or etcd error text reaches an agent answer.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  ETCD_AGENT_FAILURE_SENTENCES,
  ETCD_METADATA_ONLY,
  type EtcdAgentAnswer,
  etcdAgentFailure,
  etcdAgentResult,
} from "@/lib/db/providers/keyvalue/etcd/agent-metadata-read";
import { type EtcdErrorCategory, EtcdError, type EtcdStatus } from "@/lib/db/providers/keyvalue/etcd/client";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";
import { TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import {
  capturedAlarms,
  capturedError,
  capturedLeaseTtl,
  capturedMembers,
  capturedRange,
  capturedStatus,
  principalCapture,
} from "../../../helpers/etcd-agent";

const BUDGET = { maxResultRows: 200, maxResultBytes: 64 * 1024, statementTimeoutMs: 10_000 };
const capture = principalCapture("reader-range");
const answerOf = <T>(name: string): T => (capture.reads[name] as { answer: T }).answer;

const status = capturedStatus(answerOf("status"));
const result = (answer: EtcdAgentAnswer) => etcdAgentResult(answer, BUDGET, "statement", 4);

/** Every text a result carries: its column names and its cells. */
const textOf = (value: unknown) => JSON.stringify(value);

describe("each read's projection", () => {
  test("endpoint status: the cluster's metadata, its error texts counted and never shown", () => {
    const answered = result({ op: "endpoint status", status });
    expect(answered).toEqual({
      fields: [
        "version",
        "storage_version",
        "member_id",
        "leader_id",
        "is_learner",
        "db_size_bytes",
        "db_size_in_use_bytes",
        "db_size_quota_bytes",
        "raft_term",
        "raft_index",
        "raft_applied_index",
        "errors",
      ],
      rows: [
        {
          version: "3.7.2",
          storage_version: "3.7.0",
          member_id: BigInt(status.header.memberId).toString(16),
          leader_id: BigInt(status.leader).toString(16),
          is_learner: false,
          db_size_bytes: Number(status.dbSize),
          db_size_in_use_bytes: Number(status.dbSizeInUse),
          db_size_quota_bytes: 2147483648,
          raft_term: Number(status.raftTerm),
          raft_index: Number(status.raftIndex),
          raft_applied_index: Number(status.raftAppliedIndex),
          errors: 0,
        },
      ],
      rowCount: 1,
      executionTime: 4,
    });
    const troubled: EtcdStatus = {
      ...status,
      errors: ["NOSPACE on /secret/token"],
      leader: "0",
      dbSizeQuota: "-1",
      storageVersion: "",
    };
    const row = result({ op: "endpoint status", status: troubled }).rows[0];
    expect(row).toMatchObject({ errors: 1, leader_id: null, db_size_quota_bytes: null, storage_version: null });
    expect(textOf(row)).not.toContain("/secret/token");
  });

  test("member list: ids, names and learner flags, its addresses counted and never shown", () => {
    const members = capturedMembers(answerOf("memberListLinearizable"));
    const answered = result({ op: "member list", members });
    expect(answered.fields).toEqual(["member_id", "name", "is_learner", "peer_urls", "client_urls"]);
    expect(answered.rows).toEqual([
      {
        member_id: BigInt(members[0].id).toString(16),
        name: "pr39-etcd-auth",
        is_learner: false,
        peer_urls: 1,
        client_urls: 1,
      },
    ]);
    expect(textOf(answered)).not.toContain("http://");
    const unnamed = result({ op: "member list", members: [{ ...members[0], name: "" }] });
    expect(unnamed.rows[0]?.name).toBeNull();
  });

  test("alarm list: the member and the alarm, as etcdctl names them", () => {
    expect(result({ op: "alarm list", alarms: capturedAlarms(answerOf("alarmGet")) }).rows).toEqual([]);
    const raised = result({ op: "alarm list", alarms: [{ memberId: "255", alarm: "nospace" }] });
    expect(raised).toMatchObject({ fields: ["member_id", "alarm"], rows: [{ member_id: "ff", alarm: "NOSPACE" }] });
  });

  test("auth status: whether authentication is on, and the auth store's revision", () => {
    const answered = result({ op: "auth status", auth: { enabled: true, authRevision: "33" } });
    expect(answered).toMatchObject({
      fields: ["enabled", "auth_revision"],
      rows: [{ enabled: true, auth_revision: 33 }],
    });
  });

  test("lease list: each lease's id as lease list prints it", () => {
    const ids = (answerOf("leaseLeases") as { leases: Array<{ ID: string }> }).leases.map((lease) => lease.ID);
    const answered = result({ op: "lease list", ids });
    expect(answered.fields).toEqual(["lease_id"]);
    expect(answered.rows).toEqual(ids.map((id) => ({ lease_id: BigInt(id).toString(16).padStart(16, "0") })));
  });

  test("lease timetolive: the lease's time to live, never its keys; a lease etcd no longer holds reads as gone", () => {
    const lease = capturedLeaseTtl(answerOf("leaseTimeToLive"));
    const answered = result({
      op: "lease timetolive",
      lease: { ...lease, keys: [new TextEncoder().encode("/app/x")] },
    });
    expect(answered).toMatchObject({
      fields: ["lease_id", "exists", "ttl_seconds", "granted_ttl_seconds"],
      rows: [
        {
          lease_id: BigInt(lease.id).toString(16).padStart(16, "0"),
          exists: true,
          ttl_seconds: Number(lease.ttl),
          granted_ttl_seconds: 3600,
        },
      ],
    });
    expect(textOf(answered)).not.toContain("/app/x");
    const gone = result({ op: "lease timetolive", lease: { ...lease, ttl: "-1", grantedTtl: "0" } });
    expect(gone.rows[0]).toMatchObject({ exists: false, ttl_seconds: null, granted_ttl_seconds: null });
  });

  test("the key count: one count, and nothing of a key", () => {
    const answered = result({ op: "key count", count: capturedRange(answerOf("rangeCountApp")).count });
    expect(answered).toMatchObject({ fields: ["keys"], rows: [{ keys: 3 }] });
  });

  test("one key's metadata: never its name or its value, and the value read as its size", () => {
    const kv = capturedRange(answerOf("rangeKey")).kvs[0];
    const answered = result({ op: "key metadata", kv });
    expect(answered).toEqual({
      fields: ["exists", "create_revision", "mod_revision", "version", "lease_id", "value_bytes"],
      rows: [{ exists: true, create_revision: 2, mod_revision: 2, version: 1, lease_id: null, value_bytes: 20 }],
      rowCount: 1,
      executionTime: 4,
    });
    expect(textOf(answered)).not.toContain("/app/config");
    expect(textOf(answered)).not.toContain("fixture-config-value");
    const leased = result({ op: "key metadata", kv: capturedRange(answerOf("rangeKeyLeased")).kvs[0] });
    expect(leased.rows[0]?.lease_id).toMatch(/^[0-9a-f]{16}$/);
    expect(textOf(leased)).not.toContain("fixture-session");
    const missing = result({ op: "key metadata", kv: capturedRange(answerOf("rangeKeyMissing")).kvs[0] });
    expect(missing.rows).toEqual([
      { exists: false, create_revision: null, mod_revision: null, version: null, lease_id: null, value_bytes: null },
    ]);
  });
});

describe("an answer that does not fit its column withholds the whole answer", () => {
  test.each([
    ["a revision past 15 digits", { op: "key count", count: "1234567890123456" }],
    ["a count that is not a number", { op: "key count", count: "/secret/token" }],
    ["an id that is not one", { op: "lease list", ids: ["/secret/token"] }],
    ["an optional id that is not one", { op: "endpoint status", status: { ...status, leader: "/secret/token" } }],
    [
      "a member id that is not a string",
      { op: "alarm list", alarms: [{ memberId: 5 as unknown as string, alarm: "corrupt" }] },
    ],
  ] as const)("%s", (_label, answer) => {
    let thrown: unknown;
    try {
      result(answer as EtcdAgentAnswer);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MetadataProjectionError);
    expect((thrown as Error).message).not.toContain("/secret/token");
  });
});

describe("the budget", () => {
  const members = capturedMembers(answerOf("memberListLinearizable"));

  test("more rows than the budget allows are refused, never cut", () => {
    const many = Array.from({ length: 3 }, (_, index) => ({ ...members[0], id: String(index + 1) }));
    expect(() =>
      etcdAgentResult({ op: "member list", members: many }, { ...BUDGET, maxResultRows: 2 }, "member list", 1),
    ).toThrow(QueryError);
  });

  test("more bytes than the budget allows are refused, never cut", () => {
    expect(() =>
      etcdAgentResult({ op: "member list", members }, { ...BUDGET, maxResultBytes: 10 }, "member list", 1),
    ).toThrow(QueryError);
  });
});

describe("the capability's statement", () => {
  test("names every read of the table, each with its columns' kinds, and no reader", () => {
    expect(Object.keys(ETCD_METADATA_ONLY)).toEqual([
      "endpoint status",
      "member list",
      "alarm list",
      "auth status",
      "lease list",
      "lease timetolive",
      "key count",
      "key metadata",
    ]);
    expect(ETCD_METADATA_ONLY["key metadata"]).toContainEqual({ column: "value_bytes", kind: "count" });
    expect(textOf(ETCD_METADATA_ONLY)).not.toContain("read");
  });
});

describe("the wording of a failure", () => {
  test("a captured permission refusal is worded by its category, without etcd's words", () => {
    const failure = etcdAgentFailure(capturedError(capture.reads.rangeKeyOutside!), BUDGET, "get /other/credential");
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure?.message).toBe(ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied"));
    expect(failure?.message).not.toContain("etcdserver");
  });

  test("an etcd error that repeats a key never passes it on", () => {
    const echoed = new EtcdError("invalid-argument", "etcdserver: bad key /secret/token", 3);
    const failure = etcdAgentFailure(echoed, BUDGET, "get x");
    expect(failure?.message).toBe(ETCD_AGENT_FAILURE_SENTENCES.refused("invalid-argument"));
    expect(failure?.message).not.toContain("/secret/token");
  });

  test.each([
    "lease-not-found",
    "no-leader",
    "unauthenticated",
    "resource-exhausted",
    "unavailable",
    "unknown",
  ] as const)("%s has a sentence of its own or names its category", (category: EtcdErrorCategory) => {
    const message = etcdAgentFailure(new EtcdError(category, "etcdserver: words /k"), BUDGET, "x")?.message ?? "";
    expect(message).toBe(ETCD_AGENT_FAILURE_SENTENCES.refused(category));
    expect(message).not.toContain("/k");
    expect(message).toContain("not passed on");
  });

  test("a deadline is the time budget's refusal", () => {
    const failure = etcdAgentFailure(new EtcdError("deadline-exceeded", "Cancelled on client"), BUDGET, "x");
    expect(failure?.message).toBe(`${TIME_BUDGET_PREFIX}: no answer within 10000ms`);
  });

  test("a projection's refusal keeps its own sentence, and anything else is not this table's", () => {
    const projection = new MetadataProjectionError("keys", "count");
    expect(etcdAgentFailure(projection, BUDGET, "x")?.message).toBe(projection.message);
    expect(etcdAgentFailure(new Error("defect"), BUDGET, "x")).toBeUndefined();
    expect(etcdAgentFailure("thrown", BUDGET, "x")).toBeUndefined();
  });
});
