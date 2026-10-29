/**
 * Unit tests for the Kubernetes discovery exporter (`docker/discover-kubernetes.mjs`).
 *
 * The exporter reads the credential Secrets of every supported database in the namespaces a cluster owner opted in,
 * and writes them into one Secret Studio's pod mounts, so a mistake here leaks a password or hands Studio the wrong
 * one. It sits outside src/, so the coverage gate does not measure it (scripts/merge-lcov.mjs keeps src/ only): every
 * branch below is covered by discipline instead, as tests/unit/docker-discover.test.ts covers the CapRover exporter.
 *
 * Every case runs against a fake Kubernetes API over https (tests/helpers/kubernetes-discovery/fake-api.ts), so the
 * token and CA files, TLS, paging, refusals and the optimistic write are the real code paths.
 *
 * WHY each group is worth locking:
 *  - The contract row is the same data as Studio's table: a drift reads one Secret and makes Studio ask the review
 *    about another, or keeps a key Studio never reads.
 *  - Only the contract's keys leave a Secret, and no value reaches a log line.
 *  - 403, 404 and a list over the size or page bound are answers that withdraw one namespace's databases, and the
 *    database and export bounds are shared fairly, so one namespace's editors cannot crowd another out; every other
 *    failure keeps the last good scan.
 *  - The write keeps the Secret's Helm metadata and fails over to one retry on a conflict, never to a blind write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KUBERNETES_CONTRACT, mapKubernetesDatabase } from "@/lib/seed/kubernetes-discovery-contract";
import {
  KUBERNETES_DISCOVERY_EXPORT_VERSION,
  parseKubernetesDiscoveryExport,
  type KubernetesDiscoveredDatabase,
} from "@/lib/seed/kubernetes-discovery-export";
import {
  buildExport,
  classifyApiError,
  CONTRACT,
  createApiClient,
  createExporter,
  DEFAULTS,
  EXPORT_VERSION,
  fairShares,
  isDirectExecution,
  LIMITS,
  main,
  readConfig,
  RESERVED_SECRET_NAMES,
  RESERVED_SECRET_SUFFIXES,
  isReservedSecretName,
  scanOnce,
  serviceProblem,
  serializeExport,
  writeExport,
} from "../../docker/discover-kubernetes.mjs";
import {
  FAKE_DISCOVERY_TOKEN,
  type FakeDiscoveryApi,
  ownerReference,
  type ServiceShape,
  startFakeDiscoveryApi,
  statusBody,
} from "../helpers/kubernetes-discovery/fake-api";
import { GOLDEN_CASES, type GoldenCase, goldenEntry, goldenRow } from "../helpers/kubernetes-discovery-fixture";
import { eventually } from "../helpers/node-transport-fixtures";

const T0 = Date.parse("2026-10-28T08:00:00.000Z");
const PASSWORD_A = "not-a-real-password-orders";
const PASSWORD_B = "not-a-real-password-analytics";
const EXPORT_PATH = "/api/v1/namespaces/libredb-studio/secrets/libredb-studio-discovery-export";

// The hosts below are those of the default cluster domain.
delete process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;

let api: FakeDiscoveryApi;

/** A candidate an exporter row expands a listed item into, typed for the assertions. */
interface ExporterCandidate {
  row: ExporterRow;
  resource: {
    metadata: { namespace: string; name: string };
    spec?: { users?: { name: string; roles?: { db: string }[] }[] } & Record<string, unknown>;
  };
  uid?: string;
  secretName?: string;
  exact: string[];
  precheck?: string;
}

/** An exporter contract row, typed for the assertions: the module is JavaScript, and its inferred union is too narrow. */
interface ExporterRow {
  slug: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  secretType: string;
  allowedKeys: readonly string[];
  secretKeys: readonly string[];
  requiredKeys(candidate: unknown): string[];
  serviceName(resource: unknown): string;
  expand(item: unknown): { candidates: ExporterCandidate[]; leftOut: number };
}

const EXPORTER_ROWS = CONTRACT as unknown as readonly ExporterRow[];

/** The exporter's row of the kind `slug`. */
function exporterRow(slug: string): ExporterRow {
  const row = EXPORTER_ROWS.find((entry) => entry.slug === slug);
  if (row === undefined) throw new Error(`the exporter has no row ${slug}`);
  return row;
}

/** scanOnce's answer, typed for the assertions: the exporter is JavaScript, so the union TypeScript infers is loose. */
interface Scan {
  ok: boolean;
  namespaces: { name: string; status: Record<string, unknown> }[];
  databases: KubernetesDiscoveredDatabase[];
  truncated: boolean;
  leftOut: number;
  status: { ok: boolean; code?: string; httpStatus?: number; message: string };
}

async function scan(options: { client: unknown; config: unknown; limits?: typeof LIMITS }): Promise<Scan> {
  return (await scanOnce(options as never)) as unknown as Scan;
}

/** What a promise rejected with, awaited rather than waited for in place (see "the harness"); a fulfilment fails. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, the promise fulfilled with ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );
}

/** LIMITS with some bounds lowered, so a case reaches a bound without building thousands of objects. */
function limitsWith(overrides: Partial<Record<keyof typeof LIMITS, number>>): typeof LIMITS {
  return { ...LIMITS, ...overrides } as unknown as typeof LIMITS;
}

beforeAll(async () => {
  api = await startFakeDiscoveryApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.reset();
});

/** The two lab databases: orders in team-a with its <name>-app Secret, analytics in team-b with its own. */
function seedLab(): void {
  api.addCluster("team-a", "orders", { bootstrap: { initdb: { database: "orders", owner: "orders" } } });
  api.addAppSecret("team-a", "orders", {
    username: "orders",
    password: PASSWORD_A,
    dbname: "orders",
    port: "5432",
    host: "orders-rw",
    uri: `postgresql://orders@orders-rw.team-a:5432/orders?password=${PASSWORD_A}`,
    "jdbc-uri": `jdbc:postgresql://orders-rw.team-a:5432/orders?password=${PASSWORD_A}&user=orders`,
  });
  api.addCluster("team-b", "analytics");
  api.addAppSecret("team-b", "analytics", { username: "app", password: PASSWORD_B, dbname: "app", port: "5432" });
}

function config(extra: Record<string, string> = {}) {
  return readConfig(api.env(extra));
}

function client(extra: Record<string, unknown> = {}) {
  const settings = config();
  return createApiClient({
    apiUrl: settings.apiUrl,
    tokenPath: settings.tokenPath,
    caPath: settings.caPath,
    ...extra,
  });
}

function logs() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (chunk: string) => out.push(chunk),
    stderr: (chunk: string) => err.push(chunk),
    all: () => [...out, ...err].join(""),
  };
}

/** A port nothing listens on: bound, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/*
 * bun:test's expect(promise).rejects and .resolves wait for a pending promise by running the event loop inside the
 * caller. A case that starts right after an await settled in a socket's callback (every answer of the fake API) then
 * runs that nested loop inside the socket's dispatch, and Bun 1.4.2 on Windows frees the socket under it: a segfault
 * in us_internal_ssl_close or us_internal_dispatch_ready_poll (oven-sh/bun#39643, relanded in 1.4.4 by #42667). A
 * case here awaits the promise and asserts on what it settled to instead, so no case runs a loop inside another.
 */
describe("the harness", () => {
  test("expect().rejects runs the event loop inside the caller, which is why no case here uses it", async () => {
    let inCaller = true;
    let firedInCaller = false;
    const late = new Promise((_, reject) =>
      setTimeout(() => {
        firedInCaller = inCaller;
        reject(new Error("late"));
      }, 1),
    );
    const asserted = expect(late).rejects.toThrow("late");
    inCaller = false;
    await asserted;
    expect(firedInCaller).toBe(true);
  });

  test("no case waits on a promise with expect().rejects or expect().resolves", () => {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    // The case above is the one use, on purpose: it runs before any socket is opened.
    const first = lines.findIndex((line) => line.startsWith('describe("the reviewed constants"'));
    const waits = lines.flatMap((line, index) =>
      index > first && /\.(rejects|resolves)\./.test(line) ? [index + 1] : [],
    );
    expect(waits).toEqual([]);
  });
});

describe("the reviewed constants", () => {
  test("defaults and limits", () => {
    expect(DEFAULTS).toEqual({
      intervalMs: 30000,
      minIntervalMs: 5000,
      apiUrl: "https://kubernetes.default.svc",
      tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      caPath: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      exportKey: "export.json",
      kinds: ["cnpg"],
    });
    expect(LIMITS).toEqual({
      namespaces: 256,
      databases: 500,
      valueBytes: 1024,
      exportBytes: 983040,
      responseBytes: 16777216,
      pageSize: 10,
      pages: 100,
      requestTimeoutMs: 10000,
      messageChars: 512,
    });
    // A Secret holds at most 1 MiB; the export leaves room for its key.
    expect(LIMITS.exportBytes).toBeLessThan(1024 * 1024);
  });

  // etcd refuses a request over 1.5 MiB by default (--max-request-bytes), so no object a list returns is larger, and a
  // full page of the largest objects a namespace's editors can make stays under the response bound.
  test("the export version is Studio's", () => {
    expect(EXPORT_VERSION).toBe(KUBERNETES_DISCOVERY_EXPORT_VERSION);
    const data = buildExport({ now: T0, status: { ok: true }, generatedAt: null, namespaces: [], databases: [] });
    expect(data.version).toBe(KUBERNETES_DISCOVERY_EXPORT_VERSION);
  });

  test("a full page of the largest objects etcd keeps fits the response bound", () => {
    const etcdMaxRequestBytes = 1.5 * 1024 * 1024;
    expect(LIMITS.pageSize * etcdMaxRequestBytes).toBeLessThan(LIMITS.responseBytes);
  });

  test("the contract rows are Studio's, row for row", () => {
    expect(CONTRACT.map((row: Record<string, unknown>) => row.slug)).toEqual(
      KUBERNETES_CONTRACT.map((row) => row.slug),
    );
    for (const studio of KUBERNETES_CONTRACT) {
      const row = exporterRow(studio.slug);
      expect(row).toMatchObject({
        slug: studio.slug,
        group: studio.group,
        version: studio.version,
        kind: studio.kind,
        plural: studio.plural,
        secretType: studio.secretType,
        secretKeys: [...studio.secretKeys],
      });
      // Every kept key is an allowed key: the exporter never keeps a key it would refuse.
      for (const key of row.secretKeys) expect(row.allowedKeys).toContain(key);
    }
    expect(Object.isFrozen(CONTRACT)).toBe(true);
    for (const row of CONTRACT) expect(Object.isFrozen(row)).toBe(true);
  });

  test("the measured key sets", () => {
    const keys = exporterRow;
    const cnpg = [
      "dbname",
      "fqdn-jdbc-uri",
      "fqdn-uri",
      "host",
      "jdbc-uri",
      "password",
      "pgpass",
      "port",
      "uri",
      "user",
      "username",
    ];
    expect(keys("cnpg").allowedKeys).toEqual(cnpg);
    expect(keys("edbpg").allowedKeys).toEqual(cnpg);
    expect(keys("pgo").allowedKeys).toEqual([
      "dbname",
      "host",
      "jdbc-uri",
      "password",
      "port",
      "uri",
      "user",
      "verifier",
      "pgbouncer-host",
      "pgbouncer-port",
      "pgbouncer-uri",
      "pgbouncer-jdbc-uri",
    ]);
    expect(keys("mongo").allowedKeys).toEqual([
      "connectionString.standard",
      "connectionString.standardSrv",
      "password",
      "username",
    ]);
  });

  test.each(GOLDEN_CASES.map((c) => [`${c.resource.kind} ${c.secretName}`, c] as const))(
    "each golden case names the same Secret and Service on both sides: %s",
    (_, c) => {
      const studio = goldenRow(c);
      const row = exporterRow(studio.slug);
      const { candidates, leftOut } = row.expand(c.resource);
      expect(leftOut).toBe(0);
      const candidate = candidates.find(
        (entry) =>
          c.user === undefined || (entry.resource.spec?.users?.[0]?.name ?? c.resource.metadata.name) === c.user,
      );
      if (candidate === undefined) throw new Error("the exporter gave no row for the golden case");
      // The exporter writes the resource Studio reads, and names the Secret and Service Studio's row names.
      const resource = candidate.resource as KubernetesDiscoveredDatabase["resource"];
      expect(resource).toEqual(goldenEntry(c).resource);
      expect(candidate.secretName).toBe(c.secretName);
      expect(candidate.uid).toBe(c.resource.metadata.uid);
      expect(row.serviceName(resource)).toBe(c.service.name);
      expect(studio.secretName(resource)).toBe(c.secretName);
      expect(studio.serviceName(resource)).toBe(c.service.name);
    },
  );

  test("the CloudNativePG family prunes a resource to the contract's fields and names the operator's reserved Secrets", () => {
    for (const slug of ["cnpg", "edbpg"]) {
      const row = exporterRow(slug);
      expect(
        row.expand({
          apiVersion: "postgresql.cnpg.io/v1",
          metadata: { namespace: "prod", name: "billing-db", uid: "u", labels: { a: "b" } },
          spec: {
            instances: 3,
            bootstrap: { initdb: { database: "billing", owner: "o", secret: { name: "billing-owner", x: 1 } } },
            certificates: { serverCASecret: "my-ca", serverTLSSecret: "my-tls", replicationTLSSecret: 7 },
            superuserSecret: { name: "my-superuser" },
          },
        }),
      ).toEqual({
        candidates: [
          {
            row,
            resource: {
              metadata: { namespace: "prod", name: "billing-db" },
              spec: { bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } } },
            },
            uid: "u",
            secretName: "billing-owner",
            exact: [
              "billing-db-ca",
              "billing-db-server",
              "billing-db-replication",
              "billing-db-superuser",
              "my-ca",
              "my-tls",
              "my-superuser",
            ],
          },
        ],
        leftOut: 0,
      });
      // A database that is not a name Studio accepts leaves the resource out rather than connecting to another one.
      expect(
        row.expand({ metadata: { namespace: "a", name: "b" }, spec: { bootstrap: { initdb: { database: 1 } } } }),
      ).toEqual({ candidates: [], leftOut: 1 });
      expect(row.expand({ metadata: { namespace: "a", name: "b" } }).candidates[0]).toMatchObject({
        resource: { metadata: { namespace: "a", name: "b" } },
        secretName: "b-app",
      });
      const odd = [
        null,
        {},
        { metadata: { name: "b" } },
        { metadata: { namespace: "a", name: 7 } },
        { metadata: { namespace: "a", name: "B" } },
        { metadata: { namespace: "a", name: "b" }, spec: { bootstrap: { initdb: { secret: { name: "Bad_Name" } } } } },
      ];
      for (const item of odd) expect(row.expand(item)).toEqual({ candidates: [], leftOut: 1 });
    }
  });

  test("names each row's required keys", () => {
    const row = exporterRow;
    const cnpg = row("cnpg").expand({ metadata: { namespace: "a", name: "b" } }).candidates[0];
    const supplied = row("cnpg").expand({
      metadata: { namespace: "a", name: "b" },
      spec: { bootstrap: { initdb: { secret: { name: "owner" } } } },
    }).candidates[0];
    expect(row("cnpg").requiredKeys(cnpg)).toEqual(["username", "password", "dbname", "port"]);
    expect(row("cnpg").requiredKeys(supplied)).toEqual(["username", "password"]);
    expect(row("pgo").requiredKeys({})).toEqual(["user", "password", "host", "port", "dbname"]);
    expect(row("mongo").requiredKeys({})).toEqual(["connectionString.standard", "username", "password"]);
  });
});

