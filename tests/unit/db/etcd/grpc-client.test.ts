/**
 * The gRPC adapter (spec 3.2, E3, E4, E5, E11, E14, E16, 6.1), in two halves.
 *
 * Over the recorded transport of tests/helpers/etcd-fixtures.ts (plan C11), the real adapter meets what etcd v3.7.2
 * answered the evidence harness (Task 2b): the request each seam method builds, every captured answer decoded,
 * every captured failure classified by the error table, the `hasleader` table, the token and spec E4's bounded
 * renewal, the watch and the keep-alive, and close(). Only the server is fake.
 *
 * Over local gRPC servers this file starts from the descriptor, through `grpcWireTransport` and the installed
 * @grpc/grpc-js: the wire encoding both ways, the decoded AlarmRequest of spec 7.2, deadlines before and after the
 * send, the call's own abort, the receive cap, etcd's answers in its own words (KE6), a refused and a reset socket,
 * a name that does not resolve, a TXT service config that would resend a write, a proxy the environment names,
 * which the channel never dials (E1), failover inside the one channel, the TLS rules of spec E5 the transport
 * applies, over the committed test certificates of tests/fixtures/tls/, and what a closed channel still did (E16): a
 * TLS handshake, or an HTTP/2 session waiting for SETTINGS, that a peer never answers, and a stream still open, which
 * close() ends, and a dial after the close, which refused readiness stops.
 * Real handshakes against certificates made at test time, under both runtimes, are tls-handshake.test.ts.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import dns from "node:dns";
import http2 from "node:http2";
import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import {
  type ChannelCredentials,
  Client,
  credentials,
  type experimental,
  Metadata,
  Server,
  ServerCredentials,
  type ServerDuplexStream,
  type ServerUnaryCall,
  type ServiceDefinition,
  type sendUnaryData,
} from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import {
  type EtcdCallOptions,
  type EtcdClient,
  type EtcdClientFactory,
  EtcdError,
  type EtcdErrorCategory,
  type EtcdRangeRequest,
  type EtcdTlsFailure,
  type EtcdWatchBatch,
} from "@/lib/db/providers/keyvalue/etcd/client";
import type { EtcdConnectionOptions, EtcdTlsOptions } from "@/lib/db/providers/keyvalue/etcd/connection-options";
import { type EtcdErrorContext, toProviderError } from "@/lib/db/providers/keyvalue/etcd/errors";
import {
  ClosingCredentials,
  channelOptions,
  createGrpcEtcdClient,
  ETCD_ALLOWLISTED_RPCS,
  ETCD_LOADER_OPTIONS,
  type EtcdUnaryRpc,
  type EtcdWireRpc,
  grpcWireTransport,
  HASLEADER_RULES,
} from "@/lib/db/providers/keyvalue/etcd/grpc-client";
import { ETCD_DESCRIPTOR } from "@/lib/db/providers/keyvalue/etcd/proto/descriptor";
import {
  ETCD_FIXTURE_NAMES,
  etcdCapture,
  type RecordedEtcdAnswer,
  type RecordedEtcdWireOptions,
  recordedEtcdWire,
} from "../../../helpers/etcd-fixtures";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
/** A stand-in no sentence of the adapter or of etcd holds, so an error that repeated it would show. */
const SECRET_PROBE = "hunter2";
const AUTH_STORE_OLD = "etcdserver: revision of auth store is old";
const options = { signal: new AbortController().signal };
const bytes = (value: string) => Buffer.from(value, "utf8");
const textOf = (value: Uint8Array) => Buffer.from(value).toString("utf8");

const PLAINTEXT: EtcdConnectionOptions = {
  target: "dns:etcd.test:2379",
  endpoint: { host: "etcd.test", port: 2379 },
  auth: { kind: "none" },
  callTimeoutMs: 5000,
  receiveCapBytes: 16 * 1024 * 1024,
};
const TLS: EtcdTlsOptions = {
  mode: "verify-full",
  verify: true,
  identity: "etcd.test",
  identityIsIp: false,
  serverNameOverride: "etcd.test",
};
const PASSWORD: EtcdConnectionOptions = {
  ...PLAINTEXT,
  tls: TLS,
  auth: { kind: "password", user: "root", password: TEST_PASSWORD },
  principal: { name: "root", via: "password" },
};
const CERTIFICATE: EtcdConnectionOptions = {
  ...PLAINTEXT,
  tls: { ...TLS, clientCertificate: { cert: "a certificate", key: "a key" } },
  auth: { kind: "certificate" },
  principal: { name: "reader", via: "certificate" },
};

const HEADER = {
  cluster_id: "14841639068965178418",
  member_id: "10276657743932975437",
  revision: "40",
  raft_term: "2",
};
const DECODED_HEADER = {
  clusterId: "14841639068965178418",
  memberId: "10276657743932975437",
  revision: "40",
  raftTerm: "2",
};

/** A grpc-js status error, as the library rejects a call: `code`, `details`, and a message built from both. */
function statusError(code: number, details: string): Error {
  return Object.assign(new Error(`${code} ${details}`), { code, details, metadata: new Metadata() });
}

function kv(key: string, value: string, modRevision = "9") {
  return {
    key: bytes(key),
    create_revision: "5",
    mod_revision: modRevision,
    version: "2",
    value: bytes(value),
    lease: "0",
  };
}

function rangeAnswer(...kvs: ReturnType<typeof kv>[]) {
  return { header: HEADER, kvs, more: false, count: String(kvs.length) };
}

const signedIn = (token: string) => () => ({ header: HEADER, token });
const refuse =
  (code: number, details: string): RecordedEtcdAnswer =>
  () => {
    throw statusError(code, details);
  };
/** An answer that arrives after `ms`, so a test can order two calls' answers around a renewal. */
const later =
  (ms: number, answer: () => unknown): RecordedEtcdAnswer =>
  () =>
    Bun.sleep(ms).then(answer);
/** An answer that never comes: the call ends only through its own signal. */
const never: RecordedEtcdAnswer = () => new Promise(() => undefined);

/** Each recorded call's rpc and the token it carried, or null for none. */
function tokensOf(calls: ReadonlyArray<{ readonly rpc: string; readonly metadata: Readonly<Record<string, string>> }>) {
  return calls.map((call): [string, string | null] => [call.rpc, call.metadata.token ?? null]);
}

async function recorded(wireOptions: RecordedEtcdWireOptions = {}, connection = PLAINTEXT, hooks = {}) {
  const wire = recordedEtcdWire(wireOptions);
  const client = await createGrpcEtcdClient(connection, hooks, wire.transport);
  return { wire, client };
}

/** The error a call rejects with; a call that answers fails the test. */
async function failure(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("The call answered, though this test expects it to fail");
    },
    (error: unknown) => error,
  );
}

function context(command: string, write: boolean): EtcdErrorContext {
  return {
    command,
    write,
    connection: {
      host: "etcd.test",
      port: 2379,
      runtimeReportsTlsCause: false,
      receiveCapBytes: 65536,
      timeoutMs: 5000,
    },
  };
}

/** One call of each unary seam method, with a request whose content no recorded answer below depends on. */
const INVOKE: Readonly<Record<EtcdUnaryRpc, (client: EtcdClient, call?: EtcdCallOptions) => Promise<unknown>>> = {
  "KV/Range": (client, call = options) => client.range({ key: bytes("/app/cfg"), limit: 1 }, call),
  "KV/DeleteRange": (client, call = options) => client.deleteRange({ key: bytes("/app/cfg") }, call),
  "KV/Txn": (client, call = options) => client.txn({ compare: [], success: [], failure: [] }, call),
  "KV/Compact": (client, call = options) => client.compact("40", call),
  "Lease/LeaseGrant": (client, call = options) => client.leaseGrant(60, call),
  "Lease/LeaseRevoke": (client, call = options) => client.leaseRevoke("7587863092875085100", call),
  "Lease/LeaseTimeToLive": (client, call = options) => client.leaseTimeToLive("7587863092875085001", true, call),
  "Lease/LeaseLeases": (client, call = options) => client.leaseLeases(call),
  "Cluster/MemberList": (client, call = options) => client.memberList({ linearizable: true }, call),
  "Maintenance/Alarm": (client, call = options) => client.alarmList(call),
  "Maintenance/Status": (client, call = options) => client.status(call),
  "Maintenance/Defragment": (client, call = options) => client.defragment(call),
  "Auth/AuthStatus": (client, call = options) => client.authStatus(call),
  "Auth/Authenticate": (client, call = options) => client.authenticate(call),
  "Auth/UserList": (client, call = options) => client.userList(call),
  "Auth/UserGet": (client, call = options) => client.userGet("reader", call),
  "Auth/RoleList": (client, call = options) => client.roleList(call),
  "Auth/RoleGet": (client, call = options) => client.roleGet("reader", call),
};

/** The smallest answer of each unary RPC that the adapter reads without an error. */
const MINIMAL: Readonly<Record<EtcdUnaryRpc, object>> = {
  "KV/Range": rangeAnswer(),
  "KV/DeleteRange": { header: HEADER, deleted: "0", prev_kvs: [] },
  "KV/Txn": { header: HEADER, succeeded: true, responses: [] },
  "KV/Compact": { header: HEADER },
  "Lease/LeaseGrant": { header: HEADER, ID: "7587863092875085100", TTL: "60", error: "" },
  "Lease/LeaseRevoke": { header: HEADER },
  "Lease/LeaseTimeToLive": { header: HEADER, ID: "7587863092875085001", TTL: "59", grantedTTL: "60", keys: [] },
  "Lease/LeaseLeases": { header: HEADER, leases: [] },
  "Cluster/MemberList": { header: HEADER, members: [] },
  "Maintenance/Alarm": { header: HEADER, alarms: [] },
  "Maintenance/Status": {
    header: HEADER,
    version: "3.7.2",
    dbSize: "20480",
    leader: "10276657743932975437",
    raftIndex: "44",
    raftTerm: "2",
    raftAppliedIndex: "44",
    errors: [],
    dbSizeInUse: "16384",
    isLearner: false,
    storageVersion: "3.7.0",
    dbSizeQuota: "0",
  },
  "Maintenance/Defragment": { header: null },
  "Auth/AuthStatus": { header: HEADER, enabled: false, authRevision: "0" },
  "Auth/Authenticate": { header: HEADER, token: "token-1" },
  "Auth/UserList": { header: HEADER, users: ["root"] },
  "Auth/UserGet": { header: HEADER, roles: ["reader"] },
  "Auth/RoleList": { header: HEADER, roles: ["reader", "root"] },
  "Auth/RoleGet": { header: HEADER, perm: [] },
};

/** A watch answer, every field at the default etcd leaves it at unless `overrides` says otherwise. */
const watchResponse = (overrides: object = {}) => ({
  header: HEADER,
  created: false,
  canceled: false,
  compact_revision: "0",
  cancel_reason: "",
  fragment: false,
  events: [],
  ...overrides,
});
const putEvent = (key: string, revision: string) => ({ type: "PUT", kv: kv(key, revision, revision), prev_kv: null });

describe("the RPC allowlist and the leader table (spec E11, 6.1)", () => {
  const definition = fromJSON(ETCD_DESCRIPTOR, ETCD_LOADER_OPTIONS);

  test("the descriptor is read with the options Task 1's descriptor test loads it with", () => {
    expect(ETCD_LOADER_OPTIONS).toEqual({ keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  });

  test("the allowlist is spec E11's, in its order, and neither a bare Put nor RangeStream is on it", () => {
    expect([...ETCD_ALLOWLISTED_RPCS]).toEqual([
      "KV/Range",
      "KV/DeleteRange",
      "KV/Txn",
      "Watch/Watch",
      "Lease/LeaseGrant",
      "Lease/LeaseRevoke",
      "Lease/LeaseKeepAlive",
      "Lease/LeaseTimeToLive",
      "Lease/LeaseLeases",
      "Cluster/MemberList",
      "Maintenance/Status",
      "Maintenance/Alarm",
      "KV/Compact",
      "Maintenance/Defragment",
      "Auth/AuthStatus",
      "Auth/Authenticate",
      "Auth/UserList",
      "Auth/UserGet",
      "Auth/RoleList",
      "Auth/RoleGet",
    ]);
    const listed: readonly string[] = ETCD_ALLOWLISTED_RPCS;
    expect(listed).not.toContain("KV/Put");
    expect(listed).not.toContain("KV/RangeStream");
  });

  test.each([...ETCD_ALLOWLISTED_RPCS])(
    "%s is a method of the descriptor, streaming both ways exactly when E11 says",
    (rpc) => {
      const [service, method] = rpc.split("/");
      const found = (definition[`etcdserverpb.${service}`] as unknown as ServiceDefinition)[method];
      const stream = rpc === "Watch/Watch" || rpc === "Lease/LeaseKeepAlive";
      expect(found).toMatchObject({
        path: `/etcdserverpb.${service}/${method}`,
        requestStream: stream,
        responseStream: stream,
      });
    },
  );

  test("HASLEADER_RULES is keyed by the allowlist: never for three calls, when-linearizable for three, always for the rest", () => {
    expect(Object.keys(HASLEADER_RULES).sort()).toEqual([...ETCD_ALLOWLISTED_RPCS].sort());
    const ruled = (rule: string) => ETCD_ALLOWLISTED_RPCS.filter((rpc) => HASLEADER_RULES[rpc] === rule);
    expect(ruled("never")).toEqual(["Lease/LeaseLeases", "Maintenance/Status", "Maintenance/Defragment"]);
    expect(ruled("when-linearizable")).toEqual(["KV/Range", "KV/Txn", "Cluster/MemberList"]);
    expect(ruled("always")).toHaveLength(14);
  });

  const get = (key: string, serializable?: true) =>
    ({ op: "range", request: { key: bytes(key), limit: 1, ...(serializable ? { serializable } : {}) } }) as const;
  const put = { op: "put", request: { key: bytes("/a"), value: bytes("v") } } as const;
  /** Every allowlisted RPC, each way its request decides the rule, with whether spec 6.1's table sends hasleader. */
  const LEADER_CASES: ReadonlyArray<readonly [string, EtcdWireRpc, (client: EtcdClient) => Promise<unknown>, boolean]> =
    [
      ["a linearizable range", "KV/Range", INVOKE["KV/Range"], true],
      [
        "a serializable range",
        "KV/Range",
        (c) => c.range({ key: bytes("/a"), limit: 1, serializable: true }, options),
        false,
      ],
      ["a deleteRange", "KV/DeleteRange", INVOKE["KV/DeleteRange"], true],
      [
        "a txn with a linearizable get",
        "KV/Txn",
        (c) => c.txn({ compare: [], success: [get("/a")], failure: [] }, options),
        true,
      ],
      [
        "a read-only txn of serializable gets",
        "KV/Txn",
        (c) => c.txn({ compare: [], success: [get("/a", true)], failure: [get("/b", true)] }, options),
        false,
      ],
      [
        "a txn whose failure branch holds a linearizable get",
        "KV/Txn",
        (c) => c.txn({ compare: [], success: [get("/a", true)], failure: [get("/b")] }, options),
        true,
      ],
      // etcd's own rule (IsTxnSerializable): a txn with no request is answered by the member alone.
      ["a txn with no request at all", "KV/Txn", INVOKE["KV/Txn"], false],
      [
        "a txn with a put beside a serializable get",
        "KV/Txn",
        (c) => c.txn({ compare: [], success: [get("/a", true), put], failure: [] }, options),
        true,
      ],
      ["a watch", "Watch/Watch", (c) => c.watch({ key: bytes("/a") }, () => "continue", options), true],
      ["a leaseGrant", "Lease/LeaseGrant", INVOKE["Lease/LeaseGrant"], true],
      ["a leaseRevoke", "Lease/LeaseRevoke", INVOKE["Lease/LeaseRevoke"], true],
      ["a keep-alive", "Lease/LeaseKeepAlive", (c) => c.leaseKeepAliveOnce("7587863092875085100", options), true],
      ["a leaseTimeToLive", "Lease/LeaseTimeToLive", INVOKE["Lease/LeaseTimeToLive"], true],
      ["a leaseLeases", "Lease/LeaseLeases", INVOKE["Lease/LeaseLeases"], false],
      ["a linearizable memberList", "Cluster/MemberList", INVOKE["Cluster/MemberList"], true],
      ["a serializable memberList", "Cluster/MemberList", (c) => c.memberList({ linearizable: false }, options), false],
      ["a status", "Maintenance/Status", INVOKE["Maintenance/Status"], false],
      ["an alarm GET", "Maintenance/Alarm", INVOKE["Maintenance/Alarm"], true],
      [
        "an alarm DEACTIVATE",
        "Maintenance/Alarm",
        (c) => c.alarmDisarm({ memberId: "10276657743932975437", alarm: "nospace" }, options),
        true,
      ],
      ["a compact", "KV/Compact", INVOKE["KV/Compact"], true],
      ["a defragment", "Maintenance/Defragment", INVOKE["Maintenance/Defragment"], false],
      ["an authStatus", "Auth/AuthStatus", INVOKE["Auth/AuthStatus"], true],
      ["an authenticate", "Auth/Authenticate", INVOKE["Auth/Authenticate"], true],
      ["a userList", "Auth/UserList", INVOKE["Auth/UserList"], true],
      ["a userGet", "Auth/UserGet", INVOKE["Auth/UserGet"], true],
      ["a roleList", "Auth/RoleList", INVOKE["Auth/RoleList"], true],
      ["a roleGet", "Auth/RoleGet", INVOKE["Auth/RoleGet"], true],
    ];
  const STREAM_ANSWERS: Readonly<Record<string, object>> = {
    "Watch/Watch": { messages: [watchResponse({ canceled: true, compact_revision: "2" })], end: "open" },
    "Lease/LeaseKeepAlive": { messages: [{ ID: "7587863092875085100", TTL: "59" }], end: "open" },
  };

  test("the cases below hold every allowlisted RPC to the table", () => {
    expect([...new Set(LEADER_CASES.map(([, rpc]) => rpc))].sort()).toEqual([...ETCD_ALLOWLISTED_RPCS].sort());
  });

  test.each(LEADER_CASES)("%s carries hasleader exactly as spec 6.1's table says", async (_label, rpc, run, leader) => {
    const answer = STREAM_ANSWERS[rpc] ?? MINIMAL[rpc as EtcdUnaryRpc];
    const { wire, client } = await recorded(
      { answers: { [rpc]: [() => answer] } },
      rpc === "Auth/Authenticate" ? PASSWORD : PLAINTEXT,
    );
    await run(client);
    expect(wire.calls.map((call) => [call.rpc, call.metadata])).toEqual([[rpc, leader ? { hasleader: "true" } : {}]]);
  });

  test("the sign-in carries hasleader and never a token, and every call after it carries the latest token", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "Maintenance/Status": [() => MINIMAL["Maintenance/Status"]],
          "KV/Range": [() => rangeAnswer()],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    await client.authenticate(options);
    await client.status(options);
    await INVOKE["KV/Range"](client);
    expect(wire.calls.map((call) => call.metadata)).toEqual([
      { hasleader: "true" },
      { hasleader: "true" },
      { token: "token-2" },
      { token: "token-2", hasleader: "true" },
    ]);
    expect(wire.calls[0].request).toEqual({ name: "root", password: TEST_PASSWORD });
  });

  test("every call's deadline, unary or stream, is its start plus the connection's query timeout (spec 5.3)", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "KV/Range": [() => rangeAnswer()],
          "Watch/Watch": [() => STREAM_ANSWERS["Watch/Watch"]],
          "Lease/LeaseKeepAlive": [() => STREAM_ANSWERS["Lease/LeaseKeepAlive"]],
        },
      },
      { ...PLAINTEXT, callTimeoutMs: 1234 },
    );
    const before = Date.now();
    await INVOKE["KV/Range"](client);
    await client.watch({ key: bytes("/a") }, () => "continue", options);
    await client.leaseKeepAliveOnce("7587863092875085100", options);
    const after = Date.now();
    expect(wire.calls.map((call) => call.rpc)).toEqual(["KV/Range", "Watch/Watch", "Lease/LeaseKeepAlive"]);
    for (const call of wire.calls) {
      expect(call.deadline.getTime()).toBeGreaterThanOrEqual(before + 1234);
      expect(call.deadline.getTime()).toBeLessThanOrEqual(after + 1234);
    }
  });
});

