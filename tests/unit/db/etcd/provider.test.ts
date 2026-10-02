/**
 * EtcdProvider at its own seam (#1089, spec 3.1, 3.5): the declarations with no client; the connect sequence
 * of spec 6.1 step by step, with the calls each step makes; the grants of 4.7 and their re-read after an
 * auth-store change (R13 D10); the query path's refusals and bounds (5.4); cancelQuery (5.5); and that every
 * surface answers exactly what the module that owns it answers over the same client and the same context,
 * with the same calls, so the provider composes and never reshapes.
 *
 * Every client is the shared fake of `tests/helpers/etcd-fake-client.ts` over the key space of
 * `tests/helpers/etcd-key-space.ts`; the real adapter over etcd's recorded answers runs in
 * `tests/integration/db/etcd-provider.test.ts`. The client certificates of certificate mode are generated with
 * openssl when the file starts and never written into the repository.
 */
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import {
  type EtcdAlarm,
  type EtcdClient,
  type EtcdClientHooks,
  EtcdError,
  type EtcdMember,
  type EtcdPermission,
  type EtcdStatus,
} from "@/lib/db/providers/keyvalue/etcd/client";
import { parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import {
  buildEtcdConnectionOptions,
  ETCD_DEFAULT_PORT,
  etcdErrorConnection,
} from "@/lib/db/providers/keyvalue/etcd/connection-options";
import { applyEtcdValueEdit, buildEtcdValueEdit, type EtcdEditPlanStamp } from "@/lib/db/providers/keyvalue/etcd/edit";
import { toEtcdError, toProviderError } from "@/lib/db/providers/keyvalue/etcd/errors";
import { ETCD_READ_BOUNDS, executeCommand } from "@/lib/db/providers/keyvalue/etcd/execute";
import { assessCommand } from "@/lib/db/providers/keyvalue/etcd/guard";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { ETCD_KEY_SCAN, scanEtcdKeysPage } from "@/lib/db/providers/keyvalue/etcd/key-scan";
import { groupLabel, memberHexId, prefixGroups } from "@/lib/db/providers/keyvalue/etcd/keys";
import { ETCD_LABELS } from "@/lib/db/providers/keyvalue/etcd/labels";
import { ETCD_SCHEMA_REFRESH_PATTERN } from "@/lib/db/providers/keyvalue/etcd/lexer";
import {
  ETCD_MAINTENANCE_OPERATIONS,
  ETCD_MAINTENANCE_SPECS,
  runEtcdMaintenance,
} from "@/lib/db/providers/keyvalue/etcd/maintenance";
import {
  readEtcdHealth,
  readEtcdOverview,
  readEtcdStorageStats,
  readEtcdTableStats,
} from "@/lib/db/providers/keyvalue/etcd/monitoring-reads";
import {
  countEtcdObjects,
  describeEtcdObject,
  describeEtcdObjects,
  ETCD_OBJECT_KINDS,
  type EtcdSurfaceContext,
  listEtcdObjects,
  readEtcdObjectSource,
} from "@/lib/db/providers/keyvalue/etcd/objects";
import { describeScope, readableScope, writableScope } from "@/lib/db/providers/keyvalue/etcd/permissions";
import { commandResult } from "@/lib/db/providers/keyvalue/etcd/results";
import { readOnlySentence, refuseBeforeSend } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import type {
  DatabaseConnection,
  DatabaseProvider,
  ObjectEditBuild,
  ObjectEditPlan,
  ObjectEditRefusal,
  ProviderCapabilities,
  ProviderExecutionContext,
} from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../../helpers/etcd-fake-client";
import { KEY_SPACE_HEADER, type KeySpaceEntry, keySpaceRange, permissionDenied } from "../../../helpers/etcd-key-space";

const QUERY_TIMEOUT = 5_000;
const PASSWORD = "unit-reader-password";
const encode = (text: string) => new TextEncoder().encode(text);

const CONNECTION: DatabaseConnection = {
  id: "etcd-unit",
  name: "etcd unit",
  type: "etcd",
  host: "etcd.test",
  port: 2379,
  createdAt: new Date(0),
};
/** Password sign-in, which needs TLS (spec E2); `require` verifies nothing, which no fake minds. */
const PASSWORD_CONNECTION: DatabaseConnection = {
  ...CONNECTION,
  user: "reader",
  password: PASSWORD,
  ssl: { mode: "require" },
};

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
/** A raised NOSPACE alarm, and an answer for each maintenance call, so every operation has a request to send. */
const ALARM: EtcdAlarm = { memberId: MEMBER.id, alarm: "nospace" };
const MAINTENANCE: Partial<EtcdClient> = {
  compact: async () => {},
  defragment: async () => {},
  alarmList: async () => [ALARM],
  alarmDisarm: async (alarm) => [alarm],
};

/** The shapes of the prefix-group rule (spec 4.1): a deep and a flat first segment, and a key in no group. */
const KEYS: readonly KeySpaceEntry[] = [
  { key: "/app/a/b", value: "nested" },
  { key: "/app/cfg", value: '{"mode":"blue"}' },
  { key: "/app/x/y", value: "deeper" },
  { key: "/config/a", value: "alpha" },
  { key: "/config/b", value: "beta" },
  { key: "/feature-flag", value: "enabled" },
];

/** The reader of spec 9: READ on the prefix /app/ and on the single key /config/a. */
const READER_PERMISSIONS: readonly EtcdPermission[] = [
  { type: "read", key: encode("/app/"), rangeEnd: encode("/app0") },
  { type: "read", key: encode("/config/a") },
];

/** A value edit of a key KEYS holds. */
const REQUEST = { path: ["/app/cfg"], kind: "key", partId: "value", text: '{"mode":"green"}' } as const;

const denied = () => permissionDenied();
const notEnabled = () => new EtcdError("failed-precondition", "etcdserver: authentication is not enabled", 9);
const nameEmpty = () => new EtcdError("unauthenticated", "etcdserver: user name is empty", 3);
const userNotFound = () => new EtcdError("failed-precondition", "etcdserver: user name not found", 9);
const unavailable = () => new EtcdError("unavailable", "etcdserver: request timed out", 14);

/** A cluster with authentication off, over KEYS. */
function etcdClient(overrides: Partial<EtcdClient> = {}): FakeEtcdClient {
  return createFakeEtcdClient({
    authStatus: async () => ({ enabled: false, authRevision: "1" }),
    status: async () => STATUS,
    range: keySpaceRange(KEYS),
    memberList: async () => ({ header: KEY_SPACE_HEADER, members: [MEMBER] }),
    alarmList: async () => [],
    leaseLeases: async () => ({ header: KEY_SPACE_HEADER, ids: [] }),
    userList: async () => [],
    roleList: async () => [],
    close: async () => {},
    ...overrides,
  });
}

/** The same cluster with authentication on, signed in as the reader, whose listings of users, roles and leases etcd refuses. */
function readerClient(overrides: Partial<EtcdClient> = {}): FakeEtcdClient {
  return etcdClient({
    authenticate: async () => {},
    authStatus: async () => ({ enabled: true, authRevision: "5" }),
    userGet: async () => ["reader"],
    roleGet: async () => READER_PERMISSIONS,
    range: keySpaceRange(KEYS, READER_PERMISSIONS),
    userList: async () => {
      throw denied();
    },
    roleList: async () => {
      throw denied();
    },
    leaseLeases: async () => {
      throw denied();
    },
    ...overrides,
  });
}

/** A self-signed certificate and its key for `subject`, made with openssl and never written into the repository. */
function selfSigned(subject: string): { readonly cert: string; readonly key: string } {
  const dir = mkdtempSync(join(tmpdir(), "etcd-provider-cert-"));
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

let CERTIFICATE_CONNECTION: DatabaseConnection = CONNECTION;
let NAMELESS_CERTIFICATE_CONNECTION: DatabaseConnection = CONNECTION;
beforeAll(() => {
  const named = selfSigned("/CN=cert-only");
  const nameless = selfSigned("/O=libredb-test");
  CERTIFICATE_CONNECTION = { ...CONNECTION, ssl: { mode: "require", clientCert: named.cert, clientKey: named.key } };
  NAMELESS_CERTIFICATE_CONNECTION = {
    ...CONNECTION,
    ssl: { mode: "require", clientCert: nameless.cert, clientKey: nameless.key },
  };
});

interface Built {
  readonly provider: EtcdProvider;
  readonly hooks: EtcdClientHooks[];
  readonly factoryCalls: () => number;
}

/** A provider whose factory hands out `client` and records the hooks it was given. */
function build(
  connection: DatabaseConnection,
  client: FakeEtcdClient,
  execution: ProviderExecutionContext = {},
): Built {
  const hooks: EtcdClientHooks[] = [];
  let calls = 0;
  const provider = new EtcdProvider(connection, { queryTimeout: QUERY_TIMEOUT }, execution, async (_options, hook) => {
    calls += 1;
    if (hook !== undefined) hooks.push(hook);
    return client;
  });
  return { provider, hooks, factoryCalls: () => calls };
}

async function connected(
  connection: DatabaseConnection,
  client: FakeEtcdClient,
  execution: ProviderExecutionContext = {},
): Promise<Built> {
  const built = build(connection, client, execution);
  await built.provider.connect();
  return built;
}

const methods = (client: FakeEtcdClient, from = 0) => client.calls.slice(from).map((call) => call.method);

/**
 * The calls from `from` on, each without its call options, since every call carries a signal of its own, and
 * without a watch's batch callback, which every caller makes its own.
 */
function callsOf(client: FakeEtcdClient, from = 0): Array<{ readonly method: string; readonly args: unknown[] }> {
  return client.calls.slice(from).map((call) => ({
    method: String(call.method),
    args: call.args.filter(
      (arg) => typeof arg !== "function" && !(typeof arg === "object" && arg !== null && "signal" in arg),
    ),
  }));
}

/** The context the provider builds for a surface call, built here from the same inputs. */
function contextFor(connection: DatabaseConnection, permissions?: readonly EtcdPermission[]): EtcdSurfaceContext {
  const options = buildEtcdConnectionOptions(connection, { executionReadOnly: false, queryTimeout: QUERY_TIMEOUT });
  return {
    readable: permissions === undefined ? { kind: "all" } : readableScope(permissions),
    writable: permissions === undefined ? { kind: "all" } : writableScope(permissions),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT),
    now: () => Date.now(),
    errors: etcdErrorConnection(options),
  };
}

const LIMITS = {
  maxLimit: DEFAULT_QUERY_LIMIT,
  txnRangeLimit: ETCD_READ_BOUNDS.firstPageSize,
  maxCommandTimeoutMs: QUERY_TIMEOUT,
  maxWatchWindowMs: Math.max(0, QUERY_TIMEOUT - ETCD_READ_BOUNDS.watchMarginMs),
};

/** Waits for `condition`, polling every 2 ms, at most `tries` times; recursive, so no await sits in a loop. */
async function until(condition: () => boolean, tries = 500): Promise<void> {
  if (condition()) return;
  if (tries === 0) throw new Error("the condition never held");
  await Bun.sleep(2);
  return until(condition, tries - 1);
}

/**
 * The parser's refusal of `text` under `limits`, the provider's own caps by default; a text that parses is a
 * mistake in the test.
 */
function refusalOf(text: string, limits = LIMITS): string {
  const parsed = parseEtcdCommand(text, limits);
  if (parsed.ok) throw new Error(`${JSON.stringify(text)} parsed`);
  return parsed.refusal.message;
}

// ============================================================================
// Declarations
// ============================================================================

describe("the declarations, with no client (spec 3.1, 6.2, 6.3)", () => {
  test("the constructor validates and opens nothing: a refused host still declares, and connect refuses before the factory", async () => {
    const client = etcdClient();
    const { provider, factoryCalls } = build({ ...CONNECTION, host: "etcd:2379" }, client);
    const dialect: ProviderCapabilities["queryDialect"] = "etcd";
    expect(provider.getCapabilities().queryDialect).toBe(dialect);
    expect(provider.getLabels()).toEqual(ETCD_LABELS);
    expect(provider.isConnected()).toBe(false);
    await expect(provider.connect()).rejects.toThrow(
      new DatabaseConfigError(
        "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.",
        "etcd",
      ),
    );
    expect(factoryCalls()).toBe(0);
    expect(client.calls).toEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  test("the capabilities of spec 6.2, every member written out", () => {
    const { provider } = build(CONNECTION, etcdClient());
    const declared: ProviderCapabilities = {
      queryLanguage: "json",
      queryDialect: "etcd",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: [...ETCD_MAINTENANCE_OPERATIONS],
      maintenanceOperationSpecs: ETCD_MAINTENANCE_SPECS,
      tablesAreDerivedGroupings: true,
      statementTerminator: "none",
      defaultPort: ETCD_DEFAULT_PORT,
      containerLevels: [],
      objectKinds: ETCD_OBJECT_KINDS,
      keyScan: ETCD_KEY_SCAN,
      enforcesReadOnly: true,
      schemaRefreshPattern: ETCD_SCHEMA_REFRESH_PATTERN,
    };
    expect(provider.getCapabilities()).toEqual(declared);
    expect(ETCD_DEFAULT_PORT).toBe(2379);
    expect(provider.getCapabilities().maintenanceOperations).toEqual(["compact", "defragment", "disarm"]);
  });

  test("the labels are ETCD_LABELS, a copy on every call", () => {
    const { provider } = build(CONNECTION, etcdClient());
    expect(provider.getLabels()).toEqual(ETCD_LABELS);
    expect(provider.getLabels()).not.toBe(provider.getLabels());
  });

  test("prepareQuery pins the command: no limit is added and no page two exists (spec 5.4)", () => {
    // Typed as the routes hold it, whose options this provider takes none of (the Prometheus shape).
    const provider: DatabaseProvider = build(CONNECTION, etcdClient()).provider;
    expect(provider.prepareQuery("get /app/ --prefix", { limit: 50, offset: 50 })).toEqual({
      query: "get /app/ --prefix",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
  });

  test("no presence-detected method that would do nothing (spec 5.5, 7.1, E12)", () => {
    const { provider } = build(CONNECTION, etcdClient());
    for (const method of [
      "getPoolStats",
      "queryReadOnly",
      "endOpenQueryTransaction",
      "beginTransaction",
      "commitTransaction",
      "rollbackTransaction",
    ]) {
      expect({ method, present: method in provider }).toEqual({ method, present: false });
    }
    // The controls: the methods this provider does implement are found the same way.
    for (const method of ["cancelQuery", "scanKeysPage", "readObjectSource", "buildObjectEdit", "applyObjectEdit"]) {
      expect({ method, present: method in provider }).toEqual({ method, present: true });
    }
  });

  test("every surface refuses before connect, naming the missing connect", async () => {
    const client = etcdClient();
    const { provider } = build(CONNECTION, client);
    const refusal = new DatabaseConfigError("Provider is not connected. Call connect() first.", "etcd");
    const surfaces: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["query", () => provider.query("get /a")],
      ["listContainers", () => provider.listContainers()],
      ["countObjects", () => provider.countObjects([])],
      ["listObjects", () => provider.listObjects([], "prefix")],
      ["describeObject", () => provider.describeObject(["/app/a/*"], "prefix")],
      ["describeObjects of the groups", () => provider.describeObjects([], "prefix")],
      ["describeObjects of a kind with no columns", () => provider.describeObjects([], "member")],
      ["readObjectSource", () => provider.readObjectSource(["/app/cfg"], "key")],
      ["scanKeysPage", () => provider.scanKeysPage({ cursor: "0", count: 10 })],
      [
        "buildObjectEdit",
        () => provider.buildObjectEdit({ path: ["/app/cfg"], kind: "key", partId: "value", text: "x" }),
      ],
      // Refused before the plan is read, so any plan stands in.
      ["applyObjectEdit", () => provider.applyObjectEdit({} as ObjectEditPlan)],
      ["getHealth", () => provider.getHealth()],
      ["getOverview", () => provider.getOverview()],
      ["getStorageStats", () => provider.getStorageStats()],
      ["getTableStats", () => provider.getTableStats()],
      ["getPerformanceMetrics", () => provider.getPerformanceMetrics()],
      ["getSlowQueries", () => provider.getSlowQueries()],
      ["getActiveSessions", () => provider.getActiveSessions()],
      ["getIndexStats", () => provider.getIndexStats()],
      ["runMaintenance", () => provider.runMaintenance("compact")],
    ];
    const answers = await Promise.all(
      surfaces.map(async ([name, surface]) => ({
        name,
        refusal: await surface().then(
          () => "answered",
          (error: unknown) => (error instanceof DatabaseConfigError ? error.message : String(error)),
        ),
      })),
    );
    expect(answers).toEqual(surfaces.map(([name]) => ({ name, refusal: refusal.message })));
    expect(client.calls).toEqual([]);
  });
});

// ============================================================================
// The connect sequence (spec 6.1) and the grants (spec 4.7)
// ============================================================================

describe("the connect sequence (spec 6.1)", () => {
  test("no credential on an etcd whose authentication is off: AuthStatus, then Status", async () => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    expect(methods(client)).toEqual(["authStatus", "status"]);
    expect(provider.isConnected()).toBe(true);
  });

  test("a password signs in first, then Status, AuthStatus and the reader's grants", async () => {
    const client = readerClient();
    await connected(PASSWORD_CONNECTION, client);
    expect(callsOf(client)).toEqual([
      { method: "authenticate", args: [] },
      { method: "status", args: [] },
      { method: "authStatus", args: [] },
      { method: "userGet", args: ["reader"] },
      { method: "roleGet", args: ["reader"] },
    ]);
  });

  test("a root user's grants are every key, and no role is read", async () => {
    // A key space that checks no grant, as etcd checks none for root: the walk covers every key.
    const client = readerClient({ userGet: async () => ["root", "reader"], range: keySpaceRange(KEYS) });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect(methods(client)).toEqual(["authenticate", "status", "authStatus", "userGet"]);
    const groups = (await provider.listObjects([], "prefix")).map((group) => group.name).sort();
    expect(groups).toEqual(
      prefixGroups(KEYS.map((entry) => encode(entry.key)))
        .groups.map(groupLabel)
        .sort(),
    );
    // A user can lose the root role, so the walk reads the auth store's revision first, and then keys alone (spec 4.7).
    const [check, ...walk] = methods(client, 4);
    expect(check).toBe("authStatus");
    expect(walk.every((method) => method === "range")).toBe(true);
  });

  test("each role's permissions are read, in the order UserGet names the roles, and the grants are their union", async () => {
    // Two roles with disjoint grants: the prefix /app/ and the one key /config/a (spec 4.7).
    const byRole = new Map<string, readonly EtcdPermission[]>([
      ["reader", [{ type: "read", key: encode("/app/"), rangeEnd: encode("/app0") }]],
      ["auditor", [{ type: "read", key: encode("/config/a") }]],
    ]);
    const client = readerClient({
      userGet: async () => ["reader", "auditor"],
      roleGet: async (role) => {
        const permissions = byRole.get(role);
        if (permissions === undefined) throw new Error(`the test gives no role ${role}`);
        return permissions;
      },
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect(callsOf(client).filter((call) => call.method === "roleGet")).toEqual([
      { method: "roleGet", args: ["reader"] },
      { method: "roleGet", args: ["auditor"] },
    ]);
    const both = prefixGroups(["/app/a/b", "/app/cfg", "/app/x/y", "/config/a"].map(encode))
      .groups.map(groupLabel)
      .sort();
    expect((await provider.countObjects([])).prefix).toEqual({
      count: both.length,
      sampledFrom: "the 2 ranges etcd user reader may read",
    });
    expect((await provider.listObjects([], "prefix")).map((group) => group.name).sort()).toEqual(both);
  });

  test("a password on an etcd whose AuthStatus then answers off reads no grant", async () => {
    const client = readerClient({ authStatus: async () => ({ enabled: false, authRevision: "1" }) });
    await connected(PASSWORD_CONNECTION, client);
    expect(methods(client)).toEqual(["authenticate", "status", "authStatus"]);
  });

  test("step 1: a password on an etcd whose authentication is off is refused, and the channel is closed", async () => {
    const client = readerClient({
      authenticate: async () => {
        throw notEnabled();
      },
    });
    const { provider } = build(PASSWORD_CONNECTION, client);
    const failure = await provider.connect().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect(failure?.message).toBe(
      "Authentication is not enabled on this etcd, so the User and Password would not be used. Clear them to connect. (etcd: authentication is not enabled)",
    );
    expect(failure?.message).not.toContain(PASSWORD);
    expect(methods(client)).toEqual(["authenticate", "close"]);
    expect(provider.isConnected()).toBe(false);
  });

  test("step 1: a wrong password is etcd's refusal of the sign-in", async () => {
    const client = readerClient({
      authenticate: async () => {
        throw new EtcdError("auth-failed", "etcdserver: authentication failed, invalid user ID or password", 3);
      },
    });
    const { provider } = build(PASSWORD_CONNECTION, client);
    await expect(provider.connect()).rejects.toThrow(
      new AuthenticationError(
        "etcd refused the sign-in: the user is unknown or the password is wrong. (etcd: authentication failed, invalid user ID or password)",
        "etcd",
      ),
    );
    expect(methods(client)).toEqual(["authenticate", "close"]);
  });

  test("step 1: a sign-in etcd does not answer is named as the sign-in", async () => {
    const client = readerClient({
      authenticate: async () => {
        throw unavailable();
      },
    });
    const { provider } = build(PASSWORD_CONNECTION, client);
    const failure = await provider.connect().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure?.message).toBe("etcd did not answer the sign-in. (etcd: request timed out)");
    expect(methods(client)).toEqual(["authenticate", "close"]);
  });

  test("step 1: a defect's own error surfaces as itself", async () => {
    const defect = new TypeError("a defect in the adapter");
    const client = readerClient({
      authenticate: async () => {
        throw defect;
      },
    });
    const { provider } = build(PASSWORD_CONNECTION, client);
    await expect(provider.connect()).rejects.toBe(defect);
    // A rejection that carries nothing is a defect too, never a step's refusal handed no answer.
    const empty = build(PASSWORD_CONNECTION, readerClient({ authenticate: () => Promise.reject(undefined) }));
    await expect(empty.provider.connect()).rejects.toThrow(
      new Error("The etcd provider received a thrown value that is not an Error: undefined"),
    );
  });

  test("step 3: authentication on and no credential is refused before any other call", async () => {
    const client = etcdClient({ authStatus: async () => ({ enabled: true, authRevision: "5" }) });
    const { provider } = build(CONNECTION, client);
    await expect(provider.connect()).rejects.toThrow(
      new AuthenticationError(
        "This etcd has authentication enabled. Enter a User and Password, or add a client certificate under SSL / TLS whose Common Name is an etcd user.",
        "etcd",
      ),
    );
    expect(methods(client)).toEqual(["authStatus", "close"]);
  });

  test("step 2: below 3.7, 'user name is empty' means authentication is on", async () => {
    const client = etcdClient({
      authStatus: async () => {
        throw nameEmpty();
      },
    });
    const { provider } = build(CONNECTION, client);
    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(methods(client)).toEqual(["authStatus", "close"]);
  });

  test("step 2: any other AuthStatus failure is the error table's, a lost quorum refused at once", async () => {
    const client = etcdClient({
      authStatus: async () => {
        throw new EtcdError("no-leader", "etcdserver: no leader", 14);
      },
    });
    const { provider } = build(CONNECTION, client);
    const failure = await provider.connect().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure?.message).toContain("the cluster has lost quorum, so nothing was applied");
    expect(methods(client)).toEqual(["authStatus", "close"]);
  });

  test("step 4: a client certificate on an etcd with authentication on reads its Common Name's user, then its grants", async () => {
    const client = readerClient({ userGet: async () => ["reader"] });
    await connected(CERTIFICATE_CONNECTION, client);
    expect(callsOf(client)).toEqual([
      { method: "authStatus", args: [] },
      { method: "userGet", args: ["cert-only"] },
      { method: "status", args: [] },
      { method: "roleGet", args: ["reader"] },
    ]);
  });

  test("step 2's auth revision is the one the grants are read under, so a certificate user's first walk reads AuthStatus and no grant (spec 4.7)", async () => {
    const client = readerClient();
    const { provider } = await connected(CERTIFICATE_CONNECTION, client);
    const mark = client.calls.length;
    expect((await provider.listObjects([], "prefix")).length).toBeGreaterThan(0);
    expect(methods(client, mark).filter((method) => method !== "range")).toEqual(["authStatus"]);
  });

  /**
   * etcd below 3.7 as measured on 3.6.0 and 3.6.6 with --client-cert-auth: AuthStatus and Status answer the root
   * role alone, whatever the credential, a caller etcd reads no user for meets "user name is empty", and UserGet
   * answers a user about itself. `seen` is the user etcd reads from the credential, or undefined for none.
   */
  function etcd36(seen: { readonly user: string; readonly root: boolean } | undefined): FakeEtcdClient {
    const asRoot = <T>(answer: T): Promise<T> => {
      if (seen === undefined) return Promise.reject(nameEmpty());
      return seen.root ? Promise.resolve(answer) : Promise.reject(denied());
    };
    return readerClient({
      authStatus: () => asRoot({ enabled: true, authRevision: "8" }),
      status: () => asRoot(STATUS),
      userGet: async (name) => {
        if (seen === undefined) throw nameEmpty();
        if (name !== seen.user) throw denied();
        return seen.root ? ["root"] : ["reader"];
      },
      // etcd checks no grant for root.
      ...(seen?.root === true ? { range: keySpaceRange(KEYS) } : {}),
    });
  }

  const ROOT_SEEN = (user: string) => ({ user, root: true });
  const READER_SEEN = (user: string) => ({ user, root: false });
  test.each([
    [
      "a client certificate of root connects",
      "certificate",
      ROOT_SEEN("cert-only"),
      ["authStatus", "userGet", "status"],
      undefined,
    ],
    [
      "a password of root connects",
      "password",
      ROOT_SEEN("reader"),
      ["authenticate", "status", "authStatus", "userGet"],
      undefined,
    ],
    [
      "a client certificate of a user who is not root is refused at the auth status",
      "certificate",
      READER_SEEN("cert-only"),
      ["authStatus", "close"],
      "QueryError: etcd refused the auth status: this connection's etcd user is not granted all of it. (etcd: permission denied)",
    ],
    [
      "a password of a user who is not root is refused at the endpoint status",
      "password",
      READER_SEEN("reader"),
      ["authenticate", "status", "close"],
      "QueryError: etcd refused the endpoint status: this connection's etcd user is not granted all of it. (etcd: permission denied)",
    ],
    [
      "a client certificate etcd does not read is refused at the user get",
      "certificate",
      undefined,
      ["authStatus", "userGet", "close"],
      "AuthenticationError: etcd did not read the client certificate: the server must run with --client-cert-auth. (etcd: user name is empty)",
    ],
  ] as const)(
    "below 3.7, where AuthStatus and Status answer root alone, no session connects without an auth revision: %s (spec 4.7, 6.1)",
    async (_label, mode, seen, calls, owed) => {
      const client = etcd36(seen);
      const { provider } = build(mode === "certificate" ? CERTIFICATE_CONNECTION : PASSWORD_CONNECTION, client);
      const refused = await provider.connect().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)),
      );
      expect({ refused, calls: methods(client) }).toEqual({ refused: owed, calls: [...calls] });
      if (refused !== undefined) return;
      // A session that connected holds AuthStatus's revision, so its walk reads AuthStatus first (spec 4.7).
      const mark = client.calls.length;
      await provider.listObjects([], "prefix");
      expect(methods(client, mark)[0]).toBe("authStatus");
    },
  );

  test("step 4: a Common Name that holds root reads no role", async () => {
    const client = readerClient({ userGet: async () => ["root"] });
    await connected(CERTIFICATE_CONNECTION, client);
    expect(methods(client)).toEqual(["authStatus", "userGet", "status"]);
  });

  test("a client certificate on an etcd whose authentication is off reads no user", async () => {
    const client = etcdClient();
    await connected(CERTIFICATE_CONNECTION, client);
    expect(methods(client)).toEqual(["authStatus", "status"]);
  });

  test("step 4: a Common Name etcd does not know is named", async () => {
    const client = readerClient({
      userGet: async () => {
        throw userNotFound();
      },
    });
    const { provider } = build(CERTIFICATE_CONNECTION, client);
    await expect(provider.connect()).rejects.toThrow(
      new AuthenticationError(
        'The client certificate\'s Common Name "cert-only" is not an etcd user. (etcd: user name not found)',
        "etcd",
      ),
    );
    expect(methods(client)).toEqual(["authStatus", "userGet", "close"]);
  });

  test("step 4: an etcd that did not read the certificate is told to run with --client-cert-auth", async () => {
    const client = readerClient({
      userGet: async () => {
        throw nameEmpty();
      },
    });
    const { provider } = build(CERTIFICATE_CONNECTION, client);
    await expect(provider.connect()).rejects.toThrow(
      new AuthenticationError(
        "etcd did not read the client certificate: the server must run with --client-cert-auth. (etcd: user name is empty)",
        "etcd",
      ),
    );
  });

  test("step 4: a UserGet etcd does not answer is named as the user get", async () => {
    const client = readerClient({
      userGet: async () => {
        throw unavailable();
      },
    });
    const { provider } = build(CERTIFICATE_CONNECTION, client);
    const failure = await provider.connect().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure?.message).toBe("etcd did not answer the user get. (etcd: request timed out)");
    expect(methods(client)).toEqual(["authStatus", "userGet", "close"]);
  });

  test("a client certificate that names no Common Name is step 3's refusal, never a UserGet of no name", async () => {
    const client = readerClient();
    const { provider } = build(NAMELESS_CERTIFICATE_CONNECTION, client);
    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(methods(client)).toEqual(["authStatus", "close"]);
  });

  test("step 5: a Status failure is the error table's, after the sign-in", async () => {
    const client = etcdClient({
      status: async () => {
        throw unavailable();
      },
    });
    const { provider } = build(CONNECTION, client);
    await expect(provider.connect()).rejects.toThrow(
      new ConnectionError(
        "etcd did not answer the endpoint status. (etcd: request timed out)",
        "etcd",
        "etcd.test",
        2379,
      ),
    );
    expect(methods(client)).toEqual(["authStatus", "status", "close"]);
  });

  test("step 5: a member whose Status names no leader refuses the connection at once (spec 4.7)", async () => {
    const client = etcdClient({ status: async () => ({ ...STATUS, leader: "0" }) });
    const { provider } = build(CONNECTION, client);
    const failure = await provider.connect().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure?.message).toBe(
      "The etcd member this connection reaches has no leader: the cluster has lost quorum, so nothing was applied. Bring the stopped members back, then run the command again. (the answering member's Status names no leader)",
    );
    expect(methods(client)).toEqual(["authStatus", "status", "close"]);
  });

  test("password mode: step 5's AuthStatus failure is the error table's", async () => {
    const client = readerClient({
      authStatus: async () => {
        throw unavailable();
      },
    });
    const { provider } = build(PASSWORD_CONNECTION, client);
    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(methods(client)).toEqual(["authenticate", "status", "authStatus", "close"]);
  });

  test("a grants read that fails is raised, and the channel is closed", async () => {
    const client = readerClient({
      userGet: async () => {
        throw unavailable();
      },
    });
    const { provider } = build(PASSWORD_CONNECTION, client);
    await expect(provider.connect()).rejects.toThrow(
      "etcd did not answer the read of etcd user reader's grants. (etcd: request timed out)",
    );
    expect(methods(client)).toEqual(["authenticate", "status", "authStatus", "userGet", "close"]);
  });

  test("a grants read etcd refuses connects, and every surface that reads keys says so (spec 4.7)", async () => {
    const client = readerClient({
      roleGet: async () => {
        throw denied();
      },
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    const refusal =
      "etcd refused the read of etcd user reader's grants: this connection's etcd user is not granted all of it. (etcd: permission denied)";
    const counted = client.calls.length;
    expect((await provider.countObjects([])).prefix).toEqual({ unavailable: refusal });
    // The count walks no range: with its grants unread, the reader is sent over none (spec 4.7).
    expect(methods(client, counted)).not.toContain("range");
    await expect(provider.listObjects([], "prefix")).rejects.toThrow(refusal);
    await expect(provider.readObjectSource(["/app/cfg"], "key")).rejects.toThrow(refusal);
    await expect(provider.scanKeysPage({ cursor: "0", count: 10 })).rejects.toThrow(refusal);
    await expect(
      provider.buildObjectEdit({ path: ["/app/cfg"], kind: "key", partId: "value", text: '{"mode":"green"}' }),
    ).rejects.toThrow(refusal);
    await expect(provider.getOverview()).rejects.toThrow(refusal);
    await expect(provider.getTableStats()).rejects.toThrow(refusal);
    await expect(provider.describeObjects([], "prefix")).rejects.toThrow(refusal);
    // A surface that reads no key still answers.
    expect((await provider.listObjects([], "member")).length).toBe(1);
    expect(await provider.getHealth()).toBeDefined();
  });

  test("the factory's own failure is the error table's, and nothing was opened to close", async () => {
    const provider = new EtcdProvider(CONNECTION, { queryTimeout: QUERY_TIMEOUT }, {}, async () => {
      throw new EtcdError("closed", "the channel could not be built");
    });
    await expect(provider.connect()).rejects.toThrow(
      new ConnectionError(
        "This connection to etcd is closed: connect again. (the channel could not be built)",
        "etcd",
        "etcd.test",
        2379,
      ),
    );
    const thrownValue = new EtcdProvider(CONNECTION, { queryTimeout: QUERY_TIMEOUT }, {}, async () => {
      throw "boom";
    });
    await expect(thrownValue.connect()).rejects.toThrow(
      "The etcd provider received a thrown value that is not an Error: boom",
    );
  });

  test("a close that fails after a failed connect is logged, never thrown over the failure", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = etcdClient({
        status: async () => {
          throw unavailable();
        },
        close: async () => {
          throw new Error("the socket was already gone");
        },
      });
      const { provider } = build(CONNECTION, client);
      await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
      expect(logged).toHaveBeenCalledWith("[DB:etcd] connect cleanup failed: the socket was already gone");
    } finally {
      logged.mockRestore();
    }
  });

  test("one connect builds one client with the hooks, and disconnect closes it once (E16)", async () => {
    const client = etcdClient();
    const { provider, factoryCalls, hooks } = await connected(CONNECTION, client);
    expect(factoryCalls()).toBe(1);
    expect(hooks).toHaveLength(1);
    expect(typeof hooks[0].onAuthStoreChanged).toBe("function");
    await provider.disconnect();
    expect(methods(client).filter((method) => method === "close")).toHaveLength(1);
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect();
    expect(methods(client).filter((method) => method === "close")).toHaveLength(1);
    await provider.connect();
    expect(factoryCalls()).toBe(2);
  });
});