describe("expansion", () => {
  const pgo = exporterRow("pgo");
  const mongo = exporterRow("mongo");
  const PGO_METADATA = { namespace: "team-b", name: "analytics", uid: "uid-analytics" };
  const MONGO_METADATA = { namespace: "team-m", name: "catalog", uid: "uid-catalog" };

  test("PGO gives one candidate per user, its resource pruned to that user", () => {
    const { candidates, leftOut } = pgo.expand({
      metadata: PGO_METADATA,
      spec: {
        users: [
          { name: "analyst", databases: ["analytics"], options: "SUPERUSER" },
          { name: "reporter", databases: ["analytics", "metrics"] },
        ],
      },
    });
    expect(leftOut).toBe(0);
    expect(candidates).toEqual([
      {
        row: pgo,
        resource: { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: [{ name: "analyst" }] } },
        uid: "uid-analytics",
        secretName: "analytics-pguser-analyst",
        exact: [],
      },
      {
        row: pgo,
        resource: { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: [{ name: "reporter" }] } },
        uid: "uid-analytics",
        secretName: "analytics-pguser-reporter",
        exact: [],
      },
    ]);
  });

  test("PGO gives its default user, named after the cluster, when spec.users is absent or empty", () => {
    for (const spec of [undefined, {}, { users: [] }, { users: null }]) {
      const { candidates, leftOut } = pgo.expand({ metadata: { ...PGO_METADATA, name: "metrics" }, spec });
      expect(leftOut).toBe(0);
      expect(candidates).toEqual([
        {
          row: pgo,
          resource: { metadata: { namespace: "team-b", name: "metrics" } },
          uid: "uid-analytics",
          secretName: "metrics-pguser-metrics",
          exact: [],
        },
      ]);
    }
  });

  test("PGO marks a user without databases no_database, before any request", () => {
    for (const user of [{ name: "analyst" }, { name: "analyst", databases: [] }, { name: "analyst", databases: "x" }]) {
      const { candidates } = pgo.expand({ metadata: PGO_METADATA, spec: { users: [user] } });
      expect(candidates).toEqual([
        expect.objectContaining({ secretName: "analytics-pguser-analyst", precheck: "no_database" }),
      ]);
    }
  });

  test("PGO leaves out and counts a user whose name PGO or Studio would refuse", () => {
    const users = [
      { name: "Analyst", databases: ["a"] },
      { name: "ana_lyst", databases: ["a"] },
      { name: "a/b", databases: ["a"] },
      { name: "", databases: ["a"] },
      { name: "a".repeat(64), databases: ["a"] },
      { name: 7, databases: ["a"] },
      null,
      { name: "fine", databases: ["a"] },
    ];
    const { candidates, leftOut } = pgo.expand({ metadata: PGO_METADATA, spec: { users } });
    expect(leftOut).toBe(7);
    expect(candidates.map((entry) => entry.secretName)).toEqual(["analytics-pguser-fine"]);
    expect(pgo.expand({ metadata: PGO_METADATA, spec: { users: "x" } })).toEqual({ candidates: [], leftOut: 1 });
    expect(pgo.expand({ metadata: { namespace: "team-b" } })).toEqual({ candidates: [], leftOut: 1 });
  });

  test("MongoDB gives one candidate per user, its resource pruned to that user, its TLS switch and its Service", () => {
    const { candidates, leftOut } = mongo.expand({
      metadata: MONGO_METADATA,
      spec: {
        members: 3,
        security: {
          tls: { enabled: true, certificateKeySecretRef: { name: "x" } },
          authentication: { modes: ["SCRAM"] },
        },
        statefulSet: { spec: { serviceName: "catalog-hl", replicas: 3 } },
        users: [
          {
            name: "appuser",
            db: "admin",
            passwordSecretRef: { name: "appuser-password" },
            roles: [{ name: "readWrite", db: "catalog" }],
            additionalConnectionStringConfig: { proxyHost: "evil.example.com" },
          },
          { name: "reader", db: "catalog", connectionStringSecretName: "catalog-reader", roles: [] },
        ],
      },
    });
    expect(leftOut).toBe(0);
    const shared = { security: { tls: { enabled: true } }, statefulSet: { spec: { serviceName: "catalog-hl" } } };
    expect<unknown>(candidates).toEqual([
      {
        row: mongo,
        resource: {
          metadata: { namespace: "team-m", name: "catalog" },
          spec: { users: [{ name: "appuser", db: "admin", roles: [{ db: "catalog" }] }], ...shared },
        },
        uid: "uid-catalog",
        secretName: "catalog-admin-appuser",
        exact: [],
      },
      {
        row: mongo,
        resource: {
          metadata: { namespace: "team-m", name: "catalog" },
          spec: {
            users: [{ name: "reader", db: "catalog", connectionStringSecretName: "catalog-reader", roles: [] }],
            ...shared,
          },
        },
        uid: "uid-catalog",
        secretName: "catalog-reader",
        exact: [],
      },
    ]);
    expect(mongo.expand({ metadata: MONGO_METADATA, spec: {} })).toEqual({ candidates: [], leftOut: 0 });
    expect(mongo.expand({ metadata: MONGO_METADATA })).toEqual({ candidates: [], leftOut: 0 });
  });

  test("MongoDB keeps at most 64 roles of a user", () => {
    const roles = Array.from({ length: 70 }, (_, index) => ({ name: "read", db: `db${index}` }));
    const { candidates } = mongo.expand({
      metadata: MONGO_METADATA,
      spec: { users: [{ name: "appuser", db: "admin", roles }] },
    });
    const kept = candidates[0]?.resource.spec?.users?.[0]?.roles;
    expect(kept).toHaveLength(64);
    expect(kept?.[63]).toEqual({ db: "db63" });
  });

  test("MongoDB marks a Secret in another namespace other_namespace, and a name it would have to normalize unsupported_name", () => {
    const user = (extra: Record<string, unknown>) =>
      mongo.expand({
        metadata: MONGO_METADATA,
        spec: { users: [{ name: "appuser", db: "admin", roles: [], ...extra }] },
      }).candidates[0];
    expect(user({ connectionStringSecretNamespace: "team-x" })).toMatchObject({
      secretName: "catalog-admin-appuser",
      precheck: "other_namespace",
    });
    expect(user({ connectionStringSecretNamespace: "team-m" })).not.toHaveProperty("precheck");
    const odd = mongo.expand({
      metadata: MONGO_METADATA,
      spec: { users: [{ name: "App_User", db: "admin", roles: [] }] },
    }).candidates[0];
    expect(odd).toMatchObject({ precheck: "unsupported_name" });
    expect(odd).not.toHaveProperty("secretName");
    // A name the user gave is used as it is, so no normalization is needed.
    expect(
      mongo.expand({
        metadata: MONGO_METADATA,
        spec: { users: [{ name: "App_User", db: "admin", connectionStringSecretName: "catalog-app", roles: [] }] },
      }).candidates[0],
    ).toMatchObject({ secretName: "catalog-app" });
    expect(odd.precheck === "unsupported_name" && odd.resource.spec?.users?.[0]?.name).toBe("App_User");
  });

  test("MongoDB leaves out and counts a user whose name, database, role database or Secret name Studio would refuse", () => {
    const users = [
      { name: "app user", db: "admin", roles: [] },
      { name: "appuser", db: "ad.min", roles: [] },
      { name: "appuser", db: "admin", roles: [{ db: "cat/alog" }] },
      { name: "appuser", db: "admin", roles: "x" },
      { name: "appuser", db: "admin", connectionStringSecretName: "Bad_Name", roles: [] },
      { name: "appuser", db: 7, roles: [] },
      null,
      { name: "fine", roles: [{ db: "catalog" }] },
    ];
    const { candidates, leftOut } = mongo.expand({ metadata: MONGO_METADATA, spec: { users } });
    expect(leftOut).toBe(7);
    expect(candidates.map((entry) => entry.secretName)).toEqual(["catalog-admin-fine"]);
    // A Service name override that is not a DNS-1035 label leaves every user of the resource out.
    expect(
      mongo.expand({
        metadata: MONGO_METADATA,
        spec: { statefulSet: { spec: { serviceName: "Catalog" } }, users: [users[7], users[7]] },
      }),
    ).toEqual({ candidates: [], leftOut: 2 });
    expect(mongo.expand({ metadata: MONGO_METADATA, spec: { users: "x" } })).toEqual({ candidates: [], leftOut: 1 });
  });

  test("scans the prechecked rows with their problem and no Secret request", async () => {
    api.addResource("pgo", "team-a", "analytics", { users: [{ name: "analyst" }] });
    api.addResource("mongo", "team-a", "catalog", {
      users: [
        { name: "App_User", db: "admin", roles: [] },
        { name: "appuser", db: "admin", connectionStringSecretNamespace: "team-x", roles: [] },
      ],
    });
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_KINDS: "pgo,mongo" }) });
    expect(result.databases.map((entry) => [entry.kind, entry.secret])).toEqual([
      ["pgo", { name: "analytics-pguser-analyst", problem: "no_database" }],
      ["mongo", { problem: "unsupported_name" }],
      ["mongo", { name: "catalog-admin-appuser", problem: "other_namespace" }],
    ]);
    expect(api.seen.some((seen) => seen.path.includes("/secrets/") || seen.path.includes("/services/"))).toBe(false);
    const parsed = parseKubernetesDiscoveryExport(
      JSON.stringify(
        buildExport({
          now: T0,
          status: { ok: true },
          generatedAt: new Date(T0).toISOString(),
          namespaces: result.namespaces,
          databases: result.databases,
        }),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.databases).toHaveLength(3);
  });
});

