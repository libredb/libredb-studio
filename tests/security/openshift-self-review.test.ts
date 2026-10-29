/**
 * Threat: in openshift sign-in mode, a signed-in person opening a Kubernetes-discovered database whose credential
 * Secret the cluster does not let them read, learning that one exists, keeping Studio admin after the cluster took the
 * right away, or Studio leaking the person's own OpenShift token (docs/SECURITY.md, controls 3.29 and 3.30).
 *
 * Every gated request is reviewed with a SelfSubjectAccessReview carrying the session's own token. This file proves it
 * on the routes themselves, with the real session reader, gate, decision cache, review client and token record store
 * against the fake cluster (tests/helpers/openshift-auth/fake-cluster.ts): every route of `CONNECTION_ROUTES` answers a
 * denied, failed, expired and unknown id with the same bytes, builds no provider and never takes the unfiltered
 * lookup; a 401 omits the row from that request and signs the session out from the next one; admin is lost within the
 * cache lifetime once the right is removed; and the token reaches no log line, response, cookie, URL or host other
 * than the API server. A provider is counted where it is built: the factory logs `[DB] Creating <type> provider`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import https from "node:https";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import path from "node:path";
import { CookieJar } from "../helpers/openshift-auth/cookie-jar";
import { type FakeCluster, SELF_REVIEW_PATH, startFakeCluster } from "../helpers/openshift-auth/fake-cluster";
import { CONNECTION_ROUTES, PROVIDER_ROUTES } from "./helpers/provider-routes";

const jar = new CookieJar();
mock.module("next/headers", () => jar.module());

const auth = await import("@/lib/auth");
const seedIndex = await import("@/lib/seed");
const { KUBERNETES_REVIEWED_ROLE } = await import("@/lib/seed/roles");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { logger } = await import("@/lib/logger");
const { resetAccessReviewDecisions } = await import("@/lib/kubernetes-access/decisions");
const tokenStore = await import("@/lib/openshift-auth/token-store");
const { GET: listManaged } = await import("@/app/api/connections/managed/route");
const { GET: auditGET } = await import("@/app/api/admin/audit/route");
type ManagedConnection = import("@/lib/seed/types").ManagedConnection;

const FIXTURES = path.resolve(import.meta.dir, "../fixtures/seed-connections");
/** Clearly not credentials: gitleaks scans every commit. */
const TOKEN_A = "sha256~not-a-real-token-a";
const TOKEN_ADMIN = "sha256~not-a-real-token-b";
const TOKEN_EXPIRING = "sha256~not-a-real-token-e";
const UPDATE_STUDIO = {
  verb: "update",
  apiGroup: "apps",
  resource: "deployments",
  namespace: "os-lab-studio",
  name: "studio",
};