describe("the grants after an auth-store change (spec 4.7, R13 D10)", () => {
  /** The groups spec 4.1's rule makes of the keys a reader may read: the walk's oracle, in sorted order. */
  const visibleGroups = (keys: readonly string[]) => prefixGroups(keys.map(encode)).groups.map(groupLabel).sort();
  const listed = async (provider: EtcdProvider) =>
    (await provider.listObjects([], "prefix")).map((group) => group.name).sort();

  test("under etcd's default simple tokens, where no call after an auth change meets the stale revision, a walk reads the grants again once the auth store's revision moved", async () => {
    let permissions: readonly EtcdPermission[] = READER_PERMISSIONS;
    let authRevision = "5";
    const client = readerClient({
      authStatus: async () => ({ enabled: true, authRevision }),
      roleGet: async () => permissions,
      // etcd checks every call against the grants as they stand, whatever the provider read.
      range: (request, options) => keySpaceRange(KEYS, permissions)(request, options),
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect(await listed(provider)).toEqual(visibleGroups(["/app/a/b", "/app/cfg", "/app/x/y", "/config/a"]));

    // An admin took the prefix away and granted another key: the auth store moved on, and the adapter said nothing.
    permissions = [
      { type: "read", key: encode("/config/a") },
      { type: "read", key: encode("/config/b") },
    ];
    authRevision = "7";
    const before = client.calls.length;
    expect(await listed(provider)).toEqual(visibleGroups(["/config/a", "/config/b"]));
    expect(methods(client, before).slice(0, 3)).toEqual(["authStatus", "userGet", "roleGet"]);
    expect((await provider.countObjects([])).prefix).toEqual({
      count: 1,
      sampledFrom: "the 2 ranges etcd user reader may read",
    });
    // The revision the grants were read under is kept, so a walk after it reads AuthStatus and no grant.
    const again = client.calls.length;
    expect(await listed(provider)).toEqual(visibleGroups(["/config/a", "/config/b"]));
    expect(methods(client, again).filter((method) => method !== "range")).toEqual(["authStatus"]);
  });

  test("once an admin turns authentication off, the next walk reads every key, as a connect with it off does, and no grant; turned on again, the grants are read again (spec 4.7)", async () => {
    let enabled = true;
    let authRevision = "5";
    // A group outside the reader's grants, so the key space it walks with authentication off is wider.
    const keys: readonly KeySpaceEntry[] = [...KEYS, { key: "/secret/x/y", value: "hidden" }];
    // With authentication off etcd checks no grant and admits every caller to root's listings (IsAdminPermitted).
    const whileOn = <T>(answer: T) => (enabled ? Promise.reject(denied()) : Promise.resolve(answer));
    const client = readerClient({
      authStatus: async () => ({ enabled, authRevision }),
      range: (request, options) => keySpaceRange(keys, enabled ? READER_PERMISSIONS : undefined)(request, options),
      userList: () => whileOn(["reader", "root"]),
      roleList: () => whileOn(["reader", "root"]),
      leaseLeases: () => whileOn({ header: KEY_SPACE_HEADER, ids: [] }),
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    const everyGroup = visibleGroups(keys.map((entry) => entry.key)).length;

    // auth disable: etcd commits a new auth revision (AuthDisable's commitRevision) and serves every key.
    enabled = false;
    authRevision = "6";
    const disabled = client.calls.length;
    expect((await provider.countObjects([])).prefix).toEqual({ count: everyGroup });
    expect(methods(client, disabled)[0]).toBe("authStatus");
    expect(methods(client, disabled)).toEqual(expect.not.arrayContaining(["userGet", "roleGet"]));
    // Every key is writable as well, so the reader's grant of READ alone on /config/a no longer refuses its edit.
    const built = await provider.buildObjectEdit({ ...REQUEST, path: ["/config/a"], text: "omega" });
    expect(built.built).toBe(true);
    const kept = client.calls.length;
    expect(await listed(provider)).toEqual(visibleGroups(keys.map((entry) => entry.key)));
    expect(methods(client, kept).filter((method) => method !== "range")).toEqual(["authStatus"]);

    // auth enable commits no revision, so only AuthStatus's enabled tells the walk to read the grants again.
    enabled = true;
    const reenabled = client.calls.length;
    expect((await provider.countObjects([])).prefix).toEqual({
      count: visibleGroups(["/app/a/b", "/app/cfg", "/app/x/y", "/config/a"]).length,
      sampledFrom: "the 2 ranges etcd user reader may read",
    });
    expect(methods(client, reenabled).slice(0, 3)).toEqual(["authStatus", "userGet", "roleGet"]);
  });

  test("a session that connected with authentication off reads nothing before its walks, so once an admin turns authentication on, etcd's own refusal answers them (spec 4.7)", async () => {
    let enabled = false;
    const client = etcdClient({
      authStatus: async () => ({ enabled, authRevision: "2" }),
      range: (request, options) => keySpaceRange(KEYS, enabled ? READER_PERMISSIONS : undefined)(request, options),
    });
    const { provider } = await connected(CERTIFICATE_CONNECTION, client);
    enabled = true;
    const mark = client.calls.length;
    await expect(provider.listObjects([], "prefix")).rejects.toThrow(
      new QueryError(
        "etcd refused the Key Prefixes listing: this connection's etcd user is not granted all of it. (etcd: permission denied)",
        "etcd",
      ),
    );
    expect(methods(client, mark)).toEqual(["range"]);
  });

  test("a renewal that met the stale auth revision narrows the next walk to the grants read again", async () => {
    let permissions: readonly EtcdPermission[] = READER_PERMISSIONS;
    const client = readerClient({ roleGet: async () => permissions, range: keySpaceRange(KEYS, READER_PERMISSIONS) });
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    expect(await listed(provider)).toEqual(visibleGroups(["/app/a/b", "/app/cfg", "/app/x/y", "/config/a"]));

    // An admin took the prefix away; the adapter's renewal met "revision of auth store is old" and said so.
    permissions = [{ type: "read", key: encode("/config/a") }];
    hooks[0].onAuthStoreChanged?.();
    const before = client.calls.length;
    expect(await listed(provider)).toEqual(visibleGroups(["/config/a"]));
    expect(methods(client, before).slice(0, 3)).toEqual(["authStatus", "userGet", "roleGet"]);
    for (const call of callsOf(client, before + 3)) {
      expect(call.method).toBe("range");
      expect(Buffer.from((call.args[0] as { key: Uint8Array }).key).toString()).toStartWith("/config/a");
    }
    // The grants read again are the ones kept: the walk after it reads the revision and no grant again.
    const again = client.calls.length;
    expect(await listed(provider)).toEqual(visibleGroups(["/config/a"]));
    expect(methods(client, again).filter((method) => method !== "range")).toEqual(["authStatus"]);
  });

  test("without the hook, no grant is read again", async () => {
    const client = readerClient();
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    await provider.countObjects([]);
    await provider.listObjects([], "prefix");
    expect(methods(client).filter((method) => method === "userGet")).toHaveLength(1);
  });

  test("a walk raises an AuthStatus it meets refused, 'user name is empty' among them, as the read of the grants (spec 4.7)", async () => {
    let refuse = false;
    const client = readerClient({
      authStatus: async () => {
        if (refuse) throw nameEmpty();
        return { enabled: true, authRevision: "5" };
      },
    });
    const { provider } = await connected(CERTIFICATE_CONNECTION, client);
    refuse = true;
    const mark = client.calls.length;
    await expect(provider.listObjects([], "prefix")).rejects.toThrow(
      new AuthenticationError(
        "etcd did not accept this connection's sign-in for the read of etcd user cert-only's grants: connect again. (etcd: user name is empty)",
        "etcd",
      ),
    );
    expect(methods(client, mark)).toEqual(["authStatus"]);
  });

  test("surfaces that start together share one read of the grants, and each walks the grants it read", async () => {
    let permissions: readonly EtcdPermission[] = READER_PERMISSIONS;
    const client = readerClient({ roleGet: async () => permissions, range: keySpaceRange(KEYS, READER_PERMISSIONS) });
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    permissions = [{ type: "read", key: encode("/config/a") }];
    hooks[0].onAuthStoreChanged?.();
    const [counts, groups, overview] = await Promise.all([
      provider.countObjects([]),
      listed(provider),
      provider.getOverview(),
    ]);
    expect(methods(client).filter((method) => method === "authStatus")).toHaveLength(2);
    expect(methods(client).filter((method) => method === "userGet")).toHaveLength(2);
    expect(methods(client).filter((method) => method === "roleGet")).toHaveLength(2);
    // None of them walks the grants the change replaced while the new ones are being read.
    expect(counts.prefix).toEqual({ count: 1, sampledFrom: "the 1 range etcd user reader may read" });
    expect(groups).toEqual(visibleGroups(["/config/a"]));
    expect(overview).toMatchObject({
      tableCount: 1,
      tableCountSampledFrom: "the ranges etcd user reader may read: /config/a",
    });
  });

  test("a read of the grants etcd refuses is kept, for the surfaces that read keys to name", async () => {
    let refuse = false;
    const client = readerClient({
      roleGet: async () => {
        if (refuse) throw denied();
        return READER_PERMISSIONS;
      },
    });
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    refuse = true;
    hooks[0].onAuthStoreChanged?.();
    const counts = await provider.countObjects([]);
    expect(counts.prefix).toEqual({
      unavailable:
        "etcd refused the read of etcd user reader's grants: this connection's etcd user is not granted all of it. (etcd: permission denied)",
    });
    expect(counts.member).toEqual({ count: 1 });
  });

  test("a read of the grants that fails is raised by a walk, carried by the prefix folder in the count, and read again by the next walk", async () => {
    let fail = false;
    const client = readerClient({
      userGet: async () => {
        if (fail) throw unavailable();
        return ["reader"];
      },
    });
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    fail = true;
    hooks[0].onAuthStoreChanged?.();
    await expect(provider.listObjects([], "prefix")).rejects.toBeInstanceOf(ConnectionError);
    const counts = await provider.countObjects([]);
    expect(counts.prefix).toEqual({
      unavailable: "etcd did not answer the read of etcd user reader's grants. (etcd: request timed out)",
    });
    expect(counts.member).toEqual({ count: 1 });
    fail = false;
    expect((await provider.countObjects([])).prefix).toEqual({
      count: visibleGroups(["/app/a/b", "/app/cfg", "/app/x/y", "/config/a"]).length,
      sampledFrom: "the 2 ranges etcd user reader may read",
    });
    expect(methods(client).filter((method) => method === "userGet")).toHaveLength(4);
  });

  test("a typed command started while a walk reads the auth store's revision waits for nothing it does not need", async () => {
    let release: () => void = () => undefined;
    let held = false;
    const client = readerClient({
      authStatus: () => {
        if (!held) return Promise.resolve({ enabled: true, authRevision: "5" });
        return new Promise((resolve) => {
          release = () => resolve({ enabled: true, authRevision: "5" });
        });
      },
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    held = true;
    const walk = provider.listObjects([], "prefix");
    const command = provider.query("get /app/cfg").then((result) => result.rowCount);
    expect(await Promise.race([command, Bun.sleep(200).then(() => "waited for the walk's read")])).toBe(1);
    release();
    expect((await walk).length).toBeGreaterThan(0);
  });

  test("after an auth-store change, a typed command is sent before any read of the grants, so a serializable get still answers during a lost quorum (spec 4.7, 6.1)", async () => {
    let quorum = true;
    const noLeader = () => new EtcdError("no-leader", "etcdserver: no leader", 14);
    const whileQuorum = <T>(answer: T) => (quorum ? Promise.resolve(answer) : Promise.reject(noLeader()));
    const client = readerClient({
      authStatus: () => whileQuorum({ enabled: true, authRevision: "5" }),
      userGet: () => whileQuorum(["reader"]),
      roleGet: () => whileQuorum(READER_PERMISSIONS),
      // A serializable Range carries no hasleader, so a member without a leader still answers it (spec 6.1).
      range: (request, options) =>
        quorum || request.serializable === true
          ? keySpaceRange(KEYS, READER_PERMISSIONS)(request, options)
          : Promise.reject(noLeader()),
    });
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    hooks[0].onAuthStoreChanged?.();
    quorum = false;
    const mark = client.calls.length;
    expect((await provider.query("get /app/cfg --consistency=s")).rowCount).toBe(1);
    expect((await provider.query("get /app/cfg --consistency=s")).rowCount).toBe(1);
    expect(methods(client, mark)).toEqual(["range", "range"]);
  });

  test("after an auth-store change, a refusal etcd gives a typed command or a surface that walks no key names what the user may read as the grants were last read, until the next walk reads them again (spec 4.7, 5.6)", async () => {
    let permissions: readonly EtcdPermission[] = READER_PERMISSIONS;
    const client = readerClient({
      roleGet: async () => permissions,
      alarmList: async () => {
        throw denied();
      },
    });
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    const narrowed: readonly EtcdPermission[] = [{ type: "read", key: encode("/config/a") }];
    permissions = narrowed;
    hooks[0].onAuthStoreChanged?.();
    const refusals = async () => {
      const command = await provider.query("get /secret/x").then(
        () => "answered",
        (error: unknown) => (error instanceof QueryError ? error.message : String(error)),
      );
      const health = await provider.getHealth().then(
        () => "answered",
        (error: unknown) => (error instanceof QueryError ? error.message : String(error)),
      );
      return [command, health];
    };
    const mayRead = (granted: readonly EtcdPermission[]) =>
      expect.stringContaining(`etcd user reader may read: ${describeScope(readableScope(granted))}.`);
    const mark = client.calls.length;
    expect(await refusals()).toEqual([mayRead(READER_PERMISSIONS), mayRead(READER_PERMISSIONS)]);
    expect(methods(client, mark)).not.toContain("userGet");
    await provider.listObjects([], "prefix");
    expect(await refusals()).toEqual([mayRead(narrowed), mayRead(narrowed)]);
  });

  test("a defect met reading the grants is raised by the count, never kept as the prefix folder's sentence", async () => {
    let defect = false;
    const client = readerClient({
      authStatus: async () => {
        if (defect) throw new TypeError("the adapter could not read its own answer");
        return { enabled: true, authRevision: "5" };
      },
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    defect = true;
    await expect(provider.countObjects([])).rejects.toThrow(new TypeError("the adapter could not read its own answer"));
  });

  test("during a lost quorum the count of a user who is not root still lists the members, and the prefix folder carries the lost quorum (spec 4.3)", async () => {
    let quorum = true;
    const noLeader = () => new EtcdError("no-leader", "etcdserver: no leader", 14);
    const client = readerClient({
      authStatus: async () => {
        if (!quorum) throw noLeader();
        return { enabled: true, authRevision: "5" };
      },
      range: (request, options) =>
        quorum ? keySpaceRange(KEYS, READER_PERMISSIONS)(request, options) : Promise.reject(noLeader()),
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    quorum = false;
    const counts = await provider.countObjects([]);
    expect(counts.member).toEqual({ count: 1 });
    expect(counts.prefix).toEqual({ unavailable: expect.stringContaining("the cluster has lost quorum") });
  });

  test("an apply reads no grant before its one Txn, so a read of them that fails cannot turn an edit never sent into one whose outcome is unknown (spec 4.5, E6)", async () => {
    const writer: readonly EtcdPermission[] = [{ type: "readwrite", key: encode("/app/"), rangeEnd: encode("/app0") }];
    let grantsAnswer = true;
    const overrides: Partial<EtcdClient> = {
      roleGet: async () => writer,
      range: keySpaceRange(KEYS, writer),
      userGet: async () => {
        if (grantsAnswer) return ["reader"];
        throw unavailable();
      },
      txn: async () => ({
        header: KEY_SPACE_HEADER,
        succeeded: true,
        responses: [{ op: "put" as const, response: { header: KEY_SPACE_HEADER } }],
      }),
    };
    const client = readerClient(overrides);
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    const built = await provider.buildObjectEdit(REQUEST);
    if (!built.built) throw new Error(`the build refused the edit: ${JSON.stringify(built.refusal)}`);
    const readOnlyClient = readerClient(overrides);
    const readOnly = await connected({ ...PASSWORD_CONNECTION, readOnly: true }, readOnlyClient);
    // An admin changed the auth store, a renewal met the stale revision, and the grants cannot be read now.
    hooks[0].onAuthStoreChanged?.();
    readOnly.hooks[0].onAuthStoreChanged?.();
    grantsAnswer = false;
    const mark = client.calls.length;
    expect((await provider.applyObjectEdit(built.plan)).outcome).toBe("applied");
    expect(methods(client, mark)).toEqual(["txn"]);
    const readOnlyMark = readOnlyClient.calls.length;
    const refused = await readOnly.provider.applyObjectEdit(built.plan);
    expect({ ...refused, duration: 0 }).toEqual({
      outcome: "refused",
      refusal: { refusal: "privilege", sentence: readOnlySentence("connection"), at: { within: "none" } },
      duration: 0,
    });
    expect(readOnlyClient.calls.length).toBe(readOnlyMark);
    // The change is still read before the next walk.
    grantsAnswer = true;
    const walked = client.calls.length;
    await provider.listObjects([], "prefix");
    expect(methods(client, walked).slice(0, 3)).toEqual(["authStatus", "userGet", "roleGet"]);
  });

  test("on an etcd whose authentication is off the hook has no grant to read", async () => {
    const client = etcdClient();
    const { provider, hooks } = await connected(CONNECTION, client);
    hooks[0].onAuthStoreChanged?.();
    await provider.countObjects([]);
    expect(methods(client)).not.toContain("userGet");
  });

  /** The reader's client, whose read of the grants etcd stops answering once `answers` says so. */
  function failingGrants(answers: { now: boolean }, overrides: Partial<EtcdClient> = {}): FakeEtcdClient {
    return readerClient({
      ...overrides,
      userGet: async () => {
        if (answers.now) return ["reader"];
        throw unavailable();
      },
    });
  }

  test("after an auth-store change, a refusal that needs no request is given before the grants are read again (spec E6, E8)", async () => {
    const answers = { now: true };
    const readOnlyClient = failingGrants(answers, MAINTENANCE);
    const readOnly = await connected({ ...PASSWORD_CONNECTION, readOnly: true }, readOnlyClient);
    const writerClient = failingGrants(answers);
    const writer = await connected(PASSWORD_CONNECTION, writerClient);
    readOnly.hooks[0].onAuthStoreChanged?.();
    writer.hooks[0].onAuthStoreChanged?.();
    answers.now = false;
    const marks = [readOnlyClient.calls.length, writerClient.calls.length];
    const readOnlyRefusal = new QueryError(readOnlySentence("connection"), "etcd");
    await expect(readOnly.provider.query("put /app/x 1")).rejects.toThrow(readOnlyRefusal);
    await expect(readOnly.provider.runMaintenance("compact")).rejects.toThrow(readOnlyRefusal);
    const protectedWrite = "del /registry/ --prefix";
    const parsed = parseEtcdCommand(protectedWrite, LIMITS);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const protectedRefusal = refuseBeforeSend(assessCommand(parsed.parsed.command), {});
    expect(protectedRefusal?.reason).toBe("protected-prefix");
    await expect(writer.provider.query(protectedWrite)).rejects.toThrow(
      new QueryError(protectedRefusal?.message as string, "etcd"),
    );
    expect([readOnlyClient.calls.length, writerClient.calls.length]).toEqual(marks);
  });

  test("a walk's own refusal that needs no request is given before the walk reads AuthStatus, so it sends nothing and a lost quorum never stands in for it (spec 4.3, 4.6, 5.6, E8)", async () => {
    let quorum = true;
    const client = readerClient({
      authStatus: async () => {
        if (!quorum) throw new EtcdError("no-leader", "etcdserver: no leader", 14);
        return { enabled: true, authRevision: "5" };
      },
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    quorum = false;
    const twin = readerClient();
    const context = contextFor(PASSWORD_CONNECTION, READER_PERMISSIONS);
    // A refusal reads no stamp, so any stamp stands in.
    const stamp: EtcdEditPlanStamp = { type: "etcd", connectionFingerprint: "", planId: "", issuedAt: "" };
    const protectedKey = { ...REQUEST, path: ["/registry/pods/default/nginx"] };
    const metadata = { ...REQUEST, partId: "metadata" };
    const refusals: ReadonlyArray<
      readonly [
        string,
        (provider: EtcdProvider) => Promise<unknown>,
        (client: FakeEtcdClient, context: EtcdSurfaceContext) => Promise<unknown>,
      ]
    > = [
      [
        "a Keys panel page that names a database",
        (p) => p.scanKeysPage({ cursor: "0", count: 10, database: 0 }),
        (c, x) => scanEtcdKeysPage(c, x, { cursor: "0", count: 10, database: 0 }),
      ],
      [
        "a Keys panel page of no keys",
        (p) => p.scanKeysPage({ cursor: "0", count: 0 }),
        (c, x) => scanEtcdKeysPage(c, x, { cursor: "0", count: 0 }),
      ],
      [
        "a cursor the provider did not write",
        (p) => p.scanKeysPage({ cursor: "12", count: 10 }),
        (c, x) => scanEtcdKeysPage(c, x, { cursor: "12", count: 10 }),
      ],
      [
        "a prefix that is not text",
        (p) => p.scanKeysPage({ cursor: "0", count: 10, pattern: "/app/\uD800" }),
        (c, x) => scanEtcdKeysPage(c, x, { cursor: "0", count: 10, pattern: "/app/\uD800" }),
      ],
      ["the listing of the key kind", (p) => p.listObjects([], "key"), (c, x) => listEtcdObjects(c, x, "key")],
      [
        "the source of an empty key",
        (p) => p.readObjectSource([""], "key"),
        (c, x) => readEtcdObjectSource(c, x, [""], "key"),
      ],
      [
        "the source of a key path of two segments",
        (p) => p.readObjectSource(["/app", "cfg"], "key"),
        (c, x) => readEtcdObjectSource(c, x, ["/app", "cfg"], "key"),
      ],
      [
        "the source of a group",
        (p) => p.readObjectSource(["/app/*"], "prefix"),
        (c, x) => readEtcdObjectSource(c, x, ["/app/*"], "prefix"),
      ],
      [
        "the build of a protected key's value edit (E8)",
        (p) => p.buildObjectEdit(protectedKey),
        (c, x) => buildEtcdValueEdit(c, x, protectedKey, stamp),
      ],
      [
        "the build of an edit of a key's metadata",
        (p) => p.buildObjectEdit(metadata),
        (c, x) => buildEtcdValueEdit(c, x, metadata, stamp),
      ],
    ];
    const outcome = (pending: Promise<unknown>) =>
      pending.then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : error }),
      );
    const answers: unknown[] = [];
    for (const [name, surface] of refusals) {
      const mark = client.calls.length;
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time, so each one's calls are its own.
      const answered = await outcome(surface(provider));
      answers.push({ name, answered, calls: methods(client, mark) });
    }
    const owed = await Promise.all(
      refusals.map(async ([name, , module]) => ({ name, answered: await outcome(module(twin, context)), calls: [] })),
    );
    expect(answers).toEqual(owed);
    // The modules' own refusals send nothing either: each is a refusal, never an answer read from etcd.
    expect(twin.calls).toEqual([]);
  });

  test("after an auth-store change, a surface that walks no key answers over the grants as they stand: the members, the health and the storage (spec 4.7, 7.1)", async () => {
    const answers = { now: true };
    const client = failingGrants(answers);
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    hooks[0].onAuthStoreChanged?.();
    answers.now = false;
    const member = memberHexId(MEMBER.id);
    const twin = readerClient();
    const context = contextFor(PASSWORD_CONNECTION, READER_PERMISSIONS);
    const mark = client.calls.length;
    expect(await provider.listObjects([], "member")).toEqual(await listEtcdObjects(twin, context, "member"));
    expect(await provider.readObjectSource([member], "member")).toEqual(
      await readEtcdObjectSource(twin, context, [member], "member"),
    );
    expect(await provider.getHealth()).toEqual(await readEtcdHealth(twin, context));
    expect(await provider.getStorageStats()).toEqual(await readEtcdStorageStats(twin, context));
    expect(callsOf(client, mark)).toEqual(callsOf(twin));
    // The change is still read before the next walk.
    answers.now = true;
    const walked = client.calls.length;
    await provider.listObjects([], "prefix");
    expect(methods(client, walked).slice(0, 3)).toEqual(["authStatus", "userGet", "roleGet"]);
  });
});

/**
 * The user a surface names (spec 4.7): whenever authentication is on and the user does not hold root,
 * whatever its grants read, and never otherwise. The prefix count names the user whose grants scope it,
 * so it shows which context a surface was given.
 */
describe("who a surface names (spec 4.7)", () => {
  const everyGroup = prefixGroups(KEYS.map((entry) => encode(entry.key))).groups.length;
  /** The key space unchecked and the three listings answered, as etcd answers root, and anyone with authentication off. */
  const UNREFUSED: Partial<EtcdClient> = {
    range: keySpaceRange(KEYS),
    userList: async () => ["reader", "root"],
    roleList: async () => ["reader", "root"],
    leaseLeases: async () => ({ header: KEY_SPACE_HEADER, ids: [] }),
  };

  test("as root, the count names no user and no range", async () => {
    const client = readerClient({ ...UNREFUSED, userGet: async () => ["root"] });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect((await provider.countObjects([])).prefix).toEqual({ count: everyGroup });
  });

  test("a password on an etcd whose AuthStatus then answers off names no user", async () => {
    const client = readerClient({ ...UNREFUSED, authStatus: async () => ({ enabled: false, authRevision: "1" }) });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect((await provider.countObjects([])).prefix).toEqual({ count: everyGroup });
  });

  test("a client certificate's Common Name on an etcd whose authentication is off names no user", async () => {
    const { provider } = await connected(CERTIFICATE_CONNECTION, etcdClient());
    expect((await provider.countObjects([])).prefix).toEqual({ count: everyGroup });
  });

  test("a user who is not root is named even when its grants read every key", async () => {
    const everyKey: readonly EtcdPermission[] = [
      { type: "readwrite", key: Uint8Array.of(0), rangeEnd: Uint8Array.of(0) },
    ];
    const client = readerClient({ roleGet: async () => everyKey, range: keySpaceRange(KEYS) });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect((await provider.countObjects([])).prefix).toEqual({
      count: everyGroup,
      sampledFrom: "the 1 range etcd user reader may read",
    });
  });

  test("a user who is not root whose grants read every key is scoped on the overview, and a refused command names what it may read (spec 4.7, 5.6)", async () => {
    const everyKey: readonly EtcdPermission[] = [{ type: "read", key: Uint8Array.of(0), rangeEnd: Uint8Array.of(0) }];
    const client = readerClient({ roleGet: async () => everyKey, range: keySpaceRange(KEYS) });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect(await provider.getOverview()).toMatchObject({
      tableCount: KEYS.length,
      tableCountSampledFrom: "the ranges etcd user reader may read: every key",
    });
    // etcd refuses `user list` to a user who is not root, whatever its grants read.
    expect(await provider.query("user list").catch((error: Error) => error.message)).toBe(
      "etcd refused the user list: this connection's etcd user is not granted all of it. (etcd: permission denied) etcd user reader may read: every key.",
    );
  });

  test("a user whose grants etcd refused to read is still named where a refusal names it", async () => {
    const client = readerClient({
      roleGet: async () => {
        throw denied();
      },
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    expect((await provider.countObjects([])).user).toEqual({
      unavailable: "Listing users needs the etcd root role, which reader does not hold (etcd: permission denied)",
    });
  });

  test("a user granted root since the connect is no longer named once the grants are read again", async () => {
    let roles: readonly string[] = ["reader"];
    const client = readerClient({ ...UNREFUSED, userGet: async () => roles });
    const { provider, hooks } = await connected(PASSWORD_CONNECTION, client);
    expect((await provider.countObjects([])).prefix).toMatchObject({ sampledFrom: expect.any(String) });
    roles = ["root"];
    hooks[0].onAuthStoreChanged?.();
    expect((await provider.countObjects([])).prefix).toEqual({ count: everyGroup });
  });

  /** A surface's answer, or its refusal's class and words. */
  const answerOf = (pending: Promise<unknown>) =>
    pending.then(
      () => "answered",
      (error: unknown) => (error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)),
    );

  test("a user who lost the root role since the grants were read is named where etcd refuses it, before any walk reads them again: the users and roles listings and maintenance (spec 4.3, 4.7, 7.2)", async () => {
    let root = true;
    let authRevision = "5";
    const asRoot = <T>(answer: T) => (root ? Promise.resolve(answer) : Promise.reject(denied()));
    const client = readerClient({
      ...UNREFUSED,
      authStatus: async () => ({ enabled: true, authRevision }),
      userGet: async () => (root ? ["root"] : ["reader"]),
      userList: () => asRoot(["reader", "root"]),
      roleList: () => asRoot(["reader", "root"]),
      compact: () => asRoot(undefined),
    });
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    // An admin revoked root from the reader; the next thing opened is the Users folder, and no walk ran since.
    root = false;
    authRevision = "6";
    expect(await answerOf(provider.listObjects([], "user"))).toBe(
      "QueryError: Listing users needs the etcd root role, which reader does not hold (etcd: permission denied)",
    );
    expect(await answerOf(provider.listObjects([], "role"))).toBe(
      "QueryError: Listing roles needs the etcd root role, which reader does not hold (etcd: permission denied)",
    );
    expect(await answerOf(provider.runMaintenance("compact"))).toBe(
      "QueryError: Compaction, defragmentation and alarm disarm need the etcd root role; this connection signs in as reader. (etcd: permission denied)",
    );
  });

  test("a certificate session that connected with authentication off is named where etcd refuses it once an admin turns authentication on (spec 4.3, 4.7)", async () => {
    let enabled = false;
    const asRoot = <T>(answer: T) => (enabled ? Promise.reject(denied()) : Promise.resolve(answer));
    const client = etcdClient({
      authStatus: async () => ({ enabled, authRevision: "2" }),
      range: (request, options) => keySpaceRange(KEYS, enabled ? READER_PERMISSIONS : undefined)(request, options),
      userList: () => asRoot(["cert-only", "root"]),
      roleList: () => asRoot(["root"]),
      leaseLeases: () => asRoot({ header: KEY_SPACE_HEADER, ids: [] }),
    });
    const { provider } = await connected(CERTIFICATE_CONNECTION, client);
    enabled = true;
    const counts = await provider.countObjects([]);
    expect(counts.user).toEqual({
      unavailable: "Listing users needs the etcd root role, which cert-only does not hold (etcd: permission denied)",
    });
    expect(counts.role).toEqual({
      unavailable: "Listing roles needs the etcd root role, which cert-only does not hold (etcd: permission denied)",
    });
    // Its grants were never read, so no range is named: etcd's refusal is the whole answer (spec 4.7).
    expect(counts.prefix).toEqual({
      unavailable:
        "etcd refused the Key Prefixes listing: this connection's etcd user is not granted all of it. (etcd: permission denied)",
    });
    expect(await answerOf(provider.listObjects([], "user"))).toBe(
      "QueryError: Listing users needs the etcd root role, which cert-only does not hold (etcd: permission denied)",
    );
  });
});

/**
 * Every call's deadline is the connection's query timeout (spec 5.3): the connect sequence's, which the adapter's
 * gRPC deadline sets alone, so it tells a call that never left the client (spec 5.6); and each surface's, each
 * command's and the read of the grants after an auth-store change, which the provider's signal bounds too; each
 * a call etcd never answers here.
 */
describe("each call's deadline, the connection's query timeout (spec 5.3)", () => {
  const TIMEOUT = 40;

  /** A call that answers only when its signal aborts, as grpc-js answers a call whose signal ended it. */
  function unanswered(...args: unknown[]): Promise<never> {
    const { signal } = args[args.length - 1] as { readonly signal: AbortSignal };
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(toEtcdError(signal.reason, signal)), { once: true });
    });
  }

  /** The deadline the factory's options set on every call (grpc-client.ts `wireCall`), read as the factory is called. */
  let callTimeoutMs = 0;

  /**
   * A call etcd never answers, ended as the adapter ends one: by its gRPC deadline, `callTimeoutMs` after the
   * call starts, with grpc-js's DEADLINE_EXCEEDED `details`, or, when its signal aborts first, by that abort,
   * which grpc-js answers CANCELLED "Cancelled on client"; the adapter's toEtcdError reads either.
   */
  function endedAtTheDeadline(details: string) {
    return (...args: unknown[]): Promise<never> => {
      const { signal } = args[args.length - 1] as { readonly signal: AbortSignal };
      return new Promise((_resolve, reject) => {
        const cancelled = () => reject(toEtcdError({ code: 1, details: "Cancelled on client" }, signal));
        if (signal.aborted) {
          cancelled();
          return;
        }
        const deadline = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          reject(toEtcdError({ code: 4, details }, signal));
        }, callTimeoutMs);
        const cancel = () => {
          clearTimeout(deadline);
          cancelled();
        };
        signal.addEventListener("abort", cancel, { once: true });
      });
    };
  }

  function timed(connection: DatabaseConnection, client: FakeEtcdClient) {
    const hooks: EtcdClientHooks[] = [];
    const provider = new EtcdProvider(connection, { queryTimeout: TIMEOUT }, {}, async (options, hook) => {
      callTimeoutMs = options.callTimeoutMs;
      if (hook !== undefined) hooks.push(hook);
      return client;
    });
    return { provider, hooks };
  }

  /**
   * Runs `call` and holds its refusal: a TimeoutError naming the query timeout, and every deadline set on the
   * way is the query timeout itself. The message's number is the configuration's, so only the deadlines
   * show the signal's.
   */
  async function reached(call: () => Promise<unknown>, command: string): Promise<void> {
    const deadlines = spyOn(AbortSignal, "timeout");
    try {
      const failure = await call().then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure).toBeInstanceOf(TimeoutError);
      expect(failure?.message).toStartWith(`The ${command} reached its deadline of ${TIMEOUT} ms.`);
      expect(deadlines).toHaveBeenCalled();
      expect(deadlines.mock.calls).toEqual(deadlines.mock.calls.map(() => [TIMEOUT]));
    } finally {
      deadlines.mockRestore();
    }
  }

  /** The connect sequence's refusal, or a mistake in the test where it connected. */
  async function connectFailure(provider: EtcdProvider): Promise<Error> {
    const failure = await provider.connect().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    if (failure === undefined) throw new Error("the provider connected to an etcd that never answers");
    return failure;
  }

  test("a step of the connect sequence etcd never answers: the adapter's deadline, the query timeout, ends it", async () => {
    const { provider } = timed(
      CONNECTION,
      etcdClient({ authStatus: endedAtTheDeadline("Deadline exceeded after 0.040s,remote_addr=127.0.0.1:2379") }),
    );
    const failure = await connectFailure(provider);
    expect(callTimeoutMs).toBe(TIMEOUT);
    expect(failure).toBeInstanceOf(TimeoutError);
    expect(failure.message).toBe(
      `The auth status reached its deadline of ${TIMEOUT} ms. (Deadline exceeded after 0.040s)`,
    );
  });

  test.each([
    ["with no credential, at the auth status", CONNECTION, "authStatus"],
    ["with a password, at the sign-in", PASSWORD_CONNECTION, "authenticate"],
  ] as const)(
    "a step of the connect sequence that never left the client is a connection error, %s, which only the adapter's deadline tells (spec 5.6)",
    async (_label, connection, step) => {
      const details = "Deadline exceeded after 0.040s,name resolution: 0.001s,Waiting for LB pick";
      const { provider } = timed(connection, readerClient({ [step]: endedAtTheDeadline(details) }));
      const failure = await connectFailure(provider);
      const options = buildEtcdConnectionOptions(connection, { executionReadOnly: false, queryTimeout: TIMEOUT });
      const neverSent = toProviderError(new EtcdError("not-connected", details, 4), {
        command: "connection",
        write: false,
        connection: etcdErrorConnection(options),
      });
      expect(failure).toBeInstanceOf(ConnectionError);
      expect(failure.message).toBe(neverSent.message);
      expect(failure.message).toEndWith(` (${details})`);
    },
  );

  test("a surface's read", async () => {
    const { provider } = timed(CONNECTION, etcdClient({ memberList: unanswered }));
    await provider.connect();
    await reached(() => provider.listObjects([], "member"), "Members listing");
  });

  test("a command", async () => {
    const { provider } = timed(CONNECTION, etcdClient({ range: unanswered }));
    await provider.connect();
    await reached(() => provider.query("get /app/cfg"), "get");
  });

  test("the read of the grants after an auth-store change", async () => {
    let answer = true;
    const client = readerClient({
      userGet: (...args: unknown[]) => (answer ? Promise.resolve(["reader"]) : unanswered(...args)),
    });
    const { provider, hooks } = timed(PASSWORD_CONNECTION, client);
    await provider.connect();
    answer = false;
    hooks[0].onAuthStoreChanged?.();
    await reached(() => provider.listObjects([], "prefix"), "read of etcd user reader's grants");
  });
});

// ============================================================================
// The surfaces, delegated (spec 3.5)
// ============================================================================

describe("every surface answers what its module answers, with the same calls (spec 3.5)", () => {
  const member = memberHexId(MEMBER.id);

  /**
   * The stamp the provider put on a built plan (its fingerprint, a fresh id and the time), so the edit
   * module is called with the same one and every other field is compared exactly; a refusal carries no
   * plan and reads no stamp. The stamp itself is held by the test after this table.
   */
  const stampOf = (answered: unknown): EtcdEditPlanStamp => {
    const build = answered as ObjectEditBuild;
    if (!build.built) return { type: CONNECTION.type, connectionFingerprint: "", planId: "", issuedAt: "" };
    const { type, connectionFingerprint: fingerprint, planId, issuedAt } = build.plan;
    return { type, connectionFingerprint: fingerprint, planId, issuedAt };
  };

  /**
   * Each surface, what its module answers over the same client and context, and whether it is a walk that reads
   * keys, which reads the auth store's revision first for a user who is not root (spec 4.7).
   */
  const SURFACES: ReadonlyArray<
    readonly [
      string,
      (provider: EtcdProvider) => Promise<unknown>,
      (client: FakeEtcdClient, context: EtcdSurfaceContext, answered: unknown) => Promise<unknown>,
      walks: boolean,
    ]
  > = [
    ["countObjects", (p) => p.countObjects([]), (c, x) => countEtcdObjects(c, x), true],
    ["listObjects of the groups", (p) => p.listObjects([], "prefix"), (c, x) => listEtcdObjects(c, x, "prefix"), true],
    [
      "listObjects of the members",
      (p) => p.listObjects([], "member"),
      (c, x) => listEtcdObjects(c, x, "member"),
      false,
    ],
    [
      "describeObjects of the groups",
      (p) => p.describeObjects([], "prefix", 10),
      async (c, x) => describeEtcdObjects("prefix", await listEtcdObjects(c, x, "prefix"), 10),
      true,
    ],
    [
      "describeObjects of a kind with no columns",
      (p) => p.describeObjects([], "member"),
      async () => describeEtcdObjects("member", []),
      false,
    ],
    [
      "a member's source",
      (p) => p.readObjectSource([member], "member"),
      (c, x) => readEtcdObjectSource(c, x, [member], "member"),
      false,
    ],
    [
      "a key's source",
      (p) => p.readObjectSource(["/app/cfg"], "key", 64),
      (c, x) => readEtcdObjectSource(c, x, ["/app/cfg"], "key", 64),
      true,
    ],
    [
      "a Keys panel page",
      (p) => p.scanKeysPage({ cursor: "0", count: 10, pattern: "/app/" }),
      (c, x) => scanEtcdKeysPage(c, x, { cursor: "0", count: 10, pattern: "/app/" }),
      true,
    ],
    [
      "a value edit's build",
      (p) => p.buildObjectEdit(REQUEST),
      (c, x, answered) => buildEtcdValueEdit(c, x, REQUEST, stampOf(answered)),
      true,
    ],
    ["getHealth", (p) => p.getHealth(), (c, x) => readEtcdHealth(c, x), false],
    ["getOverview", (p) => p.getOverview(), (c, x) => readEtcdOverview(c, x), true],
    ["getStorageStats", (p) => p.getStorageStats(), (c, x) => readEtcdStorageStats(c, x), false],
    [
      "getTableStats",
      (p) => p.getTableStats(),
      async (c, x) =>
        readEtcdTableStats(
          c,
          x,
          (await listEtcdObjects(c, x, "prefix")).map((group) => group.name.slice(0, -1)),
        ),
      true,
    ],
  ];

  test.each(SURFACES)("%s, as the reader", async (_name, surface, module, walks) => {
    const client = readerClient();
    const { provider } = await connected(PASSWORD_CONNECTION, client);
    const twin = readerClient();
    const mark = client.calls.length;
    const answered = await surface(provider);
    expect(answered).toEqual(await module(twin, contextFor(PASSWORD_CONNECTION, READER_PERMISSIONS), answered));
    // The revision matches the one the grants were read under, so no grant is read again.
    const check = walks ? [{ method: "authStatus", args: [] }] : [];
    expect(callsOf(client, mark)).toEqual([...check, ...callsOf(twin)]);
  });

  test.each(SURFACES)("%s, with authentication off", async (_name, surface, module) => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    const twin = etcdClient();
    const mark = client.calls.length;
    const answered = await surface(provider);
    expect(answered).toEqual(await module(twin, contextFor(CONNECTION), answered));
    expect(callsOf(client, mark)).toEqual(callsOf(twin));
  });

  test("a value edit's plan carries this connection's fingerprint, a fresh id and the time it was built", async () => {
    const { provider } = await connected(CONNECTION, etcdClient());
    const before = Date.now();
    const first = await provider.buildObjectEdit(REQUEST);
    const second = await provider.buildObjectEdit(REQUEST);
    const after = Date.now();
    if (!first.built || !second.built) throw new Error("the build refused the edit");
    expect(first.plan.type).toBe(CONNECTION.type);
    expect(first.plan.connectionFingerprint).toBe(await connectionFingerprint(CONNECTION));
    expect(first.plan.planId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Two plans for one edit are two edits: the apply's audit files each under its own id.
    expect(second.plan.planId).not.toBe(first.plan.planId);
    const issued = Date.parse(first.plan.issuedAt);
    expect(new Date(issued).toISOString()).toBe(first.plan.issuedAt);
    expect(issued).toBeGreaterThanOrEqual(before);
    expect(issued).toBeLessThanOrEqual(after);
  });

  test("describeObject reads nothing: a group's columns are fixed (spec 4.2)", async () => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    const mark = client.calls.length;
    expect(await provider.describeObject(["/app/a/*"], "prefix")).toEqual(describeEtcdObject(["/app/a/*"], "prefix"));
    expect(client.calls.length).toBe(mark);
  });

  test("a value edit's apply sends the plan its build made, as the edit module sends it", async () => {
    const txn = async () => ({
      header: KEY_SPACE_HEADER,
      succeeded: true,
      responses: [{ op: "put" as const, response: { header: KEY_SPACE_HEADER } }],
    });
    const client = etcdClient({ txn });
    const { provider } = await connected(CONNECTION, client);
    const built = await provider.buildObjectEdit(REQUEST);
    if (!built.built) throw new Error(`the build refused the edit: ${JSON.stringify(built.refusal)}`);
    const plan: ObjectEditPlan = built.plan;
    const twin = etcdClient({ txn });
    const mark = client.calls.length;
    const outcome = await provider.applyObjectEdit(plan);
    const expected = await applyEtcdValueEdit(twin, contextFor(CONNECTION), plan);
    expect({ ...outcome, duration: 0 }).toEqual({ ...expected, duration: 0 });
    expect(callsOf(client, mark)).toEqual(callsOf(twin));
  });

  test.each([...ETCD_MAINTENANCE_OPERATIONS])(
    "maintenance is the maintenance module's, with the same calls: %s",
    async (type) => {
      const client = etcdClient(MAINTENANCE);
      const { provider } = await connected(CONNECTION, client);
      const twin = etcdClient(MAINTENANCE);
      const mark = client.calls.length;
      const result = await provider.runMaintenance(type);
      const expected = await runEtcdMaintenance(twin, contextFor(CONNECTION), type);
      expect({ ...result, executionTime: 0 }).toEqual({ ...expected, executionTime: 0 });
      expect(callsOf(client, mark)).toEqual(callsOf(twin));
    },
  );

  test("the surfaces etcd has nothing honest for answer empty and read nothing (spec 7.1)", async () => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    const mark = client.calls.length;
    expect(await provider.listContainers()).toEqual([]);
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(client.calls.length).toBe(mark);
  });

  test("a container path is refused on every object surface, before any call (spec 4.1)", async () => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    const mark = client.calls.length;
    const refusal = new QueryError('An etcd connection has no container level; received ["0"]', "etcd");
    await expect(provider.countObjects(["0"])).rejects.toThrow(refusal);
    await expect(provider.listObjects(["0"], "prefix")).rejects.toThrow(refusal);
    await expect(provider.describeObjects(["0"], "prefix")).rejects.toThrow(refusal);
    await expect(provider.describeObjects(["0"], "member")).rejects.toThrow(refusal);
    expect(client.calls.length).toBe(mark);
  });
});

// ============================================================================
// The query path (spec 5)
// ============================================================================

describe("the query path (spec 5.1, 5.4, E6)", () => {
  test("bound params are refused, and an empty list binds nothing (spec 5.4)", async () => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    const mark = client.calls.length;
    await expect(provider.query("get /app/cfg", ["x"])).rejects.toThrow(
      new DatabaseConfigError("Bound params are not supported: an etcdctl command has no placeholders", "etcd"),
    );
    expect(client.calls.length).toBe(mark);
    expect((await provider.query("get /app/cfg", [])).rowCount).toBe(1);
  });

  test("a command the parser refuses is its sentence, and nothing is sent", async () => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    const mark = client.calls.length;
    const refused = ["compaction 5", "get /app/cfg --sort-by=KEY", "", "get /a\nget /b"];
    await Promise.all(
      refused.map((text) => expect(provider.query(text)).rejects.toThrow(new QueryError(refusalOf(text), "etcd"))),
    );
    expect(client.calls.length).toBe(mark);
  });

  test("the connection's query timeout and the row limit are the parser's caps (spec 5.1.2, 5.3, 5.4)", async () => {
    const { provider } = await connected(CONNECTION, etcdClient());
    const overCaps = [
      "get /app/ --prefix --command-timeout=10s",
      `get /app/ --prefix --limit=${DEFAULT_QUERY_LIMIT + 1}`,
      // Inside the query timeout and past the watch cap, the timeout less KE5's margin (spec 5.3).
      `watch /app/ --prefix --command-timeout=${QUERY_TIMEOUT - Math.ceil(ETCD_READ_BOUNDS.watchMarginMs / 2)}ms`,
      `txn\n\nget /app/ --prefix --limit=${ETCD_READ_BOUNDS.firstPageSize + 1}\n\n`,
    ];
    await Promise.all(overCaps.map((text) => expect(provider.query(text)).rejects.toThrow(refusalOf(text))));
  });

  test("a query timeout inside the watch margin caps a typed watch window at 0 s, never below it (spec 5.3)", async () => {
    // 200 ms inside the margin: the cap is 0 s, never the -200 ms the subtraction leaves.
    const queryTimeout = ETCD_READ_BOUNDS.watchMarginMs - 200;
    const client = etcdClient();
    const provider = new EtcdProvider(CONNECTION, { queryTimeout }, {}, async () => client);
    await provider.connect();
    const mark = client.calls.length;
    const text = "watch /a --command-timeout=100ms";
    const refusal = refusalOf(text, { ...LIMITS, maxCommandTimeoutMs: queryTimeout, maxWatchWindowMs: 0 });
    await expect(provider.query(text)).rejects.toThrow(new QueryError(refusal, "etcd"));
    expect(client.calls.length).toBe(mark);
  });

  test("a watch's default window is capped by the query timeout less the margin, as the command module caps it (spec 5.3)", async () => {
    // Below etcdctl's 5 s window plus the margin, so the default window is capped, here at 100 ms.
    const queryTimeout = ETCD_READ_BOUNDS.watchMarginMs + 100;
    // A watch that sees no event and settles when its window aborts its signal.
    const watch: EtcdClient["watch"] = (_request, _onBatch, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ reason: "aborted" }), { once: true });
      });
    const client = etcdClient({ watch });
    const provider = new EtcdProvider(CONNECTION, { queryTimeout }, {}, async () => client);
    await provider.connect();
    const twin = etcdClient({ watch });
    const mark = client.calls.length;
    const text = "watch /app/ --prefix";
    const parsed = parseEtcdCommand(text, LIMITS);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const options = buildEtcdConnectionOptions(CONNECTION, { executionReadOnly: false, queryTimeout });
    const [result, outcome] = await Promise.all([
      provider.query(text),
      executeCommand(twin, parsed.parsed, {
        bounds: { ...ETCD_READ_BOUNDS, rowLimit: DEFAULT_QUERY_LIMIT, queryTimeoutMs: queryTimeout },
        signal: AbortSignal.timeout(queryTimeout),
        endpoint: "etcd.test:2379",
        now: () => Date.now(),
        setTimer: (ms, fn) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
        errors: etcdErrorConnection(options),
        onWriteSent: () => {},
      }),
    ]);
    const expected = commandResult(outcome, { executionTime: 0, cellLimit: ETCD_READ_BOUNDS.cellLimit });
    expect({ ...result, executionTime: 0 }).toEqual({ ...expected, executionTime: 0 });
    expect(callsOf(client, mark)).toEqual(callsOf(twin));
    expect(result.warnings?.[0]?.message).toContain(
      "The window was capped at 100 ms by this connection's query timeout",
    );
  });

  test("a --command-timeout is the command's own deadline, which the provider's timer keeps (spec 5.1.2)", async () => {
    // A read that answers only when its signal aborts, so only the command's deadline ends it.
    const client = etcdClient({
      range: (_request, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(toEtcdError(signal.reason, signal)), { once: true });
        }),
    });
    const { provider } = await connected(CONNECTION, client);
    const failure = await provider.query("get /app/cfg --command-timeout=40ms").then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(TimeoutError);
    expect(failure?.message).toBe("The get reached its deadline of 40 ms. (--command-timeout reached)");
  });

  test("the deadline of a command that answers first is cleared with it", async () => {
    const set = spyOn(globalThis, "setTimeout");
    const cleared = spyOn(globalThis, "clearTimeout");
    try {
      const { provider } = await connected(CONNECTION, etcdClient());
      expect((await provider.query("get /app/cfg --command-timeout=3s")).rowCount).toBe(1);
      const deadline = set.mock.calls.findIndex((call) => call[1] === 3_000);
      expect(deadline).toBeGreaterThanOrEqual(0);
      const timer: unknown = set.mock.results[deadline]?.value;
      expect(cleared.mock.calls.some((call) => call[0] === timer)).toBe(true);
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });

  test("a read answers what the command modules answer, with the same calls", async () => {
    const client = etcdClient();
    const { provider } = await connected(CONNECTION, client);
    const twin = etcdClient();
    const mark = client.calls.length;
    const result = await provider.query("get /app/ --prefix --limit=2");
    const parsed = parseEtcdCommand("get /app/ --prefix --limit=2", LIMITS);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const context = contextFor(CONNECTION);
    const outcome = await executeCommand(twin, parsed.parsed, {
      bounds: { ...ETCD_READ_BOUNDS, rowLimit: DEFAULT_QUERY_LIMIT, queryTimeoutMs: QUERY_TIMEOUT },
      signal: context.signal,
      endpoint: "etcd.test:2379",
      now: () => Date.now(),
      setTimer: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      errors: context.errors,
      onWriteSent: () => {},
    });
    const expected = commandResult(outcome, { executionTime: 0, cellLimit: ETCD_READ_BOUNDS.cellLimit });
    expect({ ...result, executionTime: 0 }).toEqual({ ...expected, executionTime: 0 });
    expect(callsOf(client, mark)).toEqual(callsOf(twin));
  });

  test("the endpoint an endpoint status names is the configured one, an IPv6 literal in brackets", async () => {
    const byName = await connected(CONNECTION, etcdClient());
    expect((await byName.provider.query("endpoint status")).rows[0]?.endpoint).toBe("etcd.test:2379");
    const byAddress = await connected({ ...CONNECTION, host: "::1", port: 12379 }, etcdClient());
    expect((await byAddress.provider.query("endpoint status")).rows[0]?.endpoint).toBe("[::1]:12379");
  });

  test.each([
    ["a seed", { ...CONNECTION, readOnly: true, seedId: "prod" }, {}, "seed"],
    ["a connection of the user's own", { ...CONNECTION, readOnly: true }, {}, "connection"],
    [
      "an execution profile (spec E12's operations profile among them)",
      CONNECTION,
      { readOnly: true },
      "execution-profile",
    ],
    [
      "a connection and a profile both, which the connection's own sentence names",
      { ...CONNECTION, readOnly: true },
      { readOnly: true },
      "connection",
    ],
  ] as const)(
    "read-only through %s: every write is refused before any request (spec E6)",
    async (_label, connection, execution, source) => {
      const txn = async () => ({ header: KEY_SPACE_HEADER, succeeded: true, responses: [] });
      const client = etcdClient({ ...MAINTENANCE, txn });
      const { provider } = await connected(connection as DatabaseConnection, client, execution);
      // A plan a read-write provider built, which the read-only one is then handed.
      const writer = await connected(CONNECTION, etcdClient({ txn }));
      const built = await writer.provider.buildObjectEdit(REQUEST);
      if (!built.built) throw new Error(`the read-write build refused the edit: ${JSON.stringify(built.refusal)}`);
      const mark = client.calls.length;
      const sentence = readOnlySentence(source);
      const writes = ["put /app/cfg value", "del /app/ --prefix", "lease grant 60", "lease revoke 694d8147df1dc4c8"];
      await Promise.all(writes.map((text) => expect(provider.query(text)).rejects.toThrow(sentence)));
      // An edit and each maintenance operation are refused the same way, through the surface's context.
      await Promise.all(
        ETCD_MAINTENANCE_OPERATIONS.map((type) =>
          expect(provider.runMaintenance(type)).rejects.toThrow(new QueryError(sentence, "etcd")),
        ),
      );
      const refusal: ObjectEditRefusal = { refusal: "privilege", sentence, at: { within: "none" } };
      expect(await provider.buildObjectEdit(REQUEST)).toEqual({ built: false, refusal });
      const applied = await provider.applyObjectEdit(built.plan);
      expect({ ...applied, duration: 0 }).toEqual({ outcome: "refused", refusal, duration: 0 });
      expect(client.calls.length).toBe(mark);
      // A read still runs.
      expect((await provider.query("get /app/cfg")).rowCount).toBe(1);
    },
  );

  test("a read-only reader's value edit is refused before any request, the auth store's revision unread (spec 4.5, E6)", async () => {
    const client = readerClient();
    const { provider } = await connected({ ...PASSWORD_CONNECTION, readOnly: true }, client);
    const mark = client.calls.length;
    const refusal: ObjectEditRefusal = {
      refusal: "privilege",
      sentence: readOnlySentence("connection"),
      at: { within: "none" },
    };
    expect(await provider.buildObjectEdit(REQUEST)).toEqual({ built: false, refusal });
    expect(client.calls.length).toBe(mark);
  });

  test("a read etcd refuses names what the reader may read (spec 5.6, 4.7)", async () => {
    const { provider } = await connected(PASSWORD_CONNECTION, readerClient());
    const failure = await provider.query("get /secret/x").then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure?.message).toContain(
      `etcd user reader may read: ${describeScope(readableScope(READER_PERMISSIONS))}.`,
    );
  });

  test("with authentication off, or as root, a refusal carries no list of what may be read", async () => {
    // etcd's refusal in the table's words, and nothing after it: no user's ranges to name.
    const bare =
      "etcd refused the get on /a: this connection's etcd user is not granted all of it. (etcd: permission denied)";
    const off = await connected(CONNECTION, etcdClient({ range: async () => Promise.reject(denied()) }));
    expect(await off.provider.query("get /a").catch((error: Error) => error.message)).toBe(bare);
    const root = await connected(
      PASSWORD_CONNECTION,
      readerClient({ userGet: async () => ["root"], range: async () => Promise.reject(denied()) }),
    );
    expect(await root.provider.query("get /a").catch((error: Error) => error.message)).toBe(bare);
    const refused = await connected(
      PASSWORD_CONNECTION,
      readerClient({
        roleGet: async () => {
          throw denied();
        },
        range: async () => Promise.reject(denied()),
      }),
    );
    expect(await refused.provider.query("get /a").catch((error: Error) => error.message)).toBe(bare);
  });
});