describe("readConfig", () => {
  const minimal = {
    KUBERNETES_DISCOVERY_NAMESPACES: "team-b, team-a,team-b",
    KUBERNETES_DISCOVERY_EXPORT_SECRET: " libredb-studio/libredb-studio-discovery-export ",
  };

  test("reads the minimal configuration, with every default", () => {
    const read = readConfig(minimal);
    expect(read).toMatchObject({
      namespaces: ["team-a", "team-b"],
      exportSecret: { namespace: "libredb-studio", name: "libredb-studio-discovery-export" },
      intervalMs: 30000,
      apiUrl: "https://kubernetes.default.svc",
      tokenPath: DEFAULTS.tokenPath,
      caPath: DEFAULTS.caPath,
      once: false,
    });
    expect(read.kinds.map((row: { slug: string }) => row.slug)).toEqual(["cnpg"]);
  });

  test("reads every setting", () => {
    const read = readConfig({
      ...minimal,
      KUBERNETES_DISCOVERY_KINDS: "cnpg",
      KUBERNETES_DISCOVERY_INTERVAL_MS: "5000",
      KUBERNETES_DISCOVERY_API_URL: "https://10.43.0.1:443/prefix//",
      KUBERNETES_DISCOVERY_TOKEN_PATH: "/t",
      KUBERNETES_DISCOVERY_CA_PATH: "/c",
      KUBERNETES_DISCOVERY_ONCE: "1",
    });
    expect(read).toMatchObject({
      intervalMs: 5000,
      apiUrl: "https://10.43.0.1/prefix",
      tokenPath: "/t",
      caPath: "/c",
      once: true,
    });
  });

  test.each([
    [{}, "KUBERNETES_DISCOVERY_NAMESPACES must name at least one namespace"],
    [{ KUBERNETES_DISCOVERY_NAMESPACES: " , " }, "KUBERNETES_DISCOVERY_NAMESPACES must name at least one namespace"],
    [
      { KUBERNETES_DISCOVERY_NAMESPACES: "team-a,Team_B" },
      'KUBERNETES_DISCOVERY_NAMESPACES names "Team_B", which is not a namespace name: lowercase letters, digits and inner hyphens, at most 63',
    ],
    [
      { KUBERNETES_DISCOVERY_NAMESPACES: Array.from({ length: 257 }, (_, index) => `n${index}`).join(",") },
      "KUBERNETES_DISCOVERY_NAMESPACES names more than 256 namespaces",
    ],
  ])("refuses the namespaces %p", (env, message) => {
    expect(() =>
      readConfig({
        ...minimal,
        ...env,
        ...(Object.keys(env).length === 0 ? { KUBERNETES_DISCOVERY_NAMESPACES: "" } : {}),
      }),
    ).toThrow(message);
  });

  test.each([[""], ["libredb-studio"], ["a/b/c"], ["Bad/x"], ["a/Bad_Name"], [`a/${"x".repeat(254)}`]])(
    "refuses the export Secret %p",
    (value) => {
      expect(() => readConfig({ ...minimal, KUBERNETES_DISCOVERY_EXPORT_SECRET: value })).toThrow(
        "KUBERNETES_DISCOVERY_EXPORT_SECRET must name the export Secret as <namespace>/<name>, such as libredb-studio/libredb-studio-discovery-export",
      );
    },
  );

  test("refuses a kind it does not know, and a kinds list with none", () => {
    expect(() => readConfig({ ...minimal, KUBERNETES_DISCOVERY_KINDS: "cnpg,mariadb" })).toThrow(
      'KUBERNETES_DISCOVERY_KINDS names "mariadb", which is not a supported kind: cnpg, edbpg, pgo, mongo',
    );
    expect(() => readConfig({ ...minimal, KUBERNETES_DISCOVERY_KINDS: " , " })).toThrow(
      "KUBERNETES_DISCOVERY_KINDS must name at least one kind: cnpg, edbpg, pgo, mongo",
    );
  });

  // A kind whose CRD the cluster does not serve withdraws every namespace (crd_missing), so each is opted in.
  test("reads CloudNativePG alone by default, and each opted-in kind in the contract's order", () => {
    const slugs = (value?: string) =>
      readConfig({ ...minimal, ...(value === undefined ? {} : { KUBERNETES_DISCOVERY_KINDS: value }) }).kinds.map(
        (row: { slug: string }) => row.slug,
      );
    expect(slugs()).toEqual(["cnpg"]);
    expect(slugs("  ")).toEqual(["cnpg"]);
    for (const slug of ["cnpg", "edbpg", "pgo", "mongo"]) expect(slugs(slug)).toEqual([slug]);
    expect(slugs("mongo, pgo,edbpg,cnpg")).toEqual(["cnpg", "edbpg", "pgo", "mongo"]);
  });

  test.each([
    ["4999", 'KUBERNETES_DISCOVERY_INTERVAL_MS must be an integer of at least 5000, got "4999"'],
    ["1e4", 'KUBERNETES_DISCOVERY_INTERVAL_MS must be an integer of at least 5000, got "1e4"'],
    ["2147483648", 'KUBERNETES_DISCOVERY_INTERVAL_MS must be an integer of at most 2147483647, got "2147483648"'],
  ])("refuses the interval %p", (value, message) => {
    expect(() => readConfig({ ...minimal, KUBERNETES_DISCOVERY_INTERVAL_MS: value })).toThrow(message);
  });

  test.each([
    ["http://kubernetes.default.svc"],
    ["https://u:p@k8s"],
    ["https://k8s?x=1"],
    ["https://k8s#f"],
    ["not a url"],
  ])("refuses the API URL %p", (value) => {
    expect(() => readConfig({ ...minimal, KUBERNETES_DISCOVERY_API_URL: value })).toThrow(
      "KUBERNETES_DISCOVERY_API_URL must be an https URL without a user name, password, query or fragment, such as https://kubernetes.default.svc",
    );
  });

  test("treats an absent environment as one that names no namespace", () => {
    expect(() => readConfig(undefined)).toThrow("KUBERNETES_DISCOVERY_NAMESPACES must name at least one namespace");
  });
});

describe("the API client", () => {
  test("sends the token it reads for every request, and parses a 2xx answer", async () => {
    const answer = await client().get(EXPORT_PATH);
    expect(answer.kind).toBe("Secret");
    api.setToken(`  ${FAKE_DISCOVERY_TOKEN}-rotated\n`);
    await client().get(EXPORT_PATH);
    expect(api.seen.map((seen) => seen.authorization)).toEqual([
      `Bearer ${FAKE_DISCOVERY_TOKEN}`,
      `Bearer ${FAKE_DISCOVERY_TOKEN}-rotated`,
    ]);
  });

  test("refuses to send anything without a token or a CA certificate", async () => {
    const missing = createApiClient({ apiUrl: api.url, tokenPath: "/nonexistent/token", caPath: api.caPath });
    expect(await rejection(missing.get(EXPORT_PATH))).toMatchObject({
      code: "ETOKEN",
      message: "the token file /nonexistent/token cannot be read",
    });
    api.setToken("   ");
    expect(await rejection(client().get(EXPORT_PATH))).toMatchObject({
      code: "ETOKEN",
      message: `the token file ${api.tokenPath} is empty`,
    });
    api.setToken(FAKE_DISCOVERY_TOKEN);
    api.setCa("not a certificate");
    expect(await rejection(client().get(EXPORT_PATH))).toMatchObject({
      code: "ECA",
      message: `the CA file ${api.caPath} holds no certificate`,
    });
    const noCa = createApiClient({ apiUrl: api.url, tokenPath: api.tokenPath, caPath: "/nonexistent/ca.crt" });
    expect(await rejection(noCa.get(EXPORT_PATH))).toMatchObject({
      code: "ECA",
      message: "the CA file /nonexistent/ca.crt cannot be read",
    });
    expect(api.seen).toHaveLength(0);
  });

  test("refuses an API server whose certificate the CA does not vouch for", async () => {
    api.setCa(api.otherCa);
    const error = await client()
      .get(EXPORT_PATH)
      .catch((caught: unknown) => caught);
    expect(classifyApiError(error)).toMatchObject({ ok: false, code: "api_unreachable" });
  });

  test("rejects a non-2xx answer with its status and the API server's message, never a 2xx body", async () => {
    api.scripted.set(EXPORT_PATH, { status: 500, body: statusBody(500, "InternalError", "etcd is unhappy") });
    expect(await rejection(client().get(EXPORT_PATH))).toMatchObject({
      statusCode: 500,
      message: `GET ${EXPORT_PATH} answered HTTP 500: etcd is unhappy`,
    });
    api.scripted.set(EXPORT_PATH, { status: 502, body: "<html>bad gateway</html>" });
    expect(await rejection(client().get(EXPORT_PATH))).toMatchObject({
      statusCode: 502,
      message: `GET ${EXPORT_PATH} answered HTTP 502`,
    });
    api.scripted.set(EXPORT_PATH, { status: 200, body: `{"password":"${PASSWORD_A}"` });
    const error = (await client()
      .get(EXPORT_PATH)
      .catch((caught: unknown) => caught)) as Error;
    expect(error).toMatchObject({
      code: "EBADJSON",
      message: `GET ${EXPORT_PATH} answered with a body that is not JSON`,
    });
    expect(error.message).not.toContain(PASSWORD_A);
  });

  test("bounds every answer in size and every request in time, and aborts what is in flight", async () => {
    expect(await rejection(client({ maxBytes: 10 }).get(EXPORT_PATH))).toMatchObject({
      code: "ERESPONSETOOLARGE",
      message: `GET ${EXPORT_PATH} answered with more than 10 bytes`,
    });
    api.scripted.set(EXPORT_PATH, "hang");
    expect(await rejection(client({ timeoutMs: 50 }).get(EXPORT_PATH))).toMatchObject({
      code: "ETIMEDOUT",
      message: `the API server did not answer GET ${EXPORT_PATH} within 50 ms`,
    });
    const aborting = client();
    const pending = aborting.get(EXPORT_PATH).catch((caught: unknown) => caught);
    await eventually(() => api.seen.length === 3, "the hanging request");
    aborting.abort();
    expect(await pending).toMatchObject({ code: "EABORTED" });
  });

  test("reaches an API server under a path prefix", async () => {
    const prefixed = createApiClient({
      apiUrl: `${api.url}/k8s/clusters/local`,
      tokenPath: api.tokenPath,
      caPath: api.caPath,
    });
    expect(await rejection(prefixed.get(EXPORT_PATH))).toMatchObject({ statusCode: 404 });
    expect(api.seen[0].path).toBe(`/k8s/clusters/local${EXPORT_PATH}`);
  });

  test("reports a request that cannot be built as a failure, not a throw", async () => {
    const broken = client({
      request: () => {
        throw Object.assign(new Error("no socket"), { code: "EMFILE" });
      },
    });
    expect(await rejection(broken.get(EXPORT_PATH))).toMatchObject({ code: "EMFILE" });
  });
});