describe("capture: each seam method against what etcd v3.7.2 answered (gate 4)", () => {
  interface CapturedHeader {
    readonly cluster_id: string;
    readonly member_id: string;
    readonly revision: string;
    readonly raft_term: string;
  }
  interface CapturedKv {
    readonly key: Buffer;
    readonly value: Buffer;
    readonly create_revision: string;
    readonly mod_revision: string;
    readonly version: string;
    readonly lease: string;
  }
  const decodedHeader = (header: CapturedHeader) => ({
    clusterId: header.cluster_id,
    memberId: header.member_id,
    revision: header.revision,
    raftTerm: header.raft_term,
  });
  const decodedKv = (captured: CapturedKv) => ({
    key: captured.key,
    value: captured.value,
    createRevision: captured.create_revision,
    modRevision: captured.mod_revision,
    version: captured.version,
    lease: captured.lease,
  });
  type CapturedRange = { header: CapturedHeader; kvs: CapturedKv[]; more: boolean; count: string };
  const fixture = (rpc: string, name: string): RecordedEtcdWireOptions => ({ answers: { [rpc]: [{ fixture: name }] } });

  test("capture: range sends the harness's request for a key and decodes the answer field for field", async () => {
    const capture = etcdCapture("etcd/range-key");
    const { wire, client } = await recorded(fixture("KV/Range", "etcd/range-key"));
    const answer = await client.range({ key: bytes("/app/cfg"), limit: 1 }, options);
    expect(wire.calls[0].request).toEqual(capture.$captured.request);
    expect(wire.calls[0].metadata).toEqual({ hasleader: "true" });
    const payload = capture.payload as CapturedRange;
    expect(answer).toEqual({
      header: decodedHeader(payload.header),
      kvs: payload.kvs.map(decodedKv),
      more: false,
      count: "1",
    });
    expect(textOf(answer.kvs[0].value)).toBe('{"mode":"blue"}');
  });

  test("capture: range over a prefix cut by its limit says more, and counts the whole prefix", async () => {
    const capture = etcdCapture("etcd/range-prefix-app-limit-2");
    const { wire, client } = await recorded(fixture("KV/Range", "etcd/range-prefix-app-limit-2"));
    const answer = await client.range({ key: bytes("/app/"), rangeEnd: bytes("/app0"), limit: 2 }, options);
    expect(wire.calls[0].request).toEqual(capture.$captured.request);
    expect(answer.kvs).toHaveLength(2);
    expect(answer.more).toBe(true);
    expect(answer.count).toBe((capture.payload as CapturedRange).count);
    expect(Number(answer.count)).toBeGreaterThan(2);
  });

  test("capture: keys-only, count-only, serializable and historical reads send what the harness sent", async () => {
    // The seam request each capture's own wire request stands for: sent back through the adapter, it must be the
    // request the harness sent, byte for byte, with the leader metadata spec 6.1's table gives it.
    interface CapturedRangeRequest {
      readonly key: Buffer;
      readonly range_end?: Buffer;
      readonly limit: string;
      readonly revision?: string;
      readonly serializable?: boolean;
      readonly keys_only?: boolean;
      readonly count_only?: boolean;
    }
    const seamRequest = (wire: CapturedRangeRequest): EtcdRangeRequest => ({
      key: wire.key,
      ...(wire.range_end === undefined ? {} : { rangeEnd: wire.range_end }),
      limit: Number(wire.limit),
      ...(wire.revision === undefined ? {} : { revision: wire.revision }),
      ...(wire.serializable === true ? { serializable: true } : {}),
      ...(wire.keys_only === true ? { keysOnly: true } : {}),
      ...(wire.count_only === true ? { countOnly: true } : {}),
    });
    const names = [
      "etcd/range-keys-only-all",
      "etcd/range-keys-only-from",
      "etcd/range-count-only-all",
      "etcd/range-count-only-prefix",
      "etcd/range-serializable",
      "etcd/range-history-rev",
    ];
    for (const name of names) {
      const capture = etcdCapture(name);
      const sent = capture.$captured.request as CapturedRangeRequest;
      const payload = capture.payload as CapturedRange;
      // oxlint-disable-next-line no-await-in-loop -- each capture gets a recorded channel of its own, one after another.
      const { wire, client } = await recorded(fixture("KV/Range", name));
      // oxlint-disable-next-line no-await-in-loop -- the one call on that channel.
      const answer = await client.range(seamRequest(sent), options);
      expect({ name, request: wire.calls[0].request, metadata: wire.calls[0].metadata }).toEqual({
        name,
        request: sent,
        metadata: sent.serializable === true ? {} : { hasleader: "true" },
      });
      expect({ name, answer }).toEqual({
        name,
        answer: {
          header: decodedHeader(payload.header),
          kvs: payload.kvs.map(decodedKv),
          more: payload.more,
          count: payload.count,
        },
      });
      if (sent.keys_only) expect(answer.kvs.every((pair) => pair.value.length === 0)).toBe(true);
      if (sent.count_only) expect(answer.kvs).toEqual([]);
    }
  });

  test("capture: a key and a value that are not UTF-8 arrive as their bytes", async () => {
    const { client } = await recorded(fixture("KV/Range", "etcd/range-prefix-values"));
    const answer = await client.range({ key: bytes("/values/"), rangeEnd: bytes("/values0"), limit: 500 }, options);
    const binaryKey = Buffer.concat([bytes("/values/key-"), Buffer.from([0xff, 0xfe])]);
    expect(answer.kvs.some((pair) => Buffer.from(pair.key).equals(binaryKey))).toBe(true);
    const notUtf8 = answer.kvs.find((pair) => textOf(pair.key) === "/values/not-utf8");
    expect(Buffer.from(notUtf8?.value ?? new Uint8Array()).toString("hex")).toBe("fffe0001c328");
  });

  test("capture: E8's guarded put, its conflict and E8's read of three targets, as the harness sent them", async () => {
    const guarded = etcdCapture("etcd/txn-guarded-put");
    const edit = bytes("/libredb-evidence/edit");
    const sent = guarded.$captured.request as { compare: Array<{ mod_revision: string }> };
    const put = await recorded(fixture("KV/Txn", "etcd/txn-guarded-put"));
    const applied = await put.client.txn(
      {
        compare: [{ key: edit, target: "mod", result: "equal", operand: sent.compare[0].mod_revision }],
        success: [{ op: "put", request: { key: edit, value: bytes('{"v":2}') } }],
        failure: [{ op: "range", request: { key: edit, limit: 1 } }],
      },
      options,
    );
    expect(put.wire.calls[0].request).toEqual(guarded.$captured.request);
    expect(applied.succeeded).toBe(true);
    expect(applied.responses.map((op) => op.op)).toEqual(["put"]);

    const conflict = await recorded(fixture("KV/Txn", "etcd/txn-guarded-put-conflict"));
    const refused = await conflict.client.txn({ compare: [], success: [], failure: [] }, options);
    expect(refused.succeeded).toBe(false);
    const read = refused.responses[0];
    if (read.op !== "range") throw new Error("the failure branch answered no range");
    expect(textOf(read.response.kvs[0].value)).toBe('{"v":2}');

    const targets = await recorded(fixture("KV/Txn", "etcd/txn-read-targets"));
    const three = await targets.client.txn({ compare: [], success: [], failure: [] }, options);
    expect(three.responses.map((op) => op.op)).toEqual(["range", "range", "range"]);
    const last = three.responses[2];
    if (last.op !== "range") throw new Error("the third target answered no range");
    expect(last.response.kvs).toEqual([]);
  });

  test("capture: a guarded delete and a typed txn decode what each branch answered", async () => {
    const deleted = await (await recorded(fixture("KV/Txn", "etcd/txn-guarded-delete"))).client.txn(
      { compare: [], success: [], failure: [] },
      options,
    );
    expect(deleted.succeeded).toBe(true);
    const removal = deleted.responses[0];
    if (removal.op !== "delete") throw new Error("the guarded delete answered no delete");
    expect(removal.response.deleted).toBe("1");
    const typed = await (await recorded(fixture("KV/Txn", "etcd/txn-typed"))).client.txn(
      { compare: [], success: [], failure: [] },
      options,
    );
    expect(typed.responses.length).toBeGreaterThan(0);
  });

  test("capture: a prefix delete counts what it deleted", async () => {
    const capture = etcdCapture("etcd/delete-range-prefix");
    const { wire, client } = await recorded(fixture("KV/DeleteRange", "etcd/delete-range-prefix"));
    const answer = await client.deleteRange(
      { key: bytes("/libredb-evidence/"), rangeEnd: bytes("/libredb-evidence0") },
      options,
    );
    expect(wire.calls[0].request).toEqual(capture.$captured.request);
    expect(answer.deleted).toBe((capture.payload as { deleted: string }).deleted);
  });

  test("capture: leases: a grant, a revoke, a time-to-live with its keys, an unknown lease's -1, and the listing", async () => {
    const grant = await (await recorded(fixture("Lease/LeaseGrant", "etcd/lease-grant"))).client.leaseGrant(
      60,
      options,
    );
    expect(grant).toMatchObject({ id: "7587863092875085100", ttl: "60" });
    const revoke = await recorded(fixture("Lease/LeaseRevoke", "etcd/lease-revoke"));
    const revoked = await revoke.client.leaseRevoke("7587863092875085100", options);
    expect(revoke.wire.calls[0].request).toEqual(etcdCapture("etcd/lease-revoke").$captured.request);
    expect(revoked.header.revision).toMatch(/^\d+$/);
    const { wire, client } = await recorded(fixture("Lease/LeaseTimeToLive", "etcd/lease-time-to-live-keys"));
    const alive = await client.leaseTimeToLive("7587863092875085001", true, options);
    expect(wire.calls[0].request).toEqual(etcdCapture("etcd/lease-time-to-live-keys").$captured.request);
    expect(alive.keys.map(textOf).sort()).toEqual(["/leases/session-2", "/registry/events/default/nginx.1"]);
    const unknown = await (
      await recorded(fixture("Lease/LeaseTimeToLive", "etcd/lease-time-to-live-unknown"))
    ).client.leaseTimeToLive("7587863092875085199", true, options);
    expect(unknown.ttl).toBe("-1");
    const listed = await (await recorded(fixture("Lease/LeaseLeases", "etcd/lease-leases"))).client.leaseLeases(
      options,
    );
    expect([...listed.ids].sort()).toEqual(["7587863092875085000", "7587863092875085001"]);
  });

  test("capture: members, status, alarms and auth status, as etcd answered them", async () => {
    const members = await (await recorded(fixture("Cluster/MemberList", "etcd-cluster/member-list"))).client.memberList(
      { linearizable: true },
      options,
    );
    expect(members.members).toHaveLength(3);
    expect(members.members.every((member) => /^\d+$/.test(member.id) && member.clientUrls.length > 0)).toBe(true);
    const status = await (await recorded(fixture("Maintenance/Status", "etcd/status"))).client.status(options);
    expect(status.version).toBe("3.7.2");
    expect(status.dbSize).toMatch(/^\d+$/);
    expect(
      await (await recorded(fixture("Maintenance/Alarm", "etcd/alarm-list-none"))).client.alarmList(options),
    ).toEqual([]);
    const raised = await (
      await recorded(fixture("Maintenance/Alarm", "etcd-cluster/alarm-list-nospace"))
    ).client.alarmList(options);
    expect(raised).toEqual([
      {
        memberId: (etcdCapture("etcd-cluster/alarm-list-nospace").payload as { alarms: Array<{ memberID: string }> })
          .alarms[0].memberID,
        alarm: "nospace",
      },
    ]);
    const off = await (await recorded(fixture("Auth/AuthStatus", "etcd/auth-status-off"))).client.authStatus(options);
    expect(off.enabled).toBe(false);
    const on = await (await recorded(fixture("Auth/AuthStatus", "etcd-auth/auth-status-on"))).client.authStatus(
      options,
    );
    expect(on.enabled).toBe(true);
    expect(on.authRevision).toMatch(/^\d+$/);
  });

  test("capture: the disarm sends DEACTIVATE with the exact pair a GET answered, and compaction and defragmentation answer", async () => {
    const disarm = etcdCapture("etcd-cluster/alarm-disarm");
    const sent = disarm.$captured.request as { memberID: string };
    const { wire, client } = await recorded(fixture("Maintenance/Alarm", "etcd-cluster/alarm-disarm"));
    const cleared = await client.alarmDisarm({ memberId: sent.memberID, alarm: "nospace" }, options);
    expect(wire.calls[0].request).toEqual(disarm.$captured.request);
    expect(cleared).toEqual([{ memberId: sent.memberID, alarm: "nospace" }]);
    // A member id of 0 clears nothing, and etcd's answer says so by listing no alarm (spec 7.2).
    const zero = await recorded(fixture("Maintenance/Alarm", "etcd-cluster/alarm-disarm-member-zero"));
    expect(await zero.client.alarmDisarm({ memberId: "0", alarm: "nospace" }, options)).toEqual([]);
    expect(zero.wire.calls[0].request).toEqual(etcdCapture("etcd-cluster/alarm-disarm-member-zero").$captured.request);
    const compact = etcdCapture("etcd/compact");
    const compaction = await recorded(fixture("KV/Compact", "etcd/compact"));
    await compaction.client.compact((compact.$captured.request as { revision: string }).revision, options);
    expect(compaction.wire.calls[0].request).toEqual(compact.$captured.request);
    const defragmentation = await recorded(fixture("Maintenance/Defragment", "etcd/defragment"));
    await defragmentation.client.defragment(options);
    expect(defragmentation.wire.calls[0].metadata).toEqual({});
  });

  test("capture: users and roles: the listings, a user's roles and a role's permissions", async () => {
    const users = await (await recorded(fixture("Auth/UserList", "etcd-auth/user-list"))).client.userList(options);
    expect([...users].sort()).toEqual(["cert-only", "reader", "root"]);
    const roles = await (await recorded(fixture("Auth/UserGet", "etcd-auth/user-get-reader"))).client.userGet(
      "reader",
      options,
    );
    expect(roles).toEqual(["reader"]);
    const listed = (etcdCapture("etcd-auth/role-list").payload as { roles: string[] }).roles;
    const roleNames = await (await recorded(fixture("Auth/RoleList", "etcd-auth/role-list"))).client.roleList(options);
    expect(roleNames).toEqual(listed);
    expect(roleNames).toContain("reader");
    const roleGet = await recorded(fixture("Auth/RoleGet", "etcd-auth/role-get-reader"));
    const permissions = await roleGet.client.roleGet("reader", options);
    expect(roleGet.wire.calls[0].request).toEqual(etcdCapture("etcd-auth/role-get-reader").$captured.request);
    const shown = permissions.map((permission) => ({
      type: permission.type,
      key: textOf(permission.key),
      rangeEnd: permission.rangeEnd === undefined ? undefined : textOf(permission.rangeEnd),
    }));
    expect(shown.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { type: "read", key: "/app/", rangeEnd: "/app0" },
      { type: "read", key: "/config/a", rangeEnd: undefined },
    ]);
  });

  test("capture: authenticate keeps etcd's token and sends it on the next call", async () => {
    const { wire, client } = await recorded(
      {
        service: "etcd-auth-password",
        answers: {
          "Auth/Authenticate": [{ fixture: "etcd-auth-password/authenticate" }],
          "Maintenance/Status": [{ fixture: "etcd-auth-password/status" }],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    await client.status(options);
    expect(wire.calls[0].metadata).toEqual(etcdCapture("etcd-auth-password/authenticate").$captured.metadata);
    expect(wire.calls[1].metadata).toEqual(etcdCapture("etcd-auth-password/status").$captured.metadata);
  });

  test("capture: a watch over a prefix delivers its puts and its delete with the previous values, then stops", async () => {
    const capture = etcdCapture("etcd/watch-prefix");
    const { wire, client } = await recorded(fixture("Watch/Watch", "etcd/watch-prefix"));
    const events: EtcdWatchBatch["events"][number][] = [];
    const end = await client.watch(
      { key: bytes("/libredb-evidence/watch/"), rangeEnd: bytes("/libredb-evidence/watch0"), prevKv: true },
      (batch) => {
        events.push(...batch.events);
        return events.length >= 3 ? "stop" : "continue";
      },
      options,
    );
    expect(end).toEqual({ reason: "stopped" });
    expect(wire.calls[0].request).toEqual(capture.$captured.request);
    expect(wire.calls[0].metadata).toEqual({ hasleader: "true" });
    expect(
      events.map((event) => [event.type, textOf(event.kv.value), event.prevKv && textOf(event.prevKv.value)]),
    ).toEqual([
      ["put", "1", undefined],
      ["put", "2", "1"],
      ["delete", "", "2"],
    ]);
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("capture: a watch from a revision delivers the history, a quiet watch waits for its signal, and a compacted start is reported", async () => {
    const history = await recorded(fixture("Watch/Watch", "etcd/watch-history"));
    const start = (
      etcdCapture("etcd/watch-history").$captured.request as { create_request: { start_revision: string } }
    ).create_request.start_revision;
    const values: string[] = [];
    await history.client.watch(
      { key: bytes("/libredb-evidence/history"), startRevision: start },
      (batch) => {
        values.push(...batch.events.map((event) => textOf(event.kv.value)));
        return values.length >= 3 ? "stop" : "continue";
      },
      options,
    );
    expect(history.wire.calls[0].request).toEqual(etcdCapture("etcd/watch-history").$captured.request);
    expect(values).toHaveLength(3);

    const quiet = await recorded(fixture("Watch/Watch", "etcd/watch-quiet"));
    const window = new AbortController();
    setTimeout(() => window.abort(), 50);
    const batches: EtcdWatchBatch[] = [];
    const ended = await quiet.client.watch(
      { key: bytes("/app/"), rangeEnd: bytes("/app0") },
      (batch) => {
        batches.push(batch);
        return "continue";
      },
      { signal: window.signal },
    );
    expect(ended).toEqual({ reason: "aborted" });
    expect(batches).toEqual([]);
    expect(quiet.wire.cancels).toEqual(["Watch/Watch"]);

    const compacted = await recorded(fixture("Watch/Watch", "etcd/watch-compacted"));
    const reported = await compacted.client.watch(
      { key: bytes("/history/counter"), startRevision: "20" },
      () => "continue",
      options,
    );
    const messages = (etcdCapture("etcd/watch-compacted").payload as { messages: Array<{ compact_revision: string }> })
      .messages;
    expect(reported).toEqual({ reason: "compacted", compactRevision: messages[messages.length - 1].compact_revision });
    expect(compacted.wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("capture: a watch refused in-band ends with etcd's reason, which is no renewal answer", async () => {
    const capture = etcdCapture("etcd-auth/watch-permission-denied");
    const { wire, client } = await recorded(fixture("Watch/Watch", "etcd-auth/watch-permission-denied"), CERTIFICATE);
    const end = await client.watch({ key: bytes("/config/b") }, () => "continue", options);
    const messages = (capture.payload as { messages: Array<{ cancel_reason: string }> }).messages;
    expect(end).toEqual({ reason: "canceled", cancelReason: messages[messages.length - 1].cancel_reason });
    expect(end).toEqual({
      reason: "canceled",
      cancelReason: "rpc error: code = PermissionDenied desc = etcdserver: permission denied",
    });
    expect(wire.calls).toHaveLength(1);
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("capture: a watch whose token expired in-band is renewed once and created once more", async () => {
    const { wire, client } = await recorded(
      {
        service: "etcd-auth-password",
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "Watch/Watch": [
            { fixture: "etcd-auth-password/watch-invalid-auth-token" },
            () => ({ messages: [watchResponse({ created: true })], end: "open" }),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const window = new AbortController();
    const watching = client.watch({ key: bytes("/app/"), rangeEnd: bytes("/app0") }, () => "continue", {
      signal: window.signal,
    });
    await Bun.sleep(50);
    window.abort();
    expect(await watching).toEqual({ reason: "aborted" });
    expect(tokensOf(wire.calls)).toEqual([
      ["Auth/Authenticate", null],
      ["Watch/Watch", "token-1"],
      ["Auth/Authenticate", null],
      ["Watch/Watch", "token-2"],
    ]);
    expect(wire.cancels).toEqual(["Watch/Watch", "Watch/Watch"]);
  });

  test("capture: a keep-alive is one exchange: one write, one answer, then the stream is cancelled", async () => {
    const capture = etcdCapture("etcd/lease-keep-alive");
    const { wire, client } = await recorded(fixture("Lease/LeaseKeepAlive", "etcd/lease-keep-alive"));
    const answer = await client.leaseKeepAliveOnce("7587863092875085100", options);
    expect(wire.calls[0].request).toEqual(capture.$captured.request);
    expect(wire.calls[0].metadata).toEqual({ hasleader: "true" });
    expect(wire.writes).toEqual([]);
    expect(wire.cancels).toEqual(["Lease/LeaseKeepAlive"]);
    expect(answer.id).toBe("7587863092875085100");
    expect(Number(answer.ttl)).toBeGreaterThan(0);
    const expired = await (
      await recorded(fixture("Lease/LeaseKeepAlive", "etcd/lease-keep-alive-expired"))
    ).client.leaseKeepAliveOnce("7587863092875085100", options);
    expect(expired.ttl).toBe("0");
  });

  test("capture: every answer etcd gave to a unary call decodes through its seam method", async () => {
    const unread: string[] = [];
    let decoded = 0;
    for (const name of ETCD_FIXTURE_NAMES) {
      const capture = etcdCapture(name);
      const rpc = capture.$captured.rpc as EtcdUnaryRpc;
      if (capture.outcome !== "pass" || !(rpc in INVOKE)) continue;
      // oxlint-disable-next-line no-await-in-loop -- each capture gets a recorded channel of its own, one after another.
      const { client } = await recorded(
        { answers: { [rpc]: [{ fixture: name }] } },
        rpc === "Auth/Authenticate" ? PASSWORD : PLAINTEXT,
      );
      // oxlint-disable-next-line no-await-in-loop -- the one call on that channel.
      await INVOKE[rpc](client).then(
        () => decoded++,
        (error: unknown) => unread.push(`${name}: ${String(error)}`),
      );
    }
    expect(unread).toEqual([]);
    expect(decoded).toBeGreaterThan(60);
  });

  /**
   * What the error table makes of every failure the live services gave (spec 5.6, KE6), capture by capture. Under
   * Bun a refused client certificate carries no cause (spec E5), so it reads as a TLS connection that failed.
   */
  const FAILURES: Readonly<Record<string, readonly [EtcdErrorCategory, EtcdTlsFailure?]>> = {
    "etcd-auth-password/error-auth-revision-old": ["unauthenticated"],
    "etcd-auth-password/error-authenticate-no-password-user": ["auth-failed"],
    "etcd-auth-password/error-authenticate-wrong-password": ["auth-failed"],
    "etcd-auth-password/error-invalid-auth-token": ["unauthenticated"],
    "etcd-auth-password/error-range-no-token": ["unauthenticated"],
    "etcd-auth-password/error-user-name-empty-certificate": ["unauthenticated"],
    "etcd-auth/error-permission-denied": ["permission-denied"],
    "etcd-auth/error-permission-denied-alarm-disarm": ["permission-denied"],
    "etcd-auth/error-permission-denied-compact": ["permission-denied"],
    "etcd-auth/error-permission-denied-defragment": ["permission-denied"],
    "etcd-auth/error-permission-denied-lease-leases": ["permission-denied"],
    "etcd-auth/error-permission-denied-no-common-name": ["permission-denied"],
    "etcd-auth/error-permission-denied-role-list": ["permission-denied"],
    "etcd-auth/error-permission-denied-user-list": ["permission-denied"],
    "etcd-auth/error-plaintext-to-tls.bun": ["not-connected"],
    "etcd-auth/error-plaintext-to-tls.node": ["not-connected"],
    "etcd-auth/error-tls-chain.bun": ["tls", "chain"],
    "etcd-auth/error-tls-chain.node": ["tls", "chain"],
    "etcd-auth/error-tls-client-certificate-refused.bun": ["not-connected"],
    "etcd-auth/error-tls-client-certificate-refused.node": ["tls", "client-certificate-refused"],
    "etcd-auth/error-tls-client-certificate-required.bun": ["not-connected"],
    "etcd-auth/error-tls-client-certificate-required.node": ["tls", "client-certificate-required"],
    "etcd-auth/error-tls-name.bun": ["tls", "name"],
    "etcd-auth/error-tls-name.node": ["tls", "name"],
    "etcd-auth/error-user-name-empty": ["unauthenticated"],
    "etcd-auth/error-user-name-not-found": ["failed-precondition"],
    "etcd-auth/range-health-permission-denied": ["permission-denied"],
    "etcd-cluster/error-connection-dropped": ["unavailable"],
    // Under Bun the call to the paused member was sent (its detail names the peer), so it may have been applied.
    "etcd-cluster/error-deadline-before-pick.bun": ["deadline-exceeded"],
    "etcd-cluster/error-deadline-before-pick.node": ["not-connected"],
    "etcd-cluster/error-no-leader": ["no-leader"],
    "etcd-cluster/error-no-leader-txn-put": ["no-leader"],
    "etcd-cluster/error-no-space": ["no-space"],
    "etcd/error-authenticate-not-enabled": ["failed-precondition"],
    "etcd/error-cancelled-on-client": ["cancelled-elsewhere"],
    "etcd/error-client-receive-cap": ["resource-exhausted"],
    "etcd/error-deadline-after-send.bun": ["deadline-exceeded"],
    "etcd/error-deadline-after-send.node": ["deadline-exceeded"],
    "etcd/error-lease-revoke-not-found": ["lease-not-found"],
    "etcd/error-range-compacted": ["compacted"],
    "etcd/error-range-future-revision": ["future-revision"],
    "etcd/error-server-receive-cap": ["request-too-large"],
    // etcd's plaintext port closes the socket before the handshake, as a listener that accepts and closes does (a
    // tunnel's forward whose far end refused, pinned over grpc-js below), so the text names no TLS cause.
    "etcd/error-tls-to-plaintext.bun": ["not-connected"],
    "etcd/error-tls-to-plaintext.node": ["not-connected"],
    "etcd/error-txn-duplicate-key": ["duplicate-key"],
    "etcd/error-txn-request-too-large": ["request-too-large"],
    "etcd/error-txn-too-many-ops": ["too-many-ops"],
    "transport/error-deadline-name-resolution.bun": ["not-connected"],
    "transport/error-deadline-name-resolution.node": ["not-connected"],
    "transport/error-refused.bun": ["not-connected"],
    "transport/error-refused.node": ["not-connected"],
  };

  test("capture: every failure etcd or the runtime gave is classified as the error table expects", async () => {
    const failed = ETCD_FIXTURE_NAMES.filter((name) => etcdCapture(name).outcome === "fail");
    expect(failed).toEqual(Object.keys(FAILURES).sort());
    const mismatches: string[] = [];
    for (const name of failed) {
      const capture = etcdCapture(name);
      const rpc = capture.$captured.rpc as EtcdUnaryRpc;
      // oxlint-disable-next-line no-await-in-loop -- each capture gets a recorded channel of its own, one after another.
      const { wire, client } = await recorded(
        { answers: { [rpc]: [{ fixture: name }] } },
        rpc === "Auth/Authenticate" ? PASSWORD : PLAINTEXT,
      );
      // oxlint-disable-next-line no-await-in-loop -- the one call on that channel.
      const error = await failure(INVOKE[rpc](client));
      const [category, tlsFailure] = FAILURES[name];
      const found = error instanceof EtcdError ? [error.category, error.tlsFailure] : [String(error)];
      const detail = (capture.payload as { details?: string }).details ?? (capture.payload as Error).message;
      const exact = error instanceof EtcdError && error.detail === detail && wire.calls.length === 1;
      if (found[0] !== category || found[1] !== tlsFailure || !exact) {
        mismatches.push(`${name}: ${JSON.stringify(found)} from ${JSON.stringify(detail)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("spec E4: the token and its bounded renewal", () => {
  const E4_ANSWERS: ReadonlyArray<readonly [string, number, string]> = [
    ["an expired token", 16, "etcdserver: invalid auth token"],
    ["a missing token", 3, "etcdserver: user name is empty"],
    ["a stale auth revision", 3, AUTH_STORE_OLD],
  ];

  test.each(E4_ANSWERS)(
    "%s on a read renews once and retries the same request once, under the new token (Review Focus 3)",
    async (_label, code, details) => {
      let changed = 0;
      const { wire, client } = await recorded(
        {
          answers: {
            "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
            "KV/Range": [refuse(code, details), () => rangeAnswer(kv("/app/cfg", "v"))],
          },
        },
        PASSWORD,
        { onAuthStoreChanged: () => changed++ },
      );
      await client.authenticate(options);
      const page = { key: bytes("/app/cfg"), rangeEnd: bytes("/app0"), limit: 50, revision: "39", keysOnly: true };
      const answer = await client.range(page, options);
      expect(textOf(answer.kvs[0].value)).toBe("v");
      expect(tokensOf(wire.calls)).toEqual([
        ["Auth/Authenticate", null],
        ["KV/Range", "token-1"],
        ["Auth/Authenticate", null],
        ["KV/Range", "token-2"],
      ]);
      // The page is read again from the same cursor at the same pinned revision.
      expect(wire.calls[3].request).toEqual(wire.calls[1].request);
      expect(wire.calls[2].request).toEqual({ name: "root", password: TEST_PASSWORD });
      // R13 D10: only the stale auth revision says the grants may have changed.
      expect(changed).toBe(details === AUTH_STORE_OLD ? 1 : 0);
    },
  );

  test.each(E4_ANSWERS)(
    "%s followed by a renewal that fails raises the renewal's failure",
    async (_label, code, details) => {
      let changed = 0;
      const { wire, client } = await recorded(
        {
          answers: {
            "Auth/Authenticate": [
              signedIn("token-1"),
              refuse(3, "etcdserver: authentication failed, invalid user ID or password"),
            ],
            "KV/Range": [refuse(code, details)],
          },
        },
        PASSWORD,
        { onAuthStoreChanged: () => changed++ },
      );
      await client.authenticate(options);
      const error = await failure(INVOKE["KV/Range"](client));
      expect(error).toMatchObject({ category: "auth-failed" });
      expect(wire.calls.map((call) => call.rpc)).toEqual(["Auth/Authenticate", "KV/Range", "Auth/Authenticate"]);
      expect(changed).toBe(0);
    },
  );

  test("a read-only txn meeting a renewal answer is a read: renewed once and sent once more", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "KV/Txn": [refuse(16, "etcdserver: invalid auth token"), () => MINIMAL["KV/Txn"]],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const reads = {
      compare: [],
      success: [{ op: "range", request: { key: bytes("/a"), limit: 1 } }],
      failure: [],
    } as const;
    expect(await client.txn(reads, options)).toMatchObject({ succeeded: true });
    expect(tokensOf(wire.calls)).toEqual([
      ["Auth/Authenticate", null],
      ["KV/Txn", "token-1"],
      ["Auth/Authenticate", null],
      ["KV/Txn", "token-2"],
    ]);
  });

  test("a token that expires again later is renewed again: each renewal ends before the next begins", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2"), signedIn("token-3")],
          "KV/Range": [
            refuse(16, "etcdserver: invalid auth token"),
            () => rangeAnswer(),
            refuse(16, "etcdserver: invalid auth token"),
            () => rangeAnswer(),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    await INVOKE["KV/Range"](client);
    await INVOKE["KV/Range"](client);
    expect(tokensOf(wire.calls)).toEqual([
      ["Auth/Authenticate", null],
      ["KV/Range", "token-1"],
      ["Auth/Authenticate", null],
      ["KV/Range", "token-2"],
      ["KV/Range", "token-2"],
      ["Auth/Authenticate", null],
      ["KV/Range", "token-3"],
    ]);
  });

  test("a renewal that failed is not reused: the next call that meets a renewal answer signs in again", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), refuse(14, "etcdserver: request timed out"), signedIn("token-2")],
          "KV/Range": [
            refuse(16, "etcdserver: invalid auth token"),
            refuse(16, "etcdserver: invalid auth token"),
            () => rangeAnswer(),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    expect(await failure(INVOKE["KV/Range"](client))).toMatchObject({
      category: "unavailable",
      detail: "etcdserver: request timed out",
    });
    await INVOKE["KV/Range"](client);
    expect(tokensOf(wire.calls)).toEqual([
      ["Auth/Authenticate", null],
      ["KV/Range", "token-1"],
      ["Auth/Authenticate", null],
      ["KV/Range", "token-1"],
      ["Auth/Authenticate", null],
      ["KV/Range", "token-2"],
    ]);
  });

  test("a second renewal answer after the renewal is raised, so no call loops", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "KV/Range": [refuse(16, "etcdserver: invalid auth token"), refuse(16, "etcdserver: invalid auth token")],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const error = await failure(INVOKE["KV/Range"](client));
    expect(error).toMatchObject({ category: "unauthenticated", detail: "etcdserver: invalid auth token" });
    expect(wire.calls.map((call) => call.rpc)).toEqual([
      "Auth/Authenticate",
      "KV/Range",
      "Auth/Authenticate",
      "KV/Range",
    ]);
  });

  test("two calls meeting a stale token at once share one renewal", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), later(20, signedIn("token-2"))],
          "KV/Range": [
            refuse(16, "etcdserver: invalid auth token"),
            refuse(16, "etcdserver: invalid auth token"),
            () => rangeAnswer(),
            () => rangeAnswer(),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    await Promise.all([INVOKE["KV/Range"](client), INVOKE["KV/Range"](client)]);
    expect(wire.calls.filter((call) => call.rpc === "Auth/Authenticate")).toHaveLength(2);
    expect(wire.calls.filter((call) => call.rpc === "KV/Range").map((call) => call.metadata.token)).toEqual([
      "token-1",
      "token-1",
      "token-2",
      "token-2",
    ]);
  });

  test("a call that meets the stale auth revision while another's renewal runs joins it, and that renewal names the auth change once", async () => {
    let changed = 0;
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), later(40, signedIn("token-2"))],
          "KV/Range": [
            refuse(16, "etcdserver: invalid auth token"),
            later(10, () => {
              throw statusError(3, AUTH_STORE_OLD);
            }),
            () => rangeAnswer(),
            () => rangeAnswer(),
          ],
        },
      },
      PASSWORD,
      { onAuthStoreChanged: () => changed++ },
    );
    await client.authenticate(options);
    await Promise.all([INVOKE["KV/Range"](client), INVOKE["KV/Range"](client)]);
    expect(wire.calls.filter((call) => call.rpc === "Auth/Authenticate")).toHaveLength(2);
    expect(changed).toBe(1);
  });

  test("a call sent under a token another renewal has replaced only retries, and names the auth change once", async () => {
    let changed = 0;
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "KV/Range": [
            refuse(16, "etcdserver: invalid auth token"),
            later(30, () => {
              throw statusError(3, AUTH_STORE_OLD);
            }),
            () => rangeAnswer(),
            () => rangeAnswer(),
          ],
        },
      },
      PASSWORD,
      { onAuthStoreChanged: () => changed++ },
    );
    await client.authenticate(options);
    await Promise.all([INVOKE["KV/Range"](client), INVOKE["KV/Range"](client)]);
    expect(wire.calls.filter((call) => call.rpc === "Auth/Authenticate")).toHaveLength(2);
    expect(tokensOf(wire.calls.filter((call) => call.rpc === "KV/Range"))).toEqual([
      ["KV/Range", "token-1"],
      ["KV/Range", "token-1"],
      ["KV/Range", "token-2"],
      ["KV/Range", "token-2"],
    ]);
    expect(changed).toBe(1);
  });

  test("one auth change that two calls meet, one after the other's renewal, is named once", async () => {
    let changed = 0;
    const { client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "KV/Range": [
            refuse(3, AUTH_STORE_OLD),
            later(30, () => {
              throw statusError(3, AUTH_STORE_OLD);
            }),
            () => rangeAnswer(),
            () => rangeAnswer(),
          ],
        },
      },
      PASSWORD,
      { onAuthStoreChanged: () => changed++ },
    );
    await client.authenticate(options);
    await Promise.all([INVOKE["KV/Range"](client), INVOKE["KV/Range"](client)]);
    expect(changed).toBe(1);
  });

  const put = { op: "put", request: { key: bytes("/a"), value: bytes("v") } } as const;
  const WRITES: ReadonlyArray<readonly [string, EtcdUnaryRpc, (client: EtcdClient) => Promise<unknown>]> = [
    ["a txn holding a put", "KV/Txn", (c) => c.txn({ compare: [], success: [put], failure: [] }, options)],
    [
      "a txn whose failure branch holds a delete",
      "KV/Txn",
      (c) => c.txn({ compare: [], success: [], failure: [{ op: "delete", request: { key: bytes("/a") } }] }, options),
    ],
    ["a deleteRange", "KV/DeleteRange", INVOKE["KV/DeleteRange"]],
    ["a leaseGrant", "Lease/LeaseGrant", INVOKE["Lease/LeaseGrant"]],
    ["a leaseRevoke", "Lease/LeaseRevoke", INVOKE["Lease/LeaseRevoke"]],
    ["a compact", "KV/Compact", INVOKE["KV/Compact"]],
    ["a defragment", "Maintenance/Defragment", INVOKE["Maintenance/Defragment"]],
    [
      "an alarm DEACTIVATE",
      "Maintenance/Alarm",
      (c) => c.alarmDisarm({ memberId: "10276657743932975437", alarm: "corrupt" }, options),
    ],
  ];
  // KE12 (Task 22): the two answers measured as leaving a write unapplied, and the one no write could be made to meet.
  const NOT_APPLIED_ANSWERS = E4_ANSWERS.filter(([, , details]) => details !== AUTH_STORE_OLD);
  const UNKNOWN_ANSWERS = E4_ANSWERS.filter(([, , details]) => details === AUTH_STORE_OLD);
  const writeCases = (answers: typeof E4_ANSWERS) =>
    WRITES.flatMap(([label, rpc, run]) =>
      answers.map(([answer, code, details]) => [`${label} meeting ${answer}`, rpc, run, code, details] as const),
    );
  test.each(writeCases(NOT_APPLIED_ANSWERS))(
    "%s, which KE12 measured as not applied, renews once and is sent once more under the new token",
    async (_label, rpc, run, code, details) => {
      let changed = 0;
      const { wire, client } = await recorded(
        {
          answers: {
            // The renewal answers late: a write sent again before its renewal ended would carry token-1.
            "Auth/Authenticate": [signedIn("token-1"), later(20, signedIn("token-2"))],
            [rpc]: [refuse(code, details), () => MINIMAL[rpc]],
          },
        },
        PASSWORD,
        { onAuthStoreChanged: () => changed++ },
      );
      await client.authenticate(options);
      await run(client);
      expect(tokensOf(wire.calls)).toEqual([
        ["Auth/Authenticate", null],
        [rpc, "token-1"],
        ["Auth/Authenticate", null],
        [rpc, "token-2"],
      ]);
      // The same write, once more.
      expect(wire.calls[3].request).toEqual(wire.calls[1].request);
      expect(changed).toBe(0);
    },
  );

  test.each(NOT_APPLIED_ANSWERS)(
    "a write meeting %s before and after its one renewal raises the second answer, which says nothing was written",
    async (_label, code, details) => {
      const { wire, client } = await recorded(
        {
          answers: {
            "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
            "KV/Txn": [refuse(code, details), refuse(code, details)],
          },
        },
        PASSWORD,
      );
      await client.authenticate(options);
      const error = await failure(client.txn({ compare: [], success: [put], failure: [] }, options));
      expect(error).toMatchObject({ category: "unauthenticated", detail: details, grpcCode: code });
      expect(toProviderError(error, context("put", true)).message).not.toContain("The write may have been applied");
      expect(tokensOf(wire.calls)).toEqual([
        ["Auth/Authenticate", null],
        ["KV/Txn", "token-1"],
        ["Auth/Authenticate", null],
        ["KV/Txn", "token-2"],
      ]);
    },
  );

  test.each(writeCases(UNKNOWN_ANSWERS))(
    "%s renews once and is raised as it came, sent once, and the same write after it carries the new token",
    async (_label, rpc, run, code, details) => {
      let changed = 0;
      const { wire, client } = await recorded(
        {
          answers: {
            // The renewal answers late: a write raised before its renewal ended would send the next under token-1.
            "Auth/Authenticate": [signedIn("token-1"), later(20, signedIn("token-2"))],
            [rpc]: [refuse(code, details), () => MINIMAL[rpc]],
          },
        },
        PASSWORD,
        { onAuthStoreChanged: () => changed++ },
      );
      await client.authenticate(options);
      const error = await failure(run(client));
      // Its own answer, sent once: KE12 could not make a write meet this answer, so its outcome is unknown.
      expect(error).toMatchObject({ category: "unauthenticated", detail: details, grpcCode: code });
      expect(toProviderError(error, context("put", true)).message).toContain("The write may have been applied");
      expect(tokensOf(wire.calls)).toEqual([
        ["Auth/Authenticate", null],
        [rpc, "token-1"],
        ["Auth/Authenticate", null],
      ]);
      // R13 D10: the write's renewal names a stale auth revision, and no other answer.
      expect(changed).toBe(details === AUTH_STORE_OLD ? 1 : 0);
      await run(client);
      expect(tokensOf(wire.calls.slice(3))).toEqual([[rpc, "token-2"]]);
    },
  );

  test.each(NOT_APPLIED_ANSWERS)(
    "a write meeting %s whose renewal fails raises the renewal's failure, as a read does, since nothing was written",
    async (_label, code, details) => {
      const { wire, client } = await recorded(
        {
          answers: {
            "Auth/Authenticate": [
              signedIn("token-1"),
              refuse(3, "etcdserver: authentication failed, invalid user ID or password"),
              signedIn("token-2"),
            ],
            "KV/Txn": [refuse(code, details)],
            "KV/Range": [refuse(code, details), () => rangeAnswer()],
          },
        },
        PASSWORD,
      );
      await client.authenticate(options);
      const error = await failure(client.txn({ compare: [], success: [put], failure: [] }, options));
      expect(error).toMatchObject({ category: "auth-failed" });
      // The failed renewal left the token it would have replaced, so the next call meets the answer and renews.
      await INVOKE["KV/Range"](client);
      expect(tokensOf(wire.calls)).toEqual([
        ["Auth/Authenticate", null],
        ["KV/Txn", "token-1"],
        ["Auth/Authenticate", null],
        ["KV/Range", "token-1"],
        ["Auth/Authenticate", null],
        ["KV/Range", "token-2"],
      ]);
    },
  );

  test.each(UNKNOWN_ANSWERS)(
    "a write meeting %s whose renewal fails raises its own answer, never the sign-in's, and the next call signs in again",
    async (_label, code, details) => {
      let changed = 0;
      const { wire, client } = await recorded(
        {
          answers: {
            "Auth/Authenticate": [
              signedIn("token-1"),
              refuse(3, "etcdserver: authentication failed, invalid user ID or password"),
              signedIn("token-2"),
            ],
            "KV/Txn": [refuse(code, details)],
            "KV/Range": [refuse(code, details), () => rangeAnswer()],
          },
        },
        PASSWORD,
        { onAuthStoreChanged: () => changed++ },
      );
      await client.authenticate(options);
      const error = await failure(client.txn({ compare: [], success: [put], failure: [] }, options));
      expect(error).toMatchObject({ category: "unauthenticated", detail: details, grpcCode: code });
      expect(toProviderError(error, context("put", true)).message).toContain("The write may have been applied");
      // The failed renewal left the token it would have replaced, so the next call meets the answer and renews.
      await INVOKE["KV/Range"](client);
      expect(tokensOf(wire.calls)).toEqual([
        ["Auth/Authenticate", null],
        ["KV/Txn", "token-1"],
        ["Auth/Authenticate", null],
        ["KV/Range", "token-1"],
        ["Auth/Authenticate", null],
        ["KV/Range", "token-2"],
      ]);
      expect(changed).toBe(details === AUTH_STORE_OLD ? 1 : 0);
    },
  );

  test("a write whose signal aborts while it waits for its renewal raises its own answer at once, and sends nothing more", async () => {
    // The answer KE12 could not make a write meet, so the write's outcome stays unknown.
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), never],
          "KV/DeleteRange": [refuse(3, AUTH_STORE_OLD)],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const cancel = new AbortController();
    let settled = false;
    const deleting = INVOKE["KV/DeleteRange"](client, { signal: cancel.signal }).finally(() => {
      settled = true;
    });
    await Bun.sleep(20);
    // The write waits for the renewal it started, so the next call would carry the new token.
    expect(settled).toBe(false);
    cancel.abort();
    expect(await failure(deleting)).toMatchObject({ category: "unauthenticated", detail: AUTH_STORE_OLD });
    expect(wire.calls.map((call) => call.rpc)).toEqual(["Auth/Authenticate", "KV/DeleteRange", "Auth/Authenticate"]);
    // The renewal is the client's own call, which close() ends.
    await client.close();
  });

  test("a write KE12 measured as not applied, whose signal aborts while it waits for its renewal, ends with the abort and sends nothing more", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), never],
          "KV/DeleteRange": [refuse(16, "etcdserver: invalid auth token")],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const cancel = new AbortController();
    let settled = false;
    const deleting = INVOKE["KV/DeleteRange"](client, { signal: cancel.signal }).finally(() => {
      settled = true;
    });
    await Bun.sleep(20);
    // It waits for the renewal, to be sent once more under the new token, as a read does.
    expect(settled).toBe(false);
    cancel.abort();
    expect(await failure(deleting)).toMatchObject({ category: "cancelled" });
    expect(wire.calls.map((call) => call.rpc)).toEqual(["Auth/Authenticate", "KV/DeleteRange", "Auth/Authenticate"]);
    await client.close();
  });

  test("a keep-alive meeting a renewal answer KE12 measured as not applied is renewed once and sent once more, each stream cancelled", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "Lease/LeaseKeepAlive": [
            () => ({ messages: [], end: { error: statusError(16, "etcdserver: invalid auth token") } }),
            () => ({ messages: [{ ID: "7587863092875085100", TTL: "60" }], end: "open" }),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    expect(await client.leaseKeepAliveOnce("7587863092875085100", options)).toEqual({
      id: "7587863092875085100",
      ttl: "60",
    });
    expect(tokensOf(wire.calls)).toEqual([
      ["Auth/Authenticate", null],
      ["Lease/LeaseKeepAlive", "token-1"],
      ["Auth/Authenticate", null],
      ["Lease/LeaseKeepAlive", "token-2"],
    ]);
    expect(wire.cancels).toEqual(["Lease/LeaseKeepAlive", "Lease/LeaseKeepAlive"]);
  });

  test("a keep-alive meeting a renewal answer is a write: renewed once, raised as it came, and its stream cancelled", async () => {
    // The answer KE12 could not make a write meet, so the keep-alive's outcome stays unknown.
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "Lease/LeaseKeepAlive": [
            () => ({ messages: [], end: { error: statusError(3, AUTH_STORE_OLD) } }),
            () => ({ messages: [{ ID: "7587863092875085100", TTL: "60" }], end: "open" }),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const error = await failure(client.leaseKeepAliveOnce("7587863092875085100", options));
    expect(error).toMatchObject({ category: "unauthenticated", detail: AUTH_STORE_OLD });
    expect(tokensOf(wire.calls)).toEqual([
      ["Auth/Authenticate", null],
      ["Lease/LeaseKeepAlive", "token-1"],
      ["Auth/Authenticate", null],
    ]);
    expect(wire.cancels).toEqual(["Lease/LeaseKeepAlive"]);
    expect(await client.leaseKeepAliveOnce("7587863092875085100", options)).toEqual({
      id: "7587863092875085100",
      ttl: "60",
    });
    expect(tokensOf(wire.calls.slice(3))).toEqual([["Lease/LeaseKeepAlive", "token-2"]]);
    expect(wire.cancels).toEqual(["Lease/LeaseKeepAlive", "Lease/LeaseKeepAlive"]);
  });

  test.each([
    ["no credential", PLAINTEXT],
    ["a client certificate", CERTIFICATE],
  ] as const)("with %s, no renewal runs: the answer is raised as it came", async (_label, connection) => {
    for (const [, code, details] of E4_ANSWERS) {
      // oxlint-disable-next-line no-await-in-loop -- each answer gets a recorded channel of its own, one after another.
      const { wire, client } = await recorded({ answers: { "KV/Range": [refuse(code, details)] } }, connection);
      // oxlint-disable-next-line no-await-in-loop -- the one call on that channel.
      const error = await failure(INVOKE["KV/Range"](client));
      expect(error).toMatchObject({ category: "unauthenticated", detail: details });
      expect(wire.calls.map((call) => call.rpc)).toEqual(["KV/Range"]);
    }
  });

  test("authenticate with no password configured sends nothing and says why", async () => {
    for (const [connection, why] of [
      [PLAINTEXT, "no credential"],
      [CERTIFICATE, "its certificate"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each connection gets a recorded channel of its own, one after another.
      const { wire, client } = await recorded({}, connection);
      // oxlint-disable-next-line no-await-in-loop -- the one call on that channel.
      const error = await failure(client.authenticate(options));
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        `This etcd client signs in with ${why}, so it has no password to authenticate with`,
      );
      expect(wire.calls).toEqual([]);
    }
  });

  test("the token and the password never reach an error (spec E2)", async () => {
    const token = "stay-here";
    const { client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [
            signedIn(token),
            refuse(3, "etcdserver: authentication failed, invalid user ID or password"),
          ],
          "KV/Range": [refuse(16, "etcdserver: invalid auth token")],
        },
      },
      { ...PASSWORD, auth: { kind: "password", user: "root", password: SECRET_PROBE } },
    );
    await client.authenticate(options);
    const error = (await failure(INVOKE["KV/Range"](client))) as EtcdError;
    expect(error.category).toBe("auth-failed");
    for (const text of [error.message, error.detail, toProviderError(error, context("get", false)).message]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(SECRET_PROBE);
    }
  });

  test("a call whose signal aborts while it waits for a renewal ends at once as a cancel, and sends nothing more", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), never],
          "KV/Range": [refuse(16, "etcdserver: invalid auth token")],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const cancel = new AbortController();
    const reading = INVOKE["KV/Range"](client, { signal: cancel.signal });
    await Bun.sleep(20);
    cancel.abort();
    expect(await failure(reading)).toMatchObject({ category: "cancelled" });
    expect(wire.calls.map((call) => call.rpc)).toEqual(["Auth/Authenticate", "KV/Range", "Auth/Authenticate"]);
    // The renewal is the client's own call, which close() ends.
    await client.close();
  });

  test("close() ends a renewal in flight, and a call that waited for it rejects as closed", async () => {
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), never],
          "KV/Range": [refuse(16, "etcdserver: invalid auth token")],
          "Watch/Watch": [
            () => ({
              messages: [
                watchResponse({
                  canceled: true,
                  cancel_reason: "rpc error: code = Unauthenticated desc = etcdserver: invalid auth token",
                }),
              ],
              end: "open",
            }),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const reading = INVOKE["KV/Range"](client);
    const watching = client.watch({ key: bytes("/a") }, () => "continue", options);
    await Bun.sleep(20);
    await client.close();
    expect(await failure(reading)).toMatchObject({ category: "closed" });
    expect(await failure(watching)).toMatchObject({ category: "closed" });
    expect(wire.calls.filter((call) => call.rpc === "Auth/Authenticate")).toHaveLength(2);
    expect(wire.closes).toBe(1);
  });

  const cancelledWatch = (reason: string) => watchResponse({ created: true, canceled: true, cancel_reason: reason });
  const created = (revision: string) => watchResponse({ created: true, header: { ...HEADER, revision } });
  const eventsAt = (...revisions: string[]) =>
    watchResponse({
      header: { ...HEADER, revision: revisions[revisions.length - 1] },
      events: revisions.map((revision) => putEvent("/app/cfg", revision)),
    });
  const IN_BAND: ReadonlyArray<readonly [string, string]> = [
    ["an expired token", "rpc error: code = Unauthenticated desc = etcdserver: invalid auth token"],
    ["a missing token", "rpc error: code = InvalidArgument desc = etcdserver: user name is empty"],
    ["a stale auth revision", `rpc error: code = InvalidArgument desc = ${AUTH_STORE_OLD}`],
  ];

  test.each(IN_BAND)(
    "a watch cancelled in-band for %s is renewed once and created once more, from the revision after its last event",
    async (_label, reason) => {
      let changed = 0;
      const { wire, client } = await recorded(
        {
          answers: {
            "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
            "Watch/Watch": [
              () => ({
                messages: [created("40"), eventsAt("41"), { ...cancelledWatch(reason), created: false }],
                end: "open",
              }),
              () => ({ messages: [created("41"), eventsAt("42")], end: "open" }),
            ],
          },
        },
        PASSWORD,
        { onAuthStoreChanged: () => changed++ },
      );
      await client.authenticate(options);
      const seen: string[] = [];
      const end = await client.watch(
        { key: bytes("/app/"), rangeEnd: bytes("/app0") },
        (batch) => {
          seen.push(...batch.events.map((event) => event.kv.modRevision));
          return seen.length === 2 ? "stop" : "continue";
        },
        options,
      );
      expect(end).toEqual({ reason: "stopped" });
      expect(seen).toEqual(["41", "42"]);
      const watches = wire.calls.filter((call) => call.rpc === "Watch/Watch");
      expect(watches.map((call) => [call.metadata.token, call.request])).toEqual([
        ["token-1", { create_request: { key: bytes("/app/"), range_end: bytes("/app0"), fragment: true } }],
        [
          "token-2",
          { create_request: { key: bytes("/app/"), range_end: bytes("/app0"), start_revision: "42", fragment: true } },
        ],
      ]);
      expect(wire.cancels).toEqual(["Watch/Watch", "Watch/Watch"]);
      expect(changed).toBe(reason.endsWith(AUTH_STORE_OLD) ? 1 : 0);
    },
  );

  test("a watch refused in-band before any event starts again after the created revision, or from its own", async () => {
    const reason = "rpc error: code = Unauthenticated desc = etcdserver: invalid auth token";
    const starts: Array<string | undefined> = [];
    for (const startRevision of [undefined, "7"]) {
      // oxlint-disable-next-line no-await-in-loop -- each start gets a recorded channel of its own, one after another.
      const { wire, client } = await recorded(
        {
          answers: {
            "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
            "Watch/Watch": [
              () => ({ messages: [created("40"), { ...cancelledWatch(reason), created: false }], end: "open" }),
              () => ({
                messages: [cancelledWatch("rpc error: code = PermissionDenied desc = etcdserver: permission denied")],
                end: "open",
              }),
            ],
          },
        },
        PASSWORD,
      );
      // oxlint-disable-next-line no-await-in-loop -- the sign-in comes before the watch on that channel.
      await client.authenticate(options);
      // oxlint-disable-next-line no-await-in-loop -- the one watch on that channel.
      await client.watch(
        { key: bytes("/app/"), ...(startRevision === undefined ? {} : { startRevision }) },
        () => "continue",
        options,
      );
      const second = wire.calls.filter((call) => call.rpc === "Watch/Watch")[1].request as {
        create_request: { start_revision?: string };
      };
      starts.push(second.create_request.start_revision);
    }
    expect(starts).toEqual(["41", "7"]);
  });

  test("a second in-band renewal answer ends the watch with it, after exactly one renewal", async () => {
    const reason = "rpc error: code = Unauthenticated desc = etcdserver: invalid auth token";
    const { wire, client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [signedIn("token-1"), signedIn("token-2")],
          "Watch/Watch": [
            () => ({ messages: [cancelledWatch(reason)], end: "open" }),
            () => ({ messages: [cancelledWatch(reason)], end: "open" }),
          ],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    const end = await client.watch({ key: bytes("/app/") }, () => "continue", options);
    expect(end).toEqual({ reason: "canceled", cancelReason: reason });
    expect(wire.calls.filter((call) => call.rpc === "Auth/Authenticate")).toHaveLength(2);
    expect(wire.cancels).toEqual(["Watch/Watch", "Watch/Watch"]);
  });

  test("a watch whose renewal fails raises the renewal's failure", async () => {
    const reason = "rpc error: code = Unauthenticated desc = etcdserver: invalid auth token";
    const { client } = await recorded(
      {
        answers: {
          "Auth/Authenticate": [
            signedIn("token-1"),
            refuse(3, "etcdserver: authentication failed, invalid user ID or password"),
          ],
          "Watch/Watch": [() => ({ messages: [cancelledWatch(reason)], end: "open" })],
        },
      },
      PASSWORD,
    );
    await client.authenticate(options);
    expect(await failure(client.watch({ key: bytes("/app/") }, () => "continue", options))).toMatchObject({
      category: "auth-failed",
    });
  });

  test("with a client certificate, an in-band renewal answer ends the watch as it came", async () => {
    const reason = "rpc error: code = InvalidArgument desc = etcdserver: user name is empty";
    const { wire, client } = await recorded(
      { answers: { "Watch/Watch": [() => ({ messages: [cancelledWatch(reason)], end: "open" })] } },
      CERTIFICATE,
    );
    expect(await client.watch({ key: bytes("/app/") }, () => "continue", options)).toEqual({
      reason: "canceled",
      cancelReason: reason,
    });
    expect(wire.calls.map((call) => call.rpc)).toEqual(["Watch/Watch"]);
  });
});

describe("the watch and the keep-alive (spec 5.3, E16)", () => {
  const watchOnce = async (messages: object[], end: unknown = "open") => {
    const { wire, client } = await recorded({ answers: { "Watch/Watch": [() => ({ messages, end })] } });
    const batches: EtcdWatchBatch[] = [];
    const outcome = client.watch(
      { key: bytes("/app/"), rangeEnd: bytes("/app0"), startRevision: "3", prevKv: true },
      (batch) => {
        batches.push(batch);
        return "continue";
      },
      options,
    );
    return { wire, batches, outcome };
  };

  test("the create request carries the range, the start revision, prev_kv and fragment", async () => {
    const { wire, outcome } = await watchOnce([watchResponse({ canceled: true, compact_revision: "2" })]);
    await outcome;
    expect(wire.calls[0].request).toEqual({
      create_request: {
        key: bytes("/app/"),
        range_end: bytes("/app0"),
        start_revision: "3",
        prev_kv: true,
        fragment: true,
      },
    });
    expect(wire.writes).toEqual([]);
  });

  test("a fragmented answer is handed on fragment by fragment, and an answer without events is no batch", async () => {
    const { batches, outcome } = await watchOnce([
      watchResponse({ created: true }),
      watchResponse({ fragment: true, events: [putEvent("/app/a", "5")] }),
      watchResponse({ fragment: true, events: [putEvent("/app/b", "5")] }),
      watchResponse({ events: [putEvent("/app/c", "5")] }),
      watchResponse({}),
      watchResponse({ events: [putEvent("/app/d", "6")] }),
      watchResponse({ canceled: true, compact_revision: "4" }),
    ]);
    expect(await outcome).toEqual({ reason: "compacted", compactRevision: "4" });
    expect(batches.map((batch) => batch.header)).toEqual([
      DECODED_HEADER,
      DECODED_HEADER,
      DECODED_HEADER,
      DECODED_HEADER,
    ]);
    expect(batches.map((batch) => batch.events.map((event) => textOf(event.kv.key)))).toEqual([
      ["/app/a"],
      ["/app/b"],
      ["/app/c"],
      ["/app/d"],
    ]);
  });

  /** One watch over a recorded stream, counting the messages the adapter reads from it. */
  const watchCounted = async (messages: object[], onBatch: (batch: EtcdWatchBatch) => "continue" | "stop") => {
    const wire = recordedEtcdWire({ answers: { "Watch/Watch": [() => ({ messages, end: "open" })] } });
    const read = { messages: 0 };
    const client = await createGrpcEtcdClient(PLAINTEXT, {}, (channelOptions) => {
      const channel = wire.transport(channelOptions);
      return {
        ...channel,
        stream: (rpc, call) => {
          const stream = channel.stream(rpc, call);
          return {
            ...stream,
            read: () => {
              read.messages++;
              return stream.read();
            },
          };
        },
      };
    });
    const window = new AbortController();
    const outcome = client.watch({ key: bytes("/app/"), rangeEnd: bytes("/app0") }, onBatch, { signal: window.signal });
    return { wire, read, window, outcome };
  };
  const keysOf = (batch: EtcdWatchBatch) => batch.events.map((event) => textOf(event.kv.key));

  test("a stop inside a fragmented answer reads no fragment after it, so the bounds stop a watch inside one revision (spec 5.3, E14)", async () => {
    const batches: string[][] = [];
    const { wire, read, outcome } = await watchCounted(
      [
        watchResponse({ created: true }),
        watchResponse({ fragment: true, events: [putEvent("/app/a", "5"), putEvent("/app/b", "5")] }),
        watchResponse({ fragment: true, events: [putEvent("/app/c", "5")] }),
        watchResponse({ events: [putEvent("/app/d", "5")] }),
      ],
      (batch) => {
        batches.push(keysOf(batch));
        return "stop";
      },
    );
    expect(await outcome).toEqual({ reason: "stopped" });
    expect(batches).toEqual([["/app/a", "/app/b"]]);
    // The created answer and the first fragment: the two fragments after the stop were never read.
    expect(read.messages).toBe(2);
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("an abort inside a fragmented answer keeps every fragment that arrived before it, never a quiet window (spec 5.3)", async () => {
    const batches: string[][] = [];
    const { wire, window, outcome } = await watchCounted(
      [
        watchResponse({ created: true }),
        watchResponse({ fragment: true, events: [putEvent("/app/a", "5")] }),
        watchResponse({ fragment: true, events: [putEvent("/app/b", "5")] }),
      ],
      (batch) => {
        batches.push(keysOf(batch));
        return "continue";
      },
    );
    // The last fragment never arrives: the window closes while etcd is still sending the answer.
    await Bun.sleep(20);
    window.abort();
    expect(await outcome).toEqual({ reason: "aborted" });
    expect(batches).toEqual([["/app/a"], ["/app/b"]]);
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("a delete event and a previous value are decoded as the seam spells them", async () => {
    const { batches, outcome } = await watchOnce([
      watchResponse({ events: [{ type: "DELETE", kv: kv("/app/a", "", "6"), prev_kv: kv("/app/a", "old", "5") }] }),
      watchResponse({ canceled: true, compact_revision: "4" }),
    ]);
    await outcome;
    expect(batches[0].events).toEqual([
      {
        type: "delete",
        kv: { key: bytes("/app/a"), value: bytes(""), createRevision: "5", modRevision: "6", version: "2", lease: "0" },
        prevKv: {
          key: bytes("/app/a"),
          value: bytes("old"),
          createRevision: "5",
          modRevision: "5",
          version: "2",
          lease: "0",
        },
      },
    ]);
  });

  test("onBatch answering stop ends the watch, and the stream is cancelled", async () => {
    const { wire, client } = await recorded({
      answers: {
        "Watch/Watch": [() => ({ messages: [watchResponse({ events: [putEvent("/app/a", "5")] })], end: "open" })],
      },
    });
    expect(await client.watch({ key: bytes("/app/") }, () => "stop", options)).toEqual({ reason: "stopped" });
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("a cancellation that is no renewal answer ends the watch with etcd's reason, verbatim", async () => {
    const { wire, outcome } = await watchOnce([
      watchResponse({ canceled: true, cancel_reason: "etcdserver: a new reason" }),
    ]);
    expect(await outcome).toEqual({ reason: "canceled", cancelReason: "etcdserver: a new reason" });
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("the stream ending without a cancellation is an error naming it, never a quiet window (Review Focus 3)", async () => {
    const { wire, outcome } = await watchOnce([watchResponse({ created: true })], "server-end");
    const error = await failure(outcome);
    expect(error).toMatchObject({
      category: "unavailable",
      detail: "etcd ended the watch stream before it cancelled the watch",
    });
    expect(toProviderError(error, context("watch", false)).message).toStartWith("etcd did not answer the watch.");
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("the answering member stopping during a watch ends it with the transport's cause (Review Focus 3)", async () => {
    const { wire, outcome } = await watchOnce([watchResponse({ created: true })], {
      error: statusError(14, "Connection dropped"),
    });
    const error = await failure(outcome);
    expect(error).toMatchObject({ category: "unavailable", detail: "Connection dropped", grpcCode: 14 });
    expect(toProviderError(error, context("watch", false)).message).toBe(
      "etcd did not answer the watch. (Connection dropped)",
    );
    expect(wire.cancels).toEqual(["Watch/Watch"]);
  });

  test("the caller's abort ends the watch as aborted, and the stream is cancelled; an abort before it opens nothing", async () => {
    const { wire, client } = await recorded({
      answers: { "Watch/Watch": [() => ({ messages: [watchResponse({ created: true })], end: "open" })] },
    });
    const window = new AbortController();
    const watching = client.watch({ key: bytes("/app/") }, () => "continue", { signal: window.signal });
    await Bun.sleep(20);
    window.abort();
    expect(await watching).toEqual({ reason: "aborted" });
    expect(wire.cancels).toEqual(["Watch/Watch"]);
    const before = new AbortController();
    before.abort();
    expect(await client.watch({ key: bytes("/app/") }, () => "continue", { signal: before.signal })).toEqual({
      reason: "aborted",
    });
    expect(wire.calls).toHaveLength(1);
  });

  test("an event with no key-value, or of a type this client does not read, is refused in words", async () => {
    const missing = await watchOnce([watchResponse({ events: [{ type: "PUT", kv: null, prev_kv: null }] })]);
    expect(await failure(missing.outcome)).toMatchObject({
      category: "unknown",
      detail: "etcd sent a watch event with no key-value",
    });
    expect(missing.wire.cancels).toEqual(["Watch/Watch"]);
    const unknown = await watchOnce([watchResponse({ events: [{ ...putEvent("/app/a", "5"), type: 2 }] })]);
    expect(await failure(unknown.outcome)).toMatchObject({
      category: "unknown",
      detail: "etcd answered a watch event type 2, which this client does not read",
    });
  });

  test("an answer without a header is refused in words", async () => {
    const { outcome } = await watchOnce([watchResponse({ header: null })]);
    expect(await failure(outcome)).toMatchObject({
      category: "unknown",
      detail: "etcd's answer to Watch/Watch carried no response header",
    });
  });

  test("a keep-alive the server ends before it answers, or fails, is an error, and its stream is cancelled", async () => {
    const ended = await recorded({
      answers: { "Lease/LeaseKeepAlive": [() => ({ messages: [], end: "server-end" })] },
    });
    expect(await failure(ended.client.leaseKeepAliveOnce("1", options))).toMatchObject({
      category: "unavailable",
      detail: "etcd ended the keep-alive stream before it answered",
    });
    expect(ended.wire.cancels).toEqual(["Lease/LeaseKeepAlive"]);
    const failed = await recorded({
      answers: {
        "Lease/LeaseKeepAlive": [
          () => ({ messages: [], end: { error: statusError(5, "etcdserver: requested lease not found") } }),
        ],
      },
    });
    expect(await failure(failed.client.leaseKeepAliveOnce("1", options))).toMatchObject({
      category: "lease-not-found",
    });
    expect(failed.wire.cancels).toEqual(["Lease/LeaseKeepAlive"]);
  });

  test("a keep-alive whose signal aborted first opens no stream, and one aborted while it waits is cancelled", async () => {
    const { wire, client } = await recorded({
      answers: { "Lease/LeaseKeepAlive": [() => ({ messages: [], end: "open" })] },
    });
    const before = new AbortController();
    before.abort();
    expect(await failure(client.leaseKeepAliveOnce("1", { signal: before.signal }))).toMatchObject({
      category: "cancelled",
    });
    expect(wire.calls).toEqual([]);
    const during = new AbortController();
    const waiting = client.leaseKeepAliveOnce("1", { signal: during.signal });
    await Bun.sleep(20);
    during.abort();
    expect(await failure(waiting)).toMatchObject({ category: "cancelled", detail: "Cancelled on client" });
    expect(wire.cancels).toEqual(["Lease/LeaseKeepAlive"]);
  });
});

describe("requests and answers the adapter maps (plan C1, spec E14)", () => {
  test("a txn's compares, one per target, and its three kinds of request, with every flag", async () => {
    const { wire, client } = await recorded({ answers: { "KV/Txn": [() => MINIMAL["KV/Txn"]] } });
    const key = bytes("/app/cfg");
    await client.txn(
      {
        compare: [
          { key, target: "version", result: "equal", operand: "2" },
          { key, target: "create", result: "greater", operand: "0" },
          { key, target: "mod", result: "less", operand: "9" },
          { key, rangeEnd: bytes("/app0"), target: "value", result: "not-equal", operand: bytes("v") },
          { key, target: "lease", result: "equal", operand: "7587863092875085000" },
        ],
        success: [
          {
            op: "put",
            request: {
              key,
              value: bytes("v2"),
              lease: "7587863092875085000",
              prevKv: true,
              ignoreValue: true,
              ignoreLease: true,
            },
          },
          { op: "delete", request: { key, rangeEnd: bytes("/app0"), prevKv: true } },
        ],
        failure: [
          {
            op: "range",
            request: {
              key,
              rangeEnd: bytes("/app0"),
              limit: 50,
              revision: "9",
              keysOnly: true,
              countOnly: true,
              serializable: true,
            },
          },
        ],
      },
      options,
    );
    expect(wire.calls[0].request).toEqual({
      compare: [
        { result: "EQUAL", target: "VERSION", key, version: "2" },
        { result: "GREATER", target: "CREATE", key, create_revision: "0" },
        { result: "LESS", target: "MOD", key, mod_revision: "9" },
        { result: "NOT_EQUAL", target: "VALUE", key, range_end: bytes("/app0"), value: bytes("v") },
        { result: "EQUAL", target: "LEASE", key, lease: "7587863092875085000" },
      ],
      success: [
        {
          request_put: {
            key,
            value: bytes("v2"),
            lease: "7587863092875085000",
            prev_kv: true,
            ignore_value: true,
            ignore_lease: true,
          },
        },
        { request_delete_range: { key, range_end: bytes("/app0"), prev_kv: true } },
      ],
      failure: [
        {
          request_range: {
            key,
            range_end: bytes("/app0"),
            limit: "50",
            revision: "9",
            serializable: true,
            keys_only: true,
            count_only: true,
          },
        },
      ],
    });
  });

  test("a txn's answers of each kind are decoded, a put's previous pair included", async () => {
    const { client } = await recorded({
      answers: {
        "KV/Txn": [
          () => ({
            header: HEADER,
            succeeded: true,
            responses: [
              { response_range: rangeAnswer(kv("/a", "1")) },
              { response_put: { header: HEADER, prev_kv: kv("/a", "0") } },
              { response_put: { header: HEADER, prev_kv: null } },
              { response_delete_range: { header: HEADER, deleted: "1", prev_kvs: [kv("/b", "2")] } },
            ],
          }),
        ],
      },
    });
    const answer = await INVOKE["KV/Txn"](client);
    expect(answer).toEqual({
      header: DECODED_HEADER,
      succeeded: true,
      responses: [
        {
          op: "range",
          response: {
            header: DECODED_HEADER,
            kvs: [
              { key: bytes("/a"), value: bytes("1"), createRevision: "5", modRevision: "9", version: "2", lease: "0" },
            ],
            more: false,
            count: "1",
          },
        },
        {
          op: "put",
          response: {
            header: DECODED_HEADER,
            prevKv: {
              key: bytes("/a"),
              value: bytes("0"),
              createRevision: "5",
              modRevision: "9",
              version: "2",
              lease: "0",
            },
          },
        },
        { op: "put", response: { header: DECODED_HEADER } },
        {
          op: "delete",
          response: {
            header: DECODED_HEADER,
            deleted: "1",
            prevKvs: [
              { key: bytes("/b"), value: bytes("2"), createRevision: "5", modRevision: "9", version: "2", lease: "0" },
            ],
          },
        },
      ],
    });
  });

  test("a delete sends its range and prev_kv, and decodes the pairs it deleted", async () => {
    const { wire, client } = await recorded({
      answers: { "KV/DeleteRange": [() => ({ header: HEADER, deleted: "1", prev_kvs: [kv("/a", "1")] })] },
    });
    const answer = await client.deleteRange({ key: bytes("/a"), rangeEnd: bytes("/b"), prevKv: true }, options);
    expect(wire.calls[0].request).toEqual({ key: bytes("/a"), range_end: bytes("/b"), prev_kv: true });
    expect(answer).toEqual({
      header: DECODED_HEADER,
      deleted: "1",
      prevKvs: [
        { key: bytes("/a"), value: bytes("1"), createRevision: "5", modRevision: "9", version: "2", lease: "0" },
      ],
    });
  });

  test("members, status, time-to-live, leases, users and roles are decoded field for field", async () => {
    const { wire, client } = await recorded({
      answers: {
        "Cluster/MemberList": [
          () => ({
            header: HEADER,
            members: [
              {
                ID: "10276657743932975437",
                name: "etcd-1",
                peerURLs: ["http://etcd-1:2380"],
                clientURLs: ["http://127.0.0.2:2379"],
                isLearner: false,
              },
            ],
          }),
        ],
        "Maintenance/Status": [
          () => ({ ...MINIMAL["Maintenance/Status"], errors: ["a member error"], isLearner: true }),
        ],
        "Lease/LeaseTimeToLive": [
          () => ({
            header: HEADER,
            ID: "7587863092875085001",
            TTL: "31535000",
            grantedTTL: "31536000",
            keys: [bytes("/leases/session-2")],
          }),
        ],
        "Lease/LeaseLeases": [
          () => ({ header: HEADER, leases: [{ ID: "7587863092875085000" }, { ID: "7587863092875085001" }] }),
        ],
        "Lease/LeaseRevoke": [() => MINIMAL["Lease/LeaseRevoke"]],
        "Auth/UserList": [() => MINIMAL["Auth/UserList"]],
        "Auth/UserGet": [() => MINIMAL["Auth/UserGet"]],
        "Auth/RoleList": [() => MINIMAL["Auth/RoleList"]],
        "Auth/RoleGet": [
          () => ({
            header: HEADER,
            perm: [
              { permType: "READ", key: bytes("/app/"), range_end: bytes("/app0") },
              { permType: "WRITE", key: bytes("/config/a"), range_end: Buffer.alloc(0) },
              { permType: "READWRITE", key: Buffer.from([0]), range_end: Buffer.from([0]) },
            ],
          }),
        ],
        "Auth/AuthStatus": [() => ({ header: HEADER, enabled: true, authRevision: "12" })],
      },
    });
    expect(await INVOKE["Cluster/MemberList"](client)).toEqual({
      header: DECODED_HEADER,
      members: [
        {
          id: "10276657743932975437",
          name: "etcd-1",
          peerUrls: ["http://etcd-1:2380"],
          clientUrls: ["http://127.0.0.2:2379"],
          isLearner: false,
        },
      ],
    });
    expect(await INVOKE["Maintenance/Status"](client)).toEqual({
      header: DECODED_HEADER,
      version: "3.7.2",
      dbSize: "20480",
      dbSizeInUse: "16384",
      dbSizeQuota: "0",
      leader: "10276657743932975437",
      raftIndex: "44",
      raftTerm: "2",
      raftAppliedIndex: "44",
      errors: ["a member error"],
      isLearner: true,
      storageVersion: "3.7.0",
    });
    expect(await INVOKE["Lease/LeaseTimeToLive"](client)).toEqual({
      header: DECODED_HEADER,
      id: "7587863092875085001",
      ttl: "31535000",
      grantedTtl: "31536000",
      keys: [bytes("/leases/session-2")],
    });
    expect(await INVOKE["Lease/LeaseLeases"](client)).toEqual({
      header: DECODED_HEADER,
      ids: ["7587863092875085000", "7587863092875085001"],
    });
    expect(await INVOKE["Lease/LeaseRevoke"](client)).toEqual({ header: DECODED_HEADER });
    expect(await INVOKE["Auth/UserList"](client)).toEqual(["root"]);
    expect(await INVOKE["Auth/UserGet"](client)).toEqual(["reader"]);
    expect(await INVOKE["Auth/RoleList"](client)).toEqual(["reader", "root"]);
    expect(await INVOKE["Auth/RoleGet"](client)).toEqual([
      { type: "read", key: bytes("/app/"), rangeEnd: bytes("/app0") },
      { type: "write", key: bytes("/config/a") },
      { type: "readwrite", key: Buffer.from([0]), rangeEnd: Buffer.from([0]) },
    ]);
    expect(await INVOKE["Auth/AuthStatus"](client)).toEqual({ enabled: true, authRevision: "12" });
    expect(wire.calls.map((call) => [call.rpc, call.request])).toEqual([
      ["Cluster/MemberList", { linearizable: true }],
      ["Maintenance/Status", {}],
      ["Lease/LeaseTimeToLive", { ID: "7587863092875085001", keys: true }],
      ["Lease/LeaseLeases", {}],
      ["Lease/LeaseRevoke", { ID: "7587863092875085100" }],
      ["Auth/UserList", {}],
      ["Auth/UserGet", { name: "reader" }],
      ["Auth/RoleList", {}],
      ["Auth/RoleGet", { role: "reader" }],
      ["Auth/AuthStatus", {}],
    ]);
  });

  test("alarms: a GET sends the GET alone, a DEACTIVATE the exact pair, and each type decodes", async () => {
    const { wire, client } = await recorded({
      answers: {
        "Maintenance/Alarm": [
          () => ({
            header: HEADER,
            alarms: [
              { memberID: "18446744073709551615", alarm: "NOSPACE" },
              { memberID: "1", alarm: "CORRUPT" },
            ],
          }),
          () => ({ header: HEADER, alarms: [{ memberID: "18446744073709551615", alarm: "CORRUPT" }] }),
        ],
      },
    });
    expect(await client.alarmList(options)).toEqual([
      { memberId: "18446744073709551615", alarm: "nospace" },
      { memberId: "1", alarm: "corrupt" },
    ]);
    expect(await client.alarmDisarm({ memberId: "18446744073709551615", alarm: "corrupt" }, options)).toEqual([
      { memberId: "18446744073709551615", alarm: "corrupt" },
    ]);
    expect(wire.calls.map((call) => call.request)).toEqual([
      { action: "GET" },
      { action: "DEACTIVATE", memberID: "18446744073709551615", alarm: "CORRUPT" },
    ]);
  });

  test("a compaction is physical, and a lease grant sends its TTL alone", async () => {
    const { wire, client } = await recorded({
      answers: {
        "KV/Compact": [() => MINIMAL["KV/Compact"]],
        "Lease/LeaseGrant": [
          () => MINIMAL["Lease/LeaseGrant"],
          () => ({ ...MINIMAL["Lease/LeaseGrant"], error: "lessor: a legacy error" }),
        ],
      },
    });
    await client.compact("40", options);
    expect(await client.leaseGrant(60, options)).toEqual({
      header: DECODED_HEADER,
      id: "7587863092875085100",
      ttl: "60",
    });
    expect(wire.calls.map((call) => call.request)).toEqual([{ revision: "40", physical: true }, { TTL: "60" }]);
    // A grant answer carrying an error text is refused with it, never read as a lease.
    expect(await failure(client.leaseGrant(60, options))).toMatchObject({
      category: "unknown",
      detail: "lessor: a legacy error",
    });
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "a Range limit of %p is refused before anything is sent, in words that never repeat it (spec E14)",
    async (limit) => {
      const { wire, client } = await recorded();
      // A validation refusal never echoes the value it refuses (plan Global Constraints).
      const refusal = new RangeError("Every Range carries a positive whole limit (spec E14); nothing was sent");
      const read = await failure(client.range({ key: bytes("/a"), limit }, options));
      expect(read).toBeInstanceOf(RangeError);
      expect((read as Error).message).toBe(refusal.message);
      const txn = await failure(
        client.txn(
          { compare: [], success: [{ op: "range", request: { key: bytes("/a"), limit } }], failure: [] },
          options,
        ),
      );
      expect(txn).toBeInstanceOf(RangeError);
      expect((txn as Error).message).toBe(refusal.message);
      expect(wire.calls).toEqual([]);
    },
  );

  /** Every place a seam call hands the adapter a 64-bit integer, each sent with a value protobufjs would change. */
  const INT64_SITES: ReadonlyArray<readonly [string, (client: EtcdClient, value: string) => Promise<unknown>]> = [
    ["RangeRequest.revision", (c, v) => c.range({ key: bytes("/a"), limit: 1, revision: v }, options)],
    [
      "Compare.version",
      (c, v) =>
        c.txn(
          { compare: [{ key: bytes("/a"), target: "version", result: "equal", operand: v }], success: [], failure: [] },
          options,
        ),
    ],
    [
      "Compare.create_revision",
      (c, v) =>
        c.txn(
          { compare: [{ key: bytes("/a"), target: "create", result: "equal", operand: v }], success: [], failure: [] },
          options,
        ),
    ],
    [
      "Compare.mod_revision",
      (c, v) =>
        c.txn(
          { compare: [{ key: bytes("/a"), target: "mod", result: "equal", operand: v }], success: [], failure: [] },
          options,
        ),
    ],
    [
      "Compare.lease",
      (c, v) =>
        c.txn(
          { compare: [{ key: bytes("/a"), target: "lease", result: "equal", operand: v }], success: [], failure: [] },
          options,
        ),
    ],
    [
      "PutRequest.lease",
      (c, v) =>
        c.txn(
          {
            compare: [],
            success: [{ op: "put", request: { key: bytes("/a"), value: bytes("v"), lease: v } }],
            failure: [],
          },
          options,
        ),
    ],
    [
      "RangeRequest.revision",
      (c, v) =>
        c.txn(
          {
            compare: [],
            success: [],
            failure: [{ op: "range", request: { key: bytes("/a"), limit: 1, revision: v } }],
          },
          options,
        ),
    ],
    [
      "WatchCreateRequest.start_revision",
      (c, v) => c.watch({ key: bytes("/a"), startRevision: v }, () => "stop", options),
    ],
    ["LeaseRevokeRequest.ID", (c, v) => c.leaseRevoke(v, options)],
    ["LeaseKeepAliveRequest.ID", (c, v) => c.leaseKeepAliveOnce(v, options)],
    ["LeaseTimeToLiveRequest.ID", (c, v) => c.leaseTimeToLive(v, false, options)],
    ["CompactionRequest.revision", (c, v) => c.compact(v, options)],
  ];
  // Measured on protobufjs 7.6.6: "1.5" encodes as 1, "abc" and "" as 0, and 2^63 as -2^63, with no error.
  const MALFORMED = ["1.5", "abc", "", " 7", "0x10", "9223372036854775808", "-9223372036854775809"];
  test.each(INT64_SITES)(
    "%s takes a decimal 64-bit integer, and anything else is refused with nothing sent",
    async (field, run) => {
      for (const value of MALFORMED) {
        // oxlint-disable-next-line no-await-in-loop -- each value gets a recorded channel of its own, one after another.
        const { wire, client } = await recorded();
        // oxlint-disable-next-line no-await-in-loop -- the one call on that channel.
        const error = await failure(run(client, value));
        expect({ value, error }).toEqual({
          value,
          error: new RangeError(`${field} takes a decimal 64-bit integer; nothing was sent`),
        });
        expect(wire.calls).toEqual([]);
      }
    },
  );

  test("the bounds are the field's own: a signed field takes both ends of int64, a member id every uint64", async () => {
    const { wire, client } = await recorded({
      answers: {
        "KV/Compact": [() => MINIMAL["KV/Compact"], () => MINIMAL["KV/Compact"]],
        "Maintenance/Alarm": [() => MINIMAL["Maintenance/Alarm"], () => MINIMAL["Maintenance/Alarm"]],
      },
    });
    await client.compact("9223372036854775807", options);
    await client.compact("-9223372036854775808", options);
    await client.alarmDisarm({ memberId: "0", alarm: "nospace" }, options);
    await client.alarmDisarm({ memberId: "18446744073709551615", alarm: "nospace" }, options);
    expect(wire.calls).toHaveLength(4);
    for (const memberId of ["18446744073709551616", "-1", "1.5", "abc"]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another, on the same channel.
      const error = await failure(client.alarmDisarm({ memberId, alarm: "nospace" }, options));
      expect({ memberId, error }).toEqual({
        memberId,
        error: new RangeError("AlarmRequest.memberID takes a decimal unsigned 64-bit integer; nothing was sent"),
      });
    }
    expect(wire.calls).toHaveLength(4);
  });

  test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21])(
    "a lease grant TTL of %p, which protobufjs would send as another number, is refused with nothing sent",
    async (ttl) => {
      const { wire, client } = await recorded();
      expect(await failure(client.leaseGrant(ttl, options))).toEqual(
        new RangeError("LeaseGrantRequest.TTL takes a decimal 64-bit integer; nothing was sent"),
      );
      expect(wire.calls).toEqual([]);
    },
  );

  test("a compare whose operand is not the kind its target takes is refused before anything is sent", async () => {
    const { wire, client } = await recorded();
    const key = bytes("/a");
    const txn = (compare: object) => client.txn({ compare: [compare as never], success: [], failure: [] }, options);
    for (const target of ["version", "create", "mod", "lease"]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another, on the same channel.
      const error = await failure(txn({ key, target, result: "equal", operand: bytes("9") }));
      expect(error).toEqual(new TypeError(`A ${target} compare takes a decimal string as its operand (plan C1)`));
    }
    expect(await failure(txn({ key, target: "value", result: "equal", operand: "v" }))).toEqual(
      new TypeError("A value compare takes bytes as its operand (plan C1)"),
    );
    expect(wire.calls).toEqual([]);
  });

  test("an answer with no header, a txn answer this client never asks for, and a type this client does not read are refused in words", async () => {
    const { client } = await recorded({
      answers: {
        "KV/Range": [() => ({ ...rangeAnswer(), header: null })],
        "KV/Txn": [() => ({ header: HEADER, succeeded: true, responses: [{ response_txn: { header: HEADER } }] })],
        "Maintenance/Alarm": [
          () => ({ header: HEADER, alarms: [{ memberID: "1", alarm: "NONE" }] }),
          () => ({ header: HEADER, alarms: [{ memberID: "1", alarm: 3 }] }),
        ],
        "Auth/RoleGet": [() => ({ header: HEADER, perm: [{ permType: 3, key: bytes("/a"), range_end: bytes("") }] })],
      },
    });
    expect(await failure(INVOKE["KV/Range"](client))).toMatchObject({
      category: "unknown",
      detail: "etcd's answer to KV/Range carried no response header",
    });
    expect(await failure(INVOKE["KV/Txn"](client))).toMatchObject({
      category: "unknown",
      detail: "etcd answered a txn request with a response this client never asks for",
    });
    expect(await failure(INVOKE["Maintenance/Alarm"](client))).toMatchObject({
      category: "unknown",
      detail: "etcd answered an alarm type NONE, which this client does not read",
    });
    expect(await failure(INVOKE["Maintenance/Alarm"](client))).toMatchObject({
      category: "unknown",
      detail: "etcd answered an alarm type 3, which this client does not read",
    });
    expect(await failure(INVOKE["Auth/RoleGet"](client))).toMatchObject({
      category: "unknown",
      detail: "etcd answered a permission type 3, which this client does not read",
    });
  });

  test("a call whose signal aborted first sends nothing, and reads as a cancel or, for a timeout, as a deadline", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const timedOut = new AbortController();
    timedOut.abort(new DOMException("The operation timed out.", "TimeoutError"));
    for (const rpc of Object.keys(INVOKE) as EtcdUnaryRpc[]) {
      // oxlint-disable-next-line no-await-in-loop -- each rpc gets a recorded channel of its own, one after another.
      const { wire, client } = await recorded({}, PASSWORD);
      // oxlint-disable-next-line no-await-in-loop -- the first of the two calls on that channel.
      const cancel = await failure(INVOKE[rpc](client, { signal: cancelled.signal }));
      // oxlint-disable-next-line no-await-in-loop -- the second.
      const deadline = await failure(INVOKE[rpc](client, { signal: timedOut.signal }));
      expect({ rpc, cancel, deadline }).toMatchObject({
        rpc,
        cancel: { category: "cancelled" },
        deadline: { category: "deadline-exceeded" },
      });
      expect(wire.calls).toEqual([]);
    }
  });
});

describe("the one channel and close() (spec E3, E16)", () => {
  test("the factory opens one channel with the options and sends nothing, and it is an EtcdClientFactory", async () => {
    const factory: EtcdClientFactory<EtcdConnectionOptions> = createGrpcEtcdClient;
    expect(factory).toBe(createGrpcEtcdClient);
    const { wire } = await recorded({}, PASSWORD);
    expect(wire.opened).toHaveLength(1);
    expect(wire.opened[0]).toBe(PASSWORD);
    expect(wire.calls).toEqual([]);
  });

  test("a member's client URLs are data: no second channel is opened for them", async () => {
    const { wire, client } = await recorded({
      answers: {
        "Cluster/MemberList": [
          () => ({
            header: HEADER,
            members: [
              { ID: "2", name: "etcd-2", peerURLs: [], clientURLs: ["http://10.9.8.7:2379"], isLearner: false },
            ],
          }),
        ],
        "KV/Range": [() => rangeAnswer()],
      },
    });
    await INVOKE["Cluster/MemberList"](client);
    await INVOKE["KV/Range"](client);
    expect(wire.opened).toEqual([PLAINTEXT]);
  });

  test("close() closes the channel once, and every later call rejects as closed, sending nothing", async () => {
    const { wire, client } = await recorded({}, PASSWORD);
    await client.close();
    await client.close();
    expect(wire.closes).toBe(1);
    for (const rpc of Object.keys(INVOKE) as EtcdUnaryRpc[]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another, on the same closed client.
      expect({ rpc, error: await failure(INVOKE[rpc](client)) }).toMatchObject({
        rpc,
        error: { category: "closed", detail: "The client is closed" },
      });
    }
    expect(await failure(client.watch({ key: bytes("/a") }, () => "continue", options))).toMatchObject({
      category: "closed",
    });
    expect(await failure(client.leaseKeepAliveOnce("1", options))).toMatchObject({ category: "closed" });
    expect(wire.calls).toEqual([]);
  });

  test("a leader change and the answering member stopping are raised once, and a write's outcome is unknown (Review Focus 3)", async () => {
    const { wire, client } = await recorded({
      answers: {
        "KV/Range": [refuse(14, "etcdserver: leader changed")],
        "KV/Txn": [refuse(14, "Connection dropped")],
        "Maintenance/Status": [() => MINIMAL["Maintenance/Status"]],
      },
    });
    const read = await failure(INVOKE["KV/Range"](client));
    expect(read).toMatchObject({ category: "unavailable", detail: "etcdserver: leader changed" });
    const write = await failure(
      client.txn(
        { compare: [], success: [{ op: "put", request: { key: bytes("/a"), value: bytes("v") } }], failure: [] },
        options,
      ),
    );
    expect(write).toMatchObject({ category: "unavailable", detail: "Connection dropped" });
    expect(toProviderError(write, context("put", true)).message).toBe(
      "etcd did not confirm the put: the connection failed after the request was sent. (Connection dropped) The write may have been applied: read the key again before you run the command again.",
    );
    // The next command goes over the same channel, which grpc-js's pick_first moves to a live member.
    await INVOKE["Maintenance/Status"](client);
    expect(wire.opened).toHaveLength(1);
    expect(wire.calls.map((call) => call.rpc)).toEqual(["KV/Range", "KV/Txn", "Maintenance/Status"]);
  });
});

// -- over grpc-js, against local servers this file starts --------------------------------------------------------

const LOADED = fromJSON(ETCD_DESCRIPTOR, ETCD_LOADER_OPTIONS);
const service = (name: string) => LOADED[`etcdserverpb.${name}`] as unknown as ServiceDefinition;
type Unary = (call: ServerUnaryCall<Record<string, unknown>, object>, callback: sendUnaryData<object>) => void;
type Bidi = (call: ServerDuplexStream<Record<string, unknown>, object>) => void;

async function serve(
  implementations: Readonly<Record<string, Readonly<Record<string, Unary | Bidi>>>>,
  address = "127.0.0.1:0",
  serverCredentials = ServerCredentials.createInsecure(),
): Promise<{ readonly server: Server; readonly port: number }> {
  const server = new Server();
  for (const [name, implementation] of Object.entries(implementations))
    server.addService(service(name), implementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(address, serverCredentials, (error, bound) => (error ? reject(error) : resolve(bound))),
  );
  return { server, port };
}

const at = (port: number, overrides: Partial<EtcdConnectionOptions> = {}): EtcdConnectionOptions => ({
  ...PLAINTEXT,
  target: `dns:127.0.0.1:${port}`,
  endpoint: { host: "127.0.0.1", port },
  ...overrides,
});

const answering =
  (answer: object): Unary =>
  (_call, callback) =>
    callback(null, answer);

/** Waits, two seconds at most, until `condition` holds: a server's own events arrive after the client's answer. */
async function eventually(condition: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- a poll: each check waits for the one before it.
  for (let waited = 0; waited < 2000 && !condition(); waited += 20) await Bun.sleep(20);
}

async function closedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

describe("over grpc-js: the wire both ways", () => {
  test("every unary seam method round-trips: the server decodes the request, the adapter the answer", async () => {
    const seen: Array<{
      readonly method: string;
      readonly request: unknown;
      readonly metadata: Record<string, unknown>;
    }> = [];
    const recording =
      (method: string, answer: object): Unary =>
      (call, callback) => {
        seen.push({ method, request: call.request, metadata: call.metadata.getMap() });
        callback(null, answer);
      };
    const { server, port } = await serve({
      KV: {
        Range: recording("Range", rangeAnswer(kv("/app/cfg", '{"mode":"blue"}'))),
        DeleteRange: recording("DeleteRange", { header: HEADER, deleted: "1", prev_kvs: [kv("/a", "1")] }),
        Txn: recording("Txn", {
          header: HEADER,
          succeeded: false,
          responses: [{ response_range: rangeAnswer(kv("/a", "2")) }],
        }),
        Compact: recording("Compact", { header: HEADER }),
      },
      Lease: {
        LeaseGrant: recording("LeaseGrant", MINIMAL["Lease/LeaseGrant"]),
        LeaseRevoke: recording("LeaseRevoke", MINIMAL["Lease/LeaseRevoke"]),
        LeaseTimeToLive: recording("LeaseTimeToLive", MINIMAL["Lease/LeaseTimeToLive"]),
        LeaseLeases: recording("LeaseLeases", { header: HEADER, leases: [{ ID: "7587863092875085000" }] }),
      },
      Cluster: { MemberList: recording("MemberList", MINIMAL["Cluster/MemberList"]) },
      Maintenance: {
        Status: recording("Status", MINIMAL["Maintenance/Status"]),
        Alarm: recording("Alarm", { header: HEADER, alarms: [{ memberID: "18446744073709551615", alarm: "NOSPACE" }] }),
        Defragment: recording("Defragment", {}),
      },
      Auth: {
        AuthStatus: recording("AuthStatus", MINIMAL["Auth/AuthStatus"]),
        Authenticate: recording("Authenticate", { header: HEADER, token: "token-1" }),
        UserList: recording("UserList", MINIMAL["Auth/UserList"]),
        UserGet: recording("UserGet", MINIMAL["Auth/UserGet"]),
        RoleList: recording("RoleList", MINIMAL["Auth/RoleList"]),
        RoleGet: recording("RoleGet", {
          header: HEADER,
          perm: [{ permType: "READ", key: bytes("/app/"), range_end: bytes("/app0") }],
        }),
      },
    });
    const client = await createGrpcEtcdClient(
      at(port, { auth: { kind: "password", user: "root", password: TEST_PASSWORD } }),
    );
    try {
      await client.authenticate(options);
      const range = await client.range(
        { key: bytes("/app/"), rangeEnd: bytes("/app0"), limit: 500, revision: "39" },
        options,
      );
      expect(textOf(range.kvs[0].value)).toBe('{"mode":"blue"}');
      expect(range.header).toEqual(DECODED_HEADER);
      expect(await client.deleteRange({ key: bytes("/a"), prevKv: true }, options)).toMatchObject({ deleted: "1" });
      const txn = await client.txn(
        {
          compare: [{ key: bytes("/a"), target: "mod", result: "equal", operand: "0" }],
          success: [{ op: "put", request: { key: bytes("/a"), value: bytes("v"), ignoreLease: true } }],
          failure: [{ op: "range", request: { key: bytes("/a"), limit: 1 } }],
        },
        options,
      );
      expect(txn.succeeded).toBe(false);
      expect(txn.responses.map((op) => op.op)).toEqual(["range"]);
      await client.compact("40", options);
      expect(await client.leaseGrant(60, options)).toMatchObject({ id: "7587863092875085100", ttl: "60" });
      await client.leaseRevoke("7587863092875085100", options);
      expect(await client.leaseTimeToLive("7587863092875085001", true, options)).toMatchObject({ grantedTtl: "60" });
      expect(await client.leaseLeases(options)).toMatchObject({ ids: ["7587863092875085000"] });
      await client.memberList({ linearizable: false }, options);
      expect(await client.status(options)).toMatchObject({ version: "3.7.2", leader: "10276657743932975437" });
      expect(await client.alarmDisarm({ memberId: "18446744073709551615", alarm: "nospace" }, options)).toEqual([
        { memberId: "18446744073709551615", alarm: "nospace" },
      ]);
      await client.defragment(options);
      await client.authStatus(options);
      await client.userList(options);
      await client.userGet("reader", options);
      await client.roleList(options);
      expect(await client.roleGet("reader", options)).toEqual([
        { type: "read", key: bytes("/app/"), rangeEnd: bytes("/app0") },
      ]);
    } finally {
      await client.close();
      server.forceShutdown();
    }
    const request = (method: string) => seen.find((entry) => entry.method === method)?.request;
    expect(request("Authenticate")).toEqual({ name: "root", password: TEST_PASSWORD });
    // Spec E14: the server reads the default sort and no revision filter, and the limit the adapter set.
    expect(request("Range")).toMatchObject({
      key: bytes("/app/"),
      range_end: bytes("/app0"),
      limit: "500",
      revision: "39",
      sort_order: "NONE",
      sort_target: "KEY",
      min_mod_revision: "0",
      max_mod_revision: "0",
      min_create_revision: "0",
      max_create_revision: "0",
    });
    expect(request("Txn")).toMatchObject({
      compare: [{ result: "EQUAL", target: "MOD", key: bytes("/a"), mod_revision: "0" }],
      success: [{ request_put: { key: bytes("/a"), value: bytes("v"), ignore_lease: true } }],
      failure: [{ request_range: { key: bytes("/a"), limit: "1" } }],
    });
    expect(request("Compact")).toEqual({ revision: "40", physical: true });
    // Spec 7.2: the decoded AlarmRequest carries both halves of the pair a GET answered.
    expect(request("Alarm")).toEqual({ action: "DEACTIVATE", memberID: "18446744073709551615", alarm: "NOSPACE" });
    expect(request("MemberList")).toEqual({ linearizable: false });
    expect(request("LeaseGrant")).toEqual({ TTL: "60", ID: "0" });
    const metadata = (method: string) => seen.find((entry) => entry.method === method)?.metadata;
    expect(metadata("Authenticate")).not.toHaveProperty("token");
    expect(metadata("Authenticate")).toMatchObject({ hasleader: "true" });
    expect(metadata("Range")).toMatchObject({ token: "token-1", hasleader: "true" });
    expect(metadata("Status")).toMatchObject({ token: "token-1" });
    expect(metadata("Status")).not.toHaveProperty("hasleader");
  }, 20_000);

  test("a watch: a stop on the first fragment of an answer ends it there, and the server sees the stream cancelled", async () => {
    let cancelled = false;
    let created: unknown;
    const { server, port } = await serve({
      Watch: {
        Watch: ((call) => {
          call.on("cancelled", () => {
            cancelled = true;
          });
          call.on("data", (message: Record<string, unknown>) => {
            created = message;
            call.write({ header: HEADER, created: true });
            call.write({ header: HEADER, fragment: true, events: [{ type: "PUT", kv: kv("/app/a", "1", "41") }] });
            call.write({ header: HEADER, events: [{ type: "PUT", kv: kv("/app/b", "2", "41") }] });
          });
        }) satisfies Bidi,
      },
    });
    const client = await createGrpcEtcdClient(at(port));
    try {
      const keys: string[] = [];
      const end = await client.watch(
        { key: bytes("/app/"), rangeEnd: bytes("/app0") },
        (batch) => {
          keys.push(...batch.events.map((event) => textOf(event.kv.key)));
          return "stop";
        },
        options,
      );
      expect(end).toEqual({ reason: "stopped" });
      expect(keys).toEqual(["/app/a"]);
      expect(created).toMatchObject({
        create_request: { key: bytes("/app/"), range_end: bytes("/app0"), fragment: true },
      });
      await eventually(() => cancelled);
      expect(cancelled).toBe(true);
    } finally {
      await client.close();
      server.forceShutdown();
    }
  }, 20_000);

  test("a watch the caller aborts ends as aborted, and the server sees the stream cancelled", async () => {
    let cancelled = false;
    const { server, port } = await serve({
      Watch: {
        Watch: ((call) => {
          call.on("cancelled", () => {
            cancelled = true;
          });
          call.on("data", () => call.write({ header: HEADER, created: true }));
        }) satisfies Bidi,
      },
    });
    const client = await createGrpcEtcdClient(at(port));
    try {
      const window = new AbortController();
      setTimeout(() => window.abort(), 100);
      expect(await client.watch({ key: bytes("/app/") }, () => "continue", { signal: window.signal })).toEqual({
        reason: "aborted",
      });
      await eventually(() => cancelled);
      expect(cancelled).toBe(true);
    } finally {
      await client.close();
      server.forceShutdown();
    }
  }, 20_000);

  test("a keep-alive: one request, one answer, and the stream cancelled", async () => {
    const received: unknown[] = [];
    let cancelled = false;
    const { server, port } = await serve({
      Lease: {
        LeaseKeepAlive: ((call) => {
          call.on("cancelled", () => {
            cancelled = true;
          });
          call.on("data", (message: Record<string, unknown>) => {
            received.push(message);
            call.write({ header: HEADER, ID: message.ID, TTL: "59" });
          });
        }) satisfies Bidi,
      },
    });
    const client = await createGrpcEtcdClient(at(port));
    try {
      expect(await client.leaseKeepAliveOnce("7587863092875085000", options)).toEqual({
        id: "7587863092875085000",
        ttl: "59",
      });
      await eventually(() => cancelled);
      expect(cancelled).toBe(true);
      expect(received).toEqual([{ ID: "7587863092875085000" }]);
    } finally {
      await client.close();
      server.forceShutdown();
    }
  }, 20_000);

  test("a stream that fails after its answers yields each answer, then the call's error, never a clean end", async () => {
    const { server, port } = await serve({
      Watch: {
        Watch: ((call) => {
          call.on("data", () => {
            call.write({ header: HEADER, created: true });
            call.emit("error", { code: 14, details: "etcdserver: leader changed" });
          });
        }) satisfies Bidi,
      },
    });
    const channel = grpcWireTransport(at(port));
    const stream = channel.stream("Watch/Watch", {
      metadata: {},
      deadline: new Date(Date.now() + 5000),
      signal: new AbortController().signal,
    });
    try {
      stream.write({ create_request: { key: bytes("/app/"), fragment: true } });
      // Both the error and the end of the failed call have arrived before either read.
      await Bun.sleep(200);
      expect(await stream.read()).toMatchObject({ created: true });
      expect(await failure(stream.read())).toMatchObject({ code: 14, details: "etcdserver: leader changed" });
      expect(await failure(stream.read())).toMatchObject({ code: 14 });
    } finally {
      stream.cancel();
      channel.close();
      server.forceShutdown();
    }
  }, 20_000);

  test("a stream the server ends reads as ended, and one it fails reads as the call's error", async () => {
    const { server, port } = await serve({
      Watch: {
        Watch: ((call) => {
          call.on("data", () => {
            call.write({ header: HEADER, created: true });
            call.end();
          });
        }) satisfies Bidi,
      },
      Lease: {
        LeaseKeepAlive: ((call) => {
          call.on("data", () => call.emit("error", { code: 5, details: "etcdserver: requested lease not found" }));
        }) satisfies Bidi,
      },
    });
    const client = await createGrpcEtcdClient(at(port));
    try {
      expect(await failure(client.watch({ key: bytes("/app/") }, () => "continue", options))).toMatchObject({
        category: "unavailable",
        detail: "etcd ended the watch stream before it cancelled the watch",
      });
      expect(await failure(client.leaseKeepAliveOnce("1", options))).toMatchObject({
        category: "lease-not-found",
        grpcCode: 5,
      });
    } finally {
      await client.close();
      server.forceShutdown();
    }
  }, 20_000);
});

describe("over grpc-js: deadlines, aborts, the receive cap and etcd's words (spec 5.3, 5.6, E14, KE6)", () => {
  let server: Server;
  let port: number;
  let cancelledOnServer = 0;
  const ETCD_WORDS: ReadonlyArray<readonly [number, string, EtcdErrorCategory]> = [
    [14, "etcdserver: no leader", "no-leader"],
    [16, "etcdserver: invalid auth token", "unauthenticated"],
    [3, "etcdserver: user name is empty", "unauthenticated"],
    [3, AUTH_STORE_OLD, "unauthenticated"],
    [3, "etcdserver: authentication failed, invalid user ID or password", "auth-failed"],
    [7, "etcdserver: permission denied", "permission-denied"],
    [11, "etcdserver: mvcc: required revision has been compacted", "compacted"],
    [11, "etcdserver: mvcc: required revision is a future revision", "future-revision"],
    [3, "etcdserver: request is too large", "request-too-large"],
    [8, "grpc: received message larger than max (3145771 vs. 2097152)", "request-too-large"],
    [3, "etcdserver: too many operations in txn request", "too-many-ops"],
    [3, "etcdserver: duplicate key given in txn request", "duplicate-key"],
    [8, "etcdserver: too many requests", "too-many-requests"],
    [8, "etcdserver: mvcc: database space exceeded", "no-space"],
    [5, "etcdserver: requested lease not found", "lease-not-found"],
    [9, "etcdserver: authentication is not enabled", "failed-precondition"],
    [9, "etcdserver: user name not found", "failed-precondition"],
    [14, "etcdserver: leader changed", "unavailable"],
    [14, "etcdserver: request timed out", "unavailable"],
    [1, "etcdserver: request canceled", "cancelled-elsewhere"],
  ];
  beforeAll(async () => {
    ({ server, port } = await serve({
      KV: {
        Range: (call, callback) => {
          const key = textOf(call.request.key as Buffer);
          if (key === "/silent") {
            call.on("cancelled", () => {
              cancelledOnServer++;
            });
            return;
          }
          if (key === "/large") return callback(null, rangeAnswer(kv("/large", "x".repeat(70_000))));
          const answer = ETCD_WORDS.find(([, details]) => details === key);
          if (answer !== undefined) return callback({ code: answer[0], details: answer[1] });
          callback(null, rangeAnswer());
        },
      },
    }));
  });
  afterAll(() => server.forceShutdown());

  test("a deadline after the send is a deadline, naming the peer the request reached", async () => {
    // A bare HTTP/2 listener that takes the request and never answers: a gRPC server would time the deadline too and
    // could word the status first, as a bare "Deadline exceeded", so only the client's own timer is left to fire.
    const silent = http2.createServer();
    silent.on("stream", () => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const silentPort = (silent.address() as AddressInfo).port;
    const client = await createGrpcEtcdClient(at(silentPort, { callTimeoutMs: 300 }));
    const error = await failure(client.range({ key: bytes("/app/cfg"), limit: 1 }, options));
    await client.close();
    silent.close();
    expect(error).toMatchObject({ category: "deadline-exceeded", grpcCode: 4 });
    expect((error as EtcdError).detail).toMatch(
      new RegExp(`^Deadline exceeded after [\\d.]+s,.*remote_addr=127\\.0\\.0\\.1:${silentPort}$`),
    );
  }, 10_000);

  test("a deadline before any stream is a failure to connect: the request never left", async () => {
    const silent = net.createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const client = await createGrpcEtcdClient(at((silent.address() as AddressInfo).port, { callTimeoutMs: 500 }));
    const error = await failure(client.status(options));
    await client.close();
    silent.close();
    expect(error).toMatchObject({ category: "not-connected", grpcCode: 4 });
    expect((error as EtcdError).detail).toContain("Waiting for LB pick");
  }, 10_000);

  test("the call's own abort cancels it on the server, and reads as a cancel, or as a deadline when it was a timeout", async () => {
    const client = await createGrpcEtcdClient(at(port));
    try {
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 100);
      expect(await failure(client.range({ key: bytes("/silent"), limit: 1 }, { signal: cancel.signal }))).toMatchObject(
        {
          category: "cancelled",
          detail: "Cancelled on client",
          grpcCode: 1,
        },
      );
      expect(
        await failure(client.range({ key: bytes("/silent"), limit: 1 }, { signal: AbortSignal.timeout(100) })),
      ).toMatchObject({
        category: "deadline-exceeded",
        detail: "Cancelled on client",
      });
      await eventually(() => cancelledOnServer === 2);
      expect(cancelledOnServer).toBe(2);
    } finally {
      await client.close();
    }
  }, 10_000);

  test("a call that answered, and a stream cancelled, leave no listener on the call's signal", async () => {
    const channel = grpcWireTransport(at(port));
    const controller = new AbortController();
    const added = spyOn(controller.signal, "addEventListener");
    const removed = spyOn(controller.signal, "removeEventListener");
    const call = { metadata: {}, deadline: new Date(Date.now() + 5000), signal: controller.signal };
    try {
      await channel.unary("KV/Range", { key: bytes("/a"), limit: "1" }, call);
      expect(removed.mock.calls.map(([, listener]) => listener)).toEqual(
        added.mock.calls.map(([, listener]) => listener),
      );
      const stream = channel.stream("Watch/Watch", call);
      stream.cancel();
      expect(added).toHaveBeenCalledTimes(2);
      expect(removed.mock.calls.map(([, listener]) => listener)).toEqual(
        added.mock.calls.map(([, listener]) => listener),
      );
      expect(await failure(stream.read())).toMatchObject({ code: 1, details: "Cancelled on client" });
    } finally {
      channel.close();
    }
  }, 10_000);

  test("the transport cancels a call whose signal already aborted, unary or stream, and never waits for the server", async () => {
    const channel = grpcWireTransport(at(port));
    const aborted = new AbortController();
    aborted.abort();
    const call = { metadata: {}, deadline: new Date(Date.now() + 5000), signal: aborted.signal };
    try {
      expect(await failure(channel.unary("KV/Range", { key: bytes("/silent"), limit: "1" }, call))).toMatchObject({
        code: 1,
        details: "Cancelled on client",
      });
      const stream = channel.stream("Watch/Watch", call);
      expect(await failure(stream.read())).toMatchObject({ code: 1, details: "Cancelled on client" });
      stream.cancel();
    } finally {
      channel.close();
    }
  }, 10_000);

  test("an answer past the receive cap fails naming the cap, and is never read (spec E14)", async () => {
    const client = await createGrpcEtcdClient(at(port, { receiveCapBytes: 65536 }));
    const error = await failure(client.range({ key: bytes("/large"), limit: 1 }, options));
    await client.close();
    expect(error).toMatchObject({ category: "resource-exhausted", grpcCode: 8 });
    expect((error as EtcdError).detail).toMatch(/^Received message larger than max \(\d+ vs 65536\)$/);
    expect(toProviderError(error, context("get", false)).message).toStartWith(
      "etcd's answer to the get is larger than this connection's receive cap of 64 KiB: narrow the read.",
    );
    // The same answer under the connection's own cap arrives whole.
    const roomy = await createGrpcEtcdClient(at(port));
    expect((await roomy.range({ key: bytes("/large"), limit: 1 }, options)).kvs[0].value).toHaveLength(70_000);
    await roomy.close();
  }, 10_000);

  test.each(ETCD_WORDS)(
    "status %i %s passes the installed client with its code and text, as %s",
    async (code, details, category) => {
      const client = await createGrpcEtcdClient(at(port));
      const error = await failure(client.range({ key: bytes(details), limit: 1 }, options));
      await client.close();
      expect(error).toMatchObject({ category, detail: details, grpcCode: code });
    },
  );
});

describe("over grpc-js: sockets and names that answer nothing (spec 5.6)", () => {
  test("a refused socket is a failure to connect", async () => {
    const client = await createGrpcEtcdClient(at(await closedPort(), { callTimeoutMs: 3000 }));
    const error = await failure(client.status(options));
    await client.close();
    expect(error).toMatchObject({ category: "not-connected", grpcCode: 14 });
    expect((error as EtcdError).detail).toContain("ECONNREFUSED");
  }, 10_000);

  test("a socket reset on accept is a failure to connect", async () => {
    const resetting = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.resetAndDestroy();
    });
    await new Promise<void>((resolve) => resetting.listen(0, "127.0.0.1", resolve));
    const client = await createGrpcEtcdClient(at((resetting.address() as AddressInfo).port, { callTimeoutMs: 3000 }));
    const error = await failure(client.status(options));
    await client.close();
    resetting.close();
    expect(error).toMatchObject({ category: "not-connected", grpcCode: 14 });
  }, 10_000);

  test("TLS to a listener that accepts and closes, as a tunnel's refused forward does, fails as KE6's plaintext port did", async () => {
    // src/lib/ssh/tunnel.ts ends the local socket when its forward is refused, and etcd's plaintext port closes it on
    // a TLS hello (KE6, etcd/error-tls-to-plaintext): one text, so it cannot say that the port lacks TLS.
    const plaintextPort = (etcdCapture("etcd/error-tls-to-plaintext.bun").payload as { details: string }).details;
    const tlsContext: EtcdErrorContext = {
      ...context("put", true),
      connection: {
        ...context("put", true).connection,
        tls: { serverName: "etcd.test", clientCertificate: false },
        runtimeReportsTlsCause: true,
      },
    };
    for (const close of ["end", "destroy"] as const) {
      const closing = net.createServer((socket) => {
        socket.on("error", () => undefined);
        socket[close]();
      });
      // oxlint-disable-next-line no-await-in-loop -- one listener after another.
      await new Promise<void>((resolve) => closing.listen(0, "127.0.0.1", resolve));
      const { port } = closing.address() as AddressInfo;
      // oxlint-disable-next-line no-await-in-loop -- one channel per listener.
      const client = await createGrpcEtcdClient(at(port, { tls: TLS, callTimeoutMs: 3000 }));
      // oxlint-disable-next-line no-await-in-loop -- the one call on that channel.
      const error = await failure(client.status(options));
      // oxlint-disable-next-line no-await-in-loop -- the channel closes before the next listener opens.
      await client.close();
      closing.close();
      expect({ close, error }).toMatchObject({ close, error: { category: "not-connected", grpcCode: 14 } });
      expect((error as EtcdError).detail).toBe(plaintextPort);
      expect((error as EtcdError).tlsFailure).toBeUndefined();
      expect(toProviderError(error, tlsContext).message).toStartWith(
        "No etcd answered a TLS connection at etcd.test:2379: check the host, the port, the SSL mode and the tunnel.",
      );
    }
  }, 10_000);

  test("a name that does not resolve is a failure to connect, for a write too, since nothing was dialled", async () => {
    const client = await createGrpcEtcdClient({ ...PLAINTEXT, target: "dns:libredb-etcd-fixture.invalid:2379" });
    const error = await failure(
      client.txn(
        { compare: [], success: [{ op: "put", request: { key: bytes("/a"), value: bytes("v") } }], failure: [] },
        options,
      ),
    );
    await client.close();
    expect(error).toMatchObject({
      category: "not-connected",
      detail: "Name resolution failed for target dns:libredb-etcd-fixture.invalid:2379",
    });
    expect(toProviderError(error, context("put", true)).message).not.toContain("may have been applied");
  }, 10_000);
});

describe("over grpc-js: the channel's own rules (spec E1, E4, E16, 6.1)", () => {
  test("opening the channel dials nothing: only a call does (spec E16)", async () => {
    let accepted = 0;
    const listener = net.createServer((socket) => {
      accepted++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    const channel = grpcWireTransport(at(port));
    await Bun.sleep(100);
    expect(accepted).toBe(0);
    // The control: the same channel's first call is what dials.
    const call = { metadata: {}, deadline: new Date(Date.now() + 2000), signal: new AbortController().signal };
    await failure(channel.unary("Maintenance/Status", {}, call));
    channel.close();
    listener.close();
    expect(accepted).toBeGreaterThan(0);
  }, 10_000);

  test("close() ends a call still waiting for its connection as closed, since it never started", async () => {
    const silent = net.createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const client = await createGrpcEtcdClient(at((silent.address() as AddressInfo).port, { callTimeoutMs: 5000 }));
    const waiting = failure(
      client.txn(
        { compare: [], success: [{ op: "put", request: { key: bytes("/a"), value: bytes("v") } }], failure: [] },
        options,
      ),
    );
    await Bun.sleep(200);
    await client.close();
    const error = await waiting;
    silent.close();
    expect(error).toMatchObject({ category: "closed", detail: "Channel closed before call started", grpcCode: 14 });
    expect(toProviderError(error, context("put", true)).message).not.toContain("may have been applied");
  }, 10_000);

  test("a grpc_config TXT record on the host installs no retry policy, and is never even read (spec E4)", async () => {
    let attempts = 0;
    const { server, port } = await serve({
      KV: {
        Txn: (_call, callback) => {
          attempts++;
          callback({ code: 14, details: "etcdserver: leader changed" });
        },
      },
    });
    const retryPolicy = {
      methodConfig: [
        {
          name: [{ service: "etcdserverpb.KV" }],
          retryPolicy: {
            maxAttempts: 4,
            initialBackoff: "0.01s",
            maxBackoff: "0.01s",
            backoffMultiplier: 1,
            retryableStatusCodes: ["UNAVAILABLE"],
          },
        },
      ],
    };
    const lookup = spyOn(dns.promises, "lookup").mockImplementation((async () => [
      { address: "127.0.0.1", family: 4 },
    ]) as never);
    const txt = spyOn(dns.promises, "resolveTxt").mockImplementation((async () => [
      [`grpc_config=${JSON.stringify([{ serviceConfig: retryPolicy }])}`],
    ]) as never);
    try {
      const target = `dns:etcd-txt.test:${port}`;
      const write = {
        compare: [],
        success: [{ op: "put", request: { key: bytes("/a"), value: bytes("v") } }],
        failure: [],
      } as const;
      const client = await createGrpcEtcdClient({ ...PLAINTEXT, target });
      await failure(client.txn(write, options));
      await Bun.sleep(50);
      attempts = 0;
      await failure(client.txn(write, options));
      await client.close();
      expect({ attempts, txtLookups: txt.mock.calls.length }).toEqual({ attempts: 1, txtLookups: 0 });
      // The control, which makes the assertion above able to fail: a channel that reads the record resends the write.
      const control = new Client(target, credentials.createInsecure());
      const method = (
        service("KV") as unknown as Record<
          string,
          { path: string; requestSerialize: (value: object) => Buffer; responseDeserialize: (value: Buffer) => object }
        >
      ).Txn;
      const txnOnce = () =>
        new Promise<void>((resolve) =>
          control.makeUnaryRequest(
            method.path,
            method.requestSerialize,
            method.responseDeserialize,
            { compare: [], success: [], failure: [] },
            new Metadata(),
            { deadline: Date.now() + 3000 },
            () => resolve(),
          ),
        );
      await txnOnce();
      await Bun.sleep(50);
      attempts = 0;
      await txnOnce();
      control.close();
      expect({ attempts, txtLookups: txt.mock.calls.length > 0 }).toEqual({ attempts: 4, txtLookups: true });
    } finally {
      lookup.mockRestore();
      txt.mockRestore();
      server.forceShutdown();
    }
  }, 20_000);

  test("with the answering member stopped, the next command reaches another through pick_first, on the same channel (Review Focus 3)", async () => {
    const statusAs =
      (version: string): Unary =>
      (_call, callback) =>
        callback(null, { ...MINIMAL["Maintenance/Status"], version });
    let first: { server: Server; port: number } | undefined;
    let second: { server: Server; port: number } | undefined;
    for (let tries = 0; second === undefined && tries < 5; tries++) {
      first?.server.forceShutdown();
      // oxlint-disable-next-line no-await-in-loop -- a port is taken on 127.0.0.1 before the same one is tried on ::1.
      first = await serve({ Maintenance: { Status: statusAs("member-a") } });
      // oxlint-disable-next-line no-await-in-loop -- the same port, now on ::1.
      second = await serve({ Maintenance: { Status: statusAs("member-b") } }, `[::1]:${first.port}`).catch(
        () => undefined,
      );
    }
    if (first === undefined || second === undefined) throw new Error("No port was free on both 127.0.0.1 and ::1");
    const lookup = spyOn(dns.promises, "lookup").mockImplementation((async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]) as never);
    const client = await createGrpcEtcdClient({
      ...PLAINTEXT,
      target: `dns:etcd-failover.test:${first.port}`,
      callTimeoutMs: 1000,
    });
    try {
      const answeredFirst = (await client.status(options)).version;
      const stopped = answeredFirst === "member-a" ? first : second;
      stopped.server.forceShutdown();
      const other = answeredFirst === "member-a" ? "member-b" : "member-a";
      const failures: string[] = [];
      let reached: string | undefined;
      for (let tries = 0; reached === undefined && tries < 20; tries++) {
        // oxlint-disable-next-line no-await-in-loop -- each command follows the one before it, as a person runs them.
        const answer = await client.status(options).catch((error: unknown) => {
          failures.push((error as EtcdError).category);
          return undefined;
        });
        // oxlint-disable-next-line no-await-in-loop -- a pause between two commands.
        if (answer === undefined) await Bun.sleep(100);
        else reached = answer.version;
      }
      expect(reached).toBe(other);
      expect(failures.every((category) => category === "unavailable" || category === "not-connected")).toBe(true);
    } finally {
      await client.close();
      lookup.mockRestore();
      first.server.forceShutdown();
      second.server.forceShutdown();
    }
  }, 30_000);

  test("the channel's options: no service config from DNS, the receive cap, no environment proxy, and the TLS name (spec E1, E4, E5, E14)", () => {
    const base = {
      "grpc.service_config_disable_resolution": 1,
      "grpc.max_receive_message_length": PLAINTEXT.receiveCapBytes,
      "grpc.enable_http_proxy": 0,
    };
    expect(channelOptions(PLAINTEXT)).toEqual(base);
    expect(channelOptions(PASSWORD)).toEqual({ ...base, "grpc.ssl_target_name_override": "etcd.test" });
  });

  test("a proxy the environment names is never used: the endpoint is dialled itself, and the proxy accepts nothing (spec E1)", async () => {
    let proxied = 0;
    const proxy = net.createServer((socket) => {
      proxied++;
      socket.on("error", () => undefined);
      socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { server, port } = await serve({ Maintenance: { Status: answering(MINIMAL["Maintenance/Status"]) } });
    // The variables grpc-js reads (http_proxy.ts): a proxy, by preference, and the hosts it skips, which are cleared
    // so that 127.0.0.1 cannot pass by the proxy for that reason alone.
    const read = ["grpc_proxy", "https_proxy", "http_proxy", "no_grpc_proxy", "no_proxy"] as const;
    const saved = new Map(read.map((name) => [name, process.env[name]]));
    try {
      for (const name of ["grpc_proxy", "https_proxy", "http_proxy"] as const) {
        for (const other of read) delete process.env[other];
        process.env[name] = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
        // oxlint-disable-next-line no-await-in-loop -- one variable after another, each with its own client.
        const client = await createGrpcEtcdClient(at(port, { callTimeoutMs: 3000 }));
        // oxlint-disable-next-line no-await-in-loop -- the one call on that client.
        const answered = await client.status(options).then(
          (status) => status.version,
          (error: unknown) => (error as EtcdError).category,
        );
        // oxlint-disable-next-line no-await-in-loop -- the client closes before the next variable is set.
        await client.close();
        expect({ name, answered, proxied }).toEqual({ name, answered: "3.7.2", proxied: 0 });
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      proxy.close();
      server.forceShutdown();
    }
  }, 20_000);
});

describe("over grpc-js: the TLS rules the transport applies (spec E5)", () => {
  const certificates = loadTlsFixtures();
  const servers: Server[] = [];
  let plain: number;
  let mutual: number;

  async function tlsServer(clientCa?: string): Promise<number> {
    const { server, port } = await serve(
      { Maintenance: { Status: answering(MINIMAL["Maintenance/Status"]) } },
      "127.0.0.1:0",
      ServerCredentials.createSsl(
        clientCa === undefined ? null : Buffer.from(clientCa),
        [{ private_key: Buffer.from(certificates.server.key), cert_chain: Buffer.from(certificates.server.cert) }],
        clientCa !== undefined,
      ),
    );
    servers.push(server);
    return port;
  }

  beforeAll(async () => {
    plain = await tlsServer();
    mutual = await tlsServer(certificates.clientCa);
  });
  afterAll(() => {
    for (const server of servers) server.forceShutdown();
  });

  /** A verifying panel for `identity`, the override chosen as connection-options.ts chooses it (spec E5). */
  const verifying = (identity: string, overrides: Partial<EtcdTlsOptions> = {}): EtcdTlsOptions => ({
    mode: "verify-full",
    ca: certificates.ca,
    verify: true,
    identity,
    identityIsIp: net.isIP(identity) !== 0,
    serverNameOverride: net.isIP(identity) !== 0 ? "etcd.invalid" : identity,
    ...overrides,
  });
  const statusOver = async (port: number, tls: EtcdTlsOptions) => {
    const client = await createGrpcEtcdClient(at(port, { tls, callTimeoutMs: 3000 }));
    try {
      return await client.status(options);
    } finally {
      await client.close();
    }
  };

  test("an IP identity verifies the certificate against the IP, which the override name never replaces (D0-3)", async () => {
    expect((await statusOver(plain, verifying("127.0.0.1"))).version).toBe("3.7.2");
    const error = await failure(statusOver(plain, verifying("10.0.0.6")));
    expect(error).toMatchObject({ category: "tls", tlsFailure: "name" });
    expect((error as EtcdError).detail).toContain("IP: 10.0.0.6 is not in the cert's list");
  }, 20_000);

  test("a DNS identity is checked by its name through the override, never by the dialled address", async () => {
    expect((await statusOver(plain, verifying("localhost"))).version).toBe("3.7.2");
    const error = await failure(statusOver(plain, verifying("etcd.test")));
    expect(error).toMatchObject({ category: "tls", tlsFailure: "name" });
    expect((error as EtcdError).detail).toContain("etcd.test");
  }, 20_000);

  test("require encrypts and checks nothing: a chain no CA vouches for and a name the certificate lacks both answer", async () => {
    const unchecked = { ...verifying("etcd.test"), mode: "require" as const, verify: false, ca: undefined };
    expect((await statusOver(plain, unchecked)).version).toBe("3.7.2");
    const ip = { ...verifying("10.0.0.6"), mode: "require" as const, verify: false, ca: undefined };
    expect((await statusOver(plain, ip)).version).toBe("3.7.2");
  }, 20_000);

  test("a verifying mode checks the chain: the runtime's roots without a pasted CA, and a pasted CA that signed nothing here", async () => {
    const roots = { ...verifying("localhost"), mode: "verify-system" as const, ca: undefined };
    expect(await failure(statusOver(plain, roots))).toMatchObject({ category: "tls", tlsFailure: "chain" });
    const wrong = verifying("localhost", { ca: certificates.otherCa });
    expect(await failure(statusOver(plain, wrong))).toMatchObject({ category: "tls", tlsFailure: "chain" });
  }, 20_000);

  test("a configured client certificate reaches a server that requires one, which refuses a connection without it", async () => {
    const pair = { cert: certificates.client.cert, key: certificates.client.key };
    expect((await statusOver(mutual, verifying("localhost", { clientCertificate: pair }))).version).toBe("3.7.2");
    const refused = (await failure(statusOver(mutual, verifying("localhost")))) as EtcdError;
    // Node names the refusal, Bun does not (spec E5); tls-handshake.test.ts pins each runtime's words.
    expect(["tls", "not-connected"]).toContain(refused.category);
  }, 20_000);
});

describe("over grpc-js: nothing of a channel outlives close() (spec E16)", () => {
  /** What grpc-js hands a connector for the adapter's target; the handshake's name is the host, never an IP. */
  const TARGET: experimental.GrpcUri = { scheme: "dns", path: "etcd.test:2379" };
  const CHANNEL_CLOSED = "The channel closed before this connection was established";

  /** TCP that reads what arrives and writes nothing, so a handshake never ends: what it holds, and who sent bytes. */
  async function silentListener() {
    const held = new Set<net.Socket>();
    const spoke = new Set<net.Socket>();
    const listener = net.createServer((socket) => {
      held.add(socket);
      socket.on("close", () => held.delete(socket));
      socket.on("error", () => undefined);
      socket.on("data", () => spoke.add(socket));
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    return { listener, held, spoke, port: (listener.address() as AddressInfo).port };
  }

  /**
   * A TCP socket connected to `port`, as grpc-js's own dial hands it to the credentials' connector: with no error
   * listener left on it, so a socket ended with an error would throw here as it would there.
   */
  const dialled = (port: number) =>
    new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });

  /** grpc-js's own TLS credentials, verifying against the runtime's roots: a peer that never answers shows no certificate. */
  const tlsCredentials = () => credentials.createSsl();

  /** TLS that completes the handshake, then reads what arrives and writes nothing, so no SETTINGS ever comes. */
  async function settingslessListener() {
    const { server: pair } = loadTlsFixtures();
    const held = new Set<net.Socket>();
    const listener = tls.createServer({ key: pair.key, cert: pair.cert, ALPNProtocols: ["h2"] }, (socket) => {
      held.add(socket);
      socket.on("close", () => held.delete(socket));
      socket.on("error", () => undefined);
      socket.resume();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    return { listener, held, port: (listener.address() as AddressInfo).port };
  }

  /** grpc-js's insecure credentials around a connector that hands every socket straight back, as an established one. */
  function establishing(): ChannelCredentials {
    const inner = credentials.createInsecure();
    spyOn(inner, "_createSecureConnector").mockReturnValue({
      connect: (socket) => Promise.resolve({ socket, secure: false }),
      waitForReady: () => Promise.resolve(),
      getCallCredentials: () => credentials.createEmpty(),
      destroy: () => undefined,
    });
    return inner;
  }

  test("the call fails as a connect timeout, the handshake holds its connection while the client lives, and close() ends it", async () => {
    const silent = await silentListener();
    const client = await createGrpcEtcdClient(at(silent.port, { tls: TLS, callTimeoutMs: 500 }));
    const error = await failure(client.status(options));
    expect(error).toMatchObject({ category: "not-connected", grpcCode: 4 });
    expect((error as EtcdError).detail).toMatch(/Waiting for LB pick$/);
    // The control: the connection is open, still in its handshake, until the client closes.
    expect(silent.held.size).toBe(1);
    await client.close();
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  }, 10_000);

  test("destroy() ends every socket still in its handshake and fails its connect, which Node never settles", async () => {
    const silent = await silentListener();
    const connector = new ClosingCredentials(tlsCredentials())._createSecureConnector(TARGET, {});
    const sockets = await Promise.all([dialled(silent.port), dialled(silent.port)]);
    const connecting = sockets.map((socket) => failure(connector.connect(socket)));
    // Both hellos have arrived, so both handshakes are under way.
    await eventually(() => silent.spoke.size === 2);
    expect(silent.spoke.size).toBe(2);
    connector.destroy();
    expect(await Promise.all(connecting)).toMatchObject([{ message: CHANNEL_CLOSED }, { message: CHANNEL_CLOSED }]);
    expect(sockets.map((socket) => socket.destroyed)).toEqual([true, true]);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  }, 10_000);

  test("a socket handed over after destroy(), whose TCP connect outlived the close, is ended before any handshake", async () => {
    const silent = await silentListener();
    const connector = new ClosingCredentials(tlsCredentials())._createSecureConnector(TARGET, {});
    connector.destroy();
    const socket = await dialled(silent.port);
    expect(await failure(connector.connect(socket))).toMatchObject({ message: CHANNEL_CLOSED });
    expect(socket.destroyed).toBe(true);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    // Nothing was read from it: no hello was ever sent.
    expect({ held: silent.held.size, spoke: silent.spoke.size }).toEqual({ held: 0, spoke: 0 });
  }, 10_000);

  test("everything else is grpc-js's own connector: the handshake's answer and failure, readiness, call credentials, destroy()", async () => {
    const inner = tlsCredentials();
    const handshake = { socket: new net.Socket(), secure: true };
    const refusal = new Error("the handshake failed");
    const ready = Promise.resolve();
    const callCredentials = credentials.createEmpty();
    const [answered, refused] = [new net.Socket(), new net.Socket()];
    const destroyed: string[] = [];
    const recording: experimental.SecureConnector = {
      connect: (socket) => (socket === answered ? Promise.resolve(handshake) : Promise.reject(refusal)),
      waitForReady: () => ready,
      getCallCredentials: () => callCredentials,
      destroy: () => {
        destroyed.push("inner");
      },
    };
    const created = spyOn(inner, "_createSecureConnector").mockReturnValue(recording);
    const connector = new ClosingCredentials(inner)._createSecureConnector(
      TARGET,
      { "grpc.enable_retries": 0 },
      callCredentials,
    );
    expect(created.mock.calls).toEqual([[TARGET, { "grpc.enable_retries": 0 }, callCredentials]]);
    expect(await connector.connect(answered)).toBe(handshake);
    expect(await failure(connector.connect(refused))).toBe(refusal);
    expect(connector.waitForReady()).toBe(ready);
    expect(connector.getCallCredentials()).toBe(callCredentials);
    connector.destroy();
    // No handshake was pending, so nothing was ended; the inner connector was destroyed too.
    expect({ destroyed, answered: answered.destroyed, refused: refused.destroyed }).toEqual({
      destroyed: ["inner"],
      answered: false,
      refused: false,
    });
  });

  test("the credentials keep grpc-js's security flag, and equal only themselves, plaintext or TLS, so no two clients share a subchannel", () => {
    const tls = new ClosingCredentials(tlsCredentials());
    const plaintext = new ClosingCredentials(credentials.createInsecure());
    expect({ tls: tls._isSecure(), plaintext: plaintext._isSecure() }).toEqual({ tls: true, plaintext: false });
    expect({ tls: tls._equals(tls), plaintext: plaintext._equals(plaintext) }).toEqual({ tls: true, plaintext: true });
    expect({
      tls: tls._equals(new ClosingCredentials(tlsCredentials())),
      plaintext: plaintext._equals(new ClosingCredentials(credentials.createInsecure())),
    }).toEqual({ tls: false, plaintext: false });
    // The controls: grpc-js's own TLS credentials, built twice as two clients build them, are not equal, while its
    // insecure credentials equal any other, which would let two plaintext clients of one endpoint share a subchannel,
    // and one client's close() reach the other's connection.
    expect({
      tls: tlsCredentials()._equals(tlsCredentials()),
      plaintext: credentials.createInsecure()._equals(credentials.createInsecure()),
    }).toEqual({ tls: false, plaintext: true });
  });

  test("from destroy() on, readiness is refused, naming the closed channel, so grpc-js dials nothing more and its own connector is not asked", async () => {
    const inner = credentials.createInsecure();
    const ready = Promise.resolve();
    let asked = 0;
    spyOn(inner, "_createSecureConnector").mockReturnValue({
      connect: (socket) => Promise.resolve({ socket, secure: false }),
      waitForReady: () => {
        asked++;
        return ready;
      },
      getCallCredentials: () => credentials.createEmpty(),
      destroy: () => undefined,
    });
    const connector = new ClosingCredentials(inner)._createSecureConnector(TARGET, {});
    // The control: before destroy(), readiness is grpc-js's own.
    expect(connector.waitForReady()).toBe(ready);
    connector.destroy();
    expect(await failure(connector.waitForReady())).toMatchObject({ message: CHANNEL_CLOSED });
    expect(asked).toBe(1);
  });

  test("a connector's destroy() alone leaves an established socket open, as a load balancer's release needs; the adapter's close ends it", async () => {
    const silent = await silentListener();
    const closing = new ClosingCredentials(establishing());
    const connector = closing._createSecureConnector(TARGET, {});
    const socket = await dialled(silent.port);
    expect((await connector.connect(socket)).socket).toBe(socket);
    // A load balancer's release: grpc-js then shuts the transport down gracefully, so a call in flight finishes.
    connector.destroy();
    await Bun.sleep(100);
    expect({ destroyed: socket.destroyed, held: silent.held.size }).toEqual({ destroyed: false, held: 1 });
    // The adapter's close().
    closing.endEverySocket();
    expect(socket.destroyed).toBe(true);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  });

  test("a socket that closed on its own, ended here or reset by its peer, is held no longer, so the adapter's close leaves it be", async () => {
    const silent = await silentListener();
    const closing = new ClosingCredentials(establishing());
    const connector = closing._createSecureConnector(TARGET, {});
    const [ended, reset] = await Promise.all([dialled(silent.port), dialled(silent.port)]);
    // The session grpc-js builds on a socket listens for its errors, and a peer's reset is one.
    reset.on("error", () => undefined);
    await connector.connect(ended);
    await connector.connect(reset);
    await eventually(() => silent.held.size === 2);
    const peerOfReset = [...silent.held].find((peer) => peer.remotePort === reset.localPort);
    const closed = [ended, reset].map((socket) => new Promise((resolve) => socket.once("close", resolve)));
    ended.destroy();
    peerOfReset?.resetAndDestroy();
    await Promise.all(closed);
    const destroys = [spyOn(ended, "destroy"), spyOn(reset, "destroy")];
    closing.endEverySocket();
    silent.listener.close();
    expect({ peerOfReset: peerOfReset !== undefined, destroyed: destroys.map((spy) => spy.mock.calls.length) }).toEqual(
      { peerOfReset: true, destroyed: [0, 0] },
    );
  });

  test("a session still waiting for the peer's SETTINGS holds its connection while the client lives, and close() ends it, plaintext or TLS", async () => {
    const plaintext = await silentListener();
    const settingsless = await settingslessListener();
    const unverified: EtcdTlsOptions = { ...TLS, mode: "require", verify: false };
    for (const [peer, overrides] of [
      [plaintext, {}],
      [settingsless, { tls: unverified }],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one peer after another, each with its own client.
      const client = await createGrpcEtcdClient(at(peer.port, { ...overrides, callTimeoutMs: 500 }));
      // oxlint-disable-next-line no-await-in-loop -- the one call on that client.
      const error = await failure(client.status(options));
      expect(error).toMatchObject({ category: "not-connected", grpcCode: 4 });
      // The control: the connection is open, its session waiting for SETTINGS, until the client closes.
      expect({ tls: "tls" in overrides, held: peer.held.size }).toEqual({ tls: "tls" in overrides, held: 1 });
      // oxlint-disable-next-line no-await-in-loop -- the client closes before the next peer is dialled.
      await client.close();
      // oxlint-disable-next-line no-await-in-loop -- a poll for the peer's view of the close.
      await eventually(() => peer.held.size === 0);
      peer.listener.close();
      expect({ tls: "tls" in overrides, held: peer.held.size }).toEqual({ tls: "tls" in overrides, held: 0 });
    }
  }, 10_000);

  test("close() cancels every stream still open before it ends the sockets, so a watch in flight ends as cancelled", async () => {
    let opened = 0;
    let cancelled = false;
    const { server, port } = await serve({
      Watch: {
        Watch: ((call) => {
          opened++;
          call.on("cancelled", () => {
            cancelled = true;
          });
        }) satisfies Bidi,
      },
    });
    const channel = grpcWireTransport(at(port));
    const call = { metadata: {}, deadline: new Date(Date.now() + 3000), signal: new AbortController().signal };
    const stream = channel.stream("Watch/Watch", call);
    stream.write({ create_request: { key: bytes("/a"), fragment: true } });
    await eventually(() => opened === 1);
    const reading = failure(stream.read());
    channel.close();
    // Cancelled by the client, never a dropped connection's UNAVAILABLE.
    expect(await reading).toMatchObject({ code: 1, details: "Cancelled on client" });
    await eventually(() => cancelled);
    server.forceShutdown();
    expect(cancelled).toBe(true);
  }, 10_000);

  test("a stream cancelled before close() is the channel's no longer, so close() does not cancel it again", async () => {
    const channel = grpcWireTransport(at(await closedPort()));
    const controller = new AbortController();
    const removed = spyOn(controller.signal, "removeEventListener");
    const call = { metadata: {}, deadline: new Date(Date.now() + 3000), signal: controller.signal };
    channel.stream("Watch/Watch", call).cancel();
    expect(removed).toHaveBeenCalledTimes(1);
    channel.close();
    expect(removed).toHaveBeenCalledTimes(1);
  });
});
