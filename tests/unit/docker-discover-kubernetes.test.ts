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
import { CNPG_CLUSTER, KUBERNETES_CONTRACT, mapKubernetesDatabase } from "@/lib/seed/kubernetes-discovery-contract";
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
  scanOnce,
  serializeExport,
  writeExport,
} from "../../docker/discover-kubernetes.mjs";
import {
  FAKE_DISCOVERY_TOKEN,
  type FakeDiscoveryApi,
  startFakeDiscoveryApi,
  statusBody,
} from "../helpers/kubernetes-discovery/fake-api";
import { GOLDEN_CASES } from "../helpers/kubernetes-discovery-fixture";
import { eventually } from "../helpers/node-transport-fixtures";

const T0 = Date.parse("2026-10-28T08:00:00.000Z");
const PASSWORD_A = "not-a-real-password-orders";
const PASSWORD_B = "not-a-real-password-analytics";
const EXPORT_PATH = "/api/v1/namespaces/libredb-studio/secrets/libredb-studio-discovery-export";

// The hosts below are those of the default cluster domain.
delete process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;

let api: FakeDiscoveryApi;

/** The golden CloudNativePG cases, which the exporter's CloudNativePG row serves. */
const CNPG_CASES = GOLDEN_CASES.filter((c) => c.resource.apiVersion === "postgresql.cnpg.io/v1");

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
      const row = CONTRACT.find((entry: { slug: string }) => entry.slug === studio.slug);
      expect(row).toMatchObject({
        slug: studio.slug,
        group: studio.group,
        version: studio.version,
        plural: studio.plural,
        secretKeys: [...studio.secretKeys],
      });
    }
  });

  test.each(CNPG_CASES.map((c) => [`${c.resource.metadata.namespace}/${c.resource.metadata.name}`, c] as const))(
    "the CloudNativePG row names the golden Secret of %s, as Studio's row does",
    (_, c) => {
      const [row] = CONTRACT;
      expect(row.secretName(c.resource)).toBe(c.secretName);
      expect(row.secretName(c.resource)).toBe(CNPG_CLUSTER.secretName(c.resource));
    },
  );

  test("the CloudNativePG row prunes a resource to the contract's fields", () => {
    const [row] = CONTRACT;
    expect(
      row.prune({
        apiVersion: "postgresql.cnpg.io/v1",
        metadata: { namespace: "prod", name: "billing-db", uid: "u", labels: { a: "b" } },
        spec: {
          instances: 3,
          bootstrap: { initdb: { database: "billing", owner: "o", secret: { name: "billing-owner", x: 1 } } },
        },
      }),
    ).toEqual({
      metadata: { namespace: "prod", name: "billing-db" },
      spec: { bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } } },
    });
    // A database that is not a name Studio accepts leaves the resource out rather than connecting to another one.
    expect(
      row.prune({ metadata: { namespace: "a", name: "b" }, spec: { bootstrap: { initdb: { database: 1 } } } }),
    ).toBeNull();
    expect(row.prune({ metadata: { namespace: "a", name: "b" } })).toEqual({ metadata: { namespace: "a", name: "b" } });
    for (const odd of [null, {}, { metadata: { name: "b" } }, { metadata: { namespace: "a", name: 7 } }]) {
      expect(row.prune(odd)).toBeNull();
    }
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
      'KUBERNETES_DISCOVERY_KINDS names "mariadb", which is not a supported kind: cnpg',
    );
    expect(() => readConfig({ ...minimal, KUBERNETES_DISCOVERY_KINDS: " , " })).toThrow(
      "KUBERNETES_DISCOVERY_KINDS must name at least one kind: cnpg",
    );
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
    api.addAppSecret("team-a", "orders", { username: "orders", password: "p".repeat(1025), dbname: "orders" });
    api.addCluster("team-b", "analytics");
    api.addAppSecret("team-b", "analytics", { username: Buffer.from([0xc3, 0x28]), password: PASSWORD_B });
    const result = await scan({ client: client(), config: config() });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "orders-app", problem: "invalid_value", key: "password" },
      { name: "analytics-app", problem: "invalid_value", key: "username" },
    ]);
  });

  test("keeps a Secret with no data, or a value that is not a string, as it is: Studio names what is missing", async () => {
    api.addCluster("team-a", "orders");
    api.addAppSecret("team-a", "orders", {});
    api.addCluster("team-b", "analytics");
    api.scripted.set("/api/v1/namespaces/team-b/secrets/analytics-app", {
      status: 200,
      body: JSON.stringify({
        kind: "Secret",
        metadata: { labels: { "cnpg.io/cluster": "analytics" } },
        data: { username: 7, password: Buffer.from(PASSWORD_B).toString("base64") },
      }),
    });
    const result = await scan({ client: client(), config: config() });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "orders-app", data: {} },
      { name: "analytics-app", data: { password: PASSWORD_B } },
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
    const [row] = CONTRACT;
    expect(
      row.prune({
        metadata: { namespace: "a", name: "b" },
        spec: { bootstrap: { initdb: { database: "d".repeat(63) } } },
      }),
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
    api.addCluster("team-a", "opaque", { bootstrap: { initdb: { secret: { name: "app-config" } } } });
    api.addSecret("team-a", "app-config", DATA, "Opaque");
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "custom-owner", data: DATA },
      { name: "app-config", problem: "not_owned" },
    ]);
  });

  test("keeps an initdb Secret this Cluster owns or labels, whatever its type", async () => {
    api.addCluster("team-a", "mine", { bootstrap: { initdb: { secret: { name: "mine-owner" } } } });
    api.addSecret("team-a", "mine-owner", DATA, "Opaque", { labels: { "cnpg.io/cluster": "mine" } });
    api.addCluster("team-a", "held", { bootstrap: { initdb: { secret: { name: "held-owner" } } } });
    api.addSecret("team-a", "held-owner", DATA, "Opaque", {
      ownerReferences: [{ apiVersion: "postgresql.cnpg.io/v1", kind: "Cluster", name: "held", uid: "uid-team-a-held" }],
    });
    const result = await scan({ client: client(), config: config({ KUBERNETES_DISCOVERY_NAMESPACES: "team-a" }) });
    expect(result.databases.map((entry: { secret: unknown }) => entry.secret)).toEqual([
      { name: "mine-owner", data: DATA },
      { name: "held-owner", data: DATA },
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
  test("the exporter's export of the golden resources maps to the golden connections in Studio", async () => {
    for (const c of CNPG_CASES) {
      api.addCluster(c.resource.metadata.namespace, c.resource.metadata.name, c.resource.spec);
      const { namespace, name } = c.resource.metadata;
      if (c.secretName === `${name}-app`) api.addAppSecret(namespace, name, c.secretData as Record<string, string>);
      else api.addSecret(namespace, c.secretName, c.secretData as Record<string, string>);
    }
    const namespaces = [...new Set(CNPG_CASES.map((c) => c.resource.metadata.namespace))].join(",");
    expect(
      await main({
        env: api.env({ KUBERNETES_DISCOVERY_NAMESPACES: namespaces }),
        now: () => T0,
        stdout: () => {},
        stderr: () => {},
      }),
    ).toBe(0);
    const parsed = parseKubernetesDiscoveryExport(JSON.stringify(api.writtenExport()));
    if (!parsed.ok) throw new Error(parsed.reason);
    const byResource = new Map(
      parsed.value.databases.map((entry) => [
        `${entry.resource.metadata.namespace}/${entry.resource.metadata.name}`,
        entry,
      ]),
    );
    for (const c of CNPG_CASES) {
      const entry = byResource.get(`${c.resource.metadata.namespace}/${c.resource.metadata.name}`);
      if (entry === undefined) throw new Error("the golden resource was not exported");
      const mapped = mapKubernetesDatabase(entry);
      if (!mapped.ok) throw new Error(mapped.reason);
      expect(mapped.connection.id).toBe(c.connectionId);
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