describe("classifyApiError", () => {
  test.each([
    [
      { statusCode: 401, message: "m" },
      { ok: false, code: "unauthorized", httpStatus: 401, message: "m" },
    ],
    [
      { statusCode: 500, message: "m" },
      { ok: false, code: "api_error", httpStatus: 500, message: "m" },
    ],
    [
      { code: "ETOKEN", message: "t" },
      { ok: false, code: "credentials_unavailable", message: "t" },
    ],
    [
      { code: "ECA", message: "c" },
      { ok: false, code: "credentials_unavailable", message: "c" },
    ],
    [
      { code: "ERESPONSETOOLARGE", message: "big" },
      { ok: false, code: "limit_exceeded", message: "big" },
    ],
    [
      { code: "EBADJSON", message: "j" },
      { ok: false, code: "api_error", message: "j" },
    ],
    [
      { code: "EBADLIST", message: "l" },
      { ok: false, code: "api_error", message: "l" },
    ],
    [
      { code: "ETIMEDOUT", message: "slow" },
      { ok: false, code: "api_unreachable", message: "slow" },
    ],
    [
      { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:1" },
      { ok: false, code: "api_unreachable", message: "connect ECONNREFUSED 127.0.0.1:1" },
    ],
    [
      { code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: "self-signed certificate" },
      { ok: false, code: "api_unreachable", message: "DEPTH_ZERO_SELF_SIGNED_CERT (self-signed certificate)" },
    ],
    [new Error("plain"), { ok: false, code: "api_unreachable", message: "plain" }],
    [null, { ok: false, code: "api_unreachable", message: "unknown error" }],
  ])("%p is %p", (error, status) => {
    expect(classifyApiError(error)).toEqual(status);
  });

  test("clips a message to 512 characters without ending on half a pair", () => {
    const message = `${"x".repeat(511)}\u{1F600}tail`;
    expect(classifyApiError({ statusCode: 500, message }).message).toBe("x".repeat(511));
    expect(classifyApiError({ statusCode: 500, message: "y".repeat(600) }).message).toHaveLength(512);
  });
});

describe("scanOnce", () => {
  test("lists every opted-in namespace page by page and keeps only the contract's Secret keys", async () => {
    seedLab();
    api.addCluster("team-a", "reports");
    api.addAppSecret("team-a", "reports", {
      username: "app",
      password: "not-a-real-password-reports",
      dbname: "app",
      port: "5432",
    });
    api.pageSize = 1;
    const result = await scan({ client: client(), config: config() });
    expect<unknown>(result).toEqual({
      ok: true,
      namespaces: [
        { name: "team-a", status: { ok: true } },
        { name: "team-b", status: { ok: true } },
      ],
      databases: [
        {
          kind: "cnpg",
          resource: {
            metadata: { namespace: "team-a", name: "orders" },
            spec: { bootstrap: { initdb: { database: "orders" } } },
          },
          secret: {
            name: "orders-app",
            data: { username: "orders", password: PASSWORD_A, dbname: "orders", port: "5432" },
          },
        },
        {
          kind: "cnpg",
          resource: { metadata: { namespace: "team-a", name: "reports" } },
          secret: {
            name: "reports-app",
            data: { username: "app", password: "not-a-real-password-reports", dbname: "app", port: "5432" },
          },
        },
        {
          kind: "cnpg",
          resource: { metadata: { namespace: "team-b", name: "analytics" } },
          secret: {
            name: "analytics-app",
            data: { username: "app", password: PASSWORD_B, dbname: "app", port: "5432" },
          },
        },
      ],
      truncated: false,
      leftOut: 0,
    });
    const lists = api.seen.filter((seen) => seen.path.includes("/clusters"));
    expect(lists.map((seen) => seen.path)).toEqual([
      "/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters?limit=10",
      "/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters?limit=10&continue=1",
      "/apis/postgresql.cnpg.io/v1/namespaces/team-b/clusters?limit=10",
    ]);
    // GET only: the scan never writes, and it never lists Secrets.
    expect(new Set(api.seen.map((seen) => seen.method))).toEqual(new Set(["GET"]));
    expect(api.seen.some((seen) => /\/secrets(\?|$)/.test(seen.path))).toBe(false);
  });

  test("reads a Cluster's own initdb Secret when it names one", async () => {
    api.addCluster("team-a", "billing-db", {
      bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } },
    });
    api.addSecret("team-a", "billing-owner", { username: "billing_owner", password: "not-a-real-password-billing" });
    const result = await scan({ client: client(), config: config() });
    expect(result.databases[0].secret).toEqual({
      name: "billing-owner",
      data: { username: "billing_owner", password: "not-a-real-password-billing" },
    });
  });

  test("withdraws a namespace that answers 403, with the reason, and scans the others", async () => {
    seedLab();
    api.forbiddenNamespaces.add("team-b");
    const result = await scan({ client: client(), config: config() });
    expect(result.ok).toBe(true);
    expect(result.namespaces).toEqual([
      { name: "team-a", status: { ok: true } },
      {
        name: "team-b",
        status: {
          ok: false,
          code: "forbidden",
          httpStatus: 403,
          message:
            "the exporter may not list clusters.postgresql.cnpg.io in team-b (HTTP 403): grant its ServiceAccount list on them there",
        },
      },
    ]);
    expect(
      result.databases.map((entry: { resource: { metadata: { name: string } } }) => entry.resource.metadata.name),
    ).toEqual(["orders"]);
  });

  test("reports a kind the API server does not serve as crd_missing in every namespace", async () => {
    seedLab();
    api.crdMissing = true;
    const result = await scan({ client: client(), config: config() });
    expect(result.ok).toBe(true);
    expect(result.databases).toEqual([]);
    for (const namespace of result.namespaces) {
      expect(namespace.status).toEqual({
        ok: false,
        code: "crd_missing",
        httpStatus: 404,
        message:
          "the API server does not serve clusters.postgresql.cnpg.io (HTTP 404): install the operator, or leave cnpg out of KUBERNETES_DISCOVERY_KINDS",
      });
    }
  });

  test.each([
    [403, "Forbidden", "forbidden"],
    [404, "NotFound", "crd_missing"],
  ] as const)(
    "a %d on a later page withdraws what the namespace's earlier pages found",
    async (code, reason, status) => {
      seedLab();
      api.addCluster("team-a", "reports");
      api.addAppSecret("team-a", "reports", {
        username: "app",
        password: "not-a-real-password-reports",
        dbname: "app",
        port: "5432",
      });
      const [first] = api.clusters.get("team-a") ?? [];
      api.scripted.set("/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters", [
        { status: 200, body: JSON.stringify({ metadata: { continue: "1" }, items: [first] }) },
        { status: code, body: statusBody(code, reason, "refused on page 2") },
      ]);
      const result = await scan({ client: client(), config: config() });
      expect(result.ok).toBe(true);
      expect(result.namespaces.map((namespace) => [namespace.name, namespace.status.code ?? "ok"])).toEqual([
        ["team-a", status],
        ["team-b", "ok"],
      ]);
      expect(result.databases.map((entry) => entry.resource.metadata.name)).toEqual(["analytics"]);
      // A withdrawn namespace's Secrets are not read at all.
      expect(api.seen.some((seen) => seen.path.includes("/namespaces/team-a/secrets/"))).toBe(false);
    },
  );

  // One namespace's editors decide how large its Clusters are, so its list answer being over the bound is an answer
  // about that namespace, like a 403, and never stops the others from being exported.
  test("withdraws a namespace whose list page is over the response bound, and exports the others", async () => {
    seedLab();
    api.addCluster("team-a", "bulky", { description: "x".repeat(8192) });
    const result = await scan({ client: client({ maxBytes: 4096 }), config: config() });
    expect(result.ok).toBe(true);
    expect(result.namespaces).toEqual([
      {
        name: "team-a",
        status: {
          ok: false,
          code: "limit_exceeded",
          message:
            "clusters.postgresql.cnpg.io in team-a are too large to list: GET /apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters answered with more than 4096 bytes",
        },
      },
      { name: "team-b", status: { ok: true } },
    ]);
    expect(result.databases.map((entry) => entry.resource.metadata.name)).toEqual(["analytics"]);
  });

  test("withdraws a namespace whose list does not end within the page bound, and exports the others", async () => {
    seedLab();
    const listPath = "/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters";
    api.scripted.set(
      listPath,
      Array.from({ length: 3 }, () => ({
        status: 200,
        body: JSON.stringify({ items: [], metadata: { continue: "again" } }),
      })),
    );
    const result = await scan({ client: client(), config: config(), limits: limitsWith({ pages: 3 }) });
    expect(result.ok).toBe(true);
    expect(result.namespaces).toEqual([
      {
        name: "team-a",
        status: {
          ok: false,
          code: "limit_exceeded",
          message: `clusters.postgresql.cnpg.io in team-a are too many to list: GET ${listPath} did not end within 3 pages`,
        },
      },
      { name: "team-b", status: { ok: true } },
    ]);
    expect(result.databases.map((entry) => entry.resource.metadata.name)).toEqual(["analytics"]);
  });

  // The production bounds, as one namespace's editors could use them: twelve Clusters of 1.4 MB, each under etcd's
  // default 1.5 MiB, are 16.8 MB, over the 16 MiB response bound in one page, and fit it in pages of ten.
  test("lists a namespace of Clusters near etcd's object bound in pages under the response bound", async () => {
    seedLab();
    for (let index = 0; index < 12; index += 1) {
      api.addCluster("team-a", `bulky-${index}`, { description: "x".repeat(1_400_000) });
    }
    const result = await scan({ client: client(), config: config() });
    expect(result.ok).toBe(true);
    expect(result.namespaces.map((namespace) => namespace.status)).toEqual([{ ok: true }, { ok: true }]);
    expect(result.databases.map((entry) => entry.resource.metadata.name)).toContain("analytics");
    expect(result.databases).toHaveLength(14);
  });

  test("records a missing or forbidden Secret as its problem, and lists the database", async () => {
    api.addCluster("team-a", "orders");
    api.addCluster("team-b", "analytics");
    api.scripted.set("/api/v1/namespaces/team-b/secrets/analytics-app", {
      status: 403,
      body: statusBody(403, "Forbidden", "secrets is forbidden"),
    });
    const result = await scan({ client: client(), config: config() });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "orders-app", problem: "not_found" },
      { name: "analytics-app", problem: "forbidden" },
    ]);
  });

  test("records a kept value over 1024 bytes or not UTF-8 text as invalid_value, naming the key only", async () => {
    api.addCluster("team-a", "orders");
    api.addAppSecret("team-a", "orders", {
      username: "orders",
      password: "p".repeat(1025),
      dbname: "orders",
      port: "5432",
    });
    api.addCluster("team-b", "analytics");
    api.addAppSecret("team-b", "analytics", {
      username: Buffer.from([0xc3, 0x28]),
      password: PASSWORD_B,
      dbname: "app",
      port: "5432",
    });
    const result = await scan({ client: client(), config: config() });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "orders-app", problem: "invalid_value", key: "password" },
      { name: "analytics-app", problem: "invalid_value", key: "username" },
    ]);
  });

  test("names the first required key a Secret lacks, or holds empty or not as text, as missing_key", async () => {
    api.addCluster("team-a", "orders");
    api.addAppSecret("team-a", "orders", {});
    api.addCluster("team-b", "analytics");
    api.scripted.set("/api/v1/namespaces/team-b/secrets/analytics-app", {
      status: 200,
      body: JSON.stringify({
        kind: "Secret",
        type: "kubernetes.io/basic-auth",
        metadata: { labels: { "cnpg.io/cluster": "analytics" } },
        data: { username: 7, password: Buffer.from(PASSWORD_B).toString("base64") },
      }),
    });
    api.addCluster("team-b", "reports");
    api.addAppSecret("team-b", "reports", { username: "app", password: PASSWORD_B, dbname: "app", port: "" });
    const result = await scan({ client: client(), config: config() });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "orders-app", problem: "missing_key", key: "username" },
      { name: "analytics-app", problem: "missing_key", key: "username" },
      { name: "reports-app", problem: "missing_key", key: "port" },
    ]);
  });

  test("leaves out a resource whose names are not Kubernetes names, without asking for its Secret", async () => {
    api.addCluster("team-a", "orders", {
      bootstrap: { initdb: { secret: { name: "../../namespaces/kube-system/secrets/x" } } },
    });
    api.clusters.get("team-a")?.push({ metadata: { namespace: "team-b", name: "elsewhere" } }, { metadata: {} });
    const result = await scan({ client: client(), config: config() });
    expect(result).toMatchObject({ ok: true, databases: [], leftOut: 3 });
    expect(api.seen.some((seen) => seen.path.includes("/secrets/"))).toBe(false);
  });

  // Studio's schema refuses the whole export for one database name over PostgreSQL's 63-byte identifier bound, so the
  // resource is left out here, as an odd service is by the CapRover exporter.
  test("leaves out a Cluster whose initdb database name Studio's schema would refuse, and exports the others", async () => {
    seedLab();
    api.addCluster("team-a", "odd", { bootstrap: { initdb: { database: "d".repeat(64) } } });
    api.addAppSecret("team-a", "odd", {
      username: "u",
      password: "not-a-real-password-odd",
      dbname: "d",
      port: "5432",
    });
    api.addCluster("team-a", "blank", { bootstrap: { initdb: { database: "" } } });
    const result = await scan({ client: client(), config: config() });
    expect(result.leftOut).toBe(2);
    expect(result.databases.map((entry) => entry.resource.metadata.name)).toEqual(["orders", "analytics"]);
    const row = exporterRow("cnpg");
    expect(
      row.expand({
        metadata: { namespace: "a", name: "b" },
        spec: { bootstrap: { initdb: { database: "d".repeat(63) } } },
      }).candidates[0].resource,
    ).toEqual({
      metadata: { namespace: "a", name: "b" },
      spec: { bootstrap: { initdb: { database: "d".repeat(63) } } },
    });
  });

  // The namespaces are read in name order, so cutting in order would let the editors of the first namespace push every
  // later namespace out of the export by creating Clusters.
  test("shares the database bound fairly among the namespaces, and says it cut", async () => {
    seedLab();
    for (const name of ["reports", "billing", "audit"]) {
      api.addCluster("team-a", name);
      api.addAppSecret("team-a", name, { username: "app", password: `not-a-real-password-${name}`, dbname: "app" });
    }
    const result = await scan({ client: client(), config: config(), limits: limitsWith({ databases: 3 }) });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(
      result.databases.map((entry) => `${entry.resource.metadata.namespace}/${entry.resource.metadata.name}`),
    ).toEqual(["team-a/orders", "team-a/reports", "team-b/analytics"]);
    expect(result.namespaces).toEqual([
      { name: "team-a", status: { ok: true } },
      { name: "team-b", status: { ok: true } },
    ]);
    // A database past its namespace's share costs no Secret read.
    expect(api.seen.filter((seen) => seen.path.includes("/secrets/")).map((seen) => seen.path)).toEqual([
      "/api/v1/namespaces/team-a/secrets/orders-app",
      "/api/v1/namespaces/team-a/secrets/reports-app",
      "/api/v1/namespaces/team-b/secrets/analytics-app",
    ]);
  });

  test("stops reading a namespace once it holds more databases than the bound could export from it", async () => {
    for (let index = 0; index < 5; index += 1) api.addCluster("team-a", `db-${index}`);
    api.pageSize = 1;
    const result = await scan({
      client: client(),
      config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }),
      limits: limitsWith({ databases: 2 }),
    });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.databases.map((entry) => entry.resource.metadata.name)).toEqual(["db-0", "db-1"]);
    expect(api.seen.filter((seen) => seen.path.includes("/clusters")).length).toBe(3);
  });

  test("does not report a cut when every namespace fits its share", async () => {
    seedLab();
    const result = await scan({ client: client(), config: config(), limits: limitsWith({ databases: 2 }) });
    expect(result).toMatchObject({ ok: true, truncated: false });
    expect(result.databases).toHaveLength(2);
  });

  test("fails the scan on any other answer: a 401, a 500, a list that is not a list", async () => {
    seedLab();
    const listPath = "/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters";
    api.scripted.set(listPath, { status: 401, body: statusBody(401, "Unauthorized", "Unauthorized") });
    expect<unknown>(await scan({ client: client(), config: config() })).toEqual({
      ok: false,
      status: {
        ok: false,
        code: "unauthorized",
        httpStatus: 401,
        message: `GET ${listPath} answered HTTP 401: Unauthorized`,
      },
    });
    api.scripted.set(listPath, { status: 500, body: statusBody(500, "InternalError", "boom") });
    expect((await scan({ client: client(), config: config() })).status).toMatchObject({
      code: "api_error",
      httpStatus: 500,
    });
    api.scripted.set(listPath, { status: 200, body: JSON.stringify({ items: "no" }) });
    expect((await scan({ client: client(), config: config() })).status).toEqual({
      ok: false,
      code: "api_error",
      message: `GET ${listPath} answered with something other than a list`,
    });
    api.scripted.set("/api/v1/namespaces/team-a/secrets/orders-app", { status: 500, body: statusBody(500, "x", "y") });
    api.scripted.delete(listPath);
    expect((await scan({ client: client(), config: config() })).status).toMatchObject({
      code: "api_error",
      httpStatus: 500,
    });
  });

  test("fails the scan when the API server cannot be reached", async () => {
    const port = await closedPort();
    const result = await scan({
      client: createApiClient({ apiUrl: `https://127.0.0.1:${port}`, tokenPath: api.tokenPath, caPath: api.caPath }),
      config: config(),
    });
    expect(result).toMatchObject({ ok: false, status: { code: "api_unreachable" } });
    expect(result.status.message).toContain("ECONNREFUSED");
  });
});

