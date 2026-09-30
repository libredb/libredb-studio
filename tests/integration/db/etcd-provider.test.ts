/**
 * etcd provider, end to end (#1089, spec 10, gate 1).
 *
 * The real adapter (`grpc-client.ts`), the real connect sequence, object surface, command run, monitoring
 * reads and error table all run; only the server is fake. The fake is the recorded transport of
 * `tests/helpers/etcd-fixtures.ts`, handed to `createGrpcEtcdClient` through the provider constructor's client
 * factory, so every call the composition makes goes through the adapter's request building, decoding, token
 * renewal and error translation and is answered from what etcd answered live. `mock.module()` is not used: it
 * is process-wide in bun and would poison sibling test files.
 *
 * The answers were captured by `tests/live/etcd-evidence.ts` from `gcr.io/etcd-development/etcd:v3.7.2`
 * (`sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3`), the build every etcd service
 * of `database-compose.yml` pins: `etcd` (one member, plaintext, RBAC off, the seeded key space of
 * `docker/etcd/README.md`), `etcd-cluster` (three members), `etcd-auth` (TLS with `--client-cert-auth`, RBAC
 * on) and `etcd-auth-password` (TLS, RBAC on, password sign-in). `tests/fixtures/etcd/README.md` lists each
 * capture with its member id and date, and a test below holds every capture this file reads to that digest.
 *
 * What is BUILT from a capture rather than read from one, each said again where it is built:
 * - The key space. `KV/Range` is served from the whole seeded key space of `etcd/range-keys-only-all` by
 *   etcd's range rules, each value taken from the value captures of `etcd`, because the provider's walks and
 *   pages ask ranges no capture was taken for. A value no capture holds is never invented: reading one fails
 *   the test by name.
 * - The reader's refusals. A range the `etcd-auth` reader may not read whole is refused with that service's
 *   captured `PermissionDenied`, by the reader's two grants, which a test ties to `etcd-auth/role-get-reader`.
 * - One cluster from two services. The conformance run reads the key space, members, leases and status of
 *   `etcd` and the users and roles `etcd-auth`'s root listed, because no one service counts every listed kind
 *   with a number: users and roles exist only where RBAC is on, and there the key space is read as a reader.
 * - The leases. `LeaseLeases` answers only the lease `etcd/lease-time-to-live-keys` was captured for, so the
 *   one object of the Leases folder has its source.
 * - UserGet and RoleGet answer by the name asked, from the captures of each name.
 *
 * A section number below, "spec 4.7" for example, is a section of #1089's design.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flattenTree } from "@/components/object-tree/flatten";
import { captureContextSnapshot, packContextForTask } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { AgentContextSnapshot } from "@/lib/agent/types";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { containerDepth, enumerableKinds } from "@/lib/db/object-kinds";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { EtcdMember, EtcdPermission, EtcdStatus } from "@/lib/db/providers/keyvalue/etcd/client";
import { createGrpcEtcdClient } from "@/lib/db/providers/keyvalue/etcd/grpc-client";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { groupLabel, prefixGroups } from "@/lib/db/providers/keyvalue/etcd/keys";
import type {
  DatabaseConnection,
  DatabaseObject,
  ProviderCapabilities,
  ProviderOptions,
  QueryResult,
} from "@/lib/db/types";
import { createFakeEtcdClient } from "../../helpers/etcd-fake-client";
import {
  etcdCapture,
  etcdFixture,
  type RecordedEtcdAnswer,
  type RecordedEtcdWire,
  recordedEtcdWire,
} from "../../helpers/etcd-fixtures";
import { KEY_SPACE_HEADER, keySpaceRange, permissionDenied } from "../../helpers/etcd-key-space";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

// ============================================================================
// The recorded cluster
// ============================================================================

const IMAGE = "gcr.io/etcd-development/etcd:v3.7.2";
const DIGEST = "sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3";

/** The wire's own shapes, as grpc-js hands them over with the adapter's loader options (C5, C11). */
interface WireHeader {
  readonly cluster_id: string;
  readonly member_id: string;
  readonly revision: string;
  readonly raft_term: string;
}
interface WireKeyValue {
  readonly key: Buffer;
  readonly create_revision: string;
  readonly mod_revision: string;
  readonly version: string;
  readonly value: Buffer;
  readonly lease: string;
}
interface WireRange {
  readonly header: WireHeader;
  readonly kvs: readonly WireKeyValue[];
  readonly more: boolean;
  readonly count: string;
}
interface WireRangeRequest {
  readonly key?: Uint8Array;
  readonly range_end?: Uint8Array;
  readonly limit?: string | number;
  readonly keys_only?: boolean;
  readonly count_only?: boolean;
}

/** The whole seeded key space, keys only, in etcd's byte order. */
const ALL = etcdFixture<WireRange>("etcd/range-keys-only-all");