interface Person {
  readonly name: string;
  readonly uid: string;
  readonly role: "admin" | "user";
}
const DEV_A: Person = { name: "dev-a", uid: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f", role: "user" };
const OS_ADMIN: Person = { name: "os-admin", uid: "7c1d2e3f-4a5b-4c55-9e1f-7a3b2c1d0e9f", role: "admin" };

function reviewed(id: string, namespace: string, secret: string, host = `${id}-rw.${namespace}.svc`, port = 5432) {
  return {
    id: `seed:${id}`,
    seedId: id,
    name: `${namespace}/${id} (CloudNativePG)`,
    type: "postgres",
    host,
    port,
    database: "app",
    user: "app",
    password: "example-only-password",
    managed: true,
    roles: [KUBERNETES_REVIEWED_ROLE],
    createdAt: new Date(0),
    literal: true,
    kubernetesSecret: { namespace, name: secret },
  } satisfies ManagedConnection;
}

/** orders: dev-a may get its Secret; analytics: every review of it fails; billing: nobody may get its Secret. */
const REVIEWED: ManagedConnection[] = [
  reviewed("k8s-cnpg-orders", "team-a", "orders-app"),
  reviewed("k8s-cnpg-analytics", "team-b", "analytics-app"),
  reviewed("k8s-cnpg-billing", "team-b", "billing-app"),
];
let extraRows: ManagedConnection[] = [];

const ENV: Readonly<Record<string, string>> = {
  SEED_CONFIG_PATH: path.join(FIXTURES, "multi-role-config.yaml"),
  ADMIN_PG_PASS: "admin-secret",
  USER_MYSQL_PASS: "user-secret",
  SHARED_PG_PASS: "shared-secret",
  BOTH_PG_PASS: "both-secret",
  JWT_SECRET: "a-test-secret-that-is-32-chars!!",
  KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT: "os-lab-studio/studio",
};
const UNSET = ["KUBERNETES_ACCESS_REVIEW", "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS", "AUTH_SESSION_TTL_SECONDS"];

const NOT_FOUND_TEXT = JSON.stringify({
  error: "Connection not found: it does not exist or is not granted to you",
  code: "CONNECTION_NOT_FOUND",
  statusCode: 404,
});

const getSeedListing = seedIndex.getSeedListing;
let cluster: FakeCluster;
const spies: { mockRestore(): void }[] = [];
let handles = 0;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  for (const name of UNSET) delete process.env[name];
  cluster.reset();
  cluster.useEnv();
  cluster.tokens = {
    [TOKEN_A]: { user: "dev-a", groups: ["system:authenticated"] },
    [TOKEN_ADMIN]: { user: "os-admin", groups: ["system:authenticated"] },
  };
  cluster.grants = [
    { user: "dev-a", verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
    { user: "os-admin", ...UPDATE_STUDIO },
  ];
  cluster.script(SELF_REVIEW_PATH, (request) =>
    request.body.includes('"analytics-app"') ? { status: 500, body: "{}" } : undefined,
  );
  jar.reset();
  extraRows = [];
  seedIndex.resetCache();
  resetAccessReviewDecisions();
  tokenStore.resetOpenShiftSessions();
  clearRateLimitState();
  spies.push(
    spyOn(seedIndex, "getSeedListing").mockImplementation(async (roles: string[]) => {
      const listing = await getSeedListing(roles);
      const rows = structuredClone([...REVIEWED, ...extraRows]);
      return { ...listing, pendingReview: [...listing.pendingReview, ...rows] };
    }),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  cluster.restoreEnv();
  for (const name of [...Object.keys(ENV), ...UNSET]) delete process.env[name];
  seedIndex.resetCache();
  resetAccessReviewDecisions();
  tokenStore.resetOpenShiftSessions();
  clearRateLimitState();
});

/** Signs `person` in as the callback would: a token record under a new handle, and its session cookie in the jar. */
async function signIn(person: Person, token: string): Promise<string> {
  handles += 1;
  const handle = `handle-${handles}-not-a-real-handle-${"0".repeat(20)}`;
  tokenStore.storeOpenShiftSession(handle, {
    token,
    uid: person.uid,
    name: person.name,
    issuer: cluster.issuerOrigin,
    expiresAtMs: Date.now() + 3_600_000,
  });
  const cookie = await auth.signJWT({
    role: person.role,
    username: person.name,
    idpSubject: person.uid,
    idpIssuer: cluster.issuerOrigin,
    sessionHandle: handle,
  });
  jar.values.set("auth-token", cookie);
  return handle;
}

/**
 * An admin session whose token the API server stops taking while its admin answer is still cached: the next gated
 * open is the request that meets the 401.
 */
async function expiringAdmin(): Promise<string> {
  cluster.tokens[TOKEN_EXPIRING] = { user: "os-admin", groups: ["system:authenticated"] };
  const handle = await signIn(OS_ADMIN, TOKEN_EXPIRING);
  expect((await auth.getSession())?.role).toBe("admin");
  delete cluster.tokens[TOKEN_EXPIRING];
  return handle;
}

const keyOf = (handle: string, person: Person) => ({
  sessionHandle: handle,
  uid: person.uid,
  name: person.name,
  issuer: cluster.issuerOrigin,
});

const ROUTE_MODULES = new Map(PROVIDER_ROUTES);
type Handler = (request: Request) => Promise<Response>;

async function postHandler(route: string): Promise<Handler> {
  const load = ROUTE_MODULES.get(route);
  if (load === undefined) throw new Error(`"${route}" is not a provider route`);
  const { POST } = await load();
  if (typeof POST !== "function") throw new Error(`"${route}" exports no POST`);
  return POST as unknown as Handler;
}

const responses: { status: number; text: string; headers: string }[] = [];

async function answer(route: string, body: unknown): Promise<{ status: number; text: string }> {
  const handler = await postHandler(route);
  const response = await handler(
    new Request(`http://localhost/api/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  responses.push({ status: response.status, text, headers: JSON.stringify([...response.headers]) });
  return { status: response.status, text };
}

async function listed(): Promise<{ status: number; ids: string[]; text: string }> {
  const response = await listManaged();
  const text = await response.text();
  responses.push({ status: response.status, text, headers: JSON.stringify([...response.headers]) });
  const ids = response.status === 200 ? (JSON.parse(text) as { connections: { id: string }[] }).connections : [];
  return { status: response.status, ids: ids.map((connection) => connection.id), text };
}

/** How many providers the factory announced while `log` was installed. */
function providersBuilt(log: { mock: { calls: unknown[][] } }): number {
  return log.mock.calls.filter((call) => typeof call[0] === "string" && call[0].startsWith("[DB] Creating ")).length;
}

describe("in openshift sign-in mode, the user's own review is the only way to a reviewed connection", () => {
  test("every connection route answers a denied, failed, expired and unknown id with the same bytes, builds nothing, and never takes the unfiltered lookup", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const quiet = [spyOn(logger, "warn"), spyOn(logger, "info"), spyOn(logger, "error")];
    for (const spy of quiet) spy.mockImplementation(() => {});
    const unfiltered = spyOn(seedIndex, "getSeedConnectionByIdUnfiltered");
    try {
      await signIn(OS_ADMIN, TOKEN_ADMIN);
      const answers: Record<string, unknown> = {};
      for (const [route, body] of Object.entries(CONNECTION_ROUTES)) {
        // One request at a time: the session is the one cookie of the jar, as a browser sends it.
        // oxlint-disable-next-line no-await-in-loop -- sequential requests of one browser.
        const denied = await answer(route, { ...body, connectionId: "seed:k8s-cnpg-billing" });
        // oxlint-disable-next-line no-await-in-loop -- sequential requests of one browser.
        const failed = await answer(route, { ...body, connectionId: "seed:k8s-cnpg-analytics" });
        // oxlint-disable-next-line no-await-in-loop -- sequential requests of one browser.
        const unknown = await answer(route, { ...body, connectionId: "seed:no-such-connection" });
        answers[route] = { denied, failed, unknown };
      }
      const expired: Record<string, unknown> = {};
      for (const [route, body] of Object.entries(CONNECTION_ROUTES)) {
        // oxlint-disable-next-line no-await-in-loop -- each route meets the 401 with its own fresh session.
        const handle = await expiringAdmin();
        // oxlint-disable-next-line no-await-in-loop -- each route meets the 401 with its own fresh session.
        expired[route] = await answer(route, { ...body, connectionId: "seed:k8s-cnpg-billing" });
        expect(tokenStore.openShiftBearerToken(keyOf(handle, OS_ADMIN))).toBeNull();
      }
      const notFound = { status: 404, text: NOT_FOUND_TEXT };
      const routes = Object.keys(CONNECTION_ROUTES);
      expect(answers).toEqual(
        Object.fromEntries(routes.map((route) => [route, { denied: notFound, failed: notFound, unknown: notFound }])),
      );
      expect(expired).toEqual(Object.fromEntries(routes.map((route) => [route, notFound])));
      expect(providersBuilt(log)).toBe(0);
      expect(unfiltered).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      for (const spy of quiet) spy.mockRestore();
      unfiltered.mockRestore();
    }
  });

  test("a user gets the same bytes for a reviewed row it may not use, a seed its role may not see, and an unknown id", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await signIn(DEV_A, TOKEN_A);
      for (const connectionId of [
        "seed:k8s-cnpg-billing",
        "seed:k8s-cnpg-analytics",
        "seed:admin-only",
        "seed:no-such-connection",
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, as a browser sends them.
        expect(await answer("db/query", { sql: "SELECT 1", connectionId })).toEqual({
          status: 404,
          text: NOT_FOUND_TEXT,
        });
      }
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("the admin fleet health check reports each reviewed row the review keeps from the admin as that item's error, building nothing", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await signIn(OS_ADMIN, TOKEN_ADMIN);
      const checked = await answer("admin/fleet-health", {
        connections: REVIEWED.map(({ id, name, type, managed, createdAt }) => ({ id, name, type, managed, createdAt })),
      });
      expect(checked.status).toBe(200);
      const results = (JSON.parse(checked.text) as { results: { connectionId: string; status: string }[] }).results;
      expect(results.map(({ connectionId, status }) => ({ connectionId, status }))).toEqual(
        REVIEWED.map(({ id }) => ({ connectionId: id, status: "error" })),
      );
      expect(providersBuilt(log)).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("the managed list shows a reviewed row only to a session the review allows, with no marker and no role", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await signIn(DEV_A, TOKEN_A);
      const forDevA = await listed();
      expect(forDevA.ids.filter((id) => id.startsWith("seed:k8s-"))).toEqual(["seed:k8s-cnpg-orders"]);
      const orders = (JSON.parse(forDevA.text) as { connections: Record<string, unknown>[] }).connections.find(
        (connection) => connection.id === "seed:k8s-cnpg-orders",
      );
      expect(orders).toMatchObject({ roles: [] });
      expect(orders).not.toHaveProperty("kubernetesSecret");
      expect(orders).not.toHaveProperty("password");
      await signIn(OS_ADMIN, TOKEN_ADMIN);
      expect((await listed()).ids.filter((id) => id.startsWith("seed:k8s-"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a 401 omits the row from that request, ends the record, and the next request is signed out", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const handle = await signIn(DEV_A, TOKEN_A);
      delete cluster.tokens[TOKEN_A];
      const first = await listed();
      expect(first.status).toBe(200);
      expect(first.ids).not.toContain("seed:k8s-cnpg-orders");
      expect(tokenStore.openShiftBearerToken(keyOf(handle, DEV_A))).toBeNull();
      expect(await auth.getSession()).toBeNull();
      expect((await listed()).status).toBe(401);
    } finally {
      info.mockRestore();
    }
  });

  test("an admin whose right is removed answers 403 on the next admin request, with a cache lifetime of 0", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "0";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await signIn(OS_ADMIN, TOKEN_ADMIN);
      expect((await auditGET(new Request("http://localhost/api/admin/audit"))).status).toBe(200);
      cluster.grants = cluster.grants.filter((grant) => grant.user !== "os-admin");
      const refused = await auditGET(new Request("http://localhost/api/admin/audit"));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "Unauthorized. Admin access required.", code: "ADMIN_REQUIRED" });
      const maintenance = await answer("db/maintenance", {
        ...CONNECTION_ROUTES["db/maintenance"],
        connectionId: "seed:everyone",
      });
      expect(maintenance.status).toBe(403);
      expect(JSON.parse(maintenance.text)).toMatchObject({ code: "ADMIN_REQUIRED" });
    } finally {
      warn.mockRestore();
    }
  });

  // The control: the same detector, and a reviewed row the review allows dev-a. A zero above is a measurement.
  test("the control: a reviewed row the review allows reaches the factory", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await signIn(DEV_A, TOKEN_A);
      expect((await answer("db/provider-meta", { connectionId: "seed:k8s-cnpg-orders" })).status).toBe(200);
      expect(providersBuilt(log)).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the user's token stays with the API server", () => {
  test("it reaches no log line, no response body or header and no cookie, through every outcome", async () => {
    responses.length = 0;
    const logged: unknown[] = [];
    const levels = ["debug", "info", "warn", "error"] as const;
    const captured = [
      ...levels.map((level) => spyOn(logger, level).mockImplementation((...args: unknown[]) => logged.push(args))),
      ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
        spyOn(console, level).mockImplementation((...args: unknown[]) => logged.push(args)),
      ),
    ];
    try {
      await signIn(DEV_A, TOKEN_A);
      await listed();
      await answer("db/provider-meta", { connectionId: "seed:k8s-cnpg-orders" });
      await answer("db/query", { sql: "SELECT 1", connectionId: "seed:k8s-cnpg-billing" });
      await answer("db/query", { sql: "SELECT 1", connectionId: "seed:k8s-cnpg-analytics" });
      cluster.script(SELF_REVIEW_PATH, { status: 403, body: "{}" });
      resetAccessReviewDecisions();
      await answer("db/query", { sql: "SELECT 1", connectionId: "seed:k8s-cnpg-orders" });
      cluster.reset();
      cluster.tokens = { [TOKEN_ADMIN]: { user: "os-admin", groups: ["system:authenticated"] } };
      cluster.grants = [{ user: "os-admin", ...UPDATE_STUDIO }];
      await signIn(OS_ADMIN, TOKEN_ADMIN);
      expect((await auditGET(new Request("http://localhost/api/admin/audit"))).status).toBe(200);
      await expiringAdmin();
      await answer("db/query", { sql: "SELECT 1", connectionId: "seed:k8s-cnpg-orders" });
      await listed();
    } finally {
      for (const spy of captured) spy.mockRestore();
    }
    const everything = JSON.stringify([logged, responses, jar.writes]);
    expect(everything).not.toContain(TOKEN_A);
    expect(everything).not.toContain("sha256~");
    expect(responses.length).toBeGreaterThan(5);
    expect(jar.writes.length).toBeGreaterThan(0);
  });

  test("it is sent only to the API server: never through fetch, never to the OAuth server, never to a database", async () => {
    const received: Buffer[] = [];
    const database = createNetServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => database.listen(0, "127.0.0.1", () => resolve()));
    const { port } = database.address() as AddressInfo;
    extraRows = [reviewed("k8s-cnpg-local", "team-a", "orders-app", "127.0.0.1", port)];
    const sent = spyOn(https, "request");
    const fetched = spyOn(globalThis, "fetch");
    const quiet = [spyOn(logger, "warn"), spyOn(logger, "error"), spyOn(console, "log"), spyOn(console, "error")];
    for (const spy of quiet) spy.mockImplementation(() => {});
    try {
      await signIn(DEV_A, TOKEN_A);
      expect((await listed()).ids).toContain("seed:k8s-cnpg-local");
      await answer("db/query", { sql: "SELECT 1", connectionId: "seed:k8s-cnpg-local" });
      const api = new URL(cluster.apiUrl);
      const carrying = sent.mock.calls
        .map(([options]) => options as https.RequestOptions)
        .filter((options) => JSON.stringify(options.headers ?? {}).includes(TOKEN_A));
      expect(carrying.length).toBeGreaterThan(0);
      for (const options of carrying) {
        expect({ host: options.hostname, port: String(options.port) }).toEqual({ host: api.hostname, port: api.port });
      }
      expect(JSON.stringify(fetched.mock.calls)).not.toContain("sha256~");
      expect(cluster.received("oauth")).toEqual([]);
      expect(received.length).toBeGreaterThan(0);
      expect(Buffer.concat(received).toString("latin1")).not.toContain("sha256~");
    } finally {
      sent.mockRestore();
      fetched.mockRestore();
      for (const spy of quiet) spy.mockRestore();
      await new Promise<void>((resolve) => database.close(() => resolve()));
    }
  });
});