/*
 * A namespace editor can point a Cluster at any Secret of its namespace, and the exporter may get every one of them,
 * while the Cluster's own read-write Service decides where Studio sends the credentials. So a Secret is exported only
 * when it belongs to the resource: the <name>-app Secret by an ownerReference to the Cluster's UID or CloudNativePG's
 * cnpg.io/cluster label, and an initdb Secret the same way, or by the kubernetes.io/basic-auth type CloudNativePG
 * itself requires when it is tied to no resource at all.
 */
describe("Secret ownership", () => {
  const DATA = { username: "u", password: "not-a-real-password-unowned", dbname: "d", port: "5432" };

  test("exports a <name>-app Secret the Cluster owns by UID or labels with its name, and no other", async () => {
    api.addCluster("team-a", "owned");
    api.addAppSecret("team-a", "owned", DATA, { label: false });
    api.addCluster("team-a", "labelled");
    api.addAppSecret("team-a", "labelled", DATA, { owner: false });
    api.addCluster("team-a", "foreign");
    api.addSecret("team-a", "foreign-app", DATA);
    api.addCluster("team-a", "other");
    api.addSecret("team-a", "other-app", DATA, "kubernetes.io/basic-auth", {
      ownerReferences: [{ apiVersion: "postgresql.cnpg.io/v1", kind: "Cluster", name: "other", uid: "uid-a-twin" }],
      labels: { "cnpg.io/cluster": "not-other" },
    });
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "owned-app", data: DATA },
      { name: "labelled-app", data: DATA },
      { name: "foreign-app", problem: "not_owned" },
      { name: "other-app", problem: "not_owned" },
    ]);
  });

  // Another Cluster's <name>-app Secret is kubernetes.io/basic-auth too, so the type alone would let Cluster B name
  // Cluster A's credentials and have them sent to B's read-write Service.
  test("refuses an initdb Secret that belongs to another Cluster, by its owner or its label", async () => {
    api.addCluster("team-a", "alpha");
    api.addAppSecret("team-a", "alpha", DATA);
    api.addSecret("team-a", "alpha-labelled", DATA, "kubernetes.io/basic-auth", {
      labels: { "cnpg.io/cluster": "alpha" },
    });
    api.addSecret("team-a", "operator-owned", DATA, "kubernetes.io/basic-auth", {
      ownerReferences: [
        { apiVersion: "external-secrets.io/v1", kind: "ExternalSecret", name: "x", uid: "uid-external" },
      ],
    });
    for (const [cluster, secret] of [
      ["beta", "alpha-app"],
      ["gamma", "alpha-labelled"],
      ["delta", "operator-owned"],
    ] as const) {
      api.addCluster("team-a", cluster, { bootstrap: { initdb: { secret: { name: secret } } } });
    }
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(
      result.databases.map((entry: { resource: { metadata: { name: string } }; secret: unknown }) => [
        entry.resource.metadata.name,
        entry.secret,
      ]),
    ).toEqual([
      ["alpha", { name: "alpha-app", data: DATA }],
      ["beta", { name: "alpha-app", problem: "not_owned" }],
      ["gamma", { name: "alpha-labelled", problem: "not_owned" }],
      ["delta", { name: "operator-owned", problem: "not_owned" }],
    ]);
  });

  test("keeps a plain basic-auth initdb Secret with no owner and no label, and refuses one of another type", async () => {
    api.addCluster("team-a", "custom", { bootstrap: { initdb: { secret: { name: "custom-owner" } } } });
    api.addSecret("team-a", "custom-owner", DATA);
    api.addCluster("team-a", "opaque", { bootstrap: { initdb: { secret: { name: "app-settings" } } } });
    api.addSecret("team-a", "app-settings", DATA, "Opaque");
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "custom-owner", data: DATA },
      { name: "app-settings", problem: "wrong_type" },
    ]);
  });

  // CloudNativePG requires a basic-auth initdb Secret, so an Opaque one is not the operator's input, owned or not.
  test("refuses an initdb Secret this Cluster owns or labels when it is not of type kubernetes.io/basic-auth", async () => {
    api.addCluster("team-a", "mine", { bootstrap: { initdb: { secret: { name: "mine-owner" } } } });
    api.addSecret("team-a", "mine-owner", DATA, "Opaque", { labels: { "cnpg.io/cluster": "mine" } });
    api.addCluster("team-a", "held", { bootstrap: { initdb: { secret: { name: "held-owner" } } } });
    api.addSecret("team-a", "held-owner", DATA, "Opaque", {
      ownerReferences: [{ apiVersion: "postgresql.cnpg.io/v1", kind: "Cluster", name: "held", uid: "uid-team-a-held" }],
    });
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "mine-owner", problem: "wrong_type" },
      { name: "held-owner", problem: "wrong_type" },
    ]);
  });

  test("the Secret Studio's review asks about is the Secret the exporter read", async () => {
    api.addCluster("team-a", "billing-db", {
      bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } },
    });
    api.addSecret("team-a", "billing-owner", DATA);
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    const secretReads = api.seen.filter((seen) => seen.path.includes("/secrets/")).map((seen) => seen.path);
    expect(secretReads).toEqual(["/api/v1/namespaces/team-a/secrets/billing-owner"]);
    const mapped = mapKubernetesDatabase(result.databases[0]);
    if (!mapped.ok) throw new Error(mapped.reason);
    expect(mapped.secret).toEqual({ namespace: "team-a", name: "billing-owner" });
  });

  test("writes and logs no value of a Secret it did not export", async () => {
    api.addCluster("team-a", "foreign");
    api.addSecret("team-a", "foreign-app", DATA);
    const out = logs();
    expect(
      await main({
        env: api.env({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }),
        now: () => T0,
        stdout: out.stdout,
        stderr: out.stderr,
      }),
    ).toBe(0);
    expect(JSON.stringify(api.writtenExport())).not.toContain(DATA.password);
    expect(JSON.stringify(api.writtenExport())).toContain("not_owned");
    expect(out.all()).not.toContain(DATA.password);
  });
});

describe("reserved names", () => {
  const SUFFIXES = [
    "-ca",
    "-server",
    "-replication",
    "-superuser",
    "-cluster-cert",
    "-replication-cert",
    "-certs",
    "-pgbackrest",
    "-pgbouncer",
    "-keyfile",
    "-agent-password",
    "-config",
    "-scram-credentials",
    "-ca-certificate",
    "-server-certificate-key",
    "-prometheus-certificate-key",
  ];

  test("the reserved suffixes and names, and the rule that applies them", () => {
    expect([...RESERVED_SECRET_SUFFIXES]).toEqual(SUFFIXES);
    expect([...RESERVED_SECRET_NAMES]).toEqual(["pgo-root-cacert"]);
    expect(Object.isFrozen(RESERVED_SECRET_SUFFIXES) && Object.isFrozen(RESERVED_SECRET_NAMES)).toBe(true);
    for (const suffix of SUFFIXES) expect(isReservedSecretName(`orders${suffix}`, [])).toBe(true);
    expect(isReservedSecretName("pgo-root-cacert", [])).toBe(true);
    expect(isReservedSecretName("my-root", ["my-root"])).toBe(true);
    for (const name of [
      "orders-app",
      "billing-owner",
      "analytics-pguser-analyst",
      "catalog-admin-appuser",
      "ca",
      "orders-cax",
    ]) {
      expect(isReservedSecretName(name, ["my-root"])).toBe(false);
    }
  });

  /** Scans team-a and returns its rows' Secret entries; asserts that no Service and no Secret was requested. */
  async function scanWithoutRequests(kinds = "cnpg") {
    const result = await scan({
      client: client(),
      config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a", KUBERNETES_DISCOVERY_KINDS: kinds }),
    });
    expect(api.seen.some((seen) => seen.path.includes("/secrets/") || seen.path.includes("/services/"))).toBe(false);
    return result.databases.map((entry) => entry.secret);
  }

  test("each suffix refuses a supplied initdb Secret as reserved_name, with no request", async () => {
    for (const suffix of SUFFIXES) {
      api.addCluster("team-a", `db${SUFFIXES.indexOf(suffix)}`, {
        bootstrap: { initdb: { secret: { name: `x${suffix}` } } },
      });
      api.addSecret("team-a", `x${suffix}`, { username: "u", password: "not-a-real-password-x" });
    }
    expect(await scanWithoutRequests()).toEqual(
      SUFFIXES.map((suffix) => ({ name: `x${suffix}`, problem: "reserved_name" })),
    );
  });

  test("each exact rule refuses: the Cluster's own, its spec-named certificates and superuser, and pgo-root-cacert", async () => {
    const named = {
      certificates: {
        serverCASecret: "named-1",
        serverTLSSecret: "named-2",
        replicationTLSSecret: "named-3",
        clientCASecret: "named-4",
      },
      superuserSecret: { name: "named-5" },
    };
    const supplied = ["named-1", "named-2", "named-3", "named-4", "named-5", "pgo-root-cacert"];
    for (const [index, name] of supplied.entries()) {
      api.addCluster("team-a", `db-${index}`, { ...named, bootstrap: { initdb: { secret: { name } } } });
    }
    for (const kind of ["cnpg", "edbpg"]) {
      api.addResource(kind, "team-a", "own", { bootstrap: { initdb: { secret: { name: "own-superuser" } } } });
    }
    const expected = supplied.map((name) => ({ name, problem: "reserved_name" }));
    expect<unknown>(await scanWithoutRequests("cnpg,edbpg")).toEqual([
      ...expected,
      { name: "own-superuser", problem: "reserved_name" },
      { name: "own-superuser", problem: "reserved_name" },
    ]);
  });

  test("a PGO user or a MongoDB user and database that would name another resource's key Secret are refused", async () => {
    api.addResource("pgo", "team-a", "a", { users: [{ name: "b-cluster-cert", databases: ["a"] }] });
    api.addResource("mongo", "team-a", "catalog", {
      users: [
        { name: "password", db: "agent", roles: [] },
        { name: "appuser", db: "admin", connectionStringSecretName: "pgo-root-cacert", roles: [] },
        { name: "keyfile", db: "x", roles: [] },
      ],
    });
    expect(await scanWithoutRequests("pgo,mongo")).toEqual([
      { name: "a-pguser-b-cluster-cert", problem: "reserved_name" },
      { name: "catalog-agent-password", problem: "reserved_name" },
      { name: "pgo-root-cacert", problem: "reserved_name" },
      { name: "catalog-x-keyfile", problem: "reserved_name" },
    ]);
  });
});