/** Every value the `etcd` captures read, by the key's bytes. */
const VALUE_CAPTURES = [
  "etcd/range-key",
  "etcd/range-prefix-app",
  "etcd/range-prefix-values",
  "etcd/range-prefix-registry",
  "etcd/range-prefix-registry-slashless",
  "etcd/range-prefix-tenant-a",
  "etcd/range-compact-rev-key",
] as const;
const VALUES = new Map(
  VALUE_CAPTURES.flatMap((name) =>
    etcdFixture<WireRange>(name).kvs.map((kv) => [kv.key.toString("hex"), kv.value] as const),
  ),
);

const runsToEnd = (end: Uint8Array): boolean => end.length === 1 && end[0] === 0;

/** The request's interval with an explicit end, by etcd's rules: no end is the key alone, `[k, k + 0x00)`. */
function intervalOf(request: WireRangeRequest): { readonly start: Buffer; readonly end: Buffer } {
  const start = Buffer.from(request.key ?? new Uint8Array());
  const end =
    request.range_end === undefined || request.range_end.length === 0
      ? Buffer.concat([start, Buffer.from([0])])
      : Buffer.from(request.range_end);
  return { start, end };
}

function inRange(key: Buffer, request: WireRangeRequest): boolean {
  const { start, end } = intervalOf(request);
  return Buffer.compare(key, start) >= 0 && (runsToEnd(end) || Buffer.compare(key, end) < 0);
}

function valueOf(key: Buffer): Buffer {
  const value = VALUES.get(key.toString("hex"));
  if (value === undefined) throw new Error(`No capture holds the value of ${JSON.stringify(key.toString())}`);
  return value;
}

/**
 * BUILT: `KV/Range` over the seeded key space, by etcd's rules for `limit`, `keys_only` and `count_only`.
 * `permitted` stands for etcd's grant check, whose refusal is the captured one.
 */
function servedRange(permitted: (request: WireRangeRequest) => boolean = () => true): RecordedEtcdAnswer {
  return (request: unknown) => {
    const asked = request as WireRangeRequest;
    if (!permitted(asked)) throw etcdCapture("etcd-auth/error-permission-denied").payload;
    const matching = ALL.kvs.filter((kv) => inRange(kv.key, asked));
    const limit = Number(asked.limit ?? 0);
    const page = asked.count_only === true ? [] : limit > 0 ? matching.slice(0, limit) : matching;
    return {
      header: ALL.header,
      // oxlint-disable-next-line no-map-spread -- the captured key-values are shared by every read, so each answer is a changed copy.
      kvs: page.map((kv) => ({ ...kv, value: asked.keys_only === true ? Buffer.alloc(0) : valueOf(kv.key) })),
      more: asked.count_only !== true && limit > 0 && matching.length > limit,
      count: String(matching.length),
    };
  };
}

/** The reader of spec 9: READ on the prefix `/app/` and on the single key `/config/a`. */
const READER_GRANTS = [
  { start: Buffer.from("/app/"), end: Buffer.from("/app0") },
  { start: Buffer.from("/config/a"), end: Buffer.from("/config/a\u0000") },
] as const;

/** BUILT: etcd's grant check for the reader, a request no one grant holds whole being refused (spec 4.7). */
function readerMayRead(request: WireRangeRequest): boolean {
  const { start, end } = intervalOf(request);
  return READER_GRANTS.some(
    (grant) => Buffer.compare(start, grant.start) >= 0 && !runsToEnd(end) && Buffer.compare(end, grant.end) <= 0,
  );
}

/** Every call of an rpc answered by `answer`, far more calls than any test here makes. */
const always = (answer: RecordedEtcdAnswer): RecordedEtcdAnswer[] => Array.from({ length: 5_000 }, () => answer);

/** BUILT: UserGet by the name asked, from the capture of that name. */
function userGet(request: unknown): unknown {
  const { name } = request as { readonly name?: string };
  if (name === "reader") return etcdFixture("etcd-auth/user-get-reader");
  if (name === "cert-only") return etcdFixture("etcd-auth/user-get-cert-only");
  throw new Error(`No capture holds UserGet of ${JSON.stringify(name)}`);
}

/** BUILT: RoleGet by the role asked, from the capture of that role. */
function roleGet(request: unknown): unknown {
  const { role } = request as { readonly role?: string };
  if (role === "reader") return etcdFixture("etcd-auth/role-get-reader");
  throw new Error(`No capture holds RoleGet of ${JSON.stringify(role)}`);
}

/** 694d8147df1dc4c9, the lease `etcd/lease-time-to-live-keys` was captured for (docker/etcd/README.md). */
const HELD_LEASE = "7587863092875085001";

/** BUILT: LeaseLeases narrowed to the lease whose TimeToLive was captured. */
function heldLeases(): unknown {
  const all = etcdFixture<{ readonly header: WireHeader; readonly leases: ReadonlyArray<{ readonly ID: string }> }>(
    "etcd/lease-leases",
  );
  return { ...all, leases: all.leases.filter((lease) => lease.ID === HELD_LEASE) };
}