describe("cancelQuery (spec 5.5)", () => {
  /** A read that answers only when its signal aborts, as grpc-js answers a cancelled call. */
  const hangingRange =
    (): EtcdClient["range"] =>
    (_request, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(toEtcdError(signal.reason, signal)), { once: true });
      });

  test("answers false when nothing runs under the id", async () => {
    const { provider } = await connected(CONNECTION, etcdClient());
    expect(await provider.cancelQuery("nothing")).toBe(false);
  });

  test("stops a read in flight and answers true; the read is the cancel the editor reads as its own", async () => {
    const client = etcdClient({ range: hangingRange() });
    const { provider } = await connected(CONNECTION, client);
    const running = provider.query("get /app/ --prefix", undefined, "q-read");
    await until(() => client.calls.some((call) => call.method === "range"));
    expect(await provider.cancelQuery("q-read")).toBe(true);
    await expect(running).rejects.toBeInstanceOf(QueryCancelledError);
    expect(await provider.cancelQuery("q-read")).toBe(false);
  });

  test("answers false for a write already sent, which then finishes", async () => {
    let release: (() => void) | undefined;
    const client = etcdClient({
      txn: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              header: KEY_SPACE_HEADER,
              succeeded: true,
              responses: [{ op: "put", response: { header: KEY_SPACE_HEADER } }],
            });
        }),
    });
    const { provider } = await connected(CONNECTION, client);
    const running = provider.query("put /app/new value", undefined, "q-put");
    await until(() => release !== undefined);
    expect(await provider.cancelQuery("q-put")).toBe(false);
    release?.();
    expect((await running).rowCount).toBeGreaterThan(0);
  });

  test("a query with no id cannot be cancelled, and an id a later query reuses stays that query's", async () => {
    // Each read waits until the test answers it, or until its signal aborts.
    const answer: Array<() => void> = [];
    const client = etcdClient({
      range: (_request, { signal }) =>
        new Promise((resolve, reject) => {
          answer.push(() => resolve({ header: KEY_SPACE_HEADER, kvs: [], more: false, count: "0" }));
          signal.addEventListener("abort", () => reject(toEtcdError(signal.reason, signal)), { once: true });
        }),
    });
    const { provider } = await connected(CONNECTION, client);
    const unnamed = provider.query("get /app/ --prefix");
    const first = provider.query("get /app/ --prefix", undefined, "q");
    const second = provider.query("get /config/ --prefix", undefined, "q");
    await until(() => answer.length === 3);
    // The first query under the id ends while the second, which took the id over, still runs.
    answer[1]();
    expect((await first).rowCount).toBe(0);
    expect(await provider.cancelQuery("q")).toBe(true);
    await expect(second).rejects.toBeInstanceOf(QueryCancelledError);
    expect(await provider.cancelQuery("q")).toBe(false);
    answer[0]();
    expect((await unnamed).rowCount).toBe(0);
  });
});