describe("the Service check", () => {
  const DATA = { username: "orders", password: PASSWORD_A, dbname: "orders", port: "5432" };
  const SERVICE_PATH = "/api/v1/namespaces/team-a/services/orders-rw";

  /** The Cluster orders in team-a with its <name>-app Secret, and the read-write Service `shape` describes. */
  function ordersWith(shape: ServiceShape | null) {
    api.addCluster("team-a", "orders", {}, { service: false });
    api.addAppSecret("team-a", "orders", DATA);
    const resource = api.addResource("cnpg", "team-a", "orders");
    if (shape !== null) api.addService("team-a", "orders-rw", shape);
    return resource;
  }

  async function ordersSecret() {
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    if (!result.ok) throw new Error(result.status.message);
    return result.databases[0].secret;
  }

  const secretRequests = () => api.seen.filter((seen) => seen.path.includes("/secrets/")).length;

  test("passes a Service with a selector, and reads the Secret after it", async () => {
    ordersWith({ selector: { "cnpg.io/cluster": "orders" } });
    expect(await ordersSecret()).toEqual({ name: "orders-app", data: DATA });
    const paths = api.seen.map((seen) => seen.path);
    expect(paths.indexOf(SERVICE_PATH)).toBeLessThan(paths.indexOf("/api/v1/namespaces/team-a/secrets/orders-app"));
  });

  test("passes a selector-less Service controlled by the row's resource, as PGO's primary Service is", async () => {
    const resource = ordersWith(null);
    api.addService("team-a", "orders-rw", { selector: null, owners: [ownerReference(resource)] });
    expect(await ordersSecret()).toEqual({ name: "orders-app", data: DATA });
  });

  test("refuses an ExternalName Service, whatever else it holds", async () => {
    const resource = ordersWith(null);
    api.addService("team-a", "orders-rw", {
      type: "ExternalName",
      selector: { "cnpg.io/cluster": "orders" },
      owners: [ownerReference(resource)],
    });
    expect(await ordersSecret()).toEqual({ name: "orders-app", problem: "service_external_name" });
    expect(secretRequests()).toBe(0);
  });

  test.each([
    ["no owner", () => []],
    ["another uid", (r: Record<string, unknown>) => [{ ...r, uid: "uid-team-a-other" }]],
    ["another kind", (r: Record<string, unknown>) => [{ ...r, kind: "Pooler" }]],
    ["another group", (r: Record<string, unknown>) => [{ ...r, apiVersion: "postgresql.k8s.enterprisedb.io/v1" }]],
    ["controller false", (r: Record<string, unknown>) => [{ ...r, controller: false }]],
    ["controller absent", (r: Record<string, unknown>) => [{ ...r, controller: undefined }]],
  ])("refuses a selector-less Service with %s", async (_, owners) => {
    const resource = ordersWith(null);
    api.addService("team-a", "orders-rw", { selector: null, owners: owners(ownerReference(resource)) });
    expect(await ordersSecret()).toEqual({ name: "orders-app", problem: "service_not_controlled" });
    // An empty selector selects nothing, as no selector does.
    api.addService("team-a", "orders-rw", { selector: {}, owners: owners(ownerReference(resource)) });
    expect(await ordersSecret()).toEqual({ name: "orders-app", problem: "service_not_controlled" });
    expect(secretRequests()).toBe(0);
  });

  test("refuses a Service name that is not a DNS-1035 label as service_invalid_name, with no request", async () => {
    const name = "a".repeat(61);
    api.addCluster("team-a", name, {}, { service: false });
    api.addCluster("team-a", "9lives", {}, { service: false });
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(result.databases.map((entry) => entry.secret)).toEqual([
      { name: `${name}-app`, problem: "service_invalid_name" },
      { name: "9lives-app", problem: "service_invalid_name" },
    ]);
    expect(api.seen.some((seen) => seen.path.includes("/services/") || seen.path.includes("/secrets/"))).toBe(false);
  });

  test("refuses a Service it may not get as service_forbidden, and one that does not exist as service_not_found", async () => {
    ordersWith(null);
    api.scripted.set(SERVICE_PATH, { status: 403, body: statusBody(403, "Forbidden", "services is forbidden") });
    expect(await ordersSecret()).toEqual({ name: "orders-app", problem: "service_forbidden" });
    api.scripted.clear();
    expect(await ordersSecret()).toEqual({ name: "orders-app", problem: "service_not_found" });
    expect(secretRequests()).toBe(0);
  });

  test("fails the scan on any other answer to a Service GET, and the exporter keeps its last good export", async () => {
    ordersWith({ selector: { "cnpg.io/cluster": "orders" } });
    const exporter = createExporter({
      config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }),
      client: client(),
      now: () => T0,
      info: () => {},
      warn: () => {},
    });
    expect(await exporter.scanAndWrite()).toBe(true);
    const good = api.writtenExport() as { databases: unknown[] };
    api.scripted.set(SERVICE_PATH, { status: 500, body: statusBody(500, "InternalError", "etcd is sad") });
    const before = secretRequests();
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(result).toMatchObject({ ok: false, status: { code: "api_error", httpStatus: 500 } });
    expect(await exporter.scanAndWrite()).toBe(true);
    expect((api.writtenExport() as { databases: unknown[]; status: { ok: boolean } }).databases).toEqual(
      good.databases,
    );
    expect((api.writtenExport() as { status: { ok: boolean } }).status.ok).toBe(false);
    expect(secretRequests() - before).toBe(2);
  });

  test("gets each Service once per scan, for every user of one resource", async () => {
    const resource = api.addResource("pgo", "team-a", "analytics", {
      users: [
        { name: "analyst", databases: ["analytics"] },
        { name: "reporter", databases: ["analytics"] },
      ],
    });
    api.addService("team-a", "analytics-primary", { selector: null, owners: [ownerReference(resource)] });
    for (const user of ["analyst", "reporter"]) {
      api.addSecret(
        "team-a",
        `analytics-pguser-${user}`,
        { user, password: PASSWORD_B, host: "analytics-primary.team-a.svc", port: "5432", dbname: "analytics" },
        "Opaque",
        { ownerReferences: [ownerReference(resource)] },
      );
    }
    const result = await scan({
      client: client(),
      config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a", KUBERNETES_DISCOVERY_KINDS: "pgo" }),
    });
    expect(result.databases.map((entry) => entry.secret.name)).toEqual([
      "analytics-pguser-analyst",
      "analytics-pguser-reporter",
    ]);
    expect(result.databases.every((entry) => entry.secret.data !== undefined)).toBe(true);
    expect(
      api.seen.filter((seen) => seen.path === "/api/v1/namespaces/team-a/services/analytics-primary"),
    ).toHaveLength(1);
  });

  test("serviceProblem: the rule itself", () => {
    const row = exporterRow("cnpg");
    const owner = { apiVersion: "postgresql.cnpg.io/v1", kind: "Cluster", name: "orders", uid: "u", controller: true };
    const service = (spec: Record<string, unknown>, owners?: unknown) => ({
      metadata: { name: "orders-rw", ...(owners === undefined ? {} : { ownerReferences: owners }) },
      spec,
    });
    expect(serviceProblem(service({ type: "ClusterIP", selector: { a: "b" } }), row, "u")).toBeNull();
    expect(serviceProblem(service({ type: "ClusterIP" }, [owner]), row, "u")).toBeNull();
    expect(serviceProblem(service({ type: "ExternalName", selector: { a: "b" } }, [owner]), row, "u")).toBe(
      "service_external_name",
    );
    expect(serviceProblem(service({ type: "ClusterIP" }, [owner]), row, undefined)).toBe("service_not_controlled");
    expect(serviceProblem(service({ type: "ClusterIP" }, "x"), row, "u")).toBe("service_not_controlled");
    expect(serviceProblem(service({ type: "ClusterIP" }, [{ ...owner, apiVersion: "v1" }]), row, "u")).toBe(
      "service_not_controlled",
    );
    expect(serviceProblem({}, row, "u")).toBe("service_not_controlled");
  });
});