/** The `etcd` service, with the users and roles `etcd-auth`'s root listed: every listed kind counted. */
function clusterWire(answers: Record<string, readonly RecordedEtcdAnswer[]> = {}): RecordedEtcdWire {
  return recordedEtcdWire({
    service: "etcd",
    answers: {
      "KV/Range": always(servedRange()),
      "Lease/LeaseLeases": always(heldLeases),
      "Auth/UserList": always({ fixture: "etcd-auth/user-list" }),
      "Auth/UserGet": always(userGet),
      "Auth/RoleList": always({ fixture: "etcd-auth/role-list" }),
      "Auth/RoleGet": always(roleGet),
      ...answers,
    },
  });
}

/** The `etcd-auth-password` service as its reader: signed in with a password, refused root's listings. */
function readerWire(answers: Record<string, readonly RecordedEtcdAnswer[]> = {}): RecordedEtcdWire {
  return recordedEtcdWire({
    service: "etcd-auth-password",
    answers: {
      "Auth/Authenticate": always({ fixture: "etcd-auth-password/authenticate" }),
      "Auth/AuthStatus": always({ fixture: "etcd-auth/auth-status-on" }),
      "Auth/UserGet": always({ fixture: "etcd-auth/user-get-reader" }),
      "Auth/RoleGet": always({ fixture: "etcd-auth/role-get-reader" }),
      "KV/Range": always(servedRange(readerMayRead)),
      "Cluster/MemberList": always({ fixture: "etcd/member-list-serializable" }),
      "Maintenance/Alarm": always({ fixture: "etcd/alarm-list-none" }),
      "Auth/UserList": always({ fixture: "etcd-auth/error-permission-denied-user-list" }),
      "Auth/RoleList": always({ fixture: "etcd-auth/error-permission-denied-role-list" }),
      "Lease/LeaseLeases": always({ fixture: "etcd-auth/error-permission-denied-lease-leases" }),
      ...answers,
    },
  });
}

const ETCD: DatabaseConnection = {
  id: "etcd-recorded",
  name: "etcd",
  type: "etcd",
  host: "127.0.0.1",
  port: 2379,
  createdAt: new Date(0),
};
const READER_PASSWORD = "recorded-wire-reader";
const READER: DatabaseConnection = {
  id: "etcd-recorded-reader",
  name: "etcd reader",
  type: "etcd",
  host: "127.0.0.1",
  port: 12479,
  user: "reader",
  password: READER_PASSWORD,
  ssl: { mode: "require" },
  createdAt: new Date(0),
};

/** A provider over the real adapter and `wire`, counting the factory's calls. */
function overWire(connection: DatabaseConnection, wire: RecordedEtcdWire, options: ProviderOptions = {}) {
  let calls = 0;
  const provider = new EtcdProvider(connection, options, {}, (connectionOptions, hooks) => {
    calls += 1;
    return createGrpcEtcdClient(connectionOptions, hooks, wire.transport);
  });
  return { provider, factoryCalls: () => calls };
}

async function connected(connection: DatabaseConnection, wire: RecordedEtcdWire) {
  const built = overWire(connection, wire);
  await built.provider.connect();
  return built;
}

async function failure(pending: Promise<unknown>): Promise<Error> {
  return pending.then(
    () => {
      throw new Error("it succeeded");
    },
    (error: unknown) => error as Error,
  );
}