describe("Secret checks per kind", () => {
  const caseOf = (slug: string, user?: string) =>
    GOLDEN_CASES.find((c) => goldenRow(c).slug === slug && (user === undefined || c.user === user)) as GoldenCase;

  /** Scans the golden case of `slug` alone, after `change` edits its stored Secret, and returns its Secret entry. */
  async function goldenSecret(
    slug: string,
    change: (secret: { type?: string; metadata: Record<string, unknown>; data?: Record<string, string> }) => void,
    user?: string,
  ) {
    const c = caseOf(slug, user);
    api.addGoldenCase(c);
    const { namespace } = c.resource.metadata;
    change(api.secrets.get(`${namespace}/${c.secretName}`) as never);
    const result = await scan({
      client: client(),
      config: config({ KUBERNETES_DISCOVERY_NAMESPACES: namespace, KUBERNETES_DISCOVERY_KINDS: slug }),
    });
    if (!result.ok) throw new Error(result.status.message);
    const entry = result.databases.find((database) => database.secret.name === c.secretName);
    return entry?.secret;
  }

  const encoded = (value: string) => Buffer.from(value).toString("base64");

  test.each([["cnpg"], ["edbpg"], ["pgo"], ["mongo"]])("exports the golden %s Secret's kept keys", async (slug) => {
    const c = caseOf(slug);
    expect(await goldenSecret(slug, () => {})).toEqual({ name: c.secretName, data: goldenEntry(c).secret.data });
  });

  const OTHER_TYPES = ["kubernetes.io/basic-auth", "Opaque", undefined, "kubernetes.io/tls"];
  test.each(
    ["cnpg", "edbpg", "pgo", "mongo"].flatMap((slug) =>
      OTHER_TYPES.filter((type) => type !== caseOf(slug).secretType).map((type) => [slug, String(type), type] as const),
    ),
  )("refuses a %s Secret of type %s as wrong_type", async (slug, _, type) => {
    expect(
      await goldenSecret(slug, (secret) => {
        secret.type = type;
      }),
    ).toEqual({ name: caseOf(slug).secretName, problem: "wrong_type" });
  });

  test("ties each kind's Secret to its resource by that kind's own rule", async () => {
    const untie =
      (labels?: Record<string, string>, owners?: unknown[]) => (secret: { metadata: Record<string, unknown> }) => {
        delete secret.metadata.labels;
        delete secret.metadata.ownerReferences;
        if (labels !== undefined) secret.metadata.labels = labels;
        if (owners !== undefined) secret.metadata.ownerReferences = owners;
      };
    expect(await goldenSecret("edbpg", untie({ "k8s.enterprisedb.io/cluster": "ledger" }))).toMatchObject({ data: {} });
    api.reset();
    expect(await goldenSecret("edbpg", untie({ "cnpg.io/cluster": "ledger" }))).toEqual({
      name: "ledger-app",
      problem: "not_owned",
    });
    api.reset();
    expect(await goldenSecret("cnpg", untie({ "k8s.enterprisedb.io/cluster": "orders" }))).toEqual({
      name: "orders-app",
      problem: "not_owned",
    });
  });

  test.each(
    ["pgo", "mongo"].flatMap((slug) =>
      [
        [
          "its cluster label",
          { "postgres-operator.crunchydata.com/cluster": caseOf(slug).resource.metadata.name },
          undefined,
        ],
        [
          "another resource's ownerReference",
          undefined,
          [{ apiVersion: "v1", kind: "X", name: "x", uid: "uid-x", controller: true }],
        ],
        ["no tie", undefined, undefined],
      ].map(([how, labels, owners]) => [slug, how, labels, owners] as const),
    ),
  )("refuses a %s Secret tied by %s only, as not_owned: the uid decides", async (slug, _, labels, owners) => {
    const secret = await goldenSecret(slug, (stored) => {
      delete stored.metadata.labels;
      delete stored.metadata.ownerReferences;
      if (labels !== undefined) stored.metadata.labels = labels;
      if (owners !== undefined) stored.metadata.ownerReferences = owners;
    });
    expect(secret).toEqual({ name: caseOf(slug).secretName, problem: "not_owned" });
  });

  test.each([["cnpg"], ["edbpg"], ["pgo"], ["mongo"]])(
    "discards a %s Secret holding a key outside its row's measured set, whole, without naming the key",
    async (slug) => {
      const odd = "tls.key-not-in-any-contract";
      const secret = await goldenSecret(slug, (stored) => {
        (stored.data as Record<string, string>)[odd] = encoded("not-a-real-private-key");
      });
      expect(secret).toEqual({ name: caseOf(slug).secretName, problem: "unexpected_key" });
      expect(JSON.stringify(secret)).not.toContain(odd);
    },
  );

  test("allows PGO's PgBouncer keys, which it measured, and never keeps them", async () => {
    const pgbouncer = await goldenSecret("pgo", (stored) => {
      (stored.data as Record<string, string>)["pgbouncer-host"] = encoded("analytics-pgbouncer.team-b.svc");
    });
    expect(Object.keys(pgbouncer?.data ?? {}).sort()).toEqual(["dbname", "host", "password", "port", "user"]);
  });

  test("names a missing required key of each kind", async () => {
    const drop = (key: string) => (stored: { data?: Record<string, string> }) => {
      delete (stored.data as Record<string, string>)[key];
    };
    expect(await goldenSecret("pgo", drop("dbname"))).toEqual({
      name: "analytics-pguser-analyst",
      problem: "missing_key",
      key: "dbname",
    });
    api.reset();
    expect(await goldenSecret("mongo", drop("connectionString.standard"))).toEqual({
      name: "catalog-admin-appuser",
      problem: "missing_key",
      key: "connectionString.standard",
    });
    api.reset();
    const billing = GOLDEN_CASES.find((c) => c.secretName === "billing-owner") as GoldenCase;
    api.addGoldenCase(billing);
    drop("password")(api.secrets.get("prod/billing-owner") as never);
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "prod" }) });
    expect(result.databases[0].secret).toEqual({ name: "billing-owner", problem: "missing_key", key: "password" });
  });

  test("names a kept value over the bound or not UTF-8 text as invalid_value", async () => {
    expect(
      await goldenSecret("pgo", (stored) => {
        (stored.data as Record<string, string>).password = encoded("p".repeat(LIMITS.valueBytes + 1));
      }),
    ).toEqual({ name: "analytics-pguser-analyst", problem: "invalid_value", key: "password" });
    api.reset();
    expect(
      await goldenSecret("mongo", (stored) => {
        (stored.data as Record<string, string>)["connectionString.standard"] = Buffer.from([0xc3, 0x28]).toString(
          "base64",
        );
      }),
    ).toEqual({ name: "catalog-admin-appuser", problem: "invalid_value", key: "connectionString.standard" });
  });

  test("no request outside the contract names on the golden namespace, <name>-cluster-cert and pgo-root-cacert among them", async () => {
    for (const c of GOLDEN_CASES.filter((x) => ["team-b", "team-m"].includes(x.resource.metadata.namespace))) {
      api.addGoldenCase(c);
    }
    const bystanders = [
      ["team-b", "analytics-ca"],
      ["team-b", "analytics-replication"],
      ["team-b", "analytics-server"],
      ["team-b", "analytics-superuser"],
      ["team-b", "analytics-cluster-cert"],
      ["team-b", "analytics-replication-cert"],
      ["team-b", "analytics-instance1-rvh7-certs"],
      ["team-b", "analytics-pgbackrest"],
      ["team-b", "pgo-root-cacert"],
      ["team-m", "catalog-keyfile"],
      ["team-m", "catalog-agent-password"],
      ["team-m", "catalog-config"],
      ["team-m", "appuser-scram-scram-credentials"],
      ["team-m", "appuser-password"],
    ];
    for (const [namespace, name] of bystanders)
      api.addSecret(namespace, name, { "tls.key": "not-a-real-private-key" }, "Opaque");
    const result = await scan({
      client: client(),
      config: config({
        KUBERNETES_DISCOVERY_NAMESPACES: "team-b,team-m",
        KUBERNETES_DISCOVERY_KINDS: "cnpg,pgo,mongo",
      }),
    });
    expect(result.databases.every((entry) => entry.secret.data !== undefined)).toBe(true);
    const secretPaths = api.seen.map((seen) => seen.path).filter((path) => path.includes("/secrets"));
    expect(secretPaths.sort()).toEqual(
      [
        "/api/v1/namespaces/team-b/secrets/analytics-app",
        "/api/v1/namespaces/team-b/secrets/analytics-pguser-analyst",
        "/api/v1/namespaces/team-b/secrets/analytics-pguser-reporter",
        "/api/v1/namespaces/team-b/secrets/metrics-pguser-metrics",
        "/api/v1/namespaces/team-m/secrets/catalog-admin-appuser",
      ].sort(),
    );
    // It never lists or watches Secrets or Services.
    for (const seen of api.seen) {
      expect(seen.method).toBe("GET");
      expect(seen.path).not.toMatch(/\/(secrets|services)(\?|$)/);
      expect(seen.path).not.toContain("watch");
    }
  });

  test("never writes a Secret value or the token to a log line or the export, over every problem path", async () => {
    const values: string[] = [];
    const add = (name: string, data: Record<string, string>, type: string, metadata: Record<string, unknown>) => {
      values.push(...Object.values(data));
      api.addSecret("team-a", name, data, type, metadata);
    };
    const owned = (name: string) => ({
      ownerReferences: [{ uid: `uid-team-a-${name}` }],
      labels: { "cnpg.io/cluster": name },
    });
    const app = (name: string) => ({
      username: `user-${name}`,
      password: `not-a-real-password-${name}`,
      dbname: "d",
      port: "5432",
    });
    api.addCluster("team-a", "typed");
    add("typed-app", app("typed"), "Opaque", owned("typed"));
    api.addCluster("team-a", "foreign");
    add("foreign-app", app("foreign"), "kubernetes.io/basic-auth", {});
    api.addCluster("team-a", "extra");
    add(
      "extra-app",
      { ...app("extra"), "tls.key": "not-a-real-private-key-extra" },
      "kubernetes.io/basic-auth",
      owned("extra"),
    );
    api.addCluster("team-a", "short");
    add("short-app", { password: "not-a-real-password-short" }, "kubernetes.io/basic-auth", owned("short"));
    api.addCluster("team-a", "long");
    add(
      "long-app",
      { ...app("long"), password: `not-a-real-password-long-${"x".repeat(LIMITS.valueBytes)}` },
      "kubernetes.io/basic-auth",
      owned("long"),
    );
    api.addCluster("team-a", "alias", {}, { service: false });
    api.addService("team-a", "alias-rw", { type: "ExternalName" });
    add("alias-app", app("alias"), "kubernetes.io/basic-auth", owned("alias"));
    api.addCluster("team-a", "reserved", { bootstrap: { initdb: { secret: { name: "reserved-superuser" } } } });
    add("reserved-superuser", app("reserved"), "kubernetes.io/basic-auth", {});
    const output = logs();
    expect(
      await main({
        env: api.env({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }),
        now: () => T0,
        stdout: output.stdout,
        stderr: output.stderr,
      }),
    ).toBe(0);
    const written = JSON.stringify(api.writtenExport());
    const problems = (api.writtenExport() as { databases: { secret: { problem?: string } }[] }).databases.map(
      (entry) => entry.secret.problem,
    );
    expect(problems).toEqual([
      "wrong_type",
      "not_owned",
      "unexpected_key",
      "missing_key",
      "invalid_value",
      "service_external_name",
      "reserved_name",
    ]);
    // The user names and passwords are distinct; the database name and port are not values worth hiding.
    for (const value of values.filter((text) => text.startsWith("not-a-real") || text.startsWith("user-"))) {
      expect(written).not.toContain(value);
      expect(output.all()).not.toContain(value);
    }
    expect(written).not.toContain("tls.key");
    expect(output.all()).not.toContain("tls.key");
    expect(written).not.toContain(FAKE_DISCOVERY_TOKEN);
    expect(output.all()).not.toContain(FAKE_DISCOVERY_TOKEN);
    // The token travels in the Authorization header of every request, and nowhere else.
    for (const seen of api.seen) {
      expect(seen.authorization).toBe(`Bearer ${FAKE_DISCOVERY_TOKEN}`);
      expect(seen.path).not.toContain(FAKE_DISCOVERY_TOKEN);
      expect(JSON.stringify(seen.body ?? null)).not.toContain(FAKE_DISCOVERY_TOKEN);
    }
  });
});

describe("buildExport and serializeExport", () => {
  const status = { ok: true };
  const namespaces = [{ name: "team-a", status: { ok: true } }];

  test("writes the last good scan with this attempt's status and time", () => {
    const data = buildExport({ now: T0, status, generatedAt: "2026-10-28T07:59:00.000Z", namespaces, databases: [] });
    expect(data).toEqual({
      version: 2,
      platform: "kubernetes",
      generatedAt: "2026-10-28T07:59:00.000Z",
      checkedAt: new Date(T0).toISOString(),
      status: { ok: true },
      namespaces,
      databases: [],
    });
  });

  test("before the first successful scan, exports no namespace and no database", () => {
    const data = buildExport({
      now: T0,
      status: { ok: false, code: "api_error", httpStatus: 500, message: "m" },
      generatedAt: null,
      namespaces,
      databases: [{}],
    });
    expect(data).toMatchObject({ generatedAt: null, namespaces: [], databases: [], status: { httpStatus: 500 } });
  });

  test("keeps an export under the bound whole, and cuts the databases of one over it, in order", () => {
    const database = (index: number) => ({
      kind: "cnpg",
      resource: { metadata: { namespace: "team-a", name: `db-${index}` } },
      secret: { name: `db-${index}-app`, data: { password: "x".repeat(1000) } },
    });
    const data = buildExport({ now: T0, status, generatedAt: null, namespaces, databases: [] });
    const whole = { ...data, generatedAt: new Date(T0).toISOString(), databases: [database(0), database(1)] };
    expect(JSON.parse(serializeExport(whole))).toEqual(whole);
    const size = Buffer.byteLength(JSON.stringify({ ...whole, databases: [database(0)] }));
    const cut = JSON.parse(serializeExport(whole, limitsWith({ exportBytes: size + 500 })));
    expect(cut.databases).toEqual([database(0)]);
    expect(cut.status).toEqual({
      ok: false,
      code: "limit_exceeded",
      message: `the export would exceed ${size + 500} bytes; each namespace kept a fair share and the rest was left out`,
    });
    const failing = { ...whole, status: { ok: false, code: "api_error", message: "m" } };
    expect(JSON.parse(serializeExport(failing, limitsWith({ exportBytes: size + 500 }))).status).toEqual(
      failing.status,
    );
  });

  // A namespace's editors choose its Secrets' values, up to 1024 bytes each, so cutting in order would let the first
  // namespace's large values push every later namespace out of the export.
  test("shares the export's bytes fairly among the namespaces", () => {
    const database = (namespace: string, index: number, bytes: number) => ({
      kind: "cnpg",
      resource: { metadata: { namespace, name: `db-${index}` } },
      secret: { name: `db-${index}-app`, data: { password: "x".repeat(bytes) } },
    });
    const large = Array.from({ length: 6 }, (_, index) => database("team-a", index, 1000));
    const small = [database("team-b", 0, 10), database("team-b", 1, 10)];
    const whole = {
      ...buildExport({ now: T0, status, generatedAt: new Date(T0).toISOString(), namespaces, databases: [] }),
      databases: [...large, ...small],
    };
    // Room for four of team-a's databases and a little more: in order, team-a would take it all.
    const limited = (bytes: number) => ({
      ok: false,
      code: "limit_exceeded",
      message: `the export would exceed ${bytes} bytes; each namespace kept a fair share and the rest was left out`,
    });
    const room = 4 * (Buffer.byteLength(JSON.stringify(large[0])) + 1) + 20;
    let bound = 0;
    for (let round = 0; round < 3; round += 1) {
      bound = Buffer.byteLength(JSON.stringify({ ...whole, status: limited(bound), databases: [] })) + room;
    }
    const text = serializeExport(whole, limitsWith({ exportBytes: bound }));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(bound);
    expect(JSON.parse(text)).toMatchObject({ status: limited(bound), databases: [...large.slice(0, 3), ...small] });
  });
});

describe("fairShares", () => {
  test("gives every group all of its items when they fit the budget", () => {
    expect(fairShares([[1, 1], [1], []], 5)).toEqual([2, 1, 0]);
  });

  test("leaves what a small group does not need to the larger ones, and cuts each to an equal share at least", () => {
    expect(fairShares([[1, 1, 1, 1, 1, 1], [1], [1, 1, 1]], 6)).toEqual([3, 1, 2]);
    expect(
      fairShares(
        [
          [1, 1, 1, 1],
          [1, 1, 1, 1],
        ],
        5,
      ),
    ).toEqual([2, 3]);
  });

  test("keeps a prefix of each group by size, never an item past its share", () => {
    expect(
      fairShares(
        [
          [30, 30, 30],
          [5, 5],
        ],
        70,
      ),
    ).toEqual([2, 2]);
    expect(fairShares([[100], [5]], 50)).toEqual([0, 1]);
  });

  test("keeps nothing of a budget of zero or less", () => {
    expect(fairShares([[1], [1]], 0)).toEqual([0, 0]);
    expect(fairShares([[1]], -5)).toEqual([0]);
  });
});

describe("writeExport", () => {
  test("puts the export into the Secret it read, keeping its metadata, type and resourceVersion precondition", async () => {
    await writeExport({ client: client(), config: config(), text: '{"version":1}' });
    const [read, put] = api.seen;
    expect([read.method, read.path, put.method, put.path]).toEqual(["GET", EXPORT_PATH, "PUT", EXPORT_PATH]);
    const body = put.body as { metadata: Record<string, unknown>; type: string; data: Record<string, string> };
    expect(body.metadata).toMatchObject({
      name: "libredb-studio-discovery-export",
      namespace: "libredb-studio",
      labels: { "app.kubernetes.io/managed-by": "Helm" },
      annotations: { "meta.helm.sh/release-name": "libredb-studio" },
    });
    expect(body.metadata.managedFields).toBeUndefined();
    expect(body.type).toBe("Opaque");
    expect(Object.keys(body.data)).toEqual(["export.json"]);
    expect(api.writtenExport()).toEqual({ version: 1 });
  });

  test("re-reads and retries once on a conflict, and fails on a second", async () => {
    api.conflictsBeforePut = 1;
    await writeExport({ client: client(), config: config(), text: '{"try":1}' });
    expect(api.seen.map((seen) => seen.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(api.writtenExport()).toEqual({ try: 1 });

    api.seen.length = 0;
    api.conflictsBeforePut = 2;
    expect(await rejection(writeExport({ client: client(), config: config(), text: '{"try":2}' }))).toMatchObject({
      statusCode: 409,
    });
    expect(api.seen.map((seen) => seen.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(api.writtenExport()).toEqual({ try: 1 });
  });

  test("fails without creating anything when the export Secret does not exist", async () => {
    api.secrets.clear();
    expect(await rejection(writeExport({ client: client(), config: config(), text: "{}" }))).toMatchObject({
      statusCode: 404,
      message: `GET ${EXPORT_PATH} answered HTTP 404: secrets "libredb-studio-discovery-export" not found`,
    });
    expect(api.seen.map((seen) => seen.method)).toEqual(["GET"]);
  });
});

describe("createExporter", () => {
  test("a failed scan keeps the last good databases and generatedAt, and updates the status and checkedAt", async () => {
    seedLab();
    let clock = T0;
    const out = logs();
    const exporter = createExporter({
      config: config(),
      client: client(),
      now: () => clock,
      info: (line: string) => out.stdout(`${line}\n`),
      warn: (line: string) => out.stderr(`${line}\n`),
    });
    expect(await exporter.scanAndWrite()).toBe(true);
    const first = api.writtenExport() as Record<string, unknown>;
    expect(first).toMatchObject({ generatedAt: new Date(T0).toISOString(), status: { ok: true } });

    clock = T0 + 30_000;
    api.scripted.set("/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters", {
      status: 503,
      body: statusBody(503, "ServiceUnavailable", "the server is currently unable to handle the request"),
    });
    expect(await exporter.scanAndWrite()).toBe(true);
    const second = api.writtenExport() as Record<string, unknown>;
    expect(second).toMatchObject({
      generatedAt: new Date(T0).toISOString(),
      checkedAt: new Date(T0 + 30_000).toISOString(),
      status: { ok: false, code: "api_error", httpStatus: 503 },
    });
    expect(second.databases).toEqual(first.databases);
    expect(second.namespaces).toEqual(first.namespaces);
    expect(out.out.join("")).toBe("scan ok: 2 databases in 2 namespaces exported\n");
    expect(out.err.join("")).toBe(
      "scan failed: api_error: GET /apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters answered HTTP 503: the server is currently unable to handle the request\n",
    );
  });

  test("logs a changed summary once, with the namespaces it could not read and what it left out or cut", async () => {
    seedLab();
    api.forbiddenNamespaces.add("team-b");
    api.addCluster("team-a", "odd", { bootstrap: { initdb: { secret: { name: "Not_A_Name" } } } });
    api.addCluster("team-a", "reports");
    const out = logs();
    const exporter = createExporter({
      config: config(),
      client: client(),
      now: () => T0,
      info: (line: string) => out.stdout(`${line}\n`),
      warn: (line: string) => out.stderr(`${line}\n`),
      limits: limitsWith({ databases: 1 }),
    });
    await exporter.scanAndWrite();
    await exporter.scanAndWrite();
    expect(out.out).toEqual([
      "scan ok: 1 databases in 2 namespaces exported, 1 namespaces could not be read, 1 resources left out, cut to fair shares of 1\n",
    ]);
    expect((api.writtenExport() as { status: unknown }).status).toEqual({
      ok: false,
      code: "limit_exceeded",
      message:
        "more than 1 databases in the discovered namespaces; each namespace kept a fair share and the rest was left out",
    });

    const second = logs();
    const again = createExporter({
      config: config(),
      client: client(),
      now: () => T0,
      info: (line: string) => second.stdout(`${line}\n`),
      warn: (line: string) => second.stderr(`${line}\n`),
    });
    await again.scanAndWrite();
    expect(second.out).toEqual([
      "scan ok: 2 databases in 2 namespaces exported, 1 namespaces could not be read, 1 resources left out\n",
    ]);
  });

  test("reports a write it could not make, and writes nothing", async () => {
    seedLab();
    api.secrets.delete("libredb-studio/libredb-studio-discovery-export");
    const out = logs();
    const exporter = createExporter({
      config: config(),
      client: client(),
      now: () => T0,
      info: (line: string) => out.stdout(`${line}\n`),
      warn: (line: string) => out.stderr(`${line}\n`),
    });
    expect(await exporter.scanAndWrite()).toBe(false);
    expect(out.err).toEqual([
      `write failed: api_error: GET ${EXPORT_PATH} answered HTTP 404: secrets "libredb-studio-discovery-export" not found\n`,
    ]);
  });

  test("never writes a Secret value to a log line", async () => {
    seedLab();
    const out = logs();
    const exporter = createExporter({
      config: config(),
      client: client(),
      now: () => T0,
      info: (line: string) => out.stdout(`${line}\n`),
      warn: (line: string) => out.stderr(`${line}\n`),
    });
    await exporter.scanAndWrite();
    api.scripted.set("/api/v1/namespaces/team-b/secrets/analytics-app", {
      status: 200,
      body: `{"data":{"password":"${PASSWORD_B}"`,
    });
    await exporter.scanAndWrite();
    api.scripted.set(EXPORT_PATH, { status: 500, body: statusBody(500, "x", "y") });
    await exporter.scanAndWrite();
    for (const password of [PASSWORD_A, PASSWORD_B]) expect(out.all()).not.toContain(password);
    expect(out.all()).toContain("scan failed");
    expect(out.all()).toContain("write failed");
  });
});

describe("main", () => {
  test("refuses a configuration it cannot honour with exit code 2, before any request", async () => {
    const out = logs();
    const code = await main({
      env: { KUBERNETES_DISCOVERY_NAMESPACES: "team-a" },
      stdout: out.stdout,
      stderr: out.stderr,
    });
    expect(code).toBe(2);
    expect(out.err.join("")).toBe(
      "libredb-kubernetes-discovery: invalid configuration: KUBERNETES_DISCOVERY_EXPORT_SECRET must name the export Secret as <namespace>/<name>, such as libredb-studio/libredb-studio-discovery-export\n",
    );
    expect(api.seen).toHaveLength(0);
  });

  test("scans once and exits 0 with an export Studio's own parser accepts", async () => {
    seedLab();
    const out = logs();
    const code = await main({ env: api.env(), now: () => T0, stdout: out.stdout, stderr: out.stderr });
    expect(code).toBe(0);
    expect(out.out).toEqual([
      "libredb-kubernetes-discovery: watching 2 namespaces (team-a, team-b) for cnpg every 30000 ms, writing libredb-studio/libredb-studio-discovery-export\n",
      "libredb-kubernetes-discovery: scan ok: 2 databases in 2 namespaces exported\n",
    ]);
    const parsed = parseKubernetesDiscoveryExport(JSON.stringify(api.writtenExport()));
    expect(parsed.ok).toBe(true);
  });

  test("exits 1 when a single scan could not write its export", async () => {
    api.secrets.clear();
    const out = logs();
    expect(await main({ env: api.env(), now: () => T0, stdout: out.stdout, stderr: out.stderr })).toBe(1);
  });

  test.each([["SIGTERM"], ["SIGINT"]])(
    "scans every interval until %s, then exits 0 and leaves no listener",
    async (signal) => {
      seedLab();
      const signals = new EventEmitter();
      const out = logs();
      const running = main({
        env: api.env({ KUBERNETES_DISCOVERY_ONCE: "" }),
        now: () => T0,
        stdout: out.stdout,
        stderr: out.stderr,
        signals,
      });
      await eventually(() => api.seen.some((seen) => seen.method === "PUT"), "the first export");
      signals.emit(signal);
      expect(await running).toBe(0);
      expect(out.out.at(-1)).toBe(`libredb-kubernetes-discovery: received ${signal}, exiting\n`);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
    },
  );

  test("a signal during a scan aborts its requests and writes nothing", async () => {
    seedLab();
    api.scripted.set("/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters", "hang");
    const signals = new EventEmitter();
    const out = logs();
    const running = main({
      env: api.env({ KUBERNETES_DISCOVERY_ONCE: "" }),
      now: () => T0,
      stdout: out.stdout,
      stderr: out.stderr,
      signals,
    });
    await eventually(() => api.seen.length === 1, "the first request");
    signals.emit("SIGTERM");
    expect(await running).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.seen.some((seen) => seen.method === "PUT")).toBe(false);
  });
});

describe("the golden fixture, end to end", () => {
  test("the exporter's export of the golden resources of every kind maps to the golden connections in Studio", async () => {
    for (const c of GOLDEN_CASES) api.addGoldenCase(c);
    const namespaces = [...new Set(GOLDEN_CASES.map((c) => c.resource.metadata.namespace))].join(",");
    expect(
      await main({
        env: api.env({
          KUBERNETES_DISCOVERY_NAMESPACES: namespaces,
          KUBERNETES_DISCOVERY_KINDS: "cnpg,edbpg,pgo,mongo",
        }),
        now: () => T0,
        stdout: () => {},
        stderr: () => {},
      }),
    ).toBe(0);
    const parsed = parseKubernetesDiscoveryExport(JSON.stringify(api.writtenExport()));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.version).toBe(2);
    expect(parsed.value.databases).toHaveLength(GOLDEN_CASES.length);
    const ids = new Map<string, KubernetesDiscoveredDatabase>();
    for (const entry of parsed.value.databases) {
      const mapped = mapKubernetesDatabase(entry);
      if (!mapped.ok) throw new Error(mapped.reason);
      ids.set(mapped.connection.id, entry);
    }
    for (const c of GOLDEN_CASES) {
      const entry = ids.get(c.connectionId);
      if (entry === undefined) throw new Error(`the golden case ${c.connectionId} was not exported`);
      expect(entry).toEqual(goldenEntry(c));
      const mapped = mapKubernetesDatabase(entry);
      if (!mapped.ok) throw new Error(mapped.reason);
      expect(mapped.connection).toMatchObject(c.connection);
      expect(mapped.secret.name).toBe(c.secretName);
    }
  });
});

describe("as a program, under node", () => {
  const exporter = fileURLToPath(new URL("../../docker/discover-kubernetes.mjs", import.meta.url));
  // The process environment without any exporter setting, so a developer's .env cannot change what a case runs.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("KUBERNETES_DISCOVERY_")),
  );

  test("scans once, writes the export and exits 0", async () => {
    seedLab();
    const child = Bun.spawn(["node", exporter], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...inherited, ...api.env() },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(
      "libredb-kubernetes-discovery: scan ok: 2 databases in 2 namespaces exported",
    );
    expect(parseKubernetesDiscoveryExport(JSON.stringify(api.writtenExport())).ok).toBe(true);
  }, 10000);

  test("exits 2 on a configuration it cannot honour", async () => {
    const child = Bun.spawn(["node", exporter], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...inherited, ...api.env({ KUBERNETES_DISCOVERY_INTERVAL_MS: "10" }) },
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("KUBERNETES_DISCOVERY_INTERVAL_MS must be an integer");
  }, 10000);

  /*
   * Null on Linux and macOS, a reason on Windows, which never delivers SIGTERM to a child: the kill ends it at once
   * with exit 143, so the handler this case checks cannot run there. The cases under main drive the same handler
   * through an EventEmitter on every platform, and the exporter only ever runs in a Linux container.
   */
  const missingPosixSignals =
    process.platform === "win32" ? "POSIX signals: Windows ends a child at a kill without running its handler" : null;

  test.skipIf(missingPosixSignals !== null)(
    `SIGTERM while a request is in flight aborts it: exit code 0 at once, and nothing written${missingPosixSignals === null ? "" : ` [skipped: ${missingPosixSignals}]`}`,
    async () => {
      seedLab();
      api.scripted.set("/apis/postgresql.cnpg.io/v1/namespaces/team-a/clusters", "hang");
      const child = Bun.spawn(["node", exporter], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...inherited, ...api.env({ KUBERNETES_DISCOVERY_ONCE: "" }) },
      });
      try {
        await eventually(() => api.seen.length === 1, "the first request", 5000);
        const sent = Date.now();
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);
        expect(Date.now() - sent).toBeLessThan(1500);
        expect(api.seen.some((seen) => seen.method === "PUT")).toBe(false);
        expect(await new Response(child.stdout).text()).toContain(
          "libredb-kubernetes-discovery: received SIGTERM, exiting",
        );
      } finally {
        child.kill("SIGKILL");
      }
    },
    10000,
  );
});

describe("isDirectExecution", () => {
  test("is true only for this module's own path", () => {
    const modulePath = fileURLToPath(new URL("../../docker/discover-kubernetes.mjs", import.meta.url));
    const moduleUrl = pathToFileURL(modulePath).href;
    expect(isDirectExecution(modulePath, moduleUrl)).toBe(true);
    expect(isDirectExecution(fileURLToPath(new URL("../../docker/discover.mjs", import.meta.url)), moduleUrl)).toBe(
      false,
    );
    expect(isDirectExecution(undefined, moduleUrl)).toBe(false);
    expect(isDirectExecution("/nonexistent/file.mjs", moduleUrl)).toBe(false);
  });
});