/** A self-signed certificate for `subject`, made with openssl and never written into the repository. */
function selfSigned(subject: string): { readonly cert: string; readonly key: string } {
  const dir = mkdtempSync(join(tmpdir(), "etcd-integration-cert-"));
  try {
    const made = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-subj",
        subject,
        "-days",
        "1",
      ],
      { stderr: "pipe" },
    );
    if (made.exitCode !== 0) throw new Error(`openssl made no test certificate: ${made.stderr.toString()}`);
    return { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The groups spec 4.1's rule makes of the seeded keys: the walk's oracle, in sorted order. */
const SEEDED_GROUPS = prefixGroups(ALL.kvs.map((kv) => kv.key))
  .groups.map(groupLabel)
  .sort();

const USERS = etcdFixture<{ readonly users: readonly string[] }>("etcd-auth/user-list").users;
const ROLES = etcdFixture<{ readonly roles: readonly string[] }>("etcd-auth/role-list").roles;
const MEMBERS = etcdFixture<{ readonly members: readonly unknown[] }>("etcd/member-list-serializable").members;

/** What the agent's capture is handed, the context-snapshot suite's harness with the provider behind it. */
function agentContext(provider: EtcdProvider, connection: DatabaseConnection): AgentToolContext {
  const clock = () => 1_000;
  return {
    runId: "run-etcd",
    modelId: "unmeasured-model-for-tests",
    mode: "agent",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
}

async function snapshotOf(provider: EtcdProvider, connection: DatabaseConnection): Promise<AgentContextSnapshot> {
  const capture = await captureContextSnapshot(agentContext(provider, connection));
  if (capture.kind !== "captured") throw new Error(`expected a capture, got ${capture.kind}`);
  return capture.snapshot;
}

/** The tree's rows as the Studio draws them, every folder open. */
async function treeOf(provider: EtcdProvider) {
  const capabilities = provider.getCapabilities();
  const kinds = enumerableKinds(capabilities);
  const counts = await provider.countObjects([]);
  const objects: Record<string, readonly DatabaseObject[]> = {};
  const listed = await Promise.all(
    kinds.map(async (kind) =>
      "unavailable" in (counts[kind.id] ?? {}) ? [kind.id, []] : [kind.id, await provider.listObjects([], kind.id)],
    ),
  );
  for (const [id, list] of listed) objects[id as string] = list as readonly DatabaseObject[];
  return flattenTree({
    kinds,
    containers: await provider.listContainers(),
    expanded: new Set(kinds.map((kind) => kind.id)),
    counts: { "": counts },
    objects,
    details: {},
    readsColumns: true,
    containerDepth: containerDepth(capabilities),
  });
}

// ============================================================================
// The captures
// ============================================================================

describe("the captures this file reads", () => {
  const READ = [
    "etcd/range-keys-only-all",
    ...VALUE_CAPTURES,
    "etcd/lease-leases",
    "etcd/lease-time-to-live-keys",
    "etcd/member-list-serializable",
    "etcd/status",
    "etcd/auth-status-off",
    "etcd/alarm-list-none",
    "etcd/error-authenticate-not-enabled",
    "etcd-cluster/error-no-leader",
    "etcd-cluster/status-no-leader",
    "etcd-auth/auth-status-on",
    "etcd-auth/user-list",
    "etcd-auth/role-list",
    "etcd-auth/user-get-reader",
    "etcd-auth/user-get-cert-only",
    "etcd-auth/role-get-reader",
    "etcd-auth/error-permission-denied",
    "etcd-auth/error-permission-denied-user-list",
    "etcd-auth/error-permission-denied-role-list",
    "etcd-auth/error-permission-denied-lease-leases",
    "etcd-auth/error-user-name-not-found",
    "etcd-auth-password/authenticate",
    "etcd-auth-password/status",
    "etcd-auth-password/error-authenticate-wrong-password",
    "etcd-auth-password/error-auth-revision-old",
    "etcd-auth-password/error-user-name-empty-certificate",
  ];

  test.each(READ)("%s was answered by the pinned build", (name) => {
    expect(etcdCapture(name).$captured).toMatchObject({ image: IMAGE, digest: DIGEST });
  });

  test("the one keys-only capture holds the whole seeded key space", () => {
    expect(ALL.more).toBe(false);
    expect(ALL.kvs).toHaveLength(Number(ALL.count));
  });

  test("the reader's grants this file checks are the captured role's", () => {
    const role = etcdFixture<{ readonly perm: ReadonlyArray<{ permType: string; key: Buffer; range_end: Buffer }> }>(
      "etcd-auth/role-get-reader",
    );
    expect(role.perm.map((perm) => [perm.permType, perm.key.toString(), perm.range_end.toString()])).toEqual([
      ["READ", "/app/", "/app0"],
      ["READ", "/config/a", ""],
    ]);
  });

  test("the served key space holds the secret and the envelopes E9 greps for (the grep's control)", () => {
    const served = Buffer.concat([...VALUES.values()]);
    expect(served.includes("libredb-fixture-secret")).toBe(true);
    expect(served.includes("bGlicmVkYi1maXh0dXJlLXNlY3JldA")).toBe(true);
    expect(served.includes(Buffer.from("k8s\u0000"))).toBe(true);
    expect(served.includes("k8s:enc:")).toBe(true);
  });
});

// ============================================================================
// Connect and disconnect (spec 6.1, 4.7, E16)
// ============================================================================

describe("connect, on one channel (spec 6.1, E16)", () => {
  test("with authentication off: AuthStatus and Status on one channel, closed by disconnect", async () => {
    const wire = clusterWire();
    const { provider, factoryCalls } = await connected(ETCD, wire);
    expect(factoryCalls()).toBe(1);
    expect(wire.opened).toHaveLength(1);
    expect(wire.calls.map((call) => call.rpc)).toEqual(["Auth/AuthStatus", "Maintenance/Status"]);
    await provider.disconnect();
    expect(wire.closes).toBe(1);
    await provider.connect();
    expect(wire.opened).toHaveLength(2);
    await provider.disconnect();
  });

  test("as the reader: the sign-in, Status, AuthStatus and the reader's grants, every call after the sign-in with its token", async () => {
    const wire = readerWire();
    const { provider } = await connected(READER, wire);
    expect(wire.calls.map((call) => call.rpc)).toEqual([
      "Auth/Authenticate",
      "Maintenance/Status",
      "Auth/AuthStatus",
      "Auth/UserGet",
      "Auth/RoleGet",
    ]);
    expect(wire.calls.slice(1).every((call) => call.metadata.token === "<token>")).toBe(true);
    await provider.disconnect();
  });

  test("a member that lost its leader fails the connect at once, and the channel is closed (spec 4.7)", async () => {
    const wire = clusterWire({ "Auth/AuthStatus": [{ fixture: "etcd-cluster/error-no-leader" }] });
    const { provider } = overWire(ETCD, wire);
    const refused = await failure(provider.connect());
    expect(refused).toBeInstanceOf(ConnectionError);
    expect(refused.message).toContain("the cluster has lost quorum, so nothing was applied");
    expect(refused.message).toContain("(etcd: no leader)");
    expect(wire.closes).toBe(1);
    expect(provider.isConnected()).toBe(false);
  });

  test("a Status that names no leader fails the connect too", async () => {
    const wire = clusterWire({ "Maintenance/Status": [{ fixture: "etcd-cluster/status-no-leader" }] });
    const { provider } = overWire(ETCD, wire);
    expect(await failure(provider.connect())).toBeInstanceOf(ConnectionError);
    expect(wire.closes).toBe(1);
  });

  test("step 1 on an etcd whose authentication is off refuses the password, in etcd's words after the provider's", async () => {
    const wire = readerWire({ "Auth/Authenticate": [{ fixture: "etcd/error-authenticate-not-enabled" }] });
    const { provider } = overWire(READER, wire);
    const refused = await failure(provider.connect());
    expect(refused).toBeInstanceOf(DatabaseConfigError);
    expect(refused.message).toBe(
      "Authentication is not enabled on this etcd, so the User and Password would not be used. Clear them to connect. (etcd: authentication is not enabled)",
    );
    expect(refused.message).not.toContain(READER_PASSWORD);
    expect(wire.closes).toBe(1);
  });

  test("step 1 with a wrong password is the sign-in's refusal", async () => {
    const wire = readerWire({
      "Auth/Authenticate": [{ fixture: "etcd-auth-password/error-authenticate-wrong-password" }],
    });
    const { provider } = overWire(READER, wire);
    const refused = await failure(provider.connect());
    expect(refused).toBeInstanceOf(AuthenticationError);
    expect(refused.message).not.toContain(READER_PASSWORD);
  });

  test("step 3: authentication on and no credential is refused after AuthStatus alone", async () => {
    const wire = readerWire();
    const { provider } = overWire({ ...ETCD, ssl: { mode: "require" } }, wire);
    expect((await failure(provider.connect())).message).toBe(
      "This etcd has authentication enabled. Enter a User and Password, or add a client certificate under SSL / TLS whose Common Name is an etcd user.",
    );
    expect(wire.calls.map((call) => call.rpc)).toEqual(["Auth/AuthStatus"]);
  });

  test("step 4: a certificate whose Common Name etcd does not know is named", async () => {
    const certificate = selfSigned("/CN=unknown-user");
    const wire = readerWire({ "Auth/UserGet": [{ fixture: "etcd-auth/error-user-name-not-found" }] });
    const { provider } = overWire(
      { ...ETCD, ssl: { mode: "require", clientCert: certificate.cert, clientKey: certificate.key } },
      wire,
    );
    expect((await failure(provider.connect())).message).toBe(
      'The client certificate\'s Common Name "unknown-user" is not an etcd user. (etcd: user name not found)',
    );
    expect(wire.calls.map((call) => call.rpc)).toEqual(["Auth/AuthStatus", "Auth/UserGet"]);
  });

  test("step 4: an etcd that did not read the certificate is told to run with --client-cert-auth", async () => {
    const certificate = selfSigned("/CN=cert-only");
    const wire = readerWire({
      "Auth/UserGet": [{ fixture: "etcd-auth-password/error-user-name-empty-certificate" }],
    });
    const { provider } = overWire(
      { ...ETCD, ssl: { mode: "require", clientCert: certificate.cert, clientKey: certificate.key } },
      wire,
    );
    expect((await failure(provider.connect())).message).toBe(
      "etcd did not read the client certificate: the server must run with --client-cert-auth. (etcd: user name is empty)",
    );
  });
});

// ============================================================================
// The object surface (spec 4, gate 1)
// ============================================================================

describe("the object surface (spec 4, gate 1)", () => {
  const KINDS = {
    prefix: SEEDED_GROUPS.length,
    member: MEMBERS.length,
    lease: 1,
    user: USERS.length,
    role: ROLES.length,
  };

  test.each([
    ["a JSON value", "/app/cfg"],
    ["a text value", "/app/a/b"],
  ])("satisfies the object-surface contract, the key sample holding %s", async (_label, key) => {
    const { provider } = await connected(ETCD, clusterWire());
    await assertObjectSurface(provider, {
      // A zero-level engine lists no containers, and the helper addresses every object at the root.
      containers: [],
      kinds: KINDS,
      sampleObject: { path: [SEEDED_GROUPS[0]], kind: "prefix" },
      // A key no capture holds, read under the kind whose read decides existence.
      absentSource: { path: ["/app/no-such-key"], kind: "key" },
      keyBrowserSample: { path: [key], kind: "key" },
    });
    await provider.disconnect();
  });

  test("lists the groups spec 4.1's rule makes of the seeded keys, and no key name", async () => {
    const { provider } = await connected(ETCD, clusterWire());
    const groups = (await provider.listObjects([], "prefix")).map((group) => group.name).sort();
    expect(groups).toEqual(SEEDED_GROUPS);
    const keys = new Set(ALL.kvs.map((kv) => kv.key.toString()));
    expect(groups.filter((group) => keys.has(group))).toEqual([]);
  });

  test("the tree draws five folders, and none for the key kind the Keys panel enumerates (spec 3.4, 4.1)", async () => {
    const { provider } = await connected(ETCD, clusterWire());
    const rows = await treeOf(provider);
    expect(rows.filter((row) => row.kind === "folder").map((row) => [row.id, row.label, row.depth, row.badge])).toEqual(
      [
        ["prefix", "Key Prefixes", 0, String(KINDS.prefix)],
        ["member", "Members", 0, String(KINDS.member)],
        ["lease", "Leases", 0, "1"],
        ["user", "Users", 0, String(KINDS.user)],
        ["role", "Roles", 0, String(KINDS.role)],
      ],
    );
  });
});

// ============================================================================
// E9 and E13
// ============================================================================

describe("E9: no withheld value leaves any surface", () => {
  test("every serialised answer over the Kubernetes-shaped keys holds neither the secret nor an envelope's bytes", async () => {
    const { provider } = await connected(ETCD, clusterWire());
    const answers = await Promise.all([
      provider.query("get /registry/ --prefix"),
      provider.query("get registry/ --prefix"),
      provider.query("get /tenant-a/ --prefix"),
      provider.readObjectSource(["/registry/secrets/default/db-creds"], "key"),
      provider.readObjectSource(["registry/secrets/default/legacy"], "key"),
      provider.readObjectSource(["/registry/pods/default/nginx"], "key"),
      provider.readObjectSource(["/registry/configmaps/default/encrypted"], "key"),
      provider.readObjectSource(["/tenant-a/configmaps/default/cm"], "key"),
      provider.scanKeysPage({ cursor: "0", count: 100, pattern: "/registry/" }),
      provider.listObjects([], "prefix"),
      provider.describeObjects([], "prefix"),
      provider.countObjects([]),
      provider.getOverview(),
      provider.getTableStats(),
    ]);
    const serialised = JSON.stringify(answers);
    for (const marker of [
      "libredb-fixture-secret",
      "bGlicmVkYi1maXh0dXJlLXNlY3JldA",
      "k8s\\u0000",
      "azhzAA",
      "k8s:enc:",
      "azhzOmVu",
    ]) {
      expect({ marker, found: serialised.includes(marker) }).toEqual({ marker, found: false });
    }
  });
});

describe("E13: key names stay in the Keys panel and the Source tab", () => {
  test("the grounding capture over the seeded key space holds no key name", async () => {
    const { provider } = await connected(ETCD, clusterWire());
    const captured = JSON.stringify(await snapshotOf(provider, ETCD));
    const texts = ALL.kvs.map((kv) => kv.key.toString("utf8")).filter((text) => !text.includes("�"));
    // `plain` is a word prose may hold, so it is looked for as the JSON string a name would be.
    for (const text of texts) {
      const needle = text === "plain" ? JSON.stringify(text) : text;
      expect({ key: text, found: captured.includes(needle) }).toEqual({ key: text, found: false });
    }
  });

  test("as the reader granted one key, that key's name is in no capture, row or badge, and only in readRanges", async () => {
    const { provider } = await connected(READER, readerWire());
    const groups = await provider.listObjects([], "prefix");
    expect(groups.find((group) => group.name === "/config/*")?.readRanges).toEqual([{ key: "/config/a" }]);
    expect(JSON.stringify(await snapshotOf(provider, READER))).not.toContain("/config/a");
    const rows = await treeOf(provider);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect([row.id, row.label, row.badge ?? "", row.badgeTitle ?? ""].join(" ")).not.toContain("/config/a");
    }
  });
});

// ============================================================================
// A user who is not root (spec 4.3, 4.7)
// ============================================================================

describe("the reader of spec 9 (spec 4.3, 4.7)", () => {
  test("counts its groups over its two ranges, names no range, and says which three kinds it may not list", async () => {
    const { provider } = await connected(READER, readerWire());
    const counts = await provider.countObjects([]);
    expect(counts.prefix).toEqual({ count: 3, sampledFrom: "the 2 ranges etcd user reader may read" });
    expect(counts.member).toEqual({ count: 1 });
    expect(counts.user).toEqual({
      unavailable: "Listing users needs the etcd root role, which reader does not hold (etcd: permission denied)",
    });
    expect(counts.role).toEqual({
      unavailable: "Listing roles needs the etcd root role, which reader does not hold (etcd: permission denied)",
    });
    expect(counts.lease).toEqual({
      unavailable: "Listing leases needs READ on every leased key in the cluster (etcd: permission denied)",
    });
  });

  test("a refused listing is etcd's refusal, never an empty folder", async () => {
    const { provider } = await connected(READER, readerWire());
    const refusals = await Promise.all(
      ["user", "role", "lease"].map((kind) => failure(provider.listObjects([], kind))),
    );
    for (const refused of refusals) expect(refused).toBeInstanceOf(QueryError);
  });

  test("a typed read outside the grants carries what the reader may read (spec 5.6)", async () => {
    const { provider } = await connected(READER, readerWire());
    const refused = await failure(provider.query("get /feature-flag"));
    expect(refused).toBeInstanceOf(QueryError);
    expect(refused.message).toContain("etcd user reader may read: ");
    expect(refused.message).toContain("(etcd: permission denied)");
  });

  test("a renewal on the stale auth revision narrows the next walk to the grants read again (R13 D10)", async () => {
    const narrowed = () => {
      const role = etcdFixture<{ readonly header: WireHeader; readonly perm: ReadonlyArray<{ readonly key: Buffer }> }>(
        "etcd-auth/role-get-reader",
      );
      return { ...role, perm: role.perm.filter((perm) => perm.key.toString() === "/config/a") };
    };
    const wire = readerWire({
      "KV/Range": [{ fixture: "etcd-auth-password/error-auth-revision-old" }, ...always(servedRange(readerMayRead))],
      "Auth/RoleGet": [{ fixture: "etcd-auth/role-get-reader" }, ...always(narrowed)],
    });
    const { provider } = await connected(READER, wire);
    // The first Range meets "revision of auth store is old": the adapter signs in again, retries it, and
    // reports the change through the factory's hook.
    expect((await provider.query("get /app/cfg")).rowCount).toBe(1);
    const renewed = wire.calls.findIndex((call, index) => index > 5 && call.rpc === "Auth/Authenticate");
    expect(renewed).toBeGreaterThan(5);
    const counts = await provider.countObjects([]);
    expect(counts.prefix).toMatchObject({ count: 1 });
    const reread = wire.calls.map((call) => call.rpc).lastIndexOf("Auth/RoleGet");
    expect(reread).toBeGreaterThan(renewed);
    const walked = wire.calls.slice(reread + 1).filter((call) => call.rpc === "KV/Range");
    expect(walked.length).toBeGreaterThan(0);
    for (const call of walked) {
      expect(Buffer.from((call.request as WireRangeRequest).key ?? new Uint8Array()).toString()).toStartWith(
        "/config/a",
      );
    }
  });
});

describe("plan mode as a user who is not root, over a fake client (spec 4.7)", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const PERMISSIONS: readonly EtcdPermission[] = [
    { type: "read", key: encode("/app/"), rangeEnd: encode("/app0") },
    { type: "read", key: encode("/config/a") },
  ];
  const STATUS: EtcdStatus = {
    header: KEY_SPACE_HEADER,
    version: "3.7.2",
    dbSize: "20480",
    dbSizeInUse: "16384",
    dbSizeQuota: "0",
    leader: "10276657743932975437",
    raftIndex: "40",
    raftTerm: "2",
    raftAppliedIndex: "40",
    errors: [],
    isLearner: false,
    storageVersion: "3.7.0",
  };
  const MEMBER: EtcdMember = {
    id: "10276657743932975437",
    name: "etcd-1",
    peerUrls: ["http://127.0.0.1:2380"],
    clientUrls: ["http://127.0.0.1:2379"],
    isLearner: false,
  };

  test("the walk grounds the groups and the member, lists none of the three refused kinds, and notes each", async () => {
    const client = createFakeEtcdClient({
      authenticate: async () => {},
      status: async () => STATUS,
      authStatus: async () => ({ enabled: true, authRevision: "5" }),
      userGet: async () => ["reader"],
      roleGet: async () => PERMISSIONS,
      range: keySpaceRange(
        [
          { key: "/app/a/b", value: "nested" },
          { key: "/app/cfg", value: '{"mode":"blue"}' },
          { key: "/app/x/y", value: "deeper" },
          { key: "/config/a", value: "alpha" },
          { key: "/config/b", value: "beta" },
        ],
        PERMISSIONS,
      ),
      memberList: async () => ({ header: KEY_SPACE_HEADER, members: [MEMBER] }),
      alarmList: async () => [],
      userList: async () => {
        throw permissionDenied();
      },
      roleList: async () => {
        throw permissionDenied();
      },
      leaseLeases: async () => {
        throw permissionDenied();
      },
      close: async () => {},
    });
    const provider = new EtcdProvider(READER, {}, {}, async () => client);
    await provider.connect();
    const listObjects = spyOn(provider, "listObjects");

    const snapshot = await snapshotOf(provider, READER);

    expect(new Set(listObjects.mock.calls.map((call) => call[1]))).toEqual(new Set(["prefix", "member"]));
    const byKind = Object.groupBy(snapshot.objects, (object) => object.kind ?? "");
    expect(byKind.prefix?.map((object) => object.name).sort()).toEqual(["/app/a/*", "/app/x/*", "/config/*"]);
    expect(byKind.member?.map((object) => object.name)).toHaveLength(1);
    const sentences = {
      user: "Listing users needs the etcd root role, which reader does not hold (etcd: permission denied)",
      role: "Listing roles needs the etcd root role, which reader does not hold (etcd: permission denied)",
      lease: "Listing leases needs READ on every leased key in the cluster (etcd: permission denied)",
    };
    for (const [kind, sentence] of Object.entries(sentences)) {
      expect(snapshot.kinds?.find((entry) => entry.id === kind)?.unavailable).toBe(sentence);
    }
    const packed = packContextForTask(snapshot, "which key prefixes may the reader read?");
    for (const [plural, sentence] of [
      ["Users", sentences.user],
      ["Roles", sentences.role],
      ["Leases", sentences.lease],
    ]) {
      expect(packed).toContain(
        `The ${plural} could not be read: ${sentence}. Do not read their absence below as an absence in the database.`,
      );
    }
  });
});

// ============================================================================
// E1 and E2 before any socket (spec 3.1)
// ============================================================================

describe("E1 and E2 refuse before the factory and before any socket (spec 3.1, E1, E2)", () => {
  /** A local listener that counts every connection it accepts and answers none. */
  async function listener() {
    let accepts = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      accepts += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as net.AddressInfo;
    return {
      port,
      accepts: () => accepts,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
  }

  /** A provider over the real adapter and the real gRPC transport, counting the factory's calls. */
  function real(connection: DatabaseConnection) {
    let calls = 0;
    const provider = new EtcdProvider(connection, { queryTimeout: 500 }, {}, (options, hooks) => {
      calls += 1;
      return createGrpcEtcdClient(options, hooks);
    });
    return { provider, factoryCalls: () => calls };
  }

  test("E1: a host carrying the port is refused, with no factory call and no accept", async () => {
    const local = await listener();
    try {
      const { provider, factoryCalls } = real({ ...ETCD, host: `127.0.0.1:${local.port}`, port: local.port });
      const dialect: ProviderCapabilities["queryDialect"] = "etcd";
      expect(provider.getCapabilities().queryDialect).toBe(dialect);
      const refused = await failure(provider.connect());
      expect(refused).toBeInstanceOf(DatabaseConfigError);
      expect(refused.message).toBe(
        "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.",
      );
      expect(refused.message).not.toContain(String(local.port));
      expect(factoryCalls()).toBe(0);
      expect(local.accepts()).toBe(0);
    } finally {
      await local.close();
    }
  });

  test("E2: a password with TLS off is refused, echoed nowhere, with no factory call and no accept", async () => {
    const local = await listener();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { provider, factoryCalls } = real({ ...READER, host: "127.0.0.1", port: local.port, ssl: undefined });
      const refused = await failure(provider.connect());
      expect(refused).toBeInstanceOf(DatabaseConfigError);
      expect(refused.message).toBe(
        "A User or Password needs TLS on etcd: choose an SSL mode under SSL / TLS, or clear them. A plaintext etcd with password authentication cannot be connected.",
      );
      expect(refused.message).not.toContain(READER_PASSWORD);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(READER_PASSWORD);
      expect(factoryCalls()).toBe(0);
      expect(local.accepts()).toBe(0);
    } finally {
      logged.mockRestore();
      await local.close();
    }
  });

  test("the control: an accepted connection dials the listener, which is what the two above would have recorded", async () => {
    const local = await listener();
    try {
      const { provider, factoryCalls } = real({ ...ETCD, host: "127.0.0.1", port: local.port });
      // The listener speaks no HTTP/2, so the first call reaches its deadline; the accept is what is measured.
      await failure(provider.connect());
      expect(factoryCalls()).toBe(1);
      expect(local.accepts()).toBeGreaterThan(0);
    } finally {
      await local.close();
    }
  });
});
